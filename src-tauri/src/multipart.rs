//! 分片并发下载。
//!
//! 为什么需要：同一链路实测**单连接 107 KB/s、4 连接 451 KB/s**（4.2 倍）——
//! 瓶颈是按连接限速，不是总带宽。Nexus 的 `.archive` 动辄几百 MB，单连接在慢速
//! 链路上要几十分钟，界面上就表现为「一直卡着」。
//!
//! 与 `download_queue` 的单连接续传不是替代关系：那条路走 `.part` + `Range`，
//! 适合小文件和「服务端不支持 Range」的情况；这里按段落盘，断了之后**已完成的
//! 段不用重下**，代价是多几个临时文件。

use crate::schema::{AppResult, CommandError};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// 小于这个尺寸不值得分片：线程与请求开销会盖过收益。
pub const MIN_MULTIPART_BYTES: u64 = 4 * 1024 * 1024;
/// 单段至少这么大，避免切出几十个碎请求。
const MIN_SEGMENT_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_SEGMENTS: u32 = 8;

/// 服务端忽略 `Range`（回 200）时用这个 code 告诉调用方「回退单连接」。
pub const CODE_UNSUPPORTED: &str = "MULTIPART_UNSUPPORTED";
/// 用户/上层主动中止。
pub const CODE_CANCELLED: &str = "MULTIPART_CANCELLED";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentPlan {
    pub index: u32,
    pub start: u64,
    /// 含端点。
    pub end: u64,
}

impl SegmentPlan {
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start) + 1
    }
}

/// 纯函数：把 total 字节切成至多 `requested` 段。
///
/// 段数同时受「每段不小于 2 MB」限制——否则 8 MB 的文件会被切成 8 个 1 MB 请求，
/// 握手开销比下载还大。
pub fn plan_segments(total: u64, requested: u32) -> Vec<SegmentPlan> {
    if total == 0 {
        return Vec::new();
    }
    if total < MIN_MULTIPART_BYTES {
        return vec![SegmentPlan {
            index: 0,
            start: 0,
            end: total - 1,
        }];
    }
    let hard_cap = (total / MIN_SEGMENT_BYTES).max(1) as u32;
    let count = requested.clamp(1, MAX_SEGMENTS).min(hard_cap).max(1);
    if count <= 1 {
        return vec![SegmentPlan {
            index: 0,
            start: 0,
            end: total - 1,
        }];
    }
    let base = total / count as u64;
    let mut out = Vec::with_capacity(count as usize);
    let mut start = 0u64;
    for index in 0..count {
        let end = if index + 1 == count {
            total - 1
        } else {
            start + base - 1
        };
        out.push(SegmentPlan { index, start, end });
        start = end + 1;
    }
    out
}

fn segment_path(part: &Path, index: u32) -> PathBuf {
    PathBuf::from(format!("{}.seg{}", part.display(), index))
}

/// 分片下载到 `part`（调用方负责之后的 rename）。
///
/// - `on_progress(已下载字节, 总字节)` 由监视线程每 250 ms 调一次；
/// - `cancelled` 与内部的 abort 任一为真都会让所有段尽快退出；
/// - 已存在且长度正确的 `.segN` 视为已完成（**段级续传**），不重下。
pub fn download_multipart<F>(
    client: &Client,
    uri: &str,
    api_key: Option<&str>,
    part: &Path,
    total: u64,
    requested_segments: u32,
    cancelled: &AtomicBool,
    on_progress: F,
) -> AppResult<()>
where
    F: Fn(u64, Option<u64>) + Sync + Send,
{
    let plan = plan_segments(total, requested_segments);
    if plan.len() <= 1 {
        return Err(CommandError::new(CODE_UNSUPPORTED, "文件太小，不走分片"));
    }

    // 段级续传：长度对得上的段直接算完成。
    let mut already = 0u64;
    let mut todo: Vec<SegmentPlan> = Vec::new();
    for segment in &plan {
        let path = segment_path(part, segment.index);
        let complete = std::fs::metadata(&path)
            .map(|meta| meta.len() == segment.len())
            .unwrap_or(false);
        if complete {
            already += segment.len();
        } else {
            let _ = std::fs::remove_file(&path);
            todo.push(*segment);
        }
    }
    if already > 0 {
        on_progress(already, Some(total));
    }

    let received = Arc::new(AtomicU64::new(already));
    let done = Arc::new(AtomicU64::new(0));
    let abort = Arc::new(AtomicBool::new(false));
    let unsupported = Arc::new(AtomicBool::new(false));
    let failure: std::sync::Mutex<Option<CommandError>> = std::sync::Mutex::new(None);
    let todo_len = todo.len();

    if todo_len > 0 {
        let todo_ref = &todo;
        let failure_ref = &failure;
        let received_ref = &received;
        let done_ref = &done;
        let abort_ref = &abort;
        let unsupported_ref = &unsupported;
        std::thread::scope(|scope| {
            for segment in todo_ref {
                let received = Arc::clone(received_ref);
                let done = Arc::clone(done_ref);
                let abort = Arc::clone(abort_ref);
                let unsupported = Arc::clone(unsupported_ref);
                scope.spawn(move || {
                    match fetch_segment(
                        client, uri, api_key, part, *segment, &received, cancelled, &abort,
                    ) {
                        Ok(()) => {
                            done.fetch_add(1, Ordering::SeqCst);
                        }
                        Err(err) => {
                            if err.code == CODE_UNSUPPORTED {
                                unsupported.store(true, Ordering::SeqCst);
                            }
                            if err.code != CODE_CANCELLED {
                                let mut slot =
                                    failure_ref.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                                if slot.is_none() {
                                    *slot = Some(err);
                                }
                            }
                            abort.store(true, Ordering::SeqCst);
                        }
                    }
                });
            }
            // 监视线程：各段的字节数汇总在 received 里，统一对外上报。
            scope.spawn(move || loop {
                on_progress(received_ref.load(Ordering::SeqCst), Some(total));
                if done_ref.load(Ordering::SeqCst) >= todo_len as u64
                    || abort_ref.load(Ordering::SeqCst)
                    || cancelled.load(Ordering::SeqCst)
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            });
        });
    }

    if let Some(err) = failure
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        return Err(err);
    }
    if unsupported.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            CODE_UNSUPPORTED,
            "服务端不支持分段下载（需要 Range 支持）",
        ));
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err(CommandError::new(CODE_CANCELLED, "下载已取消"));
    }

    merge_segments(part, &plan)?;
    Ok(())
}

fn fetch_segment(
    client: &Client,
    uri: &str,
    api_key: Option<&str>,
    part: &Path,
    segment: SegmentPlan,
    received: &AtomicU64,
    cancelled: &AtomicBool,
    abort: &AtomicBool,
) -> AppResult<()> {
    let mut request = client
        .get(uri)
        .header("Range", format!("bytes={}-{}", segment.start, segment.end));
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        request = request.header("apikey", key);
    }
    let mut response = request
        .send()
        .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("分段连接失败：{e}")))?;
    if response.status() == StatusCode::PARTIAL_CONTENT {
        // 正常路径。
    } else if response.status().is_success() {
        // 200 = 服务端忽略了 Range，只能回退单连接。
        return Err(CommandError::new(CODE_UNSUPPORTED, "服务端未返回 206"));
    } else {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(CommandError::new(
            "NEXUS_DOWNLOAD",
            format!("分段下载失败（{status}）：{}", body.chars().take(120).collect::<String>()),
        ));
    }

    let path = segment_path(part, segment.index);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("无法写入分段文件：{e}")))?;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        // 批量更新的暂停/取消也要能作用到分片下载：gate 在暂停时会阻塞在这里。
        if cancelled.load(Ordering::SeqCst)
            || abort.load(Ordering::SeqCst)
            || crate::updates::download_gate()
        {
            return Err(CommandError::new(CODE_CANCELLED, "下载已取消"));
        }
        let read = response
            .read(&mut buffer)
            .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("分段下载中断：{e}")))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("写入分段失败：{e}")))?;
        received.fetch_add(read as u64, Ordering::SeqCst);
    }
    file.flush().ok();

    let written = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if written != segment.len() {
        let _ = std::fs::remove_file(&path);
        return Err(CommandError::new(
            "NEXUS_DOWNLOAD",
            format!(
                "分段不完整：期望 {} 字节，实际 {written} 字节",
                segment.len()
            ),
        ));
    }
    Ok(())
}

fn merge_segments(part: &Path, plan: &[SegmentPlan]) -> AppResult<()> {
    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(part)
        .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("无法合并分段：{e}")))?;
    for segment in plan {
        let path = segment_path(part, segment.index);
        let mut input = std::fs::File::open(&path).map_err(|e| {
            CommandError::new("NEXUS_DOWNLOAD", format!("分段文件缺失：{e}"))
        })?;
        std::io::copy(&mut input, &mut output)
            .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("合并分段失败：{e}")))?;
    }
    output
        .flush()
        .map_err(|e| CommandError::new("NEXUS_DOWNLOAD", format!("合并落盘失败：{e}")))?;
    drop(output);
    for segment in plan {
        let _ = std::fs::remove_file(segment_path(part, segment.index));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_files_stay_single_segment() {
        let plan = plan_segments(1024, 8);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].start, 0);
        assert_eq!(plan[0].end, 1023);
    }

    #[test]
    fn splits_cover_every_byte_exactly_once() {
        let total = 100 * 1024 * 1024;
        let plan = plan_segments(total, 4);
        assert_eq!(plan.len(), 4);
        assert_eq!(plan[0].start, 0);
        assert_eq!(plan[plan.len() - 1].end, total - 1);
        let mut expected = 0u64;
        for segment in &plan {
            assert_eq!(segment.start, expected);
            expected = segment.end + 1;
        }
        assert_eq!(plan.iter().map(|seg| seg.len()).sum::<u64>(), total);
    }

    #[test]
    fn segment_count_respects_minimum_size() {
        // 5 MB 最多切 2 段（每段 ≥ 2 MB），不能因为用户要 8 段就切 8 份。
        assert_eq!(plan_segments(5 * 1024 * 1024, 8).len(), 2);
        // 1 GB 可以按请求切成 8 段。
        assert_eq!(plan_segments(1024 * 1024 * 1024, 8).len(), 8);
    }

    #[test]
    fn requested_count_is_clamped() {
        assert_eq!(plan_segments(64 * 1024 * 1024, 0).len(), 1);
        assert_eq!(plan_segments(64 * 1024 * 1024, 999).len(), MAX_SEGMENTS as usize);
    }

    #[test]
    fn zero_length_has_no_segments() {
        assert!(plan_segments(0, 4).is_empty());
    }
}
