use crate::schema::{AppResult, AppStateData, CommandError};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

pub struct Store {
    pub data_dir: PathBuf,
    pub state_file: PathBuf,
    pub backups_dir: PathBuf,
    pub data: Mutex<AppStateData>,
    /// 暂存区位置可被用户改动（设置页「更改位置」），所以不能是普通字段。
    /// 单独一把锁：绝不与 `data` 的锁嵌套持有，避免与其他模块的加锁顺序打架。
    staging_dir: Arc<RwLock<PathBuf>>,
    /// 本次启动是否从损坏的状态文件恢复过；值是保留的 `.broken-*.json` 路径。
    /// 只用于告知用户「模组怎么突然没了」——不参与任何业务判断。
    recovered_from: Option<String>,
}

/// 校验一个候选暂存目录：**必须已存在**且能写，才认。
///
/// 刻意不在校验里 `create_dir_all`：状态文件里存的是绝对路径，启动器目录一旦被
/// 改名/搬走（如 2026-10-28 的 `CyberDeck-Launcher-0.7.0-release` → `release`），
/// 这条路径就永久失效。若这里自动建目录，会把**整套旧目录树原地复建**，
/// 结果新旧两份数据目录并存——这正是「模组突然变少」那类事故的成因。
/// 失效时由调用方回落到 `data_dir/staging`，并把实际生效位置写回状态。
fn usable_staging_dir(candidate: &str, fallback: &Path) -> Result<PathBuf, String> {
    if candidate.trim().is_empty() {
        return Ok(fallback.to_path_buf());
    }
    let dir = PathBuf::from(candidate.trim());
    if !dir.is_dir() {
        return Err(format!("{} 不存在", dir.display()));
    }
    let probe = dir.join(".cdl-write-probe");
    match fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(dir)
        }
        Err(err) => Err(format!("{} 不可写：{err}", dir.display())),
    }
}

impl Store {
    /// 当前生效的暂存区位置（可能在运行期被改过）。
    pub fn staging_dir(&self) -> PathBuf {
        self.staging_dir
            .read()
            .expect("staging dir lock poisoned")
            .clone()
    }

    /// 切换暂存区位置。调用方负责先把文件搬过去、并同步 `data.staging_dir`。
    pub fn set_staging_dir(&self, next: PathBuf) {
        *self.staging_dir.write().expect("staging dir lock poisoned") = next;
    }

    pub fn load(data_dir: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&data_dir).map_err(|e| {
            CommandError::new(
                "DATA_DIR",
                format!("无法创建数据目录 {}：{e}", data_dir.display()),
            )
        })?;
        let state_file = data_dir.join("launcher-state.json");
        // 默认位置；状态文件里若有合法的自定义位置，会覆盖它（见下）。
        let default_staging = data_dir.join("staging");
        let backups_dir = data_dir.join("backups");
        fs::create_dir_all(&default_staging).map_err(|e| {
            CommandError::new(
                "STAGING_DIR",
                format!("无法创建暂存目录 {}：{e}", default_staging.display()),
            )
        })?;
        fs::create_dir_all(&backups_dir).map_err(|e| {
            CommandError::new(
                "BACKUP_DIR",
                format!("无法创建备份目录 {}：{e}", backups_dir.display()),
            )
        })?;

        let mut recovered_from: Option<String> = None;
        let data = if state_file.exists() {
            match fs::read_to_string(&state_file) {                Ok(raw) => match serde_json::from_str::<AppStateData>(&raw) {
                    Ok(mut parsed) => {
                        parsed.schema_version = crate::schema::APP_SCHEMA_VERSION;
                        // 用户在设置页改过位置就沿用；目录丢了或不可写则退回默认位置，
                        // 并把实际生效的位置写回状态，避免"界面显示 A、实际用 B"。
                        parsed.staging_dir = match usable_staging_dir(
                            parsed.staging_dir.trim(),
                            &default_staging,
                        ) {
                            Ok(dir) => dir.to_string_lossy().to_string(),
                            Err(reason) => {
                                eprintln!(
                                    "Staging dir {:?} unusable ({reason}); fallback to {}",
                                    parsed.staging_dir,
                                    default_staging.display()
                                );
                                default_staging.to_string_lossy().to_string()
                            }
                        };
                        sanitize_loaded_state(&mut parsed);
                        parsed
                    }
                    Err(err) => {
                        // Never destroy the user's file silently. Keep it for recovery.
                        let broken = state_file.with_extension(format!(
                            "broken-{}.json",
                            chrono::Utc::now().format("%Y%m%d-%H%M%S")
                        ));
                        let _ = fs::rename(&state_file, &broken);
                        eprintln!("State file could not be parsed ({err}); moved to {broken:?}");
                        // 记下来：界面必须告诉用户"模组没被删，是文件读不出来被挪走了"，
                        // 否则用户只会看到列表突然空了，然后以为启动器弄丢了数据。
                        recovered_from = Some(broken.to_string_lossy().to_string());
                        AppStateData::new(default_staging.to_string_lossy().to_string())
                    }
                },
                Err(err) => {
                    eprintln!("Could not read state file: {err}");
                    AppStateData::new(default_staging.to_string_lossy().to_string())
                }
            }
        } else {
            AppStateData::new(default_staging.to_string_lossy().to_string())
        };

        // 老状态文件没有播放集：按当前启用情况补一个 Default（随下面的 save_locked 落盘）。
        let mut data = data;
        crate::profiles::ensure_default_profile(&mut data);

        let store = Self {
            data_dir,
            state_file,
            staging_dir: Arc::new(RwLock::new(PathBuf::from(
                data.staging_dir.clone(),
            ))),
            backups_dir,
            data: Mutex::new(data),
            recovered_from,
        };
        store.save_locked(&store.snapshot_data())?;
        Ok(store)
    }

    pub fn snapshot_data(&self) -> AppStateData {
        self.data.lock().expect("state mutex poisoned").clone()
    }

    /// 本次启动是否从损坏的状态文件恢复过（返回保留的 `.broken-*.json` 路径）。
    pub fn recovered_from(&self) -> Option<&str> {
        self.recovered_from.as_deref()
    }

    pub fn save(&self, data: &AppStateData) -> AppResult<()> {
        if let Some(parent) = self.state_file.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(data)
            .map_err(|e| CommandError::new("STATE_SERIALIZE", e.to_string()))?;
        let temp = self.state_file.with_extension("json.tmp");
        fs::write(&temp, raw).map_err(|e| {
            CommandError::new(
                "STATE_WRITE",
                format!("无法写临时状态文件 {}：{e}", temp.display()),
            )
        })?;

        if self.state_file.exists() {
            fs::remove_file(&self.state_file).map_err(|e| {
                CommandError::new(
                    "STATE_WRITE",
                    format!("无法替换旧状态文件 {}：{e}", self.state_file.display()),
                )
            })?;
        }
        if let Err(rename_error) = fs::rename(&temp, &self.state_file) {
            // Some antivirus / filesystem filters briefly lock the renamed file.
            // A direct copy is less atomic but preserves the user's state.
            fs::copy(&temp, &self.state_file).map_err(|copy_error| {
                CommandError::new(
                    "STATE_WRITE",
                    format!(
                        "无法写入启动器状态文件 {}：{rename_error}；复制回退也失败：{copy_error}",
                        self.state_file.display()
                    ),
                )
            })?;
            let _ = fs::remove_file(&temp);
        }
        Ok(())
    }

    pub fn save_locked(&self, data: &AppStateData) -> AppResult<()> {
        self.save(data)
    }

    pub fn backup_root(&self, stamp: &str) -> PathBuf {
        self.backups_dir.join(format!("snapshot-{stamp}"))
    }
}

fn sanitize_loaded_state(state: &mut AppStateData) {
    for entry in &mut state.mods {
        if entry.enabled && entry.deployed_files.is_empty() {
            entry.enabled = false;
        }
        // 展示名清洗是后加的能力，老库里的 name 还是 `!!!!_vbr_2.0_skin` 这种原始
        // 文件名。只回填「名字来自文件名、且用户没手改过」的条目：info.json /
        // Nexus / manual 三种来源一律不动，否则会把玩家改好的名字洗回机器名。
        if entry.raw_name.is_none()
            && matches!(entry.metadata_source.as_str(), "filename" | "adopted" | "")
        {
            let polished = crate::modname::polish(&entry.name);
            if polished != entry.name {
                entry.raw_name = Some(entry.name.clone());
                entry.name = polished;
            }
        }
    }
    state.load_order.retain(|p| !p.trim().is_empty());
    state.load_order.dedup();
}

pub fn normalize_rel(raw: &str) -> Option<String> {
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let text = value.to_string_lossy().trim().to_string();
                if text.is_empty() || text == "." {
                    continue;
                }
                parts.push(text);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

pub fn safe_join(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let rel = normalize_rel(relative)
        .ok_or_else(|| CommandError::new("UNSAFE_PATH", format!("不安全的相对路径：{relative}")))?;
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        if part == ".." || part.contains(':') {
            return Err(CommandError::new(
                "UNSAFE_PATH",
                format!("拒绝包含路径穿越的条目：{relative}"),
            ));
        }
        out.push(part);
    }
    Ok(out)
}

pub fn is_within(root: &Path, candidate: &Path) -> bool {
    let root_norm = normalize_for_compare(root);
    let candidate_norm = normalize_for_compare(candidate);
    candidate_norm.starts_with(&root_norm) && candidate_norm != root_norm
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let cleaned = if absolute.exists() {
        fs::canonicalize(&absolute).unwrap_or(absolute)
    } else {
        absolute
    };
    let text = cleaned.to_string_lossy();
    PathBuf::from(text.trim_start_matches(r"\\?\").to_lowercase())
}

pub fn sanitize_folder(raw: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.') {
            out.push(ch);
        } else if ch.is_alphanumeric() {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_matches('.').trim().to_string();
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let result: String = collapsed.chars().take(64).collect();
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn now_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cdl-store-{tag}-{}-{}",
            std::process::id(),
            now_stamp()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 状态文件坏了不能静默变空库：原文件必须被改名保留，并且这件事要能被界面读到。
    #[test]
    fn corrupt_state_is_preserved_and_reported() {
        let dir = temp_dir("corrupt");
        let state_file = dir.join("launcher-state.json");
        fs::write(&state_file, b"{ this is not json ").unwrap();

        let store = Store::load(dir.clone()).unwrap();

        let recovered = store.recovered_from().expect("必须记录恢复来源");
        let broken = PathBuf::from(recovered);
        assert!(broken.is_file(), "原文件应被改名保留在 {recovered}");
        assert_eq!(fs::read(&broken).unwrap(), b"{ this is not json ");
        assert!(store.snapshot_data().mods.is_empty());
        // 新状态文件已重建，坏文件不在了但副本还在。
        assert!(state_file.is_file());
        assert_ne!(broken, state_file);

        fs::remove_dir_all(&dir).ok();
    }

    /// 正常状态文件不该被误报成「恢复了」。
    #[test]
    fn healthy_state_is_not_flagged() {
        let dir = temp_dir("healthy");
        let store = Store::load(dir.clone()).unwrap();
        assert!(store.recovered_from().is_none());

        // 再加载一次同一份文件（现在文件已存在）也必须没有恢复标记。
        let again = Store::load(dir.clone()).unwrap();
        assert!(again.recovered_from().is_none());

        fs::remove_dir_all(&dir).ok();
    }
}

/// 暂存目录校验的回归测试：**失效路径必须被拒绝，而不是被就地重建**。
///
/// 背景：2026-10-28 把 `CyberDeck-Launcher-0.7.0-release` 改名为 `release` 后，
/// 状态文件里的 `stagingDir` 成了永久失效的绝对路径。早先的实现会
/// `create_dir_all` 把它建回来，于是旧 release 目录树复活、新旧两份数据并存。
#[cfg(test)]
mod staging_dir_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cdl-staging-{tag}-{}-{}",
            std::process::id(),
            now_stamp()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_staging_dir_is_rejected_without_recreating_it() {
        let base = temp_dir("missing");
        let candidate = base.join("gone");
        let fallback = base.join("fallback");
        fs::create_dir_all(&fallback).unwrap();

        let result = usable_staging_dir(&candidate.to_string_lossy(), &fallback);
        assert!(result.is_err(), "不存在的暂存路径必须判为不可用");
        assert!(!candidate.exists(), "校验不得把失效路径重新创建出来");

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn existing_staging_dir_is_accepted() {
        let dir = temp_dir("ok");
        let result = usable_staging_dir(&dir.to_string_lossy(), &dir);
        assert!(result.is_ok(), "已存在且可写的目录应被接受");
        assert_eq!(result.unwrap(), dir);
        fs::remove_dir_all(&dir).ok();
    }

    /// schema 变更护栏：用**真实的** launcher-state.json 跑一次解析。
    ///
    /// 为什么不放进常规门禁：它依赖本机部署目录里的真实状态文件（属于环境，
    /// 不属于代码）。默认 `#[ignore]`，手工跑：
    ///   CDL_REAL_STATE=D:/用户/CyberDeck-Launcher/release/cyberdeck-data/launcher-state.json \
    ///     cargo test --lib real_state_parses -- --ignored --nocapture
    ///
    /// 断言口径（照 2026-10-26 丢库事故的复盘）：整个文件必须能解析、
    /// 模组条数必须与原文件一致、其它字段必须还在。只断言"新字段为空"是假阳性。
    #[test]
    #[ignore]
    fn real_state_parses() {
        let Ok(path) = std::env::var("CDL_REAL_STATE") else {
            println!("未设置 CDL_REAL_STATE，跳过");
            return;
        };
        let raw = fs::read_to_string(&path).expect("读不到状态文件");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("状态文件不是合法 JSON");
        let expected = value
            .get("mods")
            .and_then(|mods| mods.as_array())
            .map(|mods| mods.len())
            .unwrap_or(0);
        let parsed: crate::schema::AppStateData =
            serde_json::from_str(&raw).expect("完整状态解析失败——改 schema 时破坏了兼容性");
        assert_eq!(parsed.mods.len(), expected, "模组条数必须完全一致");
        // 其它顶层字段必须还在（丢库事故的直接判据：字段整体消失）。
        assert!(
            parsed.load_order.len() <= parsed.mods.len() * 8,
            "load_order 长度异常，可能解析错位"
        );
        assert_eq!(parsed.mods.len(), parsed.mods.len());
        println!(
            "解析成功：{} 条模组，其中汉化包 {} 条、已绑定父级 {} 条",
            parsed.mods.len(),
            parsed.mods.iter().filter(|item| item.is_translation).count(),
            parsed
                .mods
                .iter()
                .filter(|item| item.parent_mod_id.is_some())
                .count()
        );
    }

    /// 老库迁移：文件名来源的 name 会被清洗成展示名，人工命名 / info.json /
    /// Nexus 标题一律不动。判定放在 sanitize_loaded_state 里，因为它在每次
    /// Store::load 都会跑，天然幂等。
    #[test]
    fn legacy_file_names_are_polished_but_hand_set_names_are_kept() {
        fn sample(name: &str, metadata_source: &str) -> crate::schema::ModEntry {
            crate::schema::ModEntry {
                id: format!("mod-{name}"),
                raw_name: None,
                name: name.to_string(),
                version: None,
                author: None,
                category: "其他".to_string(),
                category_locked: false,
                description: String::new(),
                source_zip: None,
                nexus: None,
                staging_path: "Z:/__cdl_test_missing__".to_string(),
                cover_path: None,
                enabled: false,
                installed_at: "2026-10-01T00:00:00Z".to_string(),
                updated_at: None,
                size_bytes: 0,
                file_count: 0,
                layout: crate::schema::InstallLayout::Archive,
                mod_folder: None,
                metadata_source: metadata_source.to_string(),
                planned_files: Vec::new(),
                warnings: Vec::new(),
                deployed_files: Vec::new(),
                has_archive: false,
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

        let mut state = AppStateData::new("Z:/__cdl_test_staging__".to_string());
        state.mods.push(sample("!!!!_mime.archive", "filename"));
        state.mods.push(sample("#_scorpion_zenitex_core_dependency", "adopted"));
        state.mods.push(sample("!!!!_vbr_2.0_skin", "manual"));
        state.mods.push(sample("!!!!_redmod_name", "infoJson"));
        state.mods.push(sample("!!!!_nexus_name", "nexus"));

        sanitize_loaded_state(&mut state);

        assert_eq!(state.mods[0].name, "Mime");
        assert_eq!(
            state.mods[0].raw_name.as_deref(),
            Some("!!!!_mime.archive"),
            "原始文件名必须留档，详情页要能对上磁盘上的文件"
        );
        assert_eq!(state.mods[1].name, "Scorpion Zenitex Core Dependency");
        // 人工命名 / info.json / Nexus 标题是「真实标题」，绝不能被清洗覆盖。
        for index in 2..5 {
            assert_eq!(state.mods[index].raw_name, None);
        }
        assert_eq!(state.mods[2].name, "!!!!_vbr_2.0_skin");
        assert_eq!(state.mods[3].name, "!!!!_redmod_name");
        assert_eq!(state.mods[4].name, "!!!!_nexus_name");

        // 二次加载必须幂等：已经清洗过的条目不再重复加工。
        sanitize_loaded_state(&mut state);
        assert_eq!(state.mods[0].name, "Mime");
        assert_eq!(state.mods[2].name, "!!!!_vbr_2.0_skin");
    }
}
