//! Vortex 状态双写层（接管方案 P1 / P2）。
//!
//! 目标：CyberDeck 作为唯一入口，启用/禁用与加载顺序的改动**直接落到 Vortex 状态库**，
//! 启动 Vortex 时状态已一致，无需在 Vortex 里重复设置。
//!
//! 不可绕过的硬门槛（缺一即拒绝本次变更，且**本地状态也不改**）：
//! 1. 接管开关显式开启（默认关闭）；
//! 2. Vortex 已退出 —— `state.v2` 是独占锁的 LevelDB，运行中打不开；
//! 3. 活动 profile 属于 cyberpunk2077；
//! 4. 模组能按「游戏侧相对路径」精确映射到 Vortex 目录名；
//! 5. 写前快照备份、写后逐键回读校验。
//!
//! 任何镜像失败都必须可见：写进 pending 队列 + 返回带原因的报告，由界面提示重试/还原，
//! 绝不假装成功。所有 DB 操作都接受显式目录参数，单测用临时目录，不碰真实状态库。

use crate::schema::{
    AppResult, CommandError, VortexDriftItem, VortexPrelaunchReport,
    VortexReconcileReport, VortexSyncReport,
};
use crate::store::Store;
use rusty_leveldb::{DB, LdbIterator, Options};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const GAME_ID: &str = "cyberpunk2077";
const KEEP_PREFIXES: [&str; 4] = [
    "settings###profiles###",
    "persistent###profiles###",
    "persistent###loadOrders###",
    "persistent###mods###cyberpunk2077###",
];

pub fn state_dir() -> Option<PathBuf> {
    let roaming = std::env::var_os("APPDATA")?;
    let dir = PathBuf::from(roaming).join("Vortex").join("state.v2");
    dir.is_dir().then_some(dir)
}

fn mirror_root(store: &Store) -> PathBuf {
    store.data_dir.join("vortex-mirror")
}

fn backup_dir(store: &Store) -> PathBuf {
    mirror_root(store).join("backups")
}

fn pending_path(store: &Store) -> PathBuf {
    mirror_root(store).join("pending.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn stamp() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{:04}",
        now_ms(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

fn open_db(dir: &Path, create: bool) -> AppResult<DB> {
    let mut options = Options::default();
    options.create_if_missing = create;
    DB::open(dir, options).map_err(|err| {
        CommandError::new(
            "VORTEX_DB_LOCKED",
            format!("无法以可写方式打开 Vortex 状态库（{err}）。请先完全退出 Vortex 再改模组状态。"),
        )
    })
}

fn read_pairs_from(dir: &Path) -> AppResult<Vec<(String, String)>> {
    let mut db = open_db(dir, false)?;
    let mut iter = db.new_iter().map_err(|err| {
        CommandError::new("VORTEX_DB_READ", format!("遍历 Vortex 状态库失败：{err}"))
    })?;
    iter.seek_to_first();
    let mut out = Vec::new();
    while let Some((key, value)) = iter.next() {
        let Ok(key) = String::from_utf8(key) else { continue };
        if KEEP_PREFIXES.iter().any(|prefix| key.starts_with(prefix)) {
            out.push((key, String::from_utf8_lossy(&value).to_string()));
        }
    }
    Ok(out)
}

/// 纯解析：活动 profile 与 profile 归属（与 `vortex_mirror` 口径一致）。
pub fn active_profile(pairs: &[(String, String)]) -> (String, bool) {
    let declared = pairs
        .iter()
        .find(|(key, _)| key == "settings###profiles###activeProfileId")
        .map(|(_, value)| value.trim().trim_matches('"').to_string())
        .unwrap_or_default();
    let game_ids: HashMap<String, String> = pairs
        .iter()
        .filter_map(|(key, value)| {
            let rest = key.strip_prefix("persistent###profiles###")?;
            let (pid, tail) = rest.split_once("###")?;
            (tail == "gameId").then(|| (pid.to_string(), value.trim().trim_matches('"').to_string()))
        })
        .collect();
    if !declared.is_empty() {
        let ok = game_ids
            .get(&declared)
            .map(|game| game == GAME_ID)
            .unwrap_or(false);
        return (declared, ok);
    }
    // 键缺失时退回「本游戏且最后激活时间最大」的 profile。
    let mut last: HashMap<String, u64> = HashMap::new();
    for (key, value) in pairs {
        if let Some(rest) = key.strip_prefix("persistent###profiles###") {
            if let Some((pid, "lastActivated")) = rest.split_once("###") {
                if let Ok(time) = value.trim().trim_matches('"').parse::<u64>() {
                    last.insert(pid.to_string(), time);
                }
            }
        }
    }
    let mut candidates: Vec<(String, u64)> = game_ids
        .iter()
        .filter(|(_, game)| game.as_str() == GAME_ID)
        .map(|(pid, _)| (pid.clone(), *last.get(pid).unwrap_or(&0)))
        .collect();
    candidates.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    candidates
        .first()
        .map(|(pid, _)| (pid.clone(), true))
        .unwrap_or_default()
}

/// 变更描述。archive/redmod 顺序都是「已排好序的 id 列表」。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChanges {
    /// (Vortex 目录名, 目标启用状态)
    pub enabled: Vec<(String, bool)>,
    /// archive 顺序（Vortex 侧 id = archive 文件名）
    pub archive_order: Option<Vec<String>>,
    /// redmod 顺序（Vortex 侧 id = 安装目录名）
    pub redmod_order: Option<Vec<String>>,
}

impl SyncChanges {
    pub fn is_empty(&self) -> bool {
        self.enabled.is_empty() && self.archive_order.is_none() && self.redmod_order.is_none()
    }
}

fn load_pending(store: &Store) -> Vec<SyncChanges> {
    let path = pending_path(store);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_pending(store: &Store, items: &[SyncChanges]) -> AppResult<()> {
    let dir = mirror_root(store);
    std::fs::create_dir_all(&dir).map_err(|err| {
        CommandError::new("VORTEX_MIRROR_IO", format!("无法创建镜像目录：{err}"))
    })?;
    let raw = serde_json::to_string_pretty(items)
        .map_err(|err| CommandError::new("VORTEX_MIRROR_IO", err.to_string()))?;
    std::fs::write(pending_path(store), raw)
        .map_err(|err| CommandError::new("VORTEX_MIRROR_IO", format!("无法写待同步队列：{err}")))
}

fn queue_pending(store: &Store, changes: &SyncChanges) {
    let mut items = load_pending(store);
    items.push(changes.clone());
    if items.len() > 32 {
        items.remove(0);
    }
    let _ = save_pending(store, &items);
}

/// 写前快照：把全部相关键原样存成 JSON，供一键还原。
fn write_backup(store: &Store, pairs: &[(String, String)]) -> AppResult<PathBuf> {
    let dir = backup_dir(store);
    std::fs::create_dir_all(&dir).map_err(|err| {
        CommandError::new("VORTEX_MIRROR_IO", format!("无法创建备份目录：{err}"))
    })?;
    let path = dir.join(format!("{}.json", stamp()));
    let raw = serde_json::to_string_pretty(pairs)
        .map_err(|err| CommandError::new("VORTEX_MIRROR_IO", err.to_string()))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw)
        .map_err(|err| CommandError::new("VORTEX_MIRROR_IO", format!("写备份失败：{err}")))?;
    std::fs::rename(&temp, &path).map_err(|err| {
        CommandError::new("VORTEX_MIRROR_IO", format!("备份落盘失败：{err}"))
    })?;
    Ok(path)
}

/// 按目标顺序重排 Vortex 的 loadOrder 数组，保留原条目里的一切字段，
/// 本次没出现的 Vortex 条目追加到末尾（绝不丢记录）。
fn reorder_value(raw: &str, wanted: &[String]) -> String {
    let mut items: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap_or_default();
    let mut by_id: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    for item in items.drain(..) {
        let id = item
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        by_id.entry(id).or_default().push(item);
    }
    let mut out = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    for name in wanted {
        let key = name.to_ascii_lowercase();
        if let Some(mut found) = by_id.remove(&key) {
            out.append(&mut found);
            used.insert(key);
        } else {
            out.push(serde_json::json!({ "id": name, "name": name, "enabled": true }));
        }
    }
    for (_key, mut rest) in by_id {
        out.append(&mut rest);
    }
    let _ = used;
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

/// 把变更变成「键 → 值」写入集合。读不到原顺序键时不凭空造，记 warning。
fn build_writes(
    pairs: &[(String, String)],
    pid: &str,
    changes: &SyncChanges,
    warnings: &mut Vec<String>,
) -> Vec<(String, String)> {
    let mut writes = Vec::new();
    let time = now_ms().to_string();
    for (mod_id, enabled) in &changes.enabled {
        let base = format!("persistent###profiles###{pid}###modState###{mod_id}");
        writes.push((format!("{base}###enabled"), enabled.to_string()));
        writes.push((
            format!("{base}###{}", if *enabled { "enabledTime" } else { "disabledTime" }),
            time.clone(),
        ));
    }
    if let Some(order) = &changes.archive_order {
        let key = format!("persistent###loadOrders###{pid}###{GAME_ID}-archive");
        let existing = pairs.iter().find(|(k, _)| k == &key).map(|(_, v)| v.as_str());
        match existing {
            Some(raw) => writes.push((key, reorder_value(raw, order))),
            None => warnings.push("Vortex 里没有 archive 加载顺序记录，已跳过顺序同步。".to_string()),
        }
    }
    if let Some(order) = &changes.redmod_order {
        let key = format!("persistent###loadOrders###{pid}###{GAME_ID}-redmod");
        let existing = pairs.iter().find(|(k, _)| k == &key).map(|(_, v)| v.as_str());
        match existing {
            Some(raw) => writes.push((key, reorder_value(raw, order))),
            None => warnings.push("Vortex 里没有 redmod 加载顺序记录，已跳过顺序同步。".to_string()),
        }
    }
    writes
}

/// 与开关无关的前置校验：状态库可写 + 活动 profile 正确。开启接管的那一刻也要跑。
pub fn precheck(dir: &Path) -> AppResult<()> {
    let pairs = read_pairs_from(dir)?;
    let (pid, ok) = active_profile(&pairs);
    if !ok || pid.is_empty() {
        return Err(CommandError::new(
            "VORTEX_PROFILE_MISMATCH",
            format!("Vortex 活动 profile（{pid}）不属于 {GAME_ID}，为避免写错配置已停止本次变更。请先在 Vortex 里切回赛博朋克 2077 的 profile。"),
        ));
    }
    Ok(())
}

/// 前置守卫：接管关闭时直接放行（保持旧行为完全不变）；开启时任何一条门槛
/// 不满足都在**本地改动之前**返回错误，保证 A6「Vortex 开着时零写入、本地也不改」。
pub fn guard(store: &Store, dir: &Path) -> AppResult<()> {
    if !store.snapshot_data().settings.vortex_takeover {
        return Ok(());
    }
    precheck(dir)
}

fn last_sync_path(store: &Store) -> PathBuf {
    mirror_root(store).join("last-sync.json")
}

/// 最近一次双写结果落盘：顺序类命令的返回结构没有 warnings 字段，界面靠它拿失败原因。
fn record_last(store: &Store, report: &VortexSyncReport) {
    let dir = mirror_root(store);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(raw) = serde_json::to_string_pretty(report) {
        let _ = std::fs::write(last_sync_path(store), raw);
    }
}

pub fn load_last(store: &Store) -> VortexSyncReport {
    std::fs::read_to_string(last_sync_path(store))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 真正的双写。失败时把变更放进 pending 队列，返回带原因的报告（不抛给本地事务）。
pub fn mirror(store: &Store, dir: &Path, changes: &SyncChanges) -> VortexSyncReport {
    let mut report = VortexSyncReport::default();
    if changes.is_empty() {
        return report;
    }
    if !store.snapshot_data().settings.vortex_takeover {
        return report;
    }
    let pairs = match read_pairs_from(dir) {
        Ok(pairs) => pairs,
        Err(err) => {
            report.ok = false;
            report.reason = err.message;
            queue_pending(store, changes);
            record_last(store, &report);
            return report;
        }
    };
    let (pid, ok) = active_profile(&pairs);
    if !ok || pid.is_empty() {
        report.ok = false;
        report.reason = format!("活动 profile（{pid}）校验失败，未写入 Vortex。");
        queue_pending(store, changes);
        record_last(store, &report);
        return report;
    }
    let backup = match write_backup(store, &pairs) {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(err) => {
            report.ok = false;
            report.reason = format!("写前备份失败，已放弃写入：{}", err.message);
            queue_pending(store, changes);
            record_last(store, &report);
            return report;
        }
    };
    report.backup = backup;

    let writes = build_writes(&pairs, &pid, changes, &mut report.warnings);
    if writes.is_empty() {
        report.warnings.push("没有可写入的 Vortex 键，已跳过。".to_string());
        record_last(store, &report);
        return report;
    }
    let result = (|| -> AppResult<()> {
        let mut db = open_db(dir, false)?;
        for (key, value) in &writes {
            db.put(key.as_bytes(), value.as_bytes()).map_err(|err| {
                CommandError::new("VORTEX_DB_WRITE", format!("写入 {key} 失败：{err}"))
            })?;
        }
        db.flush()
            .map_err(|err| CommandError::new("VORTEX_DB_WRITE", format!("刷新状态库失败：{err}")))?;
        // 逐键回读校验：写进去不等于 Vortex 认得，形状错了要当场发现。
        for (key, value) in &writes {
            let got = db.get(key.as_bytes()).ok_or_else(|| {
                CommandError::new("VORTEX_DB_VERIFY", format!("回读不到 {key}"))
            })?;
            if String::from_utf8_lossy(&got) != *value {
                return Err(CommandError::new(
                    "VORTEX_DB_VERIFY",
                    format!("回读值与预期不一致：{key}"),
                ));
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            report.ok = true;
            report.written = writes.len();
            report.warnings.push(format!("已同步 {} 个键到 Vortex 状态库，回读校验通过。", writes.len()));
        }
        Err(err) => {
            report.ok = false;
            report.reason = err.message;
            queue_pending(store, changes);
        }
    }
    record_last(store, &report);
    report
}

/// 把 CyberDeck 的启用状态与顺序翻译成 Vortex 键段（纯函数，便于单测）。
pub fn changes_for_enabled(mapping: &HashMap<String, String>, ids: &[String], enabled: bool) -> SyncChanges {
    let mut out = SyncChanges::default();
    let mut seen = HashSet::new();
    for id in ids {
        if let Some(vortex_id) = mapping.get(id) {
            if seen.insert(vortex_id.clone()) {
                out.enabled.push((vortex_id.clone(), enabled));
            }
        }
    }
    out
}

pub fn changes_for_archive_order(order: &[String]) -> SyncChanges {
    let mut out = SyncChanges::default();
    out.archive_order = Some(
        order
            .iter()
            .map(|rel| rel.rsplit('/').next().unwrap_or(rel).to_string())
            .collect(),
    );
    out
}

pub fn changes_for_redmod_order(mapping: &HashMap<String, String>, order: &[String]) -> SyncChanges {
    let mut out = SyncChanges::default();
    out.redmod_order = Some(
        order
            .iter()
            .filter_map(|id| mapping.get(id).cloned())
            .collect(),
    );
    out
}

/// 重试所有待同步变更。
pub fn retry_pending(store: &Store, dir: &Path) -> VortexSyncReport {
    let items = load_pending(store);
    if items.is_empty() {
        return VortexSyncReport {
            ok: true,
            warnings: vec!["没有待同步的变更。".to_string()],
            ..Default::default()
        };
    }
    let mut merged = SyncChanges::default();
    for item in &items {
        merged.enabled.extend(item.enabled.iter().cloned());
        if item.archive_order.is_some() {
            merged.archive_order = item.archive_order.clone();
        }
        if item.redmod_order.is_some() {
            merged.redmod_order = item.redmod_order.clone();
        }
    }
    let report = mirror(store, dir, &merged);
    if report.ok {
        let _ = save_pending(store, &[]);
    }
    report
}

/// 列出备份文件名（按时间倒序）。
pub fn list_backups(store: &Store) -> Vec<String> {
    let dir = backup_dir(store);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|v| v.to_str()) == Some("json"))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    out.sort();
    out.reverse();
    out
}

/// 一键还原：把快照里的键原样写回状态库（Vortex 必须已退出）。
pub fn restore(store: &Store, dir: &Path, name: &str) -> AppResult<usize> {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(CommandError::new("VORTEX_BACKUP_NAME", "备份文件名不合法。"));
    }
    let path = backup_dir(store).join(name);
    let raw = std::fs::read_to_string(&path).map_err(|err| {
        CommandError::new("VORTEX_BACKUP_READ", format!("读备份失败：{err}"))
    })?;
    let pairs: Vec<(String, String)> = serde_json::from_str(&raw).map_err(|err| {
        CommandError::new("VORTEX_BACKUP_READ", format!("备份内容无法解析：{err}"))
    })?;
    let mut db = open_db(dir, false)?;
    for (key, value) in &pairs {
        db.put(key.as_bytes(), value.as_bytes()).map_err(|err| {
            CommandError::new("VORTEX_DB_WRITE", format!("还原 {key} 失败：{err}"))
        })?;
    }
    db.flush()
        .map_err(|err| CommandError::new("VORTEX_DB_WRITE", format!("刷新状态库失败：{err}")))?;
    Ok(pairs.len())
}

pub fn pending_count(store: &Store) -> usize {
    load_pending(store).len()
}

// ── P3：全库批量 / 漂移对账 / 切换前预检 ─────────────────────────────

/// 把库内所有可配准模组的启用状态与两套加载顺序合成一次全量变更。
/// 播放集切换、批量启停、Mod 更新后重做都走这里。
pub fn full_changes(store: &Store) -> SyncChanges {
    let data = store.snapshot_data();
    let root = data.game_dir.as_ref().map(PathBuf::from).unwrap_or_default();
    let mapping = crate::vortex_mirror::build_mapping(&data, &root);
    let mut merged: HashMap<String, bool> = HashMap::new();
    for entry in &data.mods {
        if let Some(vortex_id) = mapping.get(&entry.id) {
            // 多个启动器碎片条目可能指向同一个 Vortex 目录：任一启用即视为启用。
            let slot = merged.entry(vortex_id.clone()).or_insert(false);
            *slot |= entry.enabled;
        }
    }
    let mut out = SyncChanges {
        enabled: merged.into_iter().collect(),
        ..Default::default()
    };
    out.archive_order = Some(
        data.load_order
            .iter()
            .map(|rel| rel.rsplit('/').next().unwrap_or(rel).to_string())
            .collect(),
    );
    out.redmod_order = Some(
        data.redmod_order
            .iter()
            .filter_map(|id| mapping.get(id).cloned())
            .collect(),
    );
    out
}

/// 读 Vortex 里每个 modState 的 enabled 值（按活动 profile）。
fn vortex_enabled_map(pairs: &[(String, String)], pid: &str) -> HashMap<String, bool> {
    let prefix = format!("persistent###profiles###{pid}###modState###");
    let mut out = HashMap::new();
    for (key, value) in pairs {
        if let Some(rest) = key.strip_prefix(&prefix) {
            if let Some(mod_id) = rest.strip_suffix("###enabled") {
                out.insert(mod_id.to_string(), plain_enabled(value));
            }
        }
    }
    out
}

fn plain_enabled(raw: &str) -> bool {
    raw.trim().trim_matches('"').eq_ignore_ascii_case("true")
}

/// 漂移对账。strategy：
/// - `report`：只列差异，零写入（默认、最安全）；
/// - `cyberdeck`：以启动器为准，把全量状态写进 Vortex；
/// - `vortex`：只把 Vortex 的 enabled 值写回启动器状态标记（**不重新部署**）。
pub fn reconcile(store: &Store, dir: &Path, strategy: &str) -> VortexReconcileReport {
    let mut report = VortexReconcileReport {
        strategy: strategy.to_string(),
        ..Default::default()
    };
    if !matches!(strategy, "report" | "cyberdeck" | "vortex") {
        report
            .warnings
            .push("未知对账策略，已按 report 处理。".to_string());
        return report;
    }
    let pairs = match read_pairs_from(dir) {
        Ok(pairs) => pairs,
        Err(err) => {
            report
                .warnings
                .push(format!("读不到 Vortex 状态库：{}", err.message));
            return report;
        }
    };
    let (pid, ok) = active_profile(&pairs);
    if !ok || pid.is_empty() {
        report
            .warnings
            .push("活动 profile 校验失败，未做对账。".to_string());
        return report;
    }
    let enabled = vortex_enabled_map(&pairs, &pid);
    let data = store.snapshot_data();
    let root = data.game_dir.as_ref().map(PathBuf::from).unwrap_or_default();
    let mapping = crate::vortex_mirror::build_mapping(&data, &root);
    for entry in &data.mods {
        let Some(vortex_id) = mapping.get(&entry.id) else {
            continue;
        };
        report.checked += 1;
        let vortex_value = enabled.get(vortex_id).copied();
        if vortex_value != Some(entry.enabled) {
            report.drift.push(VortexDriftItem {
                mod_id: entry.id.clone(),
                name: entry.name.clone(),
                vortex_mod_id: vortex_id.clone(),
                cyberdeck_enabled: entry.enabled,
                vortex_enabled: vortex_value,
                kind: if vortex_value.is_none() {
                    "vortexMissing".to_string()
                } else {
                    "enabledMismatch".to_string()
                },
            });
        }
    }
    match strategy {
        "cyberdeck" => {
            let result = mirror(store, dir, &full_changes(store));
            if result.ok {
                report.applied = result.written;
            } else {
                report
                    .warnings
                    .push(format!("以启动器为准覆盖失败：{}", result.reason));
            }
        }
        "vortex" => {
            let mut guard = store.data.lock().expect("state mutex poisoned");
            for entry in guard.mods.iter_mut() {
                if let Some(vortex_id) = mapping.get(&entry.id) {
                    if let Some(value) = enabled.get(vortex_id) {
                        if entry.enabled != *value {
                            entry.enabled = *value;
                            report.applied += 1;
                        }
                    }
                }
            }
            if report.applied > 0 {
                if let Err(err) = store.save(&guard) {
                    report
                        .warnings
                        .push(format!("回写启动器状态失败：{}", err.message));
                }
            }
            report.warnings.push(
                "反向同步只改启用标记，未重新部署；请回到模组库执行一次部署使文件与状态一致。"
                    .to_string(),
            );
        }
        _ => {}
    }
    report
}

/// 把控制权交还 Vortex 之前的一致性预检。
/// ready=false 时不要启动 Vortex，否则 Vortex 可能按旧状态重新部署。
pub fn prelaunch_check(store: &Store, dir: &Path) -> VortexPrelaunchReport {
    let data = store.snapshot_data();
    let mut report = VortexPrelaunchReport {
        takeover_enabled: data.settings.vortex_takeover,
        pending_count: pending_count(store),
        ..Default::default()
    };
    if read_pairs_from(dir).is_err() {
        report.db_locked = true;
        report
            .warnings
            .push("读不到 Vortex 状态库（Vortex 可能正在运行）。".to_string());
        return report;
    }
    let drift = reconcile(store, dir, "report");
    report.drift_count = drift.drift.len();
    if !report.takeover_enabled {
        report
            .warnings
            .push("接管未开启，Vortex 状态可能与启动器不一致。".to_string());
    }
    if report.pending_count > 0 {
        report.warnings.push(format!(
            "还有 {} 项待同步变更，先在同步状态里重试。",
            report.pending_count
        ));
    }
    if report.drift_count > 0 {
        report.warnings.push(format!(
            "检测到 {} 项启用状态漂移，先做一次对账。",
            report.drift_count
        ));
    }
    report.ready = report.takeover_enabled
        && !report.db_locked
        && report.pending_count == 0
        && report.drift_count == 0;
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-vortex-sync-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::load(root.join("data")).unwrap();
        (root, store)
    }

    fn db_dir(root: &Path) -> PathBuf {
        let dir = root.join("state.v2");
        {
            let mut options = Options::default();
            options.create_if_missing = true;
            let mut db = DB::open(&dir, options).unwrap();
            db.put(
                b"settings###profiles###activeProfileId",
                b"\"tHYlht6Mz\"",
            )
            .unwrap();
            db.put(
                b"persistent###profiles###tHYlht6Mz###gameId",
                b"\"cyberpunk2077\"",
            )
            .unwrap();
            db.put(
                b"persistent###profiles###tHYlht6Mz###modState###demo-1###enabled",
                b"true",
            )
            .unwrap();
            db.put(
                b"persistent###loadOrders###tHYlht6Mz###cyberpunk2077-archive",
                br#"[{"id":"a.archive","name":"a.archive","enabled":true},{"id":"b.archive","name":"b.archive","enabled":true}]"#,
            )
            .unwrap();
            db.flush().unwrap();
        }
        dir
    }

    fn enable_takeover(store: &Store) {
        let mut guard = store.data.lock().unwrap();
        guard.settings.vortex_takeover = true;
    }

    #[test]
    fn mirror_writes_enabled_and_verifies_readback() {
        let (root, store) = temp("write");
        let dir = db_dir(&root);
        enable_takeover(&store);
        let changes = SyncChanges {
            enabled: vec![("demo-1".to_string(), false)],
            ..Default::default()
        };
        let report = mirror(&store, &dir, &changes);
        assert!(report.ok, "{}", report.reason);
        assert_eq!(report.written, 2); // enabled + disabledTime
        assert!(!report.backup.is_empty());

        let pairs = read_pairs_from(&dir).unwrap();
        let value = pairs
            .iter()
            .find(|(key, _)| key.ends_with("demo-1###enabled"))
            .map(|(_, value)| value.clone())
            .unwrap();
        assert_eq!(value, "false");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reorder_keeps_unknown_vortex_entries_and_preserves_fields() {
        let raw = r#"[{"id":"a.archive","name":"A","enabled":true,"modId":"12"},{"id":"b.archive","name":"B","enabled":true}]"#;
        let out = reorder_value(raw, &["b.archive".to_string()]);
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        let list = value.as_array().unwrap();
        assert_eq!(list[0]["id"], "b.archive");
        assert_eq!(list[1]["id"], "a.archive");
        assert_eq!(list[1]["modId"], "12");
    }

    #[test]
    fn guard_blocks_when_profile_is_not_our_game() {
        let (root, store) = temp("profile");
        let dir = db_dir(&root);
        enable_takeover(&store);
        assert!(guard(&store, &dir).is_ok());
        {
            let mut db = open_db(&dir, false).unwrap();
            db.put(
                b"persistent###profiles###tHYlht6Mz###gameId",
                b"\"stardewvalley\"",
            )
            .unwrap();
            db.flush().unwrap();
        }
        let err = guard(&store, &dir).unwrap_err();
        assert_eq!(err.code, "VORTEX_PROFILE_MISMATCH");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_puts_back_the_snapshot() {
        let (root, store) = temp("restore");
        let dir = db_dir(&root);
        enable_takeover(&store);
        let changes = SyncChanges {
            enabled: vec![("demo-1".to_string(), false)],
            ..Default::default()
        };
        let report = mirror(&store, &dir, &changes);
        assert!(report.ok, "{}", report.reason);
        let name = PathBuf::from(&report.backup)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let count = restore(&store, &dir, &name).unwrap();
        assert!(count > 0, "备份至少要有键");
        let pairs = read_pairs_from(&dir).unwrap();
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key.ends_with("demo-1###enabled"))
                .unwrap()
                .1,
            "true"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn takeover_off_keeps_old_behaviour_and_queues_nothing() {
        let (root, store) = temp("off");
        let dir = db_dir(&root);
        assert!(guard(&store, &dir).is_ok());
        let report = mirror(
            &store,
            &dir,
            &SyncChanges {
                enabled: vec![("demo-1".to_string(), false)],
                ..Default::default()
            },
        );
        assert!(!report.ok);
        assert_eq!(pending_count(&store), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn active_profile_falls_back_to_last_activated() {
        let pairs = vec![
            (
                "persistent###profiles###p1###gameId".to_string(),
                "\"cyberpunk2077\"".to_string(),
            ),
            (
                "persistent###profiles###p1###lastActivated".to_string(),
                "100".to_string(),
            ),
            (
                "persistent###profiles###p2###gameId".to_string(),
                "\"cyberpunk2077\"".to_string(),
            ),
            (
                "persistent###profiles###p2###lastActivated".to_string(),
                "200".to_string(),
            ),
        ];
        assert_eq!(active_profile(&pairs), ("p2".to_string(), true));
    }

    #[test]
    fn vortex_enabled_map_reads_only_active_profile() {
        let pairs = vec![
            (
                "persistent###profiles###tHYlht6Mz###modState###foo-1###enabled".to_string(),
                "true".to_string(),
            ),
            (
                "persistent###profiles###tHYlht6Mz###modState###bar-2###enabled".to_string(),
                "false".to_string(),
            ),
            (
                "persistent###profiles###other###modState###foo-1###enabled".to_string(),
                "false".to_string(),
            ),
        ];
        let map = vortex_enabled_map(&pairs, "tHYlht6Mz");
        assert_eq!(map.len(), 2);
        assert_eq!(map["foo-1"], true);
        assert_eq!(map["bar-2"], false);
    }

    #[test]
    fn full_changes_keeps_archive_order_without_needing_mapping() {
        let (root, store) = temp("full");
        {
            let mut guard = store.data.lock().unwrap();
            guard.load_order = vec![
                "archive/pc/mod/a.archive".to_string(),
                "archive/pc/mod/b.archive".to_string(),
            ];
        }
        let changes = full_changes(&store);
        assert_eq!(
            changes.archive_order.unwrap(),
            vec!["a.archive".to_string(), "b.archive".to_string()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reconcile_report_is_read_only_and_prelaunch_is_not_ready() {
        let (root, store) = temp("reconcile");
        let dir = db_dir(&root);
        let report = reconcile(&store, &dir, "report");
        assert_eq!(report.strategy, "report");
        assert_eq!(report.applied, 0);
        assert!(report.checked == 0, "空库不应凭空配准出模组");

        let pre = prelaunch_check(&store, &dir);
        assert!(!pre.ready, "接管未开启时不应放行");
        assert!(!pre.warnings.is_empty());
        let pairs = read_pairs_from(&dir).unwrap();
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key.ends_with("demo-1###enabled"))
                .unwrap()
                .1,
            "true",
            "report 策略绝不能写状态库"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

}
