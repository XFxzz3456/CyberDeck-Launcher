use crate::schema::{
    AppResult, CommandError, FrameworkStatus, GameInfo, LaunchResult, STEAM_APP_ID,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 游戏主进程名。直启目标与「是否已在运行」判定都用它。
pub const GAME_EXE: &str = "Cyberpunk2077.exe";
/// 官方启动器（splash / REDlauncher）进程名。
pub const PRELAUNCHER_EXE: &str = "REDprelauncher.exe";
/// 直启后观察窗口：2 秒内进程就退出，判定为直启失败（DRM 拦截 / 缺运行库），走回退。
const DIRECT_PROBE_MS: u64 = 2000;

pub fn detected_exe(root: &Path) -> PathBuf {
    root.join("bin").join("x64").join(GAME_EXE)
}

pub fn prelauncher_path(root: &Path) -> PathBuf {
    root.join("bin").join("x64").join(PRELAUNCHER_EXE)
}

pub fn inspect_game(root: &Path, source: &str, last_version: Option<&str>) -> GameInfo {
    let exe = detected_exe(root);
    let valid = exe.is_file();
    let version = if valid { file_version(&exe) } else { None };
    let game_updated = match (last_version, version.as_deref()) {
        (Some(previous), Some(current)) => !previous.is_empty() && previous != current,
        _ => false,
    };
    GameInfo {
        root: root.to_string_lossy().to_string(),
        exe_path: exe.to_string_lossy().to_string(),
        version,
        source: source.to_string(),
        valid,
        archive_dir: Some(root.join("archive").join("pc").join("mod").to_string_lossy().to_string()),
        mods_dir: Some(root.join("mods").to_string_lossy().to_string()),
        language: read_game_language(root),
        game_updated,
        last_game_version: last_version.map(ToString::to_string),
    }
}

/// 游戏更新熔断：当前 exe 版本与上次确认过的版本不一致时锁住。
///
/// 判定的边界要说清楚：
/// - 首次绑定路径（`last` 为空）→ **不算**更新，不弹警告；
/// - 读不到版本（`current` 为空）→ 无法判断，按未更新处理，避免误锁；
/// - 两边都有且不同 → 锁定，等待用户确认前置已升级。
pub fn update_lock_active(last_version: Option<&str>, current: Option<&str>) -> bool {
    match (last_version, current) {
        (Some(prev), Some(cur)) => !prev.is_empty() && !cur.is_empty() && prev != cur,
        _ => false,
    }
}

/// 自动嗅探游戏目录（平台偏好为 auto）。
pub fn detect_game(preferred: Option<&str>, last_version: Option<&str>) -> Option<GameInfo> {
    detect_game_with_platform(preferred, last_version, "auto")
}

/// 带平台偏好的嗅探。
///
/// `platform_pref` 只决定探测顺序，找不到就继续试其他平台——
/// 玩家填错平台不该导致「明明装了游戏却说找不到」。
pub fn detect_game_with_platform(
    preferred: Option<&str>,
    last_version: Option<&str>,
    platform_pref: &str,
) -> Option<GameInfo> {
    let mut candidates: Vec<(PathBuf, String)> = Vec::new();
    if let Some(path) = preferred.filter(|p| !p.trim().is_empty()) {
        candidates.push((PathBuf::from(path), "manual".to_string()));
    }

    // 平台偏好只调换探测顺序：先试玩家指定的平台，再按默认顺序兜底。
    let pref = platform_pref.trim().to_ascii_lowercase();
    let order: [&str; 4] = match pref.as_str() {
        "steam" => ["steam", "gog", "epic", "manual"],
        "gog" => ["gog", "steam", "epic", "manual"],
        "epic" => ["epic", "steam", "gog", "manual"],
        _ => ["steam", "gog", "epic", "manual"],
    };
    for platform in order {
        match platform {
            "steam" => {
                for (path, source) in steam_candidates() {
                    candidates.push((path, format!("steam:{source}")));
                }
            }
            "gog" => {
                if let Some(path) = gog_candidate() {
                    candidates.push((path, "gog".to_string()));
                }
            }
            "epic" => {
                if let Some(path) = epic_candidate() {
                    candidates.push((path, "epic".to_string()));
                }
            }
            _ => {
                for path in common_paths() {
                    candidates.push((path, "manual".to_string()));
                }
            }
        }
    }

    for (root, source) in candidates {
        if detected_exe(&root).is_file() {
            let clean_source = if source.starts_with("steam:") {
                "steam"
            } else {
                source.as_str()
            };
            return Some(inspect_game(&root, clean_source, last_version));
        }
    }
    None
}

fn steam_candidates() -> Vec<(PathBuf, String)> {
    let mut paths: Vec<(PathBuf, String)> = Vec::new();
    let mut steam_root: Option<PathBuf> = None;

    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
        if let Ok(value) = key.get_value::<String, _>("SteamPath") {
            steam_root = Some(PathBuf::from(value.replace('/', "\\")));
        }
    }
    if steam_root.is_none() {
        for key_path in [
            "SOFTWARE\\WOW6432Node\\Valve\\Steam",
            "SOFTWARE\\Valve\\Steam",
        ] {
            if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(key_path) {
                if let Ok(value) = key.get_value::<String, _>("InstallPath") {
                    steam_root = Some(PathBuf::from(value));
                    break;
                }
            }
        }
    }

    let Some(root) = steam_root else {
        return paths;
    };
    paths.push((
        root.join("steamapps").join("common").join("Cyberpunk 2077"),
        "library".to_string(),
    ));

    let library_file = root.join("steamapps").join("libraryfolders.vdf");
    if let Ok(raw) = fs::read_to_string(library_file) {
        for line in raw.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("\"path\"") {
                continue;
            }
            let quoted: Vec<&str> = trimmed.split('"').collect();
            if quoted.len() >= 5 && quoted[1] == "path" {
                let value = quoted[3].replace("\\\\", "\\");
                let library = PathBuf::from(value);
                paths.push((
                    library
                        .join("steamapps")
                        .join("common")
                        .join("Cyberpunk 2077"),
                    "library".to_string(),
                ));
            }
        }
    }
    paths
}

fn gog_candidate() -> Option<PathBuf> {
    for key_path in [
        "SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1091500",
        "SOFTWARE\\GOG.com\\Games\\1091500",
    ] {
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(key_path) {
            if let Ok(value) = key.get_value::<String, _>("path") {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

fn epic_candidate() -> Option<PathBuf> {
    let manifests = PathBuf::from(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    let entries = fs::read_dir(manifests).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("item")) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let display = json
            .get("DisplayName")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !display.eq_ignore_ascii_case("Cyberpunk 2077") {
            continue;
        }
        if let Some(location) = json.get("InstallLocation").and_then(Value::as_str) {
            return Some(PathBuf::from(location));
        }
    }
    None
}

fn common_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for drive in ["C", "D", "E", "F", "G", "H"] {
        for suffix in [
            "SteamLibrary\\steamapps\\common\\Cyberpunk 2077",
            "Steam\\steamapps\\common\\Cyberpunk 2077",
            "Games\\Cyberpunk 2077",
            "GOG Games\\Cyberpunk 2077",
            "Epic Games\\Cyberpunk 2077",
        ] {
            paths.push(PathBuf::from(format!("{drive}:\\{suffix}")));
        }
    }
    paths
}

pub fn validate_game_dir(root: &Path) -> AppResult<GameInfo> {
    if !root.is_dir() {
        return Err(CommandError::new(
            "GAME_DIR_NOT_FOUND",
            format!("目录不存在：{}", root.display()),
        ));
    }
    if !detected_exe(root).is_file() {
        return Err(CommandError::new(
            "GAME_EXE_NOT_FOUND",
            format!(
                "这里不像 Cyberpunk 2077 的游戏根目录：没有找到 bin\\x64\\Cyberpunk2077.exe。\n你选择的是：{}",
                root.display()
            ),
        ));
    }
    Ok(inspect_game(root, "manual", None))
}

pub fn file_version(path: &Path) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut handle = 0u32;
        let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        if GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) == 0 {
            return None;
        }
        let sub_block: Vec<u16> = "\\\0".encode_utf16().collect();
        let mut value_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut value_len = 0u32;
        if VerQueryValueW(
            buffer.as_ptr().cast(),
            sub_block.as_ptr(),
            &mut value_ptr,
            &mut value_len,
        ) == 0
            || value_ptr.is_null()
        {
            return None;
        }
        // VS_FIXEDFILEINFO: dwFileVersionMS lives at byte 8, dwFileVersionLS at byte 12.
        // Reading the two u32 values directly avoids depending on a bindgen struct layout.
        let base = value_ptr as *const u8;
        let ms = std::ptr::read_unaligned(base.add(8) as *const u32);
        let ls = std::ptr::read_unaligned(base.add(12) as *const u32);
        Some(format!(
            "{}.{}.{}.{}",
            (ms >> 16) & 0xffff,
            ms & 0xffff,
            (ls >> 16) & 0xffff,
            ls & 0xffff
        ))
    }
}

pub fn read_game_language(root: &Path) -> Option<String> {
    let candidates = [
        root.join("r6").join("config").join("settings").join("UserSettings.json"),
        root.join("r6").join("config").join("settings").join("userSettings.json"),
    ];
    for path in candidates {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(value) = find_key(&json, &["language", "Language", "textLanguage"]) {
            if let Some(text) = value.as_str() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn find_key<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if keys.iter().any(|wanted| key.eq_ignore_ascii_case(wanted)) {
                    if child.is_string() {
                        return Some(child);
                    }
                }
                if let Some(found) = find_key(child, keys) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(|item| find_key(item, keys)),
        _ => None,
    }
}

/// 大小写不敏感地逐级解析相对路径。
///
/// Windows 的 NTFS 默认不区分大小写，但游戏目录常被搬来搬去（网盘、外接盘、exFAT、
/// 从别人的压缩包解出来），实测见过 `Red4ext` / `ARCHIVEXL` / `mod_settings` 这类
/// 大小写变体；逐级 read_dir 比对一次，代价只是一次目录枚举，换「大小写不同也认」。
/// 分隔符不用额外处理：`PathBuf::join` 在 Windows 上统一成 `\`，用户填正斜杠也能拼对。
/// 路径段归一化：去掉 `_` `-` `.` 空格后转小写，用于「同一个东西的不同写法」比对。
fn squash(name: &str) -> String {
    name.chars()
        .filter(|ch| !matches!(ch, '_' | '-' | '.' | ' '))
        .flat_map(char::to_lowercase)
        .collect()
}

fn resolve_ci(root: &Path, segments: &[&str]) -> Option<PathBuf> {
    let mut current = root.to_path_buf();
    for segment in segments {
        let direct = current.join(segment);
        if direct.exists() {
            current = direct;
            continue;
        }
        let entries = fs::read_dir(&current).ok()?;
        let wanted = squash(segment);
        let mut matched: Option<PathBuf> = None;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // 两档匹配：先按大小写不敏感的原名，再按「去掉下划线/连字符/空格」
            // 的归一化名。第二档是必须的——真实安装里同一个东西会写成
            // `cyber_engine_tweaks`、`CyberEngineTweaks`、`Cyber Engine Tweaks`
            // 三种，只做大小写不敏感会让前两种互不认，玩家的目录明明在却被判 MISSING。
            if name.eq_ignore_ascii_case(segment) || squash(&name) == wanted {
                matched = Some(entry.path());
                break;
            }
        }
        current = matched?;
    }
    Some(current)
}

/// 多候选探测：按声明顺序尝试，第一个存在的就是「已安装」的证据。
fn locate(root: &Path, candidates: &[&[&str]]) -> Option<PathBuf> {
    candidates
        .iter()
        .find_map(|segments| resolve_ci(root, segments))
}

pub fn framework_statuses(root: &Path) -> Vec<FrameworkStatus> {
    vec![
        status(
            root,
            "red4ext",
            "RED4ext",
            &[&["red4ext", "RED4ext.dll"]],
            false,
            "多数现代框架的运行基础",
        ),
        status(
            root,
            "cet",
            "Cyber Engine Tweaks",
            &[
                // 标准安装：插件目录里有主 dll
                &[
                    "bin",
                    "x64",
                    "plugins",
                    "cyber_engine_tweaks",
                    "cyber_engine_tweaks.dll",
                ][..],
                // 入口脚本：个别分发版本把 dll 改名或放在子目录，但 init.lua 一定在
                &[
                    "bin",
                    "x64",
                    "plugins",
                    "cyber_engine_tweaks",
                    "init.lua",
                ][..],
                // 目录兜底：2026-10-30 实测反馈——玩家目录明明有
                // bind\plugins\cyber_engine_tweaks\，却一直显示 MISSING。
                // 只认 dll 等于把「权限读不到 dll」「版本换了 dll 名」都判成没装；
                // 目录存在就是强证据（CET 不会空建这个目录）。
                &["bin", "x64", "plugins", "cyber_engine_tweaks"][..],
            ],
            false,
            "CET 控制台 / Lua 模组运行时",
        ),
        status(
            root,
            "redscript",
            "redscript",
            &[
                // 新版 redscript 的编译器已改名 scc.exe（官方扩展亦以它为准），
                // 排在旧名之前，否则装上最新版反而被判成缺失（假红灯）。
                &["engine", "tools", "scc.exe"][..],
                // 老发行包仍叫 redscript-cli.exe，保留作兼容兜底。
                &["engine", "tools", "redscript-cli.exe"][..],
                // scc 的配置存在即说明装过（个别版本不带 exe，走全局安装）。
                &["r6", "config", "cybercmd", "scc.toml"][..],
                // 只认 CLI 会漏判：绝大多数玩家是用 Vortex/手动把 .reds 标准库解到
                // r6/scripts 的，CLI 往往不在（发行包版本不同）。
                &["r6", "scripts"][..],
            ],
            false,
            "编译 r6/scripts 下的 .reds 脚本",
        ),
        status(
            root,
            "archivexl",
            "ArchiveXL",
            &[&["red4ext", "plugins", "ArchiveXL", "ArchiveXL.dll"]],
            false,
            "扩展 archive 加载能力（需 RED4ext）",
        ),
        status(
            root,
            "tweakxl",
            "TweakXL",
            &[&["red4ext", "plugins", "TweakXL", "TweakXL.dll"]],
            false,
            "TweakDB 修改支持（需 RED4ext）",
        ),
        status(
            root,
            "codeware",
            "Codeware",
            &[&["red4ext", "plugins", "Codeware", "Codeware.dll"]],
            false,
            "许多功能模组依赖的脚本库",
        ),
        status(
            root,
            "modsettings",
            "Mod Settings",
            &[
                // RED4ext 版（新版主推）：靠 dll 文件本身做实证，不看文件夹名
                &["red4ext", "plugins", "mod_settings", "ModSettings.dll"][..],
                // CET 版：入口在 mods/<ModSettings>/init.lua
                &[
                    "bin",
                    "x64",
                    "plugins",
                    "cyber_engine_tweaks",
                    "mods",
                    "ModSettings",
                    "init.lua",
                ][..],
                // 兜底：个别分发只建了目录、入口文件名不同
                &[
                    "bin",
                    "x64",
                    "plugins",
                    "cyber_engine_tweaks",
                    "mods",
                    "ModSettings",
                ][..],
            ],
            false,
            "模组统一设置菜单（RED4ext 版或 CET 版）",
        ),
    ]
}

fn status(
    root: &Path,
    id: &str,
    name: &str,
    candidates: &[&[&str]],
    required: bool,
    note: &str,
) -> FrameworkStatus {
    let found = locate(root, candidates);
    let installed = found.is_some();
    // 没找到时仍回显首选路径，方便用户照着这条线索自己核对目录。
    let shown = found.unwrap_or_else(|| {
        candidates[0]
            .iter()
            .fold(root.to_path_buf(), |acc, segment| acc.join(segment))
    });
    // 目录没有文件版本资源，直接跳过这次 Win32 调用。
    let version = if shown.is_file() {
        file_version(&shown)
    } else {
        None
    };
    FrameworkStatus {
        id: id.to_string(),
        name: name.to_string(),
        installed,
        required,
        path: Some(shown.to_string_lossy().to_string()),
        version,
        note: note.to_string(),
    }
}

pub fn log_paths(root: &Path) -> Vec<String> {
    let candidates = [
        root.join("r6").join("logs"),
        root.join("red4ext").join("logs"),
        root.join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("cyber_engine_tweaks.log"),
        root.join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks"),
    ];
    candidates
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

pub fn steam_exe() -> Option<PathBuf> {
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
        if let Ok(path) = key.get_value::<String, _>("SteamExe") {
            let candidate = PathBuf::from(path.replace('/', "\\"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if let Ok(path) = key.get_value::<String, _>("SteamPath") {
            let candidate = PathBuf::from(path.replace('/', "\\")).join("steam.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for candidate in [
        PathBuf::from(r"C:\Program Files (x86)\Steam\steam.exe"),
        PathBuf::from(r"C:\Program Files\Steam\steam.exe"),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────
// 启动链路：【2】绕过官方启动器直接启动
//
// 设计要点（改这里之前先读）：
// 1. 平台决定「直启前提」：Steam 版有 Steamworks DRM、Epic 版要 Epic 客户端在运行，
//    GOG 版无 DRM。前提不满足时直启必失败，所以要**先判定、再启动**。
// 2. 判定与执行分开：`platform_of` / `plan_launch` 是纯函数（可用假目录跑测试），
//    只有 `inspect_launch` 与 `launch_game` 会碰进程和磁盘。
// 3. 直启失败必须能自愈：先观察 2 秒（进程立刻退出=失败），再按平台回退
//    官方启动器 / Steam -applaunch，并把回退原因带回前端。
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Steam,
    Gog,
    Epic,
    Manual,
}

impl Platform {
    pub fn id(self) -> &'static str {
        match self {
            Platform::Steam => "steam",
            Platform::Gog => "gog",
            Platform::Epic => "epic",
            Platform::Manual => "manual",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Platform::Steam => "Steam",
            Platform::Gog => "GOG",
            Platform::Epic => "Epic",
            Platform::Manual => "手动目录",
        }
    }

    /// 直启前必须在运行的 DRM 客户端。GOG 版无 DRM，手动目录不做假设。
    pub fn drm_client(self) -> Option<&'static str> {
        match self {
            Platform::Steam => Some("steam.exe"),
            Platform::Epic => Some("EpicGamesLauncher.exe"),
            _ => None,
        }
    }

    pub fn from_id(id: &str) -> Platform {
        match id.trim().to_ascii_lowercase().as_str() {
            "steam" => Platform::Steam,
            "gog" => Platform::Gog,
            "epic" => Platform::Epic,
            _ => Platform::Manual,
        }
    }
}

/// 平台判定：先信 `source`（自动探测给的），再按目录特征兜底。
///
/// 为什么必须兜底：已绑定目录在快照里来源固定是 `manual`
/// （`validate_game_dir` 只校验 exe 是否存在），不看路径特征就判断不出 DRM 前提。
pub fn platform_of(root: &Path, source: &str) -> Platform {
    let hint = source.trim().to_ascii_lowercase();
    if hint.starts_with("steam") {
        return Platform::Steam;
    }
    if hint.starts_with("gog") {
        return Platform::Gog;
    }
    if hint.starts_with("epic") {
        return Platform::Epic;
    }

    let lower = root.to_string_lossy().to_ascii_lowercase();
    if lower.contains("steamapps") {
        return Platform::Steam;
    }
    if has_gog_marker(root) {
        return Platform::Gog;
    }
    if root.join(".egstore").is_dir() {
        return Platform::Epic;
    }
    Platform::Manual
}

/// GOG 版在游戏根目录放 `goggame-<id>.info` / `goggame-<id>.ico`。
fn has_gog_marker(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        name.starts_with("goggame-") || name == "goggame.info"
    })
}

/// 进程是否在运行（`tasklist` 过滤，只读、不注入）。
///
/// 取不到结果一律当「没在运行」：宁可多走一次官方启动器，也不要在 DRM 前提
/// 满足时误判为不满足、把能直启的场景挡下来……所以这里的返回值只在
/// 「平台需要客户端」时用于降级判定，失败默认 false 是偏保守的方向。
pub fn process_running(image: &str) -> bool {
    let filter = format!("IMAGENAME eq {image}");
    let Ok(output) = Command::new("tasklist")
        .args(["/FI", filter.as_str(), "/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    stdout.contains(&image.to_ascii_lowercase())
}

/// 结束游戏主进程。
///
/// 先发一次「礼貌关闭」（`taskkill` 不带 `/F`，等价于 WM_CLOSE），等 2 秒还在
/// 就强杀。为什么不一上来就 `/F`：游戏在存档中强杀有概率写坏存档槽，
/// 而玩家点「关闭游戏」的预期就是"正常退出"。
///
/// 返回结果里带 `forced` 标记，前端据此提示"已强制结束"，避免玩家以为
/// 是正常退出却丢了未保存进度。
pub fn stop_game() -> Result<bool, String> {
    if !process_running(GAME_EXE) {
        return Ok(false);
    }
    let gentle = Command::new("taskkill")
        .args(["/IM", GAME_EXE])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if gentle.is_err() {
        return Err("无法调用 taskkill，可能被安全软件拦截。".to_string());
    }
    for _ in 0..20 {
        if !process_running(GAME_EXE) {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let forced = Command::new("taskkill")
        .args(["/F", "/IM", GAME_EXE])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match forced {
        Ok(output) if output.status.success() => Ok(true),
        Ok(output) => Err(format!(
            "强制结束失败：{}",
            String::from_utf8_lossy(&output.stdout).trim()
        )),
        Err(err) => Err(format!("强制结束失败：{err}")),
    }
}

/// 直启可行性快照（`inspect_launch` 命令的返回体，前端设置页展示用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCheck {
    pub platform: String,
    pub platform_label: String,
    pub exe_present: bool,
    pub prelauncher_present: bool,
    /// 需要的 DRM 客户端进程名；GOG / 手动目录为 `None`。
    pub drm_client: Option<String>,
    pub drm_client_running: bool,
    pub steam_available: bool,
    pub can_direct: bool,
    /// 阻断直启的硬条件（空数组 = 可以直启）。
    pub reasons: Vec<String>,
    /// 说明性信息（不阻断）。
    pub notes: Vec<String>,
}

pub fn inspect_launch(game: &GameInfo) -> LaunchCheck {
    let root = Path::new(&game.root);
    let platform = platform_of(root, &game.source);
    let exe_present = Path::new(&game.exe_path).is_file();
    let prelauncher_present = prelauncher_path(root).is_file();
    let steam_available = steam_exe().is_some();
    let client = platform.drm_client();
    let client_running = client.map(process_running).unwrap_or(true);

    let mut reasons = Vec::new();
    let mut notes = Vec::new();

    if !exe_present {
        reasons.push("找不到 bin\\x64\\Cyberpunk2077.exe，无法启动。".to_string());
    }
    if let Some(image) = client {
        if !client_running {
            reasons.push(match platform {
                Platform::Steam => format!(
                    "{image} 没在运行：Steam 版带 Steamworks DRM，直接双击游戏 exe 会被拦或者启动即退出。"
                ),
                Platform::Epic => format!(
                    "{image} 没在运行：Epic 版要求客户端保持登录，直启会失败。"
                ),
                _ => format!("{image} 没在运行。"),
            });
        } else {
            notes.push(format!("{} 已在运行，DRM 前提满足。", platform.label()));
        }
    }
    if prelauncher_present {
        notes.push("检测到 REDprelauncher.exe：直启会绕过它（等价于官方启动器的 --launcher-skip）。".to_string());
    } else if exe_present {
        notes.push("这个目录没有 REDprelauncher.exe（GOG / 自定义安装常见），本来就没有官方启动器可绕。".to_string());
    }
    if platform == Platform::Steam && !steam_available && !client_running {
        reasons.push("既没检测到 Steam 安装，Steam 客户端也没在运行。".to_string());
    }

    LaunchCheck {
        platform: platform.id().to_string(),
        platform_label: platform.label().to_string(),
        exe_present,
        prelauncher_present,
        drm_client: client.map(ToString::to_string),
        drm_client_running: client_running,
        steam_available,
        can_direct: exe_present && client_running,
        reasons,
        notes,
    }
}

/// 最终走哪条启动链。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchRoute {
    /// 直接跑 bin\x64\Cyberpunk2077.exe（跳过官方启动器）。
    Direct,
    /// `steam.exe -applaunch 1091500 --launcher-skip`（绕过启动器 UI，但仍走 Steam）。
    Steam,
    /// 官方 REDprelauncher.exe / 平台入口，交给厂商链路。
    Official,
}

impl LaunchRoute {
    pub fn id(self) -> &'static str {
        match self {
            LaunchRoute::Direct => "direct",
            LaunchRoute::Steam => "steam",
            LaunchRoute::Official => "official",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub route: LaunchRoute,
    pub notes: Vec<String>,
}

/// 启动方式 → 启动链（纯函数，不碰磁盘/进程）。
///
/// `method` 来自设置：`direct` 只允许直启（前提不满足就报错，不偷偷改道），
/// `steam` 强制走 Steam，`auto` 优先直启、Steam 未运行且装了 Steam 时自动改走 Steam。
pub fn plan_launch(check: &LaunchCheck, method: &str) -> AppResult<LaunchPlan> {
    if !check.exe_present {
        return Err(CommandError::new(
            "GAME_EXE_NOT_FOUND",
            "游戏可执行文件不存在，请重新定位游戏目录。",
        ));
    }
    let platform = Platform::from_id(&check.platform);
    match method {
        "steam" => {
            if !check.steam_available {
                return Err(CommandError::new(
                    "STEAM_NOT_FOUND",
                    "没有找到 Steam 安装。请把启动方式改为「自动」或「直接运行」。",
                ));
            }
            Ok(LaunchPlan {
                route: LaunchRoute::Steam,
                notes: check.notes.clone(),
            })
        }
        "direct" => {
            if !check.can_direct {
                return Err(CommandError::new(
                    "LAUNCH_CLIENT_REQUIRED",
                    format!(
                        "{}。可以先启动它，或把启动方式改成「自动」（Steam 版会自动先拉起客户端）。",
                        check
                            .reasons
                            .first()
                            .cloned()
                            .unwrap_or_else(|| "直启前提不满足。".to_string())
                    ),
                ));
            }
            Ok(LaunchPlan {
                route: LaunchRoute::Direct,
                notes: check.notes.clone(),
            })
        }
        _ => {
            if check.can_direct {
                return Ok(LaunchPlan {
                    route: LaunchRoute::Direct,
                    notes: check.notes.clone(),
                });
            }
            // 不满足直启前提：Steam 版能靠 -applaunch 先把客户端拉起来，其他平台只能报错。
            if platform == Platform::Steam && check.steam_available {
                let mut notes = check.notes.clone();
                notes.push("Steam 未运行，已改用 Steam 启动（会先拉起客户端，DRM 校验才过得去）。".to_string());
                return Ok(LaunchPlan {
                    route: LaunchRoute::Steam,
                    notes,
                });
            }
            Err(CommandError::new(
                "LAUNCH_CLIENT_REQUIRED",
                format!(
                    "{} 请先启动客户端再点「开始游戏」。",
                    check
                        .reasons
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "直启前提不满足。".to_string())
                ),
            ))
        }
    }
}

/// 直启失败后的回退顺序（只返回当前环境可用的路由）。
pub fn fallback_routes(check: &LaunchCheck) -> Vec<LaunchRoute> {
    let platform = Platform::from_id(&check.platform);
    let mut routes = Vec::new();
    if platform == Platform::Steam && check.steam_available {
        routes.push(LaunchRoute::Steam);
    }
    if check.prelauncher_present {
        routes.push(LaunchRoute::Official);
    }
    if routes.is_empty() && check.steam_available {
        routes.push(LaunchRoute::Steam);
    }
    routes
}

enum SpawnProbe {
    Running,
    Exited { code: Option<i32> },
}

/// 启动并观察 `DIRECT_PROBE_MS`：进程还在 = 启动成功；提前退出 = 启动失败。
///
/// 注意：`Child` 被 drop 不会杀掉子进程（std 语义），所以这里不会误杀游戏。
fn spawn_and_probe(
    exe: &Path,
    args: &[String],
    cwd: &Path,
    priority_flags: u32,
) -> std::io::Result<SpawnProbe> {
    let mut child = Command::new(exe)
        .args(args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW | priority_flags)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_millis(DIRECT_PROBE_MS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(SpawnProbe::Exited {
                    code: status.code(),
                })
            }
            Ok(None) => {}
            // 句柄查询失败但进程已经起来了：按成功处理，避免误回退成第二次启动。
            Err(_) => return Ok(SpawnProbe::Running),
        }
        if Instant::now() >= deadline {
            return Ok(SpawnProbe::Running);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 解析用户自定义启动参数（#6）。
///
/// 安全边界：Windows `Command` 按参数向量传参、不经 shell，本身没有注入面；
/// 这里再做两层防御——逐字符白名单（字母数字与 `-_=+.,:/\\@%`）+ 长度上限，
/// 双引号只用于分词，不进入最终参数。任何异常直接报错，不做静默修正。
pub fn parse_launch_args(raw: &str) -> AppResult<Vec<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    if trimmed.chars().count() > 256 {
        return Err(CommandError::new(
            "LAUNCH_ARGS_TOO_LONG",
            "启动参数太长（上限 256 字符）。检查一下是不是把整段命令行都粘进来了。",
        ));
    }
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in trimmed.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ' ' | '\t' if !in_quotes => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => {
                if !(c.is_ascii_alphanumeric() || "-_=+.,:/\\@%".contains(c)) {
                    return Err(CommandError::new(
                        "LAUNCH_ARGS_BAD_CHAR",
                        format!("启动参数包含不允许的字符「{c}」。只允许字母、数字和 -_=+.,:/\\@%"),
                    ));
                }
                current.push(c);
            }
        }
    }
    if in_quotes {
        return Err(CommandError::new(
            "LAUNCH_ARGS_UCDLOSED_QUOTE",
            "启动参数里的双引号没有成对闭合。",
        ));
    }
    if !current.is_empty() {
        out.push(current);
    }
    Ok(out)
}

/// 启动游戏（唯一执行入口）。
///
/// 顺序是硬约束：**版本与熔断校验在 `lib.rs` 的 `launch_game` 命令里先做**，
/// 这里只负责「前提判定 → 启动 → 失败回退」，整个过程不在状态锁内执行。
/// 优先级 → creation_flags（deepseek 任务·模块一）。low 用 BELOW_NORMAL 而不是
/// IDLE：IDLE 会在后台负载下让游戏卡成幻灯片，超出「低」的语义。
pub fn priority_creation_flags(priority: &str) -> u32 {
    match priority {
        "high" => 0x0000_0080, // HIGH_PRIORITY_CLASS
        "low" => 0x0000_4000,  // BELOW_NORMAL_PRIORITY_CLASS
        _ => 0x0000_0020,      // NORMAL_PRIORITY_CLASS
    }
}

/// 显卡偏好 → Windows 每应用 GPU 首选项（HKCU\Software\Microsoft\DirectX\
/// UserGpuPreferences）。auto = 删除该键值，交还系统决策。
/// 只写 HKCU，不需要提权；写失败不阻断启动（返回说明文本，调用方并进 notes）。
pub fn apply_gpu_preference(exe_path: &str, pref: &str) -> Option<String> {
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const GPU_PREF_KEY: &str = r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences";
    let value = match pref {
        "dedicated" => "GpuPreference=2;",
        "integrated" => "GpuPreference=1;",
        _ => {
            // auto：删掉既有条目（不存在不算失败）。
            let _ = Command::new("reg")
                .args(["delete", GPU_PREF_KEY, "/v", exe_path, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            return None;
        }
    };
    let output = Command::new("reg")
        .args(["add", GPU_PREF_KEY, "/v", exe_path, "/t", "REG_SZ", "/d", value, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(format!(
            "显卡偏好写入注册表失败（退出码 {:?}），本次按系统默认调度。",
            out.status.code()
        )),
        Err(err) => Some(format!("显卡偏好写入注册表失败：{err}，本次按系统默认调度。")),
    }
}

/// 启动前置命令（deepseek 任务·模块一）：启动前跑一次用户命令行。
/// 经 cmd /C 执行；失败返回 Err 中止启动——前置命令多半在准备环境
/// （挂载/解锁/改配置），它失败了继续启动只会把玩家丢进坏状态。
fn run_pre_command(command: &str) -> AppResult<()> {
    let output = std::process::Command::new("cmd")
        .args(["/C", command])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|err| {
            CommandError::new("PRE_COMMAND_FAILED", format!("无法执行启动前置命令：{err}"))
        })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        stdout.trim().to_string()
    };
    Err(CommandError::new(
        "PRE_COMMAND_FAILED",
        format!(
            "启动前置命令失败（退出码 {:?}）：{}",
            output.status.code(),
            if detail.is_empty() { "无输出".to_string() } else { detail }
        ),
    ))
}

pub fn launch_game(
    game: &GameInfo,
    method: &str,
    redmod_enabled: bool,
    custom_args: &[String],
    priority: &str,
    gpu_pref: &str,
    pre_command: &str,
) -> AppResult<LaunchResult> {
    // 前置命令最先跑：它失败就没有「然后」了。
    if !pre_command.trim().is_empty() {
        run_pre_command(pre_command)?;
    }
    // 显卡偏好写在启动前：注册表按 exe 路径匹配，本次启动即生效。
    let gpu_note = apply_gpu_preference(&game.exe_path, gpu_pref);
    let check = inspect_launch(game);
    let mut plan = plan_launch(&check, method)?;
    // 显卡偏好写失败不阻断启动，把说明并进 notes 随结果展示。
    if let Some(note) = gpu_note {
        plan.notes.push(note);
    }
    let root = PathBuf::from(&game.root);
    let suffix = custom_suffix(custom_args);

    // 已在运行就别再开一个：CP2077 第二个实例会立刻退出，看起来像「启动失败」。
    if process_running(GAME_EXE) {
        return Ok(LaunchResult {
            method: "already-running".to_string(),
            detail: "游戏已经在运行，本次没有重复启动。".to_string(),
            platform: check.platform.clone(),
            fallback_from: None,
            notes: plan.notes.clone(),
        });
    }

    match plan.route {
        LaunchRoute::Direct => {
            let mut args: Vec<String> = Vec::new();
            if redmod_enabled {
                args.push("-modded".to_string());
            }
            args.extend(custom_args.iter().cloned());
            let exe = PathBuf::from(&game.exe_path);
            match spawn_and_probe(&exe, &args, &root, priority_creation_flags(priority)) {
                Ok(SpawnProbe::Running) => Ok(LaunchResult {
                    method: LaunchRoute::Direct.id().to_string(),
                    detail: format!(
                        "已直接启动 {GAME_EXE}{}，跳过 REDprelauncher{suffix}",
                        if redmod_enabled { "（-modded）" } else { "" }
                    ),
                    platform: check.platform.clone(),
                    fallback_from: None,
                    notes: plan.notes.clone(),
                }),
                Ok(SpawnProbe::Exited { code }) => {
                    let reason = match code {
                        Some(code) => format!("直启后进程立刻退出（退出码 {code}）"),
                        None => "直启后进程立刻退出".to_string(),
                    };
                    fallback_launch(
                        game,
                        &check,
                        redmod_enabled,
                        custom_args,
                        &reason,
                        &plan.notes,
                    )
                }
                Err(err) => {
                    let reason = format!("直启进程创建失败：{err}");
                    fallback_launch(
                        game,
                        &check,
                        redmod_enabled,
                        custom_args,
                        &reason,
                        &plan.notes,
                    )
                }
            }
        }
        LaunchRoute::Steam => {
            launch_via_steam(redmod_enabled, custom_args)?;
            Ok(LaunchResult {
                method: LaunchRoute::Steam.id().to_string(),
                detail: format!(
                    "已请求 Steam 启动 AppID {STEAM_APP_ID}（--launcher-skip 跳过官方启动器）{suffix}"
                ),
                platform: check.platform.clone(),
                fallback_from: None,
                notes: plan.notes.clone(),
            })
        }
        // plan_launch 不会主动返回 Official，这条分支只是为了让「只走官方链路」可显式表达。
        LaunchRoute::Official => {
            launch_official(game, redmod_enabled, custom_args)?;
            Ok(LaunchResult {
                method: LaunchRoute::Official.id().to_string(),
                detail: format!("已交给官方启动器 REDprelauncher.exe{suffix}"),
                platform: check.platform.clone(),
                fallback_from: None,
                notes: plan.notes.clone(),
            })
        }
    }
}

fn custom_suffix(custom_args: &[String]) -> String {
    if custom_args.is_empty() {
        String::new()
    } else {
        format!(" · 自定义参数 {} 个", custom_args.len())
    }
}

fn launch_via_steam(redmod_enabled: bool, custom_args: &[String]) -> AppResult<()> {
    let steam = steam_exe().ok_or_else(|| {
        CommandError::new(
            "STEAM_NOT_FOUND",
            "没有找到 Steam 安装。请把启动方式改为「自动」或「直接运行」。",
        )
    })?;
    // `steam.exe -applaunch` 比协议 URL 可靠：附加参数（-modded / --launcher-skip）
    // 会透传给游戏的启动命令，不需要处理 shell 引号。
    let mut args = vec!["-applaunch".to_string(), STEAM_APP_ID.to_string()];
    if redmod_enabled {
        args.push("-modded".to_string());
    }
    args.push("--launcher-skip".to_string());
    args.extend(custom_args.iter().cloned());
    Command::new(steam)
        .args(&args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            CommandError::new(
                "STEAM_LAUNCH_FAILED",
                format!("Steam 启动请求失败：{e}。请确认 Steam 已安装并已登录。"),
            )
        })?;
    Ok(())
}

fn launch_official(
    game: &GameInfo,
    redmod_enabled: bool,
    custom_args: &[String],
) -> AppResult<()> {
    let root = Path::new(&game.root);
    let prelauncher = prelauncher_path(root);
    if !prelauncher.is_file() {
        return Err(CommandError::new(
            "PRELAUNCHER_MISSING",
            format!("这个目录没有官方启动器：{}", prelauncher.display()),
        ));
    }
    let mut args: Vec<String> = Vec::new();
    if redmod_enabled {
        args.push("-modded".to_string());
    }
    args.extend(custom_args.iter().cloned());
    Command::new(&prelauncher)
        .args(&args)
        .current_dir(root)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            CommandError::new("OFFICIAL_LAUNCH_FAILED", format!("官方启动器启动失败：{e}"))
        })?;
    Ok(())
}

/// 直启失败后的自愈：按 `fallback_routes` 顺序逐个试，成功就带着原因返回。
fn fallback_launch(
    game: &GameInfo,
    check: &LaunchCheck,
    redmod_enabled: bool,
    custom_args: &[String],
    reason: &str,
    notes: &[String],
) -> AppResult<LaunchResult> {
    let routes = fallback_routes(check);
    if routes.is_empty() {
        return Err(CommandError::new(
            "GAME_LAUNCH_FAILED",
            format!(
                "{reason}，而且这个目录既没有 REDprelauncher.exe 也没有 Steam 入口，自动回退失败。请从平台客户端手动启动游戏。"
            ),
        ));
    }
    let suffix = custom_suffix(custom_args);
    let mut failures: Vec<String> = vec![reason.to_string()];
    for route in routes {
        match route {
            LaunchRoute::Steam => match launch_via_steam(redmod_enabled, custom_args) {
                Ok(()) => {
                    return Ok(LaunchResult {
                        method: LaunchRoute::Steam.id().to_string(),
                        detail: format!(
                            "{reason}，已自动回退 Steam 启动 AppID {STEAM_APP_ID}{suffix}"
                        ),
                        platform: check.platform.clone(),
                        fallback_from: Some(LaunchRoute::Direct.id().to_string()),
                        notes: notes.to_vec(),
                    })
                }
                Err(err) => failures.push(err.message),
            },
            LaunchRoute::Official => match launch_official(game, redmod_enabled, custom_args) {
                Ok(()) => {
                    return Ok(LaunchResult {
                        method: LaunchRoute::Official.id().to_string(),
                        detail: format!(
                            "{reason}，已自动回退官方启动器 REDprelauncher.exe{suffix}"
                        ),
                        platform: check.platform.clone(),
                        fallback_from: Some(LaunchRoute::Direct.id().to_string()),
                        notes: notes.to_vec(),
                    })
                }
                Err(err) => failures.push(err.message),
            },
            LaunchRoute::Direct => {}
        }
    }
    Err(CommandError::new(
        "GAME_LAUNCH_FAILED",
        format!(
            "{}。所有启动方式都失败了，请从平台客户端手动启动游戏。",
            failures.join("；")
        ),
    ))
}

pub fn volume_serial(path: &Path) -> Option<u32> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetVolumeInformationW, GetVolumePathNameW,
    };

    let mut probe = path.to_path_buf();
    while !probe.exists() {
        if !probe.pop() {
            return None;
        }
    }
    let wide: Vec<u16> = probe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut volume = vec![0u16; 260];
    unsafe {
        if GetVolumePathNameW(wide.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) == 0 {
            return None;
        }
        let mut serial = 0u32;
        let mut max_len = 0u32;
        let mut flags = 0u32;
        let mut fs_name = vec![0u16; 16];
        if GetVolumeInformationW(
            volume.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            &mut max_len,
            &mut flags,
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        ) == 0
        {
            return None;
        }
        Some(serial)
    }
}

pub fn same_volume(a: &Path, b: &Path) -> bool {
    match (volume_serial(a), volume_serial(b)) {
        (Some(left), Some(right)) => left == right,
        _ => {
            let left = a.components().next();
            let right = b.components().next();
            left.is_some() && left == right
        }
    }
}

#[cfg(test)]
mod framework_tests {
    use super::*;

    /// 每个用例独立临时目录，避免并行测试互相看见对方的文件。
    fn fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cdl-fw-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"x").unwrap();
    }

    fn installed(root: &Path, id: &str) -> bool {
        framework_statuses(root)
            .into_iter()
            .find(|item| item.id == id)
            .unwrap_or_else(|| panic!("缺少框架条目 {id}"))
            .installed
    }

    /// 2026-10-30 反馈：玩家只解压了 .reds 标准库、没有 redscript-cli.exe，
    /// 旧判据只看 CLI，结果一直显示 MISSING。
    #[test]
    fn redscript_detected_by_r6_scripts_dir() {
        let root = fixture("redscript-scripts");
        fs::create_dir_all(root.join("r6").join("scripts").join("redscript")).unwrap();
        assert!(installed(&root, "redscript"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn redscript_detected_by_cli() {
        let root = fixture("redscript-cli");
        touch(&root.join("engine").join("tools").join("redscript-cli.exe"));
        assert!(installed(&root, "redscript"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn redscript_absent_on_empty_root() {
        let root = fixture("redscript-empty");
        assert!(!installed(&root, "redscript"));
        let _ = fs::remove_dir_all(root);
    }

    /// 2026-10-30 实测反馈：CET 明明在 bin/x64/plugins/cyber_engine_tweaks/ 下，
    /// 界面却一直 MISSING。旧判据只认目录里的 dll，dll 被改名或读不到就全盘判死。
    #[test]
    fn cet_detected_by_plugin_dir() {
        let root = fixture("cet-dir");
        fs::create_dir_all(
            root.join("bin")
                .join("x64")
                .join("plugins")
                .join("cyber_engine_tweaks"),
        )
        .unwrap();
        assert!(installed(&root, "cet"), "插件目录存在即视为已安装");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cet_detected_by_init_lua() {
        let root = fixture("cet-init-lua");
        touch(
            &root
                .join("bin")
                .join("x64")
                .join("plugins")
                .join("cyber_engine_tweaks")
                .join("init.lua"),
        );
        assert!(installed(&root, "cet"));
        let _ = fs::remove_dir_all(&root);
    }

    /// 大小写混写的真实安装（`CyberEngineTweaks`）也要认。
    #[test]
    fn cet_detected_case_insensitively() {
        let root = fixture("cet-case");
        fs::create_dir_all(
            root.join("bin")
                .join("x64")
                .join("plugins")
                .join("CyberEngineTweaks"),
        )
        .unwrap();
        assert!(installed(&root, "cet"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cet_absent_on_empty_root() {
        let root = fixture("cet-empty");
        assert!(!installed(&root, "cet"));
        let _ = fs::remove_dir_all(&root);
    }

    /// 新版 Mod Settings 走 RED4ext，路径是 red4ext/plugins/mod_settings/ModSettings.dll，
    /// 旧判据只查 CET 的 mods/ModSettings 目录，同样会漏。
    #[test]
    fn modsettings_detected_by_red4ext_dll() {
        let root = fixture("modsettings-red4ext");
        touch(
            &root
                .join("red4ext")
                .join("plugins")
                .join("mod_settings")
                .join("ModSettings.dll"),
        );
        assert!(installed(&root, "modsettings"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn modsettings_detected_by_cet_init_lua() {
        let root = fixture("modsettings-cet");
        touch(
            &root
                .join("bin")
                .join("x64")
                .join("plugins")
                .join("cyber_engine_tweaks")
                .join("mods")
                .join("ModSettings")
                .join("init.lua"),
        );
        assert!(installed(&root, "modsettings"));
        let _ = fs::remove_dir_all(root);
    }

    /// 从别人的压缩包解出来的目录常带大小写变体，探测必须认。
    #[test]
    fn detection_ignores_segment_case() {
        let root = fixture("case");
        touch(
            &root
                .join("RED4EXT")
                .join("Plugins")
                .join("MOD_SETTINGS")
                .join("modsettings.DLL"),
        );
        touch(&root.join("R6").join("Scripts").join("bootstrap.reds"));
        assert!(installed(&root, "modsettings"), "大写目录名应被识别");
        assert!(installed(&root, "redscript"), "大写 R6/Scripts 应被识别");
        let _ = fs::remove_dir_all(root);
    }

    /// 没装时也要回显首选路径（用户照着核对的线索），不能给空字符串。
    #[test]
    fn missing_framework_still_reports_primary_path() {
        let root = fixture("missing-path");
        let list = framework_statuses(&root);
        let redscript = list.iter().find(|item| item.id == "redscript").unwrap();
        assert!(!redscript.installed);
        let shown = redscript.path.clone().unwrap_or_default();
        // 首选路径跟着官方口径走：新版 redscript 的编译器是 engine\tools\scc.exe。
        // 旧名 redscript-cli.exe 只在「已装老版本」时才会被探测命中。
        assert!(
            shown.to_lowercase().contains("scc.exe"),
            "未装时应回显首选路径，实际: {shown}"
        );
        let _ = fs::remove_dir_all(root);
    }
}
