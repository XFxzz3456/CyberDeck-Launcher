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
    AdoptScanReport, AdoptVortexMeta, AppResult, CommandError, DeployedFile, InstallLayout,
    LibraryNormalizeReport, LinkType, ModEntry,
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

    /// 伴生文件（.xl / .xlp）是否属于这个 archive。
    ///
    /// 生态里两种写法都存在：
    /// - **ArchiveXL 标准写法**：`X.archive` 的元数据叫 `X.archive.xl`（或 `.archive.xlp`）；
    /// - 早期手工包：`X.archive` 配 `X.xl`（同词干）。
    ///
    /// 2026-11-06 之前只认后者。真实玩家库里 90% 是标准写法，于是每个 mod 都被
    /// 拆成「主体 + 碎片」两条记录——实机统计 119 条里有 37 条是 `.archive.xl` 碎片，
    /// 用户看到的模组数直接虚高三分之四。
    fn companion_follows(companion: &RawFile, archive: &RawFile) -> bool {
        if companion.stem_lower == archive.stem_lower {
            return true;
        }
        // 用「archive 全名 + 点」做前缀，避免 foo.archive 抢走 foobar.archive.xl。
        let prefix = format!("{}.", archive.name.to_ascii_lowercase());
        companion.name.to_ascii_lowercase().starts_with(&prefix)
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
            .filter(|item| companion_follows(item, archive))
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
            source: "archive".to_string(),
            absorb_entry_ids: Vec::new(),
            // archive 反推拿不到 Nexus 元数据：这类候选本来就没经过 Vortex，
            // 交给本地推断 + 之后的「粘贴链接 / 补全信息」补。
            vortex: None,
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
            source: "archive".to_string(),
            absorb_entry_ids: Vec::new(),
            // archive 反推拿不到 Nexus 元数据：这类候选本来就没经过 Vortex，
            // 交给本地推断 + 之后的「粘贴链接 / 补全信息」补。
            vortex: None,
        });
    }

    append_vortex_candidates(
        &state,
        &game_root,
        &staging_dir,
        &mut candidates,
    );

    // 已登记且暂存目录还在的候选直接标「已托管」：重扫时不再送进执行批次，
    // 避免 materialize 撞上残留文件后整批报 ADOPT_STAGING_FAILED。
    let registered: HashSet<String> =
        state.mods.iter().map(|item| item.id.clone()).collect();
    for candidate in &mut candidates {
        if registered.contains(&candidate.id) && staging_dir.join(&candidate.id).is_dir() {
            candidate.already_managed = true;
        }
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

/// Vortex 口径的候选：一个 mod 目录 = 一条记录。
///
/// 与 archive 反推的区别：archive 反推是「一个文件一条」，既认不出同一个 mod
/// 的 CET/redscript 部分，也扫不到 `archive/pc/mod/<子目录>/`（4K 材质包常用）。
/// Vortex 的 mod 存储目录本身就是游戏根镜像，直接读目录树就能拿到精确归属。
///
/// 去重与合并：
/// - 与该目录有文件交集的既有条目，只要它的文件**全部**落在本目录内，就是
///   同一批文件的碎片记录 → 记进 `absorb_entry_ids`，执行期并入本候选后删除；
/// - 若某个既有条目横跨多个 Vortex 目录，说明归属本身有歧义，收编会让两边
///   抢同一批文件 → 标 `already_managed` 跳过，不动它。
fn append_vortex_candidates(
    state: &crate::schema::AppStateData,
    game_root: &Path,
    staging_dir: &Path,
    candidates: &mut Vec<AdoptCandidate>,
) {
    let Some(root) = crate::vortex_source::find_mods_root(crate::vortex_source::GAME_ID) else {
        return;
    };
    let records = load_record_map();
    append_vortex_candidates_with(&root, &records, state, game_root, staging_dir, candidates);
}

/// 目录名（小写）→ Vortex 记录。Vortex 开着时库被锁，此时返回空表，
/// 收编仍然可用（只是少了 Nexus 编号与分类），不因为读不到元数据就罢工。
/// 测试构建下直接给空表：`core-tests` 是独立 crate，不为它拉 LevelDB 依赖。
#[cfg(not(test))]
fn load_record_map() -> std::collections::HashMap<String, crate::schema::VortexRecord> {
    crate::vortex::load_records()
        .unwrap_or_default()
        .into_iter()
        .map(|record| (record.dir_name.to_ascii_lowercase(), record))
        .collect()
}

#[cfg(test)]
fn load_record_map() -> std::collections::HashMap<String, crate::schema::VortexRecord> {
    std::collections::HashMap::new()
}

/// 可注入存储根的同体函数，专供测试构造夹具（不读真实 Vortex 库）。
#[allow(dead_code)]
pub(crate) fn append_vortex_candidates_from(
    root: &Path,
    state: &crate::schema::AppStateData,
    game_root: &Path,
    staging_dir: &Path,
    candidates: &mut Vec<AdoptCandidate>,
) {
    append_vortex_candidates_with(
        root,
        &std::collections::HashMap::new(),
        state,
        game_root,
        staging_dir,
        candidates,
    );
}

pub(crate) fn append_vortex_candidates_with(
    root: &Path,
    records: &std::collections::HashMap<String, crate::schema::VortexRecord>,
    state: &crate::schema::AppStateData,
    game_root: &Path,
    staging_dir: &Path,
    candidates: &mut Vec<AdoptCandidate>,
) {
    use std::collections::HashMap;

    let dirs = crate::vortex_source::scan_dirs(root, game_root);
    if dirs.is_empty() {
        return;
    }

    // rel（小写）→ 占有它的条目下标。只认 deployed_files：planned 里可能有
    // 「禁用中、文件已从游戏目录撤走」的记录，把它们算进来会让合并后
    // 出现「条目启用但文件不全」的假象。
    let mut owner_of: HashMap<String, usize> = HashMap::new();
    for (index, entry) in state.mods.iter().enumerate() {
        for file in &entry.deployed_files {
            owner_of.insert(file.relative_path.to_ascii_lowercase(), index);
        }
    }

    for dir in dirs {
        let dir_lower: HashSet<String> = dir
            .files
            .iter()
            .map(|item| item.to_ascii_lowercase())
            .collect();

        let mut overlap: Vec<usize> = Vec::new();
        for rel in &dir.files {
            if let Some(index) = owner_of.get(&rel.to_ascii_lowercase()) {
                if !overlap.contains(index) {
                    overlap.push(*index);
                }
            }
        }

        let straddles = overlap.iter().any(|index| {
            state.mods[*index]
                .deployed_files
                .iter()
                .any(|file| !dir_lower.contains(&file.relative_path.to_ascii_lowercase()))
        });

        let files: Vec<AdoptFileRef> = dir
            .files
            .iter()
            .map(|rel| file_ref(game_root, rel))
            .collect();
        if files.iter().all(|file| file.size_bytes == 0) {
            continue;
        }
        let size_bytes = files.iter().map(|file| file.size_bytes).sum();
        let main_path = game_root.join(dir.files[0].replace('/', "\\"));
        // Vortex 的目录名 = 它自己的 installationPath，能精确配到元数据。
        // 读库失败（Vortex 正开着、库被锁）时是空表，收编照常走，只是没有元数据。
        let meta = records
            .get(&dir.dir_name.to_ascii_lowercase())
            .map(meta_of);

        if straddles {
            candidates.push(AdoptCandidate {
                id: candidate_id(&format!("vortex:{}", dir.dir_name)),
                name: format!("{}（与其它条目交叉，需先手动整理）", dir.display_name),
                archive_rel: dir.files[0].clone(),
                files,
                size_bytes,
                link_type: if same_volume(&main_path, staging_dir) {
                    LinkType::HardLink
                } else {
                    LinkType::Copy
                },
                already_managed: true,
                source: "vortex".to_string(),
                absorb_entry_ids: Vec::new(),
                vortex: meta,
            });
            continue;
        }

        let absorb: Vec<String> = overlap
            .iter()
            .map(|index| state.mods[*index].id.clone())
            .collect();

        candidates.push(AdoptCandidate {
            id: candidate_id(&format!("vortex:{}", dir.dir_name)),
            name: dir.display_name,
            archive_rel: dir.files[0].clone(),
            files,
            size_bytes,
            link_type: if same_volume(&main_path, staging_dir) {
                LinkType::HardLink
            } else {
                LinkType::Copy
            },
            already_managed: false,
            source: "vortex".to_string(),
            absorb_entry_ids: absorb,
            vortex: meta,
        });
    }
}

/// Vortex 记录 → 收编候选上的元数据。空字符串一律折成 None，免得写进库是空串。
fn meta_of(record: &crate::schema::VortexRecord) -> AdoptVortexMeta {
    let non_empty = |value: &str| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };
    AdoptVortexMeta {
        mod_id: record.mod_id,
        file_id: record.file_id,
        name: non_empty(&record.name),
        author: non_empty(&record.author),
        version: non_empty(&record.version),
        category: record.category.clone(),
        picture_url: record.picture_url.clone().filter(|url| !url.trim().is_empty()),
    }
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
        // 收编目标必须落在「游戏根镜像」的可识别目录里。这条校验比早期的
        // 「必须以 archive/pc/mod 开头」宽，因为 Vortex 口径的候选会带
        // r6/、bin/、red4ext/ 等其它根；但仍然拦住 ../ 与未知顶层目录。
        let lower = file.rel.to_ascii_lowercase();
        let first = lower.split('/').next().unwrap_or_default();
        if !crate::installer::recognized_root(first) {
            return Err(CommandError::new(
                "UNSAFE_PATH",
                format!("收编目标不在游戏根的可识别目录里：{}", file.rel),
            ));
        }
        let target = safe_join(game_root, &file.rel)?;
        if !is_within(game_root, &target) {
            return Err(CommandError::new(
                "UNSAFE_PATH",
                format!("目标越出了游戏目录：{}", file.rel),
            ));
        }
        // 暂存保留原始相对结构：一个模组可能同时含 archive/ 与 r6/ 的同名文件，
        // 早期平铺会让后一个覆盖前一个。
        let staging_file = staging_dir.join(file.rel.replace('/', "\\"));
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
fn rollback_staging(staging_base: &Path, staging_dir: &Path, protected: &HashSet<String>) {
    if !is_within(staging_base, staging_dir) {
        return;
    }
    let name = staging_dir
        .file_name()
        .map(|part| part.to_string_lossy().to_string())
        .unwrap_or_default();
    // 2026-11-09：早期版本无条件删整个目录。若候选 id 恰好属于一个已登记模组
    // （重跑收编 / 残留目录撞车），这次「回滚」会把库内模组的暂存删掉，于是出现
    // 「条目在库里、暂存目录没了」。已登记目录一律不动，宁可留几个多余硬链接。
    if protected.contains(&name) {
        eprintln!("adopt: 跳过删除已登记模组的暂存目录 {name}");
        return;
    }
    let _ = fs::remove_dir_all(staging_dir);
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

    // 按真实内容判类型：Vortex 的一条 mod 可能同时含 archive / CET / redscript，
    // 早期一律写死 Archive 会让「按类型筛选」「CET 插件计数」全部失准。
    let has_archive = staged
        .iter()
        .any(|file| file.rel.to_ascii_lowercase().ends_with(".archive"));
    let has_cet = staged.iter().any(|file| {
        file.rel
            .to_ascii_lowercase()
            .contains("bin/x64/plugins/cyber_engine_tweaks")
    });
    let has_redmod = staged.iter().any(|file| {
        let lower = file.rel.to_ascii_lowercase();
        lower.starts_with("mods/") || lower.starts_with("v2077/mod/")
    });
    // Vortex 存储目录本身就是游戏根镜像，用 GameRoot 才能原样铺回去；
    // archive 反推的候选仍是老口径（平铺进 archive/pc/mod）。
    let layout = if candidate.source == "vortex" {
        InstallLayout::GameRoot
    } else {
        InstallLayout::Archive
    };
    // 收编时能精确对上的 Vortex 元数据直接写进库：Nexus 编号、官方分类、
    // 作者、版本、封面。这样条目一进库就和 Vortex 里看到的一致，
    // 也不用再靠「从 Vortex 导入」做名称模糊匹配。
    let meta = candidate.vortex.clone().unwrap_or_default();
    let nexus = (meta.mod_id > 0).then(|| crate::schema::NexusRef {
        mod_id: meta.mod_id,
        file_id: meta.file_id,
        url: format!(
            "https://www.nexusmods.com/cyberpunk2077/mods/{}",
            meta.mod_id
        ),
        version: meta.version.clone(),
        picture_url: meta.picture_url.clone(),
        latest_version: None,
        last_check: None,
    });
    // 没有 Nexus 分类时退回本地推断——内容证据仍然比「其他」有用。
    let category = match meta.category.clone() {
        Some(value) => value,
        None => crate::category::infer_with_nexus(
            &crate::category::Signals {
                name: &candidate.name,
                folder: "",
                layout: &layout,
                paths: &staged.iter().map(|file| file.rel.clone()).collect::<Vec<_>>(),
            },
            None,
        ),
    };
    ModEntry {
        id: candidate.id.clone(),
        raw_name: None,
        // Vortex 的 modName 是 Nexus 页面标题，比目录名（带版本戳）更适合当显示名。
        name: meta.name.clone().unwrap_or_else(|| candidate.name.clone()),
        version: meta.version.clone(),
        author: meta.author.clone(),
        category,
        category_locked: false,
        description: "由外部工具（如 Vortex）部署、经「收编」纳入启动器管理。".to_string(),
        source_zip: None,
        nexus,
        staging_path: staging_dir.to_string_lossy().to_string(),
        cover_path: None,
        enabled: true,
        installed_at: now_iso(),
        updated_at: None,
        size_bytes: candidate.size_bytes,
        file_count: staged.len(),
        layout,
        mod_folder: None,
        metadata_source: if meta.mod_id > 0 { "vortex" } else { "adopted" }.to_string(),
        planned_files: staged.iter().map(|file| file.rel.clone()).collect(),
        warnings,
        deployed_files: deployed,
        has_archive,
        has_redmod,
        has_cet,
        translated_name: None,
        translated_at: None,
        translated_by: None,
        managed: true,
        origin: "adopted".to_string(),
        modpack_id: None,
        nexus_cover_url: meta.picture_url.clone(),
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
        .filter(|file| {
            let lower = file.relative_path.to_ascii_lowercase();
            // 只有 archive/pc/mod 下的 archive 进加载顺序；GameRoot 口径的
            // 候选可能还带 archive/pc/content 这类原版档案，不能混进去。
            lower.starts_with("archive/pc/mod/") && lower.ends_with(".archive")
        })
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

/// 库整理：把历史上「伴生 .xl 被单独收编成条」的碎片并回它的 archive 主体。
///
/// 背景：2026-11-06 之前的 `scan` 只认同词干（`X.archive` + `X.xl`），认不出
/// ArchiveXL 的标准写法（`X.archive` + `X.archive.xl`），于是每个 mod 在库里
/// 留下「主体 + 碎片」两条记录。实机取样：119 条里 37 条是这种碎片。
/// 修 `scan` 只解决「以后不再产生」，已经进库的脏数据靠这里收口。
///
/// 范围与安全边界：
/// - 只动 `origin == "adopted"`、且部署清单恰好一个 `.archive.xl/.xlp` 的条目；
/// - 合并是**纯 state 操作**：游戏目录与暂存文件一个都不动，碎片条目的 `source`
///   仍指向它自己的暂存目录，之后禁用/卸载照常工作；
/// - 「只剩元数据、主体不在游戏目录」与「清单为空」的条目**只统计不删除**——
///   删用户数据需要单独动作，不能在整理里顺手做掉。
pub fn normalize_library(store: &Store) -> AppResult<LibraryNormalizeReport> {
    use std::collections::HashMap;

    let mut state = store.data.lock().unwrap_or_else(|err| err.into_inner());

    // rel（小写）→ 占有它的条目下标。合并前先拍一次快照，合并过程中下标不动。
    let mut owners: HashMap<String, usize> = HashMap::new();
    for (index, entry) in state.mods.iter().enumerate() {
        for file in &entry.deployed_files {
            owners.insert(file.relative_path.to_ascii_lowercase(), index);
        }
    }

    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for (index, entry) in state.mods.iter().enumerate() {
        if entry.origin != "adopted" || entry.deployed_files.len() != 1 {
            continue;
        }
        let rel = entry.deployed_files[0].relative_path.to_ascii_lowercase();
        if !(rel.ends_with(".archive.xl") || rel.ends_with(".archive.xlp")) {
            continue;
        }
        // `archive/pc/mod/X.archive.xl` → `archive/pc/mod/X.archive`
        let Some(cut) = rel.rfind('.') else { continue };
        if let Some(&owner_index) = owners.get(&rel[..cut]) {
            if owner_index != index && state.mods[owner_index].origin == "adopted" {
                pairs.push((index, owner_index));
            }
        }
    }

    let mut merged_names: Vec<String> = Vec::new();
    let mut merged_ids: Vec<String> = Vec::new();
    for (child, owner) in &pairs {
        let child_entry = state.mods[*child].clone();
        let owner_entry = &mut state.mods[*owner];
        for file in child_entry.deployed_files {
            if !owner_entry
                .deployed_files
                .iter()
                .any(|item| item.relative_path.eq_ignore_ascii_case(&file.relative_path))
            {
                owner_entry.deployed_files.push(file);
            }
        }
        for rel in child_entry.planned_files {
            if !owner_entry
                .planned_files
                .iter()
                .any(|item| item.eq_ignore_ascii_case(&rel))
            {
                owner_entry.planned_files.push(rel);
            }
        }
        owner_entry.file_count = owner_entry.deployed_files.len();
        owner_entry.size_bytes = owner_entry.size_bytes.saturating_add(child_entry.size_bytes);
        owner_entry.updated_at = Some(now_iso());
        merged_names.push(child_entry.name.clone());
        merged_ids.push(child_entry.id.clone());
    }
    if !merged_ids.is_empty() {
        state.mods.retain(|item| !merged_ids.contains(&item.id));
    }

    // 合并后重新拍一遍占有关系，用于判定「谁只剩元数据」。
    let mut owned: HashSet<String> = HashSet::new();
    for entry in &state.mods {
        for file in &entry.deployed_files {
            owned.insert(file.relative_path.to_ascii_lowercase());
        }
    }
    let game_root = state.game_dir.clone().map(PathBuf::from);

    // 「失效条目」= 只剩 ArchiveXL 元数据、且它指向的 `X.archive` 既不在库、也不在游戏目录。
    //
    // 这种条目在游戏里不产生任何效果（.xl 找不到主体就是死文件），却实打实占着
    // 「已安装」的计数——用户看到的就是数字虚高。清理只删记录、不删文件：
    // 游戏目录里的 .xl 原样保留，暂存目录也不动，以后补回主体再收编一次即可。
    //
    // 只认 `X.archive.xl` / `X.archive.xlp`。`X.xl` 这种独立元数据可能是汉化
    // extend 包（`extend:` 指向别的 archive），没有同名主体也照样生效，绝不能动。
    // 「幽灵条目」= 部署清单里的文件在磁盘上一个都不存在。
    //
    // 典型来源：早期收编把 Vortex 的 mod 存储目录名当成了游戏内目录名，
    // 于是在 `r6/scripts/DigitalVixenCore 28390 4.9.10 …/` 下记了 655 条，
    // 而那个目录从来没被创建过。这种条目禁用/卸载必然报错，只能清记录。
    //
    // 不按 origin 过滤：实机上那条 655 文件的记录 origin 是 `cyberdeck`
    // （正常安装流程写进去的），只认 `adopted` 会漏掉它。判据只认事实——
    // 清单里一个文件都不在磁盘上了，这份部署就不存在了。
    //
    // 安全边界：游戏目录必须真实存在才做（盘没挂载/路径临时不可用时不能
    // 把整库误判成幽灵）；只要还剩一个文件在，就不算。
    let mut ghost_names: Vec<String> = Vec::new();
    let mut ghost_ids: Vec<String> = Vec::new();
    if let Some(root) = game_root.as_ref().filter(|root| root.is_dir()) {
        for entry in &state.mods {
            if entry.deployed_files.is_empty() {
                continue;
            }
            let all_missing = entry
                .deployed_files
                .iter()
                .all(|file| !root.join(file.relative_path.replace('/', "\\")).exists());
            if all_missing {
                ghost_names.push(entry.name.clone());
                ghost_ids.push(entry.id.clone());
            }
        }
    }
    if !ghost_ids.is_empty() {
        state.mods.retain(|item| !ghost_ids.contains(&item.id));
    }

    let mut invalids: Vec<String> = Vec::new();
    let mut invalid_ids: Vec<String> = Vec::new();
    for entry in &state.mods {
        if entry.deployed_files.is_empty() {
            continue;
        }
        let mut orphan = true;
        for file in &entry.deployed_files {
            let low = file.relative_path.to_ascii_lowercase();
            let stem = low
                .strip_suffix(".xl")
                .or_else(|| low.strip_suffix(".xlp"));
            let Some(stem) = stem else {
                orphan = false;
                break;
            };
            if !stem.ends_with(".archive") {
                orphan = false;
                break;
            }
            let body = stem.to_string();
            let body_exists = owned.contains(&body)
                || game_root
                    .as_ref()
                    .map(|root| root.join(body.replace('/', "\\")).is_file())
                    .unwrap_or(false);
            if body_exists {
                orphan = false;
                break;
            }
        }
        if orphan {
            invalids.push(entry.name.clone());
            invalid_ids.push(entry.id.clone());
        }
    }
    if !invalid_ids.is_empty() {
        state.mods.retain(|item| !invalid_ids.contains(&item.id));
    }

    let empty: Vec<String> = state
        .mods
        .iter()
        .filter(|entry| entry.deployed_files.is_empty() && entry.planned_files.is_empty())
        .map(|entry| entry.name.clone())
        .collect();

    let merged = merged_names.len();
    let invalidated = invalid_ids.len() + ghost_ids.len();
    if merged > 0 || invalidated > 0 {
        store.save(&state)?;
    }
    drop(state);

    // 幽灵条目在前（更严重，用户更需要知道），失效元数据在后。
    let mut removed = ghost_names;
    removed.extend(invalids);

    Ok(LibraryNormalizeReport {
        merged,
        merged_names,
        removed,
        empty,
    })
}

/// 执行一批收编。进度通过回调推送（命令层负责 emit "adopt-progress"）。
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
    // 批次开始时已在库里的 id 全程受保护：失败回滚不得删它们的暂存目录。
    let protected: HashSet<String> =
        snapshot.mods.iter().map(|item| item.id.clone()).collect();

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

        // 双保险：即便前端把已登记候选勾进来了，也在这里拦住，绝不进入
        // materialize（它会撞上已存在的暂存文件，进而触发回滚删目录）。
        if protected.contains(&candidate.id) {
            skipped += 1;
            outcomes.push(AdoptOutcome {
                id: candidate.id.clone(),
                name: name.clone(),
                adopted: false,
                error: Some(AdoptError {
                    code: "ADOPT_ALREADY_MANAGED".to_string(),
                    message: "这个模组已经登记入库，无需重复收编。".to_string(),
                }),
            });
            continue;
        }

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
                rollback_staging(&staging_base, &staging_dir, &protected);
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
            rollback_staging(&staging_base, &staging_dir, &protected);
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
        let absorb_ids = candidate.absorb_entry_ids.clone();
        let register_result = (|| -> AppResult<()> {
            let mut state = store.data.lock().expect("state mutex poisoned");
            if state.mods.iter().any(|item| item.id == entry.id) {
                return Err(CommandError::new(
                    "ADOPT_DUPLICATE",
                    format!("库里已存在同 id 的收编条目：{}", entry.id),
                ));
            }
            let load_order_before = state.load_order.clone();
            // 被并入的碎片条目：先摘下来留底，save 成功才真的消失。
            let absorbed_entries: Vec<ModEntry> = state
                .mods
                .iter()
                .filter(|item| absorb_ids.iter().any(|id| id == &item.id))
                .cloned()
                .collect();
            state
                .mods
                .retain(|item| !absorb_ids.iter().any(|id| id == &item.id));
            state.mods.push(entry.clone());
            append_archives(&mut state, &entry);
            if let Err(err) = store.save(&state) {
                // 状态落盘是提交点：失败必须把内存也退回去。
                state.mods.retain(|item| item.id != entry.id);
                state.mods.extend(absorbed_entries);
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
                rollback_staging(&staging_base, &staging_dir, &protected);
                return Err(err);
            }
            Ok(()) => {
                // 并入的旧条目暂存目录作废。游戏文件不受影响 —— 收编建的是
                // 「硬链接」或「副本」，删暂存侧的目录项不等于删游戏文件。
                for id in &absorb_ids {
                    let dir = staging_base.join(id);
                    if is_within(&staging_base, &dir) && dir.exists() {
                        let _ = fs::remove_dir_all(&dir);
                    }
                }
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
