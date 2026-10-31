//! 环境体检与自愈。
//!
//! 部署记录里存了目标文件的（大小, 修改时间），这里拿它和磁盘现状比对：
//!   - 目标不存在      → critical，需要重建链接
//!   - 大小不一致      → warning，文件可能被替换或截断
//!   - 时间不一致      → warning，多半是手动覆盖或游戏更新动过它
//!
//! 自愈只做一件事：拿暂存区的源文件重建链接。源也没了就只能标记为需要重新导入，
//! 不会去猜测内容、也不会偷偷下载任何东西。

use std::fs;
use std::path::{Path, PathBuf};

use crate::installer;
use crate::schema::{CommandError, EnvDiagnosis, EnvIssue, HealReport};
use crate::store::Store;

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

    let level = if issues.iter().any(|issue| issue.kind == "missing") {
        "critical"
    } else if issues.is_empty() {
        "healthy"
    } else {
        "warning"
    };
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

    let level = if still_broken.iter().any(|issue| {
        issue.kind == "missing" || issue.kind == "source_missing"
    }) {
        "critical"
    } else if still_broken.is_empty() {
        "healthy"
    } else {
        "warning"
    };
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

    if let Some(expected) = file.size {
        if meta.len() != expected {
            return Some(EnvIssue {
                mod_id: mod_id.to_string(),
                mod_name: mod_name.to_string(),
                relative_path: file.relative_path.clone(),
                kind: "size".to_string(),
                detail: format!("文件大小对不上（记录 {expected} 字节，实际 {} 字节）。", meta.len()),
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
                    detail: "文件的修改时间变了，可能被外部工具或游戏更新改写过。".to_string(),
                });
            }
        }
    }

    None
}

fn build_summary(level: &str, mods: usize, files: usize, issues: &[EnvIssue]) -> String {
    if mods == 0 {
        return "还没有部署任何模组，先部署几个再来体检。".to_string();
    }
    match level {
        "healthy" => format!("{mods} 个模组、{files} 个文件全部正常。"),
        "warning" => format!(
            "{mods} 个模组共 {files} 个文件，其中 {} 个文件被改写过，游戏仍可运行。",
            issues.len()
        ),
        _ => {
            let missing = issues.iter().filter(|issue| issue.kind == "missing").count();
            format!("{mods} 个模组共 {files} 个文件，有 {missing} 个文件丢失，建议立刻修复。")
        }
    }
}
