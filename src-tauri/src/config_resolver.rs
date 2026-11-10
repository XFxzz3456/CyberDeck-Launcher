//! 按 Mod 找到它真正拥有的配置项，而不是遍历所有配置文件。
//!
//! 背景：CP2077 的 Mod 配置分散在多个框架里，格式各不相同。粗暴地给每个 Mod
//! 都生成一个设置表单（尤其是给 redscript / ArchiveXL / TweakXL 这类纯内容层）
//! 只会制造假选项。这个模块把「配置归属」显式建模：
//!
//! - `resolve_for_mod`：只返回某个 Mod 自己的配置，空 Vec 表示它不需要玩家设置。
//! - `resolve_global_configs`：框架级配置（RED4ext / CET / AudioXL），属于全局设置页。
//! - `save_field`：按 source 分派写入，**只 patch 目标 key**，绝不整文件覆盖。
//!
//! 支持的框架（按优先级，见 `resolve_for_mod`）：
//! 1. Mod Settings 的 `user.ini`（RED4ext 版优先，退到 CET 版）—— redscript/CET 通用。
//! 2. Mod 自己目录下的 `config.json` / `settings.json`（CET / Lua 模组常见）。
//! 3. Native Interactions 的 `projects/<Mod>.json`（只读）。
//! 4. AudioXL 的 `.ini`。
//! 5. CET 全局 `config.json`（只读兜底：装了 CET 但没有任何自己的配置时）。
//!
//! 关键陷阱（都写在对应函数上方）：
//! 1. RED4ext 的 `config.ini` 扩展名是 .ini，内容其实是 TOML，必须用 toml 解析。
//! 2. Native Interactions 的 JSON 是交互点定义，玩家手改容易把 Mod 弄坏，默认只读。
//! 3. Section 名与 Mod 名常常不一致（`[BetterVehicleHandling]` vs
//!    "Better Vehicle Handling"），匹配要靠归一化后包含，但不能把无关 Mod 硬绑。

use crate::game::validate_game_dir;
use crate::modsettings::{replace_file, update_ini_text};
use crate::schema::{AppResult, CommandError, ModEntry};
use crate::store::Store;
use ini::Ini;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 单个配置文件的读取上限。配置都是纯文本，超过这个尺寸一定是读错了目标。
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 单个来源最多展示多少字段，防止某个异常 ini 撑爆前端。
const MAX_FIELDS: usize = 400;
/// 原始文本（Native Interactions JSON）给前端的最大字符数。
const MAX_RAW_CHARS: usize = 200_000;
/// 单个设置值的最大长度（与 modsettings 保持一致）。
const MAX_VALUE_CHARS: usize = 4096;

/// 这些 section 名属于框架自身，不是任何一个 Mod 的配置。
/// 不排除的话 `[General]` 会把整库的 Mod 都绑到同一份配置上。
const RESERVED_SECTIONS: &[&str] = &["general", "modsettings", "settings", "global", "default"];

/// CET 模组目录前缀（框架自身的文件不算任何一个模组的配置）。
const CET_MODS_PREFIX: &str = "bin/x64/plugins/cyber_engine_tweaks/mods/";

/// 一条面向玩家的配置项。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingField {
    pub section: String,
    pub key: String,
    pub value: String,
    /// bool / number / string，前端据此选择开关、数字输入或文本框。
    pub kind: String,
    /// 给人看的标签：`show_minimap` → `show minimap`。
    pub label: String,
}

/// 一个配置来源，对应磁盘上的一个文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSource {
    /// mod_settings / native_interactions
    pub id: String,
    pub label: String,
    pub path: String,
    /// ini / json / toml
    pub format: String,
    /// 是否允许在详情页直接改。Native Interactions 为 false（只读 + 高级编辑）。
    pub editable: bool,
    pub fields: Vec<SettingField>,
    /// 原始文本，仅只读来源带（用于高级查看/校验）。
    pub raw: Option<String>,
    pub note: Option<String>,
}

/// 某个 Mod 的配置汇总。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModConfigView {
    pub mod_id: String,
    pub sources: Vec<ConfigSource>,
    pub warnings: Vec<String>,
}

/// 全局配置的一个展平条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConfigEntry {
    /// 展平后的显示键。CET 的 JSON 用 `first.second` 形式。
    pub key: String,
    pub value: String,
    /// 0 = 顶层键，1 = 二级，依此类推。前端据此缩进。
    pub depth: u8,
}

/// 一个框架的全局配置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConfigGroup {
    pub id: String,
    pub label: String,
    pub path: String,
    pub format: String,
    pub exists: bool,
    pub entries: Vec<GlobalConfigEntry>,
    pub note: Option<String>,
}

/// 全局配置集合。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConfigGroups {
    pub groups: Vec<GlobalConfigGroup>,
}

/// 配置解析器。持有游戏根目录，所有读取都限制在它下面。
pub struct ConfigResolver {
    game_dir: PathBuf,
    /// 解析过程中遇到的「文件在、但读不出来 / 格式坏了」。
    ///
    /// 以前这些错误被 `.ok()?` 静默吞掉，于是详情页永远显示「这个 Mod 没有可调
    /// 参数」，用户完全不知道自己装的 Mod 配置文件是坏的（2026-11-06 审计 P1-11）。
    /// 现在统一收集起来，作为 warnings 回传，抽屉照常能打开。
    problems: std::cell::RefCell<Vec<String>>,
}

impl ConfigResolver {
    pub fn new(game_dir: impl Into<PathBuf>) -> Self {
        Self {
            game_dir: game_dir.into(),
            problems: std::cell::RefCell::new(Vec::new()),
        }
    }

    /// 记一条「读得到但解析不了」的问题，并继续找下一个来源。
    fn note(&self, message: String) {
        let mut problems = self.problems.borrow_mut();
        // 同一个文件可能被多个探测分支撞到，去重避免提示刷屏。
        if !problems.iter().any(|item| item == &message) {
            problems.push(message);
        }
    }

    /// 游戏根目录（测试与诊断用）。
    #[allow(dead_code)]
    pub fn game_dir(&self) -> &Path {
        &self.game_dir
    }

    /// 返回某个 Mod 专属的配置来源 + 解析过程中产生的问题。
    ///
    /// 顺序即优先级：同一个 Mod 可能同时命中多处（比如既有 user.ini 段、又带自己的
    /// settings.json），全部返回，前端按来源分组展示。
    ///
    /// 不再返回 `Result`：单个来源读坏了不该让整页失败，问题一律走第二返回值。
    pub fn resolve_for_mod(&self, entry: &ModEntry) -> (Vec<ConfigSource>, Vec<String>) {
        let candidates = candidate_names(entry);
        let mut sources = Vec::new();

        // 1) Mod Settings 的 user.ini：redscript 与 CET 模组共用的生态约定。
        if !candidates.is_empty() {
            if let Some(source) = self.mod_settings_for(&candidates) {
                sources.push(source);
            }
        }
        // 2) Mod 自己目录下的 JSON（CET / Lua 模组）。
        if let Some(source) = self.mod_json_for(entry) {
            sources.push(source);
        }
        // 3) Native Interactions 项目定义（只读）。
        if !candidates.is_empty() {
            if let Some(source) = self.native_interactions_for(entry, &candidates) {
                sources.push(source);
            }
        }
        // 4) AudioXL 的 ini。
        if let Some(source) = self.audioxl_for(entry) {
            sources.push(source);
        }
        // 5) 兜底：装了 CET 的 Mod 至少能看到 CET 全局配置（只读），
        //    比「什么都没有」更有解释力，也不会误导玩家去改别人的模组。
        if sources.is_empty() && entry.has_cet {
            if let Some(source) = self.cet_global_for_mod() {
                sources.push(source);
            }
        }
        let problems = self.problems.borrow().clone();
        (sources, problems)
    }

    /// 框架级全局配置，供设置页的「框架配置」区块使用。
    pub fn resolve_global_configs(&self) -> GlobalConfigGroups {
        GlobalConfigGroups {
            groups: vec![
                self.red4ext_config(),
                self.cet_config(),
                self.audioxl_config(),
            ],
        }
    }

    /// Mod Settings 的 `user.ini`。历史上存在两个发行位置：CET 版和 RED4ext 版，
    /// 两个都探，优先 RED4ext（新版框架），因为玩家很可能同时装过。
    fn mod_settings_for(&self, candidates: &[String]) -> Option<ConfigSource> {
        let mut candidates_paths = vec![
            self.game_dir
                .join("red4ext")
                .join("plugins")
                .join("mod_settings")
                .join("user.ini"),
            self.game_dir
                .join("bin")
                .join("x64")
                .join("plugins")
                .join("cyber_engine_tweaks")
                .join("mods")
                .join("ModSettings")
                .join("user.ini"),
        ];
        candidates_paths.retain(|path| path.is_file());
        let path = candidates_paths.into_iter().next()?;
        let text = match read_text(&path) {
            Ok(text) => text,
            Err(err) => {
                self.note(format!("读不到 {}：{err}", path.display()));
                return None;
            }
        };
        let ini = match Ini::load_from_str(text.trim_start_matches('\u{feff}')) {
            Ok(ini) => ini,
            Err(err) => {
                self.note(format!("{} 不是合法的 INI：{err}", path.display()));
                return None;
            }
        };

        let mut fields = Vec::new();
        for (section, properties) in &ini {
            let Some(name) = section.as_deref() else {
                continue;
            };
            if RESERVED_SECTIONS.contains(&normalize_key(name).as_str()) {
                continue;
            }
            if !name_matches(name, candidates) {
                continue;
            }
            for (key, value) in properties.iter() {
                if fields.len() >= MAX_FIELDS {
                    break;
                }
                fields.push(SettingField {
                    section: name.to_string(),
                    key: key.to_string(),
                    value: value.to_string(),
                    kind: infer_kind(value).to_string(),
                    label: humanize(key),
                });
            }
        }
        if fields.is_empty() {
            return None;
        }
        Some(ConfigSource {
            id: "mod_settings".to_string(),
            label: "Mod Settings".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "ini".to_string(),
            editable: true,
            fields,
            raw: None,
            note: Some("改完直接写回 user.ini，写前会留一份 .bak。".to_string()),
        })
    }

    /// Native Interactions 的项目 JSON。
    ///
    /// 优先用这台 Mod 的部署清单反查（最精确，不会认错），退化为按文件名匹配。
    /// 内容只读：这些 JSON 是交互点定义，写坏了 Mod 直接不工作。
    fn native_interactions_for(
        &self,
        entry: &ModEntry,
        candidates: &[String],
    ) -> Option<ConfigSource> {
        let projects = self
            .game_dir
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("mods")
            .join("nativeInteractions")
            .join("projects");
        if !projects.is_dir() {
            return None;
        }

        // 1) 从部署清单里找本 Mod 写进去的 projects/*.json（最可靠）。
        let mut target: Option<PathBuf> = None;
        for file in &entry.deployed_files {
            let rel = file.relative_path.replace('\\', "/");
            if rel.contains("nativeInteractions/projects/") && rel.ends_with(".json") {
                let name = rel.rsplit('/').next().unwrap_or_default();
                let path = projects.join(name);
                if path.is_file() {
                    target = Some(path);
                    break;
                }
            }
        }

        // 2) 退化：扫目录按文件名匹配。
        if target.is_none() {
            let mut entries: Vec<PathBuf> = fs::read_dir(&projects)
                .ok()?
                .filter_map(|item| item.ok())
                .map(|item| item.path())
                .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
                .collect();
            entries.sort();
            for path in entries {
                let stem = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or_default();
                if name_matches(stem, candidates) {
                    target = Some(path);
                    break;
                }
            }
        }

        let path = target?;
        let text = match read_text(&path) {
            Ok(text) => text,
            Err(err) => {
                self.note(format!("读不到 {}：{err}", path.display()));
                return None;
            }
        };
        // 语法自检：能解析才展示，解析不了就明确告诉玩家文件坏了。
        let readable = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).is_ok();
        if !readable {
            self.note(format!("{} 不是合法的 JSON，已按只读原文展示。", path.display()));
        }
        let raw = if text.chars().count() > MAX_RAW_CHARS {
            None
        } else {
            Some(text)
        };
        Some(ConfigSource {
            id: "native_interactions".to_string(),
            label: "Native Interactions".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "json".to_string(),
            editable: false,
            fields: Vec::new(),
            raw,
            note: Some(if readable {
                "交互点定义文件，默认只读。需要手动改时用「高级编辑」，启动器会先备份。".to_string()
            } else {
                "这个文件不是有效 JSON，可能是 Mod 版本不匹配或写入中断。".to_string()
            }),
        })
    }

    /// 部署清单里的相对路径 → 游戏目录下的真实路径。
    ///
    /// 相对路径是导入时写进状态的，但仍然当不可信输入处理：拒绝绝对路径、盘符和
    /// `..`，保证最终路径一定落在游戏目录内（写文件时还会再 canonicalize 一次）。
    fn deployed_file_path(&self, relative: &str) -> Option<PathBuf> {
        let cleaned = relative.replace('\\', "/");
        if cleaned.is_empty()
            || cleaned.starts_with('/')
            || cleaned.contains("..")
            || cleaned.contains(':')
        {
            return None;
        }
        let mut path = self.game_dir.clone();
        for segment in cleaned.split('/') {
            if segment.is_empty() || segment == "." {
                continue;
            }
            path.push(segment);
        }
        path.is_file().then_some(path)
    }

    /// 部署清单里第一个满足条件的文件（相对路径已转小写，便于匹配）。
    fn find_deployed<F>(&self, entry: &ModEntry, predicate: F) -> Option<(String, PathBuf)>
    where
        F: Fn(&str) -> bool,
    {
        for file in &entry.deployed_files {
            let rel = file.relative_path.replace('\\', "/");
            if !predicate(&rel.to_ascii_lowercase()) {
                continue;
            }
            if let Some(path) = self.deployed_file_path(&rel) {
                return Some((rel, path));
            }
        }
        None
    }

    /// CET / Lua 模组自己目录下的 `config.json` / `settings.json`。
    ///
    /// 只认部署清单里真实存在的那份：玩家已经部署的文件才是游戏实际读到的。
    /// 路径必须在 `cyber_engine_tweaks/mods/<某个模组>/` 下面，框架自身的
    /// `mods/config.json` 不算（那是全局的，见 `cet_global_for_mod`）。
    fn mod_json_for(&self, entry: &ModEntry) -> Option<ConfigSource> {
        let (rel, path) = self.find_deployed(entry, |lower| {
            lower.contains(CET_MODS_PREFIX)
                && (lower.ends_with("/config.json")
                    || lower.ends_with("/settings.json")
                    || lower.ends_with("/userconfig.json"))
        })?;
        // `mods/config.json` 属于框架级，没有模组目录这一层。
        let after = rel.split(CET_MODS_PREFIX).nth(1)?;
        if !after.contains('/') {
            return None;
        }
        let text = match read_text(&path) {
            Ok(text) => text,
            Err(err) => {
                self.note(format!("读不到 {}：{err}", path.display()));
                return None;
            }
        };
        let value = match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
            Ok(value) => value,
            Err(err) => {
                self.note(format!("{} 不是合法的 JSON：{err}", path.display()));
                return None;
            }
        };
        let mut fields = Vec::new();
        json_scalar_fields(&value, "", &mut fields);
        if fields.is_empty() {
            return None;
        }
        Some(ConfigSource {
            id: "mod_json".to_string(),
            label: "Mod 配置".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "json".to_string(),
            editable: true,
            fields,
            raw: None,
            note: Some(
                "改完只写回你动过的那一项，其它键保持原样。写入前会备份为 .bak。"
                    .to_string(),
            ),
        })
    }

    /// AudioXL 的 ini：这个 Mod 自己部署的 `.ini` 才算。
    fn audioxl_for(&self, entry: &ModEntry) -> Option<ConfigSource> {
        let (_rel, path) =
            self.find_deployed(entry, |lower| lower.contains("audioxl/") && lower.ends_with(".ini"))?;
        let text = match read_text(&path) {
            Ok(text) => text,
            Err(err) => {
                self.note(format!("读不到 {}：{err}", path.display()));
                return None;
            }
        };
        let ini = match Ini::load_from_str(text.trim_start_matches('\u{feff}')) {
            Ok(ini) => ini,
            Err(err) => {
                self.note(format!("{} 不是合法的 INI：{err}", path.display()));
                return None;
            }
        };
        let fields = ini_fields(&ini);
        if fields.is_empty() {
            return None;
        }
        Some(ConfigSource {
            id: "audioxl".to_string(),
            label: "AudioXL".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "ini".to_string(),
            editable: true,
            fields,
            raw: None,
            note: Some("按 section/key 逐行改，注释与顺序保持原样。".to_string()),
        })
    }

    /// CET 的全局 `config.json`，只读兜底。
    ///
    /// 它不属于任何单个模组，改了一处会影响全部 CET 脚本，因此不提供写入，
    /// 只在「这个 Mod 装有 CET 特征但没有任何自己的配置」时给玩家一个解释。
    fn cet_global_for_mod(&self) -> Option<ConfigSource> {
        let path = self
            .game_dir
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("config.json");
        if !path.is_file() {
            return None;
        }
        let text = match read_text(&path) {
            Ok(text) => text,
            Err(err) => {
                self.note(format!("读不到 {}：{err}", path.display()));
                return None;
            }
        };
        let value = match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
            Ok(value) => value,
            Err(err) => {
                self.note(format!("{} 不是合法的 JSON：{err}", path.display()));
                return None;
            }
        };
        let mut fields = Vec::new();
        json_scalar_fields(&value, "", &mut fields);
        if fields.is_empty() {
            return None;
        }
        Some(ConfigSource {
            id: "cet_global".to_string(),
            label: "CET 全局配置".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "json".to_string(),
            editable: false,
            fields,
            raw: None,
            note: Some(
                "这是 Cyber Engine Tweaks 的全局配置，影响所有 CET 模组，启动器只读不写。"
                    .to_string(),
            ),
        })
    }

    /// RED4ext 的 `config.ini`。
    ///
    /// **扩展名骗人**：官方文档明确写「Even if the configuration file has ini
    /// extension, in fact, it is a TOML file」。用 ini 解析器会直接失败。
    fn red4ext_config(&self) -> GlobalConfigGroup {        let path = self.game_dir.join("red4ext").join("config.ini");
        let mut group = GlobalConfigGroup {
            id: "red4ext".to_string(),
            label: "RED4ext".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "toml".to_string(),
            exists: path.is_file(),
            entries: Vec::new(),
            note: Some("文件名是 .ini，内容其实是 TOML。启动器按 TOML 解析。".to_string()),
        };
        if !group.exists {
            return group;
        }
        match read_text(&path) {
            Ok(text) => {
                let cleaned = text.trim_start_matches('\u{feff}');
                match toml::from_str::<toml::Value>(cleaned) {
                    Ok(value) => flatten_toml(&value, "", 0, &mut group.entries),
                    Err(err) => {
                        group.note = Some(format!("TOML 解析失败，可能被手动改坏了：{err}"));
                    }
                }
            }
            Err(err) => group.note = Some(err),
        }
        group
    }

    /// CET 的 `config.json`，两层结构，展平成 `a.b`。
    fn cet_config(&self) -> GlobalConfigGroup {
        let path = self
            .game_dir
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("config.json");
        let mut group = GlobalConfigGroup {
            id: "cet".to_string(),
            label: "Cyber Engine Tweaks".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "json".to_string(),
            exists: path.is_file(),
            entries: Vec::new(),
            note: None,
        };
        if !group.exists {
            return group;
        }
        match read_text(&path) {
            Ok(text) => {
                match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
                    Ok(value) => flatten_json(&value, "", 0, &mut group.entries),
                    Err(err) => group.note = Some(format!("JSON 解析失败：{err}")),
                }
            }
            Err(err) => group.note = Some(err),
        }
        group
    }

    /// AudioXL 的 ini，全局只读。
    fn audioxl_config(&self) -> GlobalConfigGroup {
        let path = self
            .game_dir
            .join("red4ext")
            .join("plugins")
            .join("AudioXL")
            .join("AudioXL.ini");
        let mut group = GlobalConfigGroup {
            id: "audioxl".to_string(),
            label: "AudioXL".to_string(),
            path: path.to_string_lossy().to_string(),
            format: "ini".to_string(),
            exists: path.is_file(),
            entries: Vec::new(),
            note: Some("全局音频扩展配置，不绑定到单个 Mod。".to_string()),
        };
        if !group.exists {
            return group;
        }
        match read_text(&path) {
            Ok(text) => match Ini::load_from_str(text.trim_start_matches('\u{feff}')) {
                Ok(ini) => {
                    for (section, properties) in &ini {
                        let section_name = section.as_deref().unwrap_or("General");
                        for (key, value) in properties.iter() {
                            if group.entries.len() >= MAX_FIELDS {
                                break;
                            }
                            group.entries.push(GlobalConfigEntry {
                                key: format!("{section_name}.{key}"),
                                value: value.to_string(),
                                depth: 1,
                            });
                        }
                    }
                }
                Err(err) => group.note = Some(format!("INI 解析失败：{err}")),
            },
            Err(err) => group.note = Some(err),
        }
        group
    }
}

/// 读取游戏目录下允许的配置文件。所有路径都由调用方从 game_dir 拼出来，
/// 前端无法把任意路径塞进来。
fn read_text(path: &Path) -> Result<String, String> {
    let meta = fs::symlink_metadata(path).map_err(|err| format!("无法检查 {path:?}：{err}"))?;
    if meta.file_type().is_symlink() {
        return Err("这是个符号链接，为了避免写到游戏目录之外，启动器不读它。".to_string());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件超过 {} KB，不像配置文件，已跳过。",
            MAX_FILE_BYTES / 1024
        ));
    }
    fs::read_to_string(path).map_err(|err| format!("读取失败：{err}"))
}

/// 把一个 ini 的全部 section/key 展平成字段（不做名字过滤：文件已经属于这个 Mod）。
fn ini_fields(ini: &Ini) -> Vec<SettingField> {
    let mut fields = Vec::new();
    for (section, properties) in ini {
        let name = section.as_deref().unwrap_or("General");
        for (key, value) in properties.iter() {
            if fields.len() >= MAX_FIELDS {
                return fields;
            }
            fields.push(SettingField {
                section: name.to_string(),
                key: key.to_string(),
                value: value.to_string(),
                kind: infer_kind(value).to_string(),
                label: humanize(key),
            });
        }
    }
    fields
}

/// 把 JSON 展平成 `a.b.c = 值` 形式的字段。
///
/// JSON 来源没有 ini 的 section 概念，`section` 留空，路径全写在 `key` 里，
/// 前端按第一段分组。只收标量叶子，对象和数组继续往下走。
fn json_scalar_fields(value: &serde_json::Value, prefix: &str, out: &mut Vec<SettingField>) {
    if out.len() >= MAX_FIELDS {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let full = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                json_scalar_fields(child, &full, out);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                json_scalar_fields(child, &format!("{prefix}[{index}]"), out);
            }
        }
        other => {
            let text = match other {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Null => "null".to_string(),
                other => other.to_string(),
            };
            let leaf = prefix.rsplit('.').next().unwrap_or(prefix);
            out.push(SettingField {
                section: String::new(),
                key: if prefix.is_empty() {
                    "value".to_string()
                } else {
                    prefix.to_string()
                },
                label: humanize(leaf),
                kind: infer_kind(&text).to_string(),
                value: text,
            });
        }
    }
}

/// 在 JSON 里按 `a.b.c` 路径改一个标量值。
///
/// 三条硬约束：
/// 1. 路径必须在文件里已存在——不凭空造键，否则会写出游戏读不懂的配置；
/// 2. 只改标量叶子，对象/数组整体不动；
/// 3. 保留原值的类型（原来是 bool 就只接受 true/false，原来是数字就只接受数字）。
fn json_apply_scalar(root: &mut serde_json::Value, path: &str, value: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('[') {
        return Err("这一项在数组里，启动器不在这里改。".to_string());
    }
    let segments: Vec<&str> = path.split('.').collect();
    let mut cursor = root;
    for (index, segment) in segments.iter().enumerate() {
        let last = index + 1 == segments.len();
        let Some(map) = cursor.as_object_mut() else {
            return Err(format!("配置结构里没有 {path}。"));
        };
        let Some(slot) = map.get_mut(*segment) else {
            return Err(format!("配置里没有 {path} 这一项。"));
        };
        if last {
            let next = match slot {
                serde_json::Value::Bool(_) => {
                    serde_json::Value::Bool(parse_bool(value).ok_or("这一项只接受 true / false。")?)
                }
                serde_json::Value::Number(_) => {
                    serde_json::Value::Number(parse_number(value).ok_or("这一项只接受数字。")?)
                }
                serde_json::Value::String(_) => serde_json::Value::String(value.to_string()),
                _ => return Err("这一项不是单值，不能单独修改。".to_string()),
            };
            *slot = next;
            return Ok(());
        }
        cursor = slot;
    }
    Err(format!("配置结构里没有 {path}。"))
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn parse_number(raw: &str) -> Option<serde_json::Number> {
    let trimmed = raw.trim();
    if let Ok(int) = trimmed.parse::<i64>() {
        return Some(serde_json::Number::from(int));
    }
    trimmed
        .parse::<f64>()
        .ok()
        .and_then(serde_json::Number::from_f64)
}

/// 写入前的统一校验：值本身、目标路径、符号链接。
fn validate_write(value: &str) -> AppResult<()> {
    if value.contains('\r') || value.contains('\n') {
        return Err(CommandError::new(
            "CONFIG_INVALID_VALUE",
            "设置值不能包含换行符。",
        ));
    }
    if value.chars().count() > MAX_VALUE_CHARS {
        return Err(CommandError::new(
            "CONFIG_INVALID_VALUE",
            format!("设置值超过 {MAX_VALUE_CHARS} 个字符。"),
        ));
    }
    Ok(())
}

/// 确认目标文件在游戏目录内、不是符号链接，并返回可写的规范路径。
fn writable_target(path: &Path, game_root: &Path) -> AppResult<PathBuf> {
    let meta = fs::symlink_metadata(path)
        .map_err(|err| CommandError::new("CONFIG_INSPECT", format!("无法检查配置文件：{err}")))?;
    if meta.file_type().is_symlink() {
        return Err(CommandError::new(
            "CONFIG_UNSAFE",
            "这个配置文件是符号链接，为了避免写到游戏目录之外，启动器不修改它。",
        ));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(CommandError::new(
            "CONFIG_TOO_LARGE",
            "配置文件过大，拒绝修改。",
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|err| CommandError::new("CONFIG_INSPECT", format!("无法解析路径：{err}")))?;
    let canonical_root = fs::canonicalize(game_root).unwrap_or_else(|_| game_root.to_path_buf());
    if !canonical.starts_with(&canonical_root) {
        return Err(CommandError::new(
            "CONFIG_UNSAFE",
            "配置文件解析到了游戏目录之外，拒绝修改。",
        ));
    }
    Ok(canonical)
}


/// 参与匹配的名字集合：显示名 + 导入时的文件夹名。
fn candidate_names(entry: &ModEntry) -> Vec<String> {
    let mut names = Vec::new();
    let primary = normalize_key(&entry.name);
    if primary.chars().count() >= 3 {
        names.push(primary);
    }
    if let Some(folder) = &entry.mod_folder {
        let normalized = normalize_key(folder);
        if normalized.chars().count() >= 3 && !names.contains(&normalized) {
            names.push(normalized);
        }
    }
    names
}

/// 归一化：只保留字母数字（含中文），全部小写。
/// `Better Vehicle Handling` / `BetterVehicleHandling` / `better-vehicle-handling`
/// 三种写法归一化后一致。
fn normalize_key(raw: &str) -> String {
    raw.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

/// 名字匹配：完全相等直接命中；否则要求「短名字至少 4 个字符且被长名字包含」。
/// 4 字符门槛是为了防止 `hud`、`core`、`ui` 这类通用词把无关 Mod 绑上来。
fn name_matches(target: &str, candidates: &[String]) -> bool {
    let normalized = normalize_key(target);
    if normalized.chars().count() < 3 {
        return false;
    }
    for candidate in candidates {
        if *candidate == normalized {
            return true;
        }
        let (short, long) = if normalized.len() <= candidate.len() {
            (normalized.as_str(), candidate.as_str())
        } else {
            (candidate.as_str(), normalized.as_str())
        };
        // 只靠 contains 会把 "Better" 这类通用词绑到 "bettervehiclehandling" 上，
        // 因此要求较短的一侧至少覆盖较长一侧 60% 的字符，才认定为同一个 Mod 的写法差异。
        let short_len = short.chars().count();
        let long_len = long.chars().count().max(1);
        if short_len >= 4 && long.contains(short) && (short_len as f32 / long_len as f32) >= 0.6 {
            return true;
        }
    }
    false
}

/// `show_minimap` → `show minimap`；`Enabled` → `Enabled`。
fn humanize(key: &str) -> String {
    let spaced = key.replace(['_', '-', '.'], " ");
    let trimmed = spaced.trim();
    if trimmed.is_empty() {
        key.to_string()
    } else {
        trimmed.to_string()
    }
}

fn infer_kind(value: &str) -> &'static str {
    let lower = value.trim().to_ascii_lowercase();
    if lower == "true" || lower == "false" {
        "bool"
    } else if !lower.is_empty()
        && lower.len() <= 64
        && lower
            .chars()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-' | '+' | 'e' | 'E'))
        && lower.parse::<f64>().is_ok()
    {
        "number"
    } else {
        "string"
    }
}

fn flatten_toml(value: &toml::Value, prefix: &str, depth: u8, out: &mut Vec<GlobalConfigEntry>) {
    if out.len() >= MAX_FIELDS * 2 {
        return;
    }
    match value {
        toml::Value::Table(table) => {
            for (key, child) in table {
                let full = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_toml(child, &full, depth, out);
            }
        }
        other => out.push(GlobalConfigEntry {
            key: if prefix.is_empty() {
                "value".to_string()
            } else {
                prefix.to_string()
            },
            value: toml_scalar(other),
            depth,
        }),
    }
}

fn toml_scalar(value: &toml::Value) -> String {
    match value {
        toml::Value::String(text) => text.clone(),
        toml::Value::Integer(number) => number.to_string(),
        toml::Value::Float(number) => number.to_string(),
        toml::Value::Boolean(flag) => flag.to_string(),
        toml::Value::Datetime(date) => date.to_string(),
        other => other.to_string(),
    }
}

fn flatten_json(value: &serde_json::Value, prefix: &str, depth: u8, out: &mut Vec<GlobalConfigEntry>) {
    if out.len() >= MAX_FIELDS * 2 {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let full = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_json(child, &full, depth + 1, out);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let full = format!("{prefix}[{index}]");
                flatten_json(child, &full, depth + 1, out);
            }
        }
        other => out.push(GlobalConfigEntry {
            key: if prefix.is_empty() {
                "value".to_string()
            } else {
                prefix.to_string()
            },
            value: match other {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Null => "null".to_string(),
                other => other.to_string(),
            },
            depth,
        }),
    }
}

/// 命令层入口：从 Store 拿到游戏目录与模组条目，再交给 ConfigResolver。
fn target_of(store: &Store, mod_id: &str) -> AppResult<(PathBuf, ModEntry)> {
    let (game_root, entry) = {
        let data = store.snapshot_data();
        let Some(root) = data.game_dir.clone() else {
            return Err(CommandError::new(
                "GAME_NOT_CONFIGURED",
                "还没有定位游戏目录，无法解析 Mod 配置。",
            ));
        };
        let Some(entry) = data.mods.iter().find(|item| item.id == mod_id).cloned() else {
            return Err(CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"));
        };
        (root, entry)
    };
    let game = validate_game_dir(Path::new(&game_root))?;
    Ok((PathBuf::from(game.root), entry))
}

/// 未套本地化覆盖层的原始配置来源，供 `ailabel::generate` 取标签原文。
/// 走 `mod_config` 会拿到译文，再拿去翻译会把中文当原文重翻一遍。
pub fn raw_mod_sources(store: &Store, mod_id: &str) -> AppResult<Vec<ConfigSource>> {
    let (game_root, entry) = target_of(store, mod_id)?;
    let resolver = ConfigResolver::new(game_root);
    let (sources, _) = resolver.resolve_for_mod(&entry);
    Ok(sources)
}

pub fn mod_config(store: &Store, mod_id: &str) -> AppResult<ModConfigView> {
    let (game_root, entry) = target_of(store, mod_id)?;
    let resolver = ConfigResolver::new(game_root);
    let mut warnings = Vec::new();
    // 解析失败不该让整个抽屉打不开：有问题就退回「没有可调配置」并留下 warning，
    // 详情页会显示「这个 Mod 的配置文件读不出来」而不是一个弹窗错误。
    let (mut sources, problems) = resolver.resolve_for_mod(&entry);
    warnings.extend(problems);
    // #6 范围 ①：只替换启动器渲染的标签，不碰 value / 不写游戏目录。
    // 覆盖层过期只提示重做，绝不自动重跑 AI。
    if let Some(note) = crate::ailabel::apply_overlay(store, mod_id, &mut sources) {
        warnings.push(note);
    }
    Ok(ModConfigView {
        mod_id: entry.id,
        sources,
        warnings,
    })
}

/// 修改某个配置来源里的一个 key。
///
/// 前端只能传 `source_id`——真实文件路径永远由后端重新解析一遍，避免任意路径写入。
/// 写入策略按格式分派，两者都只动目标那一项：
/// - ini：逐行替换，注释、缩进、键顺序和其它 section 全部保留；
/// - json：值级 patch，键集合与其它值不变（JSON 没有注释，重新序列化不丢信息）。
pub fn save_field(
    store: &Store,
    mod_id: &str,
    source_id: &str,
    section: &str,
    key: &str,
    value: &str,
) -> AppResult<ModConfigView> {
    validate_write(value)?;
    let (game_root, entry) = target_of(store, mod_id)?;
    let resolver = ConfigResolver::new(&game_root);
    let (sources, _) = resolver.resolve_for_mod(&entry);
    let source = sources
        .iter()
        .find(|item| item.id == source_id)
        .ok_or_else(|| {
            CommandError::new(
                "CONFIG_SOURCE_MISSING",
                "这个模组的配置文件已经变了，关掉详情重新打开再看。",
            )
        })?;
    if !source.editable {
        return Err(CommandError::new(
            "CONFIG_READ_ONLY",
            "这个来源是只读的，启动器不会改它。",
        ));
    }

    let path = PathBuf::from(&source.path);
    let canonical = writable_target(&path, &game_root)?;
    let backup = canonical.with_file_name(format!(
        "{}.bak",
        canonical
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config")
    ));
    if let Ok(meta) = fs::symlink_metadata(&backup) {
        if meta.file_type().is_symlink() {
            return Err(CommandError::new(
                "CONFIG_UNSAFE",
                "备份文件是符号链接，拒绝写入。",
            ));
        }
    }
    fs::copy(&canonical, &backup).map_err(|err| {
        CommandError::new(
            "CONFIG_BACKUP",
            format!("写前备份失败，已停止修改：{err}"),
        )
    })?;

    let raw = fs::read_to_string(&canonical)
        .map_err(|err| CommandError::new("CONFIG_READ", format!("无法读取配置文件：{err}")))?;

    match source.format.as_str() {
        "ini" => {
            let section = section.trim();
            if section.contains(']') || section.contains('[') || section.contains('\n') {
                return Err(CommandError::new("CONFIG_INVALID_KEY", "分区名不合法。"));
            }
            let key = key.trim();
            if key.is_empty()
                || key.contains('=')
                || key.contains('[')
                || key.contains(']')
                || key.contains('\n')
            {
                return Err(CommandError::new("CONFIG_INVALID_KEY", "配置项名称不合法。"));
            }
            let updated = update_ini_text(&raw, section, key, value);
            if updated == raw {
                return mod_config(store, mod_id);
            }
            replace_file(&canonical, updated.as_bytes()).map_err(|err| {
                CommandError::new(
                    "CONFIG_WRITE",
                    format!("写入失败（原文件已备份到 {}）：{err}", backup.display()),
                )
            })?;
        }
        "json" => {
            let mut root: serde_json::Value =
                serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|err| {
                    CommandError::new("CONFIG_INVALID", format!("JSON 解析失败：{err}"))
                })?;
            json_apply_scalar(&mut root, key.trim(), value)
                .map_err(|err| CommandError::new("CONFIG_PATCH", err))?;
            let mut text = serde_json::to_string_pretty(&root)
                .map_err(|err| CommandError::new("CONFIG_WRITE", format!("序列化失败：{err}")))?;
            text.push('\n');
            replace_file(&canonical, text.as_bytes()).map_err(|err| {
                CommandError::new(
                    "CONFIG_WRITE",
                    format!("写入失败（原文件已备份到 {}）：{err}", backup.display()),
                )
            })?;
        }
        other => {
            return Err(CommandError::new(
                "CONFIG_UNSUPPORTED",
                format!("还不支持修改 {other} 格式的配置。"),
            ));
        }
    }
    mod_config(store, mod_id)
}

/// 全局配置命令入口。
pub fn global_configs(store: &Store) -> AppResult<GlobalConfigGroups> {
    let game_root = {
        let data = store.snapshot_data();
        let Some(root) = data.game_dir.clone() else {
            return Err(CommandError::new(
                "GAME_NOT_CONFIGURED",
                "还没有定位游戏目录，无法读取框架配置。",
            ));
        };
        root
    };
    let game = validate_game_dir(Path::new(&game_root))?;
    Ok(ConfigResolver::new(game.root).resolve_global_configs())
}

#[cfg(test)]
mod tests {
    use super::{
        mod_config, name_matches, normalize_key, save_field, ConfigResolver, SettingField,
        RESERVED_SECTIONS,
    };
    use crate::schema::{DeployedFile, InstallLayout, LinkType, ModEntry};
    use crate::store::Store;
    use std::fs;
    use std::path::PathBuf;

    /// 造一套最小的游戏目录 + ModEntry。
    fn fixture(tag: &str) -> (PathBuf, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("config-{tag}-{}", uuid::Uuid::new_v4().simple()));
        let game = root.join("game");
        fs::create_dir_all(game.join("bin").join("x64")).unwrap();
        fs::write(game.join("bin").join("x64").join("Cyberpunk2077.exe"), b"MZ").unwrap();
        (root, game)
    }

    fn mod_entry(name: &str) -> ModEntry {
        ModEntry {
            id: "mod-test".to_string(),
            raw_name: None,
            name: name.to_string(),
            author: None,
            version: None,
            description: String::new(),
            category: "框架".to_string(),
            category_locked: false,
            source_zip: None,
            nexus: None,
            staging_path: String::new(),
            cover_path: None,
            cover_cache_path: None,
            enabled: false,
            installed_at: "2026-01-01T00:00:00Z".to_string(),
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

    #[test]
    fn normalizes_separators() {
        assert_eq!(normalize_key("Better Vehicle Handling"), "bettervehiclehandling");
        assert_eq!(normalize_key("better-vehicle_handling"), "bettervehiclehandling");
        assert_eq!(normalize_key("BetterVehicleHandling"), "bettervehiclehandling");
    }

    #[test]
    fn matches_fuzzy_but_not_generic_words() {
        let candidates = vec!["bettervehiclehandling".to_string()];
        assert!(name_matches("BetterVehicleHandling", &candidates));
        assert!(name_matches("Better Vehicle Handling", &candidates));
        // 通用短词不应该把无关 Mod 绑上来
        assert!(!name_matches("hud", &candidates));
        assert!(!name_matches("Better", &candidates));
        assert!(!name_matches("Vehicle", &candidates));
    }

    #[test]
    fn reserved_sections_are_filtered() {
        assert!(RESERVED_SECTIONS.contains(&normalize_key("General").as_str()));
        assert!(RESERVED_SECTIONS.contains(&normalize_key("ModSettings").as_str()));
        // 真实 Mod 名不会被当成保留字
        assert!(!RESERVED_SECTIONS.contains(&normalize_key("BetterVehicleHandling").as_str()));
    }

    #[test]
    fn resolves_only_the_owning_section() {
        let (root, game) = fixture("own");
        let ini_dir = game
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("mods")
            .join("ModSettings");
        fs::create_dir_all(&ini_dir).unwrap();
        fs::write(
            ini_dir.join("user.ini"),
            "[General]\nlanguage=zh-cn\n\n[BetterVehicleHandling]\nreduce_drift=true\ngrip=1.25\n\n[UnrelatedMod]\nfoo=bar\n",
        )
        .unwrap();

        let resolver = ConfigResolver::new(&game);
        let entry = mod_entry("Better Vehicle Handling");
        let (sources, _) = resolver.resolve_for_mod(&entry);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "mod_settings");
        let keys: Vec<&SettingField> = sources[0].fields.iter().collect();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].kind, "bool");
        assert_eq!(keys[1].kind, "number");
        // 关键：General 和无关 section 都不能混进来
        assert!(keys.iter().all(|field| field.section == "BetterVehicleHandling"));
        fs::remove_dir_all(&root).ok();
    }

    /// 2026-11-06 审计 P1-11：坏掉的 user.ini 不能静默当成「没有可调参数」，
    /// 必须带一条 warning 回前端，否则用户永远不知道自己的配置文件是坏的。
    #[test]
    fn broken_user_ini_is_reported_as_a_warning() {
        let (root, game) = fixture("broken-ini");
        let ini_dir = game
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("mods")
            .join("ModSettings");
        fs::create_dir_all(&ini_dir).unwrap();
        // 半截的 section：没有右括号，ini crate 解析必失败。
        fs::write(ini_dir.join("user.ini"), "[BetterVehicleHandling\nreduce_drift=true\n").unwrap();

        let resolver = ConfigResolver::new(&game);
        let entry = mod_entry("Better Vehicle Handling");
        let (sources, warnings) = resolver.resolve_for_mod(&entry);
        assert!(sources.is_empty(), "坏文件不该被当成可调配置");
        assert!(
            warnings.iter().any(|line| line.contains("user.ini")),
            "必须报出是哪个文件坏了：{warnings:?}"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_pure_content_mod_has_no_config() {
        let (root, game) = fixture("none");
        let resolver = ConfigResolver::new(&game);
        let entry = mod_entry("ArchiveXL");
        let (sources, _) = resolver.resolve_for_mod(&entry);
        assert!(sources.is_empty(), "内容层 Mod 不应该被造出配置项");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn native_interactions_binds_through_deployed_files() {
        let (root, game) = fixture("ni");
        let projects = game
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("mods")
            .join("nativeInteractions")
            .join("projects");
        fs::create_dir_all(&projects).unwrap();
        fs::write(
            projects.join("ImmersiveFixers.json"),
            r#"{"version":1,"interactions":[]}"#,
        )
        .unwrap();

        let resolver = ConfigResolver::new(&game);
        let mut entry = mod_entry("Immersive Fixers");
        entry.deployed_files.push(DeployedFile {
            source: String::new(),
            target: String::new(),
            link_type: LinkType::HardLink,
            relative_path: "bin/x64/plugins/cyber_engine_tweaks/mods/nativeInteractions/projects/ImmersiveFixers.json".to_string(),
            size: None,
            modified_time: None,
        });
        let (sources, _) = resolver.resolve_for_mod(&entry);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "native_interactions");
        assert!(!sources[0].editable, "Native Interactions 默认只读");
        assert!(sources[0].raw.is_some());
        fs::remove_dir_all(&root).ok();
    }

    // ── 多框架解析与 patch-only 写入 ──────────────────────────────────

    /// 把已建好的游戏目录接上一个 Store：状态里有 game_dir 和一个模组条目。
    fn store_for(root: &std::path::Path, game: &std::path::Path, entry: ModEntry) -> Store {
        let store = Store::load(root.join("data")).unwrap();
        {
            let mut state = store.data.lock().unwrap();
            state.game_dir = Some(game.to_string_lossy().to_string());
            state.mods = vec![entry];
            store.save(&state).unwrap();
        }
        store
    }

    fn deployed(relative: &str) -> DeployedFile {
        DeployedFile {
            source: String::new(),
            target: String::new(),
            link_type: LinkType::HardLink,
            relative_path: relative.to_string(),
            size: None,
            modified_time: None,
        }
    }

    #[test]
    fn per_mod_json_is_resolved_and_patched_in_place() {
        let (root, game) = fixture("modjson");
        let dir = game
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("mods")
            .join("HUDTweaks");
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.json");
        fs::write(
            &config,
            "{\"version\":2,\"hud\":{\"scale\":1.0,\"enabled\":true},\"other\":\"keep\"}\n",
        )
        .unwrap();

        let mut entry = mod_entry("HUD Tweaks");
        entry.has_cet = true;
        entry.deployed_files.push(deployed(
            "bin/x64/plugins/cyber_engine_tweaks/mods/HUDTweaks/config.json",
        ));
        let store = store_for(&root, &game, entry);

        let view = mod_config(&store, "mod-test").unwrap();
        assert_eq!(view.sources.len(), 1, "不该把全局 CET 配置也塞进来");
        assert_eq!(view.sources[0].id, "mod_json");
        assert!(view.sources[0].editable);
        assert!(view.sources[0]
            .fields
            .iter()
            .any(|field| field.key == "hud.scale" && field.kind == "number"));

        let updated = save_field(&store, "mod-test", "mod_json", "", "hud.scale", "1.5").unwrap();
        let scale = updated.sources[0]
            .fields
            .iter()
            .find(|field| field.key == "hud.scale")
            .unwrap();
        assert_eq!(scale.value, "1.5");

        // 核心断言：其它键原样保留，而不是整文件重写成默认值
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.contains("\"other\": \"keep\""), "{text}");
        assert!(text.contains("\"enabled\": true"), "{text}");
        assert!(text.contains("\"version\": 2"), "{text}");
        assert!(config.with_file_name("config.json.bak").is_file());

        // 不存在的键不许凭空新建
        let error = save_field(&store, "mod-test", "mod_json", "", "hud.unknown", "1").unwrap_err();
        assert_eq!(error.code, "CONFIG_PATCH");
        // 类型不符要拒绝，而不是把数字写成字符串
        let error = save_field(&store, "mod-test", "mod_json", "", "hud.scale", "abc").unwrap_err();
        assert_eq!(error.code, "CONFIG_PATCH");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn shared_user_ini_only_patches_the_target_key() {
        let (root, game) = fixture("shared");
        let dir = game
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("mods")
            .join("ModSettings");
        fs::create_dir_all(&dir).unwrap();
        let ini = dir.join("user.ini");
        fs::write(
            &ini,
            "[General]\r\nlanguage=zh-cn\r\n\r\n[ModA]\r\nx=1 ; 保留注释\r\n\r\n[ModB]\r\ny=2\r\n",
        )
        .unwrap();

        let store = store_for(&root, &game, mod_entry("ModA"));
        let view = mod_config(&store, "mod-test").unwrap();
        assert_eq!(view.sources[0].id, "mod_settings");
        // 共用同一份 user.ini 时，别的 Mod 的段不能被算作自己的配置
        assert!(view.sources[0]
            .fields
            .iter()
            .all(|field| field.section == "ModA"));

        save_field(&store, "mod-test", "mod_settings", "ModA", "x", "9").unwrap();
        let text = fs::read_to_string(&ini).unwrap();
        assert!(text.contains("x=9 ; 保留注释"), "{text}");
        assert!(text.contains("[ModB]\r\ny=2"), "{text}");
        assert!(text.contains("language=zh-cn"), "{text}");
        assert!(dir.join("user.ini.bak").is_file());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn audioxl_ini_is_resolved_from_deployed_files() {
        let (root, game) = fixture("audio");
        let dir = game.join("red4ext").join("plugins").join("AudioXL");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("HUD.ini"), "[Audio]\nvolume=0.5\n").unwrap();

        let mut entry = mod_entry("HUD Sound");
        entry
            .deployed_files
            .push(deployed("red4ext/plugins/AudioXL/HUD.ini"));
        let store = store_for(&root, &game, entry);

        let view = mod_config(&store, "mod-test").unwrap();
        let source = view
            .sources
            .iter()
            .find(|item| item.id == "audioxl")
            .expect("AudioXL 的 ini 应该被绑定");
        assert!(source.editable);
        assert_eq!(source.fields[0].key, "volume");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_only_sources_refuse_writes() {
        let (root, game) = fixture("readonly");
        let projects = game
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("mods")
            .join("nativeInteractions")
            .join("projects");
        fs::create_dir_all(&projects).unwrap();
        fs::write(projects.join("ImmersiveFixers.json"), "{\"version\":1}").unwrap();

        let mut entry = mod_entry("Immersive Fixers");
        entry.deployed_files.push(deployed(
            "bin/x64/plugins/cyber_engine_tweaks/mods/nativeInteractions/projects/ImmersiveFixers.json",
        ));
        let store = store_for(&root, &game, entry);

        let error =
            save_field(&store, "mod-test", "native_interactions", "", "version", "2").unwrap_err();
        assert_eq!(error.code, "CONFIG_READ_ONLY");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cet_global_config_is_only_a_read_only_fallback() {
        let (root, game) = fixture("cetglobal");
        let dir = game
            .join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.json"), "{\"debug\":true}\n").unwrap();

        let mut entry = mod_entry("Some Cet Mod");
        entry.has_cet = true;
        let store = store_for(&root, &game, entry);

        let view = mod_config(&store, "mod-test").unwrap();
        assert_eq!(view.sources.len(), 1);
        assert_eq!(view.sources[0].id, "cet_global");
        assert!(!view.sources[0].editable, "全局 CET 配置不给写");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn red4ext_config_is_parsed_as_toml() {
        let (root, game) = fixture("toml");
        let red4ext = game.join("red4ext");
        fs::create_dir_all(&red4ext).unwrap();
        fs::write(
            red4ext.join("config.ini"),
            "[logging]\nlevel = \"warning\"\nmaxSize = 1048576\n\n[general]\nenabled = true\n",
        )
        .unwrap();

        let resolver = ConfigResolver::new(&game);
        let groups = resolver.resolve_global_configs();
        let group = groups
            .groups
            .iter()
            .find(|item| item.id == "red4ext")
            .unwrap();
        assert!(group.exists);
        assert_eq!(group.format, "toml");
        assert!(group.entries.iter().any(|entry| entry.key == "logging.level"));
        assert!(group.entries.iter().any(|entry| entry.value == "true"));
        fs::remove_dir_all(&root).ok();
    }
}
