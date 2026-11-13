//! `nxm://` 协议接管。
//!
//! Nexus 的「Mod manager download」按钮会打开 `nxm://cyberpunk2077/mods/<id>/files/<id>?...`。
//! 这个 scheme 在 Windows 上就是 `HKCU\Software\Classes\nxm` 一个键，谁后写谁接管——
//! 拦不到 Vortex 的进程，抢的就是这个处理器。
//!
//! 三条不能破的边界：
//! 1. **只写 HKCU**：不需要提权，卸载/交还时也只动自己的键，不碰别人的机器范围。
//! 2. **先备份再接管**：别人的处理器（通常是 Vortex）原样存进 `nxm-handler.json`，
//!    「交还」时精确写回；没有备份就只删自己创建的那棵子树。
//! 3. **不认识的游戏一律拒绝**：本启动器只管 cyberpunk2077，别的 domain 明确报错，
//!    不能把链接悄悄丢掉让用户以为下载成功了。
use crate::schema::{AppResult, CommandError, NxmLink, NxmStatus};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

/// 处理器注册表位置（当前用户）。
pub const NXM_KEY: &str = "Software\\Classes\\nxm";
/// 本启动器唯一支持的游戏 domain（Nexus 的 cyberpunk2077 分区）。
pub const SUPPORTED_DOMAIN: &str = "cyberpunk2077";
/// 备份文件名，落在数据目录里，跟着状态文件一起走。
const BACKUP_FILE: &str = "nxm-handler.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandlerBackup {
    /// 接管前 `nxm` 的 open command（通常是 Vortex 的 `vortex.exe nxm://...`）。
    previous_command: String,
    saved_at: String,
}

fn invalid(message: &str) -> CommandError {
    CommandError::new("NXM_INVALID_LINK", message.to_string())
}

/// 解析 `nxm://` 链接。只做结构解析与 range 校验，不发任何网络请求。
pub fn parse_link(uri: &str) -> AppResult<NxmLink> {
    let trimmed = uri.trim();
    let lower = trimmed.to_ascii_lowercase();
    let body = if let Some(rest) = lower.strip_prefix("nxm://") {
        // 用原始串切，避免 to_ascii_lowercase 改写 key 的大小写。
        &trimmed[trimmed.len() - rest.len()..]
    } else if let Some(rest) = lower.strip_prefix("nxm:") {
        // 少数站点给的是 nxm:cyberpunk2077/... 这种省略斜杠的写法。
        let rest = trimmed[trimmed.len() - rest.len()..].trim_start_matches('/');
        rest
    } else {
        return Err(invalid("这不是 nxm:// 链接。"));
    };

    let (path_part, query) = match body.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (body, None),
    };
    let segments: Vec<&str> = path_part
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let Some(domain) = segments.first().map(|value| value.to_ascii_lowercase()) else {
        return Err(invalid("nxm 链接里没有游戏标识。"));
    };
    if domain != SUPPORTED_DOMAIN {
        return Err(CommandError::new(
            "NXM_UNSUPPORTED_GAME",
            format!("这个链接属于 {domain}，本启动器只接管 Cyberpunk 2077 的模组下载。"),
        ));
    }

    let mut mod_id: Option<u64> = None;
    let mut file_id: Option<u64> = None;
    let mut index = 1;
    while index < segments.len() {
        match segments[index].to_ascii_lowercase().as_str() {
            "mods" | "mod" => {
                mod_id = segments
                    .get(index + 1)
                    .and_then(|value| value.parse::<u64>().ok());
                index += 2;
            }
            "files" | "file" => {
                file_id = segments
                    .get(index + 1)
                    .and_then(|value| value.parse::<u64>().ok());
                index += 2;
            }
            _ => index += 1,
        }
    }
    let mod_id = mod_id.filter(|value| *value > 0).ok_or_else(|| {
        invalid("nxm 链接里没有有效的模组 ID（形如 nxm://cyberpunk2077/mods/107/files/1234）。")
    })?;

    let (key, expires, user_id) = match query {
        Some(query) => {
            let mut key = None;
            let mut expires = None;
            let mut user_id = None;
            for pair in query.split('&') {
                let Some((name, value)) = pair.split_once('=') else {
                    continue;
                };
                let value = percent_decode(value);
                match name.to_ascii_lowercase().as_str() {
                    "key" => key = Some(value),
                    "expires" => expires = Some(value),
                    "user_id" | "userid" => user_id = Some(value),
                    _ => {}
                }
            }
            (key, expires, user_id)
        }
        None => (None, None, None),
    };

    Ok(NxmLink {
        uri: trimmed.to_string(),
        domain,
        mod_id,
        file_id: file_id.filter(|value| *value > 0),
        key,
        expires,
        user_id,
    })
}

/// `%xx` 解码。链接里的 key 是签名串，带 `%3D` 一类转义，存原文会污染日志。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            // 必须走 get()：`%` 后面可能是多字节 UTF-8（如 `%中`），按字节切
            // &value[i+1..i+3] 会落在字符边界内直接 panic。panic="abort" 下
            // 这就是「点一个 nxm:// 链接，整个启动器进程没了」。
            // 顺带用 ASCII hex 过滤，避免把 `%+1` 之类当成有效转义往前跳。
            let hex = value
                .get(index + 1..index + 3)
                .filter(|h| h.len() == 2 && h.bytes().all(|b| b.is_ascii_hexdigit()));
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 从命令行参数里挑出所有 nxm 链接。
///
/// 两种场景共用这一个函数：首次由协议拉起（args 里带链接），
/// 以及已在运行时被单实例插件转交（第二个进程的 args）。
pub fn links_from_args<S: AsRef<str>>(args: &[S]) -> Vec<NxmLink> {
    args.iter()
        .filter_map(|arg| {
            let value = arg.as_ref().trim().trim_matches('"');
            if value.to_ascii_lowercase().starts_with("nxm:") {
                parse_link(value).ok()
            } else {
                None
            }
        })
        .collect()
}

fn backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BACKUP_FILE)
}

/// 本进程 exe 应有的处理器命令行。
pub fn handler_command() -> AppResult<String> {
    let exe = std::env::current_exe()
        .map_err(|err| CommandError::new("NXM_EXE", format!("无法定位启动器路径：{err}")))?;
    Ok(format!("\"{}\" \"%1\"", exe.display()))
}

fn read_backup(data_dir: &Path) -> Option<HandlerBackup> {
    let raw = std::fs::read_to_string(backup_path(data_dir)).ok()?;
    serde_json::from_str::<HandlerBackup>(&raw).ok()
}

pub(crate) fn write_backup(data_dir: &Path, command: &str) -> AppResult<()> {
    std::fs::create_dir_all(data_dir)?;
    // 覆盖前先把旧备份归档（自检 P2-5）：Vortex → 别的工具 → 本启动器 这种链条下，
    // 单级覆盖会让最早那个 handler 永久消失。归档件**不参与** release 恢复
    // （release 语义仍是「交还给上一家」），只作为事后取证：我原来是被谁接管的。
    if let Some(previous) = read_backup(data_dir) {
        if previous.previous_command != command {
            archive_previous_backup(data_dir, &previous);
        }
    }
    let payload = HandlerBackup {
        previous_command: command.to_string(),
        saved_at: crate::store::now_iso(),
    };
    let text = serde_json::to_string_pretty(&payload)
        .map_err(|err| CommandError::new("NXM_BACKUP", format!("无法序列化备份：{err}")))?;
    std::fs::write(backup_path(data_dir), text)
        .map_err(|err| CommandError::new("NXM_BACKUP", format!("无法写入备份：{err}")))?;
    Ok(())
}

/// 归档件保留份数：再多也翻不动，够回答「上一次是谁」就够了。
const BACKUP_ARCHIVE_KEEP: usize = 3;

/// 把即将被覆盖的旧备份另存一份 `nxm-handler.prev-<时间戳>.json`。
///
/// 全程 best-effort：归档只是附加证据，失败不能影响接管主流程（宁可少一份证据，
/// 也不能让用户点「接管」时因为写文件失败而失败）。
fn archive_previous_backup(data_dir: &Path, previous: &HandlerBackup) {
    // saved_at 是 ISO 时间串（含 ':'），不能直接进文件名，统一换成 '-'。
    let stamp: String = previous
        .saved_at
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let target = data_dir.join(format!("nxm-handler.prev-{stamp}.json"));
    if target.exists() {
        return;
    }
    let Ok(text) = serde_json::to_string_pretty(previous) else {
        return;
    };
    if std::fs::write(&target, text).is_err() {
        return;
    }
    prune_backup_archives(data_dir);
}

/// 只保留最近 N 份归档。按 mtime 排序（文件名里的时间戳可读性优先，排序交给文件系统）。
fn prune_backup_archives(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };
    let mut archives: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|item| item.ok())
        .filter(|item| {
            item.file_name()
                .to_string_lossy()
                .starts_with("nxm-handler.prev-")
        })
        .filter_map(|item| {
            let modified = item.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((modified, item.path()))
        })
        .collect();
    if archives.len() <= BACKUP_ARCHIVE_KEEP {
        return;
    }
    archives.sort_by_key(|(time, _)| *time);
    let excess = archives.len() - BACKUP_ARCHIVE_KEEP;
    for (_, path) in archives.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

fn command_key(root: &str) -> String {
    format!("{root}\\shell\\open\\command")
}

fn current_command_at(root: &str) -> Option<String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(command_key(root))
        .ok()
        .and_then(|key| key.get_value::<String, _>("").ok())
        .filter(|value| !value.trim().is_empty())
}

/// 这条命令是不是本启动器的（按 exe 路径比对，而不是按进程名）。
pub fn is_ours(command: &str) -> bool {
    let Ok(ours) = handler_command() else {
        return false;
    };
    normalize(command) == normalize(&ours)
}

/// 归一化命令行后比对：去掉引号与 `%1` 占位、统一斜杠、压低空白。
///
/// 不能只做 trim + 比较原串：注册表里常见的写法有
/// `"C:////App////x.exe" "%1"`、`C:////App////x.exe %1`、`C:/App/x.exe %1` 三种，
/// 都指向同一个 exe，判定必须一致。
fn normalize(command: &str) -> String {
    command
        .replace('/', "\\")
        .replace('"', "")
        .replace("%1", " ")
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn status(data_dir: &Path) -> NxmStatus {
    status_at(NXM_KEY, data_dir)
}

/// 同 `status`，但注册表根可注入——单测用一次性沙箱键，绝不动用户真实绑定。
pub fn status_at(root: &str, data_dir: &Path) -> NxmStatus {
    let handler = current_command_at(root);
    let ours = handler.as_deref().map(is_ours).unwrap_or(false);
    // 协议可用 = 键在 + 有命令行。URL Protocol 值是否为空不作判据：
    // Vortex 写的是空串 `URL Protocol=""`（合法写法），按非空判会误报「未注册」。
    let registered = handler.is_some()
        && RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(root)
            .is_ok();
    let backup = read_backup(data_dir);
    NxmStatus {
        ours,
        registered,
        owner: if ours {
            "us".to_string()
        } else if handler.is_some() {
            "other".to_string()
        } else {
            "none".to_string()
        },
        handler,
        backup: backup.as_ref().map(|item| item.previous_command.clone()),
        backup_at: backup.map(|item| item.saved_at),
    }
}

/// 接管 `nxm://`。别人的处理器会先原样备份到数据目录。
pub fn takeover(data_dir: &Path) -> AppResult<NxmStatus> {
    takeover_at(NXM_KEY, data_dir)
}

pub fn takeover_at(root: &str, data_dir: &Path) -> AppResult<NxmStatus> {
    let command = handler_command()?;
    if let Some(existing) = current_command_at(root) {
        if !is_ours(&existing) {
            write_backup(data_dir, &existing)?;
        }
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(root)
        .map_err(|err| CommandError::new("NXM_REGISTRY", format!("无法创建 nxm 注册表项：{err}")))?;
    key.set_value("", &"URL:NXM Protocol".to_string())
        .map_err(|err| CommandError::new("NXM_REGISTRY", format!("无法写入协议名：{err}")))?;
    key.set_value("URL Protocol", &"".to_string())
        .map_err(|err| CommandError::new("NXM_REGISTRY", format!("无法标记 URL 协议：{err}")))?;
    let (command_entry, _) = hkcu
        .create_subkey(command_key(root))
        .map_err(|err| CommandError::new("NXM_REGISTRY", format!("无法创建启动命令项：{err}")))?;
    command_entry
        .set_value("", &command)
        .map_err(|err| CommandError::new("NXM_REGISTRY", format!("无法写入启动命令：{err}")))?;
    Ok(status_at(root, data_dir))
}

/// 交还 `nxm://`。有备份就精确写回（通常是回到 Vortex），没有就删掉自己建的子树。
pub fn release(data_dir: &Path) -> AppResult<NxmStatus> {
    release_at(NXM_KEY, data_dir)
}

pub fn release_at(root: &str, data_dir: &Path) -> AppResult<NxmStatus> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let backup = read_backup(data_dir);
    match backup {
        Some(backup) if !is_ours(&backup.previous_command) => {
            let (command_entry, _) = hkcu.create_subkey(command_key(root)).map_err(|err| {
                CommandError::new("NXM_REGISTRY", format!("无法打开启动命令项：{err}"))
            })?;
            command_entry
                .set_value("", &backup.previous_command)
                .map_err(|err| {
                    CommandError::new("NXM_REGISTRY", format!("无法恢复原处理器：{err}"))
                })?;
            let _ = std::fs::remove_file(backup_path(data_dir));
        }
        _ => {
            // 没有备份（我们自己第一个注册的）：整棵 nxm 子树都是本次接管建的，
            // 删掉不会影响别人——前提是当前命令仍指向本 exe。
            if let Some(existing) = current_command_at(root) {
                if !is_ours(&existing) {
                    return Err(CommandError::new(
                        "NXM_NOT_OURS",
                        "当前 nxm 处理器已经被别的程序接管了，本启动器不去动它。",
                    ));
                }
            }
            hkcu.delete_subkey_all(root).map_err(|err| {
                CommandError::new("NXM_REGISTRY", format!("无法删除 nxm 注册表项：{err}"))
            })?;
            let _ = std::fs::remove_file(backup_path(data_dir));
        }
    }
    Ok(status_at(root, data_dir))
}
