use serde::{Deserialize, Serialize};
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
    pub name: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Off by default: the game's native modlist.txt is powerful and easy to get wrong.
    #[serde(default)]
    pub write_modlist: bool,
    #[serde(default = "default_true")]
    pub auto_backup: bool,
    #[serde(default = "default_true")]
    pub confirm_uninstall: bool,
    /// 点击关闭按钮时的行为：`tray` = 最小化到托盘（默认），`exit` = 直接退出。
    /// 旧状态文件没有这个字段，serde default 兜底为 tray，不会反序列化失败。
    #[serde(default = "default_close_behavior")]
    pub close_behavior: String,
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
            auto_backup: true,
            confirm_uninstall: true,
            close_behavior: default_close_behavior(),
            launch_method: default_launch_method(),
            platform_pref: default_platform_pref(),
            archive_tool_path: String::new(),
            wolvenkit_cli_path: String::new(),
            wolvenkit_timeout_secs: crate::wolvenkit::DEFAULT_TIMEOUT_SECS,
            ai_base_url: default_ai_base_url(),
            ai_model: default_ai_model(),
            ai_protocol: default_ai_protocol(),
            nexus_hide_adult: true,
            launch_args: String::new(),
            nxm_auto_download: true,
            background_image: String::new(),
            background_opacity: default_background_opacity(),
            background_blur: 0,
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
}

impl AppStateData {
    pub fn new(staging_dir: String) -> Self {
        Self {
            schema_version: APP_SCHEMA_VERSION,
            game_dir: None,
            staging_dir,
            mods: Vec::new(),
            load_order: Vec::new(),
            modpacks: Vec::new(),
            profiles: vec![ProfileEntry::default_profile()],
            active_profile_id: Some("profile-default".to_string()),
            external_tools: Vec::new(),
            settings: Settings::default(),
            last_game_version: None,
            last_launch: None,
            backup: None,
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
    /// 给玩家看的一句话总结（中文）。
    pub message: String,
    /// 本轮检查时间（ISO 8601）。
    pub generated_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDiagnosis {
    pub summary: String,
    pub likely_cause: String,
    pub evidence: Vec<String>,
    pub fix_steps: Vec<String>,
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
