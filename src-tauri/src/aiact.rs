//! 执行 AI 诊断给出的修复动作。
//!
//! 🔴 信任模型：AI 只**点名**要做什么（kind + target + position），真正动文件的是
//! 这里。所以本模块做三件事，顺序不能变：
//!   1. 再校验一次（kind 白名单 / 模组还在 / 位置合法）—— 前端传来的东西一律不信；
//!   2. **先建环境快照**，失败就中止（没有可回滚点的自动修改不该发生）；
//!   3. 走既有实现（`installer::deploy_mod` / `undeploy_mod` / 加载顺序归一化），
//!      不另写一套文件操作。AI 从头到尾拿不到任何写权限。
//!
//! 「生成独立补丁」不在本模块落盘：它把用户送到既有的 AI 补丁流程（`aifix`），
//! 那段代码必须由人看过再点部署。

use std::collections::HashSet;
use std::path::PathBuf;

use crate::schema::{AiActionReport, AiFixAction, AppResult, CommandError};
use crate::snapshots::{self, SnapshotTrigger};
use crate::store::Store;
use crate::{game, installer, loadorder};

/// 执行一条动作。调用方（前端）必须已经做过二次确认。
pub fn apply(store: &Store, action: &AiFixAction) -> AppResult<AiActionReport> {
    // ① 白名单复核：即使前端被改过，也执行不了清单之外的动作。
    if !crate::ai::ACTION_KINDS.contains(&action.kind.as_str()) {
        return Err(CommandError::new(
            "AI_ACTION_UNSUPPORTED",
            format!("不支持的操作：{}", action.kind),
        ));
    }
    let data = store.snapshot_data();
    if !data.mods.iter().any(|item| item.id == action.target) {
        return Err(CommandError::new(
            "AI_ACTION_TARGET_MISSING",
            "这个模组已经不在库里了，请重新运行诊断。",
        ));
    }

    // ② 补丁提案不写盘：交给 AI 补丁对话框，由人看过代码再决定。
    if action.kind == "proposePatch" {
        return Ok(AiActionReport {
            kind: action.kind.clone(),
            target: action.target.clone(),
            message: "已转入 AI 补丁流程：确认意图后会生成 Redscript 补丁，部署前仍需你逐行确认。"
                .to_string(),
            snapshot_id: None,
            needs_intent: true,
        });
    }

    // ③ 要改磁盘的动作一律先留快照。写不出来就中止——没有回滚点的自动修改不做。
    let game_info = match data.game_dir.as_deref() {
        Some(root) => Some(game::validate_game_dir(std::path::Path::new(root))?),
        None => None,
    };
    let snapshot = snapshots::build_snapshot(
        &data,
        game_info.as_ref(),
        SnapshotTrigger::PreApplySnapshot,
        Some(format!("AI 动作前：{}", action.label)),
    );
    let snapshot_id = snapshots::write_snapshot(
        &store.data_dir,
        &snapshot,
        data.settings.snapshot_limit,
    )
    .map_err(|err| {
        CommandError::new(
            "AI_ACTION_SNAPSHOT",
            format!("无法在修改前创建环境快照，已中止：{err}"),
        )
    })?
    .id;

    let message = match action.kind.as_str() {
        "disableMod" => disable(store, action)?,
        "enableMod" => enable(store, &data, action, game_info.as_ref())?,
        "moveLoadOrder" => reorder(store, action, action.position.as_deref().unwrap_or("last"))?,
        other => {
            return Err(CommandError::new(
                "AI_ACTION_UNSUPPORTED",
                format!("不支持的操作：{other}"),
            ))
        }
    };

    // AI 操作同样会改动 REDmod 集合（启用 / 禁用），脏标记在这里统一落地。
    let mut redmod_notes: Vec<String> = Vec::new();
    crate::redmod::flush_into(store, data.game_dir.as_deref(), &mut redmod_notes);
    let message = if redmod_notes.is_empty() {
        message
    } else {
        format!("{message}（{}）", redmod_notes.join("；"))
    };

    Ok(AiActionReport {
        kind: action.kind.clone(),
        target: action.target.clone(),
        message,
        snapshot_id: Some(snapshot_id),
        needs_intent: false,
    })
}

fn disable(store: &Store, action: &AiFixAction) -> AppResult<String> {
    let data = store.snapshot_data();
    let root = data.game_dir.ok_or_else(|| {
        CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有绑定游戏目录，无法安全断开链接。",
        )
    })?;
    let warnings = installer::undeploy_mod(store, &action.target, std::path::Path::new(&root))?;
    if warnings.is_empty() {
        return Ok(format!("已停用 {}。", action.target_name));
    }
    Ok(format!(
        "已停用 {}（{} 条提示）：{}",
        action.target_name,
        warnings.len(),
        warnings.join("；")
    ))
}

fn enable(
    store: &Store,
    data: &crate::schema::AppStateData,
    action: &AiFixAction,
    game_info: Option<&crate::schema::GameInfo>,
) -> AppResult<String> {
    let info = game_info.ok_or_else(|| {
        CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有绑定游戏目录，无法部署这个模组。",
        )
    })?;
    // 与手动启用同一条闸门：游戏更新后旧前置多半失效，别把半坏的文件链进去。
    if game::update_lock_active(
        data.last_game_version.as_deref(),
        info.version.as_deref(),
    ) {
        return Err(CommandError::new(
            "GAME_UPDATE_LOCKED",
            "游戏已更新，请先升级前置框架再部署。可在顶部横幅点「我已更新前置，解除锁定」。",
        ));
    }
    let report = installer::deploy_mod(store, &action.target, info)?;
    if report.purged {
        return Ok(format!(
            "{} 的实体文件已不存在，已清理失效记录。",
            action.target_name
        ));
    }
    Ok(format!(
        "已启用 {}，部署 {} 个文件。",
        action.target_name, report.deployed
    ))
}

fn reorder(store: &Store, action: &AiFixAction, position: &str) -> AppResult<String> {
    let mut state = store
        .data
        .lock()
        .map_err(|_| CommandError::new("STATE_LOCK", "状态被占用，稍后再试。"))?;
    let archives: Vec<String> = state
        .mods
        .iter()
        .find(|item| item.id == action.target)
        .map(|entry| {
            entry
                .deployed_files
                .iter()
                .filter(|file| file.relative_path.to_ascii_lowercase().ends_with(".archive"))
                .map(|file| file.relative_path.clone())
                .collect()
        })
        .unwrap_or_default();
    if archives.is_empty() {
        return Err(CommandError::new(
            "AI_ACTION_NO_ARCHIVE",
            format!("{} 没有已部署的 archive，调整顺序不会有任何效果。", action.target_name),
        ));
    }
    let lower: HashSet<String> = archives.iter().map(|item| item.to_ascii_lowercase()).collect();
    let mut order: Vec<String> = state
        .load_order
        .iter()
        .filter(|path| !lower.contains(&path.to_ascii_lowercase()))
        .cloned()
        .collect();
    if position == "first" {
        for (index, path) in archives.iter().enumerate() {
            order.insert(index, path.clone());
        }
    } else {
        order.extend(archives.iter().cloned());
    }
    state.load_order = order;
    // 归一化：剔掉已卸载的路径，把新部署的补到末尾——与手工排序同一套规则。
    state.load_order = loadorder::normalized_order(&state);
    if state.settings.write_modlist {
        let root = state
            .game_dir
            .clone()
            .map(PathBuf::from)
            .ok_or_else(|| CommandError::new("GAME_NOT_CONFIGURED", "还没有绑定游戏目录。"))?;
        if let Err(err) = loadorder::write_modlist(&state, &root) {
            return Err(CommandError::new(
                "AI_ACTION_MODLIST",
                format!("加载顺序已改，但写 modlist.txt 失败：{err}"),
            ));
        }
    }
    store.save(&state)?;
    Ok(format!(
        "已把 {} 排到{}。",
        action.target_name,
        if position == "first" { "最前" } else { "最后" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{DeployedFile, InstallLayout, LinkType, ModEntry};
    use std::path::Path;

    fn temp_store(tag: &str) -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-aiact-{tag}-{}-{}",
            std::process::id(),
            crate::store::now_iso().replace(':', "-")
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.join("data")).unwrap();
        (root, store)
    }

    fn sample_mod(id: &str, name: &str, enabled: bool) -> ModEntry {
        ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: name.to_string(),
            version: None,
            author: None,
            category: "其他".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: None,
            staging_path: format!("staging/{id}"),
            cover_path: None,
            cover_cache_path: None,
            enabled,
            installed_at: crate::store::now_iso(),
            updated_at: None,
            size_bytes: 0,
            file_count: 0,
            layout: InstallLayout::Archive,
            mod_folder: None,
            metadata_source: "test".to_string(),
            planned_files: Vec::new(),
            warnings: Vec::new(),
            deployed_files: Vec::new(),
            has_archive: false,
            has_redmod: false,
            has_cet: false,
            translated_name: None,
            translated_at: None,
            translated_by: None,
            managed: true,
            origin: "cyberdeck".to_string(),
            modpack_id: None,
            nexus_cover_url: None,
            is_translation: false,
            parent_mod_id: None,
            ai_loc: None,
            ai_fix: Vec::new(),
        }
    }

    /// 造一个最小可用的游戏根目录：`validate_game_dir` 要求存在 exe。
    fn fake_game(root: &Path) -> String {
        let game = root.join("game");
        std::fs::create_dir_all(game.join("bin").join("x64")).unwrap();
        std::fs::write(game.join("bin").join("x64").join("Cyberpunk2077.exe"), b"MZ").unwrap();
        game.to_string_lossy().to_string()
    }

    fn action(kind: &str, target: &str, position: Option<&str>) -> AiFixAction {
        AiFixAction {
            id: "act".to_string(),
            kind: kind.to_string(),
            target: target.to_string(),
            target_name: "示例模组".to_string(),
            label: "操作".to_string(),
            reason: String::new(),
            position: position.map(str::to_string),
        }
    }

    /// 前端被篡改也执行不了清单外的动作 —— 这是「AI 不能直接改底层」的最后一道闸门。
    #[test]
    fn unknown_kind_is_rejected_before_touching_anything() {
        let (root, store) = temp_store("kind");
        let error = apply(&store, &action("deleteGameFiles", "whatever", None)).unwrap_err();
        assert_eq!(error.code, "AI_ACTION_UNSUPPORTED");
        assert!(!crate::snapshots::snapshots_dir(&store.data_dir).exists(), "拒绝的动作不该留下快照");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_target_is_rejected() {
        let (root, store) = temp_store("target");
        let error = apply(&store, &action("disableMod", "ghost", None)).unwrap_err();
        assert_eq!(error.code, "AI_ACTION_TARGET_MISSING");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 「生成独立补丁」不写盘、也不建快照：它只是把用户送到 AI 补丁流程，
    /// 补丁代码必须由人看过再部署。
    #[test]
    fn propose_patch_only_hands_off_to_the_patch_flow() {
        let (root, store) = temp_store("patch");
        {
            // 必须走锁改内存里的状态：`save` 只落盘，`snapshot_data()` 读的是内存副本。
            let mut state = store.data.lock().unwrap();
            state.mods = vec![sample_mod("m-a", "Alpha", true)];
            store.save(&state).unwrap();
        }
        let report = apply(&store, &action("proposePatch", "m-a", None)).unwrap();
        assert!(report.needs_intent);
        assert!(report.snapshot_id.is_none(), "没有改磁盘就不该建快照");
        assert!(!crate::snapshots::snapshots_dir(&store.data_dir).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// 调顺序前必须真的部署过 archive，否则按钮点了什么也不会发生（直接报错说清楚）。
    #[test]
    fn reorder_without_deployed_archive_is_rejected() {
        let (root, store) = temp_store("order");
        {
            let mut state = store.data.lock().unwrap();
            state.mods = vec![sample_mod("m-a", "Alpha", true)];
            state.game_dir = Some(fake_game(&root));
            store.save(&state).unwrap();
        }
        let error = apply(&store, &action("moveLoadOrder", "m-a", Some("first"))).unwrap_err();
        assert_eq!(error.code, "AI_ACTION_NO_ARCHIVE");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 有 archive 时调整顺序：先移除本模组的旧位置，再插到最前，并与手工排序同一套归一化。
    #[test]
    fn reorder_moves_archives_to_the_requested_edge() {
        let (root, store) = temp_store("order-ok");
        {
            let mut state = store.data.lock().unwrap();
            let mut entry = sample_mod("m-a", "Alpha", true);
            entry.deployed_files = vec![
                DeployedFile {
                    source: "x".to_string(),
                    target: "y".to_string(),
                    link_type: LinkType::Copy,
                    relative_path: "archive/pc/mod/alpha.archive".to_string(),
                    size: None,
                    modified_time: None,
                },
                DeployedFile {
                    source: "x".to_string(),
                    target: "y".to_string(),
                    link_type: LinkType::Copy,
                    relative_path: "r6/scripts/alpha.reds".to_string(),
                    size: None,
                    modified_time: None,
                },
            ];
            // 另一个模组占着 other.archive：归一化只保留"确实有模组拥有"的路径，
            // 所以测试数据必须造出两个 owner，否则会误以为排序没生效。
            let mut other = sample_mod("m-b", "Beta", true);
            other.deployed_files = vec![DeployedFile {
                source: "x".to_string(),
                target: "y".to_string(),
                link_type: LinkType::Copy,
                relative_path: "archive/pc/mod/other.archive".to_string(),
                size: None,
                modified_time: None,
            }];
            state.mods = vec![entry, other];
            state.load_order = vec![
                "archive/pc/mod/other.archive".to_string(),
                "archive/pc/mod/alpha.archive".to_string(),
            ];
            state.settings.write_modlist = false;
            state.game_dir = Some(fake_game(&root));
            store.save(&state).unwrap();
        }
        apply(&store, &action("moveLoadOrder", "m-a", Some("first"))).unwrap();
        let order = store.snapshot_data().load_order;
        assert_eq!(order.first().map(String::as_str), Some("archive/pc/mod/alpha.archive"));
        assert_eq!(order.last().map(String::as_str), Some("archive/pc/mod/other.archive"));
        // 非 archive 文件不会被塞进加载顺序。
        assert!(!order.iter().any(|path| path.ends_with(".reds")), "{order:?}");
        let _ = std::fs::remove_dir_all(root);
    }
}
