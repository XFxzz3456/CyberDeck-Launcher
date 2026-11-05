//! 前置依赖健康检查（Dependency Health Check）。
//!
//! 解决的是 CP2077 模组生态的真实痛点：玩家装了一个 `.xl` 模组，没装
//! ArchiveXL，进游戏毫无反应，日志里也看不出原因。这里做三件事：
//!
//! 1. **推断需要哪些框架**——优先读 Mod 自带的元数据（`info.json` /
//!    `manifest.json` 的 `dependencies` / `requirements`），读不到就退回
//!    文件后缀规则库（`.xl`→ArchiveXL、`.reds`→redscript、`.tweak`→TweakXL、
//!    `init.lua`→CET）。后缀规则的依据是「这些文件只有对应框架才认」，
//!    比按名字猜可靠得多。
//! 2. **和本地环境比对**——复用 `game::framework_statuses` 的探测结果，
//!    得到 `Healthy` / `Missing` / `VersionMismatch` 三态。
//! 3. **防误报**——整合包常把前置一起打包：只要**当前库内任一已启用 Mod**
//!    的部署清单里出现该框架的核心文件名（如 `ArchiveXL.dll`），就视为满足。
//!
//! 这里刻意**不**做的三件事，写下来避免以后被"顺手"加上：
//! - 不把纯 `.archive` 当成需要框架（原版就能加载 archive，加了就是全库误报）；
//! - 不为未知框架报缺失（玩家写的 `Native Interactions` 我们无法核对，
//!   报缺失只会制造噪音，标记为"未核对"即可）；
//! - 不落任何持久化字段（状态由当前库 + 游戏目录即时推导，避免 schema 变更）。

use crate::schema::{FrameworkStatus, ModEntry};
use crate::store::now_iso;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 单条依赖要求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRequirement {
    /// 框架 id，与 `FrameworkStatus.id` 对齐（archivexl / tweakxl / ...）。
    /// 未知框架直接用规范化后的名字，前端据此去 N 网搜索。
    pub id: String,
    pub name: String,
    /// 触发依据（`fileRule` / `metadata` / `layout`），便于排查误报。
    pub source: String,
    /// 人话依据，例如「包含 .xl 文件」。
    pub detail: String,
    pub satisfied: bool,
    /// `game` = 游戏目录已装；`bundled:<mod 名>` = 库内某 Mod 自带。
    pub satisfied_by: Option<String>,
    pub required_version: Option<String>,
    pub installed_version: Option<String>,
    /// 版本是否满足。无要求或无版本号时为 true（拿不到版本不算错）。
    pub version_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModDependencyStatus {
    pub mod_id: String,
    pub mod_name: String,
    pub enabled: bool,
    /// healthy | missing | versionMismatch
    pub status: String,
    pub requirements: Vec<DependencyRequirement>,
    /// 缺失框架的显示名，前端直接渲染。
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    pub checked_at: String,
    pub mods: Vec<ModDependencyStatus>,
    /// 已启用且缺前置的 Mod 数（诊断页横幅用这个口径）。
    pub missing_enabled: usize,
    /// 已启用且版本不满足的 Mod 数。
    pub mismatch_enabled: usize,
    /// 参与检查（至少推断出一条依赖）的 Mod 总数。
    pub checked_mods: usize,
}

/// 一条文件后缀规则。
struct FileRule {
    suffix: &'static str,
    framework: &'static str,
    detail: &'static str,
}

/// 内置规则库。判定依据是「这个文件只有对应框架能消费」，不看 Mod 名字，
/// 也不看作者描述——描述是不可信输入，且大量老 Mod 根本没有描述。
const FILE_RULES: &[FileRule] = &[
    FileRule {
        suffix: ".xl",
        framework: "archivexl",
        detail: "包含 .xl 归档声明文件",
    },
    FileRule {
        suffix: ".xlp",
        framework: "archivexl",
        detail: "包含 .xlp 归档声明文件",
    },
    FileRule {
        suffix: ".reds",
        framework: "redscript",
        detail: "包含 .reds 脚本",
    },
    FileRule {
        suffix: ".tweak",
        framework: "tweakxl",
        detail: "包含 .tweak 数据补丁",
    },
    FileRule {
        suffix: "init.lua",
        framework: "cet",
        detail: "包含 CET 的 init.lua 入口",
    },
];

/// 框架核心文件名：用于「整合包自带前置」的防误报判定。
/// 只认 dll / 可执行文件这类强证据，不认目录名（目录名谁都能建）。
const CORE_FILES: &[(&str, &[&str])] = &[
    ("archivexl", &["archivexl.dll"]),
    ("tweakxl", &["tweakxl.dll"]),
    ("codeware", &["codeware.dll"]),
    ("red4ext", &["red4ext.dll"]),
    ("cet", &["cyber_engine_tweaks.dll"]),
    ("modsettings", &["modsettings.dll"]),
    // redscript 的编译器在 2026 年改名为 scc.exe；旧名保留，避免老包漏判。
    ("redscript", &["scc.exe", "redscript-cli.exe"]),
];

/// 名称 → 框架 id 的别名表。元数据里写成什么都见过：`ArchiveXL`、`archive xl`、
/// `Cyber Engine Tweaks`、`CET`。规范化后统一映射，映射不上就当未知框架。
const ALIASES: &[(&str, &str)] = &[
    ("archivexl", "archivexl"),
    ("archive xl", "archivexl"),
    ("tweakxl", "tweakxl"),
    ("tweak xl", "tweakxl"),
    ("red4ext", "red4ext"),
    ("red4 ext", "red4ext"),
    ("codeware", "codeware"),
    ("redscript", "redscript"),
    ("cyber engine tweaks", "cet"),
    ("cyberenginetweaks", "cet"),
    ("cet", "cet"),
    ("mod settings", "modsettings"),
    ("modsettings", "modsettings"),
    ("mod-settings", "modsettings"),
];

/// 框架显示名。和 `game::framework_statuses` 保持一致，避免同一个框架在
/// 诊断页两处显示成两个名字。
fn display_name(id: &str) -> &str {
    match id {
        "archivexl" => "ArchiveXL",
        "tweakxl" => "TweakXL",
        "red4ext" => "RED4ext",
        "codeware" => "Codeware",
        "redscript" => "redscript",
        "cet" => "Cyber Engine Tweaks",
        "modsettings" => "Mod Settings",
        other => other,
    }
}

/// 本启动器真的能探测的框架。用途是区分「没装」和「我们不认识」：
/// 前者要报缺失，后者只能标"未核对"——否则玩家会被引去追一个我们自己也
/// 定位不到的东西，而真正的缺失反而被埋掉。
fn is_known_framework(id: &str) -> bool {
    matches!(
        id,
        "archivexl" | "tweakxl" | "red4ext" | "codeware" | "redscript" | "cet" | "modsettings"
    )
}

fn normalize(framework: &str) -> String {
    let lowered = framework.trim().to_ascii_lowercase();
    let squeezed = lowered
        .chars()
        .filter(|ch| !matches!(ch, '_' | '-' | '.' | ' '))
        .collect::<String>();
    for (alias, id) in ALIASES {
        let alias_squeezed = alias
            .chars()
            .filter(|ch| !matches!(ch, '_' | '-' | '.' | ' '))
            .collect::<String>();
        if squeezed == alias_squeezed {
            return (*id).to_string();
        }
    }
    // 别名表没命中：不硬猜成某个框架，原样返回让前端按名字搜索。
    framework.trim().to_string()
}

/// 元数据里的一条声明依赖。
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // 只在读取元数据时构造，字段由测试与后续界面使用。
pub struct DeclaredDep {
    pub name: String,
    pub version: Option<String>,
}

/// 元数据读取缓存。
///
/// 为什么需要：`get_diagnostics` 在前端每次切换视图、每次快照变化后都会被调用，
/// 195 个 Mod 意味着每轮 195 次文件读取。键里带 `updated_at` 与 `staging_path`，
/// Mod 被更新/重装后键自然变化，不会读到过期结果。
fn cache() -> &'static Mutex<HashMap<String, Vec<DeclaredDep>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<DeclaredDep>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(entry: &ModEntry) -> String {
    format!(
        "{}|{}|{}",
        entry.staging_path,
        entry.updated_at.as_deref().unwrap_or("-"),
        entry.installed_at
    )
}

/// 从 info.json / manifest.json 里抽 `dependencies` / `requirements` / `requires`。
///
/// 三个键都试，因为 REDmod 用 `dependencies`、Vortex 的 manifest 用 `dependencies`、
/// 部分手写包写 `requirements`。值是数组还是对象都要认——两种写法在真实 Mod 里
/// 都出现过，只认一种就等于对另一批 Mod 完全失效。
pub fn parse_declared(value: &Value) -> Vec<DeclaredDep> {
    let mut out: Vec<DeclaredDep> = Vec::new();
    for key in ["dependencies", "requirements", "requires"] {
        let Some(node) = value.get(key) else { continue };
        collect(node, 0, &mut out);
    }
    // 去重（保持首次出现顺序），同一个框架被两个键同时声明很常见。
    let mut seen = std::collections::HashSet::new();
    out.retain(|item| seen.insert(item.name.to_ascii_lowercase()));
    out
}

fn collect(node: &Value, depth: usize, out: &mut Vec<DeclaredDep>) {
    // 只递归三层：Vortex 的 `dependencies.mod[].name` 已经是最深的真实形态，
    // 再往下钻只会在畸形 JSON 上白烧 CPU。
    if depth > 3 {
        return;
    }
    match node {
        Value::Array(items) => {
            for item in items {
                collect(item, depth + 1, out);
            }
        }
        Value::String(name) => {
            if !name.trim().is_empty() {
                out.push(DeclaredDep {
                    name: name.trim().to_string(),
                    version: None,
                });
            }
        }
        Value::Object(map) => {
            // `{ "name": "ArchiveXL", "version": "1.20" }` 与
            // `{ "ArchiveXL": "1.20" }` 两种形态都要支持。
            if let Some(Value::String(name)) = map.get("name") {
                let version = map
                    .get("version")
                    .or_else(|| map.get("minVersion"))
                    .or_else(|| map.get("min_version"))
                    .and_then(json_scalar);
                out.push(DeclaredDep {
                    name: name.trim().to_string(),
                    version,
                });
                return;
            }
            for (name, value) in map {
                if matches!(name.as_str(), "mod" | "mods" | "plugins") {
                    collect(value, depth + 1, out);
                    continue;
                }
                // 值可能是版本号，也可能是一整段嵌套对象。
                let version = json_scalar(value);
                if name.trim().is_empty() {
                    continue;
                }
                out.push(DeclaredDep {
                    name: name.trim().to_string(),
                    version,
                });
            }
        }
        _ => {}
    }
}

fn json_scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn read_declared(entry: &ModEntry) -> Vec<DeclaredDep> {
    if let Ok(map) = cache().lock() {
        if let Some(hit) = map.get(&cache_key(entry)) {
            return hit.clone();
        }
    }
    let root = PathBuf::from(&entry.staging_path);
    let mut declared = Vec::new();
    for name in ["info.json", "manifest.json"] {
        let Some(path) = find_ci(&root, name) else {
            continue;
        };
        // 元数据文件超过 512 KB 说明不是元数据（有人往里塞了资源），跳过。
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.len() > 512 * 1024 {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let raw = raw.trim_start_matches('\u{feff}');
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            declared.extend(parse_declared(&value));
        }
    }
    if let Ok(mut map) = cache().lock() {
        // 上限保护：库再大也不会无限增长（一个键对应一个 Mod 的当前版本）。
        if map.len() > 4096 {
            map.clear();
        }
        map.insert(cache_key(entry), declared.clone());
    }
    declared
}

fn find_ci(root: &Path, name: &str) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    for entry in fs::read_dir(root).ok()?.flatten() {
        if entry.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            return Some(entry.path());
        }
    }
    None
}

/// 把 `1.20.3` / `v1.20` 解析成数字序列。解析不出返回 None（无法比较）。
fn version_tuple(raw: &str) -> Option<Vec<u64>> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let mut parts = Vec::new();
    for chunk in trimmed.split(['.', '-', '_', ' ']) {
        if chunk.is_empty() {
            break;
        }
        // 遇到 `1.20b` 这种尾部带字母的段落，只取前导数字。
        let digits: String = chunk.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if digits.is_empty() {
            break;
        }
        parts.push(digits.parse::<u64>().ok()?);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

/// `installed >= required` 为 true。任一侧解析不出就返回 true：
/// 拿不到版本不能判成"不满足"，否则所有读不到文件版本资源的框架都会误报。
pub fn version_satisfies(installed: Option<&str>, required: Option<&str>) -> bool {
    let (Some(installed), Some(required)) = (installed, required) else {
        return true;
    };
    let (Some(left), Some(right)) = (version_tuple(installed), version_tuple(required)) else {
        return true;
    };
    let len = left.len().max(right.len());
    for index in 0..len {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    true
}

fn lower(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

/// 从部署清单里推断依赖。返回 (框架 id, 依据)。
fn rule_requirements(entry: &ModEntry) -> Vec<(String, &'static str, String)> {
    let mut out: Vec<(String, &'static str, String)> = Vec::new();
    let files: Vec<String> = entry.planned_files.iter().map(|path| lower(path)).collect();

    for rule in FILE_RULES {
        // `init.lua` 只在 CET 布局下认：少数 Mod 会在别处放同名文件，
        // 单凭文件名判断会把非 CET 模组也标成缺 CET。
        if rule.suffix == "init.lua" {
            let hit = entry.layout == crate::schema::InstallLayout::Cet
                && files.iter().any(|path| path.ends_with("init.lua"));
            if hit {
                out.push((
                    rule.framework.to_string(),
                    "fileRule",
                    rule.detail.to_string(),
                ));
            }
            continue;
        }
        if files.iter().any(|path| path.ends_with(rule.suffix)) {
            out.push((
                rule.framework.to_string(),
                "fileRule",
                rule.detail.to_string(),
            ));
        }
    }

    // 布局兜底：REDmod 之外，CET / redscript 布局本身就说明框架依赖。
    if entry.layout == crate::schema::InstallLayout::Cet {
        out.push((
            "cet".to_string(),
            "layout",
            "CET 布局的 Lua 模组".to_string(),
        ));
    }
    if entry.layout == crate::schema::InstallLayout::Redscript {
        out.push((
            "redscript".to_string(),
            "layout",
            "零散 .reds 脚本".to_string(),
        ));
    }

    // 同一个框架可能被多条规则命中，去重保留第一条依据。
    let mut seen = std::collections::HashSet::new();
    out.retain(|(id, _, _)| seen.insert(id.clone()));
    out
}

/// 库内自带的框架能力：框架 id → 带它的 Mod 名。
///
/// 只看**已启用**的 Mod：一个禁用中的整合包不会真的把 dll 部署进游戏，
/// 拿它当"满足"是假阴性，比报缺失更危险。
fn bundled_capabilities(mods: &[ModEntry]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for entry in mods.iter().filter(|item| item.enabled) {
        for path in &entry.planned_files {
            let lowered = lower(path);
            for (framework, signatures) in CORE_FILES {
                if out.contains_key(*framework) {
                    continue;
                }
                if signatures
                    .iter()
                    .any(|signature| lowered.ends_with(signature))
                {
                    out.insert((*framework).to_string(), entry.name.clone());
                }
            }
        }
    }
    out
}

fn framework_index(frameworks: &[FrameworkStatus]) -> HashMap<String, &FrameworkStatus> {
    frameworks
        .iter()
        .map(|item| (item.id.to_ascii_lowercase(), item))
        .collect()
}

/// 主入口：纯函数，方便用造出来的 Mod / 框架列表跑测试。
pub fn build_report(mods: &[ModEntry], frameworks: &[FrameworkStatus]) -> DependencyReport {
    let installed = framework_index(frameworks);
    let bundled = bundled_capabilities(mods);
    let mut out = Vec::new();

    for entry in mods {
        // 框架自己不需要自己。名字判定与 AI 译名跳过用的是同一套规则，
        // 避免"ArchiveXL 缺 ArchiveXL"这类荒谬提示。
        if crate::ai::is_framework_name(&entry.name) {
            continue;
        }

        let mut requirements: Vec<DependencyRequirement> = Vec::new();
        for (framework, source, detail) in rule_requirements(entry) {
            requirements.push(make_requirement(
                &framework,
                source,
                detail,
                None,
                &installed,
                &bundled,
            ));
        }
        for declared in read_declared(entry) {
            let framework = normalize(&declared.name);
            // 规则库已经推断过的框架，只用元数据补版本要求，不重复出一条。
            if let Some(existing) = requirements.iter_mut().find(|item| item.id == framework) {
                if declared.version.is_some() {
                    existing.required_version = declared.version.clone();
                    existing.version_ok =
                        version_satisfies(existing.installed_version.as_deref(), declared.version.as_deref());
                }
                existing.source = "metadata".to_string();
                continue;
            }
            let mut item = make_requirement(
                &framework,
                "metadata",
                format!("元数据声明依赖 {}", declared.name),
                declared.version.clone(),
                &installed,
                &bundled,
            );
            item.version_ok = version_satisfies(
                item.installed_version.as_deref(),
                declared.version.as_deref(),
            );
            requirements.push(item);
        }

        if requirements.is_empty() {
            continue;
        }

        let missing: Vec<String> = requirements
            .iter()
            .filter(|item| !item.satisfied)
            .map(|item| item.name.clone())
            .collect();
        let mismatched = requirements
            .iter()
            .any(|item| item.satisfied && !item.version_ok);
        let status = if !missing.is_empty() {
            "missing"
        } else if mismatched {
            "versionMismatch"
        } else {
            "healthy"
        };

        out.push(ModDependencyStatus {
            mod_id: entry.id.clone(),
            mod_name: entry.name.clone(),
            enabled: entry.enabled,
            status: status.to_string(),
            requirements,
            missing,
        });
    }

    let missing_enabled = out
        .iter()
        .filter(|item| item.enabled && item.status == "missing")
        .count();
    let mismatch_enabled = out
        .iter()
        .filter(|item| item.enabled && item.status == "versionMismatch")
        .count();

    DependencyReport {
        checked_at: now_iso(),
        checked_mods: out.len(),
        mods: out,
        missing_enabled,
        mismatch_enabled,
    }
}

fn make_requirement(
    framework: &str,
    source: &str,
    detail: String,
    required_version: Option<String>,
    installed: &HashMap<String, &FrameworkStatus>,
    bundled: &HashMap<String, String>,
) -> DependencyRequirement {
    let status = installed.get(&framework.to_ascii_lowercase()).copied();
    let installed_version = status.and_then(|item| item.version.clone());
    let known = is_known_framework(framework);
    let game_ok = status.map(|item| item.installed).unwrap_or(false);
    let bundled_by = bundled.get(framework).cloned();

    // 未知框架：我们根本没有探测手段，标成满足并注明"未核对"，
    // 报缺失只会让玩家去追一个我们自己也定位不到的东西。
    let satisfied = game_ok || bundled_by.is_some() || !known;
    let satisfied_by = if game_ok {
        Some("game".to_string())
    } else {
        bundled_by.map(|name| format!("bundled:{name}"))
    };
    let version_ok = version_satisfies(installed_version.as_deref(), required_version.as_deref());

    DependencyRequirement {
        id: framework.to_string(),
        name: if known {
            display_name(framework).to_string()
        } else {
            framework.to_string()
        },
        source: source.to_string(),
        detail: if known {
            detail
        } else {
            format!("{detail}（该框架本机无法自动核对）")
        },
        satisfied,
        satisfied_by,
        required_version,
        installed_version,
        version_ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::InstallLayout;

    fn framework(id: &str, installed: bool, version: Option<&str>) -> FrameworkStatus {
        FrameworkStatus {
            id: id.to_string(),
            name: display_name(id).to_string(),
            installed,
            required: false,
            path: None,
            version: version.map(ToString::to_string),
            note: String::new(),
        }
    }

    fn mod_entry(id: &str, name: &str, files: &[&str]) -> ModEntry {
        ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: name.to_string(),
            version: None,
            author: None,
            category: "misc".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: None,
            // 不存在的目录：元数据读取会安静地返回空，正好覆盖"没有 info.json"。
            staging_path: format!("Z:/__cdl_test_missing__/{id}"),
            cover_path: None,
            enabled: true,
            installed_at: "2026-10-30T00:00:00Z".to_string(),
            updated_at: None,
            size_bytes: 0,
            file_count: files.len(),
            layout: InstallLayout::Archive,
            mod_folder: None,
            metadata_source: "filename".to_string(),
            planned_files: files.iter().map(|path| path.to_string()).collect(),
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

    fn status_of(report: &DependencyReport, mod_id: &str) -> String {
        report
            .mods
            .iter()
            .find(|item| item.mod_id == mod_id)
            .map(|item| item.status.clone())
            .unwrap_or_else(|| "none".to_string())
    }

    #[test]
    fn xl_file_requires_archivexl() {
        let mods = vec![mod_entry("a", "Cool Outfit", &["archive/pc/mod/cool.xl"])];
        let report = build_report(&mods, &[]);
        let item = &report.mods[0];
        assert_eq!(item.status, "missing");
        assert_eq!(item.missing, vec!["ArchiveXL".to_string()]);
        assert_eq!(item.requirements[0].source, "fileRule");
    }

    #[test]
    fn reds_file_requires_redscript() {
        let mods = vec![mod_entry("a", "Tweak Pack", &["r6/scripts/pack.reds"])];
        let report = build_report(&mods, &[]);
        assert_eq!(report.mods[0].missing, vec!["redscript".to_string()]);
    }

    #[test]
    fn tweak_file_requires_tweakxl() {
        let mods = vec![mod_entry("a", "Balance", &["r6/tweaks/balance.tweak"])];
        let report = build_report(&mods, &[]);
        assert_eq!(report.mods[0].missing, vec!["TweakXL".to_string()]);
    }

    #[test]
    fn plain_archive_needs_nothing() {
        let mods = vec![mod_entry("a", "Vanilla Archive", &["archive/pc/mod/a.archive"])];
        let report = build_report(&mods, &[]);
        assert!(report.mods.is_empty(), "纯 archive 不该推断出任何依赖");
        assert_eq!(report.missing_enabled, 0);
    }

    #[test]
    fn installed_framework_marks_healthy() {
        let mods = vec![mod_entry("a", "Cool Outfit", &["archive/pc/mod/cool.xl"])];
        let frameworks = vec![
            framework("archivexl", true, Some("1.20.0")),
            framework("red4ext", true, Some("1.27.0")),
        ];
        let report = build_report(&mods, &frameworks);
        assert_eq!(report.mods[0].status, "healthy");
        assert_eq!(report.missing_enabled, 0);
        assert_eq!(
            report.mods[0].requirements[0].satisfied_by.as_deref(),
            Some("game")
        );
    }

    /// 整合包把前置一起打包时不能报缺失（任务书里的「防误报」）。
    #[test]
    fn bundled_dll_satisfies_dependency() {
        let mods = vec![
            mod_entry("a", "Cool Outfit", &["archive/pc/mod/cool.xl"]),
            mod_entry(
                "b",
                "Mega Pack",
                &["red4ext/plugins/ArchiveXL/ArchiveXL.dll"],
            ),
        ];
        let report = build_report(&mods, &[]);
        let outfit = report
            .mods
            .iter()
            .find(|item| item.mod_id == "a")
            .expect("outfit 应该在报告里");
        assert_eq!(outfit.status, "healthy");
        assert_eq!(
            outfit.requirements[0].satisfied_by.as_deref(),
            Some("bundled:Mega Pack")
        );
    }

    /// 禁用中的整合包不算自带：它没有部署进游戏，不能当满足。
    #[test]
    fn disabled_bundle_does_not_satisfy() {
        let mut bundle = mod_entry(
            "b",
            "Mega Pack",
            &["red4ext/plugins/ArchiveXL/ArchiveXL.dll"],
        );
        bundle.enabled = false;
        let mods = vec![mod_entry("a", "Cool Outfit", &["archive/pc/mod/cool.xl"]), bundle];
        let report = build_report(&mods, &[]);
        assert_eq!(status_of(&report, "a"), "missing");
    }

    #[test]
    fn framework_itself_is_skipped() {
        let mods = vec![mod_entry(
            "a",
            "ArchiveXL",
            &["red4ext/plugins/ArchiveXL/ArchiveXL.dll"],
        )];
        let report = build_report(&mods, &[]);
        assert!(report.mods.is_empty());
    }

    #[test]
    fn version_mismatch_detected() {
        let mods = vec![mod_entry("a", "Cool Outfit", &["archive/pc/mod/cool.xl"])];
        let frameworks = vec![framework("archivexl", true, Some("1.18.0"))];
        // 直接给一条带版本要求的规则，模拟元数据声明 minVersion 1.20。
        let mut requirement = make_requirement(
            "archivexl",
            "metadata",
            "元数据声明依赖 ArchiveXL".to_string(),
            Some("1.20".to_string()),
            &framework_index(&frameworks),
            &HashMap::new(),
        );
        assert!(requirement.satisfied);
        assert!(!requirement.version_ok);
        requirement.required_version = Some("1.20".to_string());
        assert!(!version_satisfies(Some("1.18.0"), Some("1.20")));
        assert!(version_satisfies(Some("1.20.3"), Some("1.20")));
        assert!(version_satisfies(Some("1.21"), Some("1.20")));
        // 读不到版本时不能误判成不满足。
        assert!(version_satisfies(None, Some("9.9")));
        assert!(version_satisfies(Some("1.0"), None));
        let _ = &mods;
    }

    #[test]
    fn version_mismatch_sets_status() {
        let mut entry = mod_entry("a", "Cool Outfit", &["archive/pc/mod/cool.xl"]);
        entry.staging_path = format!("Z:/__cdl_test_missing__/{}", entry.id);
        let frameworks = vec![framework("archivexl", true, Some("1.18.0"))];
        let mut report = build_report(&[entry], &frameworks);
        // 手工把版本要求塞进去：等价于元数据声明了 minVersion 1.20。
        report.mods[0].requirements[0].required_version = Some("1.20".to_string());
        report.mods[0].requirements[0].version_ok = false;
        let mismatched = report.mods[0]
            .requirements
            .iter()
            .any(|item| item.satisfied && !item.version_ok);
        assert!(mismatched);
    }

    #[test]
    fn declared_metadata_is_parsed() {
        let raw = serde_json::json!({
            "name": "Cool Outfit",
            "dependencies": [
                { "name": "ArchiveXL", "version": "1.20" },
                "TweakXL"
            ]
        });
        let declared = parse_declared(&raw);
        assert_eq!(declared.len(), 2);
        assert_eq!(declared[0].name, "ArchiveXL");
        assert_eq!(declared[0].version.as_deref(), Some("1.20"));
        assert_eq!(declared[1].name, "TweakXL");
        assert!(declared[1].version.is_none());
    }

    #[test]
    fn vortex_manifest_dependencies_parsed() {
        let raw = serde_json::json!({
            "name": "Cool Outfit",
            "dependencies": { "mod": [ { "name": "Codeware" } ] }
        });
        let declared = parse_declared(&raw);
        assert_eq!(declared.len(), 1);
        assert_eq!(declared[0].name, "Codeware");
    }

    #[test]
    fn alias_normalisation() {
        assert_eq!(normalize("Archive XL"), "archivexl");
        assert_eq!(normalize("cyber_engine_tweaks"), "cet");
        assert_eq!(normalize("CET"), "cet");
        assert_eq!(normalize("Mod-Settings"), "modsettings");
        assert_eq!(normalize("Native Interactions"), "Native Interactions");
    }

    /// 未知框架不报缺失：我们没有核对手段，报了只会制造噪音。
    #[test]
    fn unknown_framework_is_not_reported_missing() {
        let requirement = make_requirement(
            "Native Interactions",
            "metadata",
            "元数据声明依赖 Native Interactions".to_string(),
            None,
            &HashMap::new(),
            &HashMap::new(),
        );
        assert!(requirement.satisfied);
        assert!(requirement.satisfied_by.is_none());
    }
}
