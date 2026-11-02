//! Nexus Mods API client.
//!
//! The launcher deliberately does not scrape the website. It uses the official
//! v1 API with a user-supplied personal API key, so rate limits and permissions
//! are enforced by Nexus. Free accounts can browse and open the download page;
//! direct downloads are only available to Premium accounts because Nexus only
//! issues download links to Premium keys.

use crate::installer;
use crate::schema::{
    AppResult, CommandError, InstallOutcome, NexusCoverRefresh, NexusDownloadResult, NexusFile,
    NexusModDetail, NexusModSummary, NexusRef, NexusStatus, NexusUpdateItem, NexusUpdateReport,
    NexusUser,
};
use crate::secret;
use crate::store::Store;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const GAME_DOMAIN: &str = "cyberpunk2077";
const API_BASE: &str = "https://api.nexusmods.com/v1";
const MAX_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

pub fn key_path(store: &Store) -> PathBuf {
    key_path_from(&store.data_dir)
}

/// 同上，但只给数据目录：`--self-check` 拿不到 Store 时也要能定位密钥文件。
pub fn key_path_from(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets").join("nexus-api.key")
}

fn client() -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(12))
        .user_agent("CyberDeckLauncher/0.7.0 (Tauri; Windows; Nexus-API)")
        .build()
        .map_err(|e| CommandError::new("NEXUS_HTTP", format!("无法创建网络客户端：{e}")))
}

fn api_key(store: &Store) -> AppResult<String> {
    secret::load(&key_path(store))?.ok_or_else(|| {
        CommandError::new(
            "NEXUS_NOT_CONFIGURED",
            "还没有配置 Nexus API Key。请到「设置 → Nexus Mods」填写个人 API Key。",
        )
    })
}

fn api_error(status: StatusCode, body: &str) -> CommandError {
    let snippet: String = body.chars().take(500).collect();
    match status {
        StatusCode::UNAUTHORIZED => CommandError::new(
            "NEXUS_AUTH",
            "Nexus API Key 已失效（HTTP 401）。请重新在「设置 → 工具组件 → Nexus Mods」             填写 Personal API Key —— 换账号、在 Nexus 网站上重新生成过 Key、或 Key 被撤销，             都会让旧 Key 立刻失效。",
        ),
        StatusCode::FORBIDDEN => CommandError::new(
            "NEXUS_FORBIDDEN",
            format!(
                "Nexus 拒绝了这个请求。最常见的原因是免费账号不能通过 API 直接下载（需要 Premium），\
                 或者这个模组限制了 API 访问。\n{snippet}"
            ),
        ),
        StatusCode::TOO_MANY_REQUESTS => CommandError::new(
            "NEXUS_RATE_LIMIT",
            "Nexus API 请求过于频繁，请稍后再试。",
        ),
        StatusCode::NOT_FOUND => CommandError::new(
            "NEXUS_NOT_FOUND",
            "Nexus 上找不到这个模组或文件。它可能已被作者删除或隐藏。",
        ),
        _ => CommandError::new(
            "NEXUS_HTTP",
            format!("Nexus API 返回 HTTP {}。\n{snippet}", status.as_u16()),
        ),
    }
}

fn get(client: &Client, key: &str, url: &str) -> AppResult<Response> {
    let response = client
        .get(url)
        .header("apikey", key)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| CommandError::new("NEXUS_NETWORK", format!("连接 Nexus 失败：{e}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(api_error(status, &body));
    }
    Ok(response)
}

fn get_json<T: for<'de> Deserialize<'de>>(client: &Client, key: &str, url: &str) -> AppResult<T> {
    let response = get(client, key, url)?;
    response
        .json::<T>()
        .map_err(|e| CommandError::new("NEXUS_PARSE", format!("Nexus 返回了无法解析的数据：{e}")))
}

#[derive(Debug, Deserialize)]
struct ApiValidate {
    name: String,
    #[serde(default)]
    profile_url: Option<String>,
    #[serde(default)]
    is_premium: bool,
    #[serde(default)]
    is_supporter: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiMod {
    mod_id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    category_name: String,
    #[serde(default)]
    picture_url: Option<String>,
    #[serde(default)]
    mod_page_url: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default, alias = "endorsements")]
    endorsement_count: u64,
    #[serde(default, alias = "adult")]
    adult_content: bool,
    #[serde(default)]
    updated_time: Option<String>,
    #[serde(default)]
    created_time: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

impl ApiMod {
    fn into_summary(self) -> NexusModSummary {
        let fallback = format!(
            "https://www.nexusmods.com/{GAME_DOMAIN}/mods/{}",
            self.mod_id
        );
        NexusModSummary {
            mod_id: self.mod_id,
            name: self.name,
            summary: self.summary,
            author: self.author,
            version: self.version,
            category: self.category_name,
            picture_url: self.picture_url,
            mod_page_url: Some(self.mod_page_url.unwrap_or(fallback)),
            downloads: self.downloads,
            endorsements: self.endorsement_count,
            adult: self.adult_content,
            updated_time: self.updated_time,
            created_time: self.created_time,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ApiFiles {
    #[serde(default)]
    files: Vec<ApiFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiFile {
    file_id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    mod_version: String,
    #[serde(default)]
    category_name: String,
    #[serde(default)]
    size_kb: u64,
    #[serde(default)]
    uploaded_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiDownloadLink {
    #[serde(rename = "URI", default, alias = "uri")]
    uri: String,
}

fn validate_key(key: &str) -> AppResult<ApiValidate> {
    let client = client()?;
    get_json::<ApiValidate>(&client, key, &format!("{API_BASE}/users/validate.json"))
}

/// 「测试连接」结果：失败也返回结构化数据，前端好稳定地显示状态码与原因。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusTestResult {
    pub ok: bool,
    #[serde(default)]
    pub status_code: Option<u16>,
    pub latency_ms: u64,
    pub message: String,
    /// 校验成功时 Nexus 回的用户名（证明连的是谁的号）。
    #[serde(default)]
    pub user: Option<String>,
}

/// 用给定 key（或已保存的 key）打一次 `/users/validate.json`。
///
/// 故意不抛错：设置页需要把 401 / 网络错误 / 未配置都显示成一行文字 + 状态码，
/// 而不是一个会消失的红框。
pub fn test_connection(store: &Store, key_override: Option<&str>) -> NexusTestResult {
    let key = key_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| secret::load(&key_path(store)).ok().flatten());
    let Some(key) = key else {
        return NexusTestResult {
            ok: false,
            status_code: None,
            latency_ms: 0,
            message: "还没有填写 Nexus API Key。".to_string(),
            user: None,
        };
    };
    let started = std::time::Instant::now();
    let outcome = validate_key(&key);
    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(info) => NexusTestResult {
            ok: true,
            status_code: Some(200),
            latency_ms,
            message: format!("连接成功，已登录为 {}。", info.name),
            user: Some(info.name),
        },
        Err(err) => NexusTestResult {
            ok: false,
            // 401 时把状态码显式带出来，前端据此高亮「去重新生成 Key」。
            status_code: if err.code == "NEXUS_AUTH" { Some(401) } else { None },
            latency_ms,
            message: err.message,
            user: None,
        },
    }
}

pub fn status(store: &Store) -> NexusStatus {
    let configured = secret::load(&key_path(store)).ok().flatten().is_some();
    if !configured {
        return NexusStatus {
            configured: false,
            connected: false,
            user: None,
            error: None,
        };
    }
    let key = match secret::load(&key_path(store)) {
        Ok(Some(key)) => key,
        Ok(None) => {
            return NexusStatus {
                configured: false,
                connected: false,
                user: None,
                error: None,
            }
        }
        Err(err) => {
            return NexusStatus {
                configured: true,
                connected: false,
                user: None,
                error: Some(err.message),
            }
        }
    };
    match validate_key(&key) {
        Ok(user) => NexusStatus {
            configured: true,
            connected: true,
            user: Some(NexusUser {
                name: user.name,
                profile_url: user.profile_url,
                is_premium: user.is_premium,
                is_supporter: user.is_supporter,
            }),
            error: None,
        },
        Err(err) => NexusStatus {
            configured: true,
            connected: false,
            user: None,
            error: Some(err.message),
        },
    }
}

pub fn set_key(store: &Store, key: &str) -> AppResult<NexusStatus> {
    let trimmed = key.trim();
    if trimmed.len() < 8 {
        return Err(CommandError::new(
            "NEXUS_KEY_INVALID",
            "API Key 看起来不完整。请到 Nexus 账号设置里复制完整的 personal API key。",
        ));
    }
    // Validate before persisting so a typo never replaces a working key.
    validate_key(trimmed)?;
    secret::save(&key_path(store), trimmed)?;
    Ok(status(store))
}

pub fn clear_key(store: &Store) -> AppResult<NexusStatus> {
    secret::clear(&key_path(store))?;
    Ok(NexusStatus {
        configured: false,
        connected: false,
        user: None,
        error: None,
    })
}

pub fn browse(store: &Store, section: &str) -> AppResult<Vec<NexusModSummary>> {
    let key = api_key(store)?;
    let endpoint = match section {
        "trending" => "trending.json",
        "latest_added" => "latest_added.json",
        "latest_updated" => "latest_updated.json",
        other => {
            return Err(CommandError::new(
                "NEXUS_BAD_SECTION",
                format!("未知的 Nexus 列表：{other}"),
            ))
        }
    };
    let client = client()?;
    let mods: Vec<ApiMod> = get_json(
        &client,
        &key,
        &format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{endpoint}"),
    )?;
    let hide_adult = store.snapshot_data().settings.nexus_hide_adult;
    Ok(mods
        .into_iter()
        .filter(|item| !(hide_adult && item.adult_content))
        .map(ApiMod::into_summary)
        .collect())
}

pub fn detail(store: &Store, mod_id: u64) -> AppResult<NexusModDetail> {
    let key = api_key(store)?;
    let client = client()?;
    let raw: ApiMod = get_json(
        &client,
        &key,
        &format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}.json"),
    )?;
    let description = raw
        .description
        .clone()
        .unwrap_or_default()
        .chars()
        .take(20_000)
        .collect::<String>();
    let files_raw: ApiFiles = get_json(
        &client,
        &key,
        &format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}/files.json"),
    )?;
    let files = files_raw
        .files
        .into_iter()
        .map(|file| NexusFile {
            file_id: file.file_id,
            name: file.name,
            file_name: file.file_name,
            version: file.mod_version,
            category: file.category_name,
            size_kb: file.size_kb,
            uploaded_time: file.uploaded_time,
            primary: false,
        })
        .collect();
    Ok(NexusModDetail {
        summary: raw.into_summary(),
        description,
        files,
    })
}

/// 给库里的老记录批量补全 Nexus 官方封面。
///
/// 只打 mod 详情这一个请求：`detail` 会连带拉一次 files，批量回查几十个模组时
/// 那份文件清单一条也用不上，白白多耗一倍配额和等待时间。
///
/// 这是阻塞调用，命令层要放进 `spawn_blocking`，别卡住 webview。
pub fn refresh_covers(store: &Store) -> AppResult<NexusCoverRefresh> {
    // 没配 Key 时 api_key 报的是 NEXUS_NOT_CONFIGURED；批量补封面是纯联网功能，
    // 这里换成语义更直接的 NEXUS_NOT_CONNECTED，前端才好据此直接引导去设置页，
    // 而不是丢给用户一句「没配置」让他自己找是哪个配置项。
    let key = api_key(store).map_err(|err| {
        if err.code == "NEXUS_NOT_CONFIGURED" {
            CommandError::new(
                "NEXUS_NOT_CONNECTED",
                "还没有连接 Nexus 账号，无法补全封面。请先到「设置 → Nexus Mods」填写个人 API Key。",
            )
        } else {
            err
        }
    })?;

    // 这一轮可能跑几十秒（每条之间还要主动 sleep），所以先只收集下标和 id，
    // 收完立刻放掉快照进网络阶段：握着 store.data 会把快照、部署这些命令一起堵死。
    //
    // 溯源增强（2026-11-01 用户反馈）：只看 entry.nexus 会漏掉一大批「明明是 N 网
    // 下载、接管进库时丢了引用」的模组——它们被整体计入 skipped，于是一条封面都
    // 不补还报告「所有 Nexus 模组都已经有封面了」，正是用户撞到的误报。现在对没有
    // nexus 引用的条目也尝试从文件名 / 来源包名 / 暂存目录名解析 ModId（收编流程
    // 保留 Nexus 的 `名称-ModId-FileId-版本` 命名），认得出就一起进补全队列，并把
    // 解析出的引用写回 entry.nexus，下次更新检查也能用上。
    let mut pending: Vec<(usize, String, u64, Option<u64>, bool)> = Vec::new();
    let mut skipped = 0usize;
    let mut nexus_total = 0usize;
    {
        let snapshot = store.snapshot_data();
        for (index, entry) in snapshot.mods.iter().enumerate() {
            let Some(reference) = entry.nexus.as_ref() else {
                // 没有官方引用：先溯源，认不出才真正跳过（本地导入、游戏目录扫描）。
                let candidates = [
                    Some(entry.name.clone()),
                    entry.source_zip.clone(),
                    entry
                        .staging_path
                        .trim_end_matches(['/', '\\'])
                        .rsplit(['/', '\\'])
                        .next()
                        .map(str::to_string),
                ];
                let Some((mod_id, file_id)) =
                    candidates.iter().flatten().find_map(|text| parse_nexus_ids(text))
                else {
                    skipped += 1;
                    continue;
                };
                nexus_total += 1;
                pending.push((index, entry.id.clone(), mod_id, file_id, false));
                continue;
            };
            nexus_total += 1;
            // 空字符串等同于没存，别让一条坏数据把整批补全挡在门外。
            let has_cover = entry
                .nexus_cover_url
                .as_deref()
                .is_some_and(|url| !url.trim().is_empty());
            if !has_cover {
                pending.push((index, entry.id.clone(), reference.mod_id, reference.file_id, true));
            }
        }
    }

    if pending.is_empty() {
        let message = if nexus_total == 0 {
            "库里还没有认出 Nexus 模组，不需要补封面。".to_string()
        } else if skipped > 0 {
            format!(
                "已关联的 {nexus_total} 个 Nexus 模组都有封面；另有 {skipped} 个模组认不出 Nexus ID（本地包或目录名没有 ID 特征），无法自动补全。"
            )
        } else {
            "所有 Nexus 模组都已经有封面了。".to_string()
        };
        return Ok(NexusCoverRefresh {
            updated: 0,
            failed: 0,
            skipped,
            message,
        });
    }

    let client = client()?;
    let mut updates: Vec<(usize, String, String, bool, u64, Option<u64>)> = Vec::new();
    let mut failed = 0usize;
    for (attempt, (index, entry_id, mod_id, file_id, had_ref)) in pending.into_iter().enumerate() {
        if attempt > 0 {
            // Nexus 对 API 有速率限制，连续无缝请求很容易吃到 429；批量场景下
            // 一条被限流会连带拖坏后面几条，用 250ms 间隔换整批稳定更划算。
            std::thread::sleep(Duration::from_millis(250));
        }
        let url = format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}.json");
        match get_json::<ApiMod>(&client, &key, &url) {
            Ok(raw) => {
                let cover = raw
                    .picture_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|url| !url.is_empty())
                    .map(str::to_string);
                match cover {
                    Some(cover) => updates.push((index, entry_id, cover, had_ref, mod_id, file_id)),
                    // 官网这条 Mod 本来就没传图，重试多少次都一样，只能记失败。
                    None => failed += 1,
                }
            }
            // 单条失败不连坐整批：下架、设为隐藏、网络抖动都很常见，
            // 剩下的照常补，失败的条数交给前端去提示。
            Err(_) => failed += 1,
        }
    }

    let updated = updates.len();
    if !updates.is_empty() {
        let mut data = store.data.lock().expect("state mutex poisoned");
        for (index, entry_id, cover, had_ref, mod_id, file_id) in updates {
            // 请求期间库可能被别的命令改过（比如正好卸掉一个 Mod），
            // 下标命中后还要核对 id，否则封面会写到别的模组身上。
            if let Some(entry) = data.mods.get_mut(index) {
                if entry.id == entry_id {
                    entry.nexus_cover_url = Some(cover.clone());
                    if !had_ref {
                        // 溯源成功：把解析出的引用一并落盘（与「粘贴链接」同构），
                        // 封面地址也写进引用里，保持两条路径的数据形状一致。
                        entry.nexus = Some(NexusRef {
                            mod_id,
                            file_id,
                            url: format!("https://www.nexusmods.com/cyberpunk2077/mods/{mod_id}"),
                            version: entry.version.clone(),
                            picture_url: Some(cover),
                            latest_version: None,
                            last_check: None,
                        });
                        entry.updated_at = Some(crate::store::now_iso());
                    }
                }
            }
        }
        store.save(&data)?;
    }

    let message = if failed == 0 {
        format!("补全了 {updated} 个封面。")
    } else {
        format!("补全了 {updated} 个封面，{failed} 个失败（官网无图或网络问题）。")
    };
    Ok(NexusCoverRefresh {
        updated,
        failed,
        skipped,
        message,
    })
}

/// 从 Nexus 模组链接里取出 ModId：支持 `.../mods/28099`、`.../mods/28099?tab=files` 等形态。
fn parse_mod_id_from_url(url: &str) -> Option<u64> {
    let marker = "/mods/";
    let start = url.find(marker)? + marker.len();
    let digits: String = url[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse::<u64>().ok().filter(|id| *id >= 1)
}

/// 用用户粘贴的 Nexus 链接补全单个模组的信息（B 方案：无需 OAuth，手动指定一次即可）。
pub fn attach_from_url(store: &Store, entry_id: &str, url: &str) -> AppResult<()> {
    let mod_id = parse_mod_id_from_url(url.trim()).ok_or_else(|| {
        CommandError::new(
            "NEXUS_BAD_LINK",
            "这个链接里找不到模组编号。请粘贴形如 …/cyberpunk2077/mods/28099 的地址。",
        )
    })?;
    let key = api_key(store)?;
    let client = client()?;
    let api_url = format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}.json");
    let raw: ApiMod = get_json(&client, &key, &api_url)?;

    let mut data = store.data.lock().expect("state mutex poisoned");
    let entry = data
        .mods
        .iter_mut()
        .find(|item| item.id == entry_id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "这个模组已经不在库里了。"))?;
    if !raw.name.trim().is_empty() {
        entry.name = raw.name;
    }
    if !raw.author.trim().is_empty() {
        entry.author = Some(raw.author);
    }
    if !raw.version.trim().is_empty() {
        entry.version = Some(raw.version);
    }
    // P6：Nexus 的 category_name 是英文分区名（Body/Weapons/…），不能直接当本地
    // 分类用；走映射表落地到 10 类里的一个，映射不出来再退回内容证据。
    if !raw.category_name.trim().is_empty() {
        crate::installer::apply_nexus_category(entry, &raw.category_name);
    }
    entry.nexus = Some(NexusRef {
        mod_id,
        file_id: None,
        url: format!("https://www.nexusmods.com/{GAME_DOMAIN}/mods/{mod_id}"),
        version: entry.version.clone(),
        picture_url: raw.picture_url.clone(),
        latest_version: None,
        last_check: None,
    });
    if entry
        .nexus_cover_url
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        entry.nexus_cover_url = raw.picture_url;
    }
    entry.metadata_source = "nexus-link".to_string();
    entry.updated_at = Some(crate::store::now_iso());
    store.save(&data)
}

/// 从文件名/路径里认出 Nexus 的 (ModId, FileId)。
///
/// Nexus 的下载文件名形如 `模组名-28099-1-0-0-1772990692`（名称-ModId-FileId-版本-时间戳），
/// Vortex 的暂存目录也保留同样的数字后缀。这里只认「名称之后第一组 `数字-数字-数字`」，
/// 且要求 ModId ≥ 100 —— 版本号 `1-0-0` 这类片段不能被误认成 ModId。
fn parse_nexus_ids(text: &str) -> Option<(u64, Option<u64>)> {
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        // 一个数字组的起止
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let first = &text[start..index];
        // 必须是 `数字-数字-数字` 的三段式
        if index + 1 < bytes.len() && bytes[index] == b'-' {
            let second_start = index + 1;
            let mut cursor = second_start;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            let second = &text[second_start..cursor];
            if !first.is_empty() && !second.is_empty() && cursor < bytes.len() && bytes[cursor] == b'-' {
                let after = cursor + 1;
                if after < bytes.len() && bytes[after].is_ascii_digit() {
                    let mod_id: u64 = first.parse().ok()?;
                    let file_id: u64 = second.parse().ok()?;
                    if mod_id >= 100 {
                        return Some((mod_id, Some(file_id)));
                    }
                }
            }
        }
        if index == start {
            index += 1;
        }
    }
    None
}

/// 批量补全「从 Vortex/游戏目录收编进来」的模组元数据。
///
/// 收编流程只看得到部署产物，名称只能取文件名（`_Osp0_xxx.tpp`），于是卡片上
/// 「Unknown author · no version · 无封面」。这里用文件名里的 Nexus ModId 反查官方
/// 元数据（名称/作者/版本/分类/封面），把 Vortex 里看到的信息尽量还原回来。
///
/// 边界：
/// - 已有 `nexus` 引用、或用户手动编辑过（`metadata_source == "manual"`）的一律跳过；
/// - 单条失败不连坐整批（下架、隐藏、限流都很常见）；
/// - 250ms 节流 + 单批上限 40，避免吃满 Nexus 速率限制。
pub fn enrich_metadata(store: &Store) -> AppResult<crate::schema::NexusEnrichReport> {
    const MAX_CHECKS: usize = 40;

    let key = api_key(store).map_err(|err| {
        if err.code == "NEXUS_NOT_CONFIGURED" {
            CommandError::new(
                "NEXUS_NOT_CONNECTED",
                "还没有连接 Nexus 账号，无法补全模组信息。请先到「设置 → Nexus Mods」填写个人 API Key。",
            )
        } else {
            err
        }
    })?;

    // 先在短锁内取快照，网络阶段不持锁（锁纪律）。
    let mut pending: Vec<(String, u64, Option<u64>)> = Vec::new();
    let mut scanned = 0usize;
    let mut unmatched = 0usize;
    {
        let snapshot = store.snapshot_data();
        for entry in snapshot.mods.iter() {
            if entry.nexus.is_some() || entry.metadata_source == "manual" {
                continue;
            }
            scanned += 1;
            // 依次尝试：显示名、来源压缩包名、暂存路径末段（Vortex 收编常见带数字后缀）
            let candidates = [
                Some(entry.name.clone()),
                entry.source_zip.clone(),
                entry
                    .staging_path
                    .trim_end_matches(['/', '\\'])
                    .rsplit(['/', '\\'])
                    .next()
                    .map(str::to_string),
            ];
            let parsed = candidates
                .iter()
                .flatten()
                .find_map(|text| parse_nexus_ids(text));
            match parsed {
                Some((mod_id, file_id)) => pending.push((entry.id.clone(), mod_id, file_id)),
                None => unmatched += 1,
            }
        }
    }

    if pending.is_empty() {
        let message = if scanned == 0 {
            "没有需要补全的模组。".to_string()
        } else {
            format!("{scanned} 个模组都没能从文件名认出 Nexus ModId，需要手动编辑信息。")
        };
        return Ok(crate::schema::NexusEnrichReport {
            scanned,
            matched: 0,
            updated: 0,
            failed: 0,
            unmatched,
            message,
        });
    }

    let client = client()?;
    struct Enriched {
        id: String,
        name: String,
        author: String,
        version: String,
        category: String,
        summary: String,
        mod_id: u64,
        file_id: Option<u64>,
        url: String,
        picture_url: Option<String>,
    }
    let mut results: Vec<Enriched> = Vec::new();
    let mut failed = 0usize;

    for (attempt, (entry_id, mod_id, file_id)) in pending.iter().take(MAX_CHECKS).enumerate() {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(250));
        }
        let url = format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}.json");
        match get_json::<ApiMod>(&client, &key, &url) {
            Ok(raw) if !raw.name.trim().is_empty() => results.push(Enriched {
                id: entry_id.clone(),
                name: raw.name,
                author: raw.author,
                version: raw.version,
                category: raw.category_name,
                summary: raw.summary,
                mod_id: *mod_id,
                file_id: *file_id,
                url: raw
                    .mod_page_url
                    .unwrap_or_else(|| format!("https://www.nexusmods.com/{GAME_DOMAIN}/mods/{mod_id}")),
                picture_url: raw.picture_url,
            }),
            _ => failed += 1,
        }
    }

    let matched = pending.len();
    let updated = results.len();
    if !results.is_empty() {
        let mut data = store.data.lock().expect("state mutex poisoned");
        for item in results {
            // 请求期间库可能被改动，按 id 定位而不是下标。
            let Some(entry) = data.mods.iter_mut().find(|m| m.id == item.id) else {
                continue;
            };
            if entry.metadata_source == "manual" {
                continue;
            }
            if !item.name.trim().is_empty() {
                entry.name = item.name;
            }
            if !item.author.trim().is_empty() {
                entry.author = Some(item.author);
            }
            if !item.version.trim().is_empty() {
                entry.version = Some(item.version);
            }
            if !item.category.trim().is_empty() {
                crate::installer::apply_nexus_category(entry, &item.category);
            }
            if !item.summary.trim().is_empty() {
                entry.description = item.summary;
            }
            entry.nexus = Some(NexusRef {
                mod_id: item.mod_id,
                file_id: item.file_id,
                url: item.url,
                version: entry.version.clone(),
                picture_url: item.picture_url.clone(),
                latest_version: None,
                last_check: None,
            });
            if entry
                .nexus_cover_url
                .as_deref()
                .is_none_or(|url| url.trim().is_empty())
            {
                entry.nexus_cover_url = item.picture_url;
            }
            entry.metadata_source = "nexus".to_string();
            entry.updated_at = Some(crate::store::now_iso());
        }
        store.save(&data)?;
    }

    let mut message = format!("补全了 {updated} 个模组的信息。");
    if failed > 0 {
        message.push_str(&format!("{failed} 个请求失败（可能已下架或网络问题）。"));
    }
    if unmatched > 0 {
        message.push_str(&format!("{unmatched} 个认不出 ModId，可手动编辑。"));
    }
    if matched > MAX_CHECKS {
        message.push_str(&format!("本轮只处理了 {MAX_CHECKS} 个，剩余的再点一次继续。"));
    }

    Ok(crate::schema::NexusEnrichReport {
        scanned,
        matched,
        updated,
        failed,
        unmatched,
        message,
    })
}

/// 手动编辑模组信息（兜底方案 C）：名称/作者/版本/分类。
/// 一旦手动保存，`metadata_source` 标记为 `manual`，之后任何自动补全都不再覆盖。
pub fn update_metadata(
    store: &Store,
    id: &str,
    name: &str,
    author: &str,
    version: &str,
    category: &str,
) -> AppResult<()> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(CommandError::new("MOD_NAME_EMPTY", "模组名称不能为空。"));
    }
    let mut data = store.data.lock().expect("state mutex poisoned");
    let entry = data
        .mods
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "这个模组已经不在库里了。"))?;
    entry.name = trimmed_name.to_string();
    entry.author = Some(author.trim().to_string()).filter(|value| !value.is_empty());
    entry.version = Some(version.trim().to_string()).filter(|value| !value.is_empty());
    if !category.trim().is_empty() {
        entry.category = category.trim().to_string();
    }
    entry.metadata_source = "manual".to_string();
    entry.updated_at = Some(crate::store::now_iso());
    store.save(&data)
}

/// Nexus `updated.json` 的条目：只取时间戳，其它字段不关心。
#[derive(Debug, Clone, Deserialize)]
struct ApiUpdatedEntry {
    #[serde(default)]
    latest_file_update: u64,
    /// 评论/点赞等「非文件」活跃时间：不参与排序，保留是为了看清 API 形状。
    #[serde(default)]
    #[allow(dead_code)]
    latest_mod_activity: u64,
}

/// 批量检查库内 Nexus 模组的更新（P5-5A 重构）。
///
/// 两段式，目的都是省配额：
/// 1. 先拉 `mods/updated.json`（**一次**请求）——它只含最近一个月有文件变更的
///    模组。命中的先查，因为它们最可能有更新。
/// 2. 再按预算逐条查 `mods/{id}.json` 拿版本号。预算 40 条 + 250ms 节流，
///    超出的记为 `stale`（「这轮没查完」，不是「没有更新」）。
///
/// 判定用 `vercmp::is_newer` 而不是字符串相等：`1.0` 与 `1.0.0` 是同一版本，
/// `1.10` 比 `1.9` 新——字符串比会把这两种都判错。
/// 老记录没存版本号的跳过：宁可漏报也不把「未知」当「有更新」。
///
/// 检查结果会写回每条 `NexusRef.latest_version` / `last_check`，
/// 以及状态里的 `last_update_check`，前端据此显示「上次检查」。
pub fn check_updates(store: &Store) -> AppResult<NexusUpdateReport> {
    const MAX_CHECKS: usize = 40;
    let key = api_key(store)?;
    let client = client()?;

    // updated.json 拿不到不致命：退回「全量详情比对」，只是费配额。
    let updated: std::collections::HashMap<String, ApiUpdatedEntry> = get_json(
        &client,
        &key,
        &format!("{API_BASE}/games/{GAME_DOMAIN}/mods/updated.json"),
    )
    .unwrap_or_default();

    struct Target {
        entry_id: String,
        mod_id: u64,
        current_version: String,
        name: String,
        recently_updated: bool,
        /// updated.json 里的最近文件更新时间戳；0 = 不在近一个月窗口内。
        file_update: u64,
    }

    let mut targets: Vec<Target> = Vec::new();
    let mut skipped = 0usize;
    {
        let snapshot = store.snapshot_data();
        for entry in snapshot.mods.iter() {
            let Some(reference) = entry.nexus.as_ref() else {
                skipped += 1;
                continue;
            };
            let version = reference
                .version
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(version) = version else {
                // 没存安装版本时无从比较，视为跳过而不是误报。
                skipped += 1;
                continue;
            };
            let hit = updated.get(&reference.mod_id.to_string());
            targets.push(Target {
                entry_id: entry.id.clone(),
                mod_id: reference.mod_id,
                current_version: version.to_string(),
                name: entry.name.clone(),
                recently_updated: hit.is_some(),
                file_update: hit.map(|item| item.latest_file_update).unwrap_or(0),
            });
        }
    }

    if targets.is_empty() {
        return Ok(NexusUpdateReport {
            checked: 0,
            skipped,
            failed: 0,
            updates: Vec::new(),
            stale: 0,
            message: if skipped > 0 {
                "库里没有可比较版本的 Nexus 模组（老记录没存版本号）。重新从 N 网下载一次就能记录版本。".to_string()
            } else {
                "库里还没有从 Nexus 安装的模组。".to_string()
            },
            generated_at: crate::store::now_iso(),
        });
    }

    // 最近一个月动过的排前面，同组内按文件更新时间从新到旧：配额有限时
    // 优先覆盖最可能变的那批（`latest_mod_activity` 是评论/点赞时间，不参与排序）。
    targets.sort_by(|left, right| {
        right
            .recently_updated
            .cmp(&left.recently_updated)
            .then(right.file_update.cmp(&left.file_update))
    });

    let total = targets.len();
    let mut updates: Vec<NexusUpdateItem> = Vec::new();
    let mut failed = 0usize;
    let mut checked_ids: Vec<(String, Option<String>, String)> = Vec::new();

    for (attempt, target) in targets.iter().take(MAX_CHECKS).enumerate() {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(250));
        }
        let url = format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{}.json", target.mod_id);
        match get_json::<ApiMod>(&client, &key, &url) {
            Ok(raw) => {
                let latest = raw.version.trim().to_string();
                let now = crate::store::now_iso();
                if !latest.is_empty() {
                    checked_ids.push((target.entry_id.clone(), Some(latest.clone()), now.clone()));
                }
                if crate::vercmp::is_newer(&latest, &target.current_version) {
                    let page = raw.mod_page_url.clone().unwrap_or_else(|| {
                        format!(
                            "https://www.nexusmods.com/{GAME_DOMAIN}/mods/{}",
                            target.mod_id
                        )
                    });
                    updates.push(NexusUpdateItem {
                        entry_id: target.entry_id.clone(),
                        mod_id: target.mod_id,
                        name: target.name.clone(),
                        current_version: Some(target.current_version.clone()),
                        latest_version: latest,
                        page_url: page,
                    });
                }
            }
            // 单条失败不连坐：下架、隐藏、限流都常见，计数交给前端提示。
            Err(_) => failed += 1,
        }
    }

    let attempted = total.min(MAX_CHECKS);
    let checked = attempted.saturating_sub(failed);
    let stale = total.saturating_sub(MAX_CHECKS);
    let found = updates.len();
    let generated_at = crate::store::now_iso();

    // 回写检查痕迹：哪条查过、查到的最新版本、什么时候查的。
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        for (entry_id, latest_version, checked_at) in checked_ids.iter() {
            if let Some(entry) = data.mods.iter_mut().find(|item| &item.id == entry_id) {
                if let Some(reference) = entry.nexus.as_mut() {
                    if latest_version.is_some() {
                        reference.latest_version = latest_version.clone();
                    }
                    reference.last_check = Some(checked_at.clone());
                }
            }
        }
        data.last_update_check = Some(generated_at.clone());
        let _ = store.save(&data);
    }

    let mut message = format!("检查了 {checked} 个模组，{found} 个有新版本。");
    if failed > 0 {
        message = format!("检查了 {checked} 个模组，{found} 个有新版本，{failed} 个查询失败。");
    }
    if stale > 0 {
        message.push_str(&format!("还有 {stale} 个这轮没查完，下次再查。"));
    }

    Ok(NexusUpdateReport {
        checked,
        skipped,
        failed,
        updates,
        stale,
        message,
        generated_at,
    })
}

pub(crate) fn safe_download_name(mod_id: u64, file_id: u64, file_name: &str) -> String {
    let candidate = file_name
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(file_name)
        .trim();
    let mut cleaned: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ' | '(' | ')' | '[' | ']') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        cleaned = format!("nexus-{mod_id}-{file_id}.zip");
    }
    if cleaned.len() > 140 {
        let ext = Path::new(&cleaned)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("zip")
            .to_string();
        cleaned.truncate(130);
        cleaned.push('.');
        cleaned.push_str(&ext);
    }
    cleaned
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    mod_id: u64,
    file_id: u64,
    received: u64,
    total: Option<u64>,
}

/// 一个已经落到本地 `downloads` 目录的文件（P5-5B 抽出，更新流程复用同一套下载）。
pub(crate) struct DownloadedFile {
    pub path: PathBuf,
    pub file_name: String,
    pub file_id: u64,
    /// Nexus 上这个模组的版本号（detail.json 的 version）。
    pub version: Option<String>,
    /// Nexus 官方分区名（Body / Weapons / …），装完按它落本地分类。
    pub category: Option<String>,
    pub picture_url: Option<String>,
    /// 命中上次留下的同名文件，没有重新下载。
    pub reused: bool,
}

/// 下载指定文件到 `downloads` 目录，**不**安装。阻塞调用。
pub(crate) fn download_file(
    app: &AppHandle,
    store: &Store,
    mod_id: u64,
    file_id: u64,
    file_name_hint: Option<String>,
) -> AppResult<DownloadedFile> {
    let key = api_key(store)?;
    let client = client()?;
    let detail: ApiMod = get_json(
        &client,
        &key,
        &format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}.json"),
    )?;
    let files_raw: ApiFiles = get_json(
        &client,
        &key,
        &format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}/files.json"),
    )?;
    let file = files_raw
        .files
        .into_iter()
        .find(|item| item.file_id == file_id)
        .ok_or_else(|| {
            CommandError::new(
                "NEXUS_FILE_NOT_FOUND",
                "这个文件已经从 Nexus 上移除。请刷新文件列表后重试。",
            )
        })?;

    let display_name = if !file.file_name.trim().is_empty() {
        file.file_name.clone()
    } else if !file.name.trim().is_empty() {
        file.name.clone()
    } else {
        file_name_hint.unwrap_or_else(|| format!("nexus-{mod_id}-{file_id}.zip"))
    };
    let download_name = safe_download_name(mod_id, file_id, &display_name);
    let downloads_dir = store.data_dir.join("downloads");
    std::fs::create_dir_all(&downloads_dir)?;
    let target = downloads_dir.join(&download_name);

    let mut reused = false;
    if target.is_file() {
        if let Ok(meta) = std::fs::metadata(&target) {
            if meta.len() > 0 {
                reused = true;
            }
        }
    }

    if !reused {
        let links: Vec<ApiDownloadLink> = get_json(
            &client,
            &key,
            &format!(
                "{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}/files/{file_id}/download_link.json"
            ),
        )?;
        let link = links
            .into_iter()
            .find(|link| !link.uri.trim().is_empty())
            .ok_or_else(|| {
                CommandError::new(
                    "NEXUS_NO_DOWNLOAD",
                    "Nexus 没有返回下载地址。免费账号请打开模组页面用浏览器下载；\
                     启动器在拿到 ZIP 后会自动导入。",
                )
            })?;

        let response = client
            .get(&link.uri)
            .header("apikey", &key)
            .send()
            .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("下载连接失败：{e}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(api_error(status, &body));
        }
        let total = response.content_length();
        if let Some(total) = total {
            if total > MAX_DOWNLOAD_BYTES {
                return Err(CommandError::new(
                    "NEXUS_DOWNLOAD_TOO_LARGE",
                    "这个文件超过 8 GB，启动器拒绝下载。",
                ));
            }
        }
        let part = target.with_extension("part");
        let _ = std::fs::remove_file(&part);
        let mut output = std::fs::File::create(&part)
            .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("无法创建下载文件：{e}")))?;
        let mut response = response;
        let mut received: u64 = 0;
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("下载中断：{e}")))?;
            if read == 0 {
                break;
            }
            received += read as u64;
            if received > MAX_DOWNLOAD_BYTES {
                let _ = std::fs::remove_file(&part);
                return Err(CommandError::new(
                    "NEXUS_DOWNLOAD_TOO_LARGE",
                    "下载超过 8 GB，已中止。",
                ));
            }
            output.write_all(&buffer[..read]).map_err(|e| {
                CommandError::new("NEXUS_DOWNLOAD", format!("写入下载文件失败：{e}"))
            })?;
            if received % (1024 * 1024) < 128 * 1024 {
                let _ = app.emit(
                    "nexus-download-progress",
                    DownloadProgress {
                        mod_id,
                        file_id,
                        received,
                        total,
                    },
                );
            }
        }
        output.flush().ok();
        drop(output);
        if received == 0 {
            let _ = std::fs::remove_file(&part);
            return Err(CommandError::new("NEXUS_DOWNLOAD_EMPTY", "下载到 0 字节，已中止。"));
        }
        if target.exists() {
            let _ = std::fs::remove_file(&target);
        }
        std::fs::rename(&part, &target)
            .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("无法完成下载文件：{e}")))?;
    }

    Ok(DownloadedFile {
        path: target,
        file_name: download_name,
        file_id,
        version: Some(detail.version.clone()).filter(|value| !value.trim().is_empty()),
        category: Some(detail.category_name.clone()).filter(|value| !value.trim().is_empty()),
        picture_url: detail.picture_url.clone(),
        reused,
    })
}

/// 下载这个 Mod 的「最新主文件」。
///
/// 选法：`category_name == MAIN` 的条目里取 `file_id` 最大的（Nexus 的 file_id
/// 单调递增，等价于最新上传）；一个 MAIN 都没有时退回全体 file_id 最大的那个。
/// 这样「可选补丁」「旧版本」不会被误当成更新源。
pub(crate) fn download_latest(app: &AppHandle, store: &Store, mod_id: u64) -> AppResult<DownloadedFile> {
    let key = api_key(store)?;
    let client = client()?;
    let files_raw: ApiFiles = get_json(
        &client,
        &key,
        &format!("{API_BASE}/games/{GAME_DOMAIN}/mods/{mod_id}/files.json"),
    )?;

    let newest = |only_main: bool| -> Option<(u64, String)> {
        files_raw
            .files
            .iter()
            .filter(|file| !only_main || file.category_name.eq_ignore_ascii_case("MAIN"))
            .max_by_key(|file| file.file_id)
            .map(|file| {
                let hint = if !file.file_name.trim().is_empty() {
                    file.file_name.clone()
                } else {
                    file.name.clone()
                };
                (file.file_id, hint)
            })
    };
    let (file_id, hint) = newest(true)
        .or_else(|| newest(false))
        .ok_or_else(|| {
            CommandError::new("NEXUS_NO_FILES", "这个模组在 Nexus 上没有任何文件可下载。")
        })?;
    download_file(app, store, mod_id, file_id, Some(hint))
}

/// 下载并安装一个新模组（首次安装路径）。阻塞调用。
pub fn download_and_install(
    app: &AppHandle,
    store: &Store,
    mod_id: u64,
    file_id: u64,
    file_name_hint: Option<String>,
) -> AppResult<NexusDownloadResult> {
    let downloaded = download_file(app, store, mod_id, file_id, file_name_hint)?;
    let nexus = NexusRef {
        mod_id,
        file_id: Some(downloaded.file_id),
        url: format!("https://www.nexusmods.com/{GAME_DOMAIN}/mods/{mod_id}"),
        version: downloaded.version.clone(),
        picture_url: downloaded.picture_url.clone(),
        latest_version: None,
        last_check: None,
    };
    let mut entry =
        installer::install_archive(store, &downloaded.path.to_string_lossy(), Some(nexus))?;
    // P6：安装时就按 Nexus 官方分类落位，而不是等下一次「补全信息」才纠正。
    if let Some(category) = downloaded.category.as_deref() {
        installer::apply_nexus_category(&mut entry, category);
    }
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        data.mods.push(entry.clone());
        if let Err(err) = store.save(&data) {
            // Keep the staging directory; it is harmless and the user can retry.
            return Err(err);
        }
    }

    Ok(NexusDownloadResult {
        outcome: InstallOutcome {
            path: downloaded.path.to_string_lossy().to_string(),
            success: true,
            mod_entry: Some(entry),
            error: None,
            error_code: None,
        },
        file_name: downloaded.file_name,
        path: downloaded.path.to_string_lossy().to_string(),
        reused: downloaded.reused,
    })
}

pub fn prune_downloads(store: &Store, days: u64) -> usize {
    let dir = store.data_dir.join("downloads");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(days.saturating_mul(86_400)))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if modified < cutoff {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}
