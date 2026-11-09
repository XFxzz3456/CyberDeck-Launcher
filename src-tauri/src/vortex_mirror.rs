//! Vortex 状态取证层（接管方案 P0，**纯只读**）。
//!
//! 目标是把「Vortex 里现在到底记了什么」变成启动器看得懂的报告：活动 profile、
//! 每个模组的启用状态、archive / redmod 加载顺序、以及它们与启动器自身状态的差异。
//!
//! 硬约束：
//! - 这里**绝不写** LevelDB，也绝不删除任何文件；写入留给 P1，且必须在 Vortex
//!   已退出、profile 校验通过、写前备份之后才允许。
//! - Vortex 运行时对 `state.v2` 加独占锁，`DB::open` 会失败。失败不当成崩溃，
//!   而是回一份 `available=false / dbLocked=true` 的报告，界面明确告诉用户原因。
//! - 状态键是 Vortex `persistDiffMiddleware` 拍平出来的 `###` 形式，版本升级可能
//!   改形状；解析一律走「读不到就记 warning、绝不猜」的路径。

use crate::schema::{
    AdoptStagingHealth, AppResult, CommandError, VortexDriftItem, VortexTakeoverPreflight,
};
use crate::store::Store;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

const GAME_ID: &str = "cyberpunk2077";

fn state_dir() -> Option<PathBuf> {
    let roaming = std::env::var_os("APPDATA")?;
    let dir = PathBuf::from(roaming).join("Vortex").join("state.v2");
    dir.is_dir().then_some(dir)
}

/// 只读打开状态库，取回与接管相关的键值。
///
/// 只收四类前缀，避免把整个 mods 元数据与部署清单都拉进内存；仍然是只读打开
/// （`create_if_missing=false`），Vortex 正在运行时会返回 `VORTEX_DB_LOCKED`。
/// `core-tests` 是 headless 测试 crate，不拉 LevelDB 依赖，所以真实读取只在
/// 生产构建里编译；测试构建直接回「状态库不可读」，纯解析逻辑仍可单测。
#[cfg(not(test))]
pub fn read_pairs() -> AppResult<Vec<(String, String)>> {
    use rusty_leveldb::{DB, LdbIterator, Options};
    let dir = state_dir().ok_or_else(|| {
        CommandError::new(
            "VORTEX_NOT_FOUND",
            "没找到 Vortex 的数据目录（%APPDATA%\\Vortex\\state.v2）。",
        )
    })?;
    let mut options = Options::default();
    options.create_if_missing = false;
    let mut db = DB::open(&dir, options).map_err(|err| {
        CommandError::new(
            "VORTEX_DB_LOCKED",
            format!("读取 Vortex 状态库失败（{err}）。请先完全退出 Vortex 再体检。"),
        )
    })?;
    let mut iter = db.new_iter().map_err(|err| {
        CommandError::new("VORTEX_DB_READ", format!("遍历 Vortex 状态库失败：{err}"))
    })?;
    iter.seek_to_first();
    let mut out = Vec::new();
    while let Some((key, value)) = iter.next() {
        let Ok(key) = String::from_utf8(key) else { continue };
        let keep = key.starts_with("settings###profiles###")
            || key.starts_with("persistent###profiles###")
            || key.starts_with("persistent###loadOrders###")
            || key.starts_with("persistent###mods###cyberpunk2077###");
        if keep {
            out.push((key, String::from_utf8_lossy(&value).to_string()));
        }
    }
    Ok(out)
}

#[cfg(test)]
pub fn read_pairs() -> AppResult<Vec<(String, String)>> {
    Err(CommandError::new(
        "VORTEX_DB_LOCKED",
        "测试构建不访问真实 Vortex 状态库。",
    ))
}

/// 拍平键解析后的中间态。按 profile 分组，避免把别的游戏的记录混进来。
#[derive(Debug, Default, Clone)]
pub struct ParsedVortexState {
    pub active_profile_id: String,
    pub profile_game_ids: HashMap<String, String>,
    pub profile_last_activated: HashMap<String, u64>,
    /// profileId → (模组目录名 → enabled)
    pub mod_states: HashMap<String, HashMap<String, bool>>,
    pub archive_orders: HashMap<String, Vec<String>>,
    pub redmod_orders: HashMap<String, Vec<String>>,
    pub mod_dirs: HashSet<String>,
    pub warnings: Vec<String>,
}

/// Vortex 把值写成 JSON 字面量，字符串会带双引号。
fn plain(value: &str) -> String {
    value.trim().trim_matches('"').trim().to_string()
}

fn order_ids(raw: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let list = value.as_array()?;
    Some(
        list.iter()
            .filter_map(|item| item.get("id").and_then(|id| id.as_str()).map(str::to_string))
            .collect(),
    )
}

/// 纯函数：把 LevelDB 键值拍平表解析成中间态，方便脱离真实数据库做单测。
pub fn parse_pairs(pairs: &[(String, String)]) -> ParsedVortexState {
    let mut out = ParsedVortexState::default();
    for (key, raw) in pairs {
        if let Some(tail) = key.strip_prefix("settings###profiles###") {
            if tail == "activeProfileId" {
                out.active_profile_id = plain(raw);
            }
            continue;
        }
        if let Some(rest) = key.strip_prefix("persistent###profiles###") {
            let Some((pid, tail)) = rest.split_once("###") else {
                continue;
            };
            if tail == "gameId" {
                out.profile_game_ids.insert(pid.to_string(), plain(raw));
            } else if tail == "lastActivated" {
                if let Ok(stamp) = plain(raw).parse::<u64>() {
                    out.profile_last_activated.insert(pid.to_string(), stamp);
                }
            } else if let Some(mid) = tail.strip_prefix("modState###") {
                // 目录名里可能带 `#`，所以从尾部剥 `###enabled`，而不是按分段下标取。
                if let Some(mod_id) = mid.strip_suffix("###enabled") {
                    let enabled = plain(raw).eq_ignore_ascii_case("true");
                    out.mod_states
                        .entry(pid.to_string())
                        .or_default()
                        .insert(mod_id.to_string(), enabled);
                }
            }
            continue;
        }
        if let Some(rest) = key.strip_prefix("persistent###loadOrders###") {
            let Some((pid, kind)) = rest.split_once("###") else {
                continue;
            };
            let parsed = order_ids(raw);
            match kind {
                "cyberpunk2077-archive" => {
                    match parsed {
                        Some(ids) => {
                            out.archive_orders.insert(pid.to_string(), ids);
                        }
                        None => out
                            .warnings
                            .push("Vortex 的 archive 加载顺序无法解析，已跳过。".to_string()),
                    }
                }
                "cyberpunk2077-redmod" => {
                    match parsed {
                        Some(ids) => {
                            out.redmod_orders.insert(pid.to_string(), ids);
                        }
                        None => out
                            .warnings
                            .push("Vortex 的 redmod 加载顺序无法解析，已跳过。".to_string()),
                    }
                }
                _ => {}
            }
            continue;
        }
        if let Some(rest) = key.strip_prefix("persistent###mods###cyberpunk2077###") {
            if let Some((dir_name, _field)) = rest.split_once("###") {
                out.mod_dirs.insert(dir_name.to_string());
            }
        }
    }
    out
}

fn fnv1a64(data: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 状态指纹：P1 写入前后比对用；P0 只展示，不落盘。
pub fn fingerprint(parsed: &ParsedVortexState, pid: &str) -> String {
    let mut states: Vec<(&String, &bool)> = parsed
        .mod_states
        .get(pid)
        .map(|map| map.iter().collect())
        .unwrap_or_default();
    states.sort_by(|left, right| left.0.cmp(right.0));
    let blob = format!(
        "{:?}|{:?}|{:?}",
        states,
        parsed.archive_orders.get(pid),
        parsed.redmod_orders.get(pid)
    );
    format!("{:016x}", fnv1a64(&blob))
}

/// 选活动 profile：优先 Vortex 自己记的 activeProfileId，键缺失时退回「本游戏
/// 且最后激活时间最大」的 profile。绝不因为读不到就随便挑一个写回去。
fn choose_profile(parsed: &ParsedVortexState) -> String {
    let declared = &parsed.active_profile_id;
    let belongs = |pid: &str| -> bool {
        parsed
            .profile_game_ids
            .get(pid)
            .map(|game| game == GAME_ID)
            .unwrap_or(false)
    };
    if !declared.is_empty() && (belongs(declared) || parsed.mod_states.contains_key(declared)) {
        return declared.clone();
    }
    let mut candidates: Vec<(&String, u64)> = parsed
        .mod_states
        .keys()
        .chain(parsed.archive_orders.keys())
        .collect::<HashSet<_>>()
        .into_iter()
        .filter(|pid| belongs(pid) || parsed.archive_orders.contains_key(*pid))
        .map(|pid| (pid, *parsed.profile_last_activated.get(pid).unwrap_or(&0)))
        .collect();
    candidates.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(right.0)));
    candidates
        .first()
        .map(|(pid, _)| (*pid).clone())
        .unwrap_or_default()
}

/// 只读体检报告。任何一步读不到都转成 warning，不抛异常、不写盘。
pub fn preflight(store: &Store) -> AppResult<VortexTakeoverPreflight> {
    let mut report = VortexTakeoverPreflight::default();
    report.state_dir = state_dir()
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_default();

    let pairs = match read_pairs() {
        Ok(pairs) => pairs,
        Err(err) => {
            report.db_locked = err.code == "VORTEX_DB_LOCKED";
            report.reason = err.message;
            report
                .warnings
                .push("体检只读：未写入 Vortex 状态库、未删除任何文件。".to_string());
            return Ok(report);
        }
    };
    report.available = true;
    let parsed = parse_pairs(&pairs);
    report.warnings.extend(parsed.warnings.clone());

    let pid = choose_profile(&parsed);
    report.active_profile_id = pid.clone();
    report.profile_game_id = parsed
        .profile_game_ids
        .get(&pid)
        .cloned()
        .unwrap_or_default();
    report.profile_ok = report.profile_game_id == GAME_ID;
    if !report.profile_ok {
        report.warnings.push(format!(
            "活动 profile {} 不是 {}（读到 {}），P1 写入会被拒绝。",
            pid, GAME_ID, report.profile_game_id
        ));
    }

    let states = parsed.mod_states.get(&pid);
    if let Some(states) = states {
        report.vortex_mod_count = states.len();
        report.vortex_enabled_count = states.values().filter(|value| **value).count();
        report.vortex_disabled_count = states.len() - report.vortex_enabled_count;
    }
    report.archive_order = parsed.archive_orders.get(&pid).cloned().unwrap_or_default();
    report.redmod_order = parsed.redmod_orders.get(&pid).cloned().unwrap_or_default();
    report.fingerprint = fingerprint(&parsed, &pid);

    let data = store.snapshot_data();
    let game_root = data
        .game_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_default();
    let mapping = build_mapping(&data, &game_root);
    report.mapped_mod_count = mapping.len();
    report.unmapped_mod_count = data.mods.len().saturating_sub(mapping.len());
    if report.unmapped_mod_count > 0 {
        report.warnings.push(format!(
            "{} 个库内模组无法精确映射到 Vortex 目录（可能已禁用或纯本地），P1 不会同步它们。",
            report.unmapped_mod_count
        ));
    }

    for entry in &data.mods {
        let Some(vortex_id) = mapping.get(&entry.id) else {
            continue;
        };
        let vortex_enabled = states.and_then(|map| map.get(vortex_id)).copied();
        let mismatched = vortex_enabled
            .map(|value| value != entry.enabled)
            .unwrap_or(true);
        if mismatched {
            report.drift.push(VortexDriftItem {
                mod_id: entry.id.clone(),
                name: entry.name.clone(),
                vortex_mod_id: vortex_id.clone(),
                cyberdeck_enabled: entry.enabled,
                vortex_enabled,
                kind: if vortex_enabled.is_none() {
                    "vortexMissing".to_string()
                } else {
                    "enabledMismatch".to_string()
                },
            });
        }
    }
    report.drift.sort_by(|left, right| left.name.cmp(&right.name));

    report.archive_order_same = order_consistent(&data.load_order, &report.archive_order);
    if !report.archive_order_same {
        report
            .warnings
            .push("启动器与 Vortex 的 archive 加载顺序不一致。".to_string());
    }
    if !report.drift.is_empty() {
        report.warnings.push(format!(
            "检测到 {} 项启用状态漂移；默认只告警，不自动覆盖任何一侧。",
            report.drift.len()
        ));
    }
    report
        .warnings
        .push("体检只读：未写入 Vortex 状态库、未删除任何文件。".to_string());
    Ok(report)
}

/// 按「游戏侧相对路径」精确配准 Vortex 目录，不做名称模糊匹配。
///
/// 一个 Vortex mod 目录就是游戏根镜像；同一个 rel 只可能属于一个目录。
/// 禁用中的 mod 文件已不在游戏目录，scan_dirs 看不到它，因此会落在 unmapped——
/// 这是保守但正确的结果，不会误把改动写到别的模组头上。
pub fn build_mapping(
    data: &crate::schema::AppStateData,
    game_root: &std::path::Path,
) -> HashMap<String, String> {
    let mut owner_of: HashMap<String, String> = HashMap::new();
    let Some(root) = crate::vortex_source::find_mods_root(GAME_ID) else {
        return owner_of;
    };
    if !game_root.is_dir() {
        return owner_of;
    }
    for dir in crate::vortex_source::scan_dirs(&root, game_root) {
        for rel in &dir.files {
            owner_of.insert(rel.to_ascii_lowercase(), dir.dir_name.clone());
        }
    }

    let mut mapping = HashMap::new();
    for entry in &data.mods {
        let mut votes: HashMap<String, usize> = HashMap::new();
        for file in &entry.deployed_files {
            if let Some(dir_name) = owner_of.get(&file.relative_path.to_ascii_lowercase()) {
                *votes.entry(dir_name.clone()).or_default() += 1;
            }
        }
        if let Some((dir_name, _)) = votes.into_iter().max_by_key(|(_, count)| *count) {
            mapping.insert(entry.id.clone(), dir_name);
        }
    }
    mapping
}

/// 两边顺序一致性：只比较交集，按各自出现顺序比对；任一为空视为无法比较（true）。
fn order_consistent(local: &[String], vortex: &[String]) -> bool {
    let local_names: Vec<String> = local
        .iter()
        .map(|rel| {
            rel.rsplit('/')
                .next()
                .unwrap_or(rel)
                .to_ascii_lowercase()
        })
        .collect();
    let vortex_lower: Vec<String> = vortex.iter().map(|id| id.to_ascii_lowercase()).collect();
    let set: HashSet<&str> = vortex_lower.iter().map(String::as_str).collect();
    let left: Vec<&str> = local_names
        .iter()
        .map(String::as_str)
        .filter(|name| set.contains(name))
        .collect();
    let local_set: HashSet<&str> = local_names.iter().map(String::as_str).collect();
    let right: Vec<&str> = vortex_lower
        .iter()
        .map(String::as_str)
        .filter(|id| local_set.contains(id))
        .collect();
    left.is_empty() || right.is_empty() || left == right
}

/// 暂存区体检（**只读**）：列出孤儿目录与已登记但缺失的目录，绝不删除。
pub fn staging_health(store: &Store) -> AppResult<AdoptStagingHealth> {
    let data = store.snapshot_data();
    let base = store.staging_dir();
    let registered: HashSet<String> = data.mods.iter().map(|entry| entry.id.clone()).collect();
    // 目录名不一定等于 mod id：历史收编把 `deployed_files[].source` 指向旧 id
    // 目录，后来条目被合并/重建，id 变了但部署源没变。只按 id 判孤儿会把
    // 仍在使用的暂存目录误报成垃圾（2026-11-09 现场 44 个里有 18 个属于此类）。
    let mut in_use = registered.clone();
    for entry in &data.mods {
        if let Some(name) = staging_child(&base, &entry.staging_path) {
            in_use.insert(name);
        }
        for file in &entry.deployed_files {
            if let Some(name) = staging_child(&base, &file.source) {
                in_use.insert(name);
            }
        }
    }
    let mut health = AdoptStagingHealth {
        staging_dir: base.to_string_lossy().to_string(),
        registered_total: registered.len(),
        ..Default::default()
    };
    if !base.is_dir() {
        health
            .warnings
            .push("暂存目录不存在，无法体检。".to_string());
        return Ok(health);
    }
    let entries = fs_read_dir(&base)?;
    for (name, path) in entries {
        health.dirs_total += 1;
        if !in_use.contains(&name) {
            health.orphan_bytes += dir_size(&path);
            health.orphan_dirs.push(name);
        }
    }
    health.missing_dirs = registered
        .iter()
        .filter(|id| !base.join(id).is_dir())
        .cloned()
        .collect();
    health.orphan_dirs.sort();
    health.missing_dirs.sort();
    if !health.orphan_dirs.is_empty() {
        health.warnings.push(format!(
            "发现 {} 个孤儿暂存目录（不属于任何库内模组）。体检不删除，需你确认后再处理。",
            health.orphan_dirs.len()
        ));
    }
    if !health.missing_dirs.is_empty() {
        health.warnings.push(format!(
            "{} 个已登记模组的暂存目录缺失，禁用/卸载可能受影响。",
            health.missing_dirs.len()
        ));
    }
    health
        .warnings
        .push("体检只读：未删除、未移动、未改写任何文件。".to_string());
    Ok(health)
}

/// 从绝对路径里取出「暂存区下第一层目录名」。路径不在暂存区就返回 None。
fn staging_child(base: &std::path::Path, raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let path = std::path::Path::new(raw);
    let rel = path.strip_prefix(base).ok()?;
    rel.components()
        .next()
        .map(|part| part.as_os_str().to_string_lossy().to_string())
}

fn fs_read_dir(base: &std::path::Path) -> AppResult<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let entries = std::fs::read_dir(base).map_err(|err| {
        CommandError::new("STAGING_HEALTH_READ", format!("无法读取暂存目录：{err}"))
    })?;
    for entry in entries.flatten() {
        let is_dir = entry
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false);
        if is_dir {
            out.push((
                entry.file_name().to_string_lossy().to_string(),
                entry.path(),
            ));
        }
    }
    Ok(out)
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return total;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            total += dir_size(&entry.path());
        } else if kind.is_file() {
            total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs() -> Vec<(String, String)> {
        vec![
            (
                "settings###profiles###activeProfileId".to_string(),
                "\"tHYlht6Mz\"".to_string(),
            ),
            (
                "persistent###profiles###tHYlht6Mz###gameId".to_string(),
                "\"cyberpunk2077\"".to_string(),
            ),
            (
                "persistent###profiles###tHYlht6Mz###lastActivated".to_string(),
                "1793971145999".to_string(),
            ),
            (
                "persistent###profiles###other###gameId".to_string(),
                "\"stardewvalley\"".to_string(),
            ),
            (
                "persistent###profiles###tHYlht6Mz###modState###foo.archive-1###enabled"
                    .to_string(),
                "true".to_string(),
            ),
            (
                "persistent###profiles###tHYlht6Mz###modState###bar.archive-2###enabled"
                    .to_string(),
                "false".to_string(),
            ),
            (
                "persistent###profiles###other###modState###stardew-1###enabled".to_string(),
                "true".to_string(),
            ),
            (
                "persistent###loadOrders###tHYlht6Mz###cyberpunk2077-archive".to_string(),
                r#"[{"id":"foo.archive","enabled":true},{"id":"bar.archive","enabled":true}]"#
                    .to_string(),
            ),
            (
                "persistent###loadOrders###tHYlht6Mz###cyberpunk2077-redmod".to_string(),
                r#"[{"id":"red-1","modId":"5266"}]"#.to_string(),
            ),
            (
                "persistent###mods###cyberpunk2077###foo.archive-1###attributes###modId"
                    .to_string(),
                "123".to_string(),
            ),
        ]
    }

    #[test]
    fn parse_pairs_isolates_profiles_and_reads_orders() {
        let parsed = parse_pairs(&pairs());
        assert_eq!(parsed.active_profile_id, "tHYlht6Mz");
        assert_eq!(choose_profile(&parsed), "tHYlht6Mz");
        let states = &parsed.mod_states["tHYlht6Mz"];
        assert_eq!(states.len(), 2);
        assert_eq!(states["foo.archive-1"], true);
        assert_eq!(states["bar.archive-2"], false);
        assert_eq!(
            parsed.archive_orders["tHYlht6Mz"],
            vec!["foo.archive", "bar.archive"]
        );
        assert_eq!(parsed.redmod_orders["tHYlht6Mz"], vec!["red-1"]);
        assert!(parsed.mod_dirs.contains("foo.archive-1"));
        // 别的游戏的 modState 不能混进本游戏计数。
        assert_eq!(parsed.mod_states["other"].len(), 1);
    }

    #[test]
    fn fingerprint_is_stable_and_changes_with_state() {
        let parsed = parse_pairs(&pairs());
        let first = fingerprint(&parsed, "tHYlht6Mz");
        assert_eq!(first, fingerprint(&parsed, "tHYlht6Mz"));
        assert_eq!(first.len(), 16);
        let mut changed = pairs();
        changed[4].1 = "false".to_string();
        let other = parse_pairs(&changed);
        assert_ne!(first, fingerprint(&other, "tHYlht6Mz"));
    }

    #[test]
    fn order_consistent_only_compares_intersection() {
        let local = vec![
            "archive/pc/mod/a.archive".to_string(),
            "archive/pc/mod/b.archive".to_string(),
        ];
        assert!(order_consistent(&local, &["a.archive".to_string(), "b.archive".to_string()]));
        assert!(!order_consistent(&local, &["b.archive".to_string(), "a.archive".to_string()]));
        assert!(order_consistent(&local, &[]));
    }

    #[test]
    fn malformed_order_becomes_warning_not_panic() {
        let mut input = pairs();
        input.push((
            "persistent###loadOrders###tHYlht6Mz###cyberpunk2077-archive".to_string(),
            "not-json".to_string(),
        ));
        let parsed = parse_pairs(&input);
        assert!(parsed.warnings.iter().any(|item| item.contains("无法解析")));
    }

    fn temp_store(tag: &str) -> (std::path::PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "cdl-vortex-mirror-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let store = Store::load(root.join("data")).expect("临时 Store 应能创建");
        (root, store)
    }

    #[test]
    fn staging_health_lists_orphans_without_deleting_anything() {
        let (root, store) = temp_store("health");
        let base = store.staging_dir();
        let known = base.join("adopt-known");
        let orphan = base.join("adopt-orphan");
        // 目录名是旧收编 id，与 mod id 不同，但部署清单仍指向它 —— 不能算孤儿。
        let legacy = base.join("adopt-legacy");
        std::fs::create_dir_all(&known).unwrap();
        std::fs::write(known.join("x.txt"), b"abc").unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("y.archive.xl"), b"xl").unwrap();

        let mut entry: crate::schema::ModEntry = serde_json::from_value(serde_json::json!({
            "id": "adopt-known",
            "name": "known",
            "category": "misc",
            "stagingPath": known.to_string_lossy(),
            "enabled": true,
            "installedAt": "2026-11-09T00:00:00Z",
            "sizeBytes": 3,
            "fileCount": 1,
            "layout": "archive",
        }))
        .expect("最小 ModEntry 应能反序列化");
        entry.deployed_files.push(crate::schema::DeployedFile {
            source: legacy.join("y.archive.xl").to_string_lossy().to_string(),
            target: "D:/game/archive/pc/mod/y.archive.xl".to_string(),
            link_type: crate::schema::LinkType::HardLink,
            relative_path: "archive/pc/mod/y.archive.xl".to_string(),
            size: Some(2),
            modified_time: None,
        });
        // Store::save 只落盘、不回写内存；体检读的是内存快照，所以这里直接改
        // 内存状态（也更贴合「体检只读、不改任何文件」的语义）。
        store.data.lock().expect("state mutex poisoned").mods.push(entry);

        let health = staging_health(&store).unwrap();
        assert_eq!(health.registered_total, 1);
        assert!(health.orphan_dirs.contains(&"adopt-orphan".to_string()));
        assert!(!health.orphan_dirs.contains(&"adopt-known".to_string()));
        assert!(
            !health.orphan_dirs.contains(&"adopt-legacy".to_string()),
            "被 deployedFiles.source 引用的旧 id 目录不能算孤儿"
        );
        assert!(health.missing_dirs.is_empty());
        assert!(orphan.is_dir(), "体检绝不能删除孤儿目录");
        assert_eq!(health.orphan_bytes, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn preflight_with_unreadable_db_is_a_report_not_a_crash() {
        let (root, store) = temp_store("preflight");
        let report = preflight(&store).unwrap();
        assert!(!report.available);
        assert!(report.db_locked);
        assert!(report.warnings.iter().any(|item| item.contains("只读")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
