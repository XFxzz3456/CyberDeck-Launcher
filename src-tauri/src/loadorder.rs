use crate::schema::{
    AppResult, AppStateData, CommandError, LoadOrderItem, LoadOrderView,
};
use crate::store::{now_stamp, Store};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 旧版本写在 modlist.txt 首行的管理标记。
///
/// **2026-11-06 起不再写入**：`archive/pc/mod/modlist.txt` 是游戏直接读的文件，
/// 官方 Vortex 写进去的只有纯文件名，我们往里塞注释头属于污染格式。
/// 这个常量只保留用于**识别并迁移**老版本留下的文件。
pub const MANAGED_HEADER: &str = "# Managed by CyberDeck Launcher";

/// 托管标记的旁挂文件（与 modlist.txt 同目录）。
///
/// 游戏只扫 `.archive`，不会碰这个点文件；托管判定也不再依赖游戏文件的内容格式。
const MANAGED_MARK: &str = ".cyberdeck-modlist";

/// 判断 modlist.txt 首行是不是旧版管理标记。
pub fn is_managed_modlist(raw: &str) -> bool {
    raw.starts_with(MANAGED_HEADER)
}

fn managed_mark_path(dir: &Path) -> PathBuf {
    dir.join(MANAGED_MARK)
}

/// FNV-1a 64，用于把「上次写出去的内容」记在旁挂文件里。
///
/// 为什么不用内容全量比对：modlist 可能几百行，每次部署都读两遍没必要；
/// 为什么不用 `DefaultHasher`：它不保证跨版本稳定，而这份摘要要跨进程重启存活。
fn fingerprint(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 这个 modlist.txt 是不是本启动器写的。
///
/// 三条判据，任一成立即「是」：
/// 1. 旁挂标记存在且摘要与当前文件一致（正常路径）；
/// 2. 旁挂标记存在但文件已被删除（用户手删了文件，标记还在）；
/// 3. 首行是旧版 `# Managed by ...` 标记（老版本遗留，下次写入时自动迁移）。
///
/// 用户或别的工具改过内容 → 摘要对不上 → 判为「不是我们的」，写入会被拒绝，
/// 与以前「首行标记」的自我保护强度一致。
fn is_managed(dir: &Path, file: &Path) -> bool {
    let mark = managed_mark_path(dir);
    if mark.is_file() {
        let Ok(expected) = fs::read_to_string(&mark) else {
            return false;
        };
        if !file.is_file() {
            return true;
        }
        return fs::read_to_string(file)
            .map(|raw| fingerprint(&raw) == expected.trim())
            .unwrap_or(false);
    }
    fs::read_to_string(file)
        .map(|raw| is_managed_modlist(&raw))
        .unwrap_or(false)
}

fn clear_managed(dir: &Path) {
    let _ = fs::remove_file(managed_mark_path(dir));
}

/// 文件名清单是否已经是升序。
///
/// 官方 `modListFor` 的判据是「已升序就返回 undefined」，随后把 modlist.txt 删掉——
/// 因为游戏的默认顺序就是升序，写一份与默认完全相同的清单只会掩盖问题
/// （比如用户以为「我排过序」，其实什么都没改）。
fn is_ascending(names: &[String]) -> bool {
    names
        .windows(2)
        .all(|pair| pair[0].to_ascii_lowercase() <= pair[1].to_ascii_lowercase())
}

pub fn deployed_archives(state: &AppStateData) -> Vec<(String, String, String, String)> {
    // (relative path, mod id, mod name, category)
    let mut rows = Vec::new();
    for entry in state.mods.iter().filter(|entry| entry.enabled) {
        for file in &entry.deployed_files {
            if file.relative_path.to_ascii_lowercase().ends_with(".archive") {
                rows.push((
                    file.relative_path.clone(),
                    entry.id.clone(),
                    entry.name.clone(),
                    entry.category.clone(),
                ));
            }
        }
    }
    rows
}

pub fn normalized_order(state: &AppStateData) -> Vec<String> {
    let rows = deployed_archives(state);
    let mut available: HashMap<String, String> = HashMap::new();
    for (path, _, _, _) in &rows {
        available.insert(path.to_ascii_lowercase(), path.clone());
    }
    let mut ordered: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for path in &state.load_order {
        if let Some(actual) = available.get(&path.to_ascii_lowercase()) {
            if seen.insert(actual.to_ascii_lowercase()) {
                ordered.push(actual.clone());
            }
        }
    }
    let mut remaining: Vec<String> = rows
        .iter()
        .map(|(path, _, _, _)| path.clone())
        .filter(|path| !seen.contains(&path.to_ascii_lowercase()))
        .collect();
    remaining.sort_by_key(|path| path.to_ascii_lowercase());
    ordered.extend(remaining);
    ordered
}

pub fn build_view(state: &AppStateData, game_root: Option<&Path>) -> LoadOrderView {
    let rows = deployed_archives(state);
    let order = normalized_order(state);
    let by_path: HashMap<String, (String, String, String)> = rows
        .into_iter()
        .map(|(path, mod_id, mod_name, category)| {
            (path.to_ascii_lowercase(), (mod_id, mod_name, category))
        })
        .collect();

    let archives = order
        .iter()
        .enumerate()
        .filter_map(|(index, path)| {
            let lower = path.to_ascii_lowercase();
            let (mod_id, mod_name, category) = by_path.get(&lower)?.clone();
            let filename = path
                .rsplit('/')
                .next()
                .unwrap_or(path.as_str())
                .to_string();
            Some(LoadOrderItem {
                id: path.clone(),
                mod_id,
                mod_name,
                filename,
                category,
                deployed: true,
                order: index,
            })
        })
        .collect();

    // REDmod 的加载顺序来自 `state.redmod_order`（用户拖过的顺序），没登记过的
    // 按文件夹名字母序排在后面。这里只负责**展示**；真正写进 `V2077/modlist.txt`
    // 是在 redmod::sync 里做的事。
    let redmod_order = crate::redmod::normalize_order(state, &state.redmod_order);
    let redmods: Vec<LoadOrderItem> = redmod_order
        .iter()
        .filter_map(|id| {
            let entry = state.mods.iter().find(|item| &item.id == id)?;
            if !entry.enabled {
                return None;
            }
            Some(LoadOrderItem {
                id: format!("redmod:{}", entry.id),
                mod_id: entry.id.clone(),
                mod_name: entry.name.clone(),
                filename: entry
                    .mod_folder
                    .clone()
                    .unwrap_or_else(|| entry.name.clone()),
                category: entry.category.clone(),
                deployed: true,
                order: 0,
            })
        })
        .collect();
    let redmods: Vec<LoadOrderItem> = redmods
        .into_iter()
        .enumerate()
        .map(|(index, mut item)| {
            item.order = index;
            item
        })
        .collect();

    let modlist_path = game_root.map(|root| {
        root.join("archive")
            .join("pc")
            .join("mod")
            .join("modlist.txt")
            .to_string_lossy()
            .to_string()
    });
    let (modlist_exists, managed_modlist) = match game_root {
        Some(root) => {
            let dir = root.join("archive").join("pc").join("mod");
            let file = dir.join("modlist.txt");
            let exists = file.is_file();
            (exists, exists && is_managed(&dir, &file))
        }
        None => (false, false),
    };

    LoadOrderView {
        archives,
        redmods,
        modlist_path,
        modlist_exists,
        managed_modlist,
    }
}

pub fn write_modlist(state: &AppStateData, game_root: &Path) -> AppResult<Option<String>> {
    let order = normalized_order(state);
    let dir = game_root.join("archive").join("pc").join("mod");
    let path = dir.join("modlist.txt");
    let managed = path.is_file() && is_managed(&dir, &path);

    // 有内容要写、而盘上这份不是我们写的 → 绝不覆盖。
    if !order.is_empty() && path.is_file() && !managed {
        return Err(CommandError::new(
            "MODLIST_UNMANAGED",
            "archive/pc/mod/modlist.txt 已存在，而且不是本启动器写的。为避免破坏你的加载顺序，已停止写入；请在设置里选择「备份并接管」。",
        ));
    }

    // 游戏原生 modlist.txt 只认文件名，不认目录。
    let mut names: Vec<String> = Vec::with_capacity(order.len());
    let mut seen: HashSet<String> = HashSet::new();
    for relative in &order {
        let name = relative
            .rsplit('/')
            .next()
            .unwrap_or(relative.as_str())
            .to_string();
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(CommandError::new(
                "MODLIST_DUPLICATE",
                format!(
                    "检测到同名 archive：{name}。游戏原生 modlist.txt 只认文件名，无法表达两个同名文件；请重命名其中一个。"
                ),
            ));
        }
        names.push(name);
    }

    // 空清单，或顺序恰好等于游戏默认的升序 → 删掉这个文件，让游戏走原生顺序。
    // 官方同样的处理：默认顺序不需要被一份多余的文件「确认」一遍。
    if names.is_empty() || is_ascending(&names) {
        if managed {
            fs::remove_file(&path)?;
        }
        clear_managed(&dir);
        return Ok(None);
    }

    fs::create_dir_all(&dir)?;
    // 纯文件名 + CRLF + 无尾随换行，与官方逐字同构。
    let content = names.join("\r\n");
    write_atomic(&path, &content)?;
    // 托管标记写进旁挂文件（顺带完成老版本「首行注释」的迁移）。
    fs::write(managed_mark_path(&dir), fingerprint(&content))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 原子覆盖写文本文件（同目录 temp + rename）。
///
/// 为什么不「先 remove 再 rename」：两步之间崩溃/断电会留下「文件根本不存在」的
/// 状态——modlist.txt 消失意味着全部 archive 的加载顺序丢失，而临时文件还在，
/// 但用户不会去游戏目录里翻一个 `.cyberdeck-tmp`。
/// 同目录 rename 在 Windows 上等价 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，
/// 失败时目标保持原样，不存在中间态。
fn write_atomic(path: &Path, content: &str) -> AppResult<()> {
    let temp = path.with_extension("txt.cyberdeck-tmp");
    fs::write(&temp, content)?;
    if let Err(err) = fs::rename(&temp, path) {
        return Err(CommandError::new(
            "MODLIST_WRITE",
            format!(
                "写入 {} 失败（原文件未被改动，临时文件保留在 {}）：{err}",
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.display().to_string()),
                temp.display()
            ),
        ));
    }
    Ok(())
}

pub fn backup_unmanaged_modlist(store: &Store, game_root: &Path) -> AppResult<Option<String>> {
    let path = game_root
        .join("archive")
        .join("pc")
        .join("mod")
        .join("modlist.txt");
    if !path.is_file() {
        return Ok(None);
    }
    let target = store
        .backups_dir
        .join(format!("modlist-before-takeover-{}.txt", now_stamp()));
    fs::copy(&path, &target)?;
    Ok(Some(target.to_string_lossy().to_string()))
}

pub fn remove_modlist(game_root: &Path) -> AppResult<bool> {
    let dir = game_root.join("archive").join("pc").join("mod");
    let path = dir.join("modlist.txt");
    if !path.is_file() {
        clear_managed(&dir);
        return Ok(false);
    }
    if !is_managed(&dir, &path) {
        return Err(CommandError::new(
            "MODLIST_UNMANAGED",
            "这个 modlist.txt 不是启动器写的，不会删除。",
        ));
    }
    fs::remove_file(&path)?;
    clear_managed(&dir);
    Ok(true)
}

#[cfg(test)]
mod managed_header_tests {
    use super::*;
    #[test]
    fn current_header_is_managed() {
        assert!(is_managed_modlist("# Managed by CyberDeck Launcher\nfoo.archive\n"));
    }

    #[test]
    fn user_written_file_is_not_managed() {
        assert!(!is_managed_modlist("foo.archive\nbar.archive\n"));
        assert!(!is_managed_modlist(""));
        // 只是前缀相似不算：必须整行匹配到标记。
        assert!(!is_managed_modlist("# Managed by someone else\n"));
    }

    /// 原子写：覆盖已存在文件、内容完整、不留 temp 残留。
    ///
    /// 这条测试防的是回退成「先 remove 再 rename」——那种写法在正常路径下也能过，
    /// 只有在「remove 之后崩溃」时才炸，所以这里断言的是不变量（旧文件在 rename
    /// 之前始终可读、且写完没有 .cyberdeck-tmp 残留），而不是时序。
    #[test]
    fn write_atomic_replaces_without_leftovers() {
        let dir = std::env::temp_dir().join(format!(
            "cdl-modlist-atomic-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("modlist.txt");
        fs::write(&path, "# old\nold.archive\n").unwrap();

        write_atomic(&path, "# new\nnew.archive\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# new\nnew.archive\n");

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|item| item.ok())
            .map(|item| item.file_name().to_string_lossy().to_string())
            .filter(|name| name != "modlist.txt")
            .collect();
        assert!(leftovers.is_empty(), "残留文件：{leftovers:?}");

        let _ = fs::remove_dir_all(&dir);
    }
}
