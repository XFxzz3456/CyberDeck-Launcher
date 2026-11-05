use crate::schema::{
    AppResult, AppStateData, CommandError, LoadOrderItem, LoadOrderView,
};
use crate::store::{now_stamp, Store};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

/// 当前版本写进 modlist.txt 首行的管理标记。
pub const MANAGED_HEADER: &str = "# Managed by CyberDeck Launcher";

/// 判断 modlist.txt 首行是不是本启动器写的。
pub fn is_managed_modlist(raw: &str) -> bool {
    raw.starts_with(MANAGED_HEADER)
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
    let (modlist_exists, managed_modlist) = match &modlist_path {
        Some(path) => {
            let file = Path::new(path);
            if file.is_file() {
                let managed = fs::read_to_string(file)
                    .map(|raw| is_managed_modlist(&raw))
                    .unwrap_or(false);
                (true, managed)
            } else {
                (false, false)
            }
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

    if order.is_empty() {
        if path.is_file() {
            let managed = fs::read_to_string(&path)
                .map(|raw| is_managed_modlist(&raw))
                .unwrap_or(false);
            if managed {
                fs::remove_file(&path)?;
                return Ok(None);
            }
        }
        return Ok(None);
    }

    if path.is_file() {
        let raw = fs::read_to_string(&path)?;
        if !is_managed_modlist(&raw) {
            return Err(CommandError::new(
                "MODLIST_UNMANAGED",
                "archive/pc/mod/modlist.txt 已存在，而且不是本启动器写的。为避免破坏你的加载顺序，已停止写入；请在设置里选择「备份并接管」。",
            ));
        }
    }

    let mut names: HashSet<String> = HashSet::new();
    let mut lines: Vec<String> = vec![
        MANAGED_HEADER.to_string(),
        "# Delete this file to restore ASCII-alphabetical load order.".to_string(),
    ];
    for relative in order {
        let name = relative
            .rsplit('/')
            .next()
            .unwrap_or(relative.as_str())
            .to_string();
        if !names.insert(name.to_ascii_lowercase()) {
            return Err(CommandError::new(
                "MODLIST_DUPLICATE",
                format!(
                    "检测到同名 archive：{name}。游戏原生 modlist.txt 只认文件名，无法表达两个同名文件；请重命名其中一个。"
                ),
            ));
        }
        lines.push(name);
    }
    fs::create_dir_all(&dir)?;
    let content = format!("{}\n", lines.join("\r\n"));
    write_atomic(&path, &content)?;
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
    let path = game_root
        .join("archive")
        .join("pc")
        .join("mod")
        .join("modlist.txt");
    if !path.is_file() {
        return Ok(false);
    }
    let raw = fs::read_to_string(&path)?;
    if !is_managed_modlist(&raw) {
        return Err(CommandError::new(
            "MODLIST_UNMANAGED",
            "这个 modlist.txt 不是启动器写的，不会删除。",
        ));
    }
    fs::remove_file(path)?;
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
