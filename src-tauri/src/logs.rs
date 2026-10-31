//! Read-only log discovery and tailing. Paths are constrained to the selected
//! game root and known log directories; the frontend never supplies an
//! arbitrary filesystem path to read.

use crate::game::validate_game_dir;
use crate::schema::{AppResult, CommandError, LogFileInfo, LogLine, LogTail};
use crate::store::Store;
use chrono::{DateTime, SecondsFormat, Utc};
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;
const TAIL_BYTES: usize = 256 * 1024;
const DEFAULT_TAIL_LINES: usize = 100;
const MAX_TAIL_LINES: usize = 500;

fn root_for(store: &Store) -> AppResult<PathBuf> {
    let data = store.snapshot_data();
    let Some(root) = data.game_dir else {
        return Err(CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有定位游戏目录，无法读取日志。",
        ));
    };
    let game = validate_game_dir(Path::new(&root))?;
    Ok(PathBuf::from(game.root))
}

fn log_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![
        root.join("r6").join("logs"),
        root.join("red4ext").join("logs"),
        root.join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks")
            .join("logs"),
    ];
    // CET has historically written its main log directly beside the plugin.
    dirs.push(
        root.join("bin")
            .join("x64")
            .join("plugins")
            .join("cyber_engine_tweaks"),
    );
    dirs
}

fn classify(path: &Path) -> &'static str {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.contains("redscript") {
        "redscript"
    } else if lower.contains("cyber_engine_tweaks") {
        "CET"
    } else if lower.contains("red4ext") {
        "RED4ext"
    } else {
        "game"
    }
}

fn is_log_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "log" | "txt"))
        .unwrap_or(false)
}

pub fn list(store: &Store) -> AppResult<Vec<LogFileInfo>> {
    let root = root_for(store)?;
    let canonical_root = fs::canonicalize(&root).unwrap_or(root.clone());
    let mut seen = BTreeSet::new();
    let mut files = Vec::new();

    for dir in log_dirs(&canonical_root) {
        if !dir.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&dir)
            .max_depth(2)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !is_log_file(path) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() == 0 || meta.len() > MAX_LOG_BYTES {
                continue;
            }
            let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            if !canonical.starts_with(&canonical_root) {
                continue;
            }
            if !seen.insert(canonical.to_string_lossy().to_ascii_lowercase()) {
                continue;
            }
            let modified_at = meta.modified().ok().map(|time| {
                let datetime: DateTime<Utc> = time.into();
                datetime.to_rfc3339_opts(SecondsFormat::Secs, true)
            });
            files.push(LogFileInfo {
                path: canonical.to_string_lossy().to_string(),
                name: canonical
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "log".to_string()),
                category: classify(&canonical).to_string(),
                size_bytes: meta.len(),
                modified_at,
            });
        }
    }

    files.sort_by(|left, right| {
        let rank = |category: &str| match category {
            "redscript" => 0,
            "CET" => 1,
            "RED4ext" => 2,
            _ => 3,
        };
        rank(&left.category)
            .cmp(&rank(&right.category))
            .then_with(|| right.modified_at.cmp(&left.modified_at))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(files)
}

fn validate_log_path(root: &Path, raw: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw);
    let meta = fs::symlink_metadata(&path)
        .map_err(|e| CommandError::new("LOG_NOT_FOUND", format!("找不到日志文件：{e}")))?;
    if meta.file_type().is_symlink() {
        return Err(CommandError::new(
            "LOG_UNSAFE",
            "日志文件是符号链接，拒绝读取。",
        ));
    }
    if !meta.is_file() {
        return Err(CommandError::new("LOG_NOT_FILE", "日志路径不是文件。"));
    }
    if meta.len() > MAX_LOG_BYTES {
        return Err(CommandError::new(
            "LOG_TOO_LARGE",
            "日志超过 32 MB，拒绝读取。先清理旧日志再试。",
        ));
    }
    if !is_log_file(&path) {
        return Err(CommandError::new(
            "LOG_NOT_ALLOWED",
            "只允许读取 .log / .txt 日志文件。",
        ));
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| {
        CommandError::new("GAME_DIR_MISSING", format!("无法解析游戏目录：{e}"))
    })?;
    let canonical = fs::canonicalize(&path)
        .map_err(|e| CommandError::new("LOG_NOT_FOUND", format!("无法解析日志路径：{e}")))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(CommandError::new(
            "LOG_UNSAFE",
            "日志不在游戏目录内，拒绝读取。",
        ));
    }
    let lower = canonical.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    let allowed = lower.contains("/r6/logs/")
        || lower.contains("/red4ext/logs/")
        || lower.contains("/cyber_engine_tweaks/logs/")
        || lower.ends_with("/cyber_engine_tweaks/cyber_engine_tweaks.log")
        || (lower.contains("/cyber_engine_tweaks/")
            && (lower.ends_with(".log") || lower.ends_with(".txt")));
    if !allowed {
        return Err(CommandError::new(
            "LOG_NOT_ALLOWED",
            "这个文件不在已知日志目录中，拒绝读取。",
        ));
    }
    Ok(canonical)
}

pub fn tail(store: &Store, raw_path: &str, limit: Option<usize>) -> AppResult<LogTail> {
    let root = root_for(store)?;
    let path = validate_log_path(&root, raw_path)?;
    let meta = fs::metadata(&path)
        .map_err(|e| CommandError::new("LOG_INSPECT", format!("无法检查日志：{e}")))?;
    let limit = limit.unwrap_or(DEFAULT_TAIL_LINES).clamp(1, MAX_TAIL_LINES);
    let read_len = meta.len().min(TAIL_BYTES as u64);
    let mut file = fs::File::open(&path)
        .map_err(|e| CommandError::new("LOG_OPEN", format!("无法打开日志：{e}")))?;
    file.seek(SeekFrom::Start(meta.len() - read_len))
        .map_err(|e| CommandError::new("LOG_OPEN", format!("无法定位日志末尾：{e}")))?;
    let mut buffer = vec![0u8; read_len as usize];
    file.read_exact(&mut buffer)
        .map_err(|e| CommandError::new("LOG_READ", format!("读取日志失败：{e}")))?;
    let text = String::from_utf8_lossy(&buffer);
    let mut source: Vec<&str> = text.lines().collect();
    if meta.len() > read_len {
        // The first line is almost certainly cut in half at the seek boundary.
        source.remove(0);
    }
    let start = source.len().saturating_sub(limit);
    let lines = source[start..]
        .iter()
        .enumerate()
        .map(|(index, line)| LogLine {
            number: index + 1,
            text: (*line).chars().take(4000).collect(),
            level: classify_line(line).to_string(),
        })
        .collect();
    Ok(LogTail {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "log".to_string()),
        lines,
        truncated: meta.len() > read_len || start > 0,
        file_size_bytes: meta.len(),
        tail_limit: limit,
    })
}

fn classify_line(line: &str) -> &'static str {
    let lower = line.to_ascii_lowercase();
    let error = [
        "[error]",
        "[err]",
        " error",
        "error:",
        "failed",
        "failure",
        "exception",
        "crash",
        "fatal",
        "unhandled",
    ];
    if error.iter().any(|needle| lower.contains(needle)) {
        return "error";
    }
    let warn = ["[warning]", "[warn]", " warning", "warn:", "deprecated"];
    if warn.iter().any(|needle| lower.contains(needle)) {
        return "warn";
    }
    if line.trim().is_empty() {
        "muted"
    } else {
        "info"
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_line, list, tail};
    use crate::store::Store;
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        store: Store,
        log: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(".test-tmp")
                .join(format!("logs-{}", uuid::Uuid::new_v4().simple()));
            let game = root.join("game");
            fs::create_dir_all(game.join("bin").join("x64")).unwrap();
            fs::write(
                game.join("bin").join("x64").join("Cyberpunk2077.exe"),
                b"MZ fake",
            )
            .unwrap();
            let log_dir = game.join("r6").join("logs");
            fs::create_dir_all(&log_dir).unwrap();
            let log = log_dir.join("redscript.log");
            let mut content = String::new();
            for index in 1..=150 {
                content.push_str(&format!("[INFO] line {index}\r\n"));
            }
            content.push_str("[ERROR] failed to compile Broken.reds\r\n");
            fs::write(&log, content).unwrap();
            let store = Store::load(root.join("data")).unwrap();
            let mut state = store.data.lock().unwrap();
            state.game_dir = Some(game.to_string_lossy().to_string());
            store.save(&state).unwrap();
            drop(state);
            Self { root, store, log }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn classifies_common_log_levels() {
        assert_eq!(classify_line("[ERROR] failed to load"), "error");
        assert_eq!(classify_line("warning: deprecated call"), "warn");
        assert_eq!(classify_line("[INFO] loaded"), "info");
        assert_eq!(classify_line(""), "muted");
    }

    #[test]
    fn lists_and_tails_only_the_end() {
        let fixture = Fixture::new();
        let files = list(&fixture.store).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].category, "redscript");

        let tail = tail(&fixture.store, &fixture.log.to_string_lossy(), Some(100)).unwrap();
        assert_eq!(tail.lines.len(), 100);
        assert!(tail.truncated);
        assert_eq!(tail.lines.last().unwrap().level, "error");
        assert!(tail.lines.last().unwrap().text.contains("Broken.reds"));
    }

    #[test]
    fn refuses_paths_outside_the_game_directory() {
        let fixture = Fixture::new();
        let error = tail(&fixture.store, r"C:\Windows\notepad.exe", Some(10)).unwrap_err();
        assert!(matches!(
            error.code.as_str(),
            "LOG_NOT_ALLOWED" | "LOG_NOT_FILE" | "LOG_NOT_FOUND"
        ));
    }
}
