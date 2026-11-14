//! ModSettings 框架菜单文案的**只读**扫描（issue #6 范围②的第一步）。
//!
//! 为什么需要它：`user.ini` 只存键值（`modsettings.rs` 的 `ModSettingEntry` 里
//! 根本没有 label / tooltip 字段），框架菜单的**文案在 Lua**——每个模组在自己的
//! `init.lua` 里向 ModSettings 注册选项时写 `label = "…"` / `tooltip = "…"`。
//! 所以「框架菜单汉化」的载体是 `bin/x64/plugins/cyber_engine_tweaks/mods/<Mod>/`
//! 下的 Lua，而不是那份 ini。
//!
//! 本模块只回答一个问题：**这套菜单到底有多少条能直译、多少条够不着**。
//! 它是纯只读的：不写文件、不改游戏目录、不调 AI、不注册 Tauri 命令。
//! 写回层（备份 → 断链 → 写 → 登记 → 回滚）等真机校准后再接，
//! 风险清单见 `docs/ARCH-FULL-LOCALIZATION-2026-11-08.md` §5.1。
//!
//! 提取规则刻意**复用** `ailoc_full::display_strings(.., CarrierKind::Lua)`，
//! 不另写一套正则：报告里的数字必须等于将来真正会被改写的那批字符串，
//! 否则「能翻 N 条」就是空头支票。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ailoc_full::{display_strings, CarrierKind};

/// 单个模组目录最多看几个文件，防止异常目录（几千个语言表）拖住扫描。
const MAX_LANGUAGE_FILES: usize = 32;
/// 一次最多扫多少个模组目录。
const MAX_MOD_DIRS: usize = 400;
/// 单个 Lua 文件上限。菜单脚本都是小文件，超过这个尺寸一定不是我们想找的东西。
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// 一个模组的框架菜单扫描结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuLocItem {
    /// 模组目录名（= CET 里看到的 mod 文件夹名）。
    pub mod_id: String,
    /// 实际读过的文件，路径相对游戏根、正斜杠，和部署清单同一套写法。
    pub files: Vec<String>,
    /// 去重后可直译的文案条数（同一句话出现在两个文件里只算一条）。
    pub translatable: usize,
    /// 为什么是 0 条 / 为什么没读到文件。有可翻条目时为 `None`。
    pub skipped_reason: Option<String>,
}

/// 整体扫描结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuLocReport {
    /// CET 的 mods 目录是否存在。`false` 表示这台机器没装 CET（或没装任何 CET mod），
    /// 此时 `mods` 为空、`total_translatable` 为 0，但**不是错误**。
    pub available: bool,
    pub mods: Vec<MenuLocItem>,
    pub total_translatable: usize,
}

/// 扫描 CET 模组目录里的框架菜单文案。只读，失败一律降级为「这一项没扫到」。
#[allow(dead_code)] // 只读层先落地；写回层接入后才会有命令 / 单测之外的调用方
pub fn scan_menu_loc(game_dir: &Path) -> MenuLocReport {
    let mods_root = cet_mods_root(game_dir);
    if !mods_root.is_dir() {
        return MenuLocReport {
            available: false,
            mods: Vec::new(),
            total_translatable: 0,
        };
    }

    let mut dirs: Vec<PathBuf> = fs::read_dir(&mods_root)
        .map(|iter| {
            iter.filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default();
    // 排序 + 截断：同样的游戏目录扫两次必须给出同样的顺序，便于对比与测试。
    dirs.sort();
    dirs.truncate(MAX_MOD_DIRS);

    let mut mods: Vec<MenuLocItem> = Vec::new();
    let mut total_translatable = 0usize;
    for dir in dirs {
        let Some(mod_id) = dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let mut texts: BTreeSet<String> = BTreeSet::new();
        let mut files: Vec<String> = Vec::new();
        let mut unreadable = 0usize;

        for file in menu_files(&dir) {
            // 先看尺寸再读：菜单脚本都是小文件，超过上限的一定不是目标，不必读进内存。
            let too_big = fs::metadata(&file)
                .map(|meta| meta.len() > MAX_FILE_BYTES)
                .unwrap_or(true);
            if too_big {
                unreadable += 1;
                continue;
            }
            let Ok(content) = fs::read_to_string(&file) else {
                unreadable += 1;
                continue;
            };
            for text in display_strings(&content, CarrierKind::Lua) {
                texts.insert(text);
            }
            files.push(relative_to(game_dir, &file));
        }

        let translatable = texts.len();
        total_translatable += translatable;
        // 「0 条」有两种完全不同的含义，必须分开说：没找到脚本 / 找到了但文案不是字面量。
        let skipped_reason = if files.is_empty() {
            Some(if unreadable > 0 {
                "菜单脚本读不出来（被占用，或不是 UTF-8 编码）".to_string()
            } else {
                "没有 init.lua，也没有 modules/languages/*.lua".to_string()
            })
        } else if translatable == 0 {
            Some(
                "没有 label / tooltip 这类字面量：菜单文案可能由 Loc() 或语言表拼装，暂不支持"
                    .to_string(),
            )
        } else {
            None
        };

        mods.push(MenuLocItem {
            mod_id,
            files,
            translatable,
            skipped_reason,
        });
    }

    MenuLocReport {
        available: true,
        mods,
        total_translatable,
    }
}

/// `<game>/bin/x64/plugins/cyber_engine_tweaks/mods`。
///
/// 与 `game.rs` 的框架探测、`modsettings.rs` 的 ini 路径保持同一套拼装方式：
/// 逐段 join，不拼字符串，避免反斜杠 / 大小写在别的机器上出错。
fn cet_mods_root(game_dir: &Path) -> PathBuf {
    game_dir
        .join("bin")
        .join("x64")
        .join("plugins")
        .join("cyber_engine_tweaks")
        .join("mods")
}

/// 一个模组里可能承载菜单文案的文件：入口 `init.lua` + 语言表目录下的 `*.lua`。
fn menu_files(mod_dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let init = mod_dir.join("init.lua");
    if init.is_file() {
        out.push(init);
    }
    let languages = mod_dir.join("modules").join("languages");
    if languages.is_dir() {
        let mut extra: Vec<PathBuf> = fs::read_dir(&languages)
            .map(|iter| {
                iter.filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| path.is_file() && is_lua(path))
                    .collect()
            })
            .unwrap_or_default();
        extra.sort();
        extra.truncate(MAX_LANGUAGE_FILES);
        out.extend(extra);
    }
    out
}

fn is_lua(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("lua"))
        .unwrap_or(false)
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    struct Fixture {
        root: PathBuf,
        game: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(".test-tmp")
                .join(format!("menu-loc-{}", Uuid::new_v4().simple()));
            let game = root.join("game");
            fs::create_dir_all(&game).unwrap();
            Self { root, game }
        }

        /// 在假游戏目录里写一个 CET 模组文件。
        fn write_mod_file(&self, relative: &str, content: &str) {
            let path = self.game.join(relative.replace('/', "\\"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn mods_dir(&self) -> PathBuf {
            cet_mods_root(&self.game)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// 正常模组：3 条 label 字面量 + 1 条普通赋值（普通赋值不能算进去）。
    #[test]
    fn counts_label_literals_in_init_lua() {
        let fixture = Fixture::new();
        fixture.write_mod_file(
            "bin/x64/plugins/cyber_engine_tweaks/mods/TestMod/init.lua",
            r#"
local counter = 0
local settings = {
    { label = "Enable feature", type = "bool", default = true },
    { label = "Show minimap", type = "bool" },
    { label = "Toggle overlay" },
}
"#,
        );
        let report = scan_menu_loc(&fixture.game);
        assert!(report.available);
        assert_eq!(report.mods.len(), 1);
        assert_eq!(report.mods[0].mod_id, "TestMod");
        assert_eq!(report.mods[0].translatable, 3, "{:?}", report.mods[0]);
        assert_eq!(report.mods[0].skipped_reason, None);
        assert_eq!(report.total_translatable, 3);
        // 文件清单用正斜杠、相对游戏根，和部署清单同一套写法。
        assert_eq!(
            report.mods[0].files,
            vec!["bin/x64/plugins/cyber_engine_tweaks/mods/TestMod/init.lua".to_string()]
        );
    }

    /// 没装 CET：`available = false`，不 panic、不报错。
    #[test]
    fn missing_cet_directory_is_reported_not_thrown() {
        let fixture = Fixture::new();
        let empty = fixture.root.join("no-cet");
        fs::create_dir_all(&empty).unwrap();
        let report = scan_menu_loc(&empty);
        assert!(!report.available);
        assert!(report.mods.is_empty());
        assert_eq!(report.total_translatable, 0);

        // 连目录都不存在也要一样的结果。
        let report = scan_menu_loc(&fixture.root.join("nope"));
        assert!(!report.available);
        assert_eq!(report.total_translatable, 0);
        assert!(!fixture.mods_dir().exists());
    }

    /// 语言表目录也算载体；同一句话出现两次只计一条。
    #[test]
    fn language_tables_counted_once_per_unique_text() {
        let fixture = Fixture::new();
        fixture.write_mod_file(
            "bin/x64/plugins/cyber_engine_tweaks/mods/TestMod/init.lua",
            "local t = { label = \"Enable feature\" }\n",
        );
        fixture.write_mod_file(
            "bin/x64/plugins/cyber_engine_tweaks/mods/TestMod/modules/languages/en.lua",
            "return { label = \"Enable feature\", tooltip = \"Turns the feature on\" }\n",
        );
        let report = scan_menu_loc(&fixture.game);
        assert_eq!(report.mods[0].files.len(), 2, "{:?}", report.mods[0].files);
        assert_eq!(report.mods[0].translatable, 2, "{:?}", report.mods[0]);
    }

    /// 有脚本但文案是 `Loc("key")` 拼装的：必须给出 skipped 原因，不能假装 0 条 =
    /// 「没有文案」。
    #[test]
    fn indirect_labels_get_a_skip_reason() {
        let fixture = Fixture::new();
        fixture.write_mod_file(
            "bin/x64/plugins/cyber_engine_tweaks/mods/TestMod/init.lua",
            "local s = { label = Loc(\"enable_feature\"), tooltip = Loc(\"hint\") }\n",
        );
        let report = scan_menu_loc(&fixture.game);
        assert_eq!(report.mods[0].translatable, 0);
        let reason = report.mods[0].skipped_reason.clone().unwrap_or_default();
        assert!(reason.contains("语言表"), "{reason}");
    }
}
