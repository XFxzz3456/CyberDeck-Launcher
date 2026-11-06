//! Vortex 模组目录导入：把 Vortex 的 mod 存储目录当成「一个目录 = 一个模组」来读。
//!
//! 为什么需要它：`adopt::scan` 是从 `archive/pc/mod` 的文件反推模组的，
//! 一个 `.archive` 就是一条。而 Vortex 的口径是「一个 mod 可以同时含
//! archive / CET / redscript / RED4ext 多类文件」，两者根本不是同一个维度。
//! 更要命的是 archive 反推只看顶层文件，`archive/pc/mod/<子目录>/x.archive`
//! 这种（4K 材质包很常见）整批漏掉。
//!
//! Vortex 的 mod 存储目录结构恰好就是「游戏根镜像」：每个 mod 一个目录，
//! 目录内保留 `archive/`、`r6/`、`bin/` 等完整相对路径。所以直接读这个目录树
//! 就能拿到精确归属，不用猜。

use crate::installer::recognized_root;
use std::fs;
use std::path::{Path, PathBuf};

/// 递归深度上限：mod 目录最深也就 8 层，超过基本是符号链接环。
const MAX_DEPTH: usize = 8;

/// Vortex 里这款游戏的 domain / 目录名。
pub const GAME_ID: &str = "cyberpunk2077";

/// 一个 Vortex mod 目录的扫描结果。
#[derive(Debug, Clone)]
pub struct VortexModDir {
    /// 原始目录名（带 Nexus 版本戳），用作稳定 id 的种子。
    pub dir_name: String,
    /// 剥掉版本戳后的显示名。
    pub display_name: String,
    /// 游戏根相对路径（斜杠分隔），只保留游戏目录里真实存在的文件。
    pub files: Vec<String>,
}

fn is_all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// 从 Vortex 目录名里剥掉 Nexus 版本戳，得到给人看的名字。
///
/// 生态里有两种命名形态（都是 Vortex 自己生成的）：
/// - 旧式连字符：`0 SP0 - BODY MOD 2.0-1424-1-2-1-1756231818`
/// - 新式空格：`DigitalVixenCore 28390 4.9.10 2026-11-02T11-50Z rxs7xRen8`
///
/// 两种的共同点：末尾有一段连续的数字尾巴（mod id + 版本号 + 时间戳 + 随机串）。
/// 从右往左吃掉数字段，遇到第一个非纯数字段就停 —— 名字中间的 `2.0` 因为
/// 带小数点，天然不会被误吃。
pub fn strip_version_stamp(name: &str) -> String {
    let trimmed = name.trim();

    // 新式：`<名字> <modId> <版本> <ISO时间> <随机串>`
    let spaced: Vec<&str> = trimmed.split(' ').collect();
    if spaced.len() >= 5 {
        let n = spaced.len();
        let tail_rand = spaced[n - 1];
        let tail_iso = spaced[n - 2];
        let tail_ver = spaced[n - 3];
        let tail_id = spaced[n - 4];
        if is_all_digits(tail_id)
            && tail_iso.contains('T')
            && tail_iso.ends_with('Z')
            && tail_rand.len() >= 6
            && tail_ver.starts_with(|c: char| c.is_ascii_digit())
        {
            return spaced[..n - 4].join(" ").trim_end().to_string();
        }
    }

    // 旧式：`<名字>-<modId>-<版本1>-<版本2>-<版本3>-<时间戳>`
    // 从末尾连续吃掉纯数字段；至少要吃掉 3 段（modId + 版本 + 时间戳）才动手，
    // 否则 `Call of Duty-2` 这种名字会被削。
    let hyphenated: Vec<&str> = trimmed.split('-').collect();
    if hyphenated.len() >= 4 {
        let mut cut = hyphenated.len();
        while cut > 0 && is_all_digits(hyphenated[cut - 1].trim()) {
            cut -= 1;
        }
        let eaten = hyphenated.len() - cut;
        if eaten >= 3 {
            let head = hyphenated[..cut].join("-");
            let cleaned = head
                .trim_end()
                .trim_end_matches(['.', ' ', '-', '_'])
                .trim_start_matches(['-', ' ', '_'])
                .trim();
            if !cleaned.is_empty() {
                return cleaned.to_string();
            }
        }
    }

    trimmed.to_string()
}

/// 定位 Vortex 的 mod 存储根。
///
/// 优先读 Vortex 自己的设置（`settings.mods.installPath.<gameId>`，支持 `{game}`
/// 占位符）—— 玩家把 mod 目录挪到别的盘很常见，硬编码必踩坑。读不到再退到
/// 默认位置 `<appdata>/Vortex/<gameId>/mods`。
pub fn find_mods_root(game_id: &str) -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let base = PathBuf::from(appdata).join("Vortex");

    let backup = base
        .join("temp")
        .join("state_backups_full")
        .join("hourly.json");
    if let Ok(raw) = fs::read_to_string(&backup) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            let template = value
                .get("settings")
                .and_then(|item| item.get("mods"))
                .and_then(|item| item.get("installPath"))
                .and_then(|item| item.get(game_id))
                .and_then(|item| item.as_str());
            if let Some(template) = template {
                let resolved = template.replace("{game}", game_id);
                let candidate = PathBuf::from(&resolved);
                let candidate = if candidate.is_absolute() {
                    candidate
                } else {
                    base.join(candidate)
                };
                if candidate.is_dir() {
                    return Some(candidate);
                }
            }
        }
    }

    let fallback = base.join(game_id).join("mods");
    if fallback.is_dir() {
        return Some(fallback);
    }
    None
}

fn collect_files(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_files(root, &path, depth + 1, out);
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        // 只收「游戏根镜像」里的文件：Vortex 有时会在 mod 目录里留
        // `__vortex_backup`、`.installing` 这类元数据，不能当模组内容。
        let text = rel.to_string_lossy().replace('\\', "/");
        let first = text.split('/').next().unwrap_or_default();
        if !recognized_root(first) {
            continue;
        }
        out.push(text);
    }
}

/// 枚举 mod 存储根下的所有模组目录。
///
/// 只保留「游戏目录里真实存在」的文件 —— 空目录（玩家把内容挪走/隔离过）
/// 与半残目录直接跳过，否则会造出一堆指向不存在文件的条目。
pub fn scan_dirs(root: &Path, game_root: &Path) -> Vec<VortexModDir> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let mut raw = Vec::new();
        collect_files(&entry.path(), &entry.path(), 0, &mut raw);

        let mut files: Vec<String> = raw
            .into_iter()
            .filter(|rel| game_root.join(rel.replace('/', "\\")).is_file())
            .collect();
        if files.is_empty() {
            continue;
        }
        files.sort_by_key(|item| item.to_ascii_lowercase());
        files.dedup();

        out.push(VortexModDir {
            display_name: strip_version_stamp(&dir_name),
            dir_name,
            files,
        });
    }
    out.sort_by_key(|item| item.display_name.to_ascii_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_hyphenated_stamp() {
        assert_eq!(
            strip_version_stamp("- 0 SP0 - BODY MOD 2.0-1424-1-2-1-1756231818"),
            "0 SP0 - BODY MOD 2.0"
        );
        assert_eq!(
            strip_version_stamp("Gone Away-19412-1-1-1-1774982597"),
            "Gone Away"
        );
        assert_eq!(
            strip_version_stamp("2077 More Gore V3.0.-3040-3-0-1724171105"),
            "2077 More Gore V3.0"
        );
    }

    #[test]
    fn strips_spaced_stamp() {
        assert_eq!(
            strip_version_stamp("DigitalVixenCore 28390 4.9.10 2026-11-02T11-50Z rxs7xRen8"),
            "DigitalVixenCore"
        );
        assert_eq!(
            strip_version_stamp("ArchiveXL 4198 1.27.3 2026-09-07T10-15Z aI50IA5YP"),
            "ArchiveXL"
        );
    }

    #[test]
    fn keeps_names_without_stamp() {
        assert_eq!(strip_version_stamp("Call of Duty-2"), "Call of Duty-2");
        assert_eq!(strip_version_stamp("in_world_navigation"), "in_world_navigation");
    }
}
