//! Nexus Collections（`collection.json` 清单）支持。
//!
//! 为什么不是「本地大 ZIP 整合包」：
//! - CP2077 的整合包生态用 Nexus Collections 规范描述：一个 JSON 清单
//!   列出要用的 Mod（modId/fileId/版本/是否可选）以及 Mod 之间的规则。
//!   清单本身不含 Mod 内容，Mod 仍然走 Nexus 下载或本地导入。
//! - 旧实现（`modpack.rs`）要解压巨型 ZIP、递归扫子目录、自动剥多层嵌套，
//!   再批量注册几百个 Mod。那套既慢又容易误判，且和社区规范完全脱节。
//!
//! 本模块只做三件事：
//! 1. 解析清单（容错：非关键字段一律带默认值）；
//! 2. 把清单里的每个 Mod 与本地库做匹配，产出「装了什么 / 缺什么 / 版本对不对」；
//! 3. 依据 `modRules` 做**稳定拓扑排序**，给出推荐的加载顺序。
//!
//! 格式依据（上游规范，二者一致）：
//! - `NexusMods.Abstractions.Collections/Json/CollectionRoot.cs` / `ModRule.cs`
//! - `Nexus-Mods/Vortex` 的 `src/renderer/src/extensions/collections/types/ICollection.ts`
//!
//! 上游清单里 `mods[].source.{modId,fileId,md5}` 是嵌套的，而 Mod 之间的规则
//! 写在顶层 `modRules[]`，每条规则同时带 `source`（规则所属的 Mod）和
//! `reference`（另一个 Mod）。为了兼容社区里流传的简化写法，本模块同时接受
//! 「扁平字段」和「嵌套 source」两种形状，规则也支持挂在单个 Mod 自己的
//! `rules[]` 下。

use crate::schema::{AppResult, CommandError, ModEntry};
use crate::store::Store;
use serde::{Deserialize, Deserializer, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs;
use std::path::Path;

/// 清单文件大小上限。8 MB 足够装下几百个 Mod 的描述，再大就不是清单了。
pub const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

/// Nexus 上 CP2077 的域名，兼作「这个清单是不是给我们的游戏」的判据。
pub const COLLECTION_DOMAIN: &str = "cyberpunk2077";

/// 单个 Mod 的状态：已装且版本对得上。
pub const STATUS_INSTALLED: &str = "installed";
/// 已装，但清单要求的版本和本地版本不一样。
pub const STATUS_VERSION_MISMATCH: &str = "version_mismatch";
/// 本地库里没有这个 Mod。
pub const STATUS_MISSING: &str = "missing";

// ── 清单结构 ───────────────────────────────────────────────────────────

/// 一份 Nexus Collection 清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusCollectionManifest {
    /// 清单元信息（名字、作者、目标游戏……）。
    #[serde(default)]
    pub info: CollectionInfo,
    /// 清单包含的 Mod。
    #[serde(default)]
    pub mods: Vec<CollectionMod>,
    /// Mod 之间的规则（加载先后、依赖）。
    #[serde(default, rename = "modRules", alias = "mod_rules")]
    pub mod_rules: Vec<CollectionRule>,
    /// 清单格式版本号（上游有些版本会带）。
    #[serde(default)]
    pub collection_schema_version: Option<String>,
}

/// 清单元信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    /// 目标游戏的 Nexus 域名，必须是 `cyberpunk2077`。
    #[serde(default, alias = "domain_name")]
    pub domain_name: String,
    /// 清单适配的游戏版本。
    #[serde(default)]
    pub game_versions: Vec<String>,
}

/// 清单里的一个 Mod。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(from = "RawCollectionMod")]
pub struct CollectionMod {
    /// Nexus Mod ID。
    pub mod_id: u64,
    /// Nexus 文件 ID（清单通常钉死具体版本的文件）。
    pub file_id: Option<u64>,
    /// 文件 MD5。本地库不存 MD5，这个字段只做透传，不参与匹配。
    pub file_md5: Option<String>,
    /// 是否可选。可选 Mod 缺失不阻塞部署。
    pub optional: bool,
    pub name: String,
    pub version: Option<String>,
    /// 挂在该 Mod 头上的规则（社区简化写法）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<CollectionRule>,
    /// 上游给该 Mod 分配的标签，规则靠它指回具体的 Mod。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// `CollectionMod` 的原始形状：同时吃「扁平字段」和「嵌套 source」。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCollectionMod {
    #[serde(default, deserialize_with = "de_opt_u64")]
    mod_id: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    file_id: Option<u64>,
    #[serde(default, alias = "md5")]
    file_md5: Option<String>,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    rules: Vec<CollectionRule>,
    #[serde(default)]
    tag: Option<String>,
    /// 上游写法：`source: { modId, fileId, md5, tag }`。
    #[serde(default)]
    source: Option<RawCollectionSource>,
}

/// `RawCollectionMod` 里的 `source` 子对象。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCollectionSource {
    #[serde(default, deserialize_with = "de_opt_u64")]
    mod_id: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    file_id: Option<u64>,
    #[serde(default, alias = "md5")]
    md5: Option<String>,
    #[serde(default)]
    tag: Option<String>,
}

impl From<RawCollectionMod> for CollectionMod {
    fn from(raw: RawCollectionMod) -> Self {
        let source = raw.source.unwrap_or(RawCollectionSource {
            mod_id: None,
            file_id: None,
            md5: None,
            tag: None,
        });
        Self {
            // 扁平字段优先；缺失时回落到嵌套 source（上游标准形状）。
            mod_id: raw.mod_id.or(source.mod_id).unwrap_or(0),
            file_id: raw.file_id.or(source.file_id),
            file_md5: raw.file_md5.or(source.md5),
            optional: raw.optional,
            name: raw.name,
            version: raw.version,
            rules: raw.rules,
            tag: raw.tag.or(source.tag),
        }
    }
}

/// Mod 之间的一条规则。
///
/// `type` 的含义（与上游 `VortexModRuleType` 一致）：
/// - `before`：规则所属的 Mod 排在 `reference` 之前；
/// - `after`：规则所属的 Mod 排在 `reference` 之后；
/// - `requires`：规则所属的 Mod 依赖 `reference`，因此 `reference` 排前面。
///
/// 其余类型（`conflicts` / `recommends` / `provides`）不参与加载顺序。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRule {
    #[serde(rename = "type", default)]
    pub r#type: String,
    /// 规则的另一端。
    #[serde(default)]
    pub reference: Option<CollectionRuleRef>,
    /// 规则所属的那一端。上游清单里每条规则都带它；简化写法可能只写 `reference`。
    #[serde(default)]
    pub source: Option<CollectionRuleRef>,
}

/// 规则指向的一个 Mod。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRuleRef {
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub mod_id: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub file_id: Option<u64>,
    /// 上游标签，规则主要靠它指回 Mod。
    #[serde(default)]
    pub tag: Option<String>,
    /// 上游文件哈希。
    #[serde(default, alias = "fileMD5")]
    pub file_md5: Option<String>,
    /// 上游把非 Nexus 来源的 ID 放在 `repo` 里。
    #[serde(default)]
    pub repo: Option<CollectionRuleRepo>,
}

/// 规则引用里的 `repo` 子对象。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRuleRepo {
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub mod_id: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub file_id: Option<u64>,
}

/// 清单解析后的部署计划。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPlan {
    /// 清单元信息。
    pub info: CollectionInfo,
    /// 逐个 Mod 的匹配结果。
    pub items: Vec<CollectionPlanItem>,
    /// 已装且版本对得上的 Mod 数。
    pub installed: usize,
    /// 必装但本地没有的 Mod 数。
    pub missing: usize,
    /// 可选但本地没有的 Mod 数。
    pub optional_missing: usize,
    /// 必装 Mod 全部到位，可以按清单顺序部署。
    pub ready_to_deploy: bool,
    /// 拓扑排序后的 Mod ID 顺序（加载顺序）。
    #[serde(default)]
    pub deploy_order: Vec<u64>,
    /// 规则无法解析、存在环等情况的说明。没有异常时是空串。
    #[serde(default)]
    pub message: String,
}

/// 计划里的一个 Mod。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPlanItem {
    /// Nexus Mod ID。
    pub mod_id: u64,
    /// Nexus 文件 ID。
    pub file_id: Option<u64>,
    /// Mod 名字（取自清单）。
    pub name: String,
    /// 清单要求的版本。
    pub version: Option<String>,
    /// 是否可选。
    pub optional: bool,
    /// `installed` / `version_mismatch` / `missing`。
    pub status: String,
    /// 匹配到的本地 Mod ID（`missing` 时为 None）。
    pub local_id: Option<String>,
    /// 本地已装版本。
    pub local_version: Option<String>,
    /// Nexus 页面地址。
    pub page_url: String,
    /// 拓扑排序后的位次（0 起）。
    pub order: usize,
}

/// 整批集合部署的结果。
///
/// 为什么不用 `schema::DeployReport`：那个是**单个** Mod 的部署报告，
/// 带一个 `mod_entry`。集合部署一次要动几十个 Mod，前端只关心
/// 「整体成了几个 / 挂了几个 / 有哪些警告 / 最终按什么顺序落的盘」，
/// 单个 Mod 的字段在这里没有意义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDeployReport {
    /// 成功部署的 Mod 数。
    pub deployed: usize,
    /// 部署失败的 Mod 数。
    pub failed: usize,
    /// 整批部署过程中收集到的警告。
    #[serde(default)]
    pub warnings: Vec<String>,
    /// 实际落盘的 Mod ID 顺序（本地 ModEntry.id，按部署顺序）。
    #[serde(default)]
    pub order: Vec<String>,
}

// ── 解析 ───────────────────────────────────────────────────────────────

/// 读清单文件并解析。上限 8 MB，超了直接报错而不是把内存吃光。
pub fn read_manifest(path: &str) -> AppResult<NexusCollectionManifest> {
    let file = Path::new(path);
    if !file.is_file() {
        return Err(CommandError::new(
            "COLLECTION_NOT_FOUND",
            format!("找不到清单文件：{}", file.display()),
        ));
    }
    let size = fs::metadata(file).map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_MANIFEST_BYTES {
        return Err(CommandError::new(
            "COLLECTION_TOO_LARGE",
            format!(
                "清单文件有 {} MB，超过 {} MB 上限。",
                size / 1024 / 1024,
                MAX_MANIFEST_BYTES / 1024 / 1024
            ),
        ));
    }
    let raw = fs::read_to_string(file)?;
    parse_manifest(&raw)
}

/// 解析清单文本。
pub fn parse_manifest(raw: &str) -> AppResult<NexusCollectionManifest> {
    serde_json::from_str::<NexusCollectionManifest>(raw).map_err(|err| {
        CommandError::new(
            "COLLECTION_INVALID",
            format!("清单不是合法的 Nexus Collection JSON：{err}"),
        )
    })
}

/// 校验清单是不是给 CP2077 用的。
pub fn validate_domain(manifest: &NexusCollectionManifest) -> AppResult<()> {
    let domain = manifest.info.domain_name.trim();
    if domain.is_empty() {
        return Err(CommandError::new(
            "WRONG_GAME",
            "清单里没有写目标游戏（domainName），无法确认它是不是 Cyberpunk 2077 的整合包。",
        ));
    }
    if !domain.eq_ignore_ascii_case(COLLECTION_DOMAIN) {
        return Err(CommandError::new(
            "WRONG_GAME",
            format!(
                "这是 {domain} 的整合包，不是 Cyberpunk 2077 的。请换一个 Cyberpunk 2077 的清单。"
            ),
        ));
    }
    Ok(())
}

// ── 匹配与排序 ─────────────────────────────────────────────────────────

/// 把清单和本地库对起来，产出部署计划。
///
/// 匹配顺序：先按本地 `nexus.mod_id` 精确匹配，再按 `nexus.file_id` 匹配，
/// 都不中才算缺失。`file_md5` 不参与匹配——本地库不存 MD5，拿它匹配只会
/// 造成「明明装了却显示缺失」的假象。
pub fn plan_collection(store: &Store, manifest: &NexusCollectionManifest) -> CollectionPlan {
    // 只在锁内取一份快照，匹配和排序都在锁外做。
    let state = store.snapshot_data();

    let mut by_mod_id: HashMap<u64, &ModEntry> = HashMap::new();
    let mut by_file_id: HashMap<u64, &ModEntry> = HashMap::new();
    for entry in &state.mods {
        let Some(nexus) = entry.nexus.as_ref() else {
            continue;
        };
        by_mod_id.entry(nexus.mod_id).or_insert(entry);
        if let Some(file_id) = nexus.file_id {
            by_file_id.entry(file_id).or_insert(entry);
        }
    }

    let mut items: Vec<CollectionPlanItem> = Vec::with_capacity(manifest.mods.len());
    let mut installed = 0usize;
    let mut missing = 0usize;
    let mut optional_missing = 0usize;

    for mod_entry in &manifest.mods {
        let local = by_mod_id
            .get(&mod_entry.mod_id)
            .or_else(|| mod_entry.file_id.and_then(|id| by_file_id.get(&id)));

        let (status, local_id, local_version) = match local {
            None => (STATUS_MISSING, None, None),
            Some(entry) => {
                let version = local_version_of(entry);
                let mismatch = match (&mod_entry.version, &version) {
                    // 只有两边都有版本号，且确实不同，才算版本不符。
                    (Some(want), Some(have)) => want.trim() != have.trim(),
                    _ => false,
                };
                let status = if mismatch {
                    STATUS_VERSION_MISMATCH
                } else {
                    STATUS_INSTALLED
                };
                (status, Some(entry.id.clone()), version)
            }
        };

        match status {
            // 已装且版本对得上。
            STATUS_INSTALLED => installed += 1,
            // 版本不符的条目本身不算缺失（它确实在库里），但也不进「已装」
            // —— 清单要的是这个版本，得让用户看到它需要更新。
            STATUS_VERSION_MISMATCH => {}
            _ => {
                if mod_entry.optional {
                    optional_missing += 1;
                } else {
                    missing += 1;
                }
            }
        }

        items.push(CollectionPlanItem {
            mod_id: mod_entry.mod_id,
            file_id: mod_entry.file_id,
            name: mod_entry.name.clone(),
            version: mod_entry.version.clone(),
            optional: mod_entry.optional,
            status: status.to_string(),
            local_id,
            local_version,
            page_url: page_url(mod_entry.mod_id),
            order: 0,
        });
    }

    // 加载顺序：先按规则做稳定拓扑排序，再把位次回填到每个 item。
    let (order, message) = resolve_order(&manifest.mods, &manifest.mod_rules);
    for (index, mod_index) in order.iter().enumerate() {
        if let Some(item) = items.get_mut(*mod_index) {
            item.order = index;
        }
    }
    let deploy_order = order
        .iter()
        .filter_map(|index| manifest.mods.get(*index))
        .map(|entry| entry.mod_id)
        .collect();

    CollectionPlan {
        info: manifest.info.clone(),
        items,
        installed,
        missing,
        optional_missing,
        // 必装 Mod 全部在本地才算能部署；版本不符的 Mod 已经在库里，
        // 可以先按顺序部署，是否更新版本交给用户决定。
        ready_to_deploy: missing == 0,
        deploy_order,
        message: message.unwrap_or_default(),
    }
}

/// 本地 Mod 的版本号。优先用 Nexus 记录的那份，没有再退回 info.json 里的。
fn local_version_of(entry: &ModEntry) -> Option<String> {
    entry
        .nexus
        .as_ref()
        .and_then(|nexus| nexus.version.clone())
        .or_else(|| entry.version.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Nexus 页面地址。
fn page_url(mod_id: u64) -> String {
    if mod_id == 0 {
        return String::new();
    }
    format!("https://www.nexusmods.com/{COLLECTION_DOMAIN}/mods/{mod_id}")
}

/// 算出推荐的加载顺序。
///
/// 规则来源有两处，合并处理：
/// - 清单顶层的 `modRules`（上游标准形状，每条带 `source` 和 `reference`）；
/// - 单个 Mod 自己的 `rules`（社区简化写法）。
///
/// 返回 `(顺序, 说明)`。顺序里的元素是 `manifest.mods` 的下标。
/// 出现环时不 panic：退回原始数组顺序，并在说明里讲清楚。
fn resolve_order(mods: &[CollectionMod], rules: &[CollectionRule]) -> (Vec<usize>, Option<String>) {
    let identity = ModIdentity::index(mods);
    let mut edges: Vec<(usize, usize)> = Vec::new();
    let mut unresolved = 0usize;

    for rule in rules {
        let subject = rule.source.as_ref().and_then(|source| identity.resolve(source));
        match collect_edge(&identity, rule, subject) {
            EdgeResult::Edge(edge) => edges.push(edge),
            EdgeResult::Skip => {}
            EdgeResult::Unresolved => unresolved += 1,
        }
    }
    for (index, mod_entry) in mods.iter().enumerate() {
        for rule in &mod_entry.rules {
            match collect_edge(&identity, rule, Some(index)) {
                EdgeResult::Edge(edge) => edges.push(edge),
                EdgeResult::Skip => {}
                EdgeResult::Unresolved => unresolved += 1,
            }
        }
    }

    let mut message: Option<String> = None;
    if unresolved > 0 {
        message = Some(format!(
            "有 {unresolved} 条规则缺少引用端或来源端，已跳过（不影响其余顺序）。"
        ));
    }

    match topological_order(mods.len(), &edges) {
        Some(order) => (order, message),
        None => {
            let fallback: Vec<usize> = (0..mods.len()).collect();
            let note = format!(
                "{}清单里的规则互相矛盾（存在环），已退回清单原始顺序。",
                message.map(|text| format!("{text} ")).unwrap_or_default()
            );
            (fallback, Some(note))
        }
    }
}

/// 一条规则算出来的先后关系。
enum EdgeResult {
    /// 明确的先后关系：前者排前面。
    Edge((usize, usize)),
    /// 规则不影响顺序（引用了清单外的 Mod，或类型与顺序无关）。
    Skip,
    /// 规则信息不全，无法判断。
    Unresolved,
}

/// 把一条规则翻译成「谁排前面」。
fn collect_edge(
    identity: &ModIdentity,
    rule: &CollectionRule,
    subject: Option<usize>,
) -> EdgeResult {
    let Some(reference) = rule.reference.as_ref() else {
        return EdgeResult::Unresolved;
    };
    let Some(target) = identity.resolve(reference) else {
        // 规则指向的 Mod 不在清单里（上游允许引用清单外的 Mod）。
        // 这类规则对清单内部的顺序没有影响。
        return EdgeResult::Skip;
    };
    let Some(subject) = subject else {
        // 顶层规则没有 `source`，且本清单没有把它挂在某个 Mod 上：
        // 只能知道一端，无法确定先后，跳过并记账。
        return EdgeResult::Unresolved;
    };
    if subject == target {
        return EdgeResult::Skip;
    }
    match rule.r#type.trim().to_ascii_lowercase().as_str() {
        // 所属方在前面。
        "before" => EdgeResult::Edge((subject, target)),
        // 所属方在后面。
        "after" => EdgeResult::Edge((target, subject)),
        // 依赖方在前面（被依赖的先加载）。
        "requires" => EdgeResult::Edge((target, subject)),
        _ => EdgeResult::Skip,
    }
}

/// 把 Mod 的各种标识（ID / 标签 / 哈希）索引起来，供规则指认。
struct ModIdentity {
    by_mod_id: HashMap<u64, usize>,
    by_file_id: HashMap<u64, usize>,
    by_tag: HashMap<String, usize>,
    by_md5: HashMap<String, usize>,
}

impl ModIdentity {
    fn index(mods: &[CollectionMod]) -> Self {
        let mut by_mod_id = HashMap::new();
        let mut by_file_id = HashMap::new();
        let mut by_tag = HashMap::new();
        let mut by_md5 = HashMap::new();
        for (index, entry) in mods.iter().enumerate() {
            if entry.mod_id != 0 {
                by_mod_id.entry(entry.mod_id).or_insert(index);
            }
            if let Some(file_id) = entry.file_id {
                by_file_id.entry(file_id).or_insert(index);
            }
            if let Some(tag) = entry.tag.as_ref().filter(|value| !value.is_empty()) {
                by_tag.entry(tag.clone()).or_insert(index);
            }
            if let Some(md5) = entry.file_md5.as_ref().filter(|value| !value.is_empty()) {
                by_md5.entry(md5.to_ascii_lowercase()).or_insert(index);
            }
        }
        Self {
            by_mod_id,
            by_file_id,
            by_tag,
            by_md5,
        }
    }

    /// 把一个规则引用解析成清单里的下标。
    fn resolve(&self, reference: &CollectionRuleRef) -> Option<usize> {
        if let Some(mod_id) = reference.mod_id.filter(|value| *value != 0) {
            if let Some(index) = self.by_mod_id.get(&mod_id) {
                return Some(*index);
            }
        }
        if let Some(file_id) = reference.file_id {
            if let Some(index) = self.by_file_id.get(&file_id) {
                return Some(*index);
            }
        }
        if let Some(repo) = reference.repo.as_ref() {
            if let Some(mod_id) = repo.mod_id.filter(|value| *value != 0) {
                if let Some(index) = self.by_mod_id.get(&mod_id) {
                    return Some(*index);
                }
            }
            if let Some(file_id) = repo.file_id {
                if let Some(index) = self.by_file_id.get(&file_id) {
                    return Some(*index);
                }
            }
        }
        if let Some(tag) = reference.tag.as_ref().filter(|value| !value.is_empty()) {
            if let Some(index) = self.by_tag.get(tag) {
                return Some(*index);
            }
        }
        if let Some(md5) = reference.file_md5.as_ref().filter(|value| !value.is_empty()) {
            if let Some(index) = self.by_md5.get(&md5.to_ascii_lowercase()) {
                return Some(*index);
            }
        }
        None
    }
}

/// 稳定拓扑排序。返回 `None` 表示有环。
///
/// 「稳定」= 在没有先后约束的 Mod 之间保持清单里的原始先后，
/// 这样同一份清单每次算出来的顺序都一样，用户不会看到列表乱跳。
/// 实现上用 Kahn 算法，每轮从就绪集合里挑下标最小的那个。
fn topological_order(node_count: usize, edges: &[(usize, usize)]) -> Option<Vec<usize>> {
    if node_count == 0 {
        return Some(Vec::new());
    }

    // 同一对节点可能有多条规则，去重后再统计入度，否则会算错。
    let mut unique: Vec<(usize, usize)> = Vec::with_capacity(edges.len());
    let mut seen: HashSet<(usize, usize)> = HashSet::with_capacity(edges.len());
    for edge in edges {
        if edge.0 >= node_count || edge.1 >= node_count {
            continue;
        }
        if seen.insert(*edge) {
            unique.push(*edge);
        }
    }

    let mut out_edges: Vec<Vec<usize>> = vec![Vec::new(); node_count];
    let mut in_degree = vec![0usize; node_count];
    for (from, to) in &unique {
        out_edges[*from].push(*to);
        in_degree[*to] += 1;
    }

    let mut ready: BinaryHeap<Reverse<usize>> = BinaryHeap::new();
    for (index, degree) in in_degree.iter().enumerate() {
        if *degree == 0 {
            ready.push(Reverse(index));
        }
    }

    let mut order: Vec<usize> = Vec::with_capacity(node_count);
    while let Some(Reverse(index)) = ready.pop() {
        order.push(index);
        for target in &out_edges[index] {
            in_degree[*target] -= 1;
            if in_degree[*target] == 0 {
                ready.push(Reverse(*target));
            }
        }
    }

    if order.len() == node_count {
        Some(order)
    } else {
        None
    }
}

// ── 反序列化辅助 ───────────────────────────────────────────────────────

/// 宽松的 u64：Nexus 的接口有时给数字，有时给字符串。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum FlexU64 {
    Number(u64),
    Text(String),
}

impl FlexU64 {
    fn into_number<E: serde::de::Error>(self) -> Result<u64, E> {
        match self {
            FlexU64::Number(value) => Ok(value),
            FlexU64::Text(text) => text
                .trim()
                .parse::<u64>()
                .map_err(|err| serde::de::Error::custom(format!("{text} 不是合法的 ID：{err}"))),
        }
    }
}

/// 宽松的可选 u64。
fn de_opt_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let Some(value) = Option::<FlexU64>::deserialize(deserializer)? else {
        return Ok(None);
    };
    Ok(Some(value.into_number()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{InstallLayout, NexusRef};
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "ncl-collection-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&base).expect("scratch dir");
        base
    }

    /// 三个 Mod 的清单：两个必装、一个可选。
    fn sample_manifest() -> String {
        r#"{
          "info": {
            "name": "测试整合包",
            "author": "someone",
            "description": "用来测解析和排序",
            "domainName": "cyberpunk2077",
            "gameVersions": ["2.13"]
          },
          "mods": [
            {
              "name": "Mod A",
              "version": "1.0",
              "optional": false,
              "source": { "type": "nexus", "modId": 100, "fileId": 1000, "md5": "aaaa" }
            },
            {
              "name": "Mod B",
              "version": "2.0",
              "optional": false,
              "source": { "type": "nexus", "modId": 200, "fileId": 2000, "md5": "bbbb" }
            },
            {
              "name": "Mod C",
              "version": "3.0",
              "optional": true,
              "source": { "type": "nexus", "modId": 300, "fileId": 3000, "md5": "cccc" }
            }
          ],
          "modRules": [
            {
              "type": "before",
              "source": { "tag": "mod-b" },
              "reference": { "tag": "mod-a" }
            }
          ]
        }"#
        .to_string()
    }

    /// 本地库里的一个 Mod，带 Nexus 溯源信息。
    fn local_mod(id: &str, mod_id: u64, file_id: u64, version: &str) -> ModEntry {
        ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: format!("本地 {id}"),
            version: Some(version.to_string()),
            author: None,
            category: "测试".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: Some(NexusRef {
                mod_id,
                file_id: Some(file_id),
                url: format!("https://www.nexusmods.com/cyberpunk2077/mods/{mod_id}"),
                version: Some(version.to_string()),
                picture_url: None,
                latest_version: None,
                last_check: None,
            }),
            staging_path: String::new(),
            cover_path: None,
            cover_cache_path: None,
            enabled: false,
            installed_at: "2026-10-26T00:00:00Z".to_string(),
            updated_at: None,
            size_bytes: 0,
            file_count: 0,
            layout: InstallLayout::GameRoot,
            mod_folder: None,
            metadata_source: "filename".to_string(),
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

    /// 造一个装了两个 Mod 的库：A 版本对得上，B 版本对不上。
    fn store_with_local_mods(base: &Path) -> Store {
        let store = Store::load(base.join("data")).expect("store");
        {
            let mut guard = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.mods.push(local_mod("mod-a", 100, 1000, "1.0"));
            guard.mods.push(local_mod("mod-b", 200, 2000, "0.9"));
            store.save(&guard).expect("save");
        }
        store
    }

    #[test]
    fn parses_manifest_with_nested_source() {
        let manifest = parse_manifest(&sample_manifest()).expect("parse");
        assert_eq!(manifest.info.name, "测试整合包");
        assert_eq!(manifest.info.domain_name, "cyberpunk2077");
        assert_eq!(manifest.mods.len(), 3);
        // 嵌套 source 里的 modId/fileId/md5 都要被抬到外层。
        assert_eq!(manifest.mods[0].mod_id, 100);
        assert_eq!(manifest.mods[0].file_id, Some(1000));
        assert_eq!(manifest.mods[0].file_md5.as_deref(), Some("aaaa"));
        assert!(!manifest.mods[0].optional);
        assert!(manifest.mods[2].optional);
    }

    #[test]
    fn rejects_other_games() {
        let raw = sample_manifest().replace("cyberpunk2077", "skyrimspecialedition");
        let manifest = parse_manifest(&raw).expect("parse");
        let err = validate_domain(&manifest).expect_err("should reject");
        assert_eq!(err.code, "WRONG_GAME");
    }

    #[test]
    fn plans_installed_mismatch_and_missing() {
        let base = scratch("plan");
        let store = store_with_local_mods(&base);
        let manifest = parse_manifest(&sample_manifest()).expect("parse");

        let plan = plan_collection(&store, &manifest);

        assert_eq!(plan.installed, 1, "只有 A 版本对得上");
        assert_eq!(plan.missing, 0, "两个必装 Mod 都在本地");
        assert_eq!(plan.optional_missing, 1, "可选的 C 没装");
        assert!(plan.ready_to_deploy, "必装 Mod 齐了");

        assert_eq!(plan.items[0].status, STATUS_INSTALLED);
        assert_eq!(plan.items[0].local_id.as_deref(), Some("mod-a"));
        assert_eq!(plan.items[1].status, STATUS_VERSION_MISMATCH);
        assert_eq!(plan.items[1].local_version.as_deref(), Some("0.9"));
        assert_eq!(plan.items[2].status, STATUS_MISSING);
        assert!(plan.items[2].local_id.is_none());
        assert!(plan.items[2].page_url.contains("/mods/300"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn matches_by_file_id_when_mod_id_differs() {
        let base = scratch("file-id");
        let store = Store::load(base.join("data")).expect("store");
        {
            let mut guard = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.mods.push(local_mod("mod-x", 999, 1000, "1.0"));
            store.save(&guard).expect("save");
        }
        let manifest = parse_manifest(&sample_manifest()).expect("parse");
        let plan = plan_collection(&store, &manifest);
        // modId 对不上，但 fileId 一样 → 仍算已装。
        assert_eq!(plan.items[0].status, STATUS_INSTALLED);
        assert_eq!(plan.items[0].local_id.as_deref(), Some("mod-x"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sorts_mods_by_rules() {
        let base = scratch("order");
        let store = Store::load(base.join("data")).expect("store");
        // 清单里 Mod B 声明自己排在 Mod A 之前。
        let raw = r#"{
          "info": { "name": "排序", "domainName": "cyberpunk2077" },
          "mods": [
            { "name": "A", "tag": "mod-a", "modId": 100 },
            { "name": "B", "tag": "mod-b", "modId": 200, "rules": [
                { "type": "before", "reference": { "tag": "mod-a" } }
            ] },
            { "name": "C", "tag": "mod-c", "modId": 300 }
          ]
        }"#;
        let manifest = parse_manifest(raw).expect("parse");
        let plan = plan_collection(&store, &manifest);

        assert_eq!(
            plan.deploy_order,
            vec![200, 100, 300],
            "B 在 A 之前，C 无约束保持原位"
        );
        assert_eq!(plan.items[0].order, 1, "A 排在第二位");
        assert_eq!(plan.items[1].order, 0, "B 排在第一位");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn falls_back_when_rules_are_cyclic() {
        let base = scratch("cycle");
        let store = Store::load(base.join("data")).expect("store");
        let raw = r#"{
          "info": { "name": "环", "domainName": "cyberpunk2077" },
          "mods": [
            { "name": "A", "modId": 100, "rules": [
                { "type": "before", "reference": { "modId": 200 } }
            ] },
            { "name": "B", "modId": 200, "rules": [
                { "type": "before", "reference": { "modId": 100 } }
            ] }
          ]
        }"#;
        let manifest = parse_manifest(raw).expect("parse");
        let plan = plan_collection(&store, &manifest);

        assert_eq!(plan.deploy_order, vec![100, 200], "有环时退回原始顺序");
        let message = plan.message.clone();
        assert!(message.contains("环"), "说明里要讲清楚原因：{message}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn manifest_file_size_is_capped() {
        let base = scratch("too-large");
        let path = base.join("collection.json");
        let filler = "x".repeat(MAX_MANIFEST_BYTES as usize + 16);
        fs::write(&path, filler).expect("write");
        let err = read_manifest(path.to_str().unwrap()).expect_err("should reject");
        assert_eq!(err.code, "COLLECTION_TOO_LARGE");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn legacy_modpacks_records_are_dropped_on_load() {
        // 2026-10-26 产品决定：旧的本地大 ZIP 整合包已废弃，历史状态里的
        // modpacks 记录一律作废。这里确认加载路径确实把它们清掉了。
        //
        // 注意断言的写法：不能只看「modpacks 是空的」——如果反序列化器
        // 没消费掉这个字段的值，serde 的解析位置会错位，**整个状态文件**
        // 都会解析失败，Store::load 于是把文件改名成 broken-*.json 并重置
        // 成空状态（那次事故丢了 195 条模组索引）。那样 modpacks 同样是空的，
        // 断言会误判为通过。所以这里额外验证：
        //   1. 文件能被解析成 AppStateData（而不是掉进 broken 分支）；
        //   2. 别的字段（gameDir / mods）原样保留下来了。
        let base = scratch("legacy-modpacks");
        let data_dir = base.join("data");
        fs::create_dir_all(&data_dir).expect("data dir");
        let state_file = data_dir.join("launcher-state.json");
        let raw = r#"{
          "schemaVersion": 1,
          "gameDir": "D:/steam/steamapps/common/Cyberpunk 2077",
          "stagingDir": "staging",
          "mods": [],
          "loadOrder": ["archive/pc/mod/keep.archive"],
          "modpacks": [
            {
              "id": "pack-old",
              "name": "旧整合包",
              "sourceZip": "D:/old.zip",
              "importedAt": "2025-01-01T00:00:00Z",
              "childModIds": ["mod-a"],
              "recommendedOrder": ["mod-a"],
              "status": "ready"
            }
          ]
        }"#;
        fs::write(&state_file, raw).expect("write state");

        // ① 整个文件必须仍能解析：解析器要消费掉 modpacks 的值，
        // 否则解析位置错位，整个状态被判为损坏。
        let parsed: crate::schema::AppStateData =
            serde_json::from_str(raw).expect("状态文件必须能解析（modpacks 不能破坏整体解析）");
        assert!(
            parsed.modpacks.is_empty(),
            "旧 modpacks 记录必须在读取时被清空"
        );
        // ② 别的字段必须原样保留——整份状态没被当成损坏丢弃。
        assert_eq!(
            parsed.game_dir.as_deref(),
            Some("D:/steam/steamapps/common/Cyberpunk 2077"),
            "清空 modpacks 不能牵连到其它字段"
        );
        assert_eq!(
            parsed.load_order,
            vec!["archive/pc/mod/keep.archive".to_string()],
            "加载顺序必须保留"
        );

        // 走完整的 Store::load 路径，确认没掉进「文件损坏 → 重置为空」分支。
        let store = Store::load(data_dir.clone()).expect("load");
        let state = store.snapshot_data();
        assert!(
            state.modpacks.is_empty(),
            "旧 modpacks 记录必须在加载时被清空"
        );
        assert_eq!(
            state.game_dir.as_deref(),
            Some("D:/steam/steamapps/common/Cyberpunk 2077"),
            "加载后 gameDir 必须还在（掉进 broken 分支会把它清成 None）"
        );

        // 没有 broken-*.json 备份文件 = 没有走「判定为损坏」的分支。
        let broken: Vec<_> = fs::read_dir(data_dir.join(".."))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .filter(|name| name.contains("broken"))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            broken.is_empty(),
            "不该产生 broken 备份（说明状态被误判为损坏）：{broken:?}"
        );

        // 落盘后磁盘上也不该再有这些记录。
        let raw = fs::read_to_string(&state_file).expect("read back");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(
            parsed.get("modpacks").and_then(|value| value.as_array()).map(|items| items.len()),
            Some(0),
            "清空后的状态要落盘：{raw}"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_modpacks_array_also_parses() {
        // 这是最容易漏掉的一种形态：modpacks 已经被清空成 `[]`，
        // 启动器每次落盘写出的就是这个样子。
        //
        // 关键在于——`deserialize_with` 不消费输入值时，**空数组一样会**
        // 让 serde 的解析位置错位，整个状态文件被判为损坏：
        //   "modpacks": []        -> 解析失败
        //   "modpacks": ["x"]     -> 解析失败
        //   （没有 modpacks 字段） -> 解析成功
        // 所以「空数组」不是安全形态，反而是每次保存后都会遇到的常态，
        // 必须单独守住。
        let raw = r#"{
          "schemaVersion": 1,
          "gameDir": "D:/steam/steamapps/common/Cyberpunk 2077",
          "stagingDir": "staging",
          "mods": [],
          "loadOrder": ["archive/pc/mod/keep.archive"],
          "modpacks": []
        }"#;

        let parsed: crate::schema::AppStateData =
            serde_json::from_str(raw).expect("空数组形态也必须能解析");
        assert!(parsed.modpacks.is_empty());
        assert_eq!(
            parsed.game_dir.as_deref(),
            Some("D:/steam/steamapps/common/Cyberpunk 2077"),
            "空数组形态下其它字段也要保留"
        );
        assert_eq!(parsed.load_order.len(), 1);
    }

    #[test]
    fn plan_uses_the_agreed_wire_shape() {
        // 前端按这份字段名读（src/lib/collection.ts）。字段名一变，
        // 前端就会静默拿到 undefined，所以这里把线格式钉死。
        let base = scratch("wire");
        let store = Store::load(base.join("data")).expect("store");
        let manifest = parse_manifest(&sample_manifest()).expect("parse");
        let plan = plan_collection(&store, &manifest);

        let raw = serde_json::to_value(&plan).expect("serialize");
        for field in [
            "info",
            "items",
            "installed",
            "missing",
            "optionalMissing",
            "readyToDeploy",
            "deployOrder",
            "message",
        ] {
            assert!(
                raw.get(field).is_some(),
                "CollectionPlan 缺少前端约定的字段 {field}：{raw}"
            );
        }

        let item = &raw["items"][0];
        for field in [
            "modId",
            "fileId",
            "name",
            "version",
            "optional",
            "status",
            "localId",
            "localVersion",
            "pageUrl",
            "order",
        ] {
            assert!(
                item.get(field).is_some(),
                "CollectionPlanItem 缺少前端约定的字段 {field}：{item}"
            );
        }

        // message 是非空字符串（前端声明的是 string，不是 string | null）。
        assert!(
            raw["message"].is_string(),
            "message 必须是字符串：{raw}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn deploy_report_uses_the_agreed_wire_shape() {
        // apply_collection_order 返回的是集合级结构，不带单模组的 modEntry。
        let report = CollectionDeployReport {
            deployed: 3,
            failed: 1,
            warnings: vec!["某个 Mod 部署失败".to_string()],
            order: vec!["mod-a".to_string(), "mod-b".to_string()],
        };
        let raw = serde_json::to_value(&report).expect("serialize");
        for field in ["deployed", "failed", "warnings", "order"] {
            assert!(
                raw.get(field).is_some(),
                "CollectionDeployReport 缺少前端约定的字段 {field}：{raw}"
            );
        }
        assert!(
            raw.get("modEntry").is_none(),
            "集合级报告不该带单模组字段：{raw}"
        );
    }
}
