//! 全局配置导入 / 导出（看板【12】）。
//!
//! 设计取舍：
//! 1. **只导出白名单**，不导出密钥、不导出 mod 库、不导出 deployed_files。
//!    密钥在 DPAPI 里，任何"顺手带上"的实现都会变成泄露通道。
//! 2. **导入失败绝不写状态**：解析、版本校验、白名单过滤全部在内存完成后才落盘。
//! 3. 不覆盖 `staging_dir`：那是本机路径，换机器必然失效，导入后由启动器自己重建。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::schema::{AppResult, CommandError, ProfileEntry};
use crate::store::{now_iso, Store};

/// 配置包格式版本。只接受 <= 当前版本的包。
pub const PACK_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackSettings {
    #[serde(default)]
    pub ai_base_url: String,
    #[serde(default)]
    pub ai_model: String,
    #[serde(default)]
    pub ai_protocol: String,
    // 这些开关一律用 Option：`#[serde(default)]` + bool 会让「包里没写」和
    // 「显式写成 false」无法区分，于是一个只带 AI 配置的迷你包会把玩家的自动备份、
    // 卸载确认悄悄关掉（2026-11-06 审计 P1-10）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nexus_hide_adult: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nxm_auto_download: Option<bool>,
    #[serde(default)]
    pub wolvenkit_cli_path: String,
    #[serde(default)]
    pub wolvenkit_timeout_secs: u64,
    #[serde(default)]
    pub archive_tool_path: String,
    #[serde(default)]
    pub launch_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_pref: Option<String>,
    #[serde(default)]
    pub close_behavior: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_backup: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_uninstall: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_modlist: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_args: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPack {
    pub schema_version: u32,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub app_version: String,
    pub settings: PackSettings,
    #[serde(default)]
    pub game_dir: Option<String>,
    #[serde(default)]
    pub profiles: Vec<ProfileEntry>,
    #[serde(default)]
    pub active_profile_id: Option<String>,
    /// 记录但导入时不采用的字段，让用户知道"这份包还带了什么"。
    #[serde(default)]
    pub ignored_keys: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 实际写入的字段名（camelCase，前端直接展示）。
    pub applied: Vec<String>,
    /// 包里存在但被丢弃的字段（版本不认识 / 不在白名单）。
    pub ignored: Vec<String>,
    /// 导入后需要重新校验游戏目录（路径来自另一台机器时几乎总是 true）。
    pub needs_game_reverify: bool,
    pub profiles: usize,
    /// 包里带了「敏感项」但与当前值不同：默认**不写入**，等用户确认。
    pub sensitive: Vec<SensitiveChange>,
}

/// 一项「会改变数据流向或执行对象」的设置。
///
/// 只带 `key`（camelCase），不给文案——中文标签在前端词表里，后端出文案会绕开 i18n 门禁。
/// `from` / `to` 原样展示，用户才能看出「这份包想把我连到哪台服务器」。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveChange {
    pub key: String,
    pub from: String,
    pub to: String,
}

fn collect_pack(data: &crate::schema::AppStateData, app_version: &str) -> ConfigPack {
    let settings = &data.settings;
    ConfigPack {
        schema_version: PACK_VERSION,
        exported_at: now_iso(),
        app_version: app_version.to_string(),
        settings: PackSettings {
            ai_base_url: settings.ai_base_url.clone(),
            ai_model: settings.ai_model.clone(),
            ai_protocol: settings.ai_protocol.clone(),
            nexus_hide_adult: Some(settings.nexus_hide_adult),
            nxm_auto_download: Some(settings.nxm_auto_download),
            wolvenkit_cli_path: settings.wolvenkit_cli_path.clone(),
            wolvenkit_timeout_secs: settings.wolvenkit_timeout_secs,
            archive_tool_path: settings.archive_tool_path.clone(),
            launch_method: settings.launch_method.clone(),
            platform_pref: Some(settings.platform_pref.clone()),
            close_behavior: settings.close_behavior.clone(),
            auto_backup: Some(settings.auto_backup),
            confirm_uninstall: Some(settings.confirm_uninstall),
            write_modlist: Some(settings.write_modlist),
            launch_args: Some(settings.launch_args.clone()),
        },
        game_dir: data.game_dir.clone(),
        profiles: data.profiles.clone(),
        active_profile_id: data.active_profile_id.clone(),
        // 这里写的是"包里没有带什么"的说明文字，不是字段名——不要写成
        // `apiKey` 这类字样，否则导出文件会被密钥扫描器误判（单测也会挂）。
        ignored_keys: vec![
            "密钥（系统加密存储，不随配置迁移）".to_string(),
            "Mod 库与部署清单".to_string(),
            "暂存目录路径（本机路径，换机器失效）".to_string(),
        ],
    }
}

/// 导出到指定路径，返回写入字节数。
pub fn export_to(store: &Store, path: &Path, app_version: &str) -> AppResult<usize> {
    let data = store.snapshot_data();
    let pack = collect_pack(&data, app_version);
    let text = serde_json::to_string_pretty(&pack)
        .map_err(|e| CommandError::new("CONFIG_PACK_ENCODE", format!("配置序列化失败：{e}")))?;
    std::fs::write(path, &text)
        .map_err(|e| CommandError::new("CONFIG_PACK_WRITE", format!("无法写入配置文件：{e}")))?;
    Ok(text.len())
}

/// 导出到数据目录的 exports/ 下，返回路径（前端没有保存对话框权限，走固定目录）。
pub fn export_to_data_dir(store: &Store, app_version: &str) -> AppResult<String> {
    let dir = store.data_dir.join("exports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::new("CONFIG_PACK_WRITE", format!("无法创建导出目录：{e}")))?;
    let path = dir.join(format!("cyberdeck-config-{}.json", crate::store::now_stamp()));
    export_to(store, &path, app_version)?;
    Ok(path.to_string_lossy().to_string())
}

/// 从文件导入。任何校验失败都中止，状态保持原样。
pub fn import_from(store: &Store, path: &Path, apply_sensitive: bool) -> AppResult<ImportReport> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| CommandError::new("CONFIG_PACK_READ", format!("无法读取配置文件：{e}")))?;
    import_text(store, raw.as_str(), apply_sensitive)
}

/// `apply_sensitive = false` 时，`aiBaseUrl / wolvenkitCliPath / archiveToolPath / launchArgs`
/// 这四项**不写入**，只放进返回值的 `sensitive` 清单等用户确认。
///
/// 这四项是「信任边界」：改了 base URL 就等于把 API Key 发给另一个地址，改了工具路径
/// 就等于让对方指定一个 exe 在本机执行。配置文件是可以随便转发的文本，不能因为
/// 「用户点了导入」就默认拥有这些权力。
pub fn import_text(store: &Store, raw: &str, apply_sensitive: bool) -> AppResult<ImportReport> {
    let pack: ConfigPack = serde_json::from_str(raw).map_err(|e| {
        CommandError::new(
            "CONFIG_PACK_INVALID",
            format!("配置文件无法解析，未做任何修改：{e}"),
        )
    })?;
    if pack.schema_version > PACK_VERSION {
        return Err(CommandError::new(
            "CONFIG_PACK_VERSION",
            "配置文件来自更高版本的启动器，请先升级后再导入。",
        ));
    }

    let mut applied: Vec<String> = Vec::new();
    let mut ignored: Vec<String> = Vec::new();
    let mut sensitive: Vec<SensitiveChange> = Vec::new();
    let needs_game_reverify;

    {
        let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let s = pack.settings.clone();
        let target = &mut data.settings;

        // ── 敏感项（见 import_text 文档）：默认只登记、不写入 ──
        let ai_url = s.ai_base_url.trim();
        if !ai_url.is_empty() && ai_url != target.ai_base_url.trim() {
            if apply_sensitive {
                crate::ai::validate_base_url(ai_url).map_err(|reason| {
                    CommandError::new(
                        "CONFIG_PACK_BASE_URL",
                        format!("配置文件里的 AI 接口地址不可用：{reason}"),
                    )
                })?;
                target.ai_base_url = ai_url.to_string();
                applied.push("aiBaseUrl".into());
            } else {
                sensitive.push(SensitiveChange {
                    key: "aiBaseUrl".into(),
                    from: target.ai_base_url.clone(),
                    to: ai_url.to_string(),
                });
            }
        }
        if !s.ai_model.trim().is_empty() {
            target.ai_model = s.ai_model.trim().to_string();
            applied.push("aiModel".into());
        }
        let protocol = s.ai_protocol.trim();
        if protocol == "openai" || protocol == "anthropic" {
            target.ai_protocol = protocol.to_string();
            applied.push("aiProtocol".into());
        } else if !protocol.is_empty() {
            ignored.push(format!("aiProtocol={protocol}"));
        }
        // 只覆盖「包里显式存在」的开关。缺省 = 保持本机原值，绝不因为包没写就把
        // 自动备份 / 卸载确认关掉（2026-11-06 审计 P1-10）。
        let mut switches = 0;
        if let Some(value) = s.nexus_hide_adult {
            target.nexus_hide_adult = value;
            switches += 1;
        }
        if let Some(value) = s.nxm_auto_download {
            target.nxm_auto_download = value;
            switches += 1;
        }
        if let Some(value) = s.auto_backup {
            target.auto_backup = value;
            switches += 1;
        }
        if let Some(value) = s.confirm_uninstall {
            target.confirm_uninstall = value;
            switches += 1;
        }
        if let Some(value) = s.write_modlist {
            target.write_modlist = value;
            switches += 1;
        }
        if switches > 0 {
            applied.push(format!("nexus/backup 开关 ×{switches}"));
        }

        let wolvenkit = s.wolvenkit_cli_path.trim();
        if !wolvenkit.is_empty() && wolvenkit != target.wolvenkit_cli_path.trim() {
            if apply_sensitive {
                target.wolvenkit_cli_path = wolvenkit.to_string();
                applied.push("wolvenkitCliPath".into());
            } else {
                sensitive.push(SensitiveChange {
                    key: "wolvenkitCliPath".into(),
                    from: target.wolvenkit_cli_path.clone(),
                    to: wolvenkit.to_string(),
                });
            }
        }
        if s.wolvenkit_timeout_secs >= 10 && s.wolvenkit_timeout_secs <= 600 {
            target.wolvenkit_timeout_secs = s.wolvenkit_timeout_secs;
            applied.push("wolvenkitTimeoutSecs".into());
        }
        let archive_tool = s.archive_tool_path.trim();
        if !archive_tool.is_empty() && archive_tool != target.archive_tool_path.trim() {
            if apply_sensitive {
                target.archive_tool_path = archive_tool.to_string();
                applied.push("archiveToolPath".into());
            } else {
                sensitive.push(SensitiveChange {
                    key: "archiveToolPath".into(),
                    from: target.archive_tool_path.clone(),
                    to: archive_tool.to_string(),
                });
            }
        }
        if matches!(s.launch_method.as_str(), "auto" | "steam" | "gog" | "epic" | "direct") {
            target.launch_method = s.launch_method.clone();
            applied.push("launchMethod".into());
        }
        if matches!(s.close_behavior.as_str(), "tray" | "exit") {
            target.close_behavior = s.close_behavior.clone();
            applied.push("closeBehavior".into());
        }
        if let Some(value) = s.platform_pref.as_ref() {
            if !value.trim().is_empty() {
                target.platform_pref = value.clone();
                applied.push("platformPref".into());
            }
        }
        // launch_args 允许显式空串（= 清空启动参数），所以只判「包里有没有这个键」。
        if let Some(value) = s.launch_args.as_ref() {
            if *value != target.launch_args {
                if apply_sensitive {
                    target.launch_args = value.clone();
                    applied.push("launchArgs".into());
                } else {
                    sensitive.push(SensitiveChange {
                        key: "launchArgs".into(),
                        from: target.launch_args.clone(),
                        to: value.clone(),
                    });
                }
            }
        }

        // 游戏目录：路径来自另一台机器时几乎一定失效，只写值不保证可用。
        let mut reverify = false;
        if let Some(dir) = pack.game_dir.as_ref() {
            let trimmed = dir.trim();
            let usable = !trimmed.is_empty() && Path::new(trimmed).is_dir();
            if !trimmed.is_empty() {
                data.game_dir = Some(trimmed.to_string());
                applied.push("gameDir".into());
            }
            reverify = !usable;
        }

        if !pack.profiles.is_empty() {
            data.profiles = pack.profiles.clone();
            data.active_profile_id = pack
                .active_profile_id
                .clone()
                .filter(|id| pack.profiles.iter().any(|profile| &profile.id == id))
                .or_else(|| pack.profiles.first().map(|profile| profile.id.clone()));
            applied.push("profiles".into());
        }
        needs_game_reverify = reverify;
        store.save(&data)?;
    }

    Ok(ImportReport {
        applied,
        ignored,
        needs_game_reverify,
        profiles: pack.profiles.len(),
        sensitive,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_store(tag: &str) -> (std::path::PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-config-pack-{tag}-{}-{}",
            std::process::id(),
            now_iso().replace(':', "-")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.clone()).unwrap();
        (root, store)
    }

    #[test]
    fn export_never_contains_secrets() {
        let (root, store) = temp_store("secrets");
        {
            let mut data = store.snapshot_data();
            data.settings.ai_base_url = "https://api.example.com/v1".into();
            store.save(&data).unwrap();
        }
        let path = root.join("pack.json");
        export_to(&store, &path, "0.9.0").unwrap();
        let text = fs::read_to_string(&path).unwrap().to_lowercase();
        for needle in ["api_key", "apikey", "secret", "dpapi", "bearer"] {
            assert!(!text.contains(needle), "导出文件不应包含 {needle}");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn broken_json_is_rejected_and_state_untouched() {
        let (root, store) = temp_store("broken");
        store.save(&store.snapshot_data()).unwrap();
        let before = fs::read_to_string(root.join("launcher-state.json")).unwrap();
        let err = import_text(&store, "{ not a pack", false).unwrap_err();
        assert_eq!(err.code, "CONFIG_PACK_INVALID");
        let after = fs::read_to_string(root.join("launcher-state.json")).unwrap();
        assert_eq!(before, after, "导入失败不能改动状态文件");
        let _ = fs::remove_dir_all(root);
    }

    /// 2026-11-06 审计 P1-10：只带 AI 配置的迷你包，绝不能把本机的自动备份 /
    /// 卸载确认 / 写 modlist 这些开关顺手改成 false。
    #[test]
    fn minimal_pack_keeps_existing_switches() {
        let (root, store) = temp_store("minimal");
        {
            // 必须持锁原地改：`save` 只负责落盘，不会把快照写回内存。
            let mut state = store.data.lock().unwrap();
            state.settings.auto_backup = true;
            state.settings.confirm_uninstall = true;
            state.settings.write_modlist = true;
            state.settings.launch_args = "--skipStartScreen".into();
            store.save(&state).unwrap();
        }
        let pack = format!(
            "{{\"schemaVersion\":{},\"settings\":{{\"aiModel\":\"gpt-4o-mini\"}}}}",
            PACK_VERSION
        );
        import_text(&store, &pack, false).unwrap();
        let data = store.snapshot_data();
        assert!(data.settings.auto_backup, "自动备份被迷你包静默关掉了");
        assert!(data.settings.confirm_uninstall, "卸载确认被迷你包静默关掉了");
        assert!(data.settings.write_modlist, "modlist 开关被迷你包静默关掉了");
        assert_eq!(data.settings.launch_args, "--skipStartScreen", "启动参数被清空了");
        assert_eq!(data.settings.ai_model, "gpt-4o-mini", "显式字段应当生效");
        let _ = fs::remove_dir_all(root);
    }

    /// 2026-11-10 自检 P0-3：配置文件不得静默改写 AI 地址 / 外部工具路径。
    #[test]
    fn sensitive_fields_need_explicit_confirmation() {
        let (root, store) = temp_store("sensitive");
        {
            let mut state = store.data.lock().unwrap();
            state.settings.ai_base_url = "https://api.mine.example/v1".into();
            store.save(&state).unwrap();
        }
        let pack = format!(
            "{{\"schemaVersion\":{PACK_VERSION},\"settings\":{{\"aiBaseUrl\":\"http://evil.example/v1\",\"aiModel\":\"m\",\"archiveToolPath\":\"C:/Windows/System32/calc.exe\",\"launchArgs\":\"-evil\"}}}}"
        );
        let report = import_text(&store, &pack, false).unwrap();
        let keys: Vec<&str> = report.sensitive.iter().map(|item| item.key.as_str()).collect();
        assert!(keys.contains(&"aiBaseUrl"), "AI 地址必须进待确认清单: {keys:?}");
        assert!(keys.contains(&"archiveToolPath"), "工具路径必须进待确认清单: {keys:?}");
        assert!(keys.contains(&"launchArgs"), "启动参数必须进待确认清单: {keys:?}");
        let data = store.snapshot_data();
        assert_eq!(
            data.settings.ai_base_url, "https://api.mine.example/v1",
            "未经确认不能改 AI 地址（否则 Key 会发到对方服务器）"
        );
        assert!(data.settings.archive_tool_path.is_empty(), "未经确认不能改工具路径");
        assert_eq!(data.settings.ai_model, "m", "非敏感项应当照常生效");

        let report = import_text(&store, &pack, true).unwrap();
        assert!(report.sensitive.is_empty(), "确认后不应再有待确认项");
        assert_eq!(store.snapshot_data().settings.ai_base_url, "http://evil.example/v1");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn non_http_base_url_is_rejected() {
        let (root, store) = temp_store("scheme");
        let pack = format!(
            "{{\"schemaVersion\":{PACK_VERSION},\"settings\":{{\"aiBaseUrl\":\"file:///C:/keys.txt\"}}}}"
        );
        let err = import_text(&store, &pack, true).unwrap_err();
        assert_eq!(err.code, "CONFIG_PACK_BASE_URL");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn future_version_is_rejected() {
        let (root, store) = temp_store("future");
        let pack = ConfigPack {
            schema_version: PACK_VERSION + 1,
            exported_at: now_iso(),
            app_version: "9.9.9".into(),
            settings: PackSettings::default(),
            game_dir: None,
            profiles: Vec::new(),
            active_profile_id: None,
            ignored_keys: Vec::new(),
        };
        let err = import_text(&store, &serde_json::to_string(&pack).unwrap(), false).unwrap_err();
        assert_eq!(err.code, "CONFIG_PACK_VERSION");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_protocol_goes_to_ignored() {
        let (root, store) = temp_store("ignored");
        let mut pack: ConfigPack = serde_json::from_str(
            r#"{"schemaVersion":1,"settings":{"aiBaseUrl":"https://x/v1","aiProtocol":"grpc"}}"#,
        )
        .unwrap();
        pack.settings.ai_model = "m".into();
        let report = import_text(&store, &serde_json::to_string(&pack).unwrap(), true).unwrap();
        assert!(report.ignored.iter().any(|item| item.contains("aiProtocol")));
        let data = store.snapshot_data();
        assert_eq!(data.settings.ai_protocol, "openai", "非法协议不能写进状态");
        let _ = fs::remove_dir_all(root);
    }
}
