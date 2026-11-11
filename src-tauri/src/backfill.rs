//! 给「收编进来的旧条目」回填 Nexus 编号。
//!
//! 背景（2026-11-11）：模组库里 251 条有 68 条 `origin == "adopted"` 没有
//! `nexus` 字段。这些条目不是「玩家记错了来源」，而是收编时只拿到了磁盘上的
//! 文件名和路径——收编管线刻意不去联网，于是 modId 一直是空。既有
//! `nexus::enrich_metadata` 只从文件名里抠数字（`Mod-1234-1-2-...`），
//! 纯名字（`Goneaway`）抠不出东西，所以这批条目永远补不上。
//!
//! 本模块走两条**不猜**的路：
//! 1. 读本机 Vortex 的 LevelDB（`vortex::load_records`）。玩家用 Vortex 下过
//!    这些 Mod，那里存着 `name / modId / fileId` 三件套，零网络、最准。
//! 2. 名字在 Vortex 里对不上时，才退回 Nexus v2 GraphQL 按名字搜。
//!
//! 两路都只接受「归一化后完全相等」或「唯一命中且包含关系足够强」的结果，
//! 模糊命中一律留空——写错 modId 的代价比留空大得多：以后检查更新、切版本、
//! 导出整合包全都会照着错的编号跑。
//!
//! 写库分成两步：`propose` 只读，`apply` 才落盘，中间由前端把提案摊给玩家确认。

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::schema::{AppResult, CommandError, ModEntry, NexusRef};
use crate::store::{now_iso, Store};

/// 单次提案最多联网检索多少条。Nexus GraphQL 有独立限流池，但仍然要克制：
/// 玩家可以再点一次，超时卡死一次却会让人以为功能坏了。
const MAX_REMOTE_LOOKUPS: usize = 60;
/// 两次联网检索之间的间隔。
const REMOTE_GAP_MS: u64 = 250;
/// 包含匹配的长度比下限。`nut` 这种三字母名字会把整库都「包含」进去。
const MIN_CONTAIN_RATIO: f32 = 0.55;

/// 提案来源。
pub const SOURCE_VORTEX: &str = "vortex";
pub const SOURCE_FILENAME: &str = "filename";
pub const SOURCE_SEARCH: &str = "search";

/// 一条回填提案：哪个条目 → 匹配到哪个 Nexus Mod。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillProposal {
    pub entry_id: String,
    pub entry_name: String,
    pub mod_id: u64,
    #[serde(default)]
    pub file_id: Option<u64>,
    /// 匹配到的那个名字（Vortex 记录名 / 搜索结果名）。让玩家一眼判断对不对。
    pub matched_name: String,
    #[serde(default)]
    pub matched_version: Option<String>,
    /// `vortex` / `filename` / `search`
    pub source: String,
    /// `exact` / `contains` / `search`
    pub confidence: String,
}

/// 提案结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillReport {
    /// 扫到多少条缺编号的条目。
    pub scanned: usize,
    pub proposals: Vec<BackfillProposal>,
    /// 实在匹配不上的条目名（交给玩家手动绑）。
    pub unmatched: Vec<String>,
    /// Vortex 数据源状态：`ok` / `missing` / `locked`。
    pub vortex_status: String,
    pub vortex_message: String,
    /// 联网检索被跳过或失败时的说明（不影响本地命中）。
    pub remote_message: Option<String>,
}

/// 归一化：小写、去括号段、非字母数字一律当分隔。
fn norm(text: &str) -> String {
    let lowered = text.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut depth = 0i32;
    let mut pending = false;
    for ch in lowered.chars() {
        match ch {
            '(' | '[' => {
                depth += 1;
                continue;
            }
            ')' | ']' => {
                depth = (depth - 1).max(0);
                continue;
            }
            _ => {}
        }
        if depth > 0 {
            continue;
        }
        if ch.is_alphanumeric() {
            if pending && !out.is_empty() {
                out.push(' ');
            }
            pending = false;
            out.push(ch);
        } else {
            pending = true;
        }
    }
    out.trim().to_string()
}

/// 条目上可以拿来配对的候选名。
///
/// 收编条目的 `staging_path` 末段是 `adopt-<hash>`，拿去匹配纯属噪音，
/// 这里按前缀排除。`raw_name` 是清洗前的原始名字，往往比展示名更贴近 Nexus。
fn name_candidates(entry: &ModEntry) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |value: &str| {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|item| item == trimmed) {
            out.push(trimmed.to_string());
        }
    };
    push(&entry.name);
    if let Some(raw) = entry.raw_name.as_deref() {
        push(raw);
    }
    if let Some(zip) = entry.source_zip.as_deref() {
        let stem = std::path::Path::new(zip)
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or("");
        push(stem);
    }
    out
}

/// 在候选集合里找「唯一且够强」的包含匹配。
fn unique_contains<'a>(probe: &str, pool: &'a [String]) -> Option<&'a String> {
    if probe.chars().count() < 6 {
        return None;
    }
    let hits: Vec<&String> = pool
        .iter()
        .filter(|item| {
            let long = item.chars().count().max(probe.chars().count()) as f32;
            let short = item.chars().count().min(probe.chars().count()) as f32;
            (item.contains(probe) || probe.contains(item.as_str())) && short / long >= MIN_CONTAIN_RATIO
        })
        .collect();
    (hits.len() == 1).then(|| hits[0])
}

/// 生成提案（只读，不写库）。
///
/// `use_remote` 为 true 时，本地对不上的条目会按名字去 Nexus 搜一遍；
/// 没配 API Key 或网络失败只会体现在 `remote_message` 里，本地命中照常返回。
pub fn propose(store: &Store, use_remote: bool) -> AppResult<BackfillReport> {
    let snapshot = store.snapshot_data();
    let targets: Vec<ModEntry> = snapshot
        .mods
        .iter()
        .filter(|entry| entry.nexus.is_none() && entry.metadata_source != "manual")
        .cloned()
        .collect();

    let mut report = BackfillReport {
        scanned: targets.len(),
        ..BackfillReport::default()
    };

    // ── 第一路：Vortex 记录 ──────────────────────────────────────────
    let records = match crate::vortex::load_records() {
        Ok(list) => {
            report.vortex_status = "ok".to_string();
            report.vortex_message = format!("读到 {} 条 Vortex 记录。", list.len());
            list
        }
        Err(err) => {
            report.vortex_status = if err.code == "VORTEX_DB_LOCKED" {
                "locked".to_string()
            } else {
                "missing".to_string()
            };
            report.vortex_message = err.message;
            Vec::new()
        }
    };

    // 两种索引：归一化名字（可能重名，留 Vec）与目录名（唯一）。
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_dir: HashMap<String, usize> = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        by_name.entry(norm(&record.name)).or_default().push(index);
        if !record.dir_name.is_empty() {
            by_dir.insert(norm(&record.dir_name), index);
        }
    }

    let mut unresolved: Vec<&ModEntry> = Vec::new();
    for entry in &targets {
        let candidates: Vec<String> = name_candidates(entry).into_iter().map(|v| norm(&v)).collect();
        let mut hit: Option<usize> = None;
        let mut confidence = "exact";
        for probe in &candidates {
            if let Some(list) = by_name.get(probe) {
                if list.len() == 1 {
                    hit = Some(list[0]);
                    break;
                }
            }
            if let Some(&index) = by_dir.get(probe) {
                hit = Some(index);
                break;
            }
        }
        // 精确名对不上 → 在所有归一化名字里找唯一包含。
        if hit.is_none() {
            let pool: Vec<String> = by_name.keys().cloned().collect();
            for probe in &candidates {
                if let Some(found) = unique_contains(probe, &pool) {
                    if let Some(list) = by_name.get(found) {
                        if list.len() == 1 {
                            hit = Some(list[0]);
                            confidence = "contains";
                            break;
                        }
                    }
                }
            }
        }
        match hit {
            Some(index) => {
                let record = &records[index];
                // 版本号能对上时把置信度提回 exact：同名不同 Mod 的情况真实存在。
                let same_version = match (&entry.version, &record.version) {
                    (Some(a), b) if !b.is_empty() => a.eq_ignore_ascii_case(b),
                    _ => false,
                };
                report.proposals.push(BackfillProposal {
                    entry_id: entry.id.clone(),
                    entry_name: entry.name.clone(),
                    mod_id: record.mod_id,
                    file_id: record.file_id,
                    matched_name: record.name.clone(),
                    matched_version: (!record.version.is_empty()).then(|| record.version.clone()),
                    source: SOURCE_VORTEX.to_string(),
                    confidence: if same_version { "exact" } else { confidence }.to_string(),
                });
            }
            None => unresolved.push(entry),
        }
    }

    // ── 第二路：文件名里的数字（原有能力，顺手带上）────────────────
    let mut still: Vec<&ModEntry> = Vec::new();
    for entry in unresolved {
        let parsed = name_candidates(entry)
            .iter()
            .find_map(|text| crate::nexus::parse_nexus_ids(text));
        match parsed {
            Some((mod_id, file_id)) => report.proposals.push(BackfillProposal {
                entry_id: entry.id.clone(),
                entry_name: entry.name.clone(),
                mod_id,
                file_id,
                matched_name: entry.name.clone(),
                matched_version: None,
                source: SOURCE_FILENAME.to_string(),
                confidence: "contains".to_string(),
            }),
            None => still.push(entry),
        }
    }

    // ── 第三路：联网按名字搜（可选）──────────────────────────────────
    if use_remote && !still.is_empty() {
        match remote_lookup(store, &still, &mut report.proposals) {
            Ok(used) => {
                report.remote_message = Some(if used == 0 {
                    "联网检索没有找到更多匹配。".to_string()
                } else {
                    format!("联网检索补上 {used} 条。")
                });
            }
            Err(err) => report.remote_message = Some(err.message),
        }
    }

    // 已被提案覆盖的条目不再列进 unmatched。
    let covered: Vec<&str> = report.proposals.iter().map(|item| item.entry_id.as_str()).collect();
    report.unmatched = targets
        .iter()
        .filter(|entry| !covered.contains(&entry.id.as_str()))
        .map(|entry| entry.name.clone())
        .collect();

    Ok(report)
}

/// 按名字去 Nexus v2 GraphQL 搜。只接受归一化后完全相等或唯一包含的结果。
///
/// GraphQL 返回结构变了也不该让整个功能挂掉：解析失败按「没结果」处理，
/// 错误汇总到返回的 `CommandError`，由上层展示成一条说明。
fn remote_lookup(
    store: &Store,
    targets: &[&ModEntry],
    out: &mut Vec<BackfillProposal>,
) -> AppResult<usize> {
    let key = crate::nexus::api_key(store)?;
    let client = crate::nexus::http_client()?;
    let mut used = 0usize;
    for (index, entry) in targets.iter().take(MAX_REMOTE_LOOKUPS).enumerate() {
        if index > 0 {
            std::thread::sleep(Duration::from_millis(REMOTE_GAP_MS));
        }
        let term = entry.name.trim();
        if term.chars().count() < 3 {
            continue;
        }
        let body = serde_json::json!({
            "query": "query($filter: ModsFilter, $count: Int) { mods(filter: $filter, count: $count) { totalCount nodes { modId name version author } } }",
            "variables": {
                "filter": {
                    "gameDomainName": [{ "value": "cyberpunk2077", "op": "EQUALS" }],
                    "name": [{ "value": term, "op": "WILDCARD" }]
                },
                "count": 6
            }
        });
        let response = client
            .post("https://api.nexusmods.com/v2/graphql")
            .header("apikey", &key)
            .json(&body)
            .send()
            .map_err(|err| CommandError::new("BACKFILL_NETWORK", format!("联网检索失败：{err}")))?;
        if !response.status().is_success() {
            return Err(CommandError::new(
                "BACKFILL_NETWORK",
                format!("联网检索被拒（{}）。", response.status()),
            ));
        }
        let payload: serde_json::Value = response.json().unwrap_or(serde_json::Value::Null);
        let nodes = payload
            .pointer("/data/mods/nodes")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        let probe = norm(term);
        let mut chosen: Option<&serde_json::Value> = None;
        let mut confidence = "search";
        for node in &nodes {
            let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if norm(name) == probe {
                chosen = Some(node);
                break;
            }
        }
        if chosen.is_none() && nodes.len() == 1 {
            let name = nodes[0].get("name").and_then(|v| v.as_str()).unwrap_or("");
            let long = norm(name).chars().count().max(probe.chars().count()) as f32;
            let short = norm(name).chars().count().min(probe.chars().count()) as f32;
            if long > 0.0 && short / long >= MIN_CONTAIN_RATIO {
                chosen = Some(&nodes[0]);
                confidence = "contains";
            }
        }
        if let Some(node) = chosen {
            let Some(mod_id) = node.get("modId").and_then(|v| v.as_u64()) else {
                continue;
            };
            out.push(BackfillProposal {
                entry_id: entry.id.clone(),
                entry_name: entry.name.clone(),
                mod_id,
                file_id: None,
                matched_name: node
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                matched_version: node
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                source: SOURCE_SEARCH.to_string(),
                confidence: confidence.to_string(),
            });
            used += 1;
        }
    }
    Ok(used)
}

/// 把玩家确认过的提案写进库。返回实际写入条数。
///
/// 只补 `nexus` 字段（modId/fileId/url），不动 name / category / enabled——
/// 名字是冲突检测和部署路径的依据，回填不该顺手改掉任何别的东西。
pub fn apply(store: &Store, proposals: &[BackfillProposal]) -> AppResult<usize> {
    if proposals.is_empty() {
        return Ok(0);
    }
    let mut data = store.data.lock().unwrap_or_else(|err| err.into_inner());
    let mut written = 0usize;
    for proposal in proposals {
        if proposal.mod_id == 0 {
            continue;
        }
        let Some(entry) = data.mods.iter_mut().find(|item| item.id == proposal.entry_id) else {
            continue;
        };
        // 已经有编号的不覆盖：玩家手动绑过的值优先级最高。
        if entry.nexus.is_some() {
            continue;
        }
        entry.nexus = Some(NexusRef {
            mod_id: proposal.mod_id,
            file_id: proposal.file_id,
            url: format!(
                "https://www.nexusmods.com/cyberpunk2077/mods/{}",
                proposal.mod_id
            ),
            version: proposal.matched_version.clone(),
            picture_url: None,
            latest_version: None,
            last_check: None,
        });
        entry.updated_at = Some(now_iso());
        written += 1;
    }
    if written > 0 {
        store.save(&data)?;
    }
    Ok(written)
}
