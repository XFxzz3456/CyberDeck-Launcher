//! 封面图本地缓存。
//!
//! 背景：库里的封面有两套来源——① 模组压缩包里自带的图片（`ModEntry.cover_path`，
//! 安装时由 `installer::find_cover` 找到）；② Nexus 官方封面（`nexus_cover_url`，
//! 一个 `https://staticdelivery.nexusmods.com/...` 地址）。前者只有少数模组有，
//! 后者需要联网。
//!
//! 用户反馈「有些 mod 还是不会显示封面，而 Vortex 基本都能显示」——差别就在
//! Vortex 会把 N 网封面**下载到本地缓存**，之后直接读磁盘；而我们一直是把远程
//! URL 塞进 `<img src>`，每渲染一次就发一次请求：CDN 慢、被墙、图片 404，都会
//! 变成一张空白（前端 `onError` 只能把 img 藏掉，露出下面的生成图）。
//!
//! 所以这里把「远程地址」变成「本地文件」：
//! - 文件名由 URL 的 FNV-1a 64 位散列决定，同一个 URL 永远映射到同一个文件，
//!   不需要额外的索引表，重启后照样能找到；
//! - 落盘走 `.part` + rename，避免半张图被当成缓存；
//! - 只在自己的 `covers/` 子目录里读写，清理时按文件名白名单删，不递归、不删别的。
//!
//! 缓存路径回填进 `ModEntry.cover_cache_path`（持久化），前端三级回落：
//! 包内封面 → 缓存封面 → 生成图。远程 URL 只在既没缓存也没包内封面时兜底。

use crate::schema::{AppResult, AppStateData, CommandError};
use crate::store::Store;
use reqwest::blocking::Client;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// 缓存子目录（相对数据目录）。放在 `$APPDATA/**` 下，已在 assetProtocol 作用域内。
const CACHE_SUBDIR: &str = "covers";
/// 单张图上限。N 网封面最大也就几百 KB，超过基本是错误页或盗链页。
const MAX_IMAGE_BYTES: u64 = 6 * 1024 * 1024;
/// 允许落盘的扩展名。清理时也用这张表判断「是不是我们的文件」。
const EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "webp", "gif", "avif"];
const USER_AGENT: &str = "CyberDeckLauncher/1.7.0 (Tauri; Windows; Cover-Cache)";
/// 连续失败到这个数就收手。断网 / CDN 被墙时每张都要等超时，
/// 183 张按 4 并发硬跑能拖十几分钟，必须有个断路器。
/// 注意口径是「连续」：中间成功一张就清零，个别图 404 不会误伤整批。
const ABORT_AFTER_FAILURES: usize = 8;

pub fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(CACHE_SUBDIR)
}

/// URL → 缓存文件名。
///
/// 不用 mod id 命名：同一个 mod 换了封面图（URL 变了）应该拿到新文件，用 id 会把
/// 旧图一直贴回去。反过来 URL 不变就永远命中同一个文件，天然去重。
fn stem_for(url: &str) -> String {
    // FNV-1a 64：实现只有几行，跨版本稳定；标准库的 DefaultHasher 明确不保证稳定。
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 从 URL 里取扩展名；查询串、锚点先切掉，认不出就按 jpg 存。
fn extension_of(url: &str) -> &'static str {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    EXTENSIONS
        .iter()
        .copied()
        .find(|known| *known == ext)
        .unwrap_or("jpg")
}

/// 判断某个文件名是不是本模块写出来的（清理时只删这些）。
fn is_cache_file(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 16
        && stem.chars().all(|c| c.is_ascii_hexdigit())
        && EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext))
}

/// 某个 URL 在本机**已经**缓存到哪个文件（扩展名以实际落盘时为准）。
///
/// 为什么不直接按 URL 拼路径：CDN 会对图片做格式转换——地址写 `.png`、
/// 返回 `Content-Type: image/webp` 是常态。落盘时按真实 MIME 定扩展名，
/// 查找时就要按 stem 扫一遍，否则永远命中不了。
fn existing_for(data_dir: &Path, url: &str) -> Option<PathBuf> {
    let stem = stem_for(url);
    let dir = cache_dir(data_dir);
    let preferred = dir.join(format!("{stem}.{}", extension_of(url)));
    if preferred.is_file() {
        return Some(preferred);
    }
    EXTENSIONS.iter().map(|ext| dir.join(format!("{stem}.{ext}"))).find(|path| path.is_file())
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheStats {
    /// 磁盘上实际的缓存文件数。
    pub count: usize,
    /// 占用字节数。
    pub bytes: u64,
    /// 缓存目录绝对路径（前端展示 + 「打开文件夹」用）。
    pub dir: String,
    /// 有 Nexus 封面地址、但还没缓存的模组数。
    pub pending: usize,
    /// 已经能显示封面的模组数（包内封面 + 缓存命中，去重前先按条数算）。
    pub cached: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheReport {
    pub downloaded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub stats: CoverCacheStats,
}

fn io_error(action: &str, path: &Path, err: std::io::Error) -> CommandError {
    CommandError::new(
        "COVER_CACHE_IO",
        format!("{action}失败：{}（{err}）", path.display()),
    )
}

/// 扫描缓存目录，统计文件数与占用。
fn scan(dir: &Path) -> (usize, u64) {
    let mut count = 0;
    let mut bytes = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_cache_file(&name) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                count += 1;
                bytes += meta.len();
            }
        }
    }
    (count, bytes)
}

/// 把「已经缓存好的封面」回填进内存里的 `cover_cache_path`。
///
/// 启动时跑一次即可（每个模组一次 `stat`，251 个模组也就几毫秒）：既让前端拿到
/// 路径，也顺手把「文件被用户手动删了」的残留路径清掉。
pub fn refresh_paths(data: &mut AppStateData, data_dir: &Path) {
    for entry in data.mods.iter_mut() {
        entry.cover_cache_path = resolve_cached(entry.nexus_cover_url.as_deref(), data_dir);
    }
}

/// 给定远程地址，算出「本机是否已有这张图的缓存」。
///
/// 文件不存在时返回 None 而不是那个不存在的路径——前端拿到的路径必须能直接渲染，
/// 否则每张图都要先 404 一次再回落，控制台一片红。
fn resolve_cached(url: Option<&str>, data_dir: &Path) -> Option<String> {
    let url = url.map(str::trim).filter(|url| !url.is_empty())?;
    existing_for(data_dir, url).map(|path| path.to_string_lossy().to_string())
}

pub fn stats(store: &Store) -> CoverCacheStats {
    let (count, bytes) = scan(&cache_dir(&store.data_dir));
    let data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut pending = 0;
    let mut cached = 0;
    for entry in data.mods.iter() {
        let has_remote = entry
            .nexus_cover_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|url| !url.is_empty());
        let has_cache = entry
            .cover_cache_path
            .as_deref()
            .is_some_and(|path| Path::new(path).is_file());
        if has_cache || entry.cover_path.is_some() {
            cached += 1;
        } else if has_remote {
            pending += 1;
        }
    }
    CoverCacheStats {
        count,
        bytes,
        dir: cache_dir(&store.data_dir).to_string_lossy().to_string(),
        pending,
        cached,
    }
}

/// 清空封面缓存：只删 `covers/` 下符合命名规则的文件，并把模组上的缓存路径抹掉。
pub fn clear(store: &Store) -> AppResult<CoverCacheStats> {
    let dir = cache_dir(&store.data_dir);
    if dir.is_dir() {
        let entries = fs::read_dir(&dir).map_err(|err| io_error("读取缓存目录", &dir, err))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // 只认自己写出来的名字；`__probe.tmp`、用户扔进去的说明文件一律不动。
            let temporary = name.ends_with(".part") && is_cache_file(&name[..name.len() - 5]);
            if !is_cache_file(&name) && !temporary {
                continue;
            }
            // 删不掉就跳过（可能正被杀毒/索引占用），下次清理会再试一次。
            let _ = fs::remove_file(entry.path());
        }
    }
    {
        let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if data.mods.iter().any(|entry| entry.cover_cache_path.is_some()) {
            for entry in data.mods.iter_mut() {
                entry.cover_cache_path = None;
            }
            store.save(&data)?;
        }
    }
    Ok(stats(store))
}

struct Job {
    id: String,
    url: String,
    /// 缓存目录（`covers/`），最终文件名 = `<stem>.<真实 MIME 扩展名>`。
    dir: PathBuf,
    stem: String,
}

/// `image/webp` → `webp`；不在白名单里就退回 URL 上的扩展名。
fn extension_from_mime(content_type: &str, url: &str) -> &'static str {
    let mime = content_type.split(';').next().unwrap_or("").trim();
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        _ => extension_of(url),
    }
}

fn client() -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        // N 网图片 CDN 会按 UA/Referer 做防盗链，这里只带 UA，不带 Referer：
        // 带了反而会被当成盗链站点。
        .build()
        .map_err(|err| CommandError::new("COVER_HTTP", format!("无法创建网络客户端：{err}")))
}

/// 下载单张封面并落盘。返回写入的字节数。
fn download(client: &Client, job: &Job) -> Result<(PathBuf, u64), String> {
    if !(job.url.starts_with("https://") || job.url.starts_with("http://")) {
        return Err("封面地址不是 http(s)".to_string());
    }
    let response = client
        .get(&job.url)
        .send()
        .map_err(|err| format!("请求失败：{err}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    // 有些错误页会以 200 返回 HTML，光看状态码会把一张网页存成 .jpg。
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.starts_with("image/") {
        return Err(format!("返回的不是图片（{content_type}）"));
    }
    if response.content_length().is_some_and(|len| len > MAX_IMAGE_BYTES) {
        return Err("图片超过 6 MB".to_string());
    }
    let bytes = response.bytes().map_err(|err| format!("读取响应失败：{err}"))?;
    if bytes.is_empty() {
        return Err("响应为空".to_string());
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 6 MB".to_string());
    }
    fs::create_dir_all(&job.dir).map_err(|err| format!("建目录失败：{err}"))?;
    // 扩展名按真实 MIME：CDN 会把 .png 转成 webp 返回，按 URL 后缀存会让
    // asset 协议报错 mime，也让人以后误以为目录里全是 png。
    let ext = extension_from_mime(&content_type, &job.url);
    let path = job.dir.join(format!("{}.{ext}", job.stem));
    // 先写 .part 再 rename：中途失败留下的半张图不会被当成缓存命中。
    let temporary = job.dir.join(format!("{}.{ext}.part", job.stem));
    fs::write(&temporary, &bytes).map_err(|err| format!("写文件失败：{err}"))?;
    fs::rename(&temporary, &path).map_err(|err| {
        let _ = fs::remove_file(&temporary);
        format!("落盘失败：{err}")
    })?;
    Ok((path, bytes.len() as u64))
}

/// 把还没缓存的封面抓下来。
///
/// `ids` 为 `None` 表示「全库补全」；给了 `ids` 就只补这几个（右键「补这张封面」用）。
/// 并发 4：CDN 不是 API，没有 Nexus 那套速率限制，但也没必要开太多——每张就几十 KB，
/// 串行 100 张要半分多钟，4 并发刚好在 10 秒内。
pub fn fill(store: &Store, ids: Option<Vec<String>>) -> AppResult<CoverCacheReport> {
    let filter: Option<std::collections::HashSet<String>> =
        ids.map(|list| list.into_iter().collect());
    let mut jobs: Vec<Job> = Vec::new();
    let mut skipped = 0usize;
    {
        let data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in data.mods.iter() {
            if let Some(filter) = filter.as_ref() {
                if !filter.contains(&entry.id) {
                    skipped += 1;
                    continue;
                }
            }
            let url = entry
                .nexus_cover_url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty());
            let Some(url) = url else {
                skipped += 1;
                continue;
            };
            if existing_for(&store.data_dir, url).is_some() {
                skipped += 1;
                continue;
            }
            jobs.push(Job {
                id: entry.id.clone(),
                url: url.to_string(),
                dir: cache_dir(&store.data_dir),
                stem: stem_for(url),
            });
        }
    }

    let mut report = CoverCacheReport {
        skipped,
        ..Default::default()
    };
    if !jobs.is_empty() {
        let client = client()?;
        let cursor = AtomicUsize::new(0);
        let done: Mutex<Vec<(String, PathBuf, u64)>> = Mutex::new(Vec::new());
        let failures = AtomicUsize::new(0);
        let consecutive = AtomicUsize::new(0);
        let aborted = AtomicBool::new(false);
        let workers = 4.min(jobs.len());

        // scope 让线程借到 jobs / done，省一次 Arc<Vec> 克隆。
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    if aborted.load(Ordering::Relaxed) {
                        break;
                    }
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(job) = jobs.get(index) else { break };
                    match download(&client, job) {
                        Ok((path, bytes)) => {
                            consecutive.store(0, Ordering::Relaxed);
                            done.lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .push((job.id.clone(), path, bytes));
                        }
                        Err(_) => {
                            failures.fetch_add(1, Ordering::Relaxed);
                            if consecutive.fetch_add(1, Ordering::Relaxed) + 1 >= ABORT_AFTER_FAILURES {
                                aborted.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                });
            }
        });

        let finished = done.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
        report.failed = failures.load(Ordering::Relaxed);
        report.downloaded = finished.len();
        report.bytes = finished.iter().map(|(_, _, bytes)| *bytes).sum();
        if !finished.is_empty() {
            let mut data = store.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            for (id, path, _) in finished.iter() {
                // 下载期间库可能被改过（正好卸掉一个 Mod），按 id 核对再写。
                if let Some(entry) = data.mods.iter_mut().find(|entry| &entry.id == id) {
                    entry.cover_cache_path = Some(path.to_string_lossy().to_string());
                }
            }
            store.save(&data)?;
        }
    }
    report.stats = stats(store);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_url_always_maps_to_the_same_stem() {
        let url = "https://staticdelivery.nexusmods.com/mods/109/images/thumbnails/1/1-1-2.jpg";
        assert_eq!(stem_for(url), stem_for(url));
        assert_eq!(stem_for(url).len(), 16);
        // 换了封面图（URL 变了）必须落到新文件，否则旧图会一直贴回去。
        assert_ne!(stem_for(url), stem_for(&format!("{url}?v=2")));
    }

    #[test]
    fn mime_decides_the_stored_extension() {
        let url = "https://a/b.png";
        // CDN 会把 png 转成 webp 返回，落盘按真实 MIME 走。
        assert_eq!(extension_from_mime("image/webp", url), "webp");
        assert_eq!(extension_from_mime("image/jpeg; charset=binary", url), "jpg");
        // 认不出的 MIME 退回归属 URL 的后缀。
        assert_eq!(extension_from_mime("application/octet-stream", url), "png");
    }

    #[test]
    fn extension_falls_back_and_ignores_query() {
        assert_eq!(extension_of("https://a/b.webp"), "webp");
        assert_eq!(extension_of("https://a/b.PNG?w=200"), "png");
        assert_eq!(extension_of("https://a/b"), "jpg");
        // 白名单外的一律按 jpg 存，免得在网络层异常时写出奇怪后缀的文件。
        assert_eq!(extension_of("https://a/b.exe"), "jpg");
    }

    #[test]
    fn only_own_files_are_considered_cache() {
        assert!(is_cache_file("0123456789abcdef.jpg"));
        assert!(is_cache_file("0123456789abcdef.webp"));
        assert!(!is_cache_file("0123456789abcde.jpg"));
        assert!(!is_cache_file("0123456789abcdef.exe"));
        assert!(!is_cache_file("zzzzzzzzzzzzzzzz.jpg"));
        assert!(!is_cache_file("cover.jpg"));
    }

    #[test]
    fn resolve_cached_needs_a_real_file_on_disk() {
        let root = std::env::temp_dir().join(format!("cyberdeck-covers-{}", std::process::id()));
        let dir = cache_dir(&root);
        fs::create_dir_all(&dir).expect("mkdir");
        let url = "https://staticdelivery.nexusmods.com/mods/109/images/1.jpg";
        // 注意这里刻意用 .webp 落盘：URL 是 .png，但 CDN 返回 webp，
        // 能命中就说明「按 stem 扫一遍」的逻辑是有效的。
        let expected = cache_dir(&root).join(format!("{}.webp", stem_for(url)));

        // 还没下载：不能凭空给出一个不存在的路径。
        assert_eq!(resolve_cached(Some(url), &root), None);
        assert_eq!(resolve_cached(Some(""), &root), None);
        assert_eq!(resolve_cached(None, &root), None);

        fs::write(&expected, b"img").expect("write");
        assert_eq!(
            resolve_cached(Some(url), &root).as_deref(),
            Some(expected.to_string_lossy().to_string().as_str())
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_counts_only_cache_files() {
        let root = std::env::temp_dir().join(format!("cyberdeck-scan-{}", std::process::id()));
        let dir = cache_dir(&root);
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join("0123456789abcdef.jpg"), b"12345").expect("write");
        fs::write(dir.join("notes.txt"), b"ignore me").expect("write");
        assert_eq!(scan(&dir), (1, 5));
        let _ = fs::remove_dir_all(&root);
    }
}
