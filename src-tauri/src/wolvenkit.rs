//! WolvenKit CLI 资源级深度扫描。
//!
//! 冲突中心目前只做文件级比对（两个 Mod 部署了同名 `.archive`）。两个同名
//! archive 内部资源是否真的打架，要靠 WolvenKit.Cli 解包后比对内部资源路径
//! （`base\characters\judy.mesh` 这类）。
//!
//! 实现要点：
//! - WolvenKit CLI 没有「只列清单」的命令，取内部资源清单的唯一办法是
//!   `unbundle` 解包到临时目录，再遍历目录树拿相对路径（官方 wiki 确认）。
//! - 解包大 archive 可能非常慢：每个 archive 限时 [`CLI_TIMEOUT_SECS`] 秒，
//!   超时直接 kill 子进程并删除临时目录，返回 `WOLVENKIT_TIMEOUT`。
//!   命令用 `kill_on_drop(true)`：超时分支 drop 掉 future 时子进程一并被杀，
//!   不会留下孤儿 WolvenKit 进程继续吃磁盘。
//! - 全程 `tokio::process` 异步执行，绝不阻塞 Tauri 主线程；CLI 路径与
//!   archive 路径都不受信任，所有失败都走 `Result::Err`，没有 unwrap。
//! - 深度扫描是用户主动点击的偶发操作，逐个 archive 串行扫描即可，
//!   并发解包几个 GB 的 archive 只会互相争 IO。

use crate::schema::{CommandError, Settings};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

/// 单个 archive 的默认解包超时（秒）。
///
/// schema.rs 的 `default_wolvenkit_timeout_secs` 与这里保持一致：60 秒是
/// 「交互可等待」的上限，mod 的 .archive（几百 MB）磁盘正常时远快于这个值。
/// 用户可以在设置里调（10–600 秒）；真正的原版几 GB 大 archive 仍可能超时，
/// 那是设计内的取舍：报 WOLVENKIT_TIMEOUT，文件级冲突结论仍然有效。
pub const DEFAULT_TIMEOUT_SECS: u64 = 60;

/// 设置里允许的超时范围（秒）。太短必然全部超时，太长等于把「卡死」合法化。
pub const MIN_TIMEOUT_SECS: u64 = 10;
pub const MAX_TIMEOUT_SECS: u64 = 600;

/// 把设置里的超时钳制到合法范围。
pub fn clamp_timeout_secs(value: u64) -> u64 {
    value.clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS)
}

/// 每个 archive 最多返回多少条内部资源路径。
///
/// 解包目录树可能有几万条目，全量塞给前端只会把 IPC 和 UI 拖垮；冲突比
/// 对关心的是「交集」，截断到前 N 条（按字母序）足够定位典型冲突。
const MAX_RESOURCES_PER_ARCHIVE: usize = 5000;

/// 遍历解包目录时关注的资源扩展名。
///
/// WolvenKit 会把所有资源原样解出来，其中大部分（.wem 音频、.csv 表）对
/// 冲突判断意义不大。只保留这几类能让结果列表短一截；扩展名不在此列的
/// 资源也会被计入总数，只是不进入返回清单。
const TRACKED_EXTENSIONS: &[&str] = &[
    "mesh", "xbm", "mlmask", "ent", "app", "anim", "anims", "rig", "morph", "facial",
    "inkatlas", "inkfontdictionary", "json", "journalresource", "tweak", "location",
    "community", "spot", "questsphase", "scenerid", "scenedialogline", "cminimap",
];

fn err(code: &str, message: impl Into<String>) -> CommandError {
    CommandError::new(code, message)
}

/// 单个 archive 的扫描结果。`error` 为 None 表示扫描成功。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDeepScan {
    pub archive: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ScanError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<Vec<String>>,
    /// true 表示资源数超过 [`MAX_RESOURCES_PER_ARCHIVE`]，列表被截断。
    pub truncated: bool,
    /// 解包目录里的资源总数（截断前），用于 UI 提示「共 N 项，仅显示前 M 项」。
    pub total_resources: usize,
}

/// 结构化的扫描错误：code 供前端做针对性文案，message 直接可展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub code: String,
    pub message: String,
}

impl ScanError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// 整批扫描报告。逐 archive 独立成败，部分失败不影响其余结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepScanReport {
    pub results: Vec<ArchiveDeepScan>,
}

/// 从设置里取出可用的 CLI 路径。
///
/// 返回 None 表示用户没配置或路径不存在；两种情况文案不同，由调用方区分。
pub fn resolve_cli_path(settings: &Settings) -> Result<PathBuf, CommandError> {
    let trimmed = settings.wolvenkit_cli_path.trim();
    if trimmed.is_empty() {
        // 留空 = 自动检测：dotnet 全局工具的固定安装位置 + PATH。
        // 检测只是「找文件」，失败立即返回，不会像跑错 CLI 那样白等一个超时周期。
        if let Some(path) = detect_cli() {
            return Ok(path);
        }
        return Err(err(
            "WOLVENKIT_NOT_CONFIGURED",
            "未找到 WolvenKit CLI（已尝试 %USERPROFILE%\\.dotnet\\tools 与 PATH）。\
             可用 `dotnet tool install -g wolvenkit.cli` 安装，或在设置中手动指定路径。",
        ));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_file() {
        return Err(err(
            "WOLVENKIT_CLI_MISSING",
            format!("WolvenKit CLI 路径不存在或不是文件：{trimmed}"),
        ));
    }
    Ok(path)
}

/// 自动检测 WolvenKit.Cli.exe（设置留空时兜底）。
///
/// `dotnet tool install -g` 的固定落点是 `%USERPROFILE%\.dotnet\tools\` 且该目录
/// 会被加进 PATH，所以两步基本覆盖全部安装方式；都找不到就返回 None（不猜测
/// 其他盘符——找错文件的代价是一个完整的解包超时）。
pub(crate) fn detect_cli() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let path = PathBuf::from(home)
            .join(".dotnet")
            .join("tools")
            .join("WolvenKit.Cli.exe");
        if path.is_file() {
            return Some(path);
        }
    }
    crate::installer::which("WolvenKit.Cli.exe").ok()
}

/// 校验设置里的 WolvenKit CLI 路径（set_settings 落盘前调用）。
///
/// 空值合法（= 关闭深度扫描）；非空时必须是已存在的文件，与
/// `archive_tool_path` 的校验口径一致。
pub fn validate_cli_setting(value: &str) -> Result<(), CommandError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if !Path::new(trimmed).is_file() {
        return Err(err(
            "INVALID_SETTING",
            "指定的 WolvenKit.Cli.exe 路径不存在。",
        ));
    }
    Ok(())
}

/// 把一个文件路径归一化为引擎资源路径（正斜杠、小写盘外细节保留原样）。
fn relative_resource_path(root: &Path, file: &Path) -> Option<String> {
    let relative = file.strip_prefix(root).ok()?;
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        return None;
    }
    Some(text)
}

fn is_tracked(file: &Path) -> bool {
    file.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            TRACKED_EXTENSIONS.iter().any(|item| *item == ext)
        })
        .unwrap_or(false)
}

/// 遍历解包目录，收集排序后的资源清单。
///
/// 只收文件、只收 [`TRACKED_EXTENSIONS`] 内的扩展名；超过
/// [`MAX_RESOURCES_PER_ARCHIVE`] 截断并置 `truncated`。
fn collect_resources(out_dir: &Path) -> (Vec<String>, usize, bool) {
    let mut all: Vec<String> = Vec::new();
    for entry in WalkDir::new(out_dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        if !is_tracked(entry.path()) {
            continue;
        }
        if let Some(text) = relative_resource_path(out_dir, entry.path()) {
            all.push(text);
        }
    }
    all.sort();
    let total = all.len();
    let truncated = total > MAX_RESOURCES_PER_ARCHIVE;
    if truncated {
        all.truncate(MAX_RESOURCES_PER_ARCHIVE);
    }
    (all, total, truncated)
}

/// 扫描单个 archive；任何失败都以 `ArchiveDeepScan.error` 返回，不 panic。
///
/// 临时目录放在系统 temp 下并带 uuid，扫描完立即删除；即使中途出错，
/// `cleanup` 也会尽力清掉残留。
pub async fn scan_one_archive(cli: &Path, archive: &Path, timeout: Duration) -> ArchiveDeepScan {
    let archive_text = archive.to_string_lossy().to_string();
    let archive_display = archive_text.clone();

    if !archive.is_file() {
        return ArchiveDeepScan {
            archive: archive_display,
            error: Some(ScanError::new(
                "ARCHIVE_NOT_FOUND",
                format!("archive 文件不存在：{archive_text}"),
            )),
            resources: None,
            truncated: false,
            total_resources: 0,
        };
    }

    let out_dir = std::env::temp_dir()
        .join(format!("cyberdeck-wolvenkit-{}", uuid::Uuid::new_v4().simple()));
    let result = unbundle_and_collect(cli, archive, &out_dir, timeout).await;

    // 临时目录无论成败都删掉。删除失败不掩盖主结果：残留目录会在系统
    // temp 里被定期清理，总比报错盖住真正的扫描结果好。
    let _ = std::fs::remove_dir_all(&out_dir);

    match result {
        Ok((resources, total, truncated)) => ArchiveDeepScan {
            archive: archive_display,
            error: None,
            resources: Some(resources),
            truncated,
            total_resources: total,
        },
        Err(scan_error) => ArchiveDeepScan {
            archive: archive_display,
            error: Some(scan_error),
            resources: None,
            truncated: false,
            total_resources: 0,
        },
    }
}

/// 批量串行扫描。入口由 Tauri 命令调用；超时以设置为准（已钳制）。
pub async fn scan_archives(cli: &Path, archive_paths: &[String], timeout: Duration) -> DeepScanReport {
    let mut results = Vec::with_capacity(archive_paths.len());
    for path in archive_paths {
        results.push(scan_one_archive(cli, Path::new(path), timeout).await);
    }
    DeepScanReport { results }
}

async fn unbundle_and_collect(
    cli: &Path,
    archive: &Path,
    out_dir: &Path,
    timeout: Duration,
) -> Result<(Vec<String>, usize, bool), ScanError> {
    std::fs::create_dir_all(out_dir).map_err(|e| {
        ScanError::new(
            "WOLVENKIT_TMP",
            format!("无法创建临时解包目录 {}：{e}", out_dir.display()),
        )
    })?;

    run_unbundle(cli, archive, out_dir, timeout).await?;

    let (resources, total, truncated) = collect_resources(out_dir);
    if total == 0 {
        return Err(ScanError::new(
            "WOLVENKIT_EMPTY",
            "WolvenKit 解包完成，但没有发现可跟踪的资源（.mesh / .xbm 等）。这个 archive 可能是空的或已损坏。",
        ));
    }
    Ok((resources, total, truncated))
}

/// 调用 `WolvenKit.Cli unbundle -p <archive> -o <dir>`。
async fn run_unbundle(
    cli: &Path,
    archive: &Path,
    out_dir: &Path,
    timeout: Duration,
) -> Result<(), ScanError> {
    let args = [
        "unbundle".to_string(),
        "-p".to_string(),
        archive.to_string_lossy().to_string(),
        "-o".to_string(),
        out_dir.to_string_lossy().to_string(),
    ];
    let outcome = run_process(cli, &args, timeout).await?;
    if outcome.timed_out {
        return Err(ScanError::new(
            "WOLVENKIT_TIMEOUT",
            format!(
                "WolvenKit 扫描超时（超过 {} 秒），已中断。可在设置中调大「深度扫描超时」；文件级冲突结论仍然有效。",
                timeout.as_secs()
            ),
        ));
    }
    if !outcome.success {
        let stderr_tail: String = outcome.stderr.chars().rev().take(600).collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(ScanError::new(
            "WOLVENKIT_CLI_ERROR",
            format!(
                "WolvenKit CLI 退出码 {}，解包失败。\n{}",
                outcome.code.unwrap_or(-1),
                stderr_tail.trim()
            ),
        ));
    }
    Ok(())
}

/// `run_unbundle` 的可测内核：跑一个外部进程，限时，返回成败与输出。
struct ProcessOutcome {
    success: bool,
    code: Option<i32>,
    timed_out: bool,
    stderr: String,
}

async fn run_process(
    program: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<ProcessOutcome, ScanError> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // 超时分支 drop 掉持有 Child 的 future 时顺带 kill 子进程。
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // 不弹出黑色控制台窗口（CREATE_NO_WINDOW）。
        command.creation_flags(0x0800_0000);
    }

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ScanError::new(
                "WOLVENKIT_CLI_MISSING",
                format!("无法启动 WolvenKit CLI（找不到可执行文件）：{}", program.display()),
            )
        } else {
            ScanError::new(
                "WOLVENKIT_SPAWN",
                format!("无法启动 WolvenKit CLI：{e}"),
            )
        }
    })?;

    let mut stderr_pipe = child.stderr.take().ok_or_else(|| {
        ScanError::new("WOLVENKIT_SPAWN", "无法读取 WolvenKit CLI 的错误输出。")
    })?;

    let wait = async {
        let status = child.wait().await.ok()?;
        let mut stderr = String::new();
        use tokio::io::AsyncReadExt as _;
        stderr_pipe.read_to_string(&mut stderr).await.ok()?;
        Some((status.success(), status.code(), stderr))
    };

    match tokio::time::timeout(timeout, wait).await {
        Ok(Some((success, code, stderr))) => Ok(ProcessOutcome {
            success,
            code,
            timed_out: false,
            stderr,
        }),
        Ok(None) => Err(ScanError::new(
            "WOLVENKIT_SPAWN",
            "WolvenKit CLI 进程意外终止，无法获取退出状态。",
        )),
        Err(_) => {
            // 超时：child 已随 future drop 被 kill_on_drop 杀掉。
            Ok(ProcessOutcome {
                success: false,
                code: None,
                timed_out: true,
                stderr: String::new(),
            })
        }
    }
}

/// 把一条「冲突引用（模组 + 目标相对路径）」解析成真实存在的 archive 文件。
///
/// 优先找暂存区副本（`staging_root/<staging_path>/<target>`）：无论模组是否
/// 已部署，暂存文件都保留着，且一定是普通文件而不是硬链接；找不到时回退到
/// 游戏目录里的部署目标。所有拼接都过 `safe_join`（安全不变量 #2），
/// 解析不出就返回 None，由调用方决定如何提示。
pub fn resolve_archive_ref(
    staging_root: &Path,
    game_root: Option<&Path>,
    staging_path: &str,
    target: &str,
) -> Option<PathBuf> {
    let staging_trimmed = staging_path.trim();
    if !staging_trimmed.is_empty() {
        let base = staging_root.join(staging_trimmed);
        if let Ok(candidate) = crate::store::safe_join(&base, target) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(root) = game_root {
        if let Ok(candidate) = crate::store::safe_join(root, target) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("wolvenkit-{tag}-{}", uuid::Uuid::new_v4().simple()))
    }

    #[tokio::test]
    async fn missing_cli_path_is_a_configured_error() {
        let mut settings = Settings::default();
        // 留空 = 自动检测：机器上装了 CLI 就拿到真实路径，没装就报 NOT_CONFIGURED。
        // 断言与 detect_cli() 的结果保持一致，两种机器都能过。
        settings.wolvenkit_cli_path = String::new();
        match (detect_cli(), resolve_cli_path(&settings)) {
            (Some(path), Ok(resolved)) => assert_eq!(path, resolved),
            (None, Err(error)) => assert_eq!(error.code, "WOLVENKIT_NOT_CONFIGURED"),
            _ => panic!("自动检测结果与 resolve_cli_path 行为不一致"),
        }

        settings.wolvenkit_cli_path = "Z:/definitely/not/here/WolvenKit.Cli.exe".to_string();
        let error = resolve_cli_path(&settings).unwrap_err();
        assert_eq!(error.code, "WOLVENKIT_CLI_MISSING");
    }

    #[test]
    fn cli_setting_validation_matches_archive_tool_semantics() {
        assert!(validate_cli_setting("").is_ok());
        assert!(validate_cli_setting("   ").is_ok());
        assert!(validate_cli_setting("Z:/nope/WolvenKit.Cli.exe").is_err());
        // 指向本文件这种真实存在的文件应该通过（不要求真的是 exe，
        // set_settings 只负责把「路径不存在」拦下来）。
        assert!(validate_cli_setting(env!("CARGO_MANIFEST_DIR")).is_err());
        assert!(validate_cli_setting(
            concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")
        )
        .is_ok());
    }

    #[tokio::test]
    async fn timeout_kills_the_process_and_reports_wolvenkit_timeout() {
        // 用 ping 模拟一个跑不完的 CLI；500ms 超时后必须立刻返回超时错误，
        // 而不是等 ping 跑完（Windows ping -n 30 要 ~29 秒）。
        let started = std::time::Instant::now();
        let outcome = run_process(
            Path::new("cmd"),
            &["/C".to_string(), "ping".to_string(), "-n".to_string(), "30".to_string(), "127.0.0.1".to_string()],
            Duration::from_millis(500),
        )
        .await
        .expect("超时分支应返回 outcome 而不是错误");
        assert!(outcome.timed_out);
        assert!(!outcome.success);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn nonzero_exit_is_a_cli_error_with_stderr_tail() {
        let outcome = run_process(
            Path::new("cmd"),
            &["/C".to_string(), "echo boom >&2 && exit 3".to_string()],
            Duration::from_secs(15),
        )
        .await
        .expect("进程应能启动");
        assert!(!outcome.timed_out);
        assert!(!outcome.success);
        assert_eq!(outcome.code, Some(3));
        assert!(outcome.stderr.contains("boom"));
    }

    #[test]
    fn resources_are_collected_relative_sorted_and_tracked() {
        let root = tmp_dir("collect");
        let base = root.join("base").join("characters");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(root.join("base").join("sound")).unwrap();
        std::fs::write(base.join("judy.mesh"), b"x").unwrap();
        std::fs::write(base.join("judy_cyberware.xbm"), b"x").unwrap();
        // 不在跟踪名单里的扩展名要被过滤掉。
        std::fs::write(base.join("readme.txt"), b"x").unwrap();
        std::fs::write(root.join("base").join("sound").join("tone.wem"), b"x").unwrap();
        // 空子目录不产生条目。

        let (resources, total, truncated) = collect_resources(&root);
        assert_eq!(total, 2);
        assert!(!truncated);
        assert_eq!(
            resources,
            vec![
                "base/characters/judy.mesh".to_string(),
                "base/characters/judy_cyberware.xbm".to_string(),
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn missing_archive_file_is_reported_not_panicked() {
        let mut settings = Settings::default();
        // 指向一个真实存在的文件当「CLI」——它不会真的被调用，
        // 因为 archive 缺失在启动 CLI 之前就被拦下。
        settings.wolvenkit_cli_path = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml").to_string();
        let cli = resolve_cli_path(&settings).unwrap();

        let missing = Path::new("Z:/nope/mod.archive");
        let scan = scan_one_archive(&cli, missing, Duration::from_secs(60)).await;
        let error = scan.error.expect("缺失的 archive 应报错");
        assert_eq!(error.code, "ARCHIVE_NOT_FOUND");
        assert!(scan.resources.is_none());
    }

    #[test]
    fn timeout_setting_is_clamped_to_a_sane_range() {
        assert_eq!(clamp_timeout_secs(0), MIN_TIMEOUT_SECS);
        assert_eq!(clamp_timeout_secs(60), 60);
        assert_eq!(clamp_timeout_secs(999_999), MAX_TIMEOUT_SECS);
    }

    #[test]
    fn archive_refs_resolve_through_staging_first_then_game_dir() {
        use crate::store::safe_join;
        let root = tmp_dir("resolve");
        let staging_mod = root.join("staging").join("mods").join("m1");
        let game = root.join("game");
        std::fs::create_dir_all(staging_mod.join("archive/pc/mod")).unwrap();
        std::fs::create_dir_all(game.join("archive/pc/mod")).unwrap();
        std::fs::write(staging_mod.join("archive/pc/mod/a.archive"), b"x").unwrap();
        std::fs::write(game.join("archive/pc/mod/b.archive"), b"x").unwrap();

        // 暂存副本优先（哪怕游戏目录里也有）。
        let hit = resolve_archive_ref(
            &root.join("staging"),
            Some(&game),
            "mods/m1",
            "archive/pc/mod/a.archive",
        )
        .expect("暂存副本应命中");
        assert!(hit.starts_with(&staging_mod));

        // 暂存没有 → 回退游戏目录（未受管文件场景）。
        let hit = resolve_archive_ref(
            &root.join("staging"),
            Some(&game),
            "mods/m-none",
            "archive/pc/mod/b.archive",
        )
        .expect("游戏目录文件应命中");
        assert!(hit.starts_with(&game));

        // 两边都没有 → None，不 panic。
        assert!(resolve_archive_ref(
            &root.join("staging"),
            Some(&game),
            "mods/m1",
            "archive/pc/mod/ghost.archive"
        )
        .is_none());

        // 路径穿越必须被 safe_join 拦下（安全不变量 #2）。
        assert!(resolve_archive_ref(
            &root.join("staging"),
            None,
            "mods/m1",
            "../../secrets/ai-api.key"
        )
        .is_none());

        let _ = std::fs::remove_dir_all(&root);
    }
}
