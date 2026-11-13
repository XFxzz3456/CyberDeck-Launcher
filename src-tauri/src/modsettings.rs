//! Safe reader/editor for the Cyber Engine Tweaks Mod Settings `user.ini`.
//!
//! Mod Settings is an ecosystem convention, not a game file: CET mods read this
//! INI through the ModSettings Lua API. We only ever touch the known file under
//! `bin/x64/plugins/cyber_engine_tweaks/mods/ModSettings/user.ini`; no arbitrary
//! path from the frontend is accepted.

use crate::game::validate_game_dir;
use crate::schema::{
    AppResult, CommandError, ModSettingEntry, ModSettingSection, ModSettingsView,
};
use crate::store::Store;
use ini::Ini;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_INI_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 2000;
const MAX_VALUE_CHARS: usize = 4096;

fn settings_path(root: &Path) -> PathBuf {
    root.join("bin")
        .join("x64")
        .join("plugins")
        .join("cyber_engine_tweaks")
        .join("mods")
        .join("ModSettings")
        .join("user.ini")
}

fn root_for(store: &Store) -> AppResult<PathBuf> {
    let data = store.snapshot_data();
    let Some(root) = data.game_dir else {
        return Err(CommandError::new(
            "GAME_NOT_CONFIGURED",
            "还没有定位游戏目录。Mod Settings 需要从游戏根目录读取。",
        ));
    };
    let game = validate_game_dir(Path::new(&root))?;
    Ok(PathBuf::from(game.root))
}

pub fn get(store: &Store) -> AppResult<ModSettingsView> {
    let root = root_for(store)?;
    let path = settings_path(&root);
    let parent = path.parent().map(Path::to_path_buf);
    let framework_installed = parent.as_deref().map(Path::is_dir).unwrap_or(false);
    let mut warnings = Vec::new();

    if !path.is_file() {
        return Ok(ModSettingsView {
            path: path.to_string_lossy().to_string(),
            exists: false,
            framework_installed,
            sections: Vec::new(),
            warnings: if framework_installed {
                vec!["还没有 user.ini。先在游戏内打开一次 Mod Settings 并修改任意选项，CET 才会生成它。".to_string()]
            } else {
                vec!["没有找到 CET 的 ModSettings 目录。先安装 Mod Settings 框架和至少一个使用它的模组。".to_string()]
            },
            backup_path: existing_backup(&path),
        });
    }

    let meta = fs::symlink_metadata(&path)
        .map_err(|e| CommandError::new("SETTINGS_INSPECT", format!("无法检查 user.ini：{e}")))?;
    if meta.file_type().is_symlink() {
        return Err(CommandError::new(
            "SETTINGS_UNSAFE",
            "user.ini 是符号链接。为了避免写到游戏目录之外，启动器拒绝读取/修改它。",
        ));
    }
    if meta.len() > MAX_INI_BYTES {
        return Err(CommandError::new(
            "SETTINGS_TOO_LARGE",
            format!("user.ini 超过 {} KB，拒绝解析。", MAX_INI_BYTES / 1024),
        ));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| CommandError::new("SETTINGS_READ", format!("无法读取 user.ini：{e}")))?;
    let ini = Ini::load_from_str(raw.trim_start_matches('\u{feff}')).map_err(|e| {
        CommandError::new(
            "SETTINGS_INVALID",
            format!("user.ini 不是有效的 INI 文件：{e}"),
        )
    })?;

    let mut sections = Vec::new();
    let mut count = 0usize;
    for (section, properties) in &ini {
        let name = section.as_deref().unwrap_or("General");
        let mut entries = Vec::new();
        for (key, value) in properties.iter() {
            if count >= MAX_ENTRIES {
                warnings.push(format!("文件条目超过 {MAX_ENTRIES} 条，剩余内容没有显示。"));
                break;
            }
            entries.push(ModSettingEntry {
                section: name.to_string(),
                key: key.to_string(),
                value: value.to_string(),
                kind: infer_kind(value).to_string(),
            });
            count += 1;
        }
        if !entries.is_empty() {
            sections.push(ModSettingSection {
                name: name.to_string(),
                entries,
            });
        }
    }

    if sections.is_empty() && !raw.trim().is_empty() {
        warnings.push("文件存在，但没有解析出任何 section/key。它可能使用了启动器不支持的语法。".to_string());
    }

    Ok(ModSettingsView {
        path: path.to_string_lossy().to_string(),
        exists: true,
        framework_installed,
        sections,
        warnings,
        backup_path: existing_backup(&path),
    })
}

pub fn save(
    store: &Store,
    section: &str,
    key: &str,
    value: &str,
) -> AppResult<ModSettingsView> {
    let section = validate_token(section, "section")?;
    let key = validate_token(key, "key")?;
    if value.contains('\r') || value.contains('\n') {
        return Err(CommandError::new(
            "SETTINGS_INVALID_VALUE",
            "设置值不能包含换行符。",
        ));
    }
    if value.chars().count() > MAX_VALUE_CHARS {
        return Err(CommandError::new(
            "SETTINGS_INVALID_VALUE",
            format!("设置值超过 {MAX_VALUE_CHARS} 个字符。"),
        ));
    }

    let root = root_for(store)?;
    let path = settings_path(&root);
    if !path.is_file() {
        return Err(CommandError::new(
            "SETTINGS_FILE_MISSING",
            "user.ini 还不存在。先在游戏内打开 Mod Settings 并修改一次任意选项，再回来。",
        ));
    }
    let meta = fs::symlink_metadata(&path)
        .map_err(|e| CommandError::new("SETTINGS_INSPECT", format!("无法检查 user.ini：{e}")))?;
    if meta.file_type().is_symlink() {
        return Err(CommandError::new(
            "SETTINGS_UNSAFE",
            "user.ini 是符号链接，拒绝写入。",
        ));
    }
    let canonical = fs::canonicalize(&path).map_err(|e| {
        CommandError::new("SETTINGS_INSPECT", format!("无法解析 user.ini 路径：{e}"))
    })?;
    let canonical_root = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    if !canonical.starts_with(&canonical_root) {
        return Err(CommandError::new(
            "SETTINGS_UNSAFE",
            "user.ini 解析到了游戏目录之外，拒绝写入。",
        ));
    }
    if meta.len() > MAX_INI_BYTES {
        return Err(CommandError::new(
            "SETTINGS_TOO_LARGE",
            "user.ini 过大，拒绝修改。",
        ));
    }

    let raw = fs::read_to_string(&canonical)
        .map_err(|e| CommandError::new("SETTINGS_READ", format!("无法读取 user.ini：{e}")))?;
    let updated = update_ini_text(&raw, &section, &key, value);
    if updated == raw {
        return get(store);
    }

    let backup = backup_path(&path);
    reject_symlink(&backup)?;
    fs::copy(&canonical, &backup).map_err(|e| {
        CommandError::new(
            "SETTINGS_BACKUP",
            format!("写前备份失败，已停止修改：{e}"),
        )
    })?;

    let keep_link =
        crate::installer::hardlink_source_for(store, &canonical_root, &canonical).is_some();
    write_config(
        store,
        &canonical_root,
        &canonical,
        updated.as_bytes(),
        keep_link,
    )
    .map_err(|e| {
        CommandError::new(
            "SETTINGS_WRITE",
            format!("写入 user.ini 失败（原文件已备份到 {}）：{e}", backup.display()),
        )
    })?;
    get(store)
}

/// 写入配置正文。
///
/// `keep_link = true` 表示这个文件是硬链接部署进游戏目录的：必须**原地重写**
/// （截断后写入），不能像普通文件那样"写临时文件再改名"——`MoveFileExW` 换掉
/// inode 后，落地文件与暂存副本就成了两个不同的文件对象，随后禁用 / 卸载时
/// `same_file_identity` 校验不过会拒绝删除，表现为「禁用成功但文件还在，游戏
/// 照样加载」（2026-11-06 审计 P0-3）。
///
/// 原地写不是原子的，但调用方在写之前已经把原文备份成 `user.ini.bak`，
/// 真写到一半失败也能回滚。
fn write_config(
    store: &Store,
    game_root: &Path,
    target: &Path,
    bytes: &[u8],
    keep_link: bool,
) -> std::io::Result<()> {
    if !keep_link {
        return replace_file(target, bytes);
    }
    let in_place = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(target)?;
        file.write_all(bytes)?;
        file.flush()?;
        Ok(())
    })();
    match in_place {
        Ok(()) => Ok(()),
        Err(_) => {
            // 原地写失败（只读属性 / 被别的进程独占）→ 退回"换文件"，但链接关系
            // 就此断开，必须把清单里的类型降级成 Copy，否则以后禁用 / 卸载会被
            // 硬链接身份校验永远挡下。
            replace_file(target, bytes)?;
            crate::installer::downgrade_hardlink_to_copy(store, game_root, target);
            Ok(())
        }
    }
}

pub fn restore_backup(store: &Store) -> AppResult<ModSettingsView> {
    let root = root_for(store)?;
    let path = settings_path(&root);
    let backup = backup_path(&path);
    reject_symlink(&backup)?;
    if !backup.is_file() {
        return Err(CommandError::new(
            "SETTINGS_BACKUP_MISSING",
            "还没有可恢复的 user.ini.bak。",
        ));
    }
    let raw = fs::read_to_string(&backup)
        .map_err(|e| CommandError::new("SETTINGS_READ", format!("无法读取备份：{e}")))?;
    // Keep a copy of the current file before restoring, so the restore itself
    // is reversible.
    if path.is_file() {
        let before_restore = path.with_file_name("user.ini.before-restore.bak");
        fs::copy(&path, before_restore).map_err(|e| {
            CommandError::new("SETTINGS_BACKUP", format!("恢复前备份失败：{e}"))
        })?;
    }
    let keep_link = crate::installer::hardlink_source_for(store, &root, &path).is_some();
    write_config(store, &root, &path, raw.as_bytes(), keep_link)
        .map_err(|e| CommandError::new("SETTINGS_WRITE", format!("恢复 user.ini 失败：{e}")))?;
    get(store)
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name("user.ini.bak")
}

fn reject_symlink(path: &Path) -> AppResult<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(CommandError::new(
                "SETTINGS_UNSAFE",
                format!("{} 是符号链接，拒绝写入。", path.display()),
            ));
        }
    }
    Ok(())
}

fn existing_backup(path: &Path) -> Option<String> {
    let backup = backup_path(path);
    backup
        .is_file()
        .then(|| backup.to_string_lossy().to_string())
}

fn validate_token(value: &str, label: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new(
            "SETTINGS_INVALID_KEY",
            format!("{label} 不能为空。"),
        ));
    }
    if trimmed.chars().count() > 128 {
        return Err(CommandError::new(
            "SETTINGS_INVALID_KEY",
            format!("{label} 太长。"),
        ));
    }
    if trimmed.contains('\r')
        || trimmed.contains('\n')
        || trimmed.contains('=')
        || trimmed.contains('[')
        || trimmed.contains(']')
    {
        return Err(CommandError::new(
            "SETTINGS_INVALID_KEY",
            format!("{label} 含有 INI 不允许的字符。"),
        ));
    }
    Ok(trimmed.to_string())
}

fn infer_kind(value: &str) -> &'static str {
    let lower = value.trim().to_ascii_lowercase();
    if lower == "true" || lower == "false" {
        "bool"
    } else if !lower.is_empty()
        && lower.len() <= 64
        && lower
            .chars()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-' | '+' | 'e' | 'E'))
        && lower.parse::<f64>().is_ok()
    {
        "number"
    } else {
        "string"
    }
}

/// Replace only the value on the matching line. This preserves comments, key
/// order, spacing and unrelated sections, which a full INI re-serialization
/// would discard.
pub(crate) fn update_ini_text(raw: &str, section: &str, key: &str, value: &str) -> String {
    // UTF-8 BOM（U+FEFF）会让首行变成 "\u{feff}[Section]"，`line.trim()` 去不掉它，
    // 分区匹配直接失败 → 改动被「追加到文件末尾」，结果是一份带重复 section 的 ini。
    // 这里剥掉再原样拼回去：只影响匹配，不改文件的编码形态。
    let (bom, raw) = match raw.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", raw),
    };
    let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let had_trailing = raw.ends_with('\n') || raw.ends_with('\r');
    let mut lines: Vec<String> = raw
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect();
    if had_trailing {
        lines.pop();
    }

    let header = format!("[{section}]");
    let start = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case(&header));

    if let Some(start) = start {
        let end = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| line.trim_start().starts_with('['))
            .map(|(index, _)| index)
            .unwrap_or(lines.len());

        let mut found = None;
        for (index, line) in lines.iter().enumerate().take(end).skip(start + 1) {
            if let Some(eq) = line.find('=') {
                if line[..eq].trim().eq_ignore_ascii_case(key) {
                    found = Some(index);
                    break;
                }
            }
        }

        if let Some(index) = found {
            lines[index] = replace_line_value(&lines[index], value);
        } else {
            lines.insert(end, format!("{key}={value}"));
        }
    } else if lines.is_empty() {
        lines.push(header);
        lines.push(format!("{key}={value}"));
    } else {
        if lines.last().map(|line| !line.trim().is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        lines.push(header);
        lines.push(format!("{key}={value}"));
    }

    let mut rendered = lines.join(newline);
    if had_trailing || start.is_none() {
        rendered.push_str(newline);
    }
    format!("{bom}{rendered}")
}

fn replace_line_value(line: &str, value: &str) -> String {
    let (before_comment, comment) = split_comment(line);
    // eq 原本是「整行」里 '=' 的字节位置，行内注释被剥掉后它可能越界，
    // 也可能落进多字节字符中间——旧实现用 min() 兜底仍会 `[..=eq]` 越界 panic。
    // 在剥注释后的片段里重新找：'=' 是 ASCII，find() 返回的必是合法字符边界。
    let Some(eq) = before_comment.find('=') else {
        return line.to_string();
    };
    let lhs = &before_comment[..=eq];
    let rhs = &before_comment[eq + 1..];
    let leading = &rhs[..rhs.len() - rhs.trim_start().len()];
    let trailing = &rhs[rhs.trim_end().len()..];
    format!("{lhs}{leading}{value}{trailing}{comment}")
}

fn split_comment(line: &str) -> (&str, &str) {
    let mut quote: Option<char> = None;
    for (index, ch) in line.char_indices() {
        if let Some(current) = quote {
            if ch == current {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if (ch == ';' || ch == '#')
            && index > 0
            && line[..index]
                .chars()
                .next_back()
                .map(char::is_whitespace)
                .unwrap_or(false)
        {
            return (&line[..index], &line[index..]);
        }
    }
    (line, "")
}

#[cfg(windows)]
pub(crate) fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    // 临时名必须唯一：旧实现只带进程号，同进程两个线程写同一份配置时
    // 会互踩（A 写完 temp、B 覆盖 temp、A rename 走 B 的内容）。单用户 GUI
    // 里概率极低，但一旦发生就是「改了 A 的设置，B 的值被写进去了」。
    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "config.ini".to_string());
    let temp = path.with_file_name(format!(
        "{stem}.cyberdeck-{}-{nanos}-{seq}.tmp",
        std::process::id()
    ));
    fs::write(&temp, bytes)?;
    let source: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH. ReplaceFileW has more
    // metadata semantics, but MoveFileExW also works on filesystems without
    // backup semantics and is sufficient for a text config.
    let ok = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0x1 | 0x8) };
    if ok == 0 {
        let error = std::io::Error::last_os_error();
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_file_name("user.ini.cyberdeck.tmp");
    fs::write(&temp, bytes)?;
    fs::rename(temp, path)
}

#[cfg(test)]
mod tests {
    use super::{get, infer_kind, replace_line_value, restore_backup, save, settings_path, update_ini_text};
    use crate::store::Store;
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        store: Store,
        game: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(".test-tmp")
                .join(format!("modsettings-{}", uuid::Uuid::new_v4().simple()));
            let game = root.join("game");
            fs::create_dir_all(game.join("bin").join("x64")).unwrap();
            fs::write(
                game.join("bin").join("x64").join("Cyberpunk2077.exe"),
                b"MZ fake",
            )
            .unwrap();
            let store = Store::load(root.join("data")).unwrap();
            let mut state = store.data.lock().unwrap();
            state.game_dir = Some(game.to_string_lossy().to_string());
            store.save(&state).unwrap();
            drop(state);
            let fixture = Self { root, store, game };
            let ini = settings_path(&fixture.game);
            fs::create_dir_all(ini.parent().unwrap()).unwrap();
            fs::write(
                &ini,
                "[HUD]\r\n  scale = 1.0 ; keep\r\nshow_minimap=true\r\n\r\n[Audio]\r\nvolume=0.8\r\n",
            )
            .unwrap();
            fixture
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn bom_prefixed_ini_updates_existing_section() {
        // 带 BOM 的 ini：首行是 "\u{feff}[HUD]"。若匹配前不剥 BOM，分区找不到，
        // 改动会被追加到文件尾部，于是出现两个 [HUD] 段（旧实现的实际行为）。
        let raw = "\u{feff}[HUD]\nscale=1.0\n";
        let updated = update_ini_text(raw, "HUD", "scale", "2.0");
        assert_eq!(updated.matches("[HUD]").count(), 1, "{updated:?}");
        assert!(updated.contains("scale=2.0"), "{updated:?}");
        // BOM 必须原样保留：改内容不改编码形态，否则 ini 解析器可能认不出文件。
        assert!(updated.starts_with('\u{feff}'), "{updated:?}");
    }

    #[test]
    fn ini_without_bom_is_untouched_by_bom_handling() {
        let raw = "[HUD]\nscale=1.0\n";
        let updated = update_ini_text(raw, "HUD", "scale", "2.0");
        assert!(!updated.starts_with('\u{feff}'), "{updated:?}");
        assert_eq!(updated.matches("[HUD]").count(), 1, "{updated:?}");
    }

    #[test]
    fn reads_and_writes_with_backup() {
        let fixture = Fixture::new();
        let view = get(&fixture.store).unwrap();
        assert!(view.exists);
        assert_eq!(view.sections.len(), 2);
        assert_eq!(view.sections[0].entries[0].kind, "number");

        let updated = save(&fixture.store, "HUD", "scale", "1.25").unwrap();
        let scale = updated
            .sections
            .iter()
            .flat_map(|section| &section.entries)
            .find(|entry| entry.key == "scale")
            .unwrap();
        assert_eq!(scale.value, "1.25");
        let raw = fs::read_to_string(settings_path(&fixture.game)).unwrap();
        assert!(raw.contains("scale = 1.25 ; keep"), "{raw}");
        assert!(settings_path(&fixture.game).with_file_name("user.ini.bak").is_file());

        let restored = restore_backup(&fixture.store).unwrap();
        let scale = restored
            .sections
            .iter()
            .flat_map(|section| &section.entries)
            .find(|entry| entry.key == "scale")
            .unwrap();
        assert_eq!(scale.value, "1.0");
    }

    #[test]
    fn rejects_newlines_and_missing_files() {
        let fixture = Fixture::new();
        let error = save(&fixture.store, "HUD", "scale", "1\n2").unwrap_err();
        assert_eq!(error.code, "SETTINGS_INVALID_VALUE");
        fs::remove_file(settings_path(&fixture.game)).unwrap();
        let error = save(&fixture.store, "HUD", "scale", "2").unwrap_err();
        assert_eq!(error.code, "SETTINGS_FILE_MISSING");
    }

    #[test]
    fn updates_value_and_preserves_comments_and_spacing() {
        let raw = "[Gameplay]\r\n  damage = 1.0 ; default\r\nother=keep\r\n";
        let updated = update_ini_text(raw, "gameplay", "damage", "2.5");
        assert_eq!(
            updated,
            "[Gameplay]\r\n  damage = 2.5 ; default\r\nother=keep\r\n"
        );
    }

    #[test]
    fn appends_missing_key_and_section() {
        let raw = "[Gameplay]\nother=keep\n";
        let updated = update_ini_text(raw, "Gameplay", "damage", "2.5");
        assert!(updated.contains("other=keep\ndamage=2.5\n"), "{updated}");
        let created = update_ini_text(raw, "Audio", "volume", "0.8");
        assert!(created.contains("[Audio]\nvolume=0.8\n"), "{created}");
    }

    #[test]
    fn infers_control_kind() {
        assert_eq!(infer_kind("true"), "bool");
        assert_eq!(infer_kind("-12.5"), "number");
        assert_eq!(infer_kind("hello"), "string");
    }
}

/// Vortex 差异审计 P2：`&before_comment[..=eq]` 越界 panic（ini key 含 `;` /
/// 注释里先出现 `=` 时必触发）。panic="abort" 下会直接终结启动器。
#[test]
fn replace_line_value_never_panics_on_comment_with_equals() {
    for (line, value) in [
        ("a;b=1 ; note=x=y", "2"),
        ("键=值 ; note=a=b", "2"),
        ("没有等号的一行", "2"),
        ("", "2"),
    ] {
        let _ = replace_line_value(line, value);
    }
    assert_eq!(
        replace_line_value("foo=bar ; note=x=y", "baz"),
        "foo=baz ; note=x=y"
    );
}
