//! 既有模组收编（Adopt）：把外部工具（Vortex / 手动）部署在 archive/pc/mod 下的
//! 未受管 archive（+ 同词干 .xl/.xlp）就地登记进启动器。
//!
//! 安全模型：
//! - 收编**永不**改动游戏目录文件、不写 modlist.txt、不碰 Vortex、不走 deploy_mod；
//! - 暂存侧只新增：同卷用硬链接做「反向链接」（暂存文件 = 游戏文件的另一目录项），
//!   跨卷或硬链接失败时如实复制并记录 Copy；
//! - 与 undeploy 的 same_file_identity 校验天然兼容：硬链接收编后禁用/卸载
//!   走既有 installer::undeploy_mod，重新启用走 deploy_mod 从暂存重建。
//!
//! 锁纪律（硬约束，见 profiles.rs 头注释）：绝不持 store.data 锁做磁盘 IO。
//! 每个模组三段式：无锁建暂存+验证 → 短锁登记（push+save）→ 锁外 emit 进度。

use crate::game::same_volume;
use crate::installer::file_stamp;
use crate::schema::{
    AdoptCandidate, AdoptError, AdoptFileRef, AdoptOutcome, AdoptProgress, AdoptReport,
    AdoptScanReport, AppResult, CommandError, DeployedFile, InstallLayout, LinkType, ModEntry,
};
use crate::store::{is_within, now_iso, safe_join, Store};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// 收编取消旗标。execute 结束（无论成败）都会复位，避免一次取消毒死后续批次。
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// 诊断/前端发起取消。
pub fn request_cancel() -> bool {
    CANCELLED.swap(true, Ordering::SeqCst)
}

fn cancelled() -> bool {
    CANCELLED.load(Ordering::SeqCst)
}

/// FNV-1a 64：零新依赖的稳定哈希。收编 id = "adopt-<hex>"，
/// 同一路径重复扫描得到同一 id，天然去重。
fn fnv1a64(data: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 由游戏内相对路径推导稳定候选 id。
pub fn candidate_id(rel: &str) -> String {
    format!("adopt-{:016x}", fnv1a64(&rel.to_ascii_lowercase()))
}

/// id 必须长成我们生成的样子：防止前端借 id 在暂存区里注入任意目录名。
fn valid_candidate_id(id: &str) -> bool {
    let body = id.strip_prefix("adopt-").unwrap_or_default();
    body.len() == 16 && body.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 暂存方式选择：Auto = 同卷硬链接、否则复制；Copy = 强制复制（仅测试注入用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializeMode {
    Auto,
    #[allow(dead_code)] // 主流程只用 Auto；Copy 由 adopt_tests 注入跨卷路径。
    Copy,
}

/// 在暂存区建立指向游戏文件的副本/反向链接。
///
/// 注意：这里**不调用** installer::create_link —— 收编方向相反
/// （游戏文件 → 暂存），且失败时必须如实落 Copy 而不是尝试符号链接。
pub fn materialize(source: &Path, target: &Path, mode: MaterializeMode) -> AppResult<LinkType> {
    if !source.is_file() {
        return Err(CommandError::new(
            "ADOPT_STAGING_FAILED",
            format!("游戏侧文件不存在或不可读：{}", source.display()),
        ));
    }
    if target.exists() {
        return Err(CommandError::new(
            "ADOPT_STAGING_FAILED",
            format!("暂存区已存在同名文件：{}", target.display()),
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if mode == MaterializeMode::Auto && same_volume(source, target) {
        match fs::hard_link(source, target) {
            Ok(()) => return Ok(LinkType::HardLink),
            // 硬链接可能被 ACL / 文件系统特性拒绝：如实降级为复制。
            Err(err) => eprintln!("adopt hard_link failed for {}: {err}", target.display()),
        }
    }
    fs::copy(source, target).map_err(|e| {
        CommandError::new(
            "ADOPT_STAGING_FAILED",
            format!("无法把游戏文件复制进暂存区：{e}"),
        )
    })?;
    Ok(LinkType::Copy)
}

/// 验证暂存副本可信：大小一致；硬链接还必须与游戏文件同 identity。
/// 验证通过前不会改动任何原始文件 —— 这是「就地收编」的承诺。
pub fn verify_copy(source: &Path, target: &Path, link_type: LinkType) -> AppResult<()> {
    let source_meta = fs::metadata(source).map_err(|e| {
        CommandError::new(
            "ADOPT_VERIFY_FAILED",
            format!("无法读取游戏侧文件：{e}"),
        )
    })?;
    let staging_meta = fs::metadata(target).map_err(|e| {
        CommandError::new("ADOPT_VERIFY_FAILED", format!("无法读取暂存副本：{e}"))
    })?;
    if source_meta.len() != staging_meta.len() {
        return Err(CommandError::new(
            "ADOPT_VERIFY_FAILED",
            format!(
                "大小不一致：游戏侧 {} 字节、暂存 {} 字节。",
                source_meta.len(),
                staging_meta.len()
            ),
        ));
    }
    if link_type == LinkType::HardLink && !crate::installer::same_file_identity(source, target) {
        return Err(CommandError::new(
            "ADOPT_VERIFY_FAILED",
            "暂存反向链接与游戏文件不是同一份文件，硬链接已失效。",
        ));
    }
    Ok(())
}

/// 扫描 archive/pc/mod 下的未受管 archive / 独立 .xl，产出收编候选。
///
/// 分组规则：1 个 .archive = 1 个候选，同词干 .xl/.xlp 跟随；
/// 无配对 archive 的独立 .xl 独立成候选；modlist.txt 永不入候选。
pub fn scan(store: &Store) -> AppResult<AdoptScanReport> {
    let state = store.snapshot_data();
    let Some(game_dir) = state.game_dir.clone() else {
        return Err(CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有定位游戏目录，无法扫描可收编的模组。",
        ));
    };
    let game_root = PathBuf::from(&game_dir);
    let archive_dir = game_root.join("archive").join("pc").join("mod");
    let staging_dir = store.staging_dir();

    // 已被库内条目占有的目标：部署清单 + planned 缓存，两者都算。
    let mut managed: HashSet<String> = HashSet::new();
    for entry in &state.mods {
        for file in &entry.deployed_files {
            managed.insert(file.relative_path.to_ascii_lowercase());
        }
        for planned in &entry.planned_files {
            managed.insert(planned.to_ascii_lowercase());
        }
    }

    struct RawFile {
        name: String,
        stem_lower: String,
        ext: String,
        rel: String,
    }
    let mut archives: Vec<RawFile> = Vec::new();
    let mut companions: Vec<RawFile> = Vec::new();

    if archive_dir.is_dir() {
        let entries = fs::read_dir(&archive_dir)
            .map_err(|e| CommandError::new("ARCHIVE_DIR", format!("无法读取游戏 archive 目录：{e}")))?;
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            let ext = lower.rsplit('.').next().unwrap_or_default().to_string();
            if !matches!(ext.as_str(), "archive" | "xl" | "xlp") {
                // modlist.txt 等其它文件永不入候选。
                continue;
            }
            let stem_lower = lower
                .strip_suffix(&format!(".{ext}"))
                .unwrap_or(lower.as_str())
                .to_string();
            let raw = RawFile {
                name: name.clone(),
                stem_lower,
                ext,
                rel: format!("archive/pc/mod/{name}"),
            };
            if raw.ext == "archive" {
                archives.push(raw);
            } else {
                companions.push(raw);
            }
        }
    }

    let mut candidates: Vec<AdoptCandidate> = Vec::new();
    let mut used_companions: HashSet<String> = HashSet::new();

    for archive in &archives {
        let mut files = Vec::new();
        files.push(file_ref(&game_root, &archive.rel));
        for companion in companions
            .iter()
            .filter(|item| item.stem_lower == archive.stem_lower)
        {
            files.push(file_ref(&game_root, &companion.rel));
            used_companions.insert(companion.name.clone());
        }
        let size_bytes = files.iter().map(|file| file.size_bytes).sum();
        let already = files
            .iter()
            .any(|file| managed.contains(&file.rel.to_ascii_lowercase()));
        let main_path = game_root.join(&archive.rel.replace('/', "\\"));
        candidates.push(AdoptCandidate {
            id: candidate_id(&archive.rel),
            name: archive.stem_lower.clone(),
            archive_rel: archive.rel.clone(),
            files,
            size_bytes,
            link_type: if same_volume(&main_path, &staging_dir) {
                LinkType::HardLink
            } else {
                LinkType::Copy
            },
            already_managed: already,
        });
    }

    // 没有配对 archive 的独立 .xl / .xlp：独立成候选。
    for companion in &companions {
        if used_companions.contains(&companion.name) {
            continue;
        }
        let files = vec![file_ref(&game_root, &companion.rel)];
        let size_bytes = files.iter().map(|file| file.size_bytes).sum();
        let already = managed.contains(&companion.rel.to_ascii_lowercase());
        let main_path = game_root.join(&companion.rel.replace('/', "\\"));
        candidates.push(AdoptCandidate {
            id: candidate_id(&companion.rel),
            name: companion.stem_lower.clone(),
            archive_rel: companion.rel.clone(),
            files,
            size_bytes,
            link_type: if same_volume(&main_path, &staging_dir) {
                LinkType::HardLink
            } else {
                LinkType::Copy
            },
            already_managed: already,
        });
    }

    candidates.sort_by(|left, right| left.name.cmp(&right.name));
    let total_bytes = candidates.iter().map(|item| item.size_bytes).sum();
    let cross_volume = !same_volume(&archive_dir, &staging_dir);
    let copy_bytes = candidates
        .iter()
        .filter(|item| item.link_type == LinkType::Copy)
        .map(|item| item.size_bytes)
        .sum();

    Ok(AdoptScanReport {
        candidates,
        total_bytes,
        copy_bytes,
        cross_volume,
        archive_dir: archive_dir.to_string_lossy().to_string(),
    })
}

/// 读取游戏侧文件的引用（大小/时间来自真实文件，供执行期二次校验）。
fn file_ref(game_root: &Path, rel: &str) -> AdoptFileRef {
    let path = game_root.join(rel.replace('/', "\\"));
    let (size, modified_time) = file_stamp(&path);
    AdoptFileRef {
        rel: rel.to_string(),
        size_bytes: size.unwrap_or(0),
        modified_time,
    }
}

/// 一份「已建链并通过验证」的文件记录。
struct StagedFile {
    rel: String,
    target: PathBuf,
    staging: PathBuf,
    link: LinkType,
}

/// 单个候选的暂存 + 验证（全程无锁）。任一文件失败即整候选失败，
/// 已建立的暂存文件由调用方整目录回滚。
fn stage_and_verify(
    candidate: &AdoptCandidate,
    game_root: &Path,
    staging_dir: &Path,
) -> Result<Vec<StagedFile>, CommandError> {
    fs::create_dir_all(staging_dir).map_err(|e| {
        CommandError::new(
            "ADOPT_STAGING_FAILED",
            format!("无法创建暂存目录 {}：{e}", staging_dir.display()),
        )
    })?;
    let mut staged = Vec::new();
    for file in &candidate.files {
        if !file
            .rel
            .to_ascii_lowercase()
            .starts_with("archive/pc/mod/")
        {
            return Err(CommandError::new(
                "UNSAFE_PATH",
                format!("收编目标必须在 archive/pc/mod 之下：{}", file.rel),
            ));
        }
        let target = safe_join(game_root, &file.rel)?;
        if !is_within(game_root, &target) {
            return Err(CommandError::new(
                "UNSAFE_PATH",
                format!("目标越出了游戏目录：{}", file.rel),
            ));
        }
        let filename = file.rel.rsplit('/').next().unwrap_or(&file.rel);
        let staging_file = staging_dir.join(filename);
        let link = materialize(&target, &staging_file, MaterializeMode::Auto)?;
        verify_copy(&target, &staging_file, link.clone())?;
        staged.push(StagedFile {
            rel: file.rel.clone(),
            target,
            staging: staging_file,
            link,
        });
    }
    Ok(staged)
}

/// 暂存回滚。防线：目录必须真的在暂存区内才允许删除。
fn rollback_staging(staging_base: &Path, staging_dir: &Path) {
    if is_within(staging_base, staging_dir) {
        let _ = fs::remove_dir_all(staging_dir);
    }
}

/// 按收编语义构造 ModEntry：enabled=true（收编后立即生效）、
/// origin/metadata_source = "adopted"、layout=Archive、暂存平铺，
/// deployed_files 指向既存游戏目标并记录 file_stamp 供体检复用。
fn build_entry(
    candidate: &AdoptCandidate,
    staging_dir: &Path,
    staged: &[StagedFile],
) -> ModEntry {
    let mut deployed = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for file in staged {
        let (size, modified_time) = file_stamp(&file.target);
        if file.link == LinkType::Copy && warnings.is_empty() {
            warnings.push(
                "本次收编因跨卷/硬链接失败使用了复制；禁用不影响，重新启用会从暂存副本重建。"
                    .to_string(),
            );
        }
        deployed.push(DeployedFile {
            source: file.staging.to_string_lossy().to_string(),
            target: file.target.to_string_lossy().to_string(),
            link_type: file.link.clone(),
            relative_path: file.rel.clone(),
            size,
            modified_time,
        });
    }
    ModEntry {
        id: candidate.id.clone(),
        raw_name: None,
        name: candidate.name.clone(),
        version: None,
        author: None,
        category: "其他".to_string(),
        category_locked: false,
        description: "由外部工具（如 Vortex）部署、经「收编」纳入启动器管理。".to_string(),
        source_zip: None,
        nexus: None,
        staging_path: staging_dir.to_string_lossy().to_string(),
        cover_path: None,
        enabled: true,
        installed_at: now_iso(),
        updated_at: None,
        size_bytes: candidate.size_bytes,
        file_count: staged.len(),
        layout: InstallLayout::Archive,
        mod_folder: None,
        metadata_source: "adopted".to_string(),
        planned_files: staged.iter().map(|file| file.rel.clone()).collect(),
        warnings,
        deployed_files: deployed,
        has_archive: true,
        has_redmod: false,
        has_cet: false,
        translated_name: None,
        translated_at: None,
        translated_by: None,
        managed: true,
        origin: "adopted".to_string(),
        modpack_id: None,
        nexus_cover_url: None,
        // 收编来的散装 archive 也要过一遍汉化包识别：很多玩家的汉化就是手动
        // 丢进 archive/pc/mod 的，收编后同样需要挂到父级才能级联禁停。
        is_translation: crate::translation::looks_like_translation([
            candidate.name.as_str(),
        ]),
        parent_mod_id: None,
        ai_loc: None,
        ai_fix: Vec::new(),
    }
}

/// 与 deploy_mod 的 append_to_load_order 同语义：把本候选的 archive
/// 相对路径追加进 load_order（已存在则跳过，忽略大小写）。
fn append_archives(state: &mut crate::schema::AppStateData, entry: &ModEntry) {
    let mut archives: Vec<String> = entry
        .deployed_files
        .iter()
        .filter(|file| file.relative_path.to_ascii_lowercase().ends_with(".archive"))
        .map(|file| file.relative_path.clone())
        .collect();
    archives.sort();
    for archive in archives {
        if !state
            .load_order
            .iter()
            .any(|item| item.eq_ignore_ascii_case(&archive))
        {
            state.load_order.push(archive);
        }
    }
}

/// 跨卷空间硬预检：staging 所在卷的剩余空间必须容得下全部需复制的字节。
#[cfg(windows)]
fn ensure_free_space(dir: &Path, required: u64) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut(), &mut free)
    };
    if ok != 0 && free < required {
        return Err(CommandError::new(
            "ADOPT_NO_SPACE",
            format!(
                "暂存区所在磁盘剩余 {free} 字节，装不下需要复制的 {required} 字节。本次收编已整批拒绝，未改动任何文件。"
            ),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_free_space(_dir: &Path, _required: u64) -> AppResult<()> {
    Ok(())
}

/// 执行一批收编。进度通过回调推送（命令层负责 emit "adopt-progress"）。
///
/// 失败语义：
/// - 单文件 IO 失败 → 该模组 ADOPT_STAGING_FAILED 跳过，其余继续；
/// - 验证失败 → ADOPT_VERIFY_FAILED 跳过；
/// - 登记落盘失败 → ADOPT_STATE_WRITE，当前模组回滚暂存，**中止剩余批次**，
///   已登记的模组保留；
/// - 取消 → 在候选之间与验证段之后检查，当前模组回滚暂存，已登记保留。
pub fn execute(
    store: &Store,
    candidates: &[AdoptCandidate],
    progress: &mut dyn FnMut(AdoptProgress),
) -> AppResult<AdoptReport> {
    let result = execute_inner(store, candidates, progress);
    CANCELLED.store(false, Ordering::SeqCst);
    result
}

fn execute_inner(
    store: &Store,
    candidates: &[AdoptCandidate],
    progress: &mut dyn FnMut(AdoptProgress),
) -> AppResult<AdoptReport> {
    let snapshot = store.snapshot_data();
    let Some(game_dir) = snapshot.game_dir.clone() else {
        return Err(CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有定位游戏目录，无法收编。",
        ));
    };
    let game_root = PathBuf::from(&game_dir);
    if !game_root.is_dir() {
        return Err(CommandError::new(
            "GAME_DIR_MISSING",
            format!("游戏目录不存在或已移动：{game_dir}"),
        ));
    }
    let staging_base = store.staging_dir();
    fs::create_dir_all(&staging_base)?;

    let selected: Vec<&AdoptCandidate> = candidates
        .iter()
        .filter(|item| valid_candidate_id(&item.id))
        .collect();
    if selected.is_empty() {
        return Err(CommandError::new(
            "ADOPT_NO_CANDIDATES",
            "没有可收编的模组。请重新扫描后再试。",
        ));
    }

    // 批次硬预检：跨卷复制需要真实磁盘空间；不足则整批拒绝、零改动。
    let copy_bytes: u64 = selected
        .iter()
        .filter(|item| item.link_type == LinkType::Copy)
        .map(|item| item.size_bytes)
        .sum();
    if copy_bytes > 0 {
        ensure_free_space(&staging_base, copy_bytes)?;
    }

    let total = selected.len();
    let mut outcomes: Vec<AdoptOutcome> = Vec::new();
    let mut registered: Vec<ModEntry> = Vec::new();
    let mut adopted = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut was_cancelled = false;

    for (index, candidate) in selected.iter().enumerate() {
        let name = candidate.name.clone();
        // ── 候选之间检查取消 ─────────────────────────────────────
        if cancelled() {
            was_cancelled = true;
            progress(AdoptProgress {
                phase: "cancelled".to_string(),
                current: index,
                total,
                name: name.clone(),
                detail: "已取消：登记过的模组保留，剩余未处理。".to_string(),
            });
            break;
        }

        progress(AdoptProgress {
            phase: "staging".to_string(),
            current: index,
            total,
            name: name.clone(),
            detail: "建立暂存反向链接…".to_string(),
        });

        let staging_dir = staging_base.join(&candidate.id);

        if candidate.already_managed {
            // 前端默认不勾选；即便送进来也只跳过，绝不重复登记。
            skipped += 1;
            outcomes.push(AdoptOutcome {
                id: candidate.id.clone(),
                name: name.clone(),
                adopted: false,
                error: Some(AdoptError {
                    code: "ADOPT_ALREADY_MANAGED".to_string(),
                    message: "这个模组已经被启动器托管，无需收编。".to_string(),
                }),
            });
            progress(AdoptProgress {
                phase: "failed".to_string(),
                current: index,
                total,
                name,
                detail: "已被启动器托管，跳过。".to_string(),
            });
            continue;
        }

        // ── 段 1：无锁建暂存 + 验证 ──────────────────────────────
        let staged = match stage_and_verify(candidate, &game_root, &staging_dir) {
            Ok(staged) => staged,
            Err(err) => {
                rollback_staging(&staging_base, &staging_dir);
                failed += 1;
                outcomes.push(AdoptOutcome {
                    id: candidate.id.clone(),
                    name: name.clone(),
                    adopted: false,
                    error: Some(AdoptError {
                        code: err.code.clone(),
                        message: err.message.clone(),
                    }),
                });
                progress(AdoptProgress {
                    phase: "failed".to_string(),
                    current: index,
                    total,
                    name,
                    detail: err.message,
                });
                continue;
            }
        };

        progress(AdoptProgress {
            phase: "verify".to_string(),
            current: index,
            total,
            name: name.clone(),
            detail: "校验暂存副本…".to_string(),
        });

        // ── 验证段之后检查取消：当前模组回滚暂存 ────────────────
        if cancelled() {
            rollback_staging(&staging_base, &staging_dir);
            was_cancelled = true;
            progress(AdoptProgress {
                phase: "cancelled".to_string(),
                current: index,
                total,
                name,
                detail: "已取消：当前模组暂存已回滚，已登记的保留。".to_string(),
            });
            break;
        }

        // ── 段 2：短锁登记（push + save 是提交点）───────────────
        let entry = build_entry(candidate, &staging_dir, &staged);
        let register_result = (|| -> AppResult<()> {
            let mut state = store.data.lock().expect("state mutex poisoned");
            if state.mods.iter().any(|item| item.id == entry.id) {
                return Err(CommandError::new(
                    "ADOPT_DUPLICATE",
                    format!("库里已存在同 id 的收编条目：{}", entry.id),
                ));
            }
            let load_order_before = state.load_order.clone();
            state.mods.push(entry.clone());
            append_archives(&mut state, &entry);
            if let Err(err) = store.save(&state) {
                // 状态落盘是提交点：失败必须把内存也退回去。
                state.mods.retain(|item| item.id != entry.id);
                state.load_order = load_order_before;
                return Err(CommandError::new(
                    "ADOPT_STATE_WRITE",
                    format!("登记收编结果失败：{}；暂存已回滚。", err.message),
                ));
            }
            Ok(())
        })();

        match register_result {
            Err(err) => {
                rollback_staging(&staging_base, &staging_dir);
                return Err(err);
            }
            Ok(()) => {
                adopted += 1;
                registered.push(entry.clone());
                outcomes.push(AdoptOutcome {
                    id: candidate.id.clone(),
                    name: name.clone(),
                    adopted: true,
                    error: None,
                });
                // ── 段 3：锁外 emit 进度 ────────────────────────────
                progress(AdoptProgress {
                    phase: "register".to_string(),
                    current: index,
                    total,
                    name,
                    detail: "已登记入库。".to_string(),
                });
            }
        }
    }

    progress(AdoptProgress {
        phase: "done".to_string(),
        current: total,
        total,
        name: String::new(),
        detail: format!("收编完成：成功 {adopted}、失败 {failed}、跳过 {skipped}。"),
    });

    Ok(AdoptReport {
        adopted,
        failed,
        skipped,
        cancelled: was_cancelled,
        outcomes,
        mods: registered,
    })
}
