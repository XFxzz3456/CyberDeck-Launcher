//! 兼容性体检：**只查核心前置框架**，不再逐 Mod 找元数据（看板【13】B / 任务 b014cf）。
//!
//! 为什么推翻旧实现：旧版遍历全库、去每个 Mod 目录里找 `gameVersion` 之类的
//! 声明。但 CP2077 生态的现实是——绝大多数老 Mod 根本不带这种元数据，于是
//! 186 个 Mod 里有 114 个被标成「兼容性未知」。这个结论对玩家零价值，却会
//! 让人误以为"我装了一堆不兼容的东西"，属于纯焦虑制造器。
//!
//! 现在的判定口径（对齐 Vortex 的思路）：**版本兼容性由核心前置承担**。
//! RED4ext / ArchiveXL / TweakXL / Codeware 只要装好、文件完整，绝大多数
//! Mod 就能跑；真出问题也是这四件之一先坏。所以：
//!
//! - 前置齐全 → 一句「核心前置已就绪」，不给任何列表；
//! - 缺前置 → 记为风险（红），并说清缺的是哪一件、应该放哪个目录；
//! - 目录在但主文件不在（升级中断、被杀软删 dll）→ 记为风险（黄），
//!   这种"半装"状态是玩家最容易踩、也最难自己看出来的坑。
//!
//! 除这四件之外，CET / redscript / Mod Settings / Audioware / Input Loader
//! 也一并体检并回显状态，但它们属于「装了才有需求」，缺失不进风险列表。
//!
//! 刻意不做的事：不判「前置版本过旧」。判断过旧需要一份随游戏版本走的
//! 框架最低版本基线（要联网且会被上游改），拍脑袋写死数字等于制造假警报。
//! 报告里仍然回显每个框架的版本号，让用户和作者对话时有据可查。
//!
//! 只读操作：不修改任何 Mod 文件，也不写状态。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::gamever;
use crate::schema::AppResult;

/// 一个核心前置在游戏目录里的落点（相对路径）。
///
/// 前四件是「玩家一定会装」的：RED4ext 是所有原生插件的基础，ArchiveXL /
/// TweakXL / Codeware 覆盖了 90% 以上的现代 Mod，缺了必然出问题，所以
/// `critical = true`，缺失直接进风险列表。
///
/// 后四件（audioware / input_loader / Mod Settings / CET / redscript）属于
/// 「装了才有需求」：缺少它们不构成风险，只把状态显示在框架列表里，让用户
/// 想知道的时候能查。这与模块整体的「防焦虑」口径一致。
struct CoreFramework {
    id: &'static str,
    name: &'static str,
    /// 判定「装没装完」的候选主文件，按序取第一个命中的。
    /// 一个框架跨多代发行版时文件名会变（redscript 的 scc.exe 就是），
    /// 候选列表避免把新版判成缺失。
    files: &'static [&'static [&'static str]],
    /// 判定「装没装」的目录；目录在、候选文件全不在 = 半装。
    dir: &'static [&'static str],
    /// 缺失是否构成风险。
    critical: bool,
    note: &'static str,
}

const CORE_FRAMEWORKS: &[CoreFramework] = &[
    CoreFramework {
        id: "red4ext",
        name: "RED4ext",
        files: &[&["red4ext", "RED4ext.dll"]],
        dir: &["red4ext"],
        critical: true,
        note: "所有原生插件框架的运行基础",
    },
    CoreFramework {
        id: "archivexl",
        name: "ArchiveXL",
        files: &[&["red4ext", "plugins", "ArchiveXL", "ArchiveXL.dll"]],
        dir: &["red4ext", "plugins", "ArchiveXL"],
        critical: true,
        note: "扩展 archive 加载能力（依赖 RED4ext）",
    },
    CoreFramework {
        id: "tweakxl",
        name: "TweakXL",
        files: &[&["red4ext", "plugins", "TweakXL", "TweakXL.dll"]],
        dir: &["red4ext", "plugins", "TweakXL"],
        critical: true,
        note: "TweakDB 修改支持（依赖 RED4ext）",
    },
    CoreFramework {
        id: "codeware",
        name: "Codeware",
        files: &[&["red4ext", "plugins", "Codeware", "Codeware.dll"]],
        dir: &["red4ext", "plugins", "Codeware"],
        critical: true,
        note: "许多功能模组依赖的脚本库",
    },
    CoreFramework {
        id: "cet",
        name: "Cyber Engine Tweaks",
        files: &[
            &[
                "bin",
                "x64",
                "plugins",
                "cyber_engine_tweaks",
                "cyber_engine_tweaks.dll",
            ],
            &["bin", "x64", "plugins", "cyber_engine_tweaks", "init.lua"],
        ],
        dir: &["bin", "x64", "plugins", "cyber_engine_tweaks"],
        critical: false,
        note: "CET 控制台 / Lua 模组运行时",
    },
    CoreFramework {
        id: "redscript",
        name: "redscript",
        // 新版编译器叫 scc.exe，旧发行版叫 redscript-cli.exe；只认旧名是常见的假红灯来源。
        files: &[
            &["engine", "tools", "scc.exe"],
            &["engine", "tools", "redscript-cli.exe"],
            &["r6", "config", "cybercmd", "scc.toml"],
        ],
        dir: &["engine", "tools"],
        critical: false,
        note: "编译 r6/scripts 下的 .reds 脚本",
    },
    CoreFramework {
        id: "modsettings",
        name: "Mod Settings",
        files: &[
            &["red4ext", "plugins", "mod_settings", "ModSettings.dll"],
            &["red4ext", "plugins", "mod_settings", "mod_settings.dll"],
        ],
        dir: &["red4ext", "plugins", "mod_settings"],
        critical: false,
        note: "模组统一设置菜单",
    },
    CoreFramework {
        id: "audioware",
        name: "Audioware",
        files: &[&["red4ext", "plugins", "audioware", "audioware.dll"]],
        dir: &["red4ext", "plugins", "audioware"],
        critical: false,
        note: "自定义音频 / 语音事件支持",
    },
    CoreFramework {
        id: "input_loader",
        name: "Input Loader",
        files: &[&["red4ext", "plugins", "input_loader", "input_loader.dll"]],
        dir: &["red4ext", "plugins", "input_loader"],
        critical: false,
        note: "输入映射扩展（依赖 RED4ext）",
    },
];

/// 单个前置的体检结果（界面按行渲染，不再有"未知"这种状态）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompatFramework {
    pub id: String,
    pub name: String,
    /// ok | missing | broken
    pub status: String,
    /// 从主文件读到的文件版本；读不到为 None（不影响判定）。
    pub version: Option<String>,
    /// 期望落点，缺失时给用户指路。
    pub path: String,
    pub note: String,
}

/// 真正的风险项。只有缺失 / 半装才会产生，没有问题就是空数组。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompatRisk {
    pub id: String,
    pub name: String,
    /// risk（红，缺前置）| warn（黄，装得不完整）
    pub severity: String,
    /// 一句话结论，直接上屏。
    pub reason: String,
    /// 补充说明（期望路径 / 下载建议）。
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompatReport {
    /// 游戏内部版本原文（3.0.88.46235）。
    pub target_version: String,
    /// 社区叫法（2.5 / 旧版 (2.0 及以下) / 未知版本）。
    pub target_label: String,
    /// 版本号是否命中已知映射。false 时界面只说"未知版本"，不下结论。
    pub target_matched: bool,
    /// 是否读到了游戏目录；false 时只提示绑定目录，不报风险。
    pub game_found: bool,
    pub checked_at: String,
    /// 实际检查的前置数量。
    pub scanned: usize,
    pub frameworks: Vec<CompatFramework>,
    pub risks: Vec<CompatRisk>,
    /// 无任何风险 —— 界面据此显示绿色总结。
    pub healthy: bool,
}

fn join(root: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(root.to_path_buf(), |acc, item| acc.join(item))
}

/// 检查一个前置。返回体检结果 + 可能的风险项。
fn probe(root: &Path, spec: &CoreFramework) -> (CompatFramework, Option<CompatRisk>) {
    let dir = join(root, spec.dir);
    let candidates: Vec<PathBuf> = spec.files.iter().map(|segs| join(root, segs)).collect();
    let dir_exists = dir.is_dir();
    let found = candidates.iter().find(|path| path.is_file());
    // 回显路径优先给"实际命中的那个"，没命中就给首个候选（用户照着它核对目录）。
    let shown = found
        .map(|path| path.to_string_lossy().to_string())
        .or_else(|| {
            candidates
                .first()
                .map(|path| path.to_string_lossy().to_string())
        })
        .unwrap_or_default();
    // 目录本身不是文件，没有版本资源可读；只在主文件存在时问一次。
    let version = found.and_then(|path| crate::game::file_version(path));

    let (status, risk) = if found.is_some() {
        ("ok", None)
    } else if dir_exists {
        // 目录在、主文件不在：升级中断、被安全软件删 dll、或手动删了一半。
        // 半装对任何框架都是真问题（框架自己起不来），无论 critical 与否都报。
        (
            "broken",
            Some(CompatRisk {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                severity: "warn".to_string(),
                reason: format!("{} 安装不完整，缺少主文件", spec.name),
                detail: format!("目录里找不到 {shown}。建议重新安装 {} 后重启游戏。", spec.name),
            }),
        )
    } else if spec.critical {
        (
            "missing",
            Some(CompatRisk {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                severity: "risk".to_string(),
                reason: format!("缺少核心前置 {}", spec.name),
                detail: format!("{}。期望路径：{shown}", spec.note),
            }),
        )
    } else {
        // 「装了才有需求」的框架：只回显状态，不进风险列表，避免制造焦虑。
        ("missing", None)
    };

    (
        CompatFramework {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            status: status.to_string(),
            version,
            path: shown,
            note: spec.note.to_string(),
        },
        risk,
    )
}

/// 体检入口。`root` 为 `None` 表示游戏目录没绑定/不可用。
///
/// `target` 是游戏 exe 的版本原文，仅用于生成展示用的社区版本号；判定本身
/// 不依赖它——前置齐不齐全与游戏版本无关。
pub fn scan(root: Option<&Path>, target: Option<&str>) -> AppResult<CompatReport> {
    let info = gamever::describe(target.unwrap_or(""));
    let mut report = CompatReport {
        target_version: if target.is_some() {
            info.raw.clone()
        } else {
            String::new()
        },
        target_label: info.label.clone(),
        target_matched: info.matched,
        game_found: root.is_some(),
        checked_at: crate::store::now_iso(),
        scanned: 0,
        frameworks: Vec::new(),
        risks: Vec::new(),
        healthy: false,
    };

    let Some(root) = root else {
        // 没绑定目录不是"有风险"，是还没法检查：healthy 保持 false，
        // 界面按 gameFound 走中性提示，不会渲染红框。
        return Ok(report);
    };

    for spec in CORE_FRAMEWORKS {
        report.scanned += 1;
        let (item, risk) = probe(root, spec);
        report.frameworks.push(item);
        if let Some(risk) = risk {
            report.risks.push(risk);
        }
    }
    // 缺 RED4ext 时其它三个插件必然一起失效，给一句合并结论，免得用户以为要修四处。
    report.healthy = report.risks.is_empty();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("cdl-compat-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"stub").unwrap();
    }

    /// 四件核心前置齐全 → healthy，且风险列表必须是空的（这是"防焦虑"的核心）。
    /// 注意：非核心框架（CET / redscript / …）此时缺着，但**不该**产生风险。
    #[test]
    fn all_core_frameworks_installed_is_healthy() {
        let root = fixture("healthy");
        touch(&root.join("red4ext").join("RED4ext.dll"));
        touch(&root.join("red4ext").join("plugins").join("ArchiveXL").join("ArchiveXL.dll"));
        touch(&root.join("red4ext").join("plugins").join("TweakXL").join("TweakXL.dll"));
        touch(&root.join("red4ext").join("plugins").join("Codeware").join("Codeware.dll"));

        let report = scan(Some(&root), Some("3.0.88.46235")).unwrap();
        assert_eq!(report.scanned, CORE_FRAMEWORKS.len());
        assert_eq!(report.frameworks.len(), CORE_FRAMEWORKS.len());
        assert!(report.risks.is_empty(), "齐全时不该有任何风险：{report:?}");
        assert!(report.healthy);
        assert_eq!(report.target_label, "2.5");
        assert!(report.target_matched);
        let _ = fs::remove_dir_all(root);
    }

    /// 新版 redscript 只带 scc.exe（不再有 redscript-cli.exe），必须判成已安装。
    #[test]
    fn new_redscript_scc_is_recognized() {
        let root = fixture("scc");
        touch(&root.join("engine").join("tools").join("scc.exe"));
        let report = scan(Some(&root), None).unwrap();
        let redscript = report
            .frameworks
            .iter()
            .find(|item| item.id == "redscript")
            .expect("应检查 redscript");
        assert_eq!(redscript.status, "ok");
        assert!(redscript.path.to_lowercase().ends_with("scc.exe"));
        let _ = fs::remove_dir_all(root);
    }

    /// 非核心框架缺失只回显状态，不进风险列表。
    #[test]
    fn optional_framework_missing_is_not_a_risk() {
        let root = fixture("optional");
        let report = scan(Some(&root), None).unwrap();
        assert!(report.risks.iter().all(|item| {
            CORE_FRAMEWORKS
                .iter()
                .any(|spec| spec.id == item.id && spec.critical)
        }));
        let cet = report
            .frameworks
            .iter()
            .find(|item| item.id == "cet")
            .expect("应检查 CET");
        assert_eq!(cet.status, "missing");
        let _ = fs::remove_dir_all(root);
    }

    /// 空目录 → 四个核心缺失，且结论不 healthy；每个风险都带期望路径。
    #[test]
    fn empty_dir_reports_missing_frameworks_with_paths() {
        let root = fixture("empty");
        let report = scan(Some(&root), None).unwrap();
        assert_eq!(report.scanned, CORE_FRAMEWORKS.len());
        assert_eq!(report.risks.len(), 4);
        assert!(!report.healthy);
        assert!(report.risks.iter().all(|item| item.severity == "risk"));
        assert!(report.risks.iter().all(|item| item.detail.contains("期望路径")));
        let _ = fs::remove_dir_all(root);
    }

    /// 目录在、dll 不在（升级中断/被杀软删）→ 黄灯而不是"缺失"。
    #[test]
    fn half_installed_framework_is_warn_not_missing() {
        let root = fixture("broken");
        fs::create_dir_all(root.join("red4ext").join("plugins").join("ArchiveXL")).unwrap();
        let report = scan(Some(&root), None).unwrap();
        let archive = report
            .frameworks
            .iter()
            .find(|item| item.id == "archivexl")
            .expect("应检查 ArchiveXL");
        assert_eq!(archive.status, "broken");
        let risk = report
            .risks
            .iter()
            .find(|item| item.id == "archivexl")
            .expect("半装应记为风险");
        assert_eq!(risk.severity, "warn");
        let _ = fs::remove_dir_all(root);
    }

    /// 没有游戏目录：不产出任何风险，但也不能说 healthy（还没查过）。
    #[test]
    fn missing_game_dir_reports_nothing_but_not_healthy() {
        let report = scan(None, None).unwrap();
        assert!(!report.game_found);
        assert_eq!(report.scanned, 0);
        assert!(report.risks.is_empty());
        assert!(!report.healthy);
    }

    /// 未知版本号要传下去，界面据此显示"未知版本"而不是随便猜一个。
    #[test]
    fn unknown_version_is_flagged_in_report() {
        let root = fixture("unknown-ver");
        let report = scan(Some(&root), Some("9.9.9.9")).unwrap();
        assert_eq!(report.target_label, crate::gamever::UNKNOWN_LABEL);
        assert!(!report.target_matched);
        assert_eq!(report.target_version, "9.9.9.9", "原始号要留住");
        let _ = fs::remove_dir_all(root);
    }
}
