//! 下载中心队列（r13）。
//!
//! 设计约束：
//! - **不碰主状态文件 schema**。队列与设置持久化在独立的 `download-queue.json`，
//!   就算这个文件解析失败也只影响下载中心，不能拖垮整个启动器（7b 红线）。
//! - 队列并发 1-3；暂停/继续靠 HTTP Range 断点续传（`.part` 保留，续传字节不归零）。
//! - 429 按 Retry-After 自动挂起重试（上限 5 次），不崩、不丢任务。
//! - **免 Key 通道**：NXM 链接自带的 `key`/`expires` 拿来调 download_link.json，
//!   免费账号从 N 网点「Mod manager download」也能直接下载。
//! - 任务完成且开启自动导入时复用 `installer::install_archive`，与手动导入同一管线。

use crate::installer;
use crate::nexus::safe_download_name;
use crate::schema::{AppResult, CommandError, NexusRef};
use crate::secret;
use crate::store::Store;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const API_BASE: &str = "https://api.nexusmods.com/v1";
const GAME_DOMAIN: &str = "cyberpunk2077";
const MAX_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_429_RETRIES: u32 = 5;
const DEFAULT_429_WAIT_SECS: u64 = 30;
/// 进度事件节流间隔。
const PROGRESS_INTERVAL_MS: u128 = 400;
/// 队列文件名（数据目录内）。
const QUEUE_FILE: &str = "download-queue.json";

// ---------------------------------------------------------------- 状态结构

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub mod_id: u64,
    pub file_id: u64,
    /// 展示名（模组名或文件名）。
    pub name: String,
    /// 落盘文件名（已清洗）。
    pub file_name: String,
    pub status: DownloadStatus,
    pub received: u64,
    pub total: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
    /// NXM 链接自带的签名参数：有它就能免 API Key 下载。
    #[serde(default)]
    pub nxm_key: Option<String>,
    #[serde(default)]
    pub nxm_expires: Option<String>,
    /// 完成后是否自动导入暂存区（NXM 接收条进来的任务默认 true）。
    pub auto_import: bool,
    pub created_at: u64,
    #[serde(default)]
    pub finished_at: Option<u64>,
    /// 429 重试状态：下次重试时间（epoch 秒）与已重试次数。
    #[serde(default)]
    pub retry_at: Option<u64>,
    #[serde(default)]
    pub retries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadQueueSettings {
    /// 并发数 1-3。
    pub concurrency: u32,
    /// 完成后自动导入。
    pub auto_import: bool,
    /// 下载目录覆盖；None = 数据目录内 downloads。
    pub dir: Option<String>,
    /// HTTP/HTTPS 代理（如 http://127.0.0.1:7890）。
    pub proxy: Option<String>,
    /// 带宽限制（deepseek 任务·模块二）：单任务限速，MiB/s。0 = 不限速。
    /// set_settings 钳制 0–100；多任务并发时各自限速，总速率 ≈ limit × concurrency。
    #[serde(default)]
    pub speed_limit_mbps: u32,
}

impl Default for DownloadQueueSettings {
    fn default() -> Self {
        Self {
            concurrency: 2,
            auto_import: true,
            dir: None,
            proxy: None,
            speed_limit_mbps: 0,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedQueue {
    version: u32,
    settings: DownloadQueueSettings,
    tasks: Vec<DownloadTask>,
}

/// 任务的控制旗标，跨线程共享。
#[derive(Debug, Default)]
struct TaskFlags {
    pause: AtomicBool,
    cancel: AtomicBool,
}

#[derive(Debug, Default)]
struct QueueState {
    tasks: Vec<DownloadTask>,
    settings: DownloadQueueSettings,
    flags: HashMap<String, Arc<TaskFlags>>,
    /// 正在跑的 worker（防重复拉起）。
    live_workers: HashSet<String>,
    /// 每个任务上次发进度事件的毫秒时间戳。
    last_emit: HashMap<String, u128>,
}

static QUEUE: OnceLock<Mutex<QueueState>> = OnceLock::new();

fn lock_state() -> std::sync::MutexGuard<'static, QueueState> {
    QUEUE
        .get_or_init(|| Mutex::new(QueueState::default()))
        .lock()
        .expect("queue mutex poisoned")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- 持久化

fn queue_file(data_dir: &Path) -> PathBuf {
    data_dir.join(QUEUE_FILE)
}

fn load_state(data_dir: &Path) {
    let mut state = lock_state();
    if !state.tasks.is_empty() {
        return; // 已经加载过
    }
    let raw = match std::fs::read_to_string(queue_file(data_dir)) {
        Ok(raw) => raw,
        Err(_) => return, // 没有文件 = 空队列，不算错误
    };
    let persisted: PersistedQueue = match serde_json::from_str(&raw) {
        Ok(value) => value,
        // 🔴 解析失败就保持空队列，绝不能用半坏的数据（也绝不 panic）。
        Err(_) => return,
    };
    // 恢复时把 Downloading 的任务拉回 Queued：进程可能中途退出，线程已经没了。
    let mut tasks = persisted.tasks;
    for task in &mut tasks {
        if task.status == DownloadStatus::Downloading {
            task.status = DownloadStatus::Queued;
            task.retry_at = None;
        }
    }
    state.tasks = tasks;
    state.settings = persisted.settings;
}

fn save_state(data_dir: &Path) {
    let snapshot = {
        let state = lock_state();
        PersistedQueue {
            version: 1,
            settings: state.settings.clone(),
            tasks: state.tasks.clone(),
        }
    };
    if let Ok(json) = serde_json::to_string_pretty(&snapshot) {
        let path = queue_file(data_dir);
        // 写临时文件再改名，避免写一半被杀掉留下坏 JSON。
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

// ---------------------------------------------------------------- HTTP 客户端

fn build_client(proxy: Option<&str>) -> AppResult<Client> {
    let mut builder = Client::builder()
        // 下载大文件不能设总超时：只限连接建立时间。
        .connect_timeout(Duration::from_secs(12))
        .user_agent("CyberDeckLauncher/0.7.0 (Tauri; Windows; Nexus-API)");
    if let Some(proxy) = proxy
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let proxy = reqwest::Proxy::all(&proxy)
            .map_err(|e| CommandError::new("DOWNLOAD_PROXY", format!("代理地址无效：{e}")))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| CommandError::new("DOWNLOAD_HTTP", format!("无法创建网络客户端：{e}")))
}

/// 拿直链。有 NXM 签名就走免 Key 通道；否则必须带 API Key。
fn resolve_link(client: &Client, task: &DownloadTask, api_key: Option<&str>) -> AppResult<String> {
    if let (Some(key), Some(expires)) = (task.nxm_key.as_deref(), task.nxm_expires.as_deref()) {
        let url = format!(
            "{API_BASE}/games/{GAME_DOMAIN}/mods/{}/files/{}/download_link.json?key={key}&expires={expires}",
            task.mod_id, task.file_id
        );
        // 免 Key 通道：不带 apikey 头，靠链接里的签名。
        let response = client
            .get(&url)
            .send()
            .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("下载连接失败：{e}")))?;
        return parse_link_response(response);
    }
    let key = api_key.ok_or_else(|| {
        CommandError::new(
            "NEXUS_NOT_CONFIGURED",
            "这个任务没有链接签名，需要 Nexus API Key 才能下载。",
        )
    })?;
    let url = format!(
        "{API_BASE}/games/{GAME_DOMAIN}/mods/{}/files/{}/download_link.json",
        task.mod_id, task.file_id
    );
    let response = client
        .get(&url)
        .header("apikey", key)
        .send()
        .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("下载连接失败：{e}")))?;
    parse_link_response(response)
}

fn parse_link_response(response: Response) -> AppResult<String> {
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(CommandError::new("NEXUS_RATE_LIMITED", "Nexus 限流（429）。"));
    }
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(CommandError::new(
            "NEXUS_DOWNLOAD",
            format!("获取下载地址失败（{status}）：{}", body.chars().take(160).collect::<String>()),
        ));
    }
    #[derive(Deserialize)]
    struct ApiLink {
        uri: String,
    }
    let links: Vec<ApiLink> = response
        .json()
        .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("下载地址解析失败：{e}")))?;
    links
        .into_iter()
        .find(|link| !link.uri.trim().is_empty())
        .map(|link| link.uri)
        .ok_or_else(|| CommandError::new("NEXUS_NO_DOWNLOAD", "Nexus 没有返回下载地址。"))
}

// ---------------------------------------------------------------- 基础操作

/// 恢复启动前的持久化队列（setup 阶段调用一次）。
pub fn init(data_dir: &Path) {
    load_state(data_dir);
}

fn flags_for(state: &mut QueueState, id: &str) -> Arc<TaskFlags> {
    state.flags.entry(id.to_string()).or_default().clone()
}

fn patch<F: FnOnce(&mut DownloadTask)>(data_dir: &Path, id: &str, apply: F) -> Option<DownloadTask> {
    let snapshot = {
        let mut state = lock_state();
        let task = state.tasks.iter_mut().find(|task| task.id == id)?;
        apply(task);
        task.clone()
    };
    save_state(data_dir);
    Some(snapshot)
}

fn emit_status(app: &AppHandle, task: &DownloadTask) {
    let _ = app.emit(
        "download-status",
        serde_json::json!({
            "id": task.id,
            "name": task.name,
            "fileName": task.file_name,
            "modId": task.mod_id,
            "fileId": task.file_id,
            "status": task.status,
            "error": task.error,
            "received": task.received,
            "total": task.total,
        }),
    );
}

pub fn list() -> Vec<DownloadTask> {
    lock_state().tasks.clone()
}

pub fn settings() -> DownloadQueueSettings {
    lock_state().settings.clone()
}

pub fn set_settings(data_dir: &Path, mut next: DownloadQueueSettings) -> DownloadQueueSettings {
    {
        let mut state = lock_state();
        next.speed_limit_mbps = next.speed_limit_mbps.min(100);
        state.settings = next;
        let snapshot = state.settings.clone();
        drop(state);
        save_state(data_dir);
        snapshot
    }
}

/// 入队。返回入队后的任务。
pub fn add(
    data_dir: &Path,
    mod_id: u64,
    file_id: u64,
    name: Option<String>,
    nxm_key: Option<String>,
    nxm_expires: Option<String>,
    auto_import: Option<bool>,
) -> AppResult<DownloadTask> {
    if file_id == 0 {
        return Err(CommandError::new(
            "DOWNLOAD_QUEUE_INVALID",
            "这条链接没有具体文件，不能下载。",
        ));
    }
    let display = name.unwrap_or_else(|| format!("Nexus Mod {mod_id}"));
    let file_name = safe_download_name(mod_id, file_id, &display);
    let task = DownloadTask {
        id: format!("dl-{}-{mod_id}-{file_id}", now_ms()),
        mod_id,
        file_id,
        name: display,
        file_name,
        status: DownloadStatus::Queued,
        received: 0,
        total: None,
        error: None,
        nxm_key,
        nxm_expires,
        auto_import: auto_import.unwrap_or(true),
        created_at: now_secs(),
        finished_at: None,
        retry_at: None,
        retries: 0,
    };
    {
        let mut state = lock_state();
        // 同一个文件已经在队列里（未结束）就不重复排队。
        if state.tasks.iter().any(|item| {
            item.mod_id == mod_id
                && item.file_id == file_id
                && !matches!(
                    item.status,
                    DownloadStatus::Failed | DownloadStatus::Cancelled | DownloadStatus::Completed
                )
        }) {
            return Err(CommandError::new(
                "DOWNLOAD_QUEUE_DUPLICATE",
                "这个文件已经在下载队列里。",
            ));
        }
        state.tasks.push(task.clone());
    }
    save_state(data_dir);
    Ok(task)
}

pub fn pause(data_dir: &Path, id: &str) -> Option<DownloadTask> {
    let flags = {
        let mut state = lock_state();
        Some(flags_for(&mut state, id))
    }?;
    flags.pause.store(true, Ordering::SeqCst);
    // Queued 的任务没有 worker，直接落状态；Downloading 由 worker 收尾。
    let task = patch(data_dir, id, |task| {
        if task.status == DownloadStatus::Queued {
            task.status = DownloadStatus::Paused;
        }
    });
    task
}

pub fn resume(data_dir: &Path, id: &str) -> Option<DownloadTask> {
    {
        let mut state = lock_state();
        let flags = flags_for(&mut state, id);
        flags.pause.store(false, Ordering::SeqCst);
        flags.cancel.store(false, Ordering::SeqCst);
    }
    patch(data_dir, id, |task| {
        if matches!(task.status, DownloadStatus::Paused | DownloadStatus::Failed) {
            task.status = DownloadStatus::Queued;
            task.error = None;
            task.retry_at = None;
            task.retries = 0;
        }
    })
}

pub fn cancel(data_dir: &Path, id: &str) -> Option<DownloadTask> {
    {
        let mut state = lock_state();
        let flags = flags_for(&mut state, id);
        flags.cancel.store(true, Ordering::SeqCst);
        flags.pause.store(false, Ordering::SeqCst);
    }
    // Queued 的任务没有 worker，直接落状态；Downloading 由 worker 清 .part 收尾。
    patch(data_dir, id, |task| {
        if task.status == DownloadStatus::Queued {
            task.status = DownloadStatus::Cancelled;
            task.finished_at = Some(now_secs());
        }
    })
}

/// 移除任务行（运行中的先发取消旗标，worker 会自己收尾退出）。
pub fn remove(data_dir: &Path, id: &str) -> bool {
    {
        let mut state = lock_state();
        if let Some(task) = state.tasks.iter().find(|task| task.id == id) {
            if matches!(
                task.status,
                DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Paused
            ) {
                let flags = flags_for(&mut state, id);
                flags.cancel.store(true, Ordering::SeqCst);
                flags.pause.store(false, Ordering::SeqCst);
            }
        }
    }
    let removed = {
        let mut state = lock_state();
        let before = state.tasks.len();
        state.tasks.retain(|task| task.id != id);
        let removed = before != state.tasks.len();
        if removed {
            state.flags.remove(id);
            state.last_emit.remove(id);
        }
        removed
    };
    if removed {
        save_state(data_dir);
    }
    removed
}

pub fn clear_finished(data_dir: &Path) -> usize {
    let removed = {
        let mut state = lock_state();
        let before = state.tasks.len();
        state.tasks.retain(|task| {
            !matches!(
                task.status,
                DownloadStatus::Completed | DownloadStatus::Cancelled | DownloadStatus::Failed
            )
        });
        before - state.tasks.len()
    };
    if removed > 0 {
        save_state(data_dir);
    }
    removed
}

// ---------------------------------------------------------------- 调度

/// 尝试拉起任务，直到占满并发额度。加任务 / 恢复 / 提高并发后都要调用。
pub fn pump(app: &AppHandle) {
    loop {
        let next = {
            let mut state = lock_state();
            let active = state
                .tasks
                .iter()
                .filter(|task| task.status == DownloadStatus::Downloading)
                .count() as u32;
            if active >= state.settings.concurrency {
                None
            } else {
                let now = now_secs();
                let candidate = state.tasks.iter().position(|task| {
                    task.status == DownloadStatus::Queued
                        && task.retry_at.map(|at| at <= now).unwrap_or(true)
                        && !state.live_workers.contains(&task.id)
                });
                if let Some(index) = candidate {
                    state.tasks[index].status = DownloadStatus::Downloading;
                    let id = state.tasks[index].id.clone();
                    state.live_workers.insert(id.clone());
                    Some(id)
                } else {
                    None
                }
            }
        };
        let Some(id) = next else { break };
        let app = app.clone();
        std::thread::spawn(move || {
            run_worker(&app, &id);
        });
    }
}

// ---------------------------------------------------------------- Worker

enum Attempt {
    /// 文件已就位（复用或下载完成）。
    Downloaded,
    Paused,
    Cancelled,
    /// 429：给出建议等待秒数。
    RateLimited { wait_secs: u64 },
    Failed(CommandError),
}

fn run_worker(app: &AppHandle, id: &str) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        worker_body(app, id);
    }));
    if result.is_err() {
        // worker 崩了也不能把状态永远卡在 Downloading。
        let store = app.state::<Store>();
        let data_dir = store.data_dir.clone();
        drop(store);
        patch(&data_dir, id, |task| {
            if task.status == DownloadStatus::Downloading {
                task.status = DownloadStatus::Failed;
                task.error = Some("下载任务内部异常。".to_string());
                task.finished_at = Some(now_secs());
            }
        });
    }
    {
        let mut state = lock_state();
        state.live_workers.remove(id);
    }
    pump(app);
}

fn worker_body(app: &AppHandle, id: &str) {
    let store = app.state::<Store>();
    let data_dir = store.data_dir.clone();
    let api_key = secret::load(&crate::nexus::key_path(&store)).ok().flatten();
    drop(store);

    loop {
        let (task, flags, proxy, downloads_dir, auto_import) = {
            let mut state = lock_state();
            let Some(task) = state.tasks.iter().find(|task| task.id == id).cloned() else {
                return; // 任务被移除
            };
            let settings = state.settings.clone();
            let flags = flags_for(&mut state, id);
            flags.pause.store(false, Ordering::SeqCst);
            flags.cancel.store(false, Ordering::SeqCst);
            let dir = settings
                .dir
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| data_dir.join("downloads"));
            (task, flags, settings.proxy.clone(), dir, settings.auto_import)
        };
        let do_install = auto_import && task.auto_import;

        let client = match build_client(proxy.as_deref()) {
            Ok(client) => client,
            Err(err) => {
                finish_failure(app, &data_dir, id, &err.message);
                return;
            }
        };

        match attempt_download(app, &client, &task, &flags, &downloads_dir, api_key.as_deref()) {
            Attempt::Cancelled => {
                patch(&data_dir, id, |task| {
                    task.status = DownloadStatus::Cancelled;
                    task.finished_at = Some(now_secs());
                    task.error = None;
                });
                return;
            }
            Attempt::Paused => {
                patch(&data_dir, id, |task| {
                    task.status = DownloadStatus::Paused;
                    task.error = None;
                });
                return;
            }
            Attempt::RateLimited { wait_secs } => {
                // 文件下载阶段的 429 原来没有次数上限（只有 resolve 阶段限 5 次）：
                // 被持续限流时会「等 30s → 再试 → 再等」无限循环，任务看着永远挂在队列里。
                // 这里接入同一个上限，超限即转失败并给出可操作提示（用户可手动重试）。
                if task.retries + 1 > MAX_429_RETRIES {
                    finish_failure(
                        app,
                        &data_dir,
                        id,
                        &format!(
                            "Nexus 连续限流已超过 {MAX_429_RETRIES} 次，已停止自动重试。请稍后手动重试一次。"
                        ),
                    );
                    return;
                }
                bump_retry(app, &data_dir, id, wait_secs);
                if !sleep_interruptible(&flags, wait_secs) {
                    // 等待期间被暂停/取消：必须就地收尾，**不能** continue。
                    // continue 会回到 loop 开头，那里会无条件清 pause/cancel 旗标，
                    // 等于把用户刚点的暂停/取消吞掉、任务静默继续下载（2026-10-30 自检 P1-1）。
                    let cancelled = flags.cancel.load(Ordering::SeqCst);
                    patch(&data_dir, id, |task| settle_interrupted(task, cancelled));
                    return;
                }
                patch(&data_dir, id, |task| {
                    if task.status == DownloadStatus::Queued {
                        task.status = DownloadStatus::Downloading;
                    }
                });
                continue;
            }
            Attempt::Failed(err) => {
                if err.code == "NEXUS_RATE_LIMITED" && task.retries + 1 <= MAX_429_RETRIES {
                    bump_retry(app, &data_dir, id, DEFAULT_429_WAIT_SECS);
                    if !sleep_interruptible(&flags, DEFAULT_429_WAIT_SECS) {
                        // 同上：等待期被中断就地收尾，绝不 continue 回 loop 开头。
                        let cancelled = flags.cancel.load(Ordering::SeqCst);
                        patch(&data_dir, id, |task| settle_interrupted(task, cancelled));
                        return;
                    }
                    patch(&data_dir, id, |task| {
                        if task.status == DownloadStatus::Queued {
                            task.status = DownloadStatus::Downloading;
                        }
                    });
                    continue;
                }
                finish_failure(app, &data_dir, id, &err.message);
                return;
            }
            Attempt::Downloaded => {
                patch(&data_dir, id, |task| {
                    task.status = DownloadStatus::Completed;
                    task.retries = 0;
                    task.retry_at = None;
                    task.error = None;
                    task.finished_at = Some(now_secs());
                });
                if do_install {
                    install_task(app, id, &downloads_dir);
                }
                return;
            }
        }
    }
}

/// 429 重试登记：状态回 Queued、记录下次重试时间。
fn bump_retry(app: &AppHandle, data_dir: &Path, id: &str, wait_secs: u64) {
    if let Some(task) = patch(data_dir, id, |task| {
        task.status = DownloadStatus::Queued;
        task.retry_at = Some(now_secs() + wait_secs);
        task.retries += 1;
        task.error = Some(format!("Nexus 限流，{wait_secs} 秒后自动重试。"));
    }) {
        emit_status(app, &task);
    }
}

fn finish_failure(app: &AppHandle, data_dir: &Path, id: &str, message: &str) {
    if let Some(task) = patch(data_dir, id, |task| {
        task.status = DownloadStatus::Failed;
        task.error = Some(message.to_string());
        task.finished_at = Some(now_secs());
    }) {
        emit_status(app, &task);
    }
}

/// 下载完成后（可选）自动导入：与 nexus.rs 手动路径走同一 install_archive 管线。
fn install_task(app: &AppHandle, id: &str, downloads_dir: &Path) {
    let store = app.state::<Store>();
    let task = lock_state()
        .tasks
        .iter()
        .find(|task| task.id == id)
        .cloned();
    let Some(task) = task else { return };
    let target = downloads_dir.join(&task.file_name);
    if !target.is_file() {
        return;
    }
    let nexus = NexusRef {
        mod_id: task.mod_id,
        file_id: Some(task.file_id),
        url: format!("https://www.nexusmods.com/{GAME_DOMAIN}/mods/{}", task.mod_id),
        version: None,
        picture_url: None,
    };
    match installer::install_archive(&store, &target.to_string_lossy(), Some(nexus)) {
        Ok(entry) => {
            let mut data = store.data.lock().expect("state mutex poisoned");
            data.mods.push(entry);
            if let Err(err) = store.save(&data) {
                // 暂存目录保留，用户可手动导入；不影响任务完成态。
                let _ = err;
            }
        }
        Err(err) => {
            // 安装失败：任务保持 Completed，ZIP 留着，错误单独报给前端。
            let _ = app.emit(
                "download-status",
                serde_json::json!({
                    "id": id,
                    "status": "completed",
                    "error": format!("自动导入失败（ZIP 已保留）：{}", err.message),
                    "received": task.received,
                    "total": task.total,
                }),
            );
        }
    }
}

fn sleep_interruptible(flags: &TaskFlags, secs: u64) -> bool {
    let mut waited = 0u64;
    while waited < secs {
        if flags.cancel.load(Ordering::SeqCst) || flags.pause.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_secs(1));
        waited += 1;
    }
    true
}

/// 限流等待期被用户打断后的收尾：取消优先于暂停。
/// 抽成纯函数是为了可测——worker 主体依赖 AppHandle，单元测试覆盖不到。
fn settle_interrupted(task: &mut DownloadTask, cancelled: bool) {
    task.error = None;
    if cancelled {
        task.status = DownloadStatus::Cancelled;
        task.finished_at = Some(now_secs());
    } else {
        task.status = DownloadStatus::Paused;
    }
}

fn attempt_download(
    app: &AppHandle,
    client: &Client,
    task: &DownloadTask,
    flags: &TaskFlags,
    downloads_dir: &Path,
    api_key: Option<&str>,
) -> Attempt {
    if flags.cancel.load(Ordering::SeqCst) {
        return Attempt::Cancelled;
    }
    if flags.pause.load(Ordering::SeqCst) {
        return Attempt::Paused;
    }

    let _ = std::fs::create_dir_all(downloads_dir);
    let target = downloads_dir.join(&task.file_name);

    // 已完成的文件直接复用（与 nexus.rs 一致的语义）。
    if target.is_file() {
        if let Ok(meta) = std::fs::metadata(&target) {
            if meta.len() > 0 {
                patch_progress(app, task, meta.len(), Some(meta.len()));
                return Attempt::Downloaded;
            }
        }
    }

    let uri = match resolve_link(client, task, api_key) {
        Ok(uri) => uri,
        Err(err) => return Attempt::Failed(err),
    };

    // 断点续传：.part 有多少就从多少继续。
    let part = target.with_extension("part");
    let part_len = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);

    let mut request = client.get(&uri);
    if part_len > 0 {
        request = request.header("Range", format!("bytes={part_len}-"));
    }
    let response = match request.send() {
        Ok(response) => response,
        Err(e) => {
            return Attempt::Failed(CommandError::new("NEXUS_DOWNLOAD", format!("下载连接失败：{e}")));
        }
    };
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let wait = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_429_WAIT_SECS)
            .min(300);
        return Attempt::RateLimited { wait_secs: wait };
    }
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Attempt::Failed(CommandError::new(
            "NEXUS_DOWNLOAD",
            format!("下载失败（{status}）：{}", body.chars().take(160).collect::<String>()),
        ));
    }

    let resuming = status == StatusCode::PARTIAL_CONTENT && part_len > 0;
    let total = match response.content_length() {
        Some(len) if resuming => Some(part_len + len),
        Some(len) => Some(len),
        None => None,
    };
    if let Some(total) = total {
        if total > MAX_DOWNLOAD_BYTES {
            return Attempt::Failed(CommandError::new(
                "NEXUS_DOWNLOAD_TOO_LARGE",
                "这个文件超过 8 GB，启动器拒绝下载。",
            ));
        }
    }

    // 服务端不支持 Range（回 200）就从头来。
    let mut output = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!resuming)
        .append(resuming)
        .open(&part)
    {
        Ok(file) => file,
        Err(e) => {
            return Attempt::Failed(CommandError::new("NEXUS_DOWNLOAD", format!("无法创建下载文件：{e}")));
        }
    };
    let mut received = if resuming { part_len } else { 0 };
    patch_progress(app, task, received, total);
    let mut buffer = [0u8; 128 * 1024];
    let mut response = response;
    // 带宽限制（deepseek 任务·模块二）：0 = 不限。简单令牌桶——按「这段数据
    // 理论上该花的时间」补睡差值，粒度 128 KiB，误差对 MiB/s 级限速足够小。
    let limit = settings().speed_limit_mbps;
    let limit_bytes_per_sec = if limit > 0 { (limit as u64) * 1024 * 1024 } else { 0 };
    let mut window_start = std::time::Instant::now();
    let mut window_bytes: u64 = 0;
    loop {
        if flags.cancel.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&part);
            return Attempt::Cancelled;
        }
        if flags.pause.load(Ordering::SeqCst) {
            patch_progress(app, task, received, total);
            return Attempt::Paused;
        }
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                received += read as u64;
                if received > MAX_DOWNLOAD_BYTES {
                    let _ = std::fs::remove_file(&part);
                    return Attempt::Failed(CommandError::new(
                        "NEXUS_DOWNLOAD_TOO_LARGE",
                        "下载超过 8 GB，已中止。",
                    ));
                }
                if let Err(e) = output.write_all(&buffer[..read]) {
                    return Attempt::Failed(CommandError::new(
                        "NEXUS_DOWNLOAD",
                        format!("写入下载文件失败：{e}"),
                    ));
                }
                if limit_bytes_per_sec > 0 {
                    window_bytes += read as u64;
                    if window_bytes >= limit_bytes_per_sec {
                        let elapsed = window_start.elapsed().as_secs_f64();
                        let budget = window_bytes as f64 / limit_bytes_per_sec as f64;
                        if elapsed < budget {
                            std::thread::sleep(std::time::Duration::from_secs_f64(budget - elapsed));
                        }
                        window_start = std::time::Instant::now();
                        window_bytes = 0;
                    }
                }
                throttle_emit_progress(app, task, received, total);
            }
            Err(e) => {
                // 读失败：.part 保留，继续/重试可以接着传。
                return Attempt::Failed(CommandError::new("NEXUS_DOWNLOAD", format!("下载中断：{e}")));
            }
        }
    }
    output.flush().ok();
    drop(output);
    if received == 0 {
        let _ = std::fs::remove_file(&part);
        return Attempt::Failed(CommandError::new("NEXUS_DOWNLOAD_EMPTY", "下载到 0 字节，已中止。"));
    }
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    if let Err(e) = std::fs::rename(&part, &target) {
        return Attempt::Failed(CommandError::new("NEXUS_DOWNLOAD", format!("无法完成下载文件：{e}")));
    }
    patch_progress(app, task, received, total);
    Attempt::Downloaded
}

/// 进度事件（节流）+ 任务行 received/total 同步。
fn throttle_emit_progress(app: &AppHandle, task: &DownloadTask, received: u64, total: Option<u64>) {
    let now = now_ms();
    let should_emit = {
        let mut state = lock_state();
        let last = state.last_emit.get(&task.id).copied().unwrap_or(0);
        if now.saturating_sub(last) >= PROGRESS_INTERVAL_MS {
            state.last_emit.insert(task.id.clone(), now);
            if let Some(entry) = state.tasks.iter_mut().find(|entry| entry.id == task.id) {
                entry.received = received;
                entry.total = total;
            }
            true
        } else {
            false
        }
    };
    if should_emit {
        let _ = app.emit(
            "download-progress",
            serde_json::json!({ "id": task.id, "received": received, "total": total }),
        );
    }
}

/// 立即同步一次进度（暂停/复用/出错前的最后一次）。
fn patch_progress(app: &AppHandle, task: &DownloadTask, received: u64, total: Option<u64>) {
    {
        let mut state = lock_state();
        if let Some(entry) = state.tasks.iter_mut().find(|entry| entry.id == task.id) {
            entry.received = received;
            entry.total = total;
        }
    }
    let _ = app.emit(
        "download-progress",
        serde_json::json!({ "id": task.id, "received": received, "total": total }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 队列状态是进程级单例，而 cargo test 默认并行：
    /// 不串行的话，A 测试 save_state 会把 B 测试的任务一起写进 A 的文件。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// 每个测试开头取锁 + 清空，保证互不污染。
    fn reset_queue() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = lock_state();
        state.tasks.clear();
        state.flags.clear();
        state.live_workers.clear();
        state.last_emit.clear();
        state.settings = DownloadQueueSettings::default();
        guard
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cdl-dlq-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_rejects_missing_file_and_duplicates() {
        let _guard = reset_queue();
        let dir = tmp_dir("add");
        // 没有 fileId 的链接不能下载。
        let err = add(&dir, 1, 0, None, None, None, None).unwrap_err();
        assert_eq!(err.code, "DOWNLOAD_QUEUE_INVALID");
        // 正常入队。
        let task = add(&dir, 42, 7, Some("Some Mod".into()), None, None, None).unwrap();
        assert_eq!(task.status, DownloadStatus::Queued);
        // 同文件重复入队被拒。
        let err = add(&dir, 42, 7, None, None, None, None).unwrap_err();
        assert_eq!(err.code, "DOWNLOAD_QUEUE_DUPLICATE");
        // 但失败/取消/完成后的同文件允许重新排队。
        patch(&dir, &task.id, |task| task.status = DownloadStatus::Failed);
        assert!(add(&dir, 42, 7, None, None, None, None).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn queued_task_state_machine_without_worker() {
        let _guard = reset_queue();
        let dir = tmp_dir("state");
        let task = add(&dir, 1, 1, None, None, None, None).unwrap();
        // Queued（无 worker）可以直接暂停。
        let paused = pause(&dir, &task.id).unwrap();
        assert_eq!(paused.status, DownloadStatus::Paused);
        // 恢复回队列。
        let resumed = resume(&dir, &task.id).unwrap();
        assert_eq!(resumed.status, DownloadStatus::Queued);
        // 取消直接落 Cancelled。
        let cancelled = cancel(&dir, &task.id).unwrap();
        assert_eq!(cancelled.status, DownloadStatus::Cancelled);
        assert!(cancelled.finished_at.is_some());
        // 已取消的行可以被移除。
        assert!(remove(&dir, &task.id));
        assert!(list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persisted_queue_survives_restart_and_requeues_downloading() {
        let _guard = reset_queue();
        let dir = tmp_dir("persist");
        let task = add(&dir, 9, 3, Some("Persisted Mod".into()), Some("k".into()), Some("9".into()), Some(true)).unwrap();
        // 模拟"下载中进程被杀"：落成 Downloading 后直接重放 load。
        patch(&dir, &task.id, |task| {
            task.status = DownloadStatus::Downloading;
            task.received = 12345;
            task.total = Some(99999);
        });
        // 换一个"新进程"：清内存态再从磁盘恢复。
        {
            let mut state = lock_state();
            state.tasks.clear();
        }
        load_state(&dir);
        let restored = list();
        assert_eq!(restored.len(), 1);
        // Downloading 拉回 Queued：线程已经没了，不能再显示下载中。
        assert_eq!(restored[0].status, DownloadStatus::Queued);
        assert_eq!(restored[0].received, 12345, "进度应保留（断点续传的起点）");
        assert_eq!(restored[0].nxm_key.as_deref(), Some("k"), "免 Key 签名要跟着持久化");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupted_queue_file_is_ignored_not_fatal() {
        let _guard = reset_queue();
        let dir = tmp_dir("corrupt");
        std::fs::write(dir.join(QUEUE_FILE), "{ this is not json").unwrap();
        // 坏文件必须被无视（保持空队列），绝不能 panic 或写回半坏数据。
        load_state(&dir);
        assert!(list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_clamp_and_persist() {
        let _guard = reset_queue();
        let dir = tmp_dir("settings");
        let next = set_settings(
            &dir,
            DownloadQueueSettings {
                concurrency: 99, // 上面会被命令层 clamp，这里验证存储原样
                auto_import: false,
                dir: Some("D://Downloads".into()),
                proxy: Some("http://127.0.0.1:7890".into()),
                speed_limit_mbps: 0,
            },
        );
        assert_eq!(next.concurrency, 99);
        // 重新加载后设置还在。
        {
            let mut state = lock_state();
            state.tasks.clear();
        }
        load_state(&dir);
        assert_eq!(settings().dir.as_deref(), Some("D://Downloads"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 2026-10-30 自检 P1-1 的回归：限流等待期点暂停/取消必须落状态，
    /// 不能被 next-loop 清旗标吞掉（曾经的 continue 路径就是这么丢的）。
    #[test]
    fn interrupted_wait_settles_as_paused_or_cancelled() {
        let _guard = reset_queue();
        let dir = tmp_dir("settle");
        let mut task = add(&dir, 21, 8, Some("M".into()), None, None, None).unwrap();
        task.status = DownloadStatus::Downloading;

        // 等待期点暂停 → Paused，不落 finished_at、不残留 error。
        settle_interrupted(&mut task, false);
        assert_eq!(task.status, DownloadStatus::Paused);
        assert!(task.finished_at.is_none());
        assert!(task.error.is_none());

        // 等待期点取消 → Cancelled + 落完成时间。
        task.finished_at = None;
        settle_interrupted(&mut task, true);
        assert_eq!(task.status, DownloadStatus::Cancelled);
        assert!(task.finished_at.is_some());
        assert!(task.error.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 已被打断的等待必须立刻返回 false（秒级等待不能真的睡满）。
    #[test]
    fn interruptible_sleep_returns_immediately_when_flagged() {
        let flags = TaskFlags::default();
        flags.pause.store(true, Ordering::SeqCst);
        let started = std::time::Instant::now();
        assert!(!sleep_interruptible(&flags, 30));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "旗标已置必须立刻返回，实际等了 {:?}",
            started.elapsed()
        );

        // 取消旗标同理。
        let flags = TaskFlags::default();
        flags.cancel.store(true, Ordering::SeqCst);
        assert!(!sleep_interruptible(&flags, 30));
    }
}
