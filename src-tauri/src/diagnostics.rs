use crate::deps::build_report as build_dependency_report;
use crate::game::{framework_statuses, log_paths, validate_game_dir};
use crate::schema::{
    AppStateData, DiagnosticIssue, DiagnosticsReport, GameInfo, InstallLayout,
};
use crate::store::{now_iso, Store};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub fn build_report(_store: &Store, state: &AppStateData, game: Option<&GameInfo>) -> DiagnosticsReport {
    let mut issues = Vec::new();
    let frameworks = game
        .map(|info| framework_statuses(Path::new(&info.root)))
        .unwrap_or_default();
    // 依赖检查与框架探测共用同一份 FrameworkStatus，避免两处结论打架。
    let dependencies = build_dependency_report(&state.mods, &frameworks);
    let conflicts = crate::installer::collect_conflicts(&state.mods);
    let enabled = state.mods.iter().filter(|entry| entry.enabled).count();
    let deployed = state
        .mods
        .iter()
        .filter(|entry| !entry.deployed_files.is_empty())
        .count();

    let Some(game) = game else {
        issues.push(DiagnosticIssue {
            id: "game-missing".to_string(),
            severity: "error".to_string(),
            title: "还没有定位游戏目录".to_string(),
            detail: "启动器无法部署或检查任何东西。请到「设置」选择 Cyberpunk 2077 根目录。"
                .to_string(),
            action: Some("settings".to_string()),
        });
        return DiagnosticsReport {
            generated_at: now_iso(),
            game: None,
            frameworks,
            summary: "需要先定位游戏目录，诊断才有意义。".to_string(),
            summary_level: "error".to_string(),
            deployed_mods: deployed,
            enabled_mods: enabled,
            total_mods: state.mods.len(),
            conflict_count: conflicts.len(),
            issues,
            log_paths: Vec::new(),
            backup: state.backup.clone(),
            dependencies,
        };
    };

    let game_root = Path::new(&game.root);
    if let Err(err) = validate_game_dir(game_root) {
        issues.push(DiagnosticIssue {
            id: "game-invalid".to_string(),
            severity: "error".to_string(),
            title: "游戏目录无效".to_string(),
            detail: err.message,
            action: Some("settings".to_string()),
        });
    }

    if game.game_updated {
        issues.push(DiagnosticIssue {
            id: "game-updated".to_string(),
            severity: "warning".to_string(),
            title: "游戏版本变了".to_string(),
            detail: format!(
                "上次记录：{}，当前：{}。游戏更新后 RED4ext / CET / redscript 常常需要同步更新；先别急着排查模组冲突。",
                game.last_game_version.clone().unwrap_or_else(|| "未知".to_string()),
                game.version.clone().unwrap_or_else(|| "未知".to_string())
            ),
            action: Some("frameworks".to_string()),
        });
    }

    let needs_red4ext = state
        .mods
        .iter()
        .any(|entry| entry.enabled && matches!(entry.layout, InstallLayout::Redmod));
    if needs_red4ext && !framework_installed(&frameworks, "red4ext") {
        issues.push(DiagnosticIssue {
            id: "red4ext-missing".to_string(),
            severity: "error".to_string(),
            title: "REDmod 已启用，但 RED4ext 缺失".to_string(),
            detail: "你启用了 REDmod 内容，但 red4ext\\RED4ext.dll 不存在。REDmod 的脚本/扩展部分不会生效。"
                .to_string(),
            action: Some("frameworks".to_string()),
        });
    }
    let needs_redscript = state
        .mods
        .iter()
        .any(|entry| entry.enabled && entry.layout == InstallLayout::Redscript);
    if needs_redscript && !framework_installed(&frameworks, "redscript") {
        issues.push(DiagnosticIssue {
            id: "redscript-missing".to_string(),
            severity: "error".to_string(),
            title: "redscript 模组已启用，但编译器缺失".to_string(),
            detail: "没有找到 engine\\tools\\scc.exe（旧版为 redscript-cli.exe），r6\\scripts 下的 .reds 不会被编译。"
                .to_string(),
            action: Some("frameworks".to_string()),
        });
    }
    let needs_cet = state
        .mods
        .iter()
        .any(|entry| entry.enabled && entry.layout == InstallLayout::Cet);
    if needs_cet && !framework_installed(&frameworks, "cet") {
        issues.push(DiagnosticIssue {
            id: "cet-missing".to_string(),
            severity: "error".to_string(),
            title: "CET 模组已启用，但 Cyber Engine Tweaks 缺失".to_string(),
            detail: "没有找到 cyber_engine_tweaks.dll，CET 的 Lua 模组不会加载。"
                .to_string(),
            action: Some("frameworks".to_string()),
        });
    } else if needs_cet {
        issues.push(DiagnosticIssue {
            id: "cet-runtime".to_string(),
            severity: "info".to_string(),
            title: "CET 已就绪：进游戏后按 `~` 呼出控制台".to_string(),
            detail: "如果按 `~` 没反应，先确认游戏内没有其它模组占用这个键。CET 首次运行后会在 bin\\x64\\plugins\\cyber_engine_tweaks\\logs 下留下日志；看到模组列表才说明 Lua 已加载。"
                .to_string(),
            action: Some("diagnostics".to_string()),
        });
    }
    if needs_redscript && framework_installed(&frameworks, "redscript") {
        issues.push(DiagnosticIssue {
            id: "redscript-runtime".to_string(),
            severity: "info".to_string(),
            title: "redscript 已就绪：脚本会在游戏启动时编译".to_string(),
            detail: "如果 .reds 没有生效，先看 r6\\logs\\redscript.log 是否有编译错误；改脚本后需要完全退出游戏再启动，不能只读档。"
                .to_string(),
            action: Some("diagnostics".to_string()),
        });
    }

    if !conflicts.is_empty() {
        let pending = conflicts.iter().filter(|conflict| conflict.pending).count();
        issues.push(DiagnosticIssue {
            id: "file-conflicts".to_string(),
            severity: "error".to_string(),
            title: format!("发现 {} 个文件级冲突", conflicts.len()),
            detail: if pending > 0 {
                format!(
                    "其中 {pending} 个是「启用后会冲突」的暂存模组。启动器不会自动合并；先在冲突中心选择保留哪一个，再启用。"
                )
            } else {
                "两个已启用模组声明了同一个目标文件。启动器不会自动合并；请禁用其中一个，或确认覆盖顺序后手动处理。"
                    .to_string()
            },
            action: Some("loadorder".to_string()),
        });
    }

    // 依赖健康检查的汇总条目：逐条列出会淹没诊断页，这里只给一条带计数的警告，
    // 具体哪个模组缺什么由前端「依赖检查」面板展示。
    if dependencies.missing_enabled > 0 {
        let sample = dependencies
            .mods
            .iter()
            .filter(|item| item.enabled && item.status == "missing")
            .take(3)
            .map(|item| format!("{}（缺 {}）", item.mod_name, item.missing.join("、")))
            .collect::<Vec<String>>()
            .join("；");
        issues.push(DiagnosticIssue {
            id: "deps-missing".to_string(),
            severity: "warning".to_string(),
            title: format!("{} 个已启用模组缺少前置框架", dependencies.missing_enabled),
            detail: format!(
                "{sample}。缺少前置时这些模组通常「完全不生效」，且不会报错——先装框架再排查其它问题。"
            ),
            action: Some("dependencies".to_string()),
        });
    }
    if dependencies.mismatch_enabled > 0 {
        issues.push(DiagnosticIssue {
            id: "deps-version".to_string(),
            severity: "warning".to_string(),
            title: format!("{} 个模组要求的框架版本高于本机", dependencies.mismatch_enabled),
            detail: "框架版本过低时，模组会加载一部分后静默失败。建议先把框架更新到模组要求的版本。"
                .to_string(),
            action: Some("dependencies".to_string()),
        });
    }

    let managed: HashSet<String> = state
        .mods
        .iter()
        .flat_map(|entry| entry.deployed_files.iter())
        .map(|file| file.relative_path.to_ascii_lowercase())
        .collect();
    let archive_dir = game_root.join("archive").join("pc").join("mod");
    let mut unmanaged = 0usize;
    if let Ok(entries) = fs::read_dir(&archive_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("archive") {
                continue;
            }
            let rel = format!(
                "archive/pc/mod/{}",
                entry.file_name().to_string_lossy()
            );
            if !managed.contains(&rel.to_ascii_lowercase()) {
                unmanaged += 1;
            }
        }
    }
    if unmanaged > 0 {
        issues.push(DiagnosticIssue {
            id: "unmanaged-archives".to_string(),
            severity: "info".to_string(),
            title: format!("发现 {unmanaged} 个未受管 archive"),
            detail: "这些文件由外部工具（如 Vortex）部署，启动器无法安全卸载。可以就地收编：\
                     启动器只登记清单并建立暂存反向链接，验证通过前不会改动任何原始文件；\
                     收编后即可禁用、卸载、参与冲突检测。"
                .to_string(),
            action: Some("adopt".to_string()),
        });
    }

    let modlist = archive_dir.join("modlist.txt");
    if modlist.is_file() {
        let managed_modlist = fs::read_to_string(&modlist)
            .map(|raw| crate::loadorder::is_managed_modlist(&raw))
            .unwrap_or(false);
        if !managed_modlist {
            issues.push(DiagnosticIssue {
                id: "unmanaged-modlist".to_string(),
                severity: "warning".to_string(),
                title: "archive/pc/mod/modlist.txt 不是启动器写的".to_string(),
                detail: "这个文件会覆盖游戏的 ASCII 加载顺序。启动器不会自动改写它；需要接管时请先备份。"
                    .to_string(),
                action: Some("loadorder".to_string()),
            });
        }
    }

    if !has_write_access(game_root) {
        issues.push(DiagnosticIssue {
            id: "no-write".to_string(),
            severity: "error".to_string(),
            title: "游戏目录不可写".to_string(),
            detail: "启动器无法在游戏根目录创建文件。请检查文件夹权限，或避免把游戏装在受保护的系统目录。"
                .to_string(),
            action: None,
        });
    }

    if state.mods.is_empty() {
        issues.push(DiagnosticIssue {
            id: "no-mods".to_string(),
            severity: "info".to_string(),
            title: "还没有导入模组".to_string(),
            detail: "把 Nexus 下载的 ZIP 拖进窗口，或点右上角「导入 ZIP」。".to_string(),
            action: None,
        });
    } else if enabled == 0 {
        issues.push(DiagnosticIssue {
            id: "none-enabled".to_string(),
            severity: "info".to_string(),
            title: "所有模组都处于禁用状态".to_string(),
            detail: "禁用只撤掉游戏目录中的链接，暂存文件仍在，重新启用不会重新解压。"
                .to_string(),
            action: None,
        });
    }

    if state.backup.is_none() && deployed > 0 {
        issues.push(DiagnosticIssue {
            id: "no-backup".to_string(),
            severity: "warning".to_string(),
            title: "有部署，但没有配置备份".to_string(),
            detail: "建议运行一次「创建备份」，这样恢复原始状态时能还原 r6/config 和 modlist.txt。"
                .to_string(),
            action: Some("backup".to_string()),
        });
    }

    if let Some(language) = &game.language {
        if !language.to_ascii_lowercase().starts_with("zh") {
            issues.push(DiagnosticIssue {
                id: "language".to_string(),
                severity: "info".to_string(),
                title: format!("游戏当前语言：{language}"),
                detail: "如果你安装的是中文本地化模组，请把游戏语言设为简体中文，否则部分文本不会替换。"
                    .to_string(),
                action: None,
            });
        }
    }

    let has_error = issues.iter().any(|issue| issue.severity == "error");
    let has_warning = issues.iter().any(|issue| issue.severity == "warning");
    let (summary_level, summary) = if has_error {
        (
            "error",
            format!(
                "发现 {} 个需要处理的问题。先修红色的，再启动游戏。",
                issues.iter().filter(|i| i.severity == "error").count()
            ),
        )
    } else if has_warning {
        (
            "warning",
            format!(
                "可以启动，但有 {} 个警告值得看一眼。",
                issues.iter().filter(|i| i.severity == "warning").count()
            ),
        )
    } else if state.mods.is_empty() {
        ("info", "环境干净，但还没有导入任何模组。".to_string())
    } else {
        (
            "ok",
            format!(
                "{} 个模组已启用，未发现阻塞性问题。",
                enabled
            ),
        )
    };

    DiagnosticsReport {
        generated_at: now_iso(),
        game: Some(game.clone()),
        frameworks,
        issues,
        summary,
        summary_level: summary_level.to_string(),
        deployed_mods: deployed,
        enabled_mods: enabled,
        total_mods: state.mods.len(),
        conflict_count: conflicts.len(),
        log_paths: log_paths(game_root),
        backup: state.backup.clone(),
        dependencies,
    }
}

fn framework_installed(
    frameworks: &[crate::schema::FrameworkStatus],
    id: &str,
) -> bool {
    frameworks
        .iter()
        .find(|framework| framework.id == id)
        .map(|framework| framework.installed)
        .unwrap_or(false)
}

fn has_write_access(root: &Path) -> bool {
    let probe = root.join(".cyberdeck-launcher-write-test");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}
