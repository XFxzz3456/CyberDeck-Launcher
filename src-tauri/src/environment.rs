//! 环境体检与自愈。
//!
//! 部署记录里存了目标文件的（大小, 修改时间），这里拿它和磁盘现状比对：
//!   - 目标不存在        → critical，需要重建链接
//!   - 大小差超过容差    → warning，文件可能被整体替换
//!   - 只有时间/细微信息变 → info（灰「提示」），多半是杀软扫描或外部工具碰过
//!
//! 🔴 误报取舍（2026-11-02 用户实测反馈）：原先「字节数不等就报大小异常、时间戳
//! 不等就报被改写」把玩家吓到了——Vortex 接管、杀软扫描都会改写元数据，游戏却
//! 照常能跑。现在按文件类型分级：
//!   - 脚本 / 配置（`.xl` `.reds` `.lua` `.json` …）工具会频繁重写，**只查存在性**；
//!   - 其它文件允许 [`SIZE_TOLERANCE_BYTES`] 的字节抖动；
//!   - 剩下的差异最多进 info 档，不再默认打黄灯。
//!
//! 自愈只做一件事：拿暂存区的源文件重建链接。源也没了就只能标记为需要重新导入，
//! 不会去猜测内容、也不会偷偷下载任何东西。

use std::fs;
use std::path::{Path, PathBuf};

use crate::installer;
use crate::schema::{CommandError, EnvDiagnosis, EnvIssue, HealReport};
use crate::store::Store;

/// 大小比对的容差。
///
/// `.archive` 这类文件被杀毒软件扫描、被 Vortex 重新落盘后，字节数可能有个位数到
/// 几百字节的差异；这不是"被改写"，报出来只会制造焦虑。超过这个量级才当回事。
const SIZE_TOLERANCE_BYTES: u64 = 1024;

/// 这些后缀属于脚本 / 配置 / 元数据，外部工具（Vortex、CET、redscript、汉化包）
/// 会频繁重写它们，比对大小与时间戳纯属噪音 —— 只查「还在不在」。
pub(crate) fn is_tool_editable(relative_path: &str) -> bool {
    let lower = relative_path.to_ascii_lowercase();
    [
        ".xl", ".xlp", ".reds", ".lua", ".toml", ".json", ".ini", ".yaml", ".yml", ".txt",
        ".csv", ".xml", ".log", ".bak",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}


/// 体检所有「已启用」且「有部署清单」的模组。
///
/// 只看 enabled 的模组：停用状态本来就不该在游戏目录里留文件，
/// 把它们算成缺失会让健康度长期挂在 critical，反而失去参考价值。
pub fn diagnose_environment(store: &Store) -> Result<EnvDiagnosis, CommandError> {
    let data = store.snapshot_data();
    let mut issues: Vec<EnvIssue> = Vec::new();
    let mut checked_mods = 0usize;
    let mut checked_files = 0usize;

    for entry in data.mods.iter().filter(|item| item.enabled) {
        if entry.deployed_files.is_empty() {
            continue;
        }
        checked_mods += 1;
        for file in &entry.deployed_files {
            checked_files += 1;
            if let Some(issue) = inspect_file(&entry.id, &entry.name, file) {
                issues.push(issue);
            }
        }
    }

    let level = classify(&issues);
    let summary = build_summary(level, checked_mods, checked_files, &issues);

    Ok(EnvDiagnosis {
        level: level.to_string(),
        checked_mods,
        checked_files,
        issues,
        summary,
    })
}

/// 一键自愈：只重建「目标缺失或大小不符」的链接，其余问题只报告不动手。
pub fn heal_environment(store: &Store) -> Result<HealReport, CommandError> {
    let mut data = store.snapshot_data();
    let game_root = data
        .game_dir
        .clone()
        .map(PathBuf::from)
        .ok_or_else(|| CommandError::new("NO_GAME_DIR", "还没有绑定游戏目录，无法修复。"))?;
    // 一键自愈按用户选择的部署方式重建链接（deepseek 任务·模块一）。
    let deploy_mode = data.settings.deploy_mode.clone();

    let mut repaired = 0usize;
    let mut still_broken: Vec<EnvIssue> = Vec::new();

    for entry in data.mods.iter_mut().filter(|item| item.enabled) {
        // 先把名字借出来，后面要可变借用 deployed_files，不能再持有 entry 的不可变借用。
        let mod_id = entry.id.clone();
        let mod_name = entry.name.clone();
        for file in entry.deployed_files.iter_mut() {
            let Some(issue) = inspect_file(&mod_id, &mod_name, file) else {
                continue;
            };
            // 时间戳变化属于正常改写（用户手动改过、游戏更新过），不重建。
            if issue.kind == "time" {
                still_broken.push(issue);
                continue;
            }

            let source = Path::new(&file.source);
            if !source.exists() {
                // 暂存区也没了，只能让用户重新导入；这里不伪造内容。
                still_broken.push(EnvIssue {
                    kind: "source_missing".to_string(),
                    detail: "暂存区里的源文件已经不在了，需要重新导入这个模组。".to_string(),
                    ..issue
                });
                continue;
            }

            let target = Path::new(&file.target);
            if let Some(parent) = target.parent() {
                if let Err(err) = fs::create_dir_all(parent) {
                    still_broken.push(EnvIssue {
                        detail: format!("无法重建目录 {}：{err}", parent.display()),
                        ..issue
                    });
                    continue;
                }
            }
            // 目标可能是个坏链接或大小不对的残留，先清掉再建。
            if target.exists() || target.symlink_metadata().is_ok() {
                let _ = fs::remove_file(target);
            }
            match installer::create_link_with_mode(source, target, &deploy_mode) {
                Ok((_, notes)) => {
                    let (size, mtime) = installer::file_stamp(target);
                    file.size = size;
                    file.modified_time = mtime;
                    repaired += 1;
                    // 环境体检自己已有 issue 通道，这里的降级说明不重复上抛；
                    // 但保留收集（`notes`）是为了将来需要时能写进体检详情。
                    let _ = notes;
                }
                Err(err) => still_broken.push(EnvIssue {
                    detail: format!("重建链接失败：{err}"),
                    ..issue
                }),
            }
        }
    }

    // 校验游戏目录仍存在，避免绑定路径失效后误判为修好了。
    let _ = &game_root;

    // 等级口径与体检保持一致：只剩时间戳这类变化时是灰「提示」，不是黄灯。
    let level = classify(&still_broken);
    let message = if repaired == 0 && still_broken.is_empty() {
        "环境本来就是好的，没有需要修复的文件。".to_string()
    } else if still_broken.is_empty() {
        format!("修复完成，重建了 {repaired} 个文件链接。")
    } else {
        format!(
            "重建了 {repaired} 个链接，还有 {} 个文件需要处理（见下方列表）。",
            still_broken.len()
        )
    };

    // 有改动才落盘，避免无意义地刷新状态文件。
    if repaired > 0 {
        let mut guard = store
            .data
            .lock()
            .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
        *guard = data;
        store.save(&guard)?;
    }

    Ok(HealReport {
        repaired,
        still_broken,
        level: level.to_string(),
        message,
    })
}

/// 检查单个已部署文件，没问题返回 None。
fn inspect_file(
    mod_id: &str,
    mod_name: &str,
    file: &crate::schema::DeployedFile,
) -> Option<EnvIssue> {
    let target = Path::new(&file.target);
    let meta = match fs::metadata(target) {
        Ok(meta) => meta,
        Err(_) => {
            return Some(EnvIssue {
                mod_id: mod_id.to_string(),
                mod_name: mod_name.to_string(),
                relative_path: file.relative_path.clone(),
                kind: "missing".to_string(),
                detail: "游戏目录里的这个文件不见了。".to_string(),
            })
        }
    };

    // 脚本 / 配置类：工具会反复重写，只看存在性。大小与时间一律不比。
    if is_tool_editable(&file.relative_path) {
        return None;
    }

    if let Some(expected) = file.size {
        let actual = meta.len();
        // 容差内直接放过：杀软扫描 / 外部工具重写导致的字节抖动不算问题。
        if actual.abs_diff(expected) > SIZE_TOLERANCE_BYTES {
            return Some(EnvIssue {
                mod_id: mod_id.to_string(),
                mod_name: mod_name.to_string(),
                relative_path: file.relative_path.clone(),
                kind: "size".to_string(),
                detail: format!(
                    "文件大小有变化（记录 {expected} 字节，实际 {actual} 字节），可能被外部工具改写过。"
                ),
            });
        }
    }

    if let Some(expected) = file.modified_time {
        let actual = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs());
        if let Some(actual) = actual {
            if actual != expected {
                return Some(EnvIssue {
                    mod_id: mod_id.to_string(),
                    mod_name: mod_name.to_string(),
                    relative_path: file.relative_path.clone(),
                    kind: "time".to_string(),
                    detail: "文件的修改时间变了，可能被杀毒软件或外部工具碰过；不影响游戏加载。"
                        .to_string(),
                });
            }
        }
    }

    None
}

/// 把问题列表折算成整体等级。
///
/// - 有文件丢失（`missing` / `source_missing`）→ `critical`（红）
/// - 有大小超容差 → `warning`（黄），这才值得动手修
/// - 只剩时间戳这类状态变化 → `info`（灰「提示」）：游戏通常照常能跑
/// - 空 → `healthy`
///
/// `info` 这一档是 2026-11-02 新增的：原先只要有任何一条差异就整块打黄灯，
/// 玩家看到一屏"警告"但游戏好好的，反而不知道该信哪个。
fn classify(issues: &[EnvIssue]) -> &'static str {
    if issues
        .iter()
        .any(|issue| issue.kind == "missing" || issue.kind == "source_missing")
    {
        "critical"
    } else if issues.iter().any(|issue| issue.kind == "size") {
        "warning"
    } else if !issues.is_empty() {
        "info"
    } else {
        "healthy"
    }
}

fn build_summary(level: &str, mods: usize, files: usize, issues: &[EnvIssue]) -> String {
    if mods == 0 {
        return "还没有部署任何模组，先部署几个再来体检。".to_string();
    }
    match level {
        "healthy" => format!("{mods} 个模组、{files} 个文件全部正常。"),
        "info" => format!(
            "{mods} 个模组共 {files} 个文件，其中 {} 个文件状态有变化，核心文件都在，游戏通常可正常运行。",
            issues.len()
        ),
        "warning" => format!(
            "{mods} 个模组共 {files} 个文件，其中 {} 个文件大小有变化，建议修复。",
            issues.len()
        ),
        _ => {
            let missing = issues.iter().filter(|issue| issue.kind == "missing").count();
            format!("{mods} 个模组共 {files} 个文件，有 {missing} 个文件丢失，建议立刻修复。")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{DeployedFile, LinkType};

    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "cdl-env-{tag}-{}-{}",
            std::process::id(),
            crate::store::now_iso().replace(':', "-")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// 造一条部署记录：文件真实存在，大小/时间按调用方给的期望值。
    fn record(
        root: &Path,
        relative: &str,
        bytes: usize,
        expected_size: Option<u64>,
        expected_time: Option<u64>,
    ) -> DeployedFile {
        let target = root.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, vec![0u8; bytes]).unwrap();
        DeployedFile {
            source: target.to_string_lossy().to_string(),
            target: target.to_string_lossy().to_string(),
            link_type: LinkType::Copy,
            relative_path: relative.replace('\\', "/"),
            size: expected_size,
            modified_time: expected_time,
        }
    }

    /// 脚本/配置被工具重写（大小差很多、时间也变）→ 一条问题都不该报。
    #[test]
    fn tool_editable_files_are_only_checked_for_existence() {
        let root = fixture("scripts");
        for rel in ["r6/scripts/foo.reds", "archive/pc/mod/bar.xl", "bin/x64/plugins/cet/init.lua"] {
            let file = record(&root, rel, 4096, Some(8), Some(1));
            assert!(
                inspect_file("m", "M", &file).is_none(),
                "{rel} 属于工具会重写的文件，不该报问题"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    /// `.archive` 几百字节抖动（杀软扫描 / 外部工具重写）在容差内 → 不报。
    #[test]
    fn small_size_drift_on_archive_is_tolerated() {
        let root = fixture("tolerance");
        let file = record(&root, "archive/pc/mod/a.archive", 2048, Some(2048 - 700), None);
        assert!(inspect_file("m", "M", &file).is_none());
        let _ = fs::remove_dir_all(root);
    }

    /// 超出容差才算"大小有变化"，且 detail 用中性措辞。
    #[test]
    fn large_size_drift_is_reported_neutrally() {
        let root = fixture("drift");
        let file = record(&root, "archive/pc/mod/b.archive", 10_000, Some(1000), None);
        let issue = inspect_file("m", "M", &file).expect("超出容差应报问题");
        assert_eq!(issue.kind, "size");
        assert!(issue.detail.contains("大小有变化"), "{}", issue.detail);
        assert!(!issue.detail.contains("异常"), "不该再出现'异常'这类吓人措辞");
        let _ = fs::remove_dir_all(root);
    }

    /// 时间戳变化只进 time 档（界面上是灰色「提示」），不升级成黄灯。
    #[test]
    fn timestamp_drift_is_not_a_warning_level_issue() {
        let root = fixture("mtime");
        let file = record(&root, "archive/pc/mod/c.archive", 512, Some(512), Some(1));
        let issue = inspect_file("m", "M", &file).expect("时间变化仍要留痕");
        assert_eq!(issue.kind, "time");
        assert!(issue.detail.contains("不影响游戏加载"), "{}", issue.detail);
        assert_eq!(classify(&[issue]), "info", "只有时间变化 → 灰「提示」");
        let _ = fs::remove_dir_all(root);
    }

    /// 等级折算：丢失 > 大小 > 时间 > 健康。
    #[test]
    fn levels_rank_missing_above_size_above_time() {
        let mk = |kind: &str| EnvIssue {
            mod_id: "m".into(),
            mod_name: "M".into(),
            relative_path: "a.archive".into(),
            kind: kind.into(),
            detail: String::new(),
        };
        assert_eq!(classify(&[]), "healthy");
        assert_eq!(classify(&[mk("time")]), "info");
        assert_eq!(classify(&[mk("time"), mk("size")]), "warning");
        assert_eq!(classify(&[mk("size"), mk("missing")]), "critical");
        assert_eq!(classify(&[mk("source_missing")]), "critical");
    }

    /// 文件真丢了仍然要红：容差策略不能把"缺失"一起放过。
    #[test]
    fn missing_file_still_screams() {
        let root = fixture("missing");
        let file = DeployedFile {
            source: root.join("gone").to_string_lossy().to_string(),
            target: root.join("archive/pc/mod/gone.archive").to_string_lossy().to_string(),
            link_type: LinkType::Copy,
            relative_path: "archive/pc/mod/gone.archive".to_string(),
            size: Some(10),
            modified_time: Some(1),
        };
        let issue = inspect_file("m", "M", &file).expect("文件不存在必须报");
        assert_eq!(issue.kind, "missing");
        assert_eq!(classify(&[issue]), "critical");
        let _ = fs::remove_dir_all(root);
    }
}
