use crate::game::{same_volume, validate_game_dir};
use crate::schema::{
    AppResult, CommandError, ConflictInfo, DeployReport, DeployedFile, GameInfo, InstallLayout,
    LinkType, ModEntry,
};
use crate::store::{
    is_within, now_iso, sanitize_folder, safe_join, Store,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::ZipArchive;

const MAX_ENTRIES: usize = 30_000;
const MAX_UNCOMPRESSED: u64 = 8 * 1024 * 1024 * 1024;
const RECOGNIZED_ROOTS: [&str; 6] = ["archive", "bin", "r6", "red4ext", "engine", "mods"];

#[derive(Debug, Clone)]
pub(crate) struct PlanFile {
    pub(crate) source: PathBuf,
    pub(crate) relative: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveKind {
    Zip,
    SevenZ,
    Rar,
}

pub(crate) fn archive_kind(path: &Path) -> AppResult<ArchiveKind> {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "zip" => Ok(ArchiveKind::Zip),
        "7z" => Ok(ArchiveKind::SevenZ),
        "rar" => Ok(ArchiveKind::Rar),
        _ => Err(CommandError::new(
            "UNSUPPORTED_ARCHIVE",
            "只支持 .zip、.7z、.rar。其他格式请先解压，或改成 ZIP 后重试。",
        )),
    }
}

/// Backwards-compatible name used by the original tests and IPC layer.
pub fn install_zip(store: &Store, zip_path: &str) -> AppResult<ModEntry> {
    install_archive(store, zip_path, None)
}

/// 按 Nexus 官方分类重算条目的本地分类（P6）。
///
/// 优先级：**用户手动（category_locked）永远最高** —— 玩家点过下拉就是最终答案，
/// 后面任何自动流程都不许覆盖。其次是 Nexus 官方分类（能映射就用），
/// 映射不出来才退回内容证据，**不看文件名**。
pub fn apply_nexus_category(entry: &mut crate::schema::ModEntry, nexus_category: &str) {
    if entry.category_locked || nexus_category.trim().is_empty() {
        return;
    }
    let next = crate::category::infer_with_nexus(
        &crate::category::Signals {
            name: &entry.name,
            folder: entry.mod_folder.as_deref().unwrap_or(""),
            layout: &entry.layout,
            paths: &entry.planned_files,
        },
        Some(nexus_category),
    );
    if next != entry.category {
        entry.category = next;
    }
}

pub fn install_archive(
    store: &Store,
    archive_path: &str,
    nexus: Option<crate::schema::NexusRef>,
) -> AppResult<ModEntry> {
    let source = PathBuf::from(archive_path);
    if !source.is_file() {
        return Err(CommandError::new(
            "ARCHIVE_NOT_FOUND",
            format!("找不到压缩包：{}", source.display()),
        ));
    }
    let kind = archive_kind(&source)?;

    let id = format!("mod-{}", uuid::Uuid::new_v4().simple());
    let staging_parent = store.staging_dir().join(&id);
    let temp_parent = store.staging_dir().join(format!(".tmp-{id}"));
    let payload = temp_parent.join("payload");
    fs::create_dir_all(&payload)?;

    let result = (|| -> AppResult<ModEntry> {
        let file_count = match kind {
            ArchiveKind::Zip => extract_zip(&source, &payload)?,
            ArchiveKind::SevenZ => extract_7z(&source, &payload)?,
            ArchiveKind::Rar => extract_rar(store, &source, &payload)?,
        };

        if file_count == 0 {
            return Err(CommandError::new(
                "ARCHIVE_EMPTY",
                "压缩包里没有可安装的文件（可能只有文档或空目录）。",
            ));
        }

        let payload_root = refine_payload_root(&payload)?;
        finalize_install(
            &source,
            &payload_root,
            &temp_parent,
            &staging_parent,
            id,
            file_count,
            nexus,
        )
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&temp_parent);
        let _ = fs::remove_dir_all(&staging_parent);
    }
    result
}

pub(crate) fn extract_zip(zip_path: &Path, payload: &Path) -> AppResult<usize> {
    let file = fs::File::open(zip_path)
        .map_err(|e| CommandError::new("ZIP_OPEN", format!("无法打开 ZIP：{e}")))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| CommandError::new("ZIP_INVALID", format!("ZIP 已损坏或格式不支持：{e}")))?;

    if archive.len() > MAX_ENTRIES {
        return Err(CommandError::new(
            "ZIP_TOO_MANY_FILES",
            format!("压缩包包含 {} 个条目，超过安全上限 {MAX_ENTRIES}。", archive.len()),
        ));
    }

    let mut paths: Vec<String> = Vec::new();
    let mut total_uncompressed: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| CommandError::new("ZIP_READ", format!("读取 ZIP 条目失败：{e}")))?;
        if entry.is_dir() {
            continue;
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        if total_uncompressed > MAX_UNCOMPRESSED {
            return Err(CommandError::new(
                "ZIP_TOO_LARGE",
                "解压后体积超过 8 GB，已停止导入。",
            ));
        }
        let Some(path) = entry.enclosed_name() else {
            return Err(CommandError::new(
                "ZIP_UNSAFE_ENTRY",
                format!("压缩包包含不安全路径：{}", entry.name()),
            ));
        };
        let normalized = path.to_string_lossy().replace('\\', "/");
        if normalized.starts_with("__MACOSX/") || normalized.ends_with(".DS_Store") {
            continue;
        }
        paths.push(normalized);
    }

    let strip = detect_strip_prefix(&paths);
    let mut file_count = 0usize;
    let mut written: HashSet<String> = HashSet::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| CommandError::new("ZIP_READ", format!("读取 ZIP 条目失败：{e}")))?;
        if entry.is_dir() {
            continue;
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind == 0o120000 {
                // Symbolic links inside a zip are a classic path-escape vector.
                return Err(CommandError::new(
                    "ZIP_SYMLINK_ENTRY",
                    format!("压缩包内含符号链接，已拒绝：{}", entry.name()),
                ));
            }
        }
        let Some(path) = entry.enclosed_name() else {
            return Err(CommandError::new(
                "ZIP_UNSAFE_ENTRY",
                format!("压缩包包含不安全路径：{}", entry.name()),
            ));
        };
        let normalized = path.to_string_lossy().replace('\\', "/");
        if normalized.starts_with("__MACOSX/") || normalized.ends_with(".DS_Store") {
            continue;
        }
        let relative = match &strip {
            Some(prefix) => normalized
                .strip_prefix(prefix.as_str())
                .unwrap_or(&normalized)
                .trim_start_matches('/')
                .to_string(),
            None => normalized,
        };
        if relative.is_empty() || is_doc_only(&relative) {
            continue;
        }
        if !written.insert(relative.to_lowercase()) {
            continue;
        }
        let target = safe_join(payload, &relative)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&target)
            .map_err(|e| CommandError::new("ZIP_EXTRACT", format!("无法写入暂存文件：{e}")))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|e| CommandError::new("ZIP_EXTRACT", format!("解压失败：{e}")))?;
            if read == 0 {
                break;
            }
            out.write_all(&buffer[..read])?;
        }
        file_count += 1;
    }
    Ok(file_count)
}

pub(crate) fn extract_7z(archive_path: &Path, payload: &Path) -> AppResult<usize> {
    use sevenz_rust::{Password, SevenZReader};

    let mut reader = SevenZReader::open(archive_path, Password::empty()).map_err(|e| {
        CommandError::new(
            "SEVENZ_OPEN",
            format!("无法打开 7z（可能加密或损坏）：{e}"),
        )
    })?;

    let entries = reader.archive().files.clone();
    if entries.len() > MAX_ENTRIES {
        return Err(CommandError::new(
            "SEVENZ_TOO_MANY_FILES",
            format!("压缩包包含 {} 个条目，超过安全上限 {MAX_ENTRIES}。", entries.len()),
        ));
    }
    let mut names: Vec<String> = Vec::new();
    let mut total: u64 = 0;
    for entry in &entries {
        let normalized = entry.name().replace('\\', "/");
        if normalized.starts_with("__MACOSX/") || normalized.ends_with(".DS_Store") {
            continue;
        }
        if entry.windows_attributes & 0x400 != 0 {
            return Err(CommandError::new(
                "SEVENZ_SYMLINK_ENTRY",
                format!("7z 内含符号链接/重解析点，已拒绝：{}", entry.name()),
            ));
        }
        if entry.is_directory() {
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNCOMPRESSED {
            return Err(CommandError::new(
                "SEVENZ_TOO_LARGE",
                "解压后体积超过 8 GB，已停止导入。",
            ));
        }
        names.push(normalized);
    }
    let strip = detect_strip_prefix(&names);
    let mut written: HashSet<String> = HashSet::new();
    let mut file_count = 0usize;

    reader
        .for_each_entries(|entry, input| {
            if entry.is_directory() || !entry.has_stream() {
                return Ok(true);
            }
            let normalized = entry.name().replace('\\', "/");
            if normalized.starts_with("__MACOSX/") || normalized.ends_with(".DS_Store") {
                return Ok(true);
            }
            let relative = match &strip {
                Some(prefix) => normalized
                    .strip_prefix(prefix.as_str())
                    .unwrap_or(&normalized)
                    .trim_start_matches('/')
                    .to_string(),
                None => normalized,
            };
            if relative.is_empty() || is_doc_only(&relative) {
                return Ok(true);
            }
            if !written.insert(relative.to_lowercase()) {
                return Ok(true);
            }
            let target = safe_join(payload, &relative)
                .map_err(|e| sevenz_rust::Error::other(e.message))?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(sevenz_rust::Error::io)?;
            }
            let mut out =
                fs::File::create(&target).map_err(|e| sevenz_rust::Error::io_msg(e, "create"))?;
            std::io::copy(input, &mut out).map_err(sevenz_rust::Error::io)?;
            file_count += 1;
            Ok(true)
        })
        .map_err(|e| CommandError::new("SEVENZ_EXTRACT", format!("7z 解压失败：{e}")))?;

    Ok(file_count)
}

pub(crate) fn extract_rar(store: &Store, archive_path: &Path, payload: &Path) -> AppResult<usize> {
    let configured = store.snapshot_data().settings.archive_tool_path;
    let tool = find_archive_tool(&configured).ok_or_else(|| {
        CommandError::new(
            "RAR_TOOL_MISSING",
            "解压 .rar 需要本机安装 7-Zip 或 WinRAR。安装后重启启动器即可自动识别；\
             也可以在「设置 → 安全策略」里手动指定 7z.exe / UnRAR.exe 的路径。\
             .zip 和 .7z 不需要额外工具。",
        )
    })?;

    let mut command = std::process::Command::new(&tool);
    let tool_name = tool
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if tool_name.starts_with("unrar") {
        command.args(["x", "-y", "-p-", "-o+", "-idq"]);
        command.arg(archive_path);
        command.arg(payload);
    } else {
        command.args(["x", "-y", "-p-", "-bd", "-bso0", "-bsp0"]);
        command.arg(format!("-o{}", payload.display()));
        command.arg("--");
        command.arg(archive_path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let output = command.output().map_err(|e| {
        CommandError::new(
            "RAR_TOOL_FAILED",
            format!("无法运行 {}：{e}", tool.display()),
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let detail = detail.chars().take(600).collect::<String>();
        return Err(CommandError::new(
            "RAR_EXTRACT",
            if detail.is_empty() {
                format!("{} 解压失败（退出码 {:?}）。", tool.display(), output.status.code())
            } else {
                format!("{} 解压失败：{detail}", tool.display())
            },
        ));
    }

    normalize_external_payload(payload)
}

pub(crate) fn find_archive_tool(configured: &str) -> Option<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    for env in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(env) {
            let base = PathBuf::from(base);
            candidates.push(base.join("7-Zip").join("7z.exe"));
            candidates.push(base.join("Programs").join("7-Zip").join("7z.exe"));
            candidates.push(base.join("WinRAR").join("UnRAR.exe"));
        }
    }
    candidates.push(PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files\WinRAR\UnRAR.exe"));
    // Some NVIDIA driver packages ship 7z.exe; it is a normal console build.
    candidates.push(PathBuf::from(
        r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe",
    ));
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Some(path);
    }

    for name in ["7z.exe", "7za.exe", "7zr.exe", "UnRAR.exe"] {
        if let Ok(path) = which(name) {
            return Some(path);
        }
    }
    None
}

pub(crate) fn which(name: &str) -> Result<PathBuf, std::io::Error> {
    let output = std::process::Command::new("where").arg(name).output()?;
    if !output.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{name} not found"),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "empty where output"))
}

/// Validate files produced by an external extractor. The wrapper directory is
/// not moved here: the caller keeps it as the payload root, which avoids
/// Windows "access denied" errors caused by renaming a directory tree that an
/// extractor just closed.
fn normalize_external_payload(payload: &Path) -> AppResult<usize> {
    let mut files: Vec<String> = Vec::new();
    let mut total: u64 = 0;
    for entry in WalkDir::new(payload).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_dir() {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| {
            CommandError::new("ARCHIVE_INSPECT", format!("无法检查解压文件：{e}"))
        })?;
        if entry.file_type().is_symlink() {
            return Err(CommandError::new(
                "ARCHIVE_SYMLINK_ENTRY",
                format!("压缩包内含符号链接，已拒绝：{}", entry.path().display()),
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(CommandError::new(
                    "ARCHIVE_SYMLINK_ENTRY",
                    format!("压缩包内含重解析点，已拒绝：{}", entry.path().display()),
                ));
            }
        }
        let relative = entry
            .path()
            .strip_prefix(payload)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if relative.starts_with("__MACOSX/") || relative.ends_with(".DS_Store") {
            continue;
        }
        total = total.saturating_add(metadata.len());
        if total > MAX_UNCOMPRESSED {
            return Err(CommandError::new(
                "ARCHIVE_TOO_LARGE",
                "解压后体积超过 8 GB，已停止导入。",
            ));
        }
        files.push(relative);
    }
    if files.len() > MAX_ENTRIES {
        return Err(CommandError::new(
            "ARCHIVE_TOO_MANY_FILES",
            format!("压缩包包含 {} 个条目，超过安全上限 {MAX_ENTRIES}。", files.len()),
        ));
    }
    Ok(files.iter().filter(|relative| !is_doc_only(relative)).count())
}

/// Locate the real mod root inside a possibly badly wrapped archive.
///
/// Some authors ship `Wrapper/ActualMod/archive/...` or
/// `Wrapper/ActualMod/info.json`; some add three nested folders. We score every
/// directory by the game-root anchors directly inside it and pick the
/// shallowest highest-scoring one. A tie at the same depth means the archive
/// contains more than one mod root; silently choosing one would drop files, so
/// that case is rejected.
pub(crate) fn refine_payload_root(payload: &Path) -> AppResult<PathBuf> {
    let mut candidates: Vec<(i32, usize, PathBuf)> = Vec::new();
    for entry in WalkDir::new(payload)
        .min_depth(0)
        .max_depth(6)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_dir() {
            continue;
        }
        let mut score = 0i32;
        if let Ok(children) = fs::read_dir(entry.path()) {
            for child in children.flatten() {
                let name = child.file_name().to_string_lossy().to_ascii_lowercase();
                let is_file = child.file_type().map(|kind| kind.is_file()).unwrap_or(false);
                if is_file && name == "info.json" {
                    score += 5;
                } else if is_file && name == "init.lua" {
                    score += 2;
                } else if is_file
                    && matches!(
                        name.rsplit('.').next().unwrap_or_default(),
                        "archive" | "xl" | "xlp" | "reds" | "lua"
                    )
                {
                    score += 1;
                } else if child.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                    && RECOGNIZED_ROOTS.iter().any(|root| root.eq_ignore_ascii_case(&name))
                {
                    score += 3;
                }
            }
        }
        if score > 0 {
            candidates.push((score, entry.depth(), entry.path().to_path_buf()));
        }
    }

    if candidates.is_empty() {
        return Ok(payload.to_path_buf());
    }
    let best_score = candidates.iter().map(|(score, _, _)| *score).max().unwrap_or(0);
    let mut best: Vec<(usize, PathBuf)> = candidates
        .into_iter()
        .filter(|(score, _, _)| *score == best_score)
        .map(|(_, depth, path)| (depth, path))
        .collect();
    best.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

    if best.len() > 1 {
        let names: Vec<String> = best
            .iter()
            .take(3)
            .map(|(_, path)| {
                path.strip_prefix(payload)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        return Err(CommandError::new(
            "LAYOUT_AMBIGUOUS",
            format!(
                "压缩包里有多个可安装根目录（{}）。启动器不想替你猜、也不想漏掉文件；请分别打包后再导入。",
                names.join("、")
            ),
        ));
    }
    Ok(best[0].1.clone())
}

fn materialize_staging(temp_parent: &Path, staging_parent: &Path) -> std::io::Result<()> {
    // Do not rename the whole tree: Windows can deny renaming a directory that
    // contains nested directories under a restrictive ACL. Moving individual
    // files is allowed, preserves hard-link semantics, and works on every
    // profile we have seen. The temporary tree is removed best-effort after.
    fs::create_dir_all(staging_parent)?;
    for entry in WalkDir::new(temp_parent).min_depth(1).into_iter() {
        let entry = entry?;
        let relative = entry
            .path()
            .strip_prefix(temp_parent)
            .unwrap_or(entry.path());
        let target = staging_parent.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::rename(entry.path(), &target) {
            Ok(()) => {}
            Err(_) => {
                fs::copy(entry.path(), &target)?;
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = fs::remove_dir_all(temp_parent);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn finalize_install(
    source: &Path,
    payload: &Path,
    temp_parent: &Path,
    staging_parent: &Path,
    id: String,
    file_count: usize,
    nexus: Option<crate::schema::NexusRef>,
) -> AppResult<ModEntry> {
    let info = read_info_json(payload);
    let layout = detect_layout(payload)?;
    let fallback_name = source
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("Imported Mod");
    // info.json 给了名字就直接用（那是作者自己定的写法，不能再改）；否则退回
    // 压缩包名，并走一遍展示名清洗 —— 玩家手里的包名普遍是 `!!!!_mime.archive`
    // 这种把装饰符当排序键的写法，原样上列表没法读。
    let info_name = info
        .as_ref()
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let name = info_name
        .clone()
        .unwrap_or_else(|| fallback_name.to_string());
    let (display_name, raw_name) = match info_name {
        Some(value) => (value, None),
        None => (crate::modname::polish(&name), Some(name.clone())),
    };
    let version = info
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(value_to_string);
    let author = info
        .as_ref()
        .and_then(|v| v.get("author"))
        .and_then(value_to_string);
    let description = info
        .as_ref()
        .and_then(|v| v.get("description"))
        .and_then(value_to_string)
        .unwrap_or_default();

    let mod_folder = match layout {
        InstallLayout::Redmod | InstallLayout::Cet | InstallLayout::Redscript => Some(
            sanitize_folder(&name, &format!("mod-{}", &id[id.len().saturating_sub(6)..])),
        ),
        _ => None,
    };

    let cover = find_cover(payload).and_then(|path| {
        path.strip_prefix(payload)
            .ok()
            .map(|relative| relative.to_path_buf())
    });
    let size_bytes = dir_size(payload);
    let mut warnings = Vec::new();
    // 布局筛掉的文件必须显式告知：混合包（archive + redscript）最容易被静默丢一半。
    let (skipped_total, skipped_sample, skipped_hint) = layout_skipped(payload, &layout, 3);
    if skipped_total > 0 {
        warnings.push(format!(
            "有 {skipped_total} 个文件不属于「{skipped_hint}」布局，部署时会跳过：{}{}。如果这是多框架合集包，请把各部分拆开分别安装。",
            skipped_sample.join("、"),
            if skipped_total > skipped_sample.len() {
                " 等"
            } else {
                ""
            }
        ));
    }
    if matches!(layout, InstallLayout::Redmod) {
        warnings.push("REDmod 需要游戏以 -modded 参数启动；启动器会在部署后提示。".to_string());
    }

    materialize_staging(temp_parent, staging_parent).map_err(|e| {
        CommandError::new("STAGING_MOVE", format!("无法把解压内容移动到暂存区：{e}"))
    })?;
    let payload_rel = payload        .strip_prefix(temp_parent)
        .unwrap_or_else(|_| Path::new("payload"));
    let final_payload = staging_parent.join(payload_rel);

    // 先把官方封面摘出来：结构体初始化时 nexus 会被整体 move 进去。
    let nexus_cover_url = nexus.as_ref().and_then(|item| item.picture_url.clone());
    // 分类先用「名字 + 顶层文件夹 + 布局」猜一版；拿到 planned_files 之后
    // 会再用内容证据覆写一次（见本函数末尾）。这里要赶在 name 被 move 之前算好。
    let initial_category = crate::category::infer(&crate::category::Signals {
        name: &name,
        folder: mod_folder.as_deref().unwrap_or(""),
        layout: &layout,
        paths: &[],
    });
    let mut entry = ModEntry {
        id: id.clone(),
        name: display_name,
        raw_name,
        version,
        author,
        category: initial_category,
        // 刚导入的模组还没人手动指定分类，交给启发式推断。
        category_locked: false,
        description,
        source_zip: Some(source.to_string_lossy().to_string()),
        nexus,
        nexus_cover_url,
        staging_path: final_payload.to_string_lossy().to_string(),
        cover_path: cover.map(|relative| {
            final_payload
                .join(relative)
                .to_string_lossy()
                .to_string()
        }),
        enabled: false,
        installed_at: now_iso(),
        updated_at: None,
        size_bytes,
        file_count,
        has_archive: layout_has_archive(&layout, &final_payload),
        has_redmod: layout == InstallLayout::Redmod,
        has_cet: layout == InstallLayout::Cet || payload_has_cet(&final_payload),
        layout,
        mod_folder,
        metadata_source: if info.is_some() {
            "infoJson".to_string()
        } else {
            "filename".to_string()
        },
        planned_files: Vec::new(),
        warnings,
        deployed_files: Vec::new(),
        // 单独导入的 Mod 天然由本启动器托管；origin 记为 cyberdeck。
        // 旧版「本地大 ZIP 整合包」展开出来的副本曾带 modpack + modpack_id；
        // 该功能已废弃（改为 Nexus Collections 清单），这里只保留字段兼容旧数据。
        translated_name: None,
        translated_at: None,
        translated_by: None,
        managed: true,
        origin: "cyberdeck".to_string(),
        modpack_id: None,
        // 初判放在拿到 planned_files 之后（那里能顺便扫非文本资源），
        // 这里先占位，保证结构体初始化时字段齐全。
        is_translation: false,
        parent_mod_id: None,
        ai_loc: None,
        ai_fix: Vec::new(),
    };
    // Cache the planned target paths now. It makes bootstrap-time conflict
    // checks O(files) instead of walking every staged mod on every refresh.
    if let Ok(plan) = plan_for(&entry) {
        entry.planned_files = plan.into_iter().map(|file| file.relative).collect();
    }
    // 附属汉化包识别：只看名字/压缩包名，误判成本低（用户在绑定弹窗里可改），
    // 漏判成本高（汉化包会被当成"重复 Mod"亮红灯，玩家直接不敢装）。
    let zip_name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    entry.is_translation = crate::translation::looks_like_translation([&entry.name, &zip_name]);
    // 自称汉化却带了模型/贴图/实体资源 → 这不是纯汉化，部署前必须提醒。
    if let Some(warning) = crate::translation::translation_warning(&entry.planned_files) {
        entry.warnings.push(warning);
    }

    // 有了真实文件路径，用内容证据再判一次分类：
    // 「装了一堆 character/ 下的 .archive」比模组名叫什么可靠得多。
    if !entry.planned_files.is_empty() {
        let refined = crate::category::infer(&crate::category::Signals {
            name: &entry.name,
            folder: entry.mod_folder.as_deref().unwrap_or(""),
            layout: &entry.layout,
            paths: &entry.planned_files,
        });
        entry.category = refined;
    }
    Ok(entry)
}

pub(crate) fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

pub(crate) fn read_info_json(payload: &Path) -> Option<Value> {
    let path = find_case_insensitive(payload, "info.json")?;
    let metadata = fs::metadata(&path).ok()?;
    if metadata.len() > 512 * 1024 {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let raw = raw.trim_start_matches('\u{feff}');
    serde_json::from_str(raw).ok()
}

fn find_case_insensitive(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(name)
        {
            return Some(entry.path());
        }
    }
    None
}

fn detect_strip_prefix(paths: &[String]) -> Option<String> {
    let mut top_dirs: HashSet<String> = HashSet::new();
    let mut top_files: Vec<String> = Vec::new();
    for path in paths {
        let mut parts = path.split('/');
        let first = parts.next()?;
        if parts.next().is_some() {
            top_dirs.insert(first.to_string());
        } else {
            top_files.push(first.to_string());
        }
    }
    if top_dirs.len() != 1 {
        return None;
    }
    let dir = top_dirs.into_iter().next()?;
    if RECOGNIZED_ROOTS
        .iter()
        .any(|root| root.eq_ignore_ascii_case(&dir))
    {
        return None;
    }
    if top_files.is_empty() || top_files.iter().all(|file| is_doc_only(file)) {
        Some(format!("{dir}/"))
    } else {
        None
    }
}

fn is_doc_only(relative: &str) -> bool {
    let lower = relative.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    name == "readme.txt"
        || name == "readme.md"
        || name == "license"
        || name == "license.txt"
        || name == "changelog.txt"
        || name.ends_with(".url")
        || name.starts_with('.')
}

pub(crate) fn detect_layout(payload: &Path) -> AppResult<InstallLayout> {
    if !payload.is_dir() {
        return Err(CommandError::new("STAGING_MISSING", "暂存区不存在。"));
    }
    let files: Vec<String> = WalkDir::new(payload)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            entry
                .path()
                .strip_prefix(payload)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    let lower: Vec<String> = files.iter().map(|v| v.to_ascii_lowercase()).collect();

    let has_game_root = lower.iter().any(|path| {
        path.starts_with("archive/pc/mod/")
            || path.starts_with("r6/scripts/")
            || path.starts_with("bin/x64/plugins/")
            || path.starts_with("red4ext/plugins/")
            || path.starts_with("engine/tools/")
    });
    if has_game_root {
        return Ok(InstallLayout::GameRoot);
    }
    if lower.iter().any(|path| path == "info.json") {
        return Ok(InstallLayout::Redmod);
    }

    let archive_count = lower
        .iter()
        .filter(|path| {
            path.ends_with(".archive") || path.ends_with(".xl") || path.ends_with(".xlp")
        })
        .count();
    let reds_count = lower.iter().filter(|path| path.ends_with(".reds")).count();
    let lua_count = lower.iter().filter(|path| path.ends_with(".lua")).count();

    if archive_count > 0 {
        return Ok(InstallLayout::Archive);
    }
    if reds_count > 0 {
        return Ok(InstallLayout::Redscript);
    }
    if lua_count > 0 {
        return Ok(InstallLayout::Cet);
    }
    if lower.iter().any(|path| {
        path.starts_with("archive/")
            || path.starts_with("bin/")
            || path.starts_with("r6/")
            || path.starts_with("red4ext/")
            || path.starts_with("engine/")
            || path.starts_with("mods/")
    }) {
        return Ok(InstallLayout::GameRoot);
    }

    Err(CommandError::new(
        "LAYOUT_UNKNOWN",
        "无法判断这个模组要装到哪里。支持的布局：\n\
         • 完整游戏目录结构（archive/、r6/、bin/、red4ext/）\n\
         • 独立 .archive / .xl 文件\n\
         • 带 info.json 的 REDmod\n\
         • CET（init.lua）或 redscript（.reds）\n\
         请查看压缩包结构后重试；启动器不会把未知文件硬塞进游戏目录。",
    ))
}

/// Rebuild a broken staging directory from files that this exact entry deployed.
///
/// This is intentionally narrower than adopting arbitrary game files: the manifest,
/// old staging-relative path, size and modification time must all agree. Recovery
/// always copies bytes, never hard-links the live game file back into staging.
/// The caller persists the returned source paths only after the whole set succeeds.
fn recover_staging(store: &Store, entry: &mut ModEntry, game_root: &Path) -> AppResult<bool> {
    let old_root = PathBuf::from(&entry.staging_path);
    if old_root.is_dir() || entry.deployed_files.is_empty() {
        return Ok(false);
    }
    if entry.origin != "adopted" && entry.source_zip.is_some() {
        return Ok(false);
    }
    let next_root = store.staging_dir().join(sanitize_folder(&entry.id, "recovered"));
    if next_root.exists() {
        return Err(CommandError::new(
            "STAGING_RECOVERY_CONFLICT",
            format!("恢复目标已存在，请先检查暂存目录：{}", next_root.display()),
        ));
    }
    let mut recovered: Vec<(usize, PathBuf, PathBuf)> = Vec::new();
    for (index, file) in entry.deployed_files.iter().enumerate() {
        let target = safe_join(game_root, &file.relative_path)?;
        if !target.is_file() {
            return Err(CommandError::new(
                "STAGING_RECOVERY_SOURCE_MISSING",
                format!("无法恢复暂存：原部署文件已不存在：{}", file.relative_path),
            ));
        }
        let (size, modified) = file_stamp(&target);
        if file.size.is_none()
            || file.modified_time.is_none()
            || file.size != size
            || file.modified_time != modified
        {
            return Err(CommandError::new(
                "STAGING_RECOVERY_CHANGED",
                format!("原部署文件已变化或缺少校验信息，拒绝自动恢复：{}", file.relative_path),
            ));
        }
        let old_source = PathBuf::from(&file.source);
        let relative = old_source.strip_prefix(&old_root).ok().map(Path::to_path_buf)
            .or_else(|| {
                if entry.origin == "adopted" && entry.layout == InstallLayout::Archive {
                    Path::new(&file.relative_path).file_name().map(PathBuf::from)
                } else {
                    None
                }
            })
            .ok_or_else(|| CommandError::new(
                "STAGING_RECOVERY_UNOWNED",
                format!("暂存源路径不属于这个模组：{}", file.source),
            ))?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        let destination = safe_join(&next_root, &relative)?;
        recovered.push((index, target, destination));
    }
    let result = (|| -> AppResult<()> {
        for (_, source, destination) in &recovered {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source, destination).map_err(|err| CommandError::new(
                "STAGING_RECOVERY_COPY",
                format!("恢复暂存副本失败 {}：{err}", source.display()),
            ))?;
        }
        entry.staging_path = next_root.to_string_lossy().to_string();
        let expected: HashSet<String> = entry.deployed_files.iter()
            .map(|file| file.relative_path.to_ascii_lowercase()).collect();
        let planned: HashSet<String> = plan_for(entry)?.into_iter()
            .map(|file| file.relative.to_ascii_lowercase()).collect();
        if planned != expected {
            return Err(CommandError::new(
                "STAGING_RECOVERY_PLAN_MISMATCH",
                "恢复后的文件清单与原部署清单不一致，未启用恢复结果。",
            ));
        }
        for (index, _, destination) in recovered {
            entry.deployed_files[index].source = destination.to_string_lossy().to_string();
            // A copy has no hard-link identity with the old game-side file.
            entry.deployed_files[index].link_type = LinkType::Copy;
        }
        entry.warnings.push("已从原部署清单恢复暂存副本，游戏目录原文件未被改动。".to_string());
        entry.updated_at = Some(now_iso());
        Ok(())
    })();
    if result.is_err() && is_within(&store.staging_dir(), &next_root) {
        let _ = fs::remove_dir_all(&next_root);
    }
    result.map(|_| true)
}

pub(crate) fn plan_for(entry: &ModEntry) -> AppResult<Vec<PlanFile>> {
    let payload = PathBuf::from(&entry.staging_path);
    if !payload.is_dir() {
        return Err(CommandError::new(
            "STAGING_MISSING",
            "这个模组的暂存文件不见了，请重新导入 ZIP。",
        ));
    }
    let mut plan = Vec::new();
    let folder = entry.mod_folder.clone().unwrap_or_else(|| {
        sanitize_folder(&entry.name, &entry.id[..entry.id.len().min(12)])
    });

    for item in WalkDir::new(&payload)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|item| item.file_type().is_file())
    {
        let relative = item
            .path()
            .strip_prefix(&payload)
            .unwrap_or(item.path())
            .to_string_lossy()
            .replace('\\', "/");
        if is_doc_only(&relative) {
            continue;
        }
        let lower = relative.to_ascii_lowercase();
        let target_rel = match entry.layout {
            InstallLayout::GameRoot => {
                let first = lower.split('/').next().unwrap_or_default();
                if !RECOGNIZED_ROOTS.contains(&first) {
                    continue;
                }
                relative.clone()
            }
            InstallLayout::Archive => {
                if !(lower.ends_with(".archive")
                    || lower.ends_with(".xl")
                    || lower.ends_with(".xlp"))
                {
                    continue;
                }
                let filename = relative.rsplit('/').next().unwrap_or(&relative);
                format!("archive/pc/mod/{filename}")
            }
            InstallLayout::Redmod => format!("mods/{folder}/{relative}"),
            InstallLayout::Cet => format!(
                "bin/x64/plugins/cyber_engine_tweaks/mods/{folder}/{relative}"
            ),
            InstallLayout::Redscript => format!("r6/scripts/{folder}/{relative}"),
        };
        plan.push(PlanFile {
            source: item.path().to_path_buf(),
            relative: target_rel,
        });
    }

    if plan.is_empty() {
        return Err(CommandError::new(
            "NOTHING_TO_DEPLOY",
            "这个模组没有可部署的文件。",
        ));
    }
    Ok(plan)
}

/// 布局标签（中文），用于给用户看的提示文案。
fn layout_label(layout: &InstallLayout) -> &'static str {
    match layout {
        InstallLayout::GameRoot => "完整游戏目录结构",
        InstallLayout::Archive => "独立 archive",
        InstallLayout::Redmod => "REDmod",
        InstallLayout::Cet => "CET",
        InstallLayout::Redscript => "redscript",
    }
}

/// 统计「按当前布局部署时会被跳过」的文件。
///
/// `plan_for` 对不同布局只收自己认识的文件：GameRoot 要求首段在 `RECOGNIZED_ROOTS` 里，
/// Archive 只要 `.archive/.xl/.xlp`。跳过本身是对的（不能把 .reds 塞进 archive/pc/mod），
/// 但**过去完全静默**——混合包装完少一半文件却一条提示都没有（2026-10-30 自检 P1-2）。
/// 这里把跳过项统计出来，供导入与部署两处拼进 warning。
///
/// 返回 `(总数, 前 sample_limit 个文件名, 布局标签)`。
fn layout_skipped(payload: &Path, layout: &InstallLayout, sample_limit: usize) -> (usize, Vec<String>, &'static str) {
    let label = layout_label(layout);
    // REDmod / CET / redscript 三种布局 plan_for 收下全部非文档文件，不存在跳过。
    if matches!(
        layout,
        InstallLayout::Redmod | InstallLayout::Cet | InstallLayout::Redscript
    ) {
        return (0, Vec::new(), label);
    }
    let mut total = 0usize;
    let mut sample: Vec<String> = Vec::new();
    for item in WalkDir::new(payload)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|item| item.file_type().is_file())
    {
        let relative = item
            .path()
            .strip_prefix(payload)
            .unwrap_or(item.path())
            .to_string_lossy()
            .replace('\\', "/");
        if is_doc_only(&relative) {
            continue;
        }
        let lower = relative.to_ascii_lowercase();
        let kept = match layout {
            InstallLayout::GameRoot => {
                let first = lower.split('/').next().unwrap_or_default();
                RECOGNIZED_ROOTS.contains(&first)
            }
            InstallLayout::Archive => {
                lower.ends_with(".archive") || lower.ends_with(".xl") || lower.ends_with(".xlp")
            }
            // 上面已提前返回。
            InstallLayout::Redmod | InstallLayout::Cet | InstallLayout::Redscript => true,
        };
        if !kept {
            total += 1;
            if sample.len() < sample_limit {
                sample.push(relative);
            }
        }
    }
    (total, sample, label)
}

pub(crate) fn layout_has_archive(layout: &InstallLayout, payload: &Path) -> bool {
    if matches!(layout, InstallLayout::Archive) {
        return true;
    }
    WalkDir::new(payload)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|v| v.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("archive"))
                    .unwrap_or(false)
        })
}

pub(crate) fn payload_has_cet(payload: &Path) -> bool {
    WalkDir::new(payload)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase()
                    .contains("cyber_engine_tweaks")
        })
}

pub(crate) fn find_cover(payload: &Path) -> Option<PathBuf> {
    let preferred = ["cover", "preview", "thumbnail", "banner"];
    let mut candidates: Vec<(u8, u64, PathBuf)> = Vec::new();
    for entry in WalkDir::new(payload).max_depth(3).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|v| v.to_str())
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        let rank = preferred
            .iter()
            .position(|wanted| stem.contains(wanted))
            .map(|index| index as u8)
            .unwrap_or(9);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > 0 && size <= 16 * 1024 * 1024 {
            candidates.push((rank, size, path.to_path_buf()));
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
    candidates.into_iter().next().map(|(_, _, path)| path)
}

pub(crate) fn dir_size(root: &Path) -> u64 {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok().map(|m| m.len()))
        .sum()
}

/// r22：分类全部交给 `category` 模块（内容证据 > 名称 > 布局）。
///
/// 这里刻意**不看 description**：收编出来的模组描述是同一句模板
/// 「由外部工具（如 Vortex）部署…」，里面带「工具」二字，
/// 旧实现把它拼进关键词海，一次「智能归类」就把 168 个模组全打成了工具。
///
/// - `all = false`：只重算「其他」与「工具」这两类兜底值（库页「智能归类」走这条）；
/// - `all = true`：重算全部，但**跳过用户手动改过的条目**（`category_locked`），
///   否则玩家刚改完分类，下次一键重算又被机器覆盖。
pub(crate) fn reclassify(store: &Store, all: bool) -> AppResult<usize> {
    // ① 短锁：只读快照，不做任何磁盘 IO。
    type Row = (String, String, String, InstallLayout, String, Vec<String>, String);
    let rows: Vec<Row> = {
        let data = store.data.lock().expect("state mutex poisoned");
        data.mods
            .iter()
            .filter(|entry| !entry.category_locked)
            .filter(|entry| all || entry.category == "其他" || entry.category == "工具")
            .map(|entry| {
                (
                    entry.id.clone(),
                    entry.name.clone(),
                    entry.category.clone(),
                    entry.layout.clone(),
                    entry.mod_folder.clone().unwrap_or_default(),
                    entry.planned_files.clone(),
                    entry.staging_path.clone(),
                )
            })
            .collect()
    };

    // ② 无锁：可能要给没有路径缓存的老条目扫一遍暂存区，绝不能在持锁时做。
    let mut updates: Vec<(String, String)> = Vec::new();
    for (id, name, current, layout, folder, planned, staging_path) in rows {
        let scanned;
        let paths: &[String] = if planned.is_empty() {
            scanned = crate::category::scan_staging(&staging_path);
            &scanned
        } else {
            &planned
        };
        let next = crate::category::infer(&crate::category::Signals {
            name: &name,
            folder: &folder,
            layout: &layout,
            paths,
        });
        if next != current {
            updates.push((id, next));
        }
    }

    // ③ 短锁写内存 + ④ 落盘
    if updates.is_empty() {
        return Ok(0);
    }
    let mut data = store.data.lock().expect("state mutex poisoned");
    let stamp = crate::store::now_iso();
    let mut changed = 0;
    for (id, next) in &updates {
        if let Some(entry) = data.mods.iter_mut().find(|entry| &entry.id == id) {
            entry.category = next.clone();
            entry.updated_at = Some(stamp.clone());
            changed += 1;
        }
    }
    if changed > 0 {
        store.save(&data)?;
    }
    Ok(changed)
}

/// 手动指定分类：写入后打上 `category_locked`，之后任何自动重算都不再碰它。
pub(crate) fn set_category(store: &Store, mod_id: &str, category: &str) -> AppResult<String> {
    const ALLOWED: [&str; 10] = [
        "框架", "玩法", "武器", "服装", "车辆", "视觉", "音频", "任务", "工具", "其他",
    ];
    if !ALLOWED.contains(&category) {
        return Err(CommandError::new(
            "CATEGORY_INVALID",
            format!("未知的分类：{category}"),
        ));
    }
    let mut data = store.data.lock().expect("state mutex poisoned");
    let entry = data
        .mods
        .iter_mut()
        .find(|entry| entry.id == mod_id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
    entry.category = category.to_string();
    // 手动指定即锁定：用户改过的分类优先级最高，高于任何启发式推断。
    entry.category_locked = true;
    entry.updated_at = Some(crate::store::now_iso());
    store.save(&data)?;
    Ok(category.to_string())
}

/// 批量手动指定分类（P6 UI）。语义与单条一致：**写入即锁定**，
/// 但只落一次盘 —— 选择 200 个模组时逐条 save 会把状态文件写 200 遍。
pub(crate) fn set_categories(
    store: &Store,
    mod_ids: &[String],
    category: &str,
) -> AppResult<usize> {
    const ALLOWED: [&str; 10] = [
        "框架", "玩法", "武器", "服装", "车辆", "视觉", "音频", "任务", "工具", "其他",
    ];
    if !ALLOWED.contains(&category) {
        return Err(CommandError::new(
            "CATEGORY_INVALID",
            format!("未知的分类：{category}"),
        ));
    }
    if mod_ids.is_empty() {
        return Ok(0);
    }
    let mut data = store.data.lock().expect("state mutex poisoned");
    let stamp = crate::store::now_iso();
    let mut changed = 0usize;
    for id in mod_ids {
        if let Some(entry) = data.mods.iter_mut().find(|entry| &entry.id == id) {
            entry.category = category.to_string();
            entry.category_locked = true;
            entry.updated_at = Some(stamp.clone());
            changed += 1;
        }
    }
    if changed > 0 {
        store.save(&data)?;
    }
    Ok(changed)
}

pub fn deploy_mod(store: &Store, mod_id: &str, game: &GameInfo) -> AppResult<DeployReport> {
    let game_info = validate_game_dir(Path::new(&game.root))?;
    let game_root = PathBuf::from(&game_info.root);
    let mut state = store.data.lock().expect("state mutex poisoned");
    let index = state
        .mods
        .iter()
        .position(|item| item.id == mod_id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;

    let mut entry = state.mods[index].clone();
    let old_order = state.load_order.clone();
    // 部署方式（deepseek 任务·模块一）：clone 出来避免后续可变借用冲突。
    let deploy_mode = state.settings.deploy_mode.clone();
    if !Path::new(&entry.staging_path).is_dir() && !entry.deployed_files.is_empty() {
        if recover_staging(store, &mut entry, &game_root)? {
            state.mods[index] = entry.clone();
            store.save(&state)?;
            if entry.enabled {
                return Ok(report(entry, 0, 0, 0, 0, vec![
                    "已从原部署清单恢复暂存副本，游戏目录原文件未被改动。".to_string(),
                ]));
            }
        }
    }
    if entry.enabled && !entry.deployed_files.is_empty() {
        return Ok(report(entry, 0, 0, 0, 0, Vec::new()));
    }

    let plan = match plan_for(&entry) {
        Ok(plan) => plan,
        Err(err) if err.code == "STAGING_MISSING" => {
            if recover_staging(store, &mut entry, &game_root)? {
                state.mods[index] = entry.clone();
                store.save(&state)?;
                plan_for(&entry)?
            } else {
                // 源文件在外部被删了（Vortex 清理、手动删目录）。这不是用户的
                // 操作失误，弹红框只会让人反复点重试：清掉残留链接和失效记录，
                // 让界面直接回到「库里没这个东西」的状态。
                let mut notes = purge_links(&entry, &game_root);
                notes.insert(
                    0,
                    "该模组实体文件已被外部删除，系统已自动清理失效记录。".to_string(),
                );
                forget_mod(&mut state, &entry);
                store.save(&state)?;
                return Ok(DeployReport {
                    purged: true,
                    ..report(entry, 0, 0, 0, 0, notes)
                });
            }
        }
        Err(err) => return Err(err),
    };
    // 回滚基准必须在恢复之后取：否则部署中途失败会把已经修好的暂存路径
    // 写回失效值，而恢复出的副本还留在磁盘上，下次恢复又会撞「目标已存在」。
    let old_entry = entry.clone();
    let mut seen: HashMap<String, String> = HashMap::new();
    for file in &plan {
        let key = file.relative.to_ascii_lowercase();
        if seen.insert(key, file.relative.clone()).is_some() {
            return Err(CommandError::new(
                "PLAN_DUPLICATE",
                format!("模组内有多个文件会写到同一目标：{}", file.relative),
            ));
        }
    }

    let conflicts = find_conflicts(&state.mods, &game_root, &plan, &entry.id);
    if !conflicts.is_empty() {
        return Err(CommandError::new(
            "DEPLOY_CONFLICT",
            format!(
                "部署被拦住：{} 个目标文件已被占用（{} 个来自其它模组，{} 个是游戏/手动文件）。",
                conflicts.len(),
                conflicts
                    .iter()
                    .filter(|c| c.kind == "managed")
                    .count(),
                conflicts
                    .iter()
                    .filter(|c| c.kind == "unmanaged")
                    .count()
            ),
        )
        .with_conflicts(conflicts));
    }

    if state.settings.auto_backup && state.backup.is_none() {
        crate::backup::ensure_backup(store, &game_root, &mut state)?;
    }

    let mut deployed: Vec<DeployedFile> = Vec::new();
    let mut created: Vec<PathBuf> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    // 部署时再报一次：模组可能是旧版导入的，导入时那条 warning 早被用户划过去了。
    let (skipped_total, skipped_sample, skipped_hint) =
        layout_skipped(Path::new(&entry.staging_path), &entry.layout, 3);
    if skipped_total > 0 {
        warnings.push(format!(
            "有 {skipped_total} 个文件不属于「{skipped_hint}」布局，已跳过：{}{}。",
            skipped_sample.join("、"),
            if skipped_total > skipped_sample.len() {
                " 等"
            } else {
                ""
            }
        ));
    }
    let mut hard_links = 0usize;
    let mut symlinks = 0usize;
    let mut copies = 0usize;

    let apply_result = (|| -> AppResult<()> {
        for file in &plan {
            let target = safe_join(&game_root, &file.relative)?;
            if target.exists() {
                return Err(CommandError::new(
                    "DEPLOY_RACE",
                    format!("目标在部署过程中被占用：{}", file.relative),
                ));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    CommandError::new(
                        "MKDIR_FAILED",
                        format!("无法创建目录 {}：{e}", parent.display()),
                    )
                })?;
            }
            let (link, link_notes) = create_link_with_mode(&file.source, &target, &deploy_mode)
                .map_err(|e| CommandError::new("LINK_FAILED", e))?;
            // 降级说明只报一次：同一个包里几十个文件都降级时，逐条推会刷屏。
            for note in link_notes {
                if !warnings.iter().any(|existing| existing == &note) {
                    warnings.push(note);
                }
            }
            match link {
                LinkType::HardLink => hard_links += 1,
                LinkType::Symlink => symlinks += 1,
                LinkType::Copy => copies += 1,
            }
            created.push(target.clone());
            // 记下部署那一刻的大小与时间，供「环境体检」事后比对。
            let stamp = file_stamp(&target);
            deployed.push(DeployedFile {
                source: file.source.to_string_lossy().to_string(),
                target: target.to_string_lossy().to_string(),
                link_type: link,
                relative_path: file.relative.clone(),
                size: stamp.0,
                modified_time: stamp.1,
            });
        }
        Ok(())
    })();

    if let Err(err) = apply_result {
        for target in created.iter().rev() {
            let is_symlink = fs::symlink_metadata(target)
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
            let _ = remove_link_or_copy(target, is_symlink);
            prune_empty_dirs(target.parent(), &game_root);
        }
        return Err(err);
    }

    if copies > 0 {
        warnings.push(format!(
            "{copies} 个文件因跨盘或符号链接权限不足被复制；卸载时只删除游戏目录副本。"
        ));
    }
    if symlinks > 0 {
        warnings.push(format!("{symlinks} 个文件使用符号链接部署。"));
    }

    entry.enabled = true;
    entry.deployed_files = deployed;
    entry.updated_at = Some(now_iso());
    state.mods[index] = entry.clone();
    append_to_load_order(&mut state, &entry);
    if state.settings.write_modlist {
        if let Err(err) = crate::loadorder::write_modlist(&state, &game_root) {
            warnings.push(format!("模组已部署，但写入 modlist.txt 失败：{err}"));
        }
    }
    if let Err(err) = store.save(&state) {
        // State persistence is the commit point. If it fails, remove the files we
        // just created so the game directory does not keep phantom deployments.
        for file in entry.deployed_files.iter().rev() {
            let _ = remove_link_or_copy(
                Path::new(&file.target),
                file.link_type == LinkType::Symlink,
            );
            prune_empty_dirs(Path::new(&file.target).parent(), &game_root);
        }
        state.mods[index] = old_entry;
        state.load_order = old_order;
        if state.settings.write_modlist {
            let _ = crate::loadorder::write_modlist(&state, &game_root);
        }
        return Err(err);
    }
    Ok(report(
        entry,
        plan.len(),
        hard_links,
        symlinks,
        copies,
        warnings,
    ))
}

fn report(
    entry: ModEntry,
    deployed: usize,
    hard_links: usize,
    symlinks: usize,
    copies: usize,
    warnings: Vec<String>,
) -> DeployReport {
    DeployReport {
        mod_entry: entry,
        deployed,
        hard_links,
        symlinks,
        copies,
        warnings,
        purged: false,
    }
}

/// 读取文件的（大小, 修改时间秒）。读不到就返回 (None, None)，不当作错误。
pub(crate) fn file_stamp(path: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(meta) = fs::metadata(path) else {
        return (None, None);
    };
    let size = Some(meta.len());
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());
    (size, mtime)
}
/// 单测与工具路径共用的默认形态（hardlink）；生产部署统一走 `create_link_with_mode`。
#[allow(dead_code)]
pub fn create_link(source: &Path, target: &Path) -> Result<LinkType, String> {
    create_link_with_mode(source, target, "hardlink").map(|(link, _)| link)
}

/// 按 deploy_mode 落盘（deepseek 任务·模块一）：
/// - hardlink：同卷硬链 → 符号链接 → 复制（默认自动降级链）
/// - symlink：符号链接优先 → 复制（跳过硬链；跨机同步 / 云盘场景需要真符号链接）
/// - copy：直接复制（U 盘 / 频繁整理暂存区的场景，缺点是占双份空间）
/// 注意 symlink 模式下「跨盘复制」的兜底仍在——符号链接本身支持跨盘，失败说明权限不足。
pub fn create_link_with_mode(
    source: &Path,
    target: &Path,
    deploy_mode: &str,
) -> Result<(LinkType, Vec<String>), String> {
    let source = fs::canonicalize(source)
        .map_err(|e| format!("找不到暂存源文件 {}：{e}", source.display()))?;
    // 降级链上每一步失败都值得留痕：GUI 没有控制台，`eprintln!` 等于没日志，
    // 用户只会看到「部署成功但占了两份空间」，排查时无从下手（自检 P2-7）。
    let mut notes = Vec::new();

    if deploy_mode == "copy" {
        fs::copy(&source, target).map_err(|e| format!("复制失败：{e}"))?;
        return Ok((LinkType::Copy, notes));
    }

    if deploy_mode != "symlink" && same_volume(&source, target) {
        match fs::hard_link(&source, target) {
            Ok(()) => return Ok((LinkType::HardLink, notes)),
            Err(err) => notes.push(format!(
                "硬链接创建失败，已降级为符号链接/复制：{err}"
            )),
        }
    }

    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(&source, target).is_ok() {
            return Ok((LinkType::Symlink, notes));
        }
        notes.push(
            "符号链接创建失败（通常是缺少开发者模式或管理员权限），已降级为复制：\
             这会占用双份磁盘空间，卸载时也会整份删除。"
                .to_string(),
        );
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::symlink;
        if symlink(&source, target).is_ok() {
            return Ok((LinkType::Symlink, notes));
        }
    }

    fs::copy(&source, target)
        .map_err(|e| format!("硬链接、符号链接和复制都失败：{e}"))?;
    Ok((LinkType::Copy, notes))
}

pub(crate) fn find_conflicts(
    mods: &[ModEntry],
    game_root: &Path,
    plan: &[PlanFile],
    own_id: &str,
) -> Vec<ConflictInfo> {
    let mut owners: HashMap<String, (&str, &str, &str)> = HashMap::new();
    for entry in mods.iter().filter(|entry| entry.id != own_id && entry.enabled) {
        for file in &entry.deployed_files {
            owners.insert(
                file.relative_path.to_ascii_lowercase(),
                (&entry.id, &entry.name, &file.relative_path),
            );
        }
    }

    let mut conflicts = Vec::new();
    for file in plan {
        let key = file.relative.to_ascii_lowercase();
        if let Some((other_id, other_name, _)) = owners.get(&key) {
            conflicts.push(ConflictInfo {
                target: file.relative.clone(),
                mod_id: own_id.to_string(),
                mod_name: String::new(),
                other_mod_id: Some((*other_id).to_string()),
                other_mod_name: Some((*other_name).to_string()),
                kind: "managed".to_string(),
                pending: false,
            });
            continue;
        }
        let target = safe_join(game_root, &file.relative).unwrap_or_default();
        if !target.as_os_str().is_empty() && target.exists() {
            conflicts.push(ConflictInfo {
                target: file.relative.clone(),
                mod_id: own_id.to_string(),
                mod_name: String::new(),
                other_mod_id: None,
                other_mod_name: None,
                kind: "unmanaged".to_string(),
                pending: false,
            });
        }
    }
    conflicts
}

/// Conflicts caused by two enabled mods claiming the same deployed target.
/// One row is emitted per target/other-mod pair; `find_conflicts` still returns
/// the full candidate view when a deploy is actually blocked.
/// 父子关系表：汉化包 id → 原版 Mod id。
///
/// 冲突判定要用它区分「两个模组抢同一个文件」（真冲突）和
/// 「汉化包覆盖自己父级的文本文件」（合法的语言覆盖，不该亮红灯）。
fn parent_links(mods: &[ModEntry]) -> HashMap<String, String> {
    mods.iter()
        .filter_map(|entry| {
            entry
                .parent_mod_id
                .as_ref()
                .map(|parent| (entry.id.clone(), parent.clone()))
        })
        .collect()
}

/// 两个模组是不是直接父子。只看直接关系——祖孙关系不成立，
/// 因为汉化包下面再挂汉化包属于用户误操作，不该被静默容忍。
fn is_parent_child(parents: &HashMap<String, String>, left: &str, right: &str) -> bool {
    parents.get(left).map(String::as_str) == Some(right)
        || parents.get(right).map(String::as_str) == Some(left)
}

pub fn all_conflicts(mods: &[ModEntry]) -> Vec<ConflictInfo> {
    let mut claims: HashMap<String, Vec<(&ModEntry, &str)>> = HashMap::new();
    for entry in mods.iter().filter(|entry| entry.enabled) {
        for file in &entry.deployed_files {
            claims
                .entry(file.relative_path.to_ascii_lowercase())
                .or_default()
                .push((entry, file.relative_path.as_str()));
        }
    }
    let parents = parent_links(mods);
    let mut conflicts = Vec::new();
    for (_, entries) in claims.into_iter().filter(|(_, entries)| entries.len() > 1) {
        let Some((first, relative)) = entries.first() else {
            continue;
        };
        for (other, _) in entries.iter().filter(|(other, _)| {
            other.id != first.id && !is_parent_child(&parents, &first.id, &other.id)
        }) {
            conflicts.push(ConflictInfo {
                target: (*relative).to_string(),
                mod_id: first.id.clone(),
                mod_name: first.name.clone(),
                other_mod_id: Some(other.id.clone()),
                other_mod_name: Some(other.name.clone()),
                kind: "managed".to_string(),
                pending: false,
            });
        }
    }
    conflicts
}

/// Conflicts that would happen if a staged mod were enabled. This is what makes
/// the conflict counter useful before deployment: the deploy command still does
/// the authoritative preflight, but the UI can show the collision in advance.
pub fn staged_conflicts(mods: &[ModEntry]) -> Vec<ConflictInfo> {
    let mut owners: HashMap<String, (&ModEntry, &str)> = HashMap::new();
    for entry in mods.iter().filter(|entry| entry.enabled) {
        for file in &entry.deployed_files {
            owners
                .entry(file.relative_path.to_ascii_lowercase())
                .or_insert((entry, file.relative_path.as_str()));
        }
    }

    let parents = parent_links(mods);
    let mut conflicts = Vec::new();
    for entry in mods.iter().filter(|entry| !entry.enabled) {
        let planned = if entry.planned_files.is_empty() {
            // State written by an older build has no cache; fall back once.
            plan_for(entry)
                .map(|plan| plan.into_iter().map(|file| file.relative).collect())
                .unwrap_or_default()
        } else {
            entry.planned_files.clone()
        };
        for relative in planned {
            if let Some((other, _)) = owners.get(&relative.to_ascii_lowercase()) {
                // 汉化包覆盖父级文件是设计内的行为，不是冲突。
                if is_parent_child(&parents, &entry.id, &other.id) {
                    continue;
                }
                conflicts.push(ConflictInfo {
                    target: relative,
                    mod_id: entry.id.clone(),
                    mod_name: entry.name.clone(),
                    other_mod_id: Some(other.id.clone()),
                    other_mod_name: Some(other.name.clone()),
                    kind: "managed".to_string(),
                    pending: true,
                });
            }
        }
    }
    conflicts
}

/// The complete conflict set shown in the UI and sent to AI diagnostics. The
/// unordered pair is the identity, so an enabled collision is not counted twice.
pub fn collect_conflicts(mods: &[ModEntry]) -> Vec<ConflictInfo> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for conflict in all_conflicts(mods).into_iter().chain(staged_conflicts(mods)) {
        let (left, right) = match conflict.other_mod_id.as_deref() {
            Some(other) if other < conflict.mod_id.as_str() => (other, conflict.mod_id.as_str()),
            Some(other) => (conflict.mod_id.as_str(), other),
            None => (conflict.mod_id.as_str(), ""),
        };
        let key = format!(
            "{}|{}|{}|{}",
            conflict.target.to_ascii_lowercase(),
            left,
            right,
            conflict.pending
        );
        if seen.insert(key) {
            result.push(conflict);
        }
    }
    result
}

/// 删掉部署清单里的一条落地文件。
///
/// 抽出来给 `undeploy_mod` 与孤儿清理共用：**「什么算启动器放的文件」只允许
/// 有一处判断**。两套实现迟早会漂移，而这里判断失误的代价是删掉玩家的原版文件。
///
/// - `Ok(false)`：已删除，且部署后没被外部改过
/// - `Ok(true)`：已删除，但这是 Copy 部署且部署后被改过（调用方要告知用户）
/// - `Err(reason)`：跳过，原因给上层拼提示用
fn remove_deployed_file(file: &DeployedFile, game_root: &Path) -> Result<bool, String> {
    let target = safe_join(game_root, &file.relative_path)
        .map_err(|err| format!("跳过不安全路径 {}：{err}", file.relative_path))?;
    if !is_within(game_root, &target) {
        return Err(format!(
            "拒绝删除游戏目录之外的文件：{}",
            target.display()
        ));
    }
    if !target.exists() && fs::symlink_metadata(&target).is_err() {
        return Err(format!(
            "部署清单中的文件已不存在：{}",
            file.relative_path
        ));
    }
    let symlink_meta = fs::symlink_metadata(&target).ok();
    let is_symlink = symlink_meta
        .as_ref()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if !is_symlink && file.link_type == LinkType::HardLink {
        let source = PathBuf::from(&file.source);
        if !same_file_identity(&source, &target) {
            return Err(format!(
                "目标已不是启动器创建的那个硬链接，拒绝删除：{}",
                file.relative_path
            ));
        }
    }
    // Copy 部署的文件与暂存区没有身份关系（自检 P2-2）：用户手改过也无从拒绝删除，
    // 因为「清单里写着这是启动器放的」。这里不比身份、只比对部署那一刻记下的
    // 大小/时间，改动过就明确告知——否则用户会以为改动「还在某处」，其实已随文件删除。
    let mut edited = false;
    if !is_symlink && file.link_type == LinkType::Copy {
        let (size, mtime) = file_stamp(&target);
        let size_changed = matches!((file.size, size), (Some(before), Some(after)) if before != after);
        let time_changed =
            matches!((file.modified_time, mtime), (Some(before), Some(after)) if before != after);
        edited = size_changed || time_changed;
    }
    remove_link_or_copy(&target, is_symlink)
        .map_err(|err| format!("无法删除 {}：{err}", target.display()))?;
    prune_empty_dirs(target.parent(), game_root);
    Ok(edited)
}

pub fn undeploy_mod(store: &Store, mod_id: &str, game_root: &Path) -> AppResult<Vec<String>> {
    if !game_root.is_dir() {
        return Err(CommandError::new(
            "GAME_DIR_MISSING",
            format!("游戏目录不存在，无法安全移除链接：{}", game_root.display()),
        ));
    }
    let mut state = store.data.lock().expect("state mutex poisoned");
    let index = state
        .mods
        .iter()
        .position(|item| item.id == mod_id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
    let mut entry = state.mods[index].clone();
    let mut warnings = Vec::new();
    // Recover before removing the only remaining verified game-side copies.
    // Without this, undeploy clears the manifest and permanently loses the
    // information needed to repair an old absolute staging path.
    if !Path::new(&entry.staging_path).is_dir() && !entry.deployed_files.is_empty() {
        if recover_staging(store, &mut entry, game_root)? {
            let mut repaired = state.clone();
            repaired.mods[index] = entry.clone();
            store.save(&repaired)?;
        }
    }
    // Copy 部署后被外部改过的文件（见下方 P2-2 说明），循环后统一汇总成一条提示。
    let mut edited_copies: Vec<String> = Vec::new();

    for file in entry.deployed_files.iter().rev() {
        match remove_deployed_file(file, game_root) {
            Ok(edited) => {
                if edited {
                    edited_copies.push(file.relative_path.clone());
                }
            }
            Err(reason) => warnings.push(reason),
        }
    }

    entry.deployed_files.clear();
    entry.enabled = false;
    entry.updated_at = Some(now_iso());
    state.mods[index] = entry;
    if !edited_copies.is_empty() {
        warnings.push(format!(
            "有 {} 个文件在部署后被手动改过，已按清单一并删除：{}（暂存区里仍是原始版本）",
            edited_copies.len(),
            edited_copies
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(" / ")
        ));
    }
    if state.settings.write_modlist {
        if let Err(err) = crate::loadorder::write_modlist(&state, game_root) {
            warnings.push(format!("更新 modlist.txt 失败：{err}"));
        }
    }
    store.save(&state)?;
    Ok(warnings)
}

/// 暂存区里的东西还在不在。
///
/// 只看目录存在不够：Vortex 删文件后经常留下空壳目录，真去部署才发现一个源文件
/// 都没有。这里顺便确认目录里至少还有一个真实文件。
fn staging_present(entry: &ModEntry) -> bool {
    let root = Path::new(&entry.staging_path);
    if !root.is_dir() {
        return false;
    }
    WalkDir::new(root)
        .into_iter()
        .flatten()
        .any(|item| item.file_type().is_file())
}

/// 静默清理一个模组留在游戏目录里的链接。
///
/// 返回删不掉的项（空 = 全部清干净）。玩家已经删掉的落地文件直接跳过——那本来
/// 就没有残留可清，不该混进提示里当异常。
fn purge_links(entry: &ModEntry, game_root: &Path) -> Vec<String> {
    let mut notes = Vec::new();
    for file in entry.deployed_files.iter().rev() {
        let already_gone = safe_join(game_root, &file.relative_path)
            .map(|target| !target.exists() && fs::symlink_metadata(&target).is_err())
            .unwrap_or(false);
        if already_gone {
            continue;
        }
        if let Err(reason) = remove_deployed_file(file, game_root) {
            notes.push(reason);
        }
    }
    notes
}

/// 从状态里彻底忘掉一个模组：删记录、清加载顺序、断开悬空父级引用、清播放集。
///
/// **只动数据库，不碰磁盘** —— 调用方必须先把游戏目录里的链接清干净，否则那些
/// 文件就再也没人认得了。
pub fn forget_mod(state: &mut crate::schema::AppStateData, entry: &ModEntry) {
    let id = entry.id.as_str();
    let vacated: Vec<String> = entry
        .deployed_files
        .iter()
        .map(|file| file.relative_path.clone())
        .collect();
    let folder = entry.mod_folder.clone().filter(|value| !value.is_empty());
    state.mods.retain(|item| item.id != id);
    state.load_order.retain(|path| {
        if vacated.iter().any(|owned| owned.eq_ignore_ascii_case(path)) {
            return false;
        }
        let Some(folder) = folder.as_deref() else {
            return true;
        };
        !path.starts_with(&format!("mods/{folder}/"))
            && !path.starts_with(&format!(
                "bin/x64/plugins/cyber_engine_tweaks/mods/{folder}/"
            ))
    });
    // 挂在被删模组下的汉化包不能留悬空父级引用：那会让它被永久隐藏。
    for item in &mut state.mods {
        if item.parent_mod_id.as_deref() == Some(id) {
            item.parent_mod_id = None;
        }
    }
    // 播放集里也存了 mod id 列表，一并清掉。
    for profile in &mut state.profiles {
        profile.enabled_mod_ids.retain(|owned| owned != id);
    }
}

/// 物理状态自同步：把数据库拉回和磁盘一致的状态。
///
/// 触发时机是「应用启动」和「手动刷新」——这两个时刻用户的预期都是「界面上的
/// 就是我实际有的东西」。孤儿判定只有一条：**暂存区里已经没有可部署的文件**。
/// 判定完先清游戏目录里属于它的链接，再从 mods 里删记录；顺序不能反，反了部署
/// 清单就丢了，残留链接再也认不出主人。
///
/// 红线：只删数据库记录和游戏目录里的链接，**绝不删暂存区里真实存在的文件**。
pub fn sync_physical_state(
    store: &Store,
    game_root: Option<&Path>,
) -> AppResult<crate::schema::PhysicalSyncReport> {
    let snapshot = store.snapshot_data();
    let mut report = crate::schema::PhysicalSyncReport {
        checked: snapshot.mods.len(),
        ..Default::default()
    };
    // 保护闸一：暂存根目录本身不可用（移动硬盘没插、目录被改到别的盘）时，
    // 下面每一条都会「暂存丢失」。这时候清理等于一键清库——宁可什么都不做。
    let staging_root = store.staging_dir();
    if !staging_root.is_dir() {
        report.warnings.push(format!(
            "暂存区不可用（{}），本次跳过物理状态同步。",
            staging_root.display()
        ));
        return Ok(report);
    }
    let mut orphans: Vec<ModEntry> = Vec::new();
    let mut repaired: Vec<ModEntry> = Vec::new();

    for mut entry in snapshot.mods {
        if staging_present(&entry) {
            continue;
        }
        // 暂存没了、但游戏目录里还有它部署出去的文件：多半只是暂存目录被移位或
        // 改名，能从清单原样恢复就先恢复，不该当孤儿删掉。
        if let Some(root) = game_root {
            match recover_staging(store, &mut entry, root) {
                Ok(true) => {
                    report.repaired.push(entry.name.clone());
                    repaired.push(entry);
                    continue;
                }
                Ok(false) => {}
                // 部署出去的文件也没了 = 正是孤儿场景，不算异常。
                Err(err) if err.code == "STAGING_RECOVERY_SOURCE_MISSING" => {}
                Err(err) => {
                    report.deferred.push(entry.name.clone());
                    report.warnings.push(format!("{}：{}", entry.name, err.message));
                    continue;
                }
            }
        }
        orphans.push(entry);
    }

    // 保护闸二：多数模组同时「消失」几乎不可能是玩家逐个删的，更可能是暂存
    // 目录被换掉或权限掉了。2026-10-26 丢过一次 195 条索引，这种判据要两道。
    let missing_ratio = orphans.len() as f64 / report.checked.max(1) as f64;
    if orphans.len() >= 4 && missing_ratio >= 0.5 {
        report.deferred.extend(orphans.iter().map(|entry| entry.name.clone()));
        report.warnings.push(format!(
            "检测到 {} 个模组同时丢失文件（占 {}%），更像暂存目录整体不可用；本次不做清理，请检查暂存区路径。",
            orphans.len(),
            (missing_ratio * 100.0).round() as i64
        ));
        return Ok(report);
    }

    // 清游戏目录里的残留链接。删不掉（身份不匹配 / 权限）就整条保留记录，
    // 否则记录一删，那些文件就永远没人认得了。
    let mut blocked: HashSet<String> = HashSet::new();
    for entry in &orphans {
        if entry.deployed_files.is_empty() {
            continue;
        }
        let Some(root) = game_root else {
            // 游戏目录还没定位：先不动，等下次能定位了再清。
            blocked.insert(entry.id.clone());
            report.deferred.push(entry.name.clone());
            continue;
        };
        for reason in purge_links(entry, root) {
            blocked.insert(entry.id.clone());
            report.warnings.push(format!("{}：{reason}", entry.name));
        }
    }

    let removed: Vec<ModEntry> = orphans
        .into_iter()
        .filter(|entry| !blocked.contains(&entry.id))
        .collect();

    if removed.is_empty() && repaired.is_empty() {
        return Ok(report);
    }

    let mut data = store.data.lock().expect("state mutex poisoned");
    for entry in &repaired {
        if let Some(slot) = data.mods.iter_mut().find(|item| item.id == entry.id) {
            *slot = entry.clone();
        }
    }
    if !removed.is_empty() {
        for entry in &removed {
            forget_mod(&mut data, entry);
        }
        if data.settings.write_modlist {
            if let Some(root) = game_root {
                if let Err(err) = crate::loadorder::write_modlist(&data, root) {
                    report.warnings.push(format!("更新 modlist.txt 失败：{err}"));
                }
            }
        }
        report.removed = removed.iter().map(|entry| entry.name.clone()).collect();
    }
    store.save(&data)?;
    Ok(report)
}

pub fn uninstall_mod(store: &Store, mod_id: &str, game_root: Option<&Path>) -> AppResult<()> {
    {
        let state = store.data.lock().expect("state mutex poisoned");
        let entry = state
            .mods
            .iter()
            .find(|item| item.id == mod_id)
            .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
        if !entry.deployed_files.is_empty() {
            drop(state);
            let root = game_root.ok_or_else(|| {
                CommandError::new(
                    "GAME_REQUIRED",
                    "这个模组仍在部署中，必须先定位游戏目录才能安全卸载。",
                )
            })?;
            undeploy_mod(store, mod_id, root)?;
        }
    }

    let mut state = store.data.lock().expect("state mutex poisoned");
    let index = state
        .mods
        .iter()
        .position(|item| item.id == mod_id)
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))?;
    let entry = state.mods.remove(index);
    let deployed_paths: Vec<String> = entry
        .deployed_files
        .iter()
        .map(|file| file.relative_path.clone())
        .collect();
    let staging_root = PathBuf::from(&entry.staging_path);
    let staging_base = store.staging_dir();
    if is_within(&staging_base, &staging_root) {
        let container = if staging_root.file_name().map(|v| v == "payload").unwrap_or(false) {
            staging_root.parent().map(Path::to_path_buf).unwrap_or(staging_root)
        } else {
            staging_root
        };
        if is_within(&staging_base, &container) {
            let _ = fs::remove_dir_all(&container);
        }
    }
    let prefix = format!("mods/{}/", entry.mod_folder.clone().unwrap_or_default());
    let cet_prefix = format!(
        "bin/x64/plugins/cyber_engine_tweaks/mods/{}/",
        entry.mod_folder.clone().unwrap_or_default()
    );
    state.load_order.retain(|path| {
        !path.starts_with(&prefix)
            && !path.starts_with(&cet_prefix)
            && !deployed_paths.iter().any(|owned| owned.eq_ignore_ascii_case(path))
    });
    store.save(&state)?;
    Ok(())
}

fn append_to_load_order(state: &mut crate::schema::AppStateData, entry: &ModEntry) {
    let mut archives: Vec<String> = entry
        .deployed_files
        .iter()
        .filter(|file| file.relative_path.to_ascii_lowercase().ends_with(".archive"))
        .map(|file| file.relative_path.clone())
        .collect();
    archives.sort();
    for archive in archives {
        if !state.load_order.iter().any(|item| item.eq_ignore_ascii_case(&archive)) {
            state.load_order.push(archive);
        }
    }
}

/// Remove a link/copy without following symlinks. Read-only copies are made
/// writable first; Windows refuses to delete a read-only file otherwise.
fn remove_link_or_copy(target: &Path, is_symlink: bool) -> std::io::Result<()> {
    if !is_symlink {
        if let Ok(metadata) = fs::metadata(target) {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                let _ = fs::set_permissions(target, permissions);
            }
        }
    }
    fs::remove_file(target)
}

#[cfg(windows)]
pub(crate) fn file_identity(path: &Path) -> Option<(u32, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        let ok = GetFileInformationByHandle(handle, &mut info);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
        Some((info.dwVolumeSerialNumber, index))
    }
}

#[cfg(windows)]
pub(crate) fn same_file_identity(left: &Path, right: &Path) -> bool {
    match (file_identity(left), file_identity(right)) {
        (Some(left_id), Some(right_id)) => left_id == right_id,
        _ => false,
    }
}

#[cfg(not(windows))]
pub(crate) fn same_file_identity(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left).ok() == fs::canonicalize(right).ok()
}

fn prune_empty_dirs(mut current: Option<&Path>, root: &Path) {
    while let Some(dir) = current {
        if dir == root || !is_within(root, dir) {
            break;
        }
        if fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独立临时目录，避免并行测试互相看见对方的文件。
    fn fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cdl-layout-{tag}-{}",
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

    /// 2026-10-30 自检 P1-2：散装 archive + redscript 的混合包被判成 Archive，
    /// .reds 会被 plan_for 跳过——必须能被统计出来（否则就是静默丢文件）。
    #[test]
    fn mixed_loose_archive_and_redscript_reports_skipped() {
        let dir = fixture("mixed");
        touch(&dir.join("Cool.archive"));
        touch(&dir.join("scripts").join("Cool.reds"));
        touch(&dir.join("readme.md"));

        let layout = detect_layout(&dir).unwrap();
        assert_eq!(layout, InstallLayout::Archive);
        let (total, sample, label) = layout_skipped(&dir, &layout, 3);
        assert_eq!(total, 1, "只有 .reds 会被跳过，readme 属文档不算");
        assert_eq!(sample, vec!["scripts/Cool.reds".to_string()]);
        assert_eq!(label, "独立 archive");
        let _ = fs::remove_dir_all(dir);
    }

    /// 纯 archive 包不该报任何跳过，避免给正常用户刷无意义警告。
    #[test]
    fn pure_archive_pack_reports_nothing_skipped() {
        let dir = fixture("pure");
        touch(&dir.join("A.archive"));
        touch(&dir.join("B.xl"));
        touch(&dir.join("readme.txt"));

        let layout = detect_layout(&dir).unwrap();
        assert_eq!(layout, InstallLayout::Archive);
        let (total, sample, _) = layout_skipped(&dir, &layout, 3);
        assert_eq!(total, 0);
        assert!(sample.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    /// GameRoot 布局：首段不在 RECOGNIZED_ROOTS 的散文件会被跳过。
    #[test]
    fn game_root_pack_flags_stray_files() {
        let dir = fixture("root");
        touch(&dir.join("archive").join("pc").join("mod").join("A.archive"));
        touch(&dir.join("tool.exe"));

        let layout = detect_layout(&dir).unwrap();
        assert_eq!(layout, InstallLayout::GameRoot);
        let (total, sample, label) = layout_skipped(&dir, &layout, 3);
        assert_eq!(total, 1);
        assert_eq!(sample, vec!["tool.exe".to_string()]);
        assert_eq!(label, "完整游戏目录结构");
        let _ = fs::remove_dir_all(dir);
    }

    /// REDmod 把整包收进 mods/<name>/，不存在跳过，不能误报。
    #[test]
    fn redmod_pack_reports_nothing_skipped() {
        let dir = fixture("redmod");
        touch(&dir.join("info.json"));
        touch(&dir.join("archives").join("A.archive"));
        touch(&dir.join("tweaks").join("handler.lua"));

        let layout = detect_layout(&dir).unwrap();
        assert_eq!(layout, InstallLayout::Redmod);
        let (total, sample, _) = layout_skipped(&dir, &layout, 3);
        assert_eq!(total, 0);
        assert!(sample.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    /// 孤儿清理只看 staging_path / deployed_files / mod_folder 这几项，其余字段
    /// 按最小可用值填。
    fn sync_entry(id: &str, staging: &Path, files: Vec<DeployedFile>) -> ModEntry {
        ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: format!("Mod {id}"),
            version: None,
            author: None,
            category: "其他".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: None,
            staging_path: staging.to_string_lossy().to_string(),
            cover_path: None,
            enabled: !files.is_empty(),
            installed_at: "2026-10-31T00:00:00Z".to_string(),
            updated_at: None,
            size_bytes: 0,
            file_count: files.len(),
            layout: InstallLayout::Archive,
            mod_folder: None,
            metadata_source: "filename".to_string(),
            planned_files: Vec::new(),
            warnings: Vec::new(),
            deployed_files: files,
            has_archive: true,
            has_redmod: false,
            has_cet: false,
            translated_name: None,
            translated_at: None,
            translated_by: None,
            managed: true,
            origin: "cyberdeck".to_string(),
            modpack_id: None,
            nexus_cover_url: None,
            is_translation: false,
            parent_mod_id: None,
            ai_loc: None,
            ai_fix: Vec::new(),
        }
    }

    /// 暂存目录存在不算数：Vortex 删文件后常留空壳目录，那种状态部署时同样没源文件。
    #[test]
    fn staging_present_requires_a_real_file() {
        let dir = fixture("staging-present");
        let empty = dir.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(
            !staging_present(&sync_entry("a", &empty, Vec::new())),
            "空目录必须判为丢失"
        );

        let filled = dir.join("filled");
        fs::create_dir_all(filled.join("archive")).unwrap();
        fs::write(filled.join("archive").join("a.archive"), b"x").unwrap();
        assert!(staging_present(&sync_entry("b", &filled, Vec::new())));
        let _ = fs::remove_dir_all(dir);
    }

    /// 暂存没了、也没部署过：直接删记录，连带清掉加载顺序里的残留。
    #[test]
    fn orphan_without_deployment_is_forgotten() {
        let dir = fixture("sync-bare");
        let store = Store::load(dir.join("data")).unwrap();
        let gone = store.staging_dir().join("gone");
        fs::create_dir_all(&gone).unwrap(); // 空壳：内容已经没了

        {
            // Store::save 只落盘、不更新内存；测试要改的正是内存里的那份状态。
            let mut data = store.data.lock().expect("state mutex poisoned");
            let mut entry = sync_entry("m1", &gone, Vec::new());
            entry.mod_folder = Some("m1".to_string());
            data.mods.push(entry);
            // REDmod / CET 在加载顺序里是目录前缀形态，删记录时必须一起清掉。
            data.load_order.push("mods/m1/init.lua".to_string());
        }

        let report = sync_physical_state(&store, None).unwrap();
        assert_eq!(report.removed, vec!["Mod m1".to_string()]);
        let after = store.snapshot_data();
        assert!(after.mods.is_empty(), "失效记录必须被清掉");
        assert!(after.load_order.is_empty(), "加载顺序不能留下残影");
        let _ = fs::remove_dir_all(dir);
    }

    /// 暂存没了、部署清单里还剩一部分文件：先清掉游戏目录里的残留，再删记录。
    /// 顺序反了清单就丢了，那些文件再也没人认得出是启动器放的。
    ///
    /// 场景取「清单里有的文件还在、有的已经没了」：只要还能拼出完整副本，
    /// 上面那条恢复逻辑就会把它救回来，不会走到清理。
    #[test]
    fn orphan_purges_game_files_before_forgetting_the_record() {
        let dir = fixture("sync-deployed");
        let store = Store::load(dir.join("data")).unwrap();
        let game = dir.join("game");
        let kept = game.join("archive").join("pc").join("mod").join("a.archive");
        fs::create_dir_all(kept.parent().unwrap()).unwrap();
        fs::write(&kept, b"payload").unwrap();
        let (size, mtime) = file_stamp(&kept);
        let deleted = game.join("archive").join("pc").join("mod").join("b.archive");

        let gone = store.staging_dir().join("m1"); // 不创建 = 暂存丢失
        let files = vec![
            DeployedFile {
                source: gone.join("a.archive").to_string_lossy().to_string(),
                target: kept.to_string_lossy().to_string(),
                link_type: LinkType::Copy,
                relative_path: "archive/pc/mod/a.archive".to_string(),
                size,
                modified_time: mtime,
            },
            DeployedFile {
                source: gone.join("b.archive").to_string_lossy().to_string(),
                target: deleted.to_string_lossy().to_string(),
                link_type: LinkType::Copy,
                relative_path: "archive/pc/mod/b.archive".to_string(),
                size: Some(1),
                modified_time: Some(1),
            },
        ];

        {
            let mut data = store.data.lock().expect("state mutex poisoned");
            data.game_dir = Some(game.to_string_lossy().to_string());
            data.mods.push(sync_entry("m1", &gone, files));
            data.load_order.push("archive/pc/mod/a.archive".to_string());
        }

        let report = sync_physical_state(&store, Some(&game)).unwrap();
        assert_eq!(report.removed.len(), 1, "拼不出完整副本 → 按孤儿清理");
        assert!(!kept.exists(), "游戏目录里的残留必须被清掉");
        let after = store.snapshot_data();
        assert!(after.mods.is_empty());
        assert!(after.load_order.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    /// 保护闸：多条模组同时「丢失」更像暂存目录整体不可用，一条都不许删。
    /// 2026-10-26 丢过 195 条索引，这类判据必须有两道。
    #[test]
    fn mass_disappearance_is_not_treated_as_a_wipe() {
        let dir = fixture("sync-guard");
        let store = Store::load(dir.join("data")).unwrap();
        let gone = store.staging_dir().join("gone");
        fs::create_dir_all(&gone).unwrap();

        {
            let mut data = store.data.lock().expect("state mutex poisoned");
            for index in 0..5 {
                data.mods.push(sync_entry(&format!("m{index}"), &gone, Vec::new()));
            }
        }

        let report = sync_physical_state(&store, None).unwrap();
        assert!(report.removed.is_empty(), "批量丢失时不许清理");
        assert_eq!(report.deferred.len(), 5);
        assert_eq!(store.snapshot_data().mods.len(), 5, "记录必须原样保留");
        let _ = fs::remove_dir_all(dir);
    }
}


