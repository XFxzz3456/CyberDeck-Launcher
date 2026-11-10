//! 多套 AI 配置：本地 / 云端 / 中转站各存一份，随时切换。
//!
//! 设计要点（都是为了不踩旧坑）：
//! - **密钥不进 state 文件**：每套配置一个 DPAPI 文件，id 做文件名后缀；
//!   老用户迁移出来的那条 id = `default`，继续用旧的 `ai-api.key`，
//!   升级后 key 不会"消失"。
//! - **激活 = 把值写回 `settings.ai_base_url/model/protocol`**：诊断、翻译、
//!   AI 修复、AI 补丁那些老调用点一行都不用改，也就不可能因为这次改造引入
//!   回归。多配置只是这些字段的"管理器"。
//! - **测试连接不落盘**：拿表单里的地址/协议/key 直接打 `/models`，成功才让保存。

use std::time::Instant;

use crate::ai;
use crate::schema::{
    AiProfile, AiProfileList, AiProfileView, AiTestResult, AppResult, CommandError,
};
use crate::store::Store;

/// 老用户迁移出来的那套配置固定用这个 id（= 旧密钥文件 ai-api.key）。
const DEFAULT_PROFILE_ID: &str = "default";

fn normalize(mut profile: AiProfile) -> AiProfile {
    profile.base_url = profile.base_url.trim().trim_end_matches('/').to_string();
    profile.model = profile.model.trim().to_string();
    profile.protocol = match profile.protocol.trim().to_ascii_lowercase().as_str() {
        "anthropic" => "anthropic".to_string(),
        _ => "openai".to_string(),
    };
    profile.name = profile.name.trim().chars().take(40).collect();
    profile.vendor = profile.vendor.trim().chars().take(40).collect();
    if profile.name.is_empty() {
        // 没起名就用模型名兜底，列表里至少能分得清谁是谁。
        profile.name = if profile.model.is_empty() {
            "未命名配置".to_string()
        } else {
            profile.model.clone()
        };
    }
    profile
}

/// 读列表；顺手完成一次**幂等迁移**：老状态没有配置列表时，用当前端点补一条。
fn ensure(store: &Store) -> AiProfileList {
    let mut state = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut dirty = false;
    if state.settings.ai_profiles.is_empty() {
        // 先把值取出来再 push：同一个结构体里既借可变又借不可变会被借用检查器拦住。
        let base_url = state.settings.ai_base_url.clone();
        let model = state.settings.ai_model.clone();
        let protocol = state.settings.ai_protocol.clone();
        state.settings.ai_profiles.push(AiProfile {
            id: DEFAULT_PROFILE_ID.to_string(),
            name: "默认配置".to_string(),
            vendor: String::new(),
            base_url,
            model,
            protocol,
        });
        state.settings.active_ai_profile_id = DEFAULT_PROFILE_ID.to_string();
        dirty = true;
    } else if !state
        .settings
        .ai_profiles
        .iter()
        .any(|item| item.id == state.settings.active_ai_profile_id)
    {
        // 激活 id 指向了不存在的配置（手改文件 / 删到一半）：回落到第一条。
        state.settings.active_ai_profile_id = state.settings.ai_profiles[0].id.clone();
        dirty = true;
    }
    let settings = state.settings.clone();
    if dirty {
        let _ = store.save(&state);
    }
    drop(state);
    build_list(store, &settings)
}

fn build_list(store: &Store, settings: &crate::schema::Settings) -> AiProfileList {
    let active_id = settings.active_ai_profile_id.clone();
    let profiles = settings
        .ai_profiles
        .iter()
        .map(|item| AiProfileView {
            profile: item.clone(),
            has_key: ai::load_key_for(store, &item.id).ok().flatten().is_some(),
            active: item.id == active_id,
        })
        .collect();
    AiProfileList {
        profiles,
        active_id,
    }
}

/// 列表（首次调用会完成迁移并落盘）。
pub fn list(store: &Store) -> AiProfileList {
    ensure(store)
}

/// 新增或修改一套配置。`key` 为 None / 空串表示"不动已存的密钥"。
pub fn save(store: &Store, profile: AiProfile, key: Option<String>) -> AppResult<AiProfileList> {
    // 先确保迁移跑过：否则老用户第一次操作如果是"保存"，迁移出来的那条会被跳过。
    ensure(store);
    let mut profile = normalize(profile);
    if profile.base_url.is_empty() {
        return Err(CommandError::new(
            "AI_PROFILE_URL",
            "请填写接口地址（Base URL），例如 https://api.deepseek.com/v1。",
        ));
    }
    if profile.model.is_empty() {
        return Err(CommandError::new(
            "AI_PROFILE_MODEL",
            "请填写模型名，例如 deepseek-chat。",
        ));
    }
    let trimmed_key = key.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if let Some(value) = trimmed_key.as_deref() {
        if value.len() < 8 {
            return Err(CommandError::new(
                "AI_KEY_INVALID",
                "API Key 看起来不完整。请粘贴服务商控制台生成的完整 key。",
            ));
        }
    }

    let mut state = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if profile.id.trim().is_empty() {
        profile.id = format!("p-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    }
    let id = profile.id.clone();
    match state
        .settings
        .ai_profiles
        .iter_mut()
        .find(|item| item.id == id)
    {
        Some(existing) => *existing = profile.clone(),
        None => state.settings.ai_profiles.push(profile.clone()),
    }
    if state.settings.active_ai_profile_id.is_empty()
        || state.settings.active_ai_profile_id == id
    {
        state.settings.active_ai_profile_id = id.clone();
        // 激活态同步到老字段：诊断/翻译等调用点完全不用改。
        state.settings.ai_base_url = profile.base_url.clone();
        state.settings.ai_model = profile.model.clone();
        state.settings.ai_protocol = profile.protocol.clone();
    }
    store.save(&state)?;
    drop(state);

    if let Some(value) = trimmed_key.as_deref() {
        ai::save_key_for(store, &id, value)?;
    }
    Ok(list(store))
}

/// 删除一套配置：至少保留一套；删掉的若是当前激活的，自动切到第一条。
pub fn delete(store: &Store, id: &str) -> AppResult<AiProfileList> {
    ensure(store);
    let mut state = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.settings.ai_profiles.len() <= 1 {
        return Err(CommandError::new(
            "AI_PROFILE_LAST",
            "至少要保留一套 AI 配置。可以先新建一套，再删这一套。",
        ));
    }
    let before = state.settings.ai_profiles.len();
    state.settings.ai_profiles.retain(|item| item.id != id);
    if state.settings.ai_profiles.len() == before {
        return Err(CommandError::new("AI_PROFILE_MISSING", "找不到这套配置。"));
    }
    if state.settings.active_ai_profile_id == id {
        let next = state.settings.ai_profiles[0].clone();
        state.settings.active_ai_profile_id = next.id.clone();
        state.settings.ai_base_url = next.base_url;
        state.settings.ai_model = next.model;
        state.settings.ai_protocol = next.protocol;
    }
    store.save(&state)?;
    drop(state);
    // 密钥文件跟着配置一起清掉，不留孤儿密文。
    let _ = ai::clear_key_for(store, id);
    Ok(list(store))
}

/// 切换当前使用的配置。
pub fn activate(store: &Store, id: &str) -> AppResult<AiProfileList> {
    ensure(store);
    let mut state = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(profile) = state
        .settings
        .ai_profiles
        .iter()
        .find(|item| item.id == id)
        .cloned()
    else {
        return Err(CommandError::new("AI_PROFILE_MISSING", "找不到这套配置。"));
    };
    state.settings.active_ai_profile_id = profile.id.clone();
    state.settings.ai_base_url = profile.base_url;
    state.settings.ai_model = profile.model;
    state.settings.ai_protocol = profile.protocol;
    store.save(&state)?;
    drop(state);
    Ok(list(store))
}

/// 清掉某一套配置的密钥（配置本身保留，方便以后重新填）。
pub fn clear_key(store: &Store, id: &str) -> AppResult<AiProfileList> {
    ensure(store);
    let exists = store
        .snapshot_data()
        .settings
        .ai_profiles
        .iter()
        .any(|item| item.id == id);
    if !exists {
        return Err(CommandError::new("AI_PROFILE_MISSING", "找不到这套配置。"));
    }
    ai::clear_key_for(store, id)?;
    Ok(list(store))
}

/// 测试连接：直接用表单里的值打一次 `/models`，**不落盘、不改激活态**。
///
/// 失败不抛错而是返回 `ok=false` + 状态码/原因，这样前端能稳定显示
/// "401 密钥无效""连不上"这类具体信息，而不是一个笼统的红框。
pub fn test(store: &Store, profile: AiProfile, key_override: Option<String>) -> AiTestResult {
    let profile = normalize(profile);
    let typed = key_override
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let key = match typed {
        Some(value) => Some(value),
        // 没输入新 key 就试这套配置已存的（default 会落到旧的 ai-api.key）。
        None => ai::load_key_for(store, &profile.id).ok().flatten(),
    };
    let started = Instant::now();
    let outcome = ai::list_models_with_key(&profile.base_url, Some(&profile.protocol), key.as_deref());
    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(models) => AiTestResult {
            ok: true,
            status_code: Some(200),
            latency_ms,
            message: format!(
                "连接成功，服务返回 {} 个可用模型。",
                models.len()
            ),
            model_count: models.len(),
        },
        Err(err) => AiTestResult {
            ok: false,
            status_code: None,
            latency_ms,
            message: err.message,
            model_count: 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> (std::path::PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-aiprofile-{tag}-{}-{}",
            std::process::id(),
            crate::store::now_iso().replace(':', "-")
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.join("data")).unwrap();
        (root, store)
    }

    fn profile(name: &str, model: &str) -> AiProfile {
        AiProfile {
            id: String::new(),
            name: name.to_string(),
            vendor: "custom".to_string(),
            base_url: "https://api.example.com/v1/".to_string(),
            model: model.to_string(),
            protocol: "openai".to_string(),
        }
    }

    /// 老状态（没有配置列表）第一次读取时自动补一条，并沿用旧密钥文件。
    #[test]
    fn legacy_state_migrates_to_one_profile() {
        let (root, store) = temp_store("migrate");
        let first = list(&store);
        assert_eq!(first.profiles.len(), 1);
        assert_eq!(first.active_id, DEFAULT_PROFILE_ID);
        assert_eq!(first.profiles[0].profile.model, "gpt-5.4-nano");
        assert!(first.profiles[0].active);
        assert_eq!(
            ai::key_path_for(&store, DEFAULT_PROFILE_ID),
            ai::key_path(&store),
            "默认配置必须继续用旧的 ai-api.key，升级后 key 不能丢"
        );
        // 幂等：再读一次不会又加一条。
        assert_eq!(list(&store).profiles.len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    /// 新增一套 → 激活态跟着切到它，并同步老字段（诊断等调用点读的就是老字段）。
    #[test]
    fn saving_first_profile_activates_and_syncs_legacy_fields() {
        let (root, store) = temp_store("save");
        let saved = save(&store, profile("本地 Ollama", "qwen3:8b"), None).unwrap();
        assert_eq!(saved.profiles.len(), 2, "迁移出来的默认配置仍在");
        let created = saved
            .profiles
            .iter()
            .find(|item| item.profile.name == "本地 Ollama")
            .expect("新配置应存在");
        assert_eq!(created.profile.base_url, "https://api.example.com/v1", "尾部斜杠要归一化");
        assert!(!created.active, "已有激活配置时，新增不应该抢走激活态");
        let settings = store.snapshot_data().settings;
        assert_eq!(settings.ai_model, "gpt-5.4-nano", "老字段仍指向激活的那套");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn activating_a_profile_switches_legacy_fields() {
        let (root, store) = temp_store("activate");
        let saved = save(&store, profile("中转站", "deepseek-chat"), None).unwrap();
        let id = saved
            .profiles
            .iter()
            .find(|item| item.profile.name == "中转站")
            .unwrap()
            .profile
            .id
            .clone();
        activate(&store, &id).unwrap();
        let settings = store.snapshot_data().settings;
        assert_eq!(settings.ai_base_url, "https://api.example.com/v1");
        assert_eq!(settings.ai_model, "deepseek-chat");
        assert_eq!(settings.ai_protocol, "openai");
        assert_eq!(settings.active_ai_profile_id, id);
        let _ = std::fs::remove_dir_all(root);
    }

    /// 删到只剩一套时必须拒绝：没有配置等于启动器直接哑火。
    #[test]
    fn deleting_the_last_profile_is_rejected() {
        let (root, store) = temp_store("delete-last");
        let first = list(&store);
        let id = first.profiles[0].profile.id.clone();
        let error = delete(&store, &id).unwrap_err();
        assert_eq!(error.code, "AI_PROFILE_LAST");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 删掉当前激活的那套 → 自动回落到剩下的第一条，并把老字段同步过去。
    #[test]
    fn deleting_active_profile_falls_back_to_the_first_one() {
        let (root, store) = temp_store("delete-active");
        let saved = save(&store, profile("临时", "tmp-model"), None).unwrap();
        let id = saved
            .profiles
            .iter()
            .find(|item| item.profile.name == "临时")
            .unwrap()
            .profile
            .id
            .clone();
        activate(&store, &id).unwrap();
        let after = delete(&store, &id).unwrap();
        assert_eq!(after.profiles.len(), 1);
        assert_eq!(after.active_id, DEFAULT_PROFILE_ID);
        let settings = store.snapshot_data().settings;
        assert_eq!(settings.ai_model, "gpt-5.4-nano", "激活态要跟着回落");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 配置校验：空地址 / 空模型 / 太短的 key 都要在落盘前拦住。
    #[test]
    fn invalid_profiles_are_rejected() {
        let (root, store) = temp_store("validate");
        let mut empty_url = profile("x", "m");
        empty_url.base_url = "  ".to_string();
        assert_eq!(
            save(&store, empty_url, None).unwrap_err().code,
            "AI_PROFILE_URL"
        );
        let mut empty_model = profile("x", "");
        empty_model.model = " ".to_string();
        assert_eq!(
            save(&store, empty_model, None).unwrap_err().code,
            "AI_PROFILE_MODEL"
        );
        assert_eq!(
            save(&store, profile("x", "m"), Some("short".to_string()))
                .unwrap_err()
                .code,
            "AI_KEY_INVALID"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 每套配置的密钥文件互不覆盖，且 id 里的路径字符会被清掉。
    #[test]
    fn keys_are_scoped_per_profile_and_ids_are_sanitized() {
        let (root, store) = temp_store("keys");
        let a = ai::key_path_for(&store, "p-abc123");
        let b = ai::key_path_for(&store, "p-def456");
        assert_ne!(a, b);
        let evil = ai::key_path_for(&store, "../../evil");
        assert!(
            evil.starts_with(store.data_dir.join("secrets")),
            "id 必须挡在 secrets 目录内：{}",
            evil.display()
        );
        assert!(!evil.to_string_lossy().contains(".."));
        let _ = std::fs::remove_dir_all(root);
    }
}
