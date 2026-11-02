//! Optional AI-powered diagnosis and mod-name translation.
//!
//! 兼容任何标准 OpenAI `/chat/completions` 端点（OpenAI / DeepSeek / Moonshot /
//! 通义千问 / 本地 Ollama 等），接口地址与模型名在设置中可配。
//!
//! Privacy boundaries are deliberate:
//! - disabled unless the user stores an API key and explicitly consents per run;
//! - only a compact, redacted diagnostic snapshot is sent;
//! - log tails are opt-in and capped;
//! - the key is encrypted with Windows DPAPI and never included in the prompt,
//!   and never written into launcher-state.json —— 无论换成哪家服务商都如此。
//!
//! 翻译（[`translate_mod_names`]）只外发「Mod 名称」这一列文本，不含路径、
//! 用户名或 Key；框架/底层库在发请求之前就被黑名单拦截，不消耗 API 额度。

use crate::schema::{
    AiDiagnosis, AiFixAction, AiStatus, AppResult, AppStateData, CommandError, DiagnosticsReport,
    TranslateReport,
};
use crate::secret;
use crate::store::{now_iso, Store};
use regex::Regex;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

const MAX_CONTEXT_CHARS: usize = 180_000;
const MAX_LOG_FILES: usize = 4;
const LOG_TAIL_BYTES: u64 = 8 * 1024;
/// 送给模型的单文件日志上限（字符数）。
///
/// 8 KB 尾读是为了"找得到最近的错误"，但整段塞进提示词会吃掉几千 token，
/// 长日志还会把真正有用的那几行挤到注意力之外。只送最后 2000 字符，
/// 并在末尾明确标注被截断，模型才不会把截断处当成日志全貌。
const LOG_PROMPT_CHARS: usize = 2000;
/// 截断标记：模型看到它就知道"上面不是完整日志"。
const LOG_TRUNCATED_MARK: &str = "[日志已截断]";

/// AI API Key 的 DPAPI 存储路径（服务商无关命名）。
pub fn key_path(store: &Store) -> PathBuf {
    key_path_from(&store.data_dir)
}

/// 同上，但只给数据目录：`--self-check` 拿不到 Store 时也要能定位密钥文件。
pub fn key_path_from(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets").join("ai-api.key")
}

/// 某一套 AI 配置的密钥文件路径。
///
/// `default`（老用户迁移出来的那条）刻意沿用旧的 `ai-api.key`：
/// 迁移只改元数据、不动密钥文件，避免"升级后 key 消失"这类最伤人的事故。
/// 其它配置各自一份 `ai-profile-<id>.key`，互不影响。
pub fn key_path_for(store: &Store, profile_id: &str) -> PathBuf {
    let id = profile_id.trim();
    if id.is_empty() || id == "default" {
        return key_path(store);
    }
    store
        .data_dir
        .join("secrets")
        .join(format!("ai-profile-{}.key", sanitize_profile_id(id)))
}

/// 只允许字母数字与短横线：id 会进文件名，必须挡住路径穿越。
fn sanitize_profile_id(raw: &str) -> String {
    raw.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(40)
        .collect()
}

pub fn load_key_for(store: &Store, profile_id: &str) -> AppResult<Option<String>> {
    if profile_id.trim().is_empty() || profile_id.trim() == "default" {
        return load_key(store);
    }
    secret::load(&key_path_for(store, profile_id))
}

pub fn save_key_for(store: &Store, profile_id: &str, key: &str) -> AppResult<()> {
    secret::save(&key_path_for(store, profile_id), key)
}

pub fn clear_key_for(store: &Store, profile_id: &str) -> AppResult<()> {
    secret::clear(&key_path_for(store, profile_id))
}

/// 旧版本遗留的 DeepSeek 专用 key 文件名（0.7.0 及更早）。
fn legacy_key_path(store: &Store) -> PathBuf {
    store.data_dir.join("secrets").join("deepseek-api.key")
}

/// 读取 API Key，兼容旧版 `deepseek-api.key`。
///
/// 迁移策略：新文件存在则直接用；新文件没有值而旧文件有值时，把旧值写到
/// 新路径（同样经 DPAPI 加密）并返回。旧文件不删除——留着无害，删了反而
/// 让「迁移写失败」的场景没有退路。新文件读取报错（损坏/解密失败）时直接
/// 返回错误，不静默回退旧值，避免掩盖真实的存储问题。
pub fn load_key(store: &Store) -> AppResult<Option<String>> {
    match secret::load(&key_path(store))? {
        Some(value) => Ok(Some(value)),
        None => {
            if let Some(legacy) = secret::load(&legacy_key_path(store))
                .ok()
                .flatten()
            {
                // 迁移写失败不阻塞使用：旧值仍然直接返回。
                let _ = secret::save(&key_path(store), &legacy);
                Ok(Some(legacy))
            } else {
                Ok(None)
            }
        }
    }
}

pub fn status(store: &Store) -> AiStatus {
    // load_key 兼容旧 deepseek-api.key；读取失败按未配置处理（前端会引导重新填写）。
    let configured = load_key(store).ok().flatten().is_some();
    let settings = store.snapshot_data().settings;
    AiStatus {
        configured,
        base_url: settings.ai_base_url,
        model: settings.ai_model,
        protocol: resolve_protocol(&settings.ai_protocol).as_str().to_string(),
    }
}

pub fn set_key(store: &Store, key: &str) -> AppResult<AiStatus> {
    let trimmed = key.trim();
    if trimmed.len() < 8 {
        return Err(CommandError::new(
            "AI_KEY_INVALID",
            "API Key 看起来不完整。请粘贴服务商控制台生成的完整 key。",
        ));
    }
    secret::save(&key_path(store), trimmed)?;
    Ok(status(store))
}

pub fn clear_key(store: &Store) -> AppResult<AiStatus> {
    secret::clear(&key_path(store))?;
    Ok(status(store))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherInfo {
    name: &'static str,
    version: &'static str,
    platform: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameContext {
    version: Option<String>,
    source: Option<String>,
    language: Option<String>,
    game_updated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameworkContext {
    name: String,
    installed: bool,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssueContext {
    severity: String,
    title: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModContext {
    /// 计算出来的稳定 id：AI 的 actions 只能引用这里出现过的值，
    /// 后端会用同一份快照做白名单校验，编造的 id 一律丢弃。
    id: String,
    name: String,
    version: Option<String>,
    layout: String,
    enabled: bool,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictContext {
    target: String,
    mod_name: String,
    other_mod_name: Option<String>,
    kind: String,
    pending: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogContext {
    name: String,
    tail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticContext {
    launcher: LauncherInfo,
    game: GameContext,
    summary: String,
    summary_level: String,
    frameworks: Vec<FrameworkContext>,
    issues: Vec<IssueContext>,
    mods: Vec<ModContext>,
    conflicts: Vec<ConflictContext>,
    load_order: Vec<String>,
    logs: Vec<LogContext>,
    log_note: String,
}

fn extract_error_context(text: &str, radius: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        let hit = lower.contains("error")
            || lower.contains("failed")
            || lower.contains("failure")
            || lower.contains("exception")
            || lower.contains("fatal")
            || lower.contains("panic")
            || lower.contains("crash");
        if !hit {
            continue;
        }
        let start = index.saturating_sub(radius);
        let end = (index + radius).min(lines.len().saturating_sub(1));
        if let Some(previous) = ranges.last_mut() {
            if start <= previous.1 + 1 {
                previous.1 = previous.1.max(end);
                continue;
            }
        }
        ranges.push((start, end));
    }
    if ranges.is_empty() {
        return String::new();
    }
    ranges
        .into_iter()
        .map(|(start, end)| {
            let mut block = format!("--- L{}–L{} ---", start + 1, end + 1);
            for (offset, line) in lines[start..=end].iter().enumerate() {
                block.push_str(&format!("\n{:>4} | {}", start + offset + 1, line));
            }
            block
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn collect_logs(game_root: Option<&Path>, focus: Option<&str>) -> Vec<LogContext> {
    let Some(root) = game_root else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    let dirs = [
        root.join("r6").join("logs"),
        root.join("red4ext").join("logs"),
        root.join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks"),
    ];
    for dir in &dirs {
        if !dir.is_dir() {
            continue;
        }
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = WalkDir::new(dir)
            .max_depth(2)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter_map(|entry| {
                let path = entry.path().to_path_buf();
                let ext = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.to_ascii_lowercase())
                    .unwrap_or_default();
                if ext != "log" && ext != "txt" {
                    return None;
                }
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                Some((modified, path))
            })
            .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        candidates.extend(files.into_iter().take(2).map(|(_, path)| path));
    }

    candidates
        .into_iter()
        .take(MAX_LOG_FILES)
        .filter_map(|path| {
            let mut file = std::fs::File::open(&path).ok()?;
            let len = file.metadata().ok()?.len();
            let start = len.saturating_sub(LOG_TAIL_BYTES);
            file.seek(SeekFrom::Start(start)).ok()?;
            let mut buf = Vec::new();
            file.take(LOG_TAIL_BYTES).read_to_end(&mut buf).ok()?;
            let text = String::from_utf8_lossy(&buf).to_string();
            let text = if focus == Some("logs") {
                let extracted = extract_error_context(&text, 5);
                if extracted.is_empty() {
                    return None;
                }
                extracted
            } else {
                text
            };
            // 只送最后 LOG_PROMPT_CHARS 个字符。按 char 截（不是按字节），
            // 否则中日文/emoji 会被切断成半个字符。
            let text = tail_chars(&text, LOG_PROMPT_CHARS);
            let name = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            Some(LogContext { name, tail: text })
        })
        .collect()
}

/// 取字符串最后 `limit` 个字符；超出时在开头标 `[日志已截断]`。
///
/// 标记放开头而不是结尾：日志的结构是"越往下越新"，用户/模型都是先看尾部，
/// 把标记塞在最后一行会被当成日志内容本身。
fn tail_chars(text: &str, limit: usize) -> String {
    let total = text.chars().count();
    if total <= limit {
        return text.to_string();
    }
    let skipped = total - limit;
    let tail: String = text.chars().skip(skipped).collect();
    format!("{LOG_TRUNCATED_MARK}（省略前 {skipped} 个字符）\n{tail}")
}

fn redact(text: &str, game_root: Option<&Path>, data_dir: &Path) -> (String, usize) {
    let mut redactions = 0usize;
    let mut result = text.to_string();
    let mut exact: Vec<PathBuf> = vec![data_dir.to_path_buf()];
    if let Some(root) = game_root {
        exact.push(root.to_path_buf());
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        exact.push(PathBuf::from(profile));
    }
    for path in exact {
        let text = path.to_string_lossy().to_string();
        if text.len() < 3 {
            continue;
        }
        let count = result.matches(&text).count();
        if count > 0 {
            redactions += count;
            result = result.replace(&text, "<PATH>");
        }
    }

    // Any remaining absolute Windows path or UNC path is replaced as a whole.
    // Keeping only generic file names would make log evidence less useful, so
    // this is intentionally conservative: replace paths, keep messages.
    let path_re =
        Regex::new(r#"(?i)(?:[A-Z]:\\[^\s"']+|\\\\[A-Za-z0-9.$_-]+\\[^\s"']+)"#).unwrap();
    redactions += path_re.find_iter(&result).count();
    result = path_re.replace_all(&result, "<PATH>").to_string();

    let email_re = Regex::new(r#"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#).unwrap();
    redactions += email_re.find_iter(&result).count();
    result = email_re.replace_all(&result, "<EMAIL>").to_string();
    (result, redactions)
}

fn build_context(
    report: &DiagnosticsReport,
    data: &AppStateData,
    game_root: Option<&Path>,
    include_logs: bool,
    focus: Option<&str>,
) -> (String, usize) {
    let game = GameContext {
        version: report.game.as_ref().and_then(|game| game.version.clone()),
        source: report.game.as_ref().map(|game| game.source.clone()),
        language: report.game.as_ref().and_then(|game| game.language.clone()),
        game_updated: report.game.as_ref().map(|game| game.game_updated).unwrap_or(false),
    };
    let frameworks = report
        .frameworks
        .iter()
        .map(|item| FrameworkContext {
            name: item.name.clone(),
            installed: item.installed,
            version: item.version.clone(),
        })
        .collect();
    let issues = report
        .issues
        .iter()
        .map(|item| IssueContext {
            severity: item.severity.clone(),
            title: item.title.clone(),
            detail: item.detail.clone(),
        })
        .collect();
    let mods = data
        .mods
        .iter()
        .map(|item| ModContext {
            id: item.id.clone(),
            name: item.name.clone(),
            version: item.version.clone(),
            layout: format!("{:?}", item.layout),
            enabled: item.enabled,
            warnings: item.warnings.clone(),
        })
        .collect();
    // Conflicts are derived from the current state, not the cached report.
    let conflicts = crate::installer::collect_conflicts(&data.mods)
        .into_iter()
        .map(|conflict| ConflictContext {
            target: conflict.target,
            mod_name: conflict.mod_name,
            other_mod_name: conflict.other_mod_name,
            kind: conflict.kind,
            pending: conflict.pending,
        })
        .collect();
    let logs = if include_logs {
        collect_logs(game_root, focus)
    } else {
        Vec::new()
    };
    let context = DiagnosticContext {
        launcher: LauncherInfo {
            name: "CyberDeck Launcher",
            version: env!("CARGO_PKG_VERSION"),
            platform: "Windows",
        },
        game,
        summary: report.summary.clone(),
        summary_level: report.summary_level.clone(),
        frameworks,
        issues,
        mods,
        conflicts,
        load_order: data.load_order.clone(),
        logs,
        log_note: if include_logs && focus == Some("logs") {
            "日志只保留每个错误前后 5 行（超出 2000 字符的部分标 [日志已截断]）；路径与邮箱已脱敏。".to_string()
        } else if include_logs {
            "日志只保留每个文件最后 2000 个字符（超出部分标 [日志已截断]），路径与邮箱已脱敏。".to_string()
        } else {
            "本次未发送日志。".to_string()
        },
    };
    let raw = serde_json::to_string_pretty(&context).unwrap_or_else(|_| "{}".to_string());
    let raw = raw.chars().take(MAX_CONTEXT_CHARS).collect::<String>();
    redact(&raw, game_root, Path::new(&data.staging_dir))
}

// Clone：空响应重试要把原 messages 原样再发一遍。
#[derive(Debug, Clone, Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
    response_format: ResponseFormat,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessageContent,
}

#[derive(Debug, Deserialize)]
struct ChatMessageContent {
    #[serde(default)]
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiPayload {
    #[serde(default)]
    summary: String,
    #[serde(default, alias = "likely_cause")]
    likely_cause: String,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default, alias = "fix_steps")]
    fix_steps: Vec<String>,
    #[serde(default)]
    confidence: String,
    #[serde(default, alias = "needs_more_info")]
    needs_more_info: Vec<String>,
    /// AI 给的动作；必须过 [`sanitize_actions`] 才能进 AiDiagnosis。
    #[serde(default)]
    actions: Vec<AiActionPayload>,
}

/// AI 原始动作（不可信输入）。字段全按字符串收，避免模型偶尔给 null / 数字时整包解析失败。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiActionPayload {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    position: Option<String>,
}

fn normalize_base_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

// ============================================================================
// 接口协议：OpenAI 兼容（默认） vs Anthropic 原生
// ============================================================================

/// Anthropic Messages API 要求的版本头。固定为当前广泛兼容的稳定版本。
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// AI 接口协议。从设置的字符串解析；未知值按 openai 兜底——
/// set_settings 已在保存时拦住非法值，这里再兜一层是防旧数据/手改文件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApiProtocol {
    OpenAi,
    Anthropic,
}

impl ApiProtocol {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ApiProtocol::OpenAi => "openai",
            ApiProtocol::Anthropic => "anthropic",
        }
    }
}

pub(crate) fn resolve_protocol(value: &str) -> ApiProtocol {
    match value.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "claude" => ApiProtocol::Anthropic,
        _ => ApiProtocol::OpenAi,
    }
}

/// Anthropic 的 `/messages` 端点拼接。
///
/// 容错与 OpenAI 版一致：允许粘贴裸域名（自动补 `/v1`）、`/v1` 根地址
/// （自动补 `/messages`）或完整 `/messages` 端点（原样使用）。
fn anthropic_messages_endpoint(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    // 完整端点原样使用：用户可能粘贴第三方原生代理的非标准路径，
    // 已经指到 /messages 的地址再补 /v1 只会 404。
    if trimmed.ends_with("/messages") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/messages")
    } else {
        format!("{trimmed}/v1/messages")
    }
}

/// Anthropic 的 `/v1/models` 端点拼接（容错同上）。
fn anthropic_models_endpoint(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/models") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }
}

/// Anthropic 原生协议下，把内部消息序列整理成它强制要求的形状。
///
/// Anthropic 的 Messages API 有两条硬性规则，违反即 400：
/// 1. `messages` 里**不能有 system 角色**——系统提示词放顶层 `system` 字段；
/// 2. 第一条必须是 `user`，且 `user`/`assistant` 严格交替。
///
/// 我们的内部请求恒为 [system, user] 两跳，天然合规；但整理函数按通用规则
/// 写并配测试，将来若引入多轮上下文不会悄悄踩雷：连续同角色合并、
/// 开头的 assistant 丢弃、整理后为空时兜一条占位 user。
fn sanitize_anthropic_messages(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut merged: Vec<ChatMessage> = Vec::new();
    for message in messages {
        if message.role == "system" {
            continue;
        }
        // role 只可能是 "user" / "assistant"（内部常量），同角色相邻即合并，
        // 用两个换行分隔，保持两段内容都不丢。
        if merged.last().map(|last| last.role) == Some(message.role) {
            let last = merged.last_mut().expect("last() 已判定存在");
            last.content.push_str("\n\n");
            last.content.push_str(&message.content);
        } else {
            merged.push(ChatMessage {
                role: if message.role == "assistant" {
                    "assistant"
                } else {
                    "user"
                },
                content: message.content.clone(),
            });
        }
    }
    while merged.first().map(|first| first.role) == Some("assistant") {
        merged.remove(0);
    }
    if merged.is_empty() {
        merged.push(ChatMessage {
            role: "user",
            content: "(无输入)".to_string(),
        });
    }
    merged
}

/// 从 Anthropic 的 system prompt 里提取顶层 `system` 字段（可有多段，取首个非空）。
fn anthropic_system_prompt(messages: &[ChatMessage]) -> Option<String> {
    messages
        .iter()
        .find(|message| message.role == "system" && !message.content.trim().is_empty())
        .map(|message| message.content.clone())
}

/// 由用户填的 Base URL 推导 `/models` 端点。
///
/// 容错与 `normalize_base_url` 一致：允许粘贴带 `/v1` 的根地址，也允许直接
/// 粘贴完整 `/chat/completions` 端点。
fn models_endpoint(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/chat/completions").unwrap_or(trimmed);
    if trimmed.ends_with("/models") {
        return trimmed.to_string();
    }
    // 裸域名（`scheme://host` 之后没有路径）要补 `/v1`：DeepSeek 的模型清单在
    // `/v1/models`，直接拼 `/models` 会 404；Ollama / LM Studio 的 OpenAI 兼容
    // 端点同样在 `/v1` 下。已有路径段（`/v1`、`/v1beta/openai` 或第三方自定义
    // 路径）时原样拼 `/models`，避免把 `/api` 这类前缀又套一层 `/v1`。
    let after_scheme = trimmed.split("://").nth(1).unwrap_or(trimmed);
    let has_path = after_scheme.contains('/');
    if has_path {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }
}

/// 拉取服务商的模型 ID 列表。
///
/// OpenAI 兼容协议：标准 `GET /v1/models`，Bearer 鉴权。
/// Anthropic 原生协议：`GET /v1/models`，`x-api-key` + `anthropic-version` 头，
/// 响应同为 `{"data":[{"id":...}]}` 形状，`parse_models_json` 两种都能吃。
/// 「模型名会过时」的一劳永逸解法：只要服务商在线，列表就是实时的。
/// Key 来自本机 DPAPI 存储，可选——Ollama 等本地服务不需要鉴权，没有
/// Key 时发匿名请求，由服务商决定是否拒绝。
pub fn list_models(store: &Store, base_url: &str, protocol: Option<&str>) -> AppResult<Vec<String>> {
    let key = load_key(store)?;
    list_models_with_key(base_url, protocol, key.as_deref())
}

/// 同上，但密钥由调用方给：`测试连接` 需要在保存之前就验证这一套配置。
pub fn list_models_with_key(
    base_url: &str,
    protocol: Option<&str>,
    key: Option<&str>,
) -> AppResult<Vec<String>> {
    if base_url.trim().is_empty() {
        return Err(CommandError::new(
            "AI_NOT_CONFIGURED",
            "请先填写接口地址（Base URL），再获取模型列表。",
        ));
    }
    let protocol = protocol.map(resolve_protocol).unwrap_or(ApiProtocol::OpenAi);
    let url = match protocol {
        ApiProtocol::OpenAi => models_endpoint(base_url),
        ApiProtocol::Anthropic => anthropic_models_endpoint(base_url),
    };
    let client = build_client_with_timeout("Models", 15, 10)?;
    let mut request = client.get(&url);
    if let Some(key) = key {
        request = match protocol {
            ApiProtocol::OpenAi => request.bearer_auth(key),
            ApiProtocol::Anthropic => request
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION),
        };
    }
    let response = request
        .send()
        .map_err(|e| CommandError::new("AI_NETWORK", format!("连接 AI 服务失败：{e}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(CommandError::new(
            "AI_HTTP",
            http_error_message(status.as_u16(), &body, ErrorContext::Models),
        ));
    }
    let body = response
        .text()
        .map_err(|e| CommandError::new("AI_PARSE", format!("AI 服务返回了无法读取的响应：{e}")))?;
    Ok(parse_models_json(&body))
}

/// 解析 `/models` 响应：标准格式是 `{"data":[{"id":"..."}]}`；
/// 个别兼容实现把数组直接放在顶层或叫 `models`，都兜住。排序去重，
/// 上限 500 条防呆。
fn parse_models_json(body: &str) -> Vec<String> {
    #[derive(serde::Deserialize)]
    struct ModelEntry {
        #[serde(alias = "name", alias = "model")]
        id: String,
    }
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Shape {
        // 顺序敏感：OpenAi 的 data 不能带 default，否则 {"models":[…]} 会被它
        // 先吃掉并得到空列表。OpenAi → Wrapped → Bare 的次序保证各归各。
        OpenAi { data: Vec<ModelEntry> },
        Wrapped { models: Vec<ModelEntry> },
        Bare(Vec<ModelEntry>),
    }
    let ids: Vec<String> = match serde_json::from_str::<Shape>(body) {
        Ok(Shape::OpenAi { data }) => data,
        Ok(Shape::Wrapped { models }) => models,
        Ok(Shape::Bare(list)) => list,
        Err(_) => Vec::new(),
    }
    .into_iter()
    .map(|entry| entry.id)
    .filter(|id| !id.trim().is_empty())
    .collect::<std::collections::BTreeSet<_>>()
    .into_iter()
    .take(500)
    .collect();
    ids
}

/// 建一个阻塞式 HTTP 客户端。
///
/// 诊断和翻译共用同一套超时策略：大模型服务普遍在 60s 左右断开长请求，75s 只是兜底，
/// 太短会把「模型在长排队」误判成网络故障。
fn build_client(purpose: &str) -> AppResult<Client> {
    build_client_with_timeout(purpose, 75, 15)
}

/// 与 `build_client` 同构，但总超时可按用途单独指定。
///
/// 拉取模型列表固定走 15s：它只是 GET 一份静态清单，不该像对话那样等 75s。
/// 用户点了「获取模型」迟迟不回来，会以为按钮坏了（Ollama / LM Studio 没起时
/// 尤其明显）。连接超时再压到 10s，让「服务没开」在 10s 内就给出结论。
fn build_client_with_timeout(
    purpose: &str,
    request_secs: u64,
    connect_secs: u64,
) -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(request_secs))
        .connect_timeout(Duration::from_secs(connect_secs))
        .user_agent(format!(
            "CyberDeckLauncher/{} {purpose}",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|e| CommandError::new("AI_HTTP", format!("无法创建网络客户端：{e}")))
}

/// 从错误响应体里抠一句人话（OpenAI `{"error":{"message":...}}` 与
/// Anthropic `{"error":{"type":...,"message":...}}` 同构），抠不到就原样给片段。
fn error_body_message(body: &str) -> String {
    #[derive(serde::Deserialize)]
    struct ErrorBody {
        #[serde(default)]
        error: Option<ErrorInner>,
    }
    #[derive(serde::Deserialize)]
    struct ErrorInner {
        #[serde(default)]
        message: Option<serde_json::Value>,
    }
    if let Ok(parsed) = serde_json::from_str::<ErrorBody>(body) {
        if let Some(message) = parsed.error.and_then(|inner| inner.message) {
            match message {
                serde_json::Value::String(text) if !text.trim().is_empty() => return text,
                other => {
                    let text = other.to_string();
                    if !text.trim().is_empty() && text != "null" {
                        return text;
                    }
                }
            }
        }
    }
    body.chars().take(500).collect()
}

/// 把非 2xx 响应翻译成用户能照做的中文提示。
///
/// 单独抽出来是为了让诊断和翻译的报错一字不差：同一个 401 在两处显示不同文案，
/// 用户会以为是两个不同的问题。401/429 这类高频错误直接给结论（Anthropic
/// 与 OpenAI 语义相同），其余状态附上服务商错误正文里的一句话。
/// 错误文案的上下文：同一个 HTTP 状态在「对话」与「拉模型列表」下含义不同。
/// 400 在对话里几乎总是模型名不对（模型已下线 / 拼错），要直接把人引到
/// 「获取模型」；在拉列表时则更像地址写错，笼统给正文即可。
#[derive(Clone, Copy)]
enum ErrorContext {
    Chat,
    Models,
}

fn http_error_message(status: u16, body: &str, context: ErrorContext) -> String {
    match status {
        401 => "AI 服务的 API Key 无效或已过期。".to_string(),
        402 => "AI 服务账户余额不足。".to_string(),
        403 => "AI 服务拒绝了本次请求：Key 没有对应模型的权限，或区域/风控受限。".to_string(),
        429 => "AI 服务请求过于频繁或额度受限，请稍后再试。".to_string(),
        400 => match context {
            ErrorContext::Chat => format!(
                "模型名称可能不匹配，建议点击 [获取模型] 刷新列表。\n{}",
                error_body_message(body)
            ),
            ErrorContext::Models => format!(
                "AI 服务拒绝了请求（HTTP 400）：请检查接口地址（Base URL）是否正确。\n{}",
                error_body_message(body)
            ),
        },
        529 => "AI 服务过载，请稍后再试。".to_string(),
        _ => format!("AI 服务返回 HTTP {status}。\n{}", error_body_message(body)),
    }
}

/// 发一次对话请求并取出首条回复的正文。
///
/// 诊断与翻译的唯一公共出口：错误码（AI_NETWORK / AI_HTTP / AI_PARSE / AI_EMPTY）
/// 集中在这里，避免两处实现慢慢漂移。协议分发也在这里：
/// - OpenAI 兼容：`POST <base>/chat/completions`，`Authorization: Bearer`，
///   带上 `response_format: json_object`，回复在 `choices[0].message.content`。
/// - Anthropic 原生：`POST <base>/v1/messages`，`x-api-key` + `anthropic-version`，
///   **不支持 `response_format`**（JSON 纯靠提示词约束 + 上层剥围栏），
///   `max_tokens` 是必填字段；system 提到顶层，回复在 `content[0].text`。
/// Key 只进鉴权头，任何错误文案都不拼接它。
fn chat_completion(
    client: &Client,
    url: &str,
    key: &str,
    protocol: ApiProtocol,
    request: &ChatRequest,
) -> AppResult<String> {
    // 第一次请求：按调用方的参数（温度/输出上限/JSON 约束）走。
    // 第一次的原始体用不上：只有"两次都空"才取证，那时的 raw_body 才有诊断价值。
    let (content, _) = request_once(client, url, key, protocol, request)?;
    if !content.trim().is_empty() {
        return Ok(content);
    }

    // ── 空响应（HTTP 200 但 content 为空）─────────────────────────────
    // 常见来源：中转站把响应体换成了自己的包装、模型被 max_tokens 卡死在第一帧、
    // 或 json_object 约束下模型直接吐了空。这些都不是"用户配置错了"，
    // 而是单次请求的偶发结果 —— 立刻用默认参数重试一次，多半就回来了。
    //
    // 重试必须隔 1 秒：连续两次瞬发请求容易被中转站/官方风控判成刷接口。
    std::thread::sleep(Duration::from_secs(1));
    let retry = ChatRequest {
        model: request.model.clone(),
        messages: request.messages.clone(),
        // 降级到通用温度：0.1/0.2 这类低温度在某些模型上会加剧"什么都不说"。
        temperature: 0.7,
        // 输出空间至少给到 2048：原来是 1200 时，长一点的诊断 JSON 会被截断成空。
        max_tokens: request.max_tokens.max(RETRY_MIN_MAX_TOKENS),
        // 保留调用方的 JSON 约束（诊断/翻译都依赖它），否则重试得到的是散文。
        response_format: ResponseFormat { kind: request.response_format.kind },
    };
    let (content, raw_body) = match request_once(client, url, key, protocol, &retry) {
        Ok(result) => result,
        // 重试阶段本身失败（网络/HTTP 错误）就直接把原始错误交给上层，
        // 不要用"空内容"覆盖掉更有信息量的 401/429。
        Err(err) => return Err(err),
    };
    if !content.trim().is_empty() {
        return Ok(content);
    }

    // 两次都空：把原始响应体打到控制台（截断，绝不打印 Key），
    // 这是判断"是不是中转站返回了奇怪格式"的唯一证据。
    let snapshot: String = raw_body.chars().take(LOG_RAW_BODY_CHARS).collect();
    eprintln!("[ai] 连续两次空响应；原始响应体（截断 {LOG_RAW_BODY_CHARS} 字符）：{snapshot}");
    Err(CommandError::new(
        "AI_EMPTY",
        "AI 未能生成有效结果。请检查：1. 模型名称是否可用；2. 第三方中转站余额是否充足；3. 尝试在设置中更换模型（如切换至 DeepSeek-V3 或 V4 Pro）。",
    ))
}

/// 重试时保证的最小输出上限。诊断 JSON 有可能会被 1200 这一档截断成空。
const RETRY_MIN_MAX_TOKENS: u32 = 2048;
/// 空响应时打印原始响应体的截断长度（够看清包装结构，又不至于刷屏）。
const LOG_RAW_BODY_CHARS: usize = 2000;

/// 发一次请求并解析出正文；同时把原始响应体带回来——空响应时要靠它取证。
///
/// 返回值第二项是原始 JSON 文本（解析失败时是解析前的原文），
/// 调用方只在"连续两次都空"时才打印它，正常路径不会多占内存。
fn request_once(
    client: &Client,
    url: &str,
    key: &str,
    protocol: ApiProtocol,
    request: &ChatRequest,
) -> AppResult<(String, String)> {
    let response = match protocol {
        ApiProtocol::OpenAi => client
            .post(url)
            .bearer_auth(key)
            .json(request)
            .send()
            .map_err(|e| CommandError::new("AI_NETWORK", format!("连接 AI 服务失败：{e}")))?,
        ApiProtocol::Anthropic => {
            let body = serde_json::json!({
                "model": request.model,
                // Anthropic 强制要求 max_tokens，复用与 OpenAI 相同的取值。
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
                // System Prompt 提权：顶层 system 字段，不进 messages。
                "system": anthropic_system_prompt(&request.messages).unwrap_or_default(),
                // messages 只放 user/assistant，且 user 开头、严格交替。
                "messages": sanitize_anthropic_messages(&request.messages),
            });
            client
                .post(url)
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&body)
                .send()
                .map_err(|e| CommandError::new("AI_NETWORK", format!("连接 AI 服务失败：{e}")))?
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(CommandError::new(
            "AI_HTTP",
            http_error_message(status.as_u16(), &body, ErrorContext::Chat),
        ));
    }
    // 先把正文读成字符串：解析要它，空响应取证也要它（一次读取，别读两遍）。
    let raw_body = response
        .text()
        .map_err(|e| CommandError::new("AI_PARSE", format!("读取 AI 响应失败：{e}")))?;
    // Anthropic 的 content 是分块数组（text 块可能多段，thinking 等类型直接跳过）；
    // OpenAI 是 choices[0].message.content。两套解析各自对准自己的形状。
    let content = match protocol {
        ApiProtocol::OpenAi => {
            let parsed: ChatResponse = serde_json::from_str(&raw_body).map_err(|e| {
                CommandError::new("AI_PARSE", format!("AI 服务返回了无法解析的响应：{e}"))
            })?;
            parsed
                .choices
                .into_iter()
                .next()
                .map(|choice| choice.message.content)
                .unwrap_or_default()
        }
        ApiProtocol::Anthropic => {
            let parsed: AnthropicResponse = serde_json::from_str(&raw_body).map_err(|e| {
                CommandError::new("AI_PARSE", format!("AI 服务返回了无法解析的响应：{e}"))
            })?;
            parsed
                .content
                .into_iter()
                .filter(|block| block.block_type == "text")
                .map(|block| block.text)
                .collect::<Vec<_>>()
                .join("\n")
        }
    };
    // 空内容不在这里报错：交给 chat_completion 决定要不要重试。
    Ok((content, raw_body))
}

/// Anthropic Messages API 的响应体：`content` 是分块数组，我们只认 `text` 块。
#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    #[serde(default)]
    content: Vec<AnthropicContentBlock>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type", default)]
    block_type: String,
    #[serde(default)]
    text: String,
}

const SYSTEM_PROMPT: &str = r#"你是《赛博朋克 2077》模组安装与加载问题的诊断专家。
你会收到启动器生成的脱敏 JSON 快照。请只依据快照中的证据判断，不要编造不存在的日志、版本号或文件。

规则：
1. 用简体中文回答。
2. 先指出“最可能的一个问题”，再给最多 3 条可以直接执行的最小修复步骤。
3. 优先级：前置框架缺失/版本不匹配 > 游戏更新导致框架失效 > 文件冲突 > 加载顺序 > 其他。
4. 不要建议盗版、绕过 DRM、删除游戏目录、关闭杀毒软件或从不明来源下载文件。
5. 如果证据不足，confidence 用 low，并在 needsMoreInfo 里列出还需要用户提供什么。
6. 只返回一个 JSON 对象，不要 Markdown 代码块。字段：
{"summary":"一句话结论","likelyCause":"最可能的原因","evidence":["证据1","证据2"],"fixSteps":["步骤1","步骤2"],"actions":[...],"confidence":"high|medium|low","needsMoreInfo":["还需要的信息"]}

7. actions 是**可以由启动器直接执行**的动作，最多 3 条；没有可执行项就给空数组。
   每条形如 {"kind":"...","target":"...","label":"按钮上的一句话","reason":"为什么要做","position":"first|last"}：
   - kind 只能是这四个之一：
     · disableMod   停用某个模组（冲突、重复、疑似不兼容时用）
     · enableMod    启用某个模组（模组没生效而且它是必需前置时用）
     · moveLoadOrder 调整加载顺序，position 必填：first=排到最前，last=排到最后
     · proposePatch 需要改 Redscript 代码才能修的场景，交给「AI 补丁」流程
   - target 必须是上面 mods[] 里出现过的 id，**不允许编造**；拿不准就干脆不给动作。
   - 每条动作只说一件事；不要给「删除游戏文件」「修改系统设置」「关杀毒」这类动作。
   - fixSteps 仍要写（给玩家看的文字说明），actions 与它对应即可。"#;

fn focus_instruction(focus: Option<&str>) -> &'static str {
    match focus {
        // Only fixed intents are accepted; user text is never injected into the prompt.
        Some("conflicts") => {
            "用户正打开冲突中心。请优先解释冲突快照里的目标文件和两个模组，给出一个明确建议：保留哪一个、禁用哪一个，以及是否真的需要改加载顺序。不要泛泛重复所有诊断项。"
        }
        Some("logs") => {
            "用户从日志查看器提取了关键错误。日志已经裁剪为每条错误前后 5 行；请只根据这些错误片段判断，指出最可能的一条并给最多三条修复步骤。不要假设没有出现在片段里的堆栈。"
        }
        _ => "整体诊断：先找出最可能影响游戏启动或模组生效的一处问题。",
    }
}

fn strip_code_fence(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    let without_open = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    without_open
        .trim_end_matches("```")
        .trim()
        .to_string()
}

fn normalize_confidence(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "high" | "高" | "很高" => "high".to_string(),
        "low" | "低" | "很低" => "low".to_string(),
        _ => "medium".to_string(),
    }
}

/// AI 可使用的动作类型白名单 —— **唯一清单**。
///
/// 前端只按这里的 kind 渲染按钮，后端执行前再校验一次；新增动作必须同时改这三处
/// （这里、`aiact::apply` 的分支、前端 apply 的文案），缺一处就会被门禁拦住。
pub const ACTION_KINDS: [&str; 4] = ["disableMod", "enableMod", "moveLoadOrder", "proposePatch"];

/// 一次诊断最多允许几条动作：按钮堆太多反而让人不知道点哪个。
const MAX_ACTIONS: usize = 3;

/// 把 AI 给的原始动作过一遍白名单与存在性校验。
///
/// 这是「AI 不能直接改底层」的关键闸门：模型只能**点名**它想做什么，能不能做、
/// 怎么做全部由这里和 `aiact::apply` 决定。具体拒绝的情况：
/// - kind 不在白名单里（包括模型自创的 "deleteFile" 这类危险动作）；
/// - target 不在当前库里（编造的 id、或已经卸载的模组）；
/// - 动作与当前状态相同（已启用的再启用、已停用的再停用）—— 点了没反应的按钮只会让人困惑；
/// - moveLoadOrder 缺少合法 position。
fn sanitize_actions(raw: Vec<AiActionPayload>, data: &AppStateData) -> Vec<AiFixAction> {
    let mut actions: Vec<AiFixAction> = Vec::new();
    for (index, item) in raw.into_iter().enumerate() {
        if actions.len() >= MAX_ACTIONS {
            break;
        }
        let kind = item.kind.trim().to_string();
        if !ACTION_KINDS.contains(&kind.as_str()) {
            continue;
        }
        let target = item.target.trim().to_string();
        let Some(entry) = data.mods.iter().find(|item| item.id == target) else {
            continue;
        };
        let redundant = match kind.as_str() {
            "disableMod" => !entry.enabled,
            "enableMod" => entry.enabled,
            _ => false,
        };
        if redundant {
            continue;
        }
        let position = if kind == "moveLoadOrder" {
            let raw = item.position.unwrap_or_default();
            match raw.trim().to_ascii_lowercase().as_str() {
                "first" | "top" | "start" => Some("first".to_string()),
                "last" | "bottom" | "end" => Some("last".to_string()),
                // 位置说不清就不执行：瞎调顺序可能直接让游戏起不来。
                _ => continue,
            }
        } else {
            None
        };
        let label = if item.label.trim().is_empty() {
            default_action_label(&kind, &entry.name)
        } else {
            item.label.trim().chars().take(40).collect()
        };
        actions.push(AiFixAction {
            id: if item.id.trim().is_empty() {
                format!("act-{index}")
            } else {
                item.id.trim().to_string()
            },
            kind,
            target,
            target_name: entry.name.clone(),
            label,
            reason: item.reason.trim().chars().take(120).collect(),
            position,
        });
    }
    actions
}

/// 模型没给按钮文案时的兜底（用库里的真名，而不是模型可能写错的名字）。
fn default_action_label(kind: &str, name: &str) -> String {
    match kind {
        "disableMod" => format!("停用 {name}"),
        "enableMod" => format!("启用 {name}"),
        "moveLoadOrder" => format!("调整 {name} 的加载顺序"),
        "proposePatch" => format!("为 {name} 生成补丁"),
        _ => format!("处理 {name}"),
    }
}

pub fn diagnose(
    store: &Store,
    report: &DiagnosticsReport,
    data: &AppStateData,
    include_logs: bool,
    consent: bool,
    focus: Option<&str>,
) -> AppResult<AiDiagnosis> {
    if !consent {
        return Err(CommandError::new(
            "AI_CONSENT_REQUIRED",
            "需要你明确同意后才会把脱敏诊断摘要发送到 AI 服务。",
        ));
    }
    let key = load_key(store)?.ok_or_else(|| {
        CommandError::new(
            "AI_NOT_CONFIGURED",
            "还没有配置 AI API Key。请先在「AI 助手配置」里填写。",
        )
    })?;
    let settings = data.settings.clone();
    let game_root = report.game.as_ref().map(|game| PathBuf::from(&game.root));
    let (context, redactions) =
        build_context(report, data, game_root.as_deref(), include_logs, focus);
    let sent_chars = context.chars().count();

    let request = ChatRequest {
        model: settings.ai_model.clone(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user",
                content: format!(
                    "这是启动器当前的脱敏诊断快照。请按系统提示输出 JSON。\n\
                     本次关注点：{}。\n\n{context}",
                    focus_instruction(focus)
                ),
            },
        ],
        temperature: 0.2,
        // 诊断 JSON 有时带 3-5 条证据+步骤，1200 会被截断成空响应；给到 2400。
        max_tokens: 2400,
        response_format: ResponseFormat { kind: "json_object" },
    };

    let client = build_client("AI-Diagnostics")?;
    let protocol = resolve_protocol(&settings.ai_protocol);
    let url = match protocol {
        ApiProtocol::OpenAi => normalize_base_url(&settings.ai_base_url),
        ApiProtocol::Anthropic => anthropic_messages_endpoint(&settings.ai_base_url),
    };
    // 发送、状态码映射、JSON 解析都走 chat_completion，与翻译共用同一份实现。
    let content = chat_completion(&client, &url, &key, protocol, &request)?;
    let cleaned = strip_code_fence(&content);
    let payload: AiPayload = serde_json::from_str(&cleaned).map_err(|e| {
        let snippet: String = cleaned.chars().take(500).collect();
        CommandError::new(
            "AI_BAD_JSON",
            format!("模型没有按 JSON 格式回复：{e}\n{snippet}"),
        )
    })?;

    Ok(AiDiagnosis {
        summary: if payload.summary.trim().is_empty() {
            "模型没有给出结论。".to_string()
        } else {
            payload.summary
        },
        likely_cause: payload.likely_cause,
        evidence: payload.evidence.into_iter().take(8).collect(),
        fix_steps: payload.fix_steps.into_iter().take(5).collect(),
        actions: sanitize_actions(payload.actions, data),
        confidence: normalize_confidence(&payload.confidence),
        needs_more_info: payload.needs_more_info.into_iter().take(5).collect(),
        model: settings.ai_model,
        generated_at: now_iso(),
        sent_chars,
        redactions,
        context_preview: context.chars().take(24_000).collect(),
    })
}

// ============================================================================
// Mod 名称 AI 中译
// ============================================================================

/// 框架/底层库名单：这些名字本身就是工具标识，翻成中文只会让用户在论坛、
/// 文档和 Nexus 上搜不到对应软件，也让「该不该更新框架」变得难以判断。
/// 匹配发生在发请求之前，命中即跳过，**不消耗任何 API 额度**。
const FRAMEWORK_NAME_BLACKLIST: &[&str] = &[
    "Cyber Engine Tweaks",
    "CET",
    "RED4ext",
    "redscript",
    "ArchiveXL",
    "TweakXL",
    "Codeware",
    "AudioXL",
    "Audioware",
    "REDmod",
    "Native Interactions",
];

/// 单批最多 20 个名字。
/// 上限来自两个考虑：20 个名字的 JSON 只有几百 token，离上下文上限很远；
/// 而模型一次处理太多条目时更容易漏 id、改号，批越大「整批返工」的代价越高。
const TRANSLATE_BATCH_SIZE: usize = 20;

/// 批与批之间停 300ms。
/// 多数服务商（无论哪家兼容实现）对短时间内的连续请求都会限流，直接连发很容易
/// 吃 429；串行 + 停顿比并发更稳，而翻译本身不是用户会盯着秒数的操作，慢一点
/// 完全可以接受。
const TRANSLATE_THROTTLE_MS: u64 = 300;

/// 单个译名的字符上限，防御模型把一整段解释塞进 name 字段。
const MAX_TRANSLATED_CHARS: usize = 60;

/// 判断某个名字是否属于「框架 / 底层库」，属于就整条跳过不翻译。
///
/// 匹配分两档，因为名单里混着长短两类词条：
/// - 长词（长度 > 3）用大小写不敏感的「包含」匹配。真实库里框架名常带后缀，
///   比如 `RED4ext Scripts`、`ArchiveXL 修复补丁`，只比整名会漏掉一大片。
/// - 短词（长度 <= 3，目前只有 `CET`）只接受「整名相等」或「按词边界切出来的
///   某个词与它相等」。短缩写出现在别的单词内部太常见，`Cetmix`、`CETy` 这类
///   普通 Mod 要是被「包含」匹配误杀，用户会发现明明能翻译却永远没有结果。
pub(crate) fn is_framework_name(name: &str) -> bool {
    let haystack = name.to_lowercase();
    if haystack.trim().is_empty() {
        return false;
    }
    // 只在 ASCII 字母数字之间保留连续片段：中文字符视为边界，因为缩写通常直接
    // 粘在中文上书写（`CET服装包`）；而英文单词内部（`Cetmix`）不会被切开。
    let tokens: Vec<&str> = haystack
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();

    FRAMEWORK_NAME_BLACKLIST.iter().any(|entry| {
        let needle = entry.to_lowercase();
        // 用 chars().count() 而不是 len()：名单将来如果加入非 ASCII 词条，
        // 按字节数算会把一个汉字算成 3 字节，短词规则就误判了。
        if needle.chars().count() > 3 {
            haystack.contains(needle.as_str())
        } else {
            haystack.trim() == needle || tokens.iter().any(|token| *token == needle.as_str())
        }
    })
}

/// 名字里已经出现汉字就当作作者给了中文名，不再送去翻译。
/// 否则「赛博朋克 2077 中文修正」会被再叠一层，变成中英混杂的怪名字。
fn looks_chinese(text: &str) -> bool {
    text.chars()
        .any(|ch| matches!(ch, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'))
}

/// 清洗模型返回的单个译名；返回 None 表示这条结果不可用。
fn clean_translation(raw: &str) -> Option<String> {
    // 先只保留第一行：有些模型会在名字后面换行再补一句解释。
    let mut text: &str = raw.lines().next().unwrap_or("").trim();
    // 再剥掉两端的引号、书名号、Markdown 星号和句号。顺序不能反：先剥后切行的话，
    // 「“义体扩展”。\n解释」会先被剥成「“义体扩展”。\n解释」（末尾不匹配），
    // 换行留着，第一行的句号也还挂着。
    text = text.trim_matches(|ch: char| {
        matches!(
            ch,
            '"' | '\''
                | '`'
                | '*'
                | '。'
                | '、'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '「'
                | '」'
                | '《'
                | '》'
        )
    });
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // 超长时截断而不是丢弃：截断至少还能用，丢弃等于这一条白花钱。
    Some(text.chars().take(MAX_TRANSLATED_CHARS).collect())
}

/// 从模型回复里抠出一个 JSON 值。
///
/// 即使请求带了 `response_format: json_object`，模型仍然可能加 ```json 围栏，
/// 或者在 JSON 前后写一句「以下是结果」。所以先原样试，再截取首尾括号之间的
/// 片段重试；两种形状（对象 / 数组）都试一遍，只要有一段能解析就返回，
/// 避免因为多说了半句话就让整批作废。
fn extract_json_value(content: &str) -> Option<serde_json::Value> {
    let text = strip_code_fence(content);
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) {
        return Some(value);
    }
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(start), Some(end)) = (text.find(open), text.rfind(close)) {
            // end 是闭合符号的起始字节，+1 后仍落在字符边界上，切片不会 panic。
            if end > start {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text[start..end + 1])
                {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// 把任意形状的回复展开成 (id, 译名) 列表。
fn collect_translation_pairs(
    value: &serde_json::Value,
    out: &mut Vec<(Option<String>, String)>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                match item {
                    // 纯字符串数组没有 id，留给位置兜底处理。
                    serde_json::Value::String(text) => out.push((None, text.clone())),
                    other => collect_translation_pairs(other, out),
                }
            }
        }
        serde_json::Value::Object(map) => {
            // 最常见形态 {"id":"m0","name":"译名"}。id 字段名各家模型会写成 key/ID，
            // 译名字段则可能叫 name/translation/zh，这里都认。
            let id = map
                .get("id")
                .or_else(|| map.get("ID"))
                .or_else(|| map.get("key"))
                .and_then(|value| value.as_str());
            let text = ["name", "translation", "translated", "zh", "zh_cn", "title", "value"]
                .iter()
                .find_map(|field| map.get(*field).and_then(|value| value.as_str()));
            if let Some(text) = text {
                out.push((id.map(|id| id.to_string()), text.to_string()));
                return;
            }
            // 外层包装：{"translations": [...]}、{"result": {...}} 等，往下钻一层。
            let mut recursed = false;
            for field in ["translations", "result", "results", "data", "items", "mods"] {
                if let Some(inner) = map.get(field) {
                    collect_translation_pairs(inner, out);
                    recursed = true;
                }
            }
            if recursed {
                return;
            }
            // 简写映射：{"m0":"译名","m1":"译名"}。
            for (key, value) in map {
                if let Some(text) = value.as_str() {
                    out.push((Some(key.clone()), text.to_string()));
                }
            }
        }
        _ => {}
    }
}

/// 把模型回复解析成 {短 id -> 译名}，短 id 即我们发送时用的 `m0`、`m1`……
fn parse_translations(value: &serde_json::Value, expected: usize) -> HashMap<String, String> {
    let mut pairs: Vec<(Option<String>, String)> = Vec::new();
    collect_translation_pairs(value, &mut pairs);

    let mut map = HashMap::new();
    // 带 id 的条目优先，它们能精确对回具体的 Mod。
    for (id, text) in pairs.iter() {
        if let Some(id) = id {
            // 同一个 id 出现多次时保留第一条，后面的重复条目当作噪声。
            map.entry(id.clone()).or_insert_with(|| text.clone());
        }
    }
    if !map.is_empty() {
        return map;
    }
    // 兜底：模型只回了一个纯字符串数组。只有数量与批次完全一致时才按位置映射——
    // 数量不符宁可算失败，也不能把 A 的译名安到 B 头上（那会污染原名对应关系）。
    if expected > 0 && pairs.len() == expected {
        for (index, (_, text)) in pairs.iter().enumerate() {
            map.insert(format!("m{index}"), text.clone());
        }
    }
    map
}

/// 构造一批翻译请求。
///
/// 发送时用批次内的短 id（`m0`、`m1`……）而不是真实的 ModEntry.id：真实 id 是较长的
/// 标识串，塞进 prompt 既浪费 token，模型也更容易抄错或漏抄；短 id 由本地一一映射回
/// 真实 id，模型只要保证「不新增、不遗漏」即可。
fn build_translate_request(
    model: &str,
    batch: &[(String, String)],
) -> AppResult<ChatRequest> {
    let items: Vec<serde_json::Value> = batch
        .iter()
        .enumerate()
        .map(|(index, (_, name))| serde_json::json!({ "id": format!("m{index}"), "name": name }))
        .collect();
    let body = serde_json::to_string(&items)
        .map_err(|e| CommandError::new("AI_REQUEST", format!("无法构造翻译请求：{e}")))?;
    Ok(ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: TRANSLATE_SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user",
                // prompt 里保留 "JSON" 字样：部分服务商的 json_object / 结构化输出
                // 模式要求提示词里出现 json，否则可能直接拒绝或返回空内容。
                content: format!(
                    "待翻译的 Mod 名称 JSON 数组：\n{body}\n请按系统提示只返回 JSON 对象，id 与输入一一对应。"
                ),
            },
        ],
        // 翻译要稳定、可复现：同一批名字两次调用最好给出同一个结果，所以温度压很低。
        temperature: 0.2,
        // 每个译名留 60 token 余量，再加固定开销，防止批次较大时被 max_tokens 截断。
        max_tokens: 400 + (batch.len() as u32) * 60,
        response_format: ResponseFormat { kind: "json_object" },
    })
}

/// 翻译结果的系统提示。
///
/// 强制对齐官方简体中文术语：Mod 作者常用 Cyberware/Braindance/Quickhack 这些词，
/// 如果模型自由发挥译成「赛博装置」「脑舞」「快速黑客」，用户在看游戏内界面时
/// 会对不上号。人名公司名同理，玩家社区只认官方译名。
const TRANSLATE_SYSTEM_PROMPT: &str = r#"你是《赛博朋克 2077》模组名称的简体中文译者。输入是一个 JSON 数组，元素形如 {"id":"m0","name":"原文 Mod 名称"}。

请为每个 name 给出一条简体中文显示名，必须遵守：
1. 术语一律使用《赛博朋克 2077》简体中文官方译名：Cyberware→义体，Braindance→超梦，Quickhack→快速破解，Ripperdoc→义体医生，Netrunner→网络潜行者，Chrome→义体，NCPD 保留 NCPD。
2. 人名、公司名、地名（V、Jackie、Judy、Panam、Arasaka、Militech、CyberDeck、Watson 等）使用官方简体中文译名；没有公认官方译名的保留英文原名。
3. 不适合翻译的专有名词保留英文原文：缩写、版本号、框架与工具名（CET、RED4ext、ArchiveXL、TweakXL、redscript、REDmod 等）、代码标识符。允许中英混排，绝不要给它们硬造中文名。
4. 名称里的版本号、下载来源、兼容性标签（[Framework]、v1.2、- CET 等）可以去掉了，但不要删掉能识别这个 Mod 的关键词。
5. 译名要短，控制在 30 个汉字以内；不要加「模组」「MOD」「插件」等后缀，不要加引号书名号，不要写解释，不要换行。
6. 只返回一个 JSON 对象，不要 Markdown 代码块，不要任何额外文字。格式：
{"translations":[{"id":"m0","name":"中文译名"}]}
id 必须与输入一一对应，不许新增、不许遗漏、不许改号。"#;

/// 错误只保留前几条。
/// 翻译是批量的，一次 429 可能连累几十个名字，全部塞进 errors 会让前端弹窗刷屏，
/// 也会把真正有用的第一条原因挤掉。
fn push_translate_error(errors: &mut Vec<String>, message: String) {
    const MAX_ERRORS: usize = 6;
    if errors.len() < MAX_ERRORS {
        errors.push(message);
    }
}

/// 把一批译名写进 state 并落盘。
///
/// 关键约束：只写 `translated_name` / `translated_at` / `translated_by`，
/// **永远不碰 `name`**。name 是冲突检测、modlist 写入和路径匹配的依据，
/// 一旦被中文覆盖，后续按名字比对的地方会全部失配。
///
/// 这里持锁的时间只包含内存赋值和一次文件写入，不包含任何网络请求。
fn persist_translations(
    store: &Store,
    updates: &HashMap<String, String>,
    model: &str,
    at: &str,
) -> AppResult<()> {
    let mut data = store.data.lock().expect("state mutex poisoned");
    let mut changed = false;
    for entry in data.mods.iter_mut() {
        let Some(translated) = updates.get(&entry.id) else {
            continue;
        };
        // 用户可能同时点了两次翻译，或者刚手动填了自定义名；后到的结果不能盖掉
        // 已有的译名，这也正是「防误触」的那道闸。
        if entry
            .translated_name
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            continue;
        }
        entry.translated_name = Some(translated.clone());
        entry.translated_at = Some(at.to_string());
        entry.translated_by = Some(model.to_string());
        changed = true;
    }
    if changed {
        store.save(&data)?;
    }
    Ok(())
}

/// 批量翻译 Mod 名称，结果只写 `translated_*` 三个字段。
///
/// 参数：
/// - `consent`：必须为 true，否则返回 `AI_CONSENT_REQUIRED`。发出去的是 Mod 名称列表
///   （不含路径和用户名），但仍然要求调用方在 UI 上做一次明确确认。
/// - `only_ids`：只处理这些 Mod id。`Some(&[])` 表示「什么都没选」，
///   直接返回全零报告——误传空数组不应该意外触发一次全库 API 请求。
/// - `limit`：本次最多翻译多少个名字，用于「先翻 10 个看看效果」。
///
/// 统计口径：`requested = translated + failed + skipped`。
/// `skipped` 包含四类：已有译名、命中框架黑名单、名字已经是中文、被 `limit` 截掉。
pub fn translate_mod_names(
    store: &Store,
    consent: bool,
    only_ids: Option<&[String]>,
    limit: Option<usize>,
) -> AppResult<TranslateReport> {
    if !consent {
        return Err(CommandError::new(
            "AI_CONSENT_REQUIRED",
            "需要你明确同意后，才会把 Mod 名称列表发送到 AI 服务做翻译。",
        ));
    }

    // 先整份快照到内存，后面的网络请求全程只读这份副本，不需要再持锁。
    let snapshot = store.snapshot_data();
    let settings = snapshot.settings.clone();
    let model = settings.ai_model.clone();
    let mut report = TranslateReport {
        requested: 0,
        translated: 0,
        failed: 0,
        skipped: 0,
        model: model.clone(),
        errors: Vec::new(),
    };

    let mut pending: Vec<(String, String)> = Vec::new();
    for entry in snapshot.mods.iter() {
        if let Some(only_ids) = only_ids {
            if !only_ids.iter().any(|id| id == &entry.id) {
                continue;
            }
        }
        report.requested += 1;

        // 已经有译名就跳过：translated_name 有值说明用户已经看过（甚至手动改过），
        // 再请求一次既浪费额度，还可能把用户自定义的名字换成模型的版本。
        if entry
            .translated_name
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            report.skipped += 1;
            continue;
        }
        // 框架/底层库保持原名。这一句在发请求之前，命中黑名单不会消耗 API。
        if is_framework_name(&entry.name) {
            report.skipped += 1;
            continue;
        }
        if looks_chinese(&entry.name) {
            report.skipped += 1;
            continue;
        }
        pending.push((entry.id.clone(), entry.name.clone()));
    }

    if let Some(limit) = limit {
        if pending.len() > limit {
            // 被 limit 截掉的部分算 skipped 而不是 failed：它们没出错，只是这一轮没轮到。
            report.skipped += pending.len() - limit;
            pending.truncate(limit);
        }
    }

    // 词表命中直接复用：命中项不消耗 API，也不再进批次（看板【7】名称级共享）。
    // 词表读失败按「没有词表」处理——不能因为一个可选加速层让整轮翻译失败。
    if let Ok(hits) = crate::glossary::lookup(store, &pending) {
        let mut reused: HashMap<String, String> = HashMap::new();
        let mut misses: Vec<(String, String)> = Vec::new();
        for ((mod_id, name), hit) in pending.into_iter().zip(hits.into_iter()) {
            match hit {
                Some(target) => {
                    reused.insert(mod_id, target);
                }
                None => misses.push((mod_id, name)),
            }
        }
        pending = misses;
        if !reused.is_empty() {
            let at = now_iso();
            persist_translations(store, &reused, &model, &at)?;
            report.translated += reused.len();
        }
    }

    // 全部跳过时直接返回，连 Key 都不读：库里只有框架时，不应该弹出「请先配置 Key」。
    if pending.is_empty() {
        return Ok(report);
    }

    let key = load_key(store)?.ok_or_else(|| {
        CommandError::new(
            "AI_NOT_CONFIGURED",
            "还没有配置 AI API Key。请先在「AI 助手配置」里填写。",
        )
    })?;

    // 客户端建一次、整轮复用：reqwest 会自动复用连接，比每批新建省掉一次 TLS 握手。
    let client = build_client("AI-Translate")?;
    let protocol = resolve_protocol(&settings.ai_protocol);
    let url = match protocol {
        ApiProtocol::OpenAi => normalize_base_url(&settings.ai_base_url),
        ApiProtocol::Anthropic => anthropic_messages_endpoint(&settings.ai_base_url),
    };
    let total_batches = (pending.len() + TRANSLATE_BATCH_SIZE - 1) / TRANSLATE_BATCH_SIZE;

    for (index, batch) in pending.chunks(TRANSLATE_BATCH_SIZE).enumerate() {
        let batch_no = index + 1;
        if index > 0 {
            // 节流放在「上一批结束、下一批开始」之间，第一批不用等。
            std::thread::sleep(Duration::from_millis(TRANSLATE_THROTTLE_MS));
        }

        let request = match build_translate_request(&model, batch) {
            Ok(request) => request,
            Err(err) => {
                report.failed += batch.len();
                push_translate_error(&mut report.errors, err.message);
                continue;
            }
        };

        // 单批失败不中断整轮：后面的批次照常跑，前端拿到的是「部分成功」，
        // 比整轮回滚更贴合用户预期（已经花钱翻译成功的部分不会白费）。
        let content = match chat_completion(&client, &url, &key, protocol, &request) {
            Ok(content) => content,
            Err(err) => {
                report.failed += batch.len();
                push_translate_error(
                    &mut report.errors,
                    format!("第 {batch_no}/{total_batches} 批请求失败：{}", err.message),
                );
                continue;
            }
        };

        let Some(value) = extract_json_value(&content) else {
            report.failed += batch.len();
            push_translate_error(
                &mut report.errors,
                format!("第 {batch_no}/{total_batches} 批返回的内容不是可解析的 JSON。"),
            );
            continue;
        };

        let parsed = parse_translations(&value, batch.len());
        let mut updates: HashMap<String, String> = HashMap::new();
        let mut missing = 0usize;
        for (offset, (mod_id, original)) in batch.iter().enumerate() {
            let Some(raw) = parsed.get(&format!("m{offset}")) else {
                missing += 1;
                continue;
            };
            let Some(cleaned) = clean_translation(raw) else {
                missing += 1;
                continue;
            };
            if cleaned == *original {
                // 模型判定无需翻译（比如纯缩写），结果与原名相同。
                // 这种情况不写库：写了只会让「已翻译」虚高，而且下次仍会重新请求。
                report.skipped += 1;
                continue;
            }
            updates.insert(mod_id.clone(), cleaned);
        }

        if !updates.is_empty() {
            let at = now_iso();
            // 每批落一次盘：中途崩掉/被杀，前面几批的成果不会丢。
            persist_translations(store, &updates, &model, &at)?;
            report.translated += updates.len();
            // 回写词表：下次（以及别的用户导入词表后）不再重复付费。
            // 单个条目写失败不影响本轮结果——词表是加速层，不是数据源。
            for (mod_id, original) in batch.iter() {
                if let Some(target) = updates.get(mod_id) {
                    let _ = crate::glossary::record(store, mod_id, original, target, "ai");
                }
            }
        }
        if missing > 0 {
            report.failed += missing;
            push_translate_error(
                &mut report.errors,
                format!("第 {batch_no}/{total_batches} 批有 {missing} 个名字没有拿到有效译名。"),
            );
        }
    }

    Ok(report)
}

/// AI 汉化文本的批次结果。`texts` 与输入等长，None 表示这一条没拿到可用译文。
pub(crate) struct TranslatedTexts {
    pub texts: Vec<Option<String>>,
    pub model: String,
    pub errors: Vec<String>,
}

/// 游戏内文本每批条数。比名称翻译更小：单条文本通常长得多，
/// 一批 20 条已经接近多数模型的输出上限，再大容易整批被截断。
const LOC_BATCH_SIZE: usize = 20;

const LOC_SYSTEM_PROMPT: &str = r#"你是《赛博朋克 2077》模组的简体中文本地化译者。输入是一个 JSON 数组，元素形如 {"id":"e0","text":"原文"}。

请为每条的 text 给出简体中文译文，必须遵守：
1. 术语用官方简体中文译名：Cyberware→义体，Braindance→超梦，Quickhack→快速破解，Ripperdoc→义体医生，Netrunner→网络潜行者，Eddies→欧元，NCPD 保留 NCPD。
2. 人名、公司名、地名用官方译名；没有公认译名的保留英文。
3. 保留原文的标点、大小写风格、占位符与格式化标记（如 {VALUE}、%s、<RichColor>、\n 转义），一个都不能少。
4. 不要合并或拆分条目，不要加解释、不要加引号、不要写 Markdown。译文中不得出现真实换行，需要换行时写 \n。
5. 代码标识符、资源路径、框架名（CET、RED4ext、ArchiveXL、TweakXL、redscript）保持原样。
6. 只返回一个 JSON 对象：
{"translations":[{"id":"e0","text":"译文"}]}
id 必须与输入一一对应，不许新增、不许遗漏、不许改号。"#;

const REDSCRIPT_FIX_PROMPT: &str = r#"你是《赛博朋克 2077》Redscript 补丁工程师。用户会给出一个模组的脚本片段和一句需求。

请生成一个**独立的**补丁文件，必须遵守：
1. 第一行必须是 `module CyberDeck.AiFix.<名字>`，不要复用原模组的模块名。
2. 只用 `@wrapMethod(类名)` 或 `@replaceMethod(类名)` 覆盖目标方法，不要重写整个类。
3. 不得调用文件、网络、进程相关 API（FileSystem / HttpClient / Process / Runtime / Exec / import）。
4. 不得修改原模组的任何文件内容；补丁只能包含注解 + 方法定义。
5. 参数与返回值必须与原方法签名一致；拿不准时用 @wrapMethod 保留原逻辑，只改返回值。
6. 只输出 Redscript 代码，不要解释、不要 Markdown 围栏、不要 TODO 注释。
7. 如果这个需求无法用补丁安全实现，只输出一行：// UNSUPPORTED: <原因>"#;

/// 生成 Redscript 补丁文本。返回 `(代码, 模型, 警告)`。
///
/// 只有「结构合法」由调用方（`aifix::validate_structure`）判定，这里不假装校验。
pub(crate) fn propose_redscript_patch(
    store: &Store,
    brief: &str,
) -> AppResult<(String, String, Vec<String>)> {
    let settings = store.snapshot_data().settings.clone();
    let model = settings.ai_model.clone();
    let key = load_key(store)?.ok_or_else(|| {
        CommandError::new(
            "AI_NOT_CONFIGURED",
            "还没有配置 AI API Key。请先在「AI 助手配置」里填写。",
        )
    })?;
    let client = build_client("AI-Redscript")?;
    let protocol = resolve_protocol(&settings.ai_protocol);
    let url = match protocol {
        ApiProtocol::OpenAi => normalize_base_url(&settings.ai_base_url),
        ApiProtocol::Anthropic => anthropic_messages_endpoint(&settings.ai_base_url),
    };
    let request = ChatRequest {
        model: model.clone(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: REDSCRIPT_FIX_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user",
                content: brief.to_string(),
            },
        ],
        temperature: 0.1,
        // 补丁通常一两百行，按上下文规模给足余量但设上限，避免长篇大论。
        max_tokens: 3000,
        response_format: ResponseFormat { kind: "json_object" },
    };
    // 部分服务商对 json_object 与代码输出兼容不好：先用普通请求，失败再退回无格式约束。
    let content = match chat_completion(&client, &url, &key, protocol, &request) {
        Ok(content) => content,
        Err(err) if err.code == "AI_HTTP" => {
            let fallback = ChatRequest {
                response_format: ResponseFormat { kind: "text" },
                ..request
            };
            chat_completion(&client, &url, &key, protocol, &fallback)?
        }
        Err(err) => return Err(err),
    };
    let code = strip_code_fence(&content).trim().to_string();
    let mut warnings = Vec::new();
    if code.starts_with("// UNSUPPORTED") {
        warnings.push(code.clone());
    }
    Ok((code, model, warnings))
}

/// 清洗游戏内译文：只剥包裹引号，不做名称翻译那套「去句号 / 截 30 字」处理。
fn clean_loc_text(raw: &str) -> Option<String> {
    let mut text = raw.replace("\r\n", "\n");
    text = text.trim().to_string();
    // 模型偶尔会把整段包在引号里；只剥成对的包裹引号，不动正文里的引号。
    for quote in ['"', '“', '「'] {
        if text.starts_with(quote) && text.ends_with(match quote {
            '"' => '"',
            '“' => '”',
            _ => '」',
        }) && text.chars().count() > 2
        {
            let mut chars = text.chars();
            chars.next();
            chars.next_back();
            text = chars.as_str().to_string();
            break;
        }
    }
    // 游戏内文本不允许真实换行（JSON 里会破坏条目），统一转成字面量 \n。
    let text = text.replace('\n', "\\n").trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(text)
}

fn parse_loc_translations(value: &serde_json::Value) -> HashMap<usize, String> {
    let mut out = HashMap::new();
    let Some(list) = value.get("translations").and_then(|item| item.as_array()) else {
        return out;
    };
    for item in list {
        let Some(id) = item.get("id").and_then(|id| id.as_str()) else {
            continue;
        };
        let Some(text) = item.get("text").and_then(|text| text.as_str()) else {
            continue;
        };
        let Ok(index) = id.trim_start_matches('e').parse::<usize>() else {
            continue;
        };
        if let Some(clean) = clean_loc_text(text) {
            out.insert(index, clean);
        }
    }
    out
}

/// 把一批游戏内文本翻成简体中文。
///
/// 与 [`translate_mod_names`] 刻意分开：名称翻译会剥书名号 / 句号并压到 30 字，
/// 那套清洗规则用在物品描述上会直接毁掉标点。这里只做最少清洗，其余交给调用方。
pub(crate) fn translate_locale_strings(
    store: &Store,
    items: &[String],
    hint: &str,
) -> AppResult<TranslatedTexts> {
    let settings = store.snapshot_data().settings.clone();
    let model = settings.ai_model.clone();
    let mut out = TranslatedTexts {
        texts: vec![None; items.len()],
        model: model.clone(),
        errors: Vec::new(),
    };
    if items.is_empty() {
        return Ok(out);
    }
    let key = load_key(store)?.ok_or_else(|| {
        CommandError::new(
            "AI_NOT_CONFIGURED",
            "还没有配置 AI API Key。请先在「AI 助手配置」里填写。",
        )
    })?;
    let client = build_client("AI-Localize")?;
    let protocol = resolve_protocol(&settings.ai_protocol);
    let url = match protocol {
        ApiProtocol::OpenAi => normalize_base_url(&settings.ai_base_url),
        ApiProtocol::Anthropic => anthropic_messages_endpoint(&settings.ai_base_url),
    };
    let total_batches = (items.len() + LOC_BATCH_SIZE - 1) / LOC_BATCH_SIZE;

    for (batch_index, chunk) in items.chunks(LOC_BATCH_SIZE).enumerate() {
        let batch_no = batch_index + 1;
        if batch_index > 0 {
            std::thread::sleep(Duration::from_millis(TRANSLATE_THROTTLE_MS));
        }
        let base = batch_index * LOC_BATCH_SIZE;
        let payload: Vec<serde_json::Value> = chunk
            .iter()
            .enumerate()
            .map(|(offset, text)| serde_json::json!({ "id": format!("e{}", base + offset), "text": text }))
            .collect();
        let body = match serde_json::to_string(&payload) {
            Ok(body) => body,
            Err(err) => {
                push_translate_error(&mut out.errors, format!("无法构造翻译请求：{err}"));
                continue;
            }
        };
        let request = ChatRequest {
            model: model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system",
                    content: LOC_SYSTEM_PROMPT.to_string(),
                },
                ChatMessage {
                    role: "user",
                    content: format!(
                        "所属模组：{hint}\n待翻译文本 JSON 数组：\n{body}\n请按系统提示只返回 JSON 对象。"
                    ),
                },
            ],
            temperature: 0.3,
            // 译文通常比原文长，按每条的原文长度再留一倍余量。
            max_tokens: 800 + chunk.iter().map(|text| text.chars().count() as u32).sum::<u32>(),
            response_format: ResponseFormat { kind: "json_object" },
        };
        match chat_completion(&client, &url, &key, protocol, &request) {
            Ok(content) => match extract_json_value(&content) {
                Some(value) => {
                    let parsed = parse_loc_translations(&value);
                    let mut missing = 0;
                    for offset in 0..chunk.len() {
                        match parsed.get(&(base + offset)) {
                            Some(text) => out.texts[base + offset] = Some(text.clone()),
                            None => missing += 1,
                        }
                    }
                    if missing > 0 {
                        push_translate_error(
                            &mut out.errors,
                            format!("第 {batch_no}/{total_batches} 批有 {missing} 条没有拿到有效译文。"),
                        );
                    }
                }
                None => push_translate_error(
                    &mut out.errors,
                    format!("第 {batch_no}/{total_batches} 批返回的内容不是合法 JSON。"),
                ),
            },
            Err(err) => push_translate_error(
                &mut out.errors,
                format!("第 {batch_no}/{total_batches} 批失败：{}", err.message),
            ),
        }
    }
    Ok(out)
}

/// Expose the redactor for unit tests without making the whole module public.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{
        AppStateData, BackupInfo, DiagnosticIssue, DiagnosticsReport, FrameworkStatus, GameInfo,
        InstallLayout, ModEntry,
    };
    use std::io::Write as _;

    /// 测试 mock 服务器专用：把 HTTP 请求读完整。
    ///
    /// 🔴 不能用单次 `stream.read(&mut [0u8; 16K])`——TCP 不保证一次读全，
    /// 请求体大于一次读的量或线程调度不同步时，断言就会随机挂
    /// （此前 diagnose / translate 两个测试在并行跑时偶发失败就是它）。
    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            // 头部齐了之后按 Content-Length 决定还要不要继续读。
            // ⚠️ hyper 写 HTTP/1.1 头是小写 `content-length:`，必须大小写无关地找，
            //    否则永远认不出来、读完头部就 break——单线程测试"碰巧"全过
            //    （第一个 chunk 装得下整个请求），并行负载下就随机截断。
            let Ok(text) = std::str::from_utf8(&buffer) else {
                continue;
            };
            let Some(header_end) = text.find("\r\n\r\n") else {
                continue;
            };
            let content_length = text[..header_end]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if !name.trim().eq_ignore_ascii_case("content-length") {
                        return None;
                    }
                    value.trim().parse::<usize>().ok()
                });
            match content_length {
                Some(len) => {
                    if buffer.len() >= header_end + 4 + len {
                        break;
                    }
                }
                // 没有 Content-Length 的测试请求：读到头也就够了。
                None => break,
            }
        }
        String::from_utf8_lossy(&buffer).to_string()
    }
    use std::net::TcpListener;

    #[test]
    fn models_endpoint_strips_chat_suffix_and_adds_models() {
        assert_eq!(
            models_endpoint("https://api.example.com/v1"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            models_endpoint("https://api.example.com/v1/"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            models_endpoint("https://x.example/api/chat/completions"),
            "https://x.example/api/models"
        );
        // 裸域名补 /v1（DeepSeek / Ollama / LM Studio 的 OpenAI 兼容端点都在 /v1 下）。
        assert_eq!(
            models_endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/models"
        );
        assert_eq!(
            models_endpoint("http://localhost:11434"),
            "http://localhost:11434/v1/models"
        );
        // 已经指到 /models 的地址不再重复拼接。
        assert_eq!(
            models_endpoint("https://api.example.com/v1/models"),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn anthropic_endpoints_follow_base_url_variants() {
        // 官方推荐写法：/v1 根地址，直接补 /messages。
        assert_eq!(
            anthropic_messages_endpoint("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        // 裸域名：补全 /v1/messages。
        assert_eq!(
            anthropic_messages_endpoint("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        // 完整端点：原样使用（第三方原生代理的常见写法）。
        assert_eq!(
            anthropic_messages_endpoint("https://proxy.example/claude/messages"),
            "https://proxy.example/claude/messages"
        );
        assert_eq!(
            anthropic_models_endpoint("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            anthropic_models_endpoint("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn anthropic_messages_must_start_with_user_and_alternate() {
        let messages = |role: &'static str, content: &str| ChatMessage {
            role,
            content: content.to_string(),
        };
        // 常规形状：system 提走后只剩 user。
        let sanitized = sanitize_anthropic_messages(&[
            messages("system", "系统提示"),
            messages("user", "用户输入"),
        ]);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].role, "user");
        assert_eq!(sanitized[0].content, "用户输入");

        // 连续同角色合并；合并后 user/assistant/user 三跳本身合法交替。
        let sanitized = sanitize_anthropic_messages(&[
            messages("user", "第一段"),
            messages("user", "第二段"),
            messages("assistant", "开场白"),
            messages("user", "问题"),
        ]);
        assert_eq!(sanitized.len(), 3);
        assert_eq!(sanitized[0].role, "user");
        assert_eq!(sanitized[0].content, "第一段\n\n第二段");
        assert_eq!(sanitized[1].role, "assistant");
        assert_eq!(sanitized[2].role, "user");

        // 全 assistant：清空后兜占位 user，绝不能发空 messages。
        let sanitized = sanitize_anthropic_messages(&[messages("assistant", "只有这个")]);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].role, "user");

        // 顶层 system 提取。
        let system = anthropic_system_prompt(&[
            messages("system", "系统提示"),
            messages("user", "用户输入"),
        ]);
        assert_eq!(system.as_deref(), Some("系统提示"));
    }

    #[test]
    fn parse_models_json_handles_standard_bare_and_wrapped_shapes() {
        let standard = r#"{"object":"list","data":[{"id":"model-a"},{"id":"model-b"},{"id":"model-a"}]}"#;
        assert_eq!(
            parse_models_json(standard),
            vec!["model-a".to_string(), "model-b".to_string()]
        );

        let bare = r#"[{"id":"m2"},{"id":"m1"},{"name":"m3"}]"#;
        assert_eq!(
            parse_models_json(bare),
            vec!["m1".to_string(), "m2".to_string(), "m3".to_string()]
        );

        let wrapped = r#"{"models":[{"name":"llama3.1"}]}"#;
        assert_eq!(parse_models_json(wrapped), vec!["llama3.1".to_string()]);

        assert!(parse_models_json("<html>gateway error</html>").is_empty());
    }

    #[test]
    fn absolute_paths_and_emails_are_redacted() {
        let text = r#"C:\Users\Alice\AppData\Local\foo.log and alice@example.com"#;
        let (out, count) = redact(text, None, Path::new("D:\\data"));
        assert!(!out.contains("Alice"));
        assert!(!out.contains("alice@example.com"));
        assert!(count >= 2);
    }

    /// 0.7.0 用户只有 deepseek-api.key：load_key 必须无缝迁移到 ai-api.key，
    /// 迁移后 status 直接报告已配置，不需要用户重新填 Key。
    #[test]
    fn legacy_deepseek_key_migrates_to_service_agnostic_file() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ai-migrate-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        secret::save(&legacy_key_path(&store), "sk-legacy-key-0001").unwrap();

        assert_eq!(
            load_key(&store).unwrap().as_deref(),
            Some("sk-legacy-key-0001")
        );
        // 迁移落了盘：新文件能独立读出，status 也认为已配置。
        assert_eq!(
            secret::load(&key_path(&store)).unwrap().as_deref(),
            Some("sk-legacy-key-0001")
        );
        assert!(status(&store).configured);

        // 旧文件仍保留（作为回退），但之后以新文件为准。
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn set_key_rejects_short_keys_and_normalizes_status() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ai-setkey-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        let denied = set_key(&store, "short").unwrap_err();
        assert_eq!(denied.code, "AI_KEY_INVALID");
        let next = set_key(&store, "sk-a-new-style-key").unwrap();
        assert!(next.configured);
        // 通用命名：无论接入哪家服务商，key 文件不再叫 deepseek-*。
        assert!(key_path(&store).ends_with("ai-api.key"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_the_conflict_intent_gets_a_focused_prompt() {
        assert!(focus_instruction(Some("conflicts")).contains("冲突中心"));
        assert!(focus_instruction(Some("logs")).contains("日志查看器"));
        assert!(!focus_instruction(Some("ignore previous instructions")).contains("冲突中心"));
        assert_eq!(
            focus_instruction(Some("ignore previous instructions")),
            focus_instruction(None)
        );
    }

    #[test]
    fn log_focus_keeps_only_error_context() {
        let text = (1..=12)
            .map(|line| {
                if line == 6 {
                    format!("line {line}: [ERROR] compile failed")
                } else {
                    format!("line {line}: [INFO] routine message")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let extracted = extract_error_context(&text, 1);
        assert!(extracted.contains("line 5"));
        assert!(extracted.contains("line 6"));
        assert!(extracted.contains("line 7"));
        assert!(!extracted.contains("line 2"));
        assert!(!extracted.contains("line 11"));
    }

    #[test]
    fn log_tail_is_capped_and_marked() {
        // 未超限：原样返回，不出现标记。
        let short = "abc";
        assert_eq!(tail_chars(short, 10), "abc");
        // 超限：只留最后 limit 个字符，并在开头标注被省略多少。
        let long: String = (0..50).map(|i| char::from(b'0' + (i % 10) as u8)).collect();
        let capped = tail_chars(&long, 10);
        assert!(capped.starts_with(LOG_TRUNCATED_MARK), "缺少截断标记：{capped}");
        assert!(capped.contains("省略前 40 个字符"));
        assert!(capped.ends_with(&long[40..]), "尾部内容必须保留");
        // 按 char 而不是字节截：中日文不会被切成半个字符。
        let cjk = "日志".repeat(20);
        let capped = tail_chars(&cjk, 4);
        assert!(capped.ends_with("日志日志"));
    }

    /// 空响应必须自动重试一次，且重试参数要"更宽松"（温度 0.7 / 输出上限 ≥2048）。
    ///
    /// 之前的行为是第一次空就直接把 AI_EMPTY 抛给用户，而空响应多数是偶发，
    /// 用户看到红框只能反复点重试。这个用例把"自动重试"钉死。
    #[test]
    fn empty_reply_is_retried_once_with_roomier_params() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let reply = |content: &str| {
                serde_json::json!({ "choices": [{ "message": { "content": content } }] }).to_string()
            };
            // 第一跳：故意返回空内容（HTTP 200）。
            let (mut stream, _) = listener.accept().unwrap();
            let first = read_http_request(&mut stream);
            assert!(first.contains("POST /chat/completions"));
            let body = reply("");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();

            // 第二跳：重试。断言参数被降级成"默认可出话"的那一档。
            let (mut stream, _) = listener.accept().unwrap();
            let second = read_http_request(&mut stream);
            assert!(second.contains("\"temperature\":0.7"), "重试应降到 0.7 温度：{second}");
            let max_tokens = second
                .rsplit("\"max_tokens\":")
                .next()
                .and_then(|tail| tail.split([',', '}']).next())
                .and_then(|value| value.trim().parse::<u32>().ok())
                .expect("请求体里应有 max_tokens");
            assert!(
                max_tokens >= 2048,
                "重试的输出上限至少要 2048，实际 {max_tokens}"
            );
            let body = reply("{\"summary\":\"重试成功\",\"confidence\":\"high\"}");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ai-retry-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        secret::save(&key_path(&store), "sk-local-test").unwrap();
        let mut data = AppStateData::new(store.staging_dir().to_string_lossy().to_string());
        data.settings.ai_base_url = format!("http://{address}");
        data.settings.ai_model = "local-test".to_string();
        let report = DiagnosticsReport {
            generated_at: now_iso(),
            game: None,
            frameworks: Vec::new(),
            issues: Vec::new(),
            summary: String::new(),
            summary_level: String::new(),
            deployed_mods: 0,
            enabled_mods: 0,
            total_mods: 0,
            conflict_count: 0,
            log_paths: Vec::new(),
            backup: None,
            dependencies: Default::default(),
        };

        let result = diagnose(&store, &report, &data, false, true, None).expect("重试后应成功");
        assert_eq!(result.summary, "重试成功");
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn diagnose_sends_json_and_parses_structured_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request_text = read_http_request(&mut stream);
            assert!(request_text.contains("POST /chat/completions"));
            assert!(request_text.contains("Bearer sk-local-test"));
            assert!(request_text.contains("\"model\":\"local-test\""));

            let content = serde_json::json!({
                "summary": "缺少 RED4ext",
                "likelyCause": "框架目录不存在",
                "evidence": ["red4ext 未安装"],
                "fixSteps": ["安装 RED4ext 后重启游戏"],
                "confidence": "high",
                "needsMoreInfo": []
            })
            .to_string();
            let reply = serde_json::json!({
                "choices": [{ "message": { "content": content } }]
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ai-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        secret::save(&key_path(&store), "sk-local-test").unwrap();
        let mut data = AppStateData::new(store.staging_dir().to_string_lossy().to_string());
        data.settings.ai_base_url = format!("http://{address}");
        data.settings.ai_model = "local-test".to_string();
        let game = GameInfo {
            root: "D:\\Games\\Cyberpunk 2077".to_string(),
            exe_path: "D:\\Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe".to_string(),
            version: Some("2.31".to_string()),
            source: "steam".to_string(),
            valid: true,
            archive_dir: None,
            mods_dir: None,
            language: Some("zh-cn".to_string()),
            game_updated: false,
            last_game_version: Some("2.31".to_string()),
        };
        let report = DiagnosticsReport {
            generated_at: now_iso(),
            game: Some(game),
            frameworks: vec![FrameworkStatus {
                id: "red4ext".to_string(),
                name: "RED4ext".to_string(),
                installed: false,
                required: false,
                path: Some("D:\\Games\\Cyberpunk 2077\\red4ext".to_string()),
                version: None,
                note: "未安装".to_string(),
            }],
            issues: vec![DiagnosticIssue {
                id: "framework-path".to_string(),
                severity: "warning".to_string(),
                title: "框架路径".to_string(),
                detail: "检查 D:\\Games\\Cyberpunk 2077\\red4ext\\RED4ext.dll".to_string(),
                action: None,
            }],
            summary: "缺少前置框架".to_string(),
            summary_level: "error".to_string(),
            deployed_mods: 0,
            enabled_mods: 0,
            total_mods: 0,
            conflict_count: 0,
            log_paths: Vec::new(),
            backup: Option::<BackupInfo>::None,
            dependencies: crate::deps::DependencyReport::default(),
        };

        let result = diagnose(&store, &report, &data, false, true, None).unwrap();
        assert_eq!(result.summary, "缺少 RED4ext");
        assert_eq!(result.confidence, "high");
        assert_eq!(result.fix_steps.len(), 1);
        assert!(result.redactions >= 1);
        assert!(!result.context_preview.contains("D:\\Games\\Cyberpunk 2077"));
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    /// Anthropic 原生协议全链路：请求必须是 /v1/messages + x-api-key +
    /// anthropic-version，body 里 system 在顶层、messages 只有 user、
    /// 不能出现 response_format；回复从 content[0].text 取。
    #[test]
    fn diagnose_via_anthropic_protocol_sends_native_shape() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request_text = read_http_request(&mut stream);
            assert!(request_text.contains("POST /v1/messages"));
            assert!(request_text.contains("x-api-key: sk-claude-test"));
            assert!(request_text.contains("anthropic-version: 2023-06-01"));
            assert!(!request_text.contains("Bearer"));
            assert!(!request_text.contains("response_format"));
            // system 必须在顶层字段，不在 messages 数组里。
            assert!(request_text.contains("\"system\":"));
            let body_start = request_text.find('{').unwrap();
            let body: serde_json::Value =
                serde_json::from_str(&request_text[body_start..]).unwrap();
            assert_eq!(body["model"], "claude-local-test");
            assert!(body["max_tokens"].is_u64(), "Anthropic 强制要求 max_tokens");
            let msgs = body["messages"].as_array().unwrap();
            assert_eq!(msgs.len(), 1);
            assert_eq!(msgs[0]["role"], "user");
            assert!(msgs[0]["content"].as_str().unwrap().contains("诊断快照"));

            let content = serde_json::json!({
                "summary": "缺少 RED4ext",
                "likelyCause": "框架目录不存在",
                "evidence": ["red4ext 未安装"],
                "fixSteps": ["安装 RED4ext 后重启游戏"],
                "confidence": "high",
                "needsMoreInfo": []
            })
            .to_string();
            let reply = serde_json::json!({
                "id": "msg_test",
                "content": [{ "type": "text", "text": content }]
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ai-anthropic-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        secret::save(&key_path(&store), "sk-claude-test").unwrap();
        let mut data = AppStateData::new(store.staging_dir().to_string_lossy().to_string());
        data.settings.ai_base_url = format!("http://{address}");
        data.settings.ai_model = "claude-local-test".to_string();
        data.settings.ai_protocol = "anthropic".to_string();
        // 地址不含 /v1：应被自动补全为 /v1/messages（mock 里断言了 POST 路径）。
        let report = make_minimal_report();
        let result = diagnose(&store, &report, &data, false, true, None).unwrap();
        assert_eq!(result.summary, "缺少 RED4ext");
        assert_eq!(result.model, "claude-local-test");
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    /// 造一份字段齐全的最小诊断报告（多个测试共用）。
    fn make_minimal_report() -> DiagnosticsReport {
        let game = GameInfo {
            root: "D:\\Games\\Cyberpunk 2077".to_string(),
            exe_path: "D:\\Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe".to_string(),
            version: Some("2.31".to_string()),
            source: "steam".to_string(),
            valid: true,
            archive_dir: None,
            mods_dir: None,
            language: Some("zh-cn".to_string()),
            game_updated: false,
            last_game_version: Some("2.31".to_string()),
        };
        DiagnosticsReport {
            generated_at: now_iso(),
            game: Some(game),
            frameworks: vec![FrameworkStatus {
                id: "red4ext".to_string(),
                name: "RED4ext".to_string(),
                installed: false,
                required: false,
                path: Some("D:\\Games\\Cyberpunk 2077\\red4ext".to_string()),
                version: None,
                note: "未安装".to_string(),
            }],
            issues: vec![DiagnosticIssue {
                id: "framework-path".to_string(),
                severity: "warning".to_string(),
                title: "框架路径".to_string(),
                detail: "检查 D:\\Games\\Cyberpunk 2077\\red4ext\\RED4ext.dll".to_string(),
                action: None,
            }],
            summary: "缺少前置框架".to_string(),
            summary_level: "error".to_string(),
            deployed_mods: 0,
            enabled_mods: 0,
            total_mods: 0,
            conflict_count: 0,
            log_paths: Vec::new(),
            backup: Option::<BackupInfo>::None,
            dependencies: crate::deps::DependencyReport::default(),
        }
    }

    /// 造一个字段齐全的 ModEntry。改名相关逻辑只关心 id/name/translated_*，
    /// 其余字段给最小值即可（ModEntry 没有 Default，只能全量写出来）。
    fn action_payload(kind: &str, target: &str, position: Option<&str>) -> AiActionPayload {
        AiActionPayload {
            id: String::new(),
            kind: kind.to_string(),
            target: target.to_string(),
            label: String::new(),
            reason: "测试".to_string(),
            position: position.map(str::to_string),
        }
    }

    /// 白名单是「AI 不能直接改底层」的第一道闸门：模型自创的动作、编造的模组 id、
    /// 以及与当前状态相同的空操作，都必须在这一步就被丢掉。
    #[test]
    fn ai_actions_are_whitelisted_and_bound_to_real_mods() {
        let mut data = AppStateData::new("staging".to_string());
        data.mods = vec![
            sample_mod("m-a", "Alpha"),
            sample_mod("m-b", "Beta"),
        ];
        let raw = vec![
            action_payload("deleteFile", "m-a", None),          // 不在白名单
            action_payload("runShell", "m-a", None),            // 不在白名单
            action_payload("enableMod", "m-ghost", None),        // 模组不存在
            action_payload("enableMod", "m-a", None),            // 已启用 → 空操作
            action_payload("disableMod", "m-a", None),           // 合法
            action_payload("moveLoadOrder", "m-b", Some("middle")), // 位置说不清 → 丢弃
            action_payload("moveLoadOrder", "m-b", Some("FIRST")),  // 合法，归一化为 first
        ];
        let actions = sanitize_actions(raw, &data);
        assert_eq!(actions.len(), 2, "{actions:?}");
        assert_eq!(actions[0].kind, "disableMod");
        assert_eq!(actions[0].target_name, "Alpha", "名字要来自库，不信 AI");
        assert!(actions[0].label.contains("Alpha"), "缺 label 时用真名兜底");
        assert_eq!(actions[1].kind, "moveLoadOrder");
        assert_eq!(actions[1].position.as_deref(), Some("first"));
    }

    /// 最多 3 条：按钮堆太多只会让人不知道该点哪个。
    #[test]
    fn ai_actions_are_capped_at_three() {
        let mut data = AppStateData::new("staging".to_string());
        data.mods = vec![
            sample_mod("m-a", "A"),
            sample_mod("m-b", "B"),
            sample_mod("m-c", "C"),
            sample_mod("m-d", "D"),
        ];
        let raw = vec![
            action_payload("disableMod", "m-a", None),
            action_payload("disableMod", "m-b", None),
            action_payload("disableMod", "m-c", None),
            action_payload("disableMod", "m-d", None),
        ];
        assert_eq!(sanitize_actions(raw, &data).len(), 3);
    }

    fn sample_mod(id: &str, name: &str) -> ModEntry {
        ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: name.to_string(),
            version: Some("1.0.0".to_string()),
            author: None,
            category: "gameplay".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: None,
            staging_path: format!("mods/{id}"),
            cover_path: None,
            enabled: true,
            installed_at: now_iso(),
            updated_at: None,
            size_bytes: 1024,
            file_count: 1,
            layout: InstallLayout::Archive,
            mod_folder: None,
            metadata_source: "filename".to_string(),
            planned_files: Vec::new(),
            warnings: Vec::new(),
            deployed_files: Vec::new(),
            has_archive: true,
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

    #[test]
    fn framework_names_are_matched_without_swallowing_similar_mods() {
        // 长词按「包含」匹配：带后缀的框架条目也要拦下来。
        assert!(is_framework_name("RED4ext Scripts"));
        assert!(is_framework_name("ArchiveXL 兼容补丁"));
        assert!(is_framework_name("Native Interactions Extended"));
        assert!(is_framework_name("redscript"));
        // 短词（<= 3）只认整名或独立分词。
        assert!(is_framework_name("CET"));
        assert!(is_framework_name(" cet "));
        assert!(is_framework_name("CET v1.2.3"));
        assert!(is_framework_name("CET服装包"));
        // 形似但不是框架：短缩写绝不能被「包含」匹配误杀。
        assert!(!is_framework_name("Cetmix"));
        assert!(!is_framework_name("CETy Character Creation"));
        assert!(!is_framework_name("ArchiveX Lite"));
        assert!(!is_framework_name(""));
    }

    #[test]
    fn translations_are_recovered_from_noisy_replies() {
        // ```json 围栏 + 前后说明文字，仍然要能解析出 id。
        let noisy = "好的，结果如下：\n```json\n{\"translations\":[{\"id\":\"m0\",\"name\":\"义体扩展\"},{\"id\":\"m1\",\"name\":\"超梦编辑器\"}]}\n```\n希望对你有帮助。";
        let value = extract_json_value(noisy).expect("应当能从噪声里抠出 JSON");
        let parsed = parse_translations(&value, 2);
        assert_eq!(parsed.get("m0").map(String::as_str), Some("义体扩展"));
        assert_eq!(parsed.get("m1").map(String::as_str), Some("超梦编辑器"));

        // 简写映射 {"m0":"..."} 也要认。
        let value = extract_json_value("{\"m0\":\"快速破解增强\"}").unwrap();
        assert_eq!(
            parse_translations(&value, 1).get("m0").map(String::as_str),
            Some("快速破解增强")
        );

        // 纯字符串数组：数量与批次一致时按位置兜底。
        let value = extract_json_value("[\"义体扩展\", \"超梦编辑器\"]").unwrap();
        let parsed = parse_translations(&value, 2);
        assert_eq!(parsed.get("m1").map(String::as_str), Some("超梦编辑器"));

        // 数量对不上就不猜位置，宁可让上层记失败。
        let value = extract_json_value("[\"只有一个\"]").unwrap();
        assert!(parse_translations(&value, 2).is_empty());

        // 译名清洗：去引号、只留第一行。原样英文则视为无需翻译。
        assert_eq!(clean_translation("「义体扩展」。\n说明文字").as_deref(), Some("义体扩展"));
        assert_eq!(clean_translation("   "), None);
    }

    #[test]
    fn translate_skips_frameworks_and_never_touches_the_original_name() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request_text = read_http_request(&mut stream);
            assert!(request_text.contains("POST /chat/completions"));
            assert!(request_text.contains("Bearer sk-local-test"));
            // 黑名单条目在发请求前就被拦掉了，请求体里不该出现它。
            assert!(!request_text.contains("\"name\":\"RED4ext\""));
            // 系统提示必须带上官方术语表（限制 2 的落地点）。
            assert!(request_text.contains("Braindance→超梦"));

            let content = serde_json::json!({
                "translations": [
                    { "id": "m0", "name": "义体扩展" },
                    { "id": "m1", "name": "超梦编辑器" }
                ]
            })
            .to_string();
            let reply = serde_json::json!({
                "choices": [{ "message": { "content": content } }]
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ai-translate-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        secret::save(&key_path(&store), "sk-local-test").unwrap();
        {
            let mut data = store.data.lock().expect("state mutex poisoned");
            data.settings.ai_base_url = format!("http://{address}");
            data.settings.ai_model = "local-test".to_string();
            data.mods = vec![
                sample_mod("m-red4ext", "RED4ext"),
                sample_mod("m-cyberware", "Cyberware Expanded"),
                sample_mod("m-braindance", "Braindance Editor"),
            ];
            store.save(&data).unwrap();
        }

        // 没有明确同意时直接拒绝，一个字节都不外发。
        let denied = translate_mod_names(&store, false, None, None).unwrap_err();
        assert_eq!(denied.code, "AI_CONSENT_REQUIRED");

        let report = translate_mod_names(&store, true, None, None).unwrap();
        assert_eq!(report.requested, 3);
        assert_eq!(report.skipped, 1, "框架条目应计入跳过");
        assert_eq!(report.translated, 2);
        assert_eq!(report.failed, 0);
        assert!(report.errors.is_empty());
        assert_eq!(report.model, "local-test");

        let data = store.snapshot_data();
        let by_id = |id: &str| {
            data.mods
                .iter()
                .find(|entry| entry.id == id)
                .cloned()
                .expect("条目应存在")
        };
        let framework = by_id("m-red4ext");
        assert_eq!(framework.name, "RED4ext");
        assert_eq!(framework.translated_name, None, "框架条目不应写入译名");

        let cyberware = by_id("m-cyberware");
        assert_eq!(cyberware.name, "Cyberware Expanded", "原名一个字都不能改");
        assert_eq!(cyberware.translated_name.as_deref(), Some("义体扩展"));
        assert_eq!(cyberware.translated_by.as_deref(), Some("local-test"));
        assert!(cyberware.translated_at.is_some());

        // 再跑一次：已有译名的条目不再请求。此时 mock 服务已关闭，
        // 只要逻辑真的又发了请求，这里就会因为连接失败而多出 failed。
        let again = translate_mod_names(&store, true, None, None).unwrap();
        assert_eq!(again.translated, 0);
        assert_eq!(again.failed, 0);
        assert_eq!(again.skipped, 3);

        server.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn empty_selection_and_zero_limit_never_touch_the_network() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("ai-translate-empty-{}", uuid::Uuid::new_v4().simple()));
        let store = Store::load(root.join("data")).unwrap();
        {
            let mut data = store.data.lock().expect("state mutex poisoned");
            // 故意给一个不可达地址，并**不**写 API Key：只要实现试图联网就会直接报错。
            data.settings.ai_base_url = "http://127.0.0.1:1".to_string();
            data.settings.ai_model = "local-test".to_string();
            data.mods = vec![sample_mod("m-cyberware", "Cyberware Expanded")];
            store.save(&data).unwrap();
        }

        // 显式传空选择 = 什么都没选，不能退化成「全库」。
        let empty: Vec<String> = Vec::new();
        let report = translate_mod_names(&store, true, Some(&empty), None).unwrap();
        assert_eq!(report.requested, 0);
        assert_eq!(report.translated, 0);
        assert_eq!(report.skipped, 0);

        // limit=0：候选全部算跳过，同样不需要 Key、不需要网络。
        let report = translate_mod_names(&store, true, None, Some(0)).unwrap();
        assert_eq!(report.requested, 1);
        assert_eq!(report.translated, 0);
        assert_eq!(report.skipped, 1);

        let _ = std::fs::remove_dir_all(root);
    }
}
