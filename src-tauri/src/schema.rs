use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use serde_json::Value;

pub const APP_SCHEMA_VERSION: u32 = 1;
pub const STEAM_APP_ID: &str = "1091500";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<ConflictInfo>,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
            conflicts: Vec::new(),
        }
    }

    pub fn with_conflicts(mut self, conflicts: Vec<ConflictInfo>) -> Self {
        self.conflicts = conflicts;
        self
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<std::io::Error> for CommandError {
    fn from(value: std::io::Error) -> Self {
        Self::new("IO_ERROR", value.to_string())
    }
}

pub type AppResult<T> = Result<T, CommandError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkType {
    HardLink,
    Symlink,
    Copy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallLayout {
    /// The archive already mirrors the game root (archive/, r6/, bin/, red4ext/...).
    GameRoot,
    /// Loose .archive / .xl files for archive/pc/mod.
    Archive,
    /// A REDmod package (info.json + archives/scripts).
    Redmod,
    /// A Cyber Engine Tweaks Lua mod.
    Cet,
    /// Loose .reds scripts.
    Redscript,
    /// An ASI plugin (or an ASI proxy loader dll) shipped without the bin/ prefix.
    Asi,
    /// A RED4ext native plugin shipped without the red4ext/ prefix.
    Red4ext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployedFile {
    pub source: String,
    pub target: String,
    pub link_type: LinkType,
    /// Path relative to the game root, stored for safe undeploy and conflict checks.
    pub relative_path: String,
    /// 部署当时目标文件的大小（字节）。事后体检用它发现文件被替换或截断。
    #[serde(default)]
    pub size: Option<u64>,
    /// 部署当时目标文件的修改时间（Unix 秒）。被外部改写时体检会报 warning。
    #[serde(default)]
    pub modified_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    pub id: String,
    /// 展示名。来自文件名时经过 `modname::polish` 清洗；来自 info.json / Nexus /
    /// 用户手改时保持原样。
    pub name: String,
    /// 清洗前的原始文件名 / 文件夹名。只有 `name` 被清洗过才有值，详情页用它
    /// 告诉玩家「界面上的名字对应磁盘上哪个文件」，排错时不用回资源管理器翻。
    #[serde(default)]
    pub raw_name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    pub category: String,
    /// 用户手动指定过分类。为 true 时任何自动重算（智能归类 / 重算全部）都会跳过，
    /// 否则玩家刚改完分类，下一次一键重算又被启发式覆盖。
    #[serde(default)]
    pub category_locked: bool,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_zip: Option<String>,
    #[serde(default)]
    pub nexus: Option<NexusRef>,
    pub staging_path: String,
    #[serde(default)]
    pub cover_path: Option<String>,
    pub enabled: bool,
    pub installed_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub size_bytes: u64,
    pub file_count: usize,
    pub layout: InstallLayout,
    #[serde(default)]
    pub mod_folder: Option<String>,
    /// "infoJson" when name/version came from REDmod info.json, "filename" when
    /// the archive had no metadata and the file name was used instead.
    #[serde(default)]
    pub metadata_source: String,
    /// Relative target paths computed at import time. This keeps conflict
    /// checks cheap for large libraries; deploy still recomputes authoritatively.
    #[serde(default)]
    pub planned_files: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub deployed_files: Vec<DeployedFile>,
    #[serde(default)]
    pub has_archive: bool,
    #[serde(default)]
    pub has_redmod: bool,
    #[serde(default)]
    pub has_cet: bool,
    /// 中文译名。None 表示还没翻译，前端回退显示 name。
    /// 单独开字段而不是改 name：name 是冲突检测、modlist 写入和路径匹配的依据，
    /// 一旦被翻译污染，后续所有按名字比对的地方都会失配。
    #[serde(default)]
    pub translated_name: Option<String>,
    /// 译名产生时间与模型。换模型后可以据此判断缓存是否该重刷。
    #[serde(default)]
    pub translated_at: Option<String>,
    #[serde(default)]
    pub translated_by: Option<String>,
    /// 是否由本启动器托管。扫描游戏目录 / Vortex 发现的散装 Mod 记为 false：
    /// 它们在库里可见，但不允许直接部署或卸载，必须先迁移进 staging。
    #[serde(default = "default_true")]
    pub managed: bool,
    /// 来源标记：cyberdeck（应用内导入）、gameDir（游戏目录扫描）、
    /// vortex（Vortex 暂存区扫描）、modpack（整合包展开）、adopted（收编散装）。
    #[serde(default = "default_origin")]
    pub origin: String,
    /// 所属整合包 id；单独导入的 Mod 为 None。
    #[serde(default)]
    pub modpack_id: Option<String>,
    /// Nexus 官方封面图地址（https）。只有从 N 网下载的 Mod 才有；
    /// 本地导入的包拿不到，前端回退到程序生成的封面。
    #[serde(default)]
    pub nexus_cover_url: Option<String>,
    /// 疑似/已确认的附属汉化包。导入时按名字关键词初判，用户可在界面里改。
    /// 默认 false，旧状态文件反序列化后一律视为独立 Mod（不会被误挂到别人下面）。
    #[serde(default)]
    pub is_translation: bool,
    /// 绑定的原版 Mod id。Some 时该条目不在主网格单独占位，而是挂在父级卡片上；
    /// 父级禁用/卸载时跟着走。**只存 id 不存名字**：名字会被用户改，id 不会。
    #[serde(default)]
    pub parent_mod_id: Option<String>,
    /// 已生成的 AI 汉化覆盖层。产物与原 Mod 分离存放，这里只登记部署清单，
    /// 用于一键撕除；原 Mod 的 deployed_files 不受影响。
    #[serde(default)]
    pub ai_loc: Option<AiLocState>,
    /// 已部署的 AI 补丁（T6）。每个补丁是独立 .reds 文件，可单独撤销。
    #[serde(default)]
    pub ai_fix: Vec<AiFixState>,
}

fn default_origin() -> String {
    "cyberdeck".to_string()
}

/// 一个整合包的登记信息。子 Mod 本身仍是普通 ModEntry，靠 modpack_id 反向归属：
/// 整合包里的每个 Mod 之后要能单独启用、停用、部署，独立成表会分裂两套生命周期。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackEntry {
    pub id: String,
    pub name: String,
    pub source_zip: String,
    pub imported_at: String,
    #[serde(default)]
    pub child_mod_ids: Vec<String>,
    /// 包内 modlist.txt（若存在）解析出的推荐加载顺序。
    /// 导入时已把文件名映射成子 Mod id，前端可直接套用。
    #[serde(default)]
    pub recommended_order: Vec<String>,
    /// importing | ready | partial | failed
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub total_files: usize,
    #[serde(default)]
    pub extracted_bytes: u64,
}

/// 扫描出来、还没进库的 Mod 候选。扫描只产出候选，用户勾选后才走既有安装流程，
/// 这样「未托管 → 托管」只有一条代码路径，不会出现第二套迁移逻辑。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // 扫描/翻译命令接入前先不触发 dead_code 噪音。
pub struct ScannedModCandidate {
    /// 稳定 id：来源 + 路径哈希，重复扫描可去重。
    pub id: String,
    pub name: String,
    /// gameDir | vortex
    pub source: String,
    /// 候选根目录。游戏目录里是 archive/pc/mod 这类聚合目录，
    /// Vortex 里是单个 mod 文件夹。
    pub path: String,
    pub layout: InstallLayout,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub file_count: usize,
    #[serde(default)]
    pub mod_folder: Option<String>,
    /// 库里已有同名或同路径的条目。前端默认不勾选，避免重复导入。
    #[serde(default)]
    pub already_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // 扫描/翻译命令接入前先不触发 dead_code 噪音。
pub struct ScanReport {
    pub candidates: Vec<ScannedModCandidate>,
    #[serde(default)]
    pub vortex_staging_dir: Option<String>,
    #[serde(default)]
    pub game_scan_dirs: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 批量翻译的统计结果。前端任务队列直接展示这里面的数字。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // 扫描/翻译命令接入前先不触发 dead_code 噪音。
pub struct TranslateReport {
    pub requested: usize,
    pub translated: usize,
    pub failed: usize,
    /// 已经是中文，或已有译名而跳过的数量。
    pub skipped: usize,
    pub model: String,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// AI 汉化：一条待翻译条目（只读扫描的产物，不落盘）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocEntry {
    /// 原文所在文件，相对 Mod 暂存根。
    pub source_file: String,
    /// onscreens 的 secondaryKey；扁平 JSON 用键名。
    pub secondary_key: String,
    pub source_text: String,
    /// 词表已命中时直接给出候选译文，命中项不再消耗 API。
    #[serde(default)]
    pub glossary_hit: Option<String>,
}

/// AI 汉化：扫到但无法安全处理的内容，附原因码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocBlocked {
    pub source_file: String,
    /// RESOURCE_TEXT / ALREADY_CHINESE / UNSUPPORTED_FORMAT / TEXT_TOO_LONG
    pub reason: String,
    #[serde(default)]
    pub sample: String,
}

/// AI 汉化计划：只读扫描结果 + 前置条件检查。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocPlan {
    pub mod_id: String,
    pub mod_name: String,
    pub source_lang: String,
    pub target_lang: String,
    /// allowed | denied | uncertain
    pub policy: String,
    #[serde(default)]
    pub policy_evidence: Vec<String>,
    #[serde(default)]
    pub entries: Vec<AiLocEntry>,
    #[serde(default)]
    pub blocked: Vec<AiLocBlocked>,
    #[serde(default)]
    pub glossary_hits: usize,
    /// WolvenKit CLI 可用：没有它就无法打包 .archive，只能生成不部署。
    pub packing_ready: bool,
    /// 已经存在覆盖层（可先 revert 再重生成）。
    pub has_overlay: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// AI 汉化：已应用的覆盖层登记（挂在原 Mod 条目上，随原 Mod 生命周期走）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocState {
    pub staging_dir: String,
    #[serde(default)]
    pub deployed: Vec<DeployedFile>,
    #[serde(default)]
    pub translated: usize,
    #[serde(default)]
    pub skipped: usize,
    #[serde(default)]
    pub model: String,
    pub created_at: String,
}

/// AI 汉化执行报告。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocReport {
    pub mod_id: String,
    pub planned: usize,
    pub translated: usize,
    pub skipped: usize,
    #[serde(default)]
    pub written: Vec<String>,
    #[serde(default)]
    pub deployed: Vec<String>,
    #[serde(default)]
    pub rolled_back: bool,
    pub model: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// AI 补丁（T6）：一份待确认的 Redscript 补丁提案。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFixProposal {
    pub mod_id: String,
    pub mod_name: String,
    /// 提案意图（用户在界面里填的症状/需求）。
    pub intent: String,
    /// 发给 AI 的上下文规模，前端用来提示「外发了多少内容」。
    pub context_chars: usize,
    /// 参与冲突/依赖判断的文件（相对 Mod 暂存根）。
    pub context_files: Vec<String>,
    pub code: String,
    /// G1：结构性校验（模块名、注解、括号配平、危险 API）。
    pub structure_ok: bool,
    #[serde(default)]
    pub structure_issues: Vec<String>,
    /// 编译器路径；None 表示本机找不到 redscript 编译器，按规则不允许部署。
    #[serde(default)]
    pub compiler: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// AI 补丁：已部署补丁的登记。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFixState {
    pub file: DeployedFile,
    pub intent: String,
    pub model: String,
    pub created_at: String,
}

/// AI 补丁执行报告。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFixReport {
    pub mod_id: String,
    pub target: String,
    pub bytes: usize,
    pub compiled: bool,
    pub model: String,
    #[serde(default)]
    pub warnings: Vec<String>,
}


/// 整合包导入过程中通过 Tauri event 推给前端的进度载荷。
/// 收编（Adopt）：一个未受管文件。`rel` 相对游戏根（如 archive/pc/mod/foo.archive），
/// 大小/时间取自游戏侧文件本身，供执行期二次校验。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptFileRef {
    pub rel: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub modified_time: Option<u64>,
}

/// 收编候选：1 个 .archive = 1 个候选，同词干 .xl/.xlp 跟随；
/// 无配对 archive 的独立 .xl 独立成候选。id 稳定（路径 FNV-1a），重复扫描可去重。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptCandidate {
    /// "adopt-<fnv1a64 hex>"。
    pub id: String,
    /// 文件词干（独立 .xl 时为其自身词干）。
    pub name: String,
    /// 主文件（.archive 或独立 .xl）的相对路径。
    pub archive_rel: String,
    pub files: Vec<AdoptFileRef>,
    pub size_bytes: u64,
    /// 预判的暂存方式：同卷 HardLink、跨卷 Copy。执行期以实际结果为准。
    pub link_type: LinkType,
    /// 任一文件已被库内条目（部署清单或 planned）占有时为 true，前端默认不勾选。
    pub already_managed: bool,
    /// 候选来源："archive"（从 archive/pc/mod 反推）或 "vortex"（按 Vortex mod 目录）。
    /// 老前端不带这个字段时按 archive 处理。
    #[serde(default)]
    pub source: String,
    /// 本候选接管后需要并入并删除的既有条目标 id（原按文件反推的碎片条目）。
    #[serde(default)]
    pub absorb_entry_ids: Vec<String>,
    /// 在 Vortex 库里精确对上的元数据（Nexus 编号 / 官方分类 / 作者 / 版本 / 封面）。
    ///
    /// Vortex 的目录名与它自己的 `installationPath` 是同一个字符串，所以配准是
    /// 精确的，不需要按名字模糊匹配。收编时把这些一起写进库，用户拿到的条目
    /// 一开始就带 Nexus 徽标和正确分类，和 Vortex 里看到的一致。
    #[serde(default)]
    pub vortex: Option<AdoptVortexMeta>,
}

/// 收编候选携带的 Vortex 元数据。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptVortexMeta {
    pub mod_id: u64,
    pub file_id: Option<u64>,
    /// Nexus 页面标题（Vortex 的 `modName`）。比剥掉版本戳的目录名更干净。
    pub name: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    /// 已翻译成本启动器分类名的结果；None 表示 Nexus 侧就是 Miscellaneous。
    pub category: Option<String>,
    pub picture_url: Option<String>,
}

/// 一条可以脱离 LevelDB 生命周期单独使用的记录（收编扫描要用）。
#[derive(Debug, Clone, Default)]
pub struct VortexRecord {
    pub mod_id: u64,
    pub file_id: Option<u64>,
    pub name: String,
    pub author: String,
    pub version: String,
    pub picture_url: Option<String>,
    /// 已翻译成本启动器分类名的结果（`服装` / `玩法` …）。
    pub category: Option<String>,
    /// 模组目录名，和 `vortex_source::scan_dirs` 读到的目录名一一对应。
    pub dir_name: String,
}

/// adopt_scan 的返回。copy_bytes 是跨卷收编需要真实复制的字节数，
/// 执行批次开始时会据此做一次硬预检。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptScanReport {
    pub candidates: Vec<AdoptCandidate>,
    pub total_bytes: u64,
    pub copy_bytes: u64,
    pub cross_volume: bool,
    pub archive_dir: String,
}

/// 收编执行过程中通过 Tauri 事件 "adopt-progress" 推给前端的进度载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptProgress {
    /// staging | verify | register | done | failed | cancelled
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub name: String,
    pub detail: String,
}

/// 单个候选收编失败的错误载荷（ADOPT_ 前缀错误码）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptError {
    pub code: String,
    pub message: String,
}

/// 单个候选的收编结果。`adopted` 为 false 且无 error 表示被跳过
/// （例如已被启动器托管）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptOutcome {
    pub id: String,
    pub name: String,
    pub adopted: bool,
    #[serde(default)]
    pub error: Option<AdoptError>,
}

/// adopt_execute 的返回。mods 是本次成功登记的 ModEntry，前端直接并入库视图。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptReport {
    pub adopted: usize,
    pub failed: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub outcomes: Vec<AdoptOutcome>,
    pub mods: Vec<ModEntry>,
}

/// 库整理（adopt_normalize）的返回。
///
/// - `merged` / `merged_names`：这次并回主体的伴生文件条目；
/// - `removed`：已从库中清掉的失效条目（只剩 `X.archive.xl`，主体既不在库也不在
///   游戏目录）。**只删记录、不删文件**，游戏目录里的 `.xl` 原样保留；
/// - `empty`：部署清单为空的条目名，通常是正常禁用的模组，仅供信息展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNormalizeReport {
    pub merged: usize,
    pub merged_names: Vec<String>,
    pub removed: Vec<String>,
    pub empty: Vec<String>,
}

/// Provenance for a mod imported through the Nexus Mods API. Optional: manual
/// ZIPs and browser downloads never carry this.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusRef {
    pub mod_id: u64,
    #[serde(default)]
    pub file_id: Option<u64>,
    pub url: String,
    #[serde(default)]
    pub version: Option<String>,
    /// 与 Mod 列表同一张官方封面，下载后直接落到 ModEntry.nexus_cover_url。
    #[serde(default)]
    pub picture_url: Option<String>,
    /// 最近一次更新检查时 Nexus 上的版本号（P5-5A）。用于「看过但没变」的
    /// 状态留痕；比只存一份布尔值更容易排查「为什么说没有更新」。
    #[serde(default)]
    pub latest_version: Option<String>,
    /// 最近一次成功比对的时间（ISO 8601）。没有值时表示从未检查过。
    #[serde(default)]
    pub last_check: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Off by default: the game's native modlist.txt is powerful and easy to get wrong.
    #[serde(default)]
    pub write_modlist: bool,
    /// Vortex 接管开关（默认关闭）。开启后启用/禁用与加载顺序会双写到 Vortex
    /// 状态库；Vortex 运行中或 profile 不符时，本地变更也会被一并拒绝，保证
    /// 两侧不会各改一半。旧状态文件没有这个字段，serde default 兜底为 false。
    #[serde(default)]
    pub vortex_takeover: bool,
    #[serde(default = "default_true")]
    pub auto_backup: bool,
    #[serde(default = "default_true")]
    pub confirm_uninstall: bool,
    /// 点击关闭按钮时的行为：`tray` = 最小化到托盘（默认），`exit` = 直接退出。
    /// 旧状态文件没有这个字段，serde default 兜底为 tray，不会反序列化失败。
    #[serde(default = "default_close_behavior")]
    pub close_behavior: String,
    /// 点 × / Alt+F4 时是否先弹确认（"最小化到托盘"模式下）。
    ///
    /// 用户可以在弹窗里勾「以后不再询问」，把这里置 false；托盘右键"彻底退出"
    /// 永远直接退出，不受这个开关影响。
    #[serde(default = "default_true")]
    pub close_ask: bool,
    #[serde(default = "default_launch_method")]
    pub launch_method: String,
    /// 游戏来源平台偏好：auto / steam / gog / epic / manual。
    /// 只影响自动嗅探的先后顺序与界面提示，不改变启动参数。
    #[serde(default = "default_platform_pref")]
    pub platform_pref: String,
    /// Optional path to 7z.exe / UnRAR.exe for .rar archives. Empty means auto-detect.
    #[serde(default)]
    pub archive_tool_path: String,
    /// Optional path to WolvenKit.Cli.exe（资源级深度扫描）。空 = 深度扫描不可用。
    /// 旧状态文件没有这个字段，serde default 兜底为空串，不会反序列化失败。
    #[serde(default)]
    pub wolvenkit_cli_path: String,
    /// WolvenKit 单个 archive 的解包超时（秒）。默认 60；set_settings 会钳制范围。
    #[serde(default = "default_wolvenkit_timeout_secs")]
    pub wolvenkit_timeout_secs: u64,
    /// 非机密的 AI 端点配置：任何兼容 OpenAI 协议的服务（OpenAI / DeepSeek /
    /// Moonshot / 通义千问 / 本地 Ollama …）。API Key 单独走 DPAPI，不进这里。
    #[serde(default = "default_ai_base_url")]
    pub ai_base_url: String,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
    /// AI 接口协议："openai"（OpenAI 兼容，默认）或 "anthropic"（Anthropic 原生）。
    /// 未知值在使用处按 openai 兜底（set_settings 会在保存时拦住非法值）。
    #[serde(default = "default_ai_protocol")]
    pub ai_protocol: String,
    /// 多套 AI 配置（本地 / 云端 / 中转站各存一份，随时切换）。
    ///
    /// 这里只存**非机密**字段；每套配置的 API Key 各自独立加密存放（DPAPI），
    /// 文件名按配置 id 区分。空数组 = 老用户还没迁移，读取时按当前
    /// `ai_base_url/ai_model/ai_protocol` 自动补一条「默认配置」。
    #[serde(default)]
    pub ai_profiles: Vec<AiProfile>,
    /// 当前激活的配置 id。空串按"第一条"处理。
    #[serde(default)]
    pub active_ai_profile_id: String,
    /// Hide adult Nexus results in the browser. Defaults to hiding them.
    #[serde(default = "default_true")]
    pub nexus_hide_adult: bool,
    /// 自定义背景图（看板【皮肤 UI 优化】P0 子项）：绝对路径。空 = 不启用背景层。
    /// 只存路径不存图——前端经 read_background_image 换成 data URL，CSP 不用放宽。
    #[serde(default)]
    pub background_image: String,
    /// 背景图不透明度 0–100（默认 45）。set_settings 会钳制，旧状态缺字段兜底 45。
    #[serde(default = "default_background_opacity")]
    pub background_opacity: u8,
    /// 背景图模糊半径 0–40 px（默认 0）。set_settings 会钳制。
    #[serde(default)]
    pub background_blur: u32,
    /// 背景图填充模式（背景图焦点任务·一）："cover"（铺满，默认，等比裁切）/
    /// "contain"（完整显示，等比留白）/ "stretch"（拉伸铺满，会变形）。
    /// 非法值按 cover 兜底（set_settings 会在保存时拦住）。
    #[serde(default = "default_background_fit")]
    pub background_fit: String,
    /// 背景图焦点横坐标 0–100（默认 50 = 居中）。cover / contain 下决定裁切重心。
    #[serde(default = "default_background_pos")]
    pub background_pos_x: u8,
    /// 背景图焦点纵坐标 0–100（默认 50 = 居中）。
    #[serde(default = "default_background_pos")]
    pub background_pos_y: u8,
    /// 背景暗化遮罩浓度 0–100（默认 50）。压在图片之上、界面之下，
    /// 和 background_opacity 是两个维度：不透明度让图变淡，遮罩让图后面垫一层黑。
    #[serde(default = "default_background_dim")]
    pub background_dim: u8,
    /// 背景图缩放倍率 1.0–3.0（默认 1.0，3A-3 裁切模态）。> 1 时前端把
    /// background-size 等比放大，配合焦点实现「头像式」拖拽裁切；
    /// 1.0 表示维持填充模式原样，不引入额外缩放。
    #[serde(default = "default_background_zoom")]
    pub background_zoom: f64,
    /// 用户自定义启动参数（#6）：如 `-modded`。空格分隔，支持双引号包裹，
    /// 经 parse_launch_args 白名单校验后逐参传给游戏进程，绝不经过 shell。
    #[serde(default)]
    pub launch_args: String,
    /// `nxm://` 收到链接后要不要直接下载并导入（需要 Nexus Premium）。
    /// 关掉就只弹接收条，由用户点「下载并导入」。
    #[serde(default = "default_true")]
    pub nxm_auto_download: bool,
    /// 部署方式（deepseek 任务·模块一）："hardlink"（默认，同卷硬链）/ "symlink"（优先
    /// 符号链接）/ "copy"（直接复制）。非法值按 hardlink 兜底（set_settings 拦截保存）。
    #[serde(default = "default_deploy_mode")]
    pub deploy_mode: String,
    /// 启动显卡偏好（deepseek 任务·模块一）："auto" / "dedicated" / "integrated"。
    /// 非 auto 时写 Windows 每应用 GPU 首选项注册表（HKCU UserGpuPreferences）。
    #[serde(default = "default_gpu_pref")]
    pub launch_gpu_pref: String,
    /// 游戏进程优先级："normal" / "high" / "low"。经 creation_flags 传给直启路径。
    #[serde(default = "default_launch_priority")]
    pub launch_priority: String,
    /// 启动前置命令（deepseek 任务·模块一）：启动游戏前执行一次的命令行。
    /// 直接走 cmd /C，失败则中止启动并带回输出；不经过任何 shell 解释用户路径以外的输入。
    #[serde(default)]
    pub launch_pre_command: String,
    /// 存档管理（865759）：部署前自动记录环境快照。默认开。
    #[serde(default = "default_true")]
    pub auto_snapshot: bool,
    /// 快照保留上限（默认 10），超出删最旧。set_settings 钳制 1–100。
    #[serde(default = "default_snapshot_limit")]
    pub snapshot_limit: usize,
    /// 外部存档编辑器（CyberCAT 等）.exe 绝对路径。空 = 未配置。
    #[serde(default)]
    pub save_editor_path: String,
}

fn default_snapshot_limit() -> usize {
    10
}

fn default_true() -> bool {
    true
}

fn default_launch_method() -> String {
    "auto".to_string()
}

fn default_close_behavior() -> String {
    "tray".to_string()
}

fn default_platform_pref() -> String {
    "auto".to_string()
}

fn default_ai_base_url() -> String {
    // 协议参考实现的端点。任何兼容 OpenAI 协议的服务都能填进来——这只是出厂默认，
    // 用户选一次预设就换掉了（normalize_base_url 会补 /chat/completions）。
    "https://api.openai.com/v1".to_string()
}

fn default_ai_model() -> String {
    // 必须非空：set_settings 会拒绝空模型名，空默认值会让「只改别的设置」也存不下去。
    "gpt-5.4-nano".to_string()
}

fn default_ai_protocol() -> String {
    "openai".to_string()
}

fn default_background_opacity() -> u8 {
    // 45：图片可辨识、又不至于盖过正文对比度的中间档。
    45
}

fn default_background_fit() -> String {
    // cover：绝大多数壁纸都是「宁可裁掉两边，也不要留白」。
    "cover".to_string()
}

fn default_background_pos() -> u8 {
    // 50 = 居中，符合直觉的默认焦点。
    50
}

fn default_background_dim() -> u8 {
    // 50：正好是看板要求的 rgba(0,0,0,0.5)。再淡正文对比度不够，再浓图就白放了。
    50
}

fn default_background_zoom() -> f64 {
    // 1.0 = 不缩放，维持填充模式原样（3A-3 裁切模态的基准档）。
    1.0
}

fn default_deploy_mode() -> String {
    "hardlink".to_string()
}

fn default_gpu_pref() -> String {
    "auto".to_string()
}

fn default_launch_priority() -> String {
    "normal".to_string()
}

fn default_wolvenkit_timeout_secs() -> u64 {
    // 与 wolvenkit.rs 共用同一份常量，避免「默认值文案」两处漂移。
    crate::wolvenkit::DEFAULT_TIMEOUT_SECS
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            write_modlist: false,
            vortex_takeover: false,
            auto_backup: true,
            confirm_uninstall: true,
            close_behavior: default_close_behavior(),
            close_ask: true,
            launch_method: default_launch_method(),
            platform_pref: default_platform_pref(),
            archive_tool_path: String::new(),
            wolvenkit_cli_path: String::new(),
            wolvenkit_timeout_secs: crate::wolvenkit::DEFAULT_TIMEOUT_SECS,
            ai_base_url: default_ai_base_url(),
            ai_model: default_ai_model(),
            ai_protocol: default_ai_protocol(),
            ai_profiles: Vec::new(),
            active_ai_profile_id: String::new(),
            nexus_hide_adult: true,
            launch_args: String::new(),
            nxm_auto_download: true,
            background_image: String::new(),
            background_opacity: default_background_opacity(),
            background_blur: 0,
            background_fit: default_background_fit(),
            background_pos_x: default_background_pos(),
            background_pos_y: default_background_pos(),
            background_dim: default_background_dim(),
            background_zoom: default_background_zoom(),
            deploy_mode: default_deploy_mode(),
            launch_gpu_pref: default_gpu_pref(),
            launch_priority: default_launch_priority(),
            launch_pre_command: String::new(),
            auto_snapshot: true,
            snapshot_limit: 10,
            save_editor_path: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created_at: String,
    pub root: String,
    pub game_dir: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateData {
    pub schema_version: u32,
    #[serde(default)]
    pub game_dir: Option<String>,
    pub staging_dir: String,
    #[serde(default)]
    pub mods: Vec<ModEntry>,
    #[serde(default)]
    pub load_order: Vec<String>,
    /// REDmod 的加载顺序（存 mod id，先加载的先赢）。
    ///
    /// 为什么不复用 `load_order`：那个列表的元素是 archive 的相对路径，REDmod 进去
    /// 会污染 archive 的排序归一化（`loadorder::normalized_order` 会把它当无效项丢掉）。
    /// 两者是两套独立的加载顺序，游戏也是分开读的（`archive/pc/mod/modlist.txt`
    /// vs `V2077/modlist.txt`）。
    #[serde(default)]
    pub redmod_order: Vec<String>,
    /// 已导入的整合包登记表。
    ///
    /// 2026-10-26 产品决定：旧的「本地大 ZIP 整合包」已废弃（生态改用
    /// Nexus Collections 清单），历史状态里的 modpacks 记录一律作废。
    /// 这里保留字段只是为了旧状态文件仍能正常解析——反序列化时强制清空，
    /// 于是下次落盘时磁盘上的旧记录也就一起消失了。
    #[serde(default, deserialize_with = "deserialize_always_empty")]
    pub modpacks: Vec<ModpackEntry>,
    /// 播放集：每套「启用哪些模组 + 加载顺序」的存档。
    #[serde(default)]
    pub profiles: Vec<ProfileEntry>,
    /// 当前正在使用的播放集 id。
    #[serde(default)]
    pub active_profile_id: Option<String>,
    /// 外部工具（deepseek 任务·模块三）：用户添加的本地 exe（REDlauncher、
    /// 存档编辑器…）。icon 是可选的 emoji/短字符，列表展示用；pinned = 固定到侧栏。
    #[serde(default)]
    pub external_tools: Vec<ExternalToolEntry>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub last_game_version: Option<String>,
    #[serde(default)]
    pub last_launch: Option<String>,
    #[serde(default)]
    pub backup: Option<BackupInfo>,
    /// 最近一次「检查 Mod 更新」的时间（ISO 8601，P5）。空 = 从未查过。
    #[serde(default)]
    pub last_update_check: Option<String>,
    /// 启动器 mod id → Vortex 安装目录名（= modState / loadOrders 键段）的持久映射。
    /// 放在 state 级而不是 ModEntry 上，避免改动 26 处结构体字面量；「重新配准」
    /// 命令全量刷新这份表，禁用 / 未部署的模组也能保持稳定身份。
    #[serde(default)]
    pub vortex_mod_ids: HashMap<String, String>,
}

impl AppStateData {
    pub fn new(staging_dir: String) -> Self {
        Self {
            schema_version: APP_SCHEMA_VERSION,
            game_dir: None,
            staging_dir,
            mods: Vec::new(),
            load_order: Vec::new(),
            redmod_order: Vec::new(),
            modpacks: Vec::new(),
            profiles: vec![ProfileEntry::default_profile()],
            active_profile_id: Some("profile-default".to_string()),
            external_tools: Vec::new(),
            settings: Settings::default(),
            last_game_version: None,
            last_launch: None,
            backup: None,
            last_update_check: None,
            vortex_mod_ids: HashMap::new(),
        }
    }
}

/// 反序列化时无视文件里的内容，一律返回空数组。
///
/// 用于 2026-10-26 废弃的 `modpacks` 字段：磁盘上的旧记录读进来就被丢掉，
/// 紧接着 `Store::load` 的落盘会把清空后的状态写回去，等于做了一次性迁移。
fn deserialize_always_empty<'de, D>(deserializer: D) -> Result<Vec<ModpackEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // 必须先把输入值消费掉（用 IgnoredAny 跳过，不要求旧结构能对上类型），
    // 否则 serde 的解析位置会错位，整个状态文件会被判为「损坏」并被重置为空——
    // 2026-10-26 就因为这里没消费而把 195 条模组索引清空了。
    let _ = <serde::de::IgnoredAny as serde::Deserialize>::deserialize(deserializer)?;
    Ok(Vec::new())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub root: String,
    pub exe_path: String,
    #[serde(default)]
    pub version: Option<String>,
    pub source: String,
    pub valid: bool,
    #[serde(default)]
    pub archive_dir: Option<String>,
    #[serde(default)]
    pub mods_dir: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub game_updated: bool,
    #[serde(default)]
    pub last_game_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    /// Relative to the game root, using forward slashes.
    pub target: String,
    pub mod_id: String,
    pub mod_name: String,
    #[serde(default)]
    pub other_mod_id: Option<String>,
    #[serde(default)]
    pub other_mod_name: Option<String>,
    /// "managed" or "unmanaged"
    pub kind: String,
    /// True when the candidate mod is still staged: enabling it would collide.
    #[serde(default)]
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOrderItem {
    pub id: String,
    pub mod_id: String,
    pub mod_name: String,
    pub filename: String,
    pub category: String,
    pub deployed: bool,
    pub order: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOrderView {
    pub archives: Vec<LoadOrderItem>,
    pub redmods: Vec<LoadOrderItem>,
    pub modlist_path: Option<String>,
    pub modlist_exists: bool,
    pub managed_modlist: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployReport {
    pub mod_entry: ModEntry,
    pub deployed: usize,
    pub hard_links: usize,
    pub symlinks: usize,
    pub copies: usize,
    pub warnings: Vec<String>,
    /// true = 这条模组的暂存文件在外部被删了，记录已被自动清理。前端要把卡片
    /// 从列表里去掉，而不是当成「部署成功」更新它。
    #[serde(default)]
    pub purged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub path: String,
    pub success: bool,
    #[serde(default)]
    pub mod_entry: Option<ModEntry>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSettingEntry {
    pub section: String,
    pub key: String,
    pub value: String,
    /// "bool" | "number" | "string"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSettingSection {
    pub name: String,
    pub entries: Vec<ModSettingEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSettingsView {
    pub path: String,
    pub exists: bool,
    pub framework_installed: bool,
    pub sections: Vec<ModSettingSection>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub path: String,
    pub name: String,
    pub category: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub number: usize,
    pub text: String,
    /// "error" | "warn" | "info" | "muted"
    pub level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    pub path: String,
    pub name: String,
    pub lines: Vec<LogLine>,
    pub truncated: bool,
    pub file_size_bytes: u64,
    pub tail_limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameworkStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub required: bool,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticIssue {
    pub id: String,
    /// error | warning | info | ok
    pub severity: String,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub generated_at: String,
    pub game: Option<GameInfo>,
    pub frameworks: Vec<FrameworkStatus>,
    pub issues: Vec<DiagnosticIssue>,
    pub summary: String,
    pub summary_level: String,
    pub deployed_mods: usize,
    pub enabled_mods: usize,
    pub total_mods: usize,
    pub conflict_count: usize,
    pub log_paths: Vec<String>,
    pub backup: Option<BackupInfo>,
    /// 前置依赖健康检查结果。`#[serde(default)]` 让旧前端/旧快照也能反序列化
    /// （这个结构只走命令返回值，不落盘，但默认值能省掉一次前端空值判断）。
    #[serde(default)]
    pub dependencies: crate::deps::DependencyReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub method: String,
    pub detail: String,
    /// 命中的平台：steam / gog / epic / manual（前端只做展示，不参与判断）。
    #[serde(default)]
    pub platform: String,
    /// 直启失败自动回退时记录原路由（当前只有 "direct"），成功直启为 null。
    #[serde(default)]
    pub fallback_from: Option<String>,
    /// 启动链给出的说明（例如「Steam 未运行，已改用 Steam 启动」）。
    #[serde(default)]
    pub notes: Vec<String>,
}

/// 一条 `nxm://` 链接的结构化形态（由 nxm.rs 解析，前端只做展示与派活）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NxmLink {
    pub uri: String,
    /// 游戏 domain，目前只可能是 `cyberpunk2077`。
    pub domain: String,
    pub mod_id: u64,
    /// 没有 `/files/<id>` 时为空：只能打开模组页，选不了具体文件。
    #[serde(default)]
    pub file_id: Option<u64>,
    /// Nexus 生成的签名参数。本启动器用自己存的 API Key 下载，这里只用于展示/排查。
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub expires: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
}

/// `nxm://` 协议处理器的当前归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NxmStatus {
    /// 当前处理器是否指向本启动器。
    /// 注意与 `registered` 的区别：Vortex 占着协议时 `registered=true` 而 `ours=false`。
    pub ours: bool,
    /// `nxm://` 协议本身是否已注册（有键、有命令），不管归属是谁。
    pub registered: bool,
    /// `us` = 本启动器接管中；`other` = 被别的程序（通常是 Vortex）占着；`none` = 未注册。
    pub owner: String,
    /// 注册表里实际的命令行，原样给界面展示，方便用户确认抢回来的是谁。
    #[serde(default)]
    pub handler: Option<String>,
    /// 接管前备份的处理器命令行（有备份才能「交还」）。
    #[serde(default)]
    pub backup: Option<String>,
    #[serde(default)]
    pub backup_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub undeployed: usize,
    pub restored_files: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: AppStateData,
    pub game: Option<GameInfo>,
    pub load_order: LoadOrderView,
    pub conflicts: Vec<ConflictInfo>,
    pub demo_mode: bool,
    /// 状态文件读不出来时，原文件被改名保留的路径；界面据此提示"模组不是被删了"。
    #[serde(default)]
    pub state_recovered_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusUser {
    pub name: String,
    #[serde(default)]
    pub profile_url: Option<String>,
    pub is_premium: bool,
    pub is_supporter: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusStatus {
    pub configured: bool,
    pub connected: bool,
    #[serde(default)]
    pub user: Option<NexusUser>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusModSummary {
    pub mod_id: u64,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub picture_url: Option<String>,
    #[serde(default)]
    pub mod_page_url: Option<String>,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub endorsements: u64,
    #[serde(default)]
    pub adult: bool,
    #[serde(default)]
    pub updated_time: Option<String>,
    #[serde(default)]
    pub created_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusFile {
    pub file_id: u64,
    pub name: String,
    pub file_name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub size_kb: u64,
    #[serde(default)]
    pub uploaded_time: Option<String>,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusModDetail {
    pub summary: NexusModSummary,
    #[serde(default)]
    pub description: String,
    pub files: Vec<NexusFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusDownloadResult {
    pub outcome: InstallOutcome,
    pub file_name: String,
    pub path: String,
    pub reused: bool,
}

/// 批量补全 Nexus 封面的结果。
///
/// 只有「从 N 网下载」那条路径会顺手存下封面，更早入库的记录 `nexus_cover_url`
/// 是 None，列表里只能回退到程序生成的占位图。回查一次把地址缓存进库，
/// 之后渲染列表不再需要联网，所以这是一次性补数据而不是每次打开都查。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusCoverRefresh {
    /// 成功补到封面的数量
    pub updated: usize,
    /// 请求失败的数量
    pub failed: usize,
    /// 本就没有 Nexus 来源、不需要补的数量
    pub skipped: usize,
    /// 给玩家看的一句话总结（中文）
    pub message: String,
}

/// 「补全 Nexus 信息」的结果：从文件名里认出 Nexus ModId 后反查官方元数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusEnrichReport {
    /// 检查过的模组数
    pub scanned: usize,
    /// 从文件名/路径里认出 ModId 的数量
    pub matched: usize,
    /// 成功写回名称/作者/版本/封面等元数据的数量
    pub updated: usize,
    /// 认出了 ModId 但请求失败（下架/网络/限流）的数量
    pub failed: usize,
    /// 没认出 ModId（非 Nexus 来源或文件名不合规），需手动编辑的数量
    pub unmatched: usize,
    pub message: String,
}

/// 一个有新版本的模组（#1 更新检查）。只做「发现 + 引导」，
/// 不做自动覆盖安装——更新永远要用户自己确认。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusUpdateItem {
    /// 库内 ModEntry id，前端据此在列表上打徽标。
    pub entry_id: String,
    pub mod_id: u64,
    pub name: String,
    /// 安装时的版本（可能为空：老记录没存）。
    pub current_version: Option<String>,
    /// Nexus 当前最新版本。
    pub latest_version: String,
    /// 模组页地址，前端一键跳转。
    pub page_url: String,
}

/// nexus_check_updates 的返回。checked 是实际发出请求的数量，
/// skipped 是没有 Nexus 来源或没有可比版本的条目数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusUpdateReport {
    pub checked: usize,
    pub skipped: usize,
    pub failed: usize,
    pub updates: Vec<NexusUpdateItem>,
    /// 有 Nexus 来源、但本轮配额用完没查的条目数（P5）。它们既不算「无更新」
    /// 也不算失败，界面上单独说明「还有 N 个没查完」。
    #[serde(default)]
    pub stale: usize,
    /// 给玩家看的一句话总结（中文）。
    pub message: String,
    /// 本轮检查时间（ISO 8601）。
    pub generated_at: String,
}

/// 一套 AI 配置（非机密部分）。
///
/// 🔴 故意**不**存 key：密钥各自走 DPAPI 文件（`secrets/ai-profile-<id>.key`），
/// 所以这份结构可以安全地写进 launcher-state.json、也可以被导出。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    /// 稳定 id（"default" 是老用户迁移出来的那条，沿用旧的密钥文件名）。
    #[serde(default)]
    pub id: String,
    /// 玩家自己起的备注名，例如「DeepSeek 主力」「本地 Ollama」。
    #[serde(default)]
    pub name: String,
    /// 预设厂商 id（`deepseek` / `ollama` …），自定义时为空串。
    #[serde(default)]
    pub vendor: String,
    pub base_url: String,
    pub model: String,
    /// openai | anthropic
    #[serde(default = "default_ai_protocol")]
    pub protocol: String,
}

/// 给前端用的一套配置：多两个只读标记。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileView {
    /// 嵌套而不是拍平：前端保存时要把整份 profile 原样传回去，
    /// 拍平后 `hasKey/active` 两个只读字段会混进可写结构里，容易误写。
    pub profile: AiProfile,
    /// 这套配置是否已经存了可用的密钥。
    pub has_key: bool,
    /// 是否是当前激活的那一套。
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileList {
    pub profiles: Vec<AiProfileView>,
    pub active_id: String,
}

/// 「测试连接」结果。不做成错误，是为了让失败也能稳定显示延迟/状态码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    pub ok: bool,
    #[serde(default)]
    pub status_code: Option<u16>,
    pub latency_ms: u64,
    pub message: String,
    /// 成功时顺带回传模型数量，便于确认"确实连到了那家服务"。
    #[serde(default)]
    pub model_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub configured: bool,
    pub base_url: String,
    pub model: String,
    /// 当前生效的接口协议："openai" | "anthropic"。
    pub protocol: String,
}

/// AI 诊断给出的一条**可执行**修复动作。
///
/// 🔴 安全边界：AI 只能从这四个 kind 里选、只能指向快照里出现过的模组 id，
/// 且真正的文件操作全部由 Rust 侧执行（AI 拿不到任何文件系统的写权限）。
/// `label` / `reason` 只用于按钮文案，执行时一律以 `kind + target + position` 为准，
/// 不解析 AI 给的自然语言。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiFixAction {
    /// 稳定 id（AI 给，缺失时后端补），前端用作 React key。
    #[serde(default)]
    pub id: String,
    /// disableMod | enableMod | moveLoadOrder | proposePatch
    pub kind: String,
    /// 目标模组 id；proposePatch 时也是模组 id。
    #[serde(default)]
    pub target: String,
    /// 目标模组显示名（后端会用库里的真名覆盖，避免 AI 写错导致按钮看不懂）。
    #[serde(default)]
    pub target_name: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub reason: String,
    /// moveLoadOrder 专用：first | last。
    #[serde(default)]
    pub position: Option<String>,
}

/// 执行一条 AI 动作的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionReport {
    pub kind: String,
    pub target: String,
    pub message: String,
    /// 执行前自动创建的环境快照 id（可据此回滚）。
    #[serde(default)]
    pub snapshot_id: Option<String>,
    /// proposePatch 专用：前端据此打开 AI 补丁对话框（需要用户填意图）。
    #[serde(default)]
    pub needs_intent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDiagnosis {
    pub summary: String,
    pub likely_cause: String,
    pub evidence: Vec<String>,
    pub fix_steps: Vec<String>,
    /// 可执行的修复动作（白名单校验过；可能为空 —— 纯文字报告仍然可用）。
    #[serde(default)]
    pub actions: Vec<AiFixAction>,
    pub confidence: String,
    #[serde(default)]
    pub needs_more_info: Vec<String>,
    pub model: String,
    pub generated_at: String,
    pub sent_chars: usize,
    pub redactions: usize,
    /// Redacted context, so the UI can show exactly what left the machine.
    pub context_preview: String,
}

/// 体检发现的一条文件级问题。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvIssue {
    pub mod_id: String,
    pub mod_name: String,
    pub relative_path: String,
    /// missing / size / time / source_missing
    pub kind: String,
    pub detail: String,
}

/// 一次环境体检的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDiagnosis {
    /// healthy / warning / critical
    pub level: String,
    pub checked_mods: usize,
    pub checked_files: usize,
    pub issues: Vec<EnvIssue>,
    pub summary: String,
}

/// 一键自愈的结果。`stillBroken` 里的条目必须靠重新导入才能修好。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealReport {
    pub repaired: usize,
    pub still_broken: Vec<EnvIssue>,
    pub level: String,
    pub message: String,
}

/// 物理状态自同步的结果（启动 / 刷新时自动跑）。
///
/// 场景：玩家在 Vortex 或资源管理器里直接删了暂存文件，本地数据库还留着记录，
/// 于是每次启用都报「暂存文件不见了」。这里把数据库拉回和磁盘一致的状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalSyncReport {
    /// 本次扫描的模组总数。
    pub checked: usize,
    /// 暂存内容已丢失、记录被清理的模组名。
    pub removed: Vec<String>,
    /// 暂存目录失效但已从游戏目录恢复成功的模组名（记录保留）。
    pub repaired: Vec<String>,
    /// 判定不了 / 无法安全清理，暂时保留记录的模组名。
    pub deferred: Vec<String>,
    /// 清理过程中遇到的异常（删除被拒、恢复冲突等）。
    pub warnings: Vec<String>,
}

impl PhysicalSyncReport {
    /// 有没有真的改动过状态：前端据此决定要不要重拉快照。
    pub fn touched(&self) -> bool {
        !self.removed.is_empty() || !self.repaired.is_empty()
    }
}

/// 播放集：一套「启用哪些 Mod + 加载顺序」的存档。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEntry {
    pub id: String,
    pub name: String,
    /// 这套播放集里启用的模组 id。顺序即部署顺序。
    #[serde(default)]
    pub enabled_mod_ids: Vec<String>,
    /// archive 文件名序列，与 `AppStateData.load_order` 同构（不是 mod_id）。
    #[serde(default)]
    pub load_order: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 内置的 Default 播放集：不可删除、不可重命名。
    #[serde(default)]
    pub builtin: bool,
}

/// 外部工具（deepseek 任务·模块三）：一个用户登记的本地 exe。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    /// 可选图标：emoji / 1-2 个字符的短标记。None = 用首字母。
    #[serde(default)]
    pub icon: Option<String>,
    /// 固定到左侧主导航。
    #[serde(default)]
    pub pinned: bool,
    pub created_at: String,
}

impl ProfileEntry {
    /// 内置默认播放集。`enabled_mod_ids` / `load_order` 在首次迁移时按现状回填。
    pub fn default_profile() -> Self {
        let now = crate::store::now_iso();
        Self {
            id: "profile-default".to_string(),
            name: "Default".to_string(),
            enabled_mod_ids: Vec::new(),
            load_order: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
            builtin: true,
        }
    }
}

/// 切换播放集的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProfileReport {
    pub profile: ProfileEntry,
    pub undeployed: usize,
    pub deployed: usize,
    pub warnings: Vec<String>,
}
/// 播放集列表 + 当前激活项，前端一次拿到完整状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileList {
    pub profiles: Vec<ProfileEntry>,
    pub active_profile_id: Option<String>,
}

#[cfg(test)]
mod modpacks_cleared_on_load {
    use super::*;

    /// 回归测试（2026-10-26 事故）：`modpacks` 被强制清空时，
    /// 反序列化器必须消费掉输入值，否则整个状态文件解析失败、
    /// 表现为「状态损坏」并被重置为空（那次丢了 195 条模组索引）。
    #[test]
    fn modpacks_field_is_ignored_but_still_consumed() {
        let raw = r#"{
            "schemaVersion": 1,
            "gameDir": "d:////steam////games////Cyberpunk 2077",
            "stagingDir": "C:////tmp////staging",
            "mods": [],
            "loadOrder": [],
            "modpacks": [{"id": "pack-1", "name": "旧整合包", "childModIds": ["a", "b"]}],
            "profiles": [],
            "activeProfileId": null,
            "settings": {}
        }"#;
        let state: AppStateData = serde_json::from_str(raw).expect("状态文件必须能解析");
        assert!(state.modpacks.is_empty(), "modpacks 必须被清空");
    }
}

// ── Vortex 接管体检（P0，只读）────────────────────────────────────────
// 这些结构只承载「取证结果」，不承载写入动作。P1 的双写会复用同一份指纹口径，
// 但写入必须另立命令、另立守卫，不能借体检命令顺手改状态。

/// 一条启用状态漂移：启动器与 Vortex 记的不一样，或 Vortex 根本没这条记录。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexDriftItem {
    /// 启动器侧模组 id。
    pub mod_id: String,
    pub name: String,
    /// 精确配准到的 Vortex 目录名（= modState 键段）。
    pub vortex_mod_id: String,
    pub cyberdeck_enabled: bool,
    /// None 表示 Vortex 侧没有这个模组的 enabled 记录。
    pub vortex_enabled: Option<bool>,
    /// "enabledMismatch" | "vortexMissing"
    pub kind: String,
}

/// 接管体检报告。available=false 时其余字段是空值，界面应先展示 reason。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexTakeoverPreflight {
    pub available: bool,
    /// Vortex 运行时状态库被独占锁住；这是 P1 写入的硬门槛。
    pub db_locked: bool,
    pub reason: String,
    pub state_dir: String,
    pub active_profile_id: String,
    pub profile_game_id: String,
    pub profile_ok: bool,
    pub vortex_mod_count: usize,
    pub vortex_enabled_count: usize,
    pub vortex_disabled_count: usize,
    pub archive_order: Vec<String>,
    pub redmod_order: Vec<String>,
    /// 两侧加载顺序交集按各自顺序是否一致。
    pub archive_order_same: bool,
    pub mapped_mod_count: usize,
    pub unmapped_mod_count: usize,
    pub drift: Vec<VortexDriftItem>,
    pub fingerprint: String,
    pub warnings: Vec<String>,
}

/// 暂存区体检：只列目录名与体积，绝不删除。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptStagingHealth {
    pub staging_dir: String,
    pub dirs_total: usize,
    pub registered_total: usize,
    pub orphan_dirs: Vec<String>,
    pub missing_dirs: Vec<String>,
    pub orphan_bytes: u64,
    pub warnings: Vec<String>,
}

// ── Vortex 状态双写（接管 P1/P2）──────────────────────────────────────
// 报告只读化：mirror 的失败不抛给本地事务，而是落 pending + 界面可见，
// 避免「本地改了、Vortex 没跟上」被当成成功。

/// 一次双写的结果。ok=false 时 reason 必须展示给用户。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexSyncReport {
    pub ok: bool,
    pub written: usize,
    /// 写前快照的绝对路径，可用于一键还原。
    pub backup: String,
    pub reason: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexSyncStatus {
    pub takeover_enabled: bool,
    pub pending_count: usize,
    pub backups: Vec<String>,
    pub last_sync: VortexSyncReport,
}

// ── Vortex 接管 P3：配准 / 对账 / 预检 ─────────────────────────────────

/// 全库重新配准的结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexMappingReport {
    pub total: usize,
    pub mapped: usize,
    pub unmapped: usize,
    pub persisted: usize,
    /// 目录已不在 Vortex、因此清掉旧绑定的条目数。
    pub cleared: usize,
    pub warnings: Vec<String>,
}

/// 漂移对账结果。strategy=report 时 applied 恒为 0。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexReconcileReport {
    pub strategy: String,
    pub checked: usize,
    pub drift: Vec<VortexDriftItem>,
    pub applied: usize,
    pub warnings: Vec<String>,
}

/// 切到 Vortex 前的一致性预检。ready=false 时不要把控制权交给 Vortex。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexPrelaunchReport {
    pub ready: bool,
    pub takeover_enabled: bool,
    pub db_locked: bool,
    pub pending_count: usize,
    pub drift_count: usize,
    pub warnings: Vec<String>,
}
