#![cfg(test)]

//! 既有模组收编（Adopt）的用例。夹具风格与 installer_tests.rs 一致：
//! 真实文件系统 + 内存 Store，跑在 workspace 卷上以规避临时目录 ACL 限制。
//!
//! 注：测试 9（save 失败回滚）用「把状态文件替换成同名目录」注入落盘失败，
//! 不需要侵入 Store。原设计中的双模组中途失败场景因无法确定性注入而降级为
//! 单模组断言（回滚暂存 + 返回 ADOPT_STATE_WRITE）。

use crate::adopt::{self, MaterializeMode};
use crate::game::validate_game_dir;
use crate::installer::{deploy_mod, file_stamp, same_file_identity, undeploy_mod, uninstall_mod};
use crate::schema::{
    AdoptCandidate, AdoptFileRef, DeployedFile, InstallLayout, LinkType, ModEntry,
};
use crate::store::{now_iso, Store};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// adopt::execute / request_cancel 共享一个进程级取消旗标；
/// cargo test 默认并行跑用例，必须串行化，否则一次取消会毒死并发批次。
static EXECUTE_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    EXECUTE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Fixture {
    root: PathBuf,
    store: Store,
    game: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("adopt-{}", uuid::Uuid::new_v4().simple()));
        let data = root.join("data");
        let game = root.join("game");
        std::fs::create_dir_all(game.join("bin").join("x64")).unwrap();
        std::fs::write(
            game.join("bin").join("x64").join("Cyberpunk2077.exe"),
            b"MZ fake test executable",
        )
        .unwrap();
        std::fs::create_dir_all(game.join("archive").join("pc").join("mod")).unwrap();
        let store = Store::load(data).unwrap();
        {
            let mut state = store.data.lock().unwrap();
            state.game_dir = Some(game.to_string_lossy().to_string());
            store.save(&state).unwrap();
        }
        Self { root, store, game }
    }

    /// 在游戏 archive/pc/mod 下放一个未受管文件。
    fn game_file(&self, name: &str, content: &[u8]) -> PathBuf {
        let path = self.game.join("archive").join("pc").join("mod").join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    fn zip(&self, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = self.root.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (entry_name, content) in entries {
            writer.start_file(*entry_name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// 按真实文件信息构造一个可执行的候选（id 用与 scan 相同的稳定推导）。
fn candidate(fixture: &Fixture, rel: &str) -> AdoptCandidate {
    let path = fixture.game.join(rel.replace('/', "\\"));
    let (size, mtime) = file_stamp(&path);
    let name = rel
        .rsplit('/')
        .next()
        .unwrap_or(rel)
        .rsplit_once('.')
        .map(|(stem, _)| stem.to_ascii_lowercase())
        .unwrap_or_default();
    AdoptCandidate {
        id: adopt::candidate_id(rel),
        name,
        archive_rel: rel.to_string(),
        files: vec![AdoptFileRef {
            rel: rel.to_string(),
            size_bytes: size.unwrap_or(0),
            modified_time: mtime,
        }],
        size_bytes: size.unwrap_or(0),
        link_type: LinkType::HardLink,
        already_managed: false,
    }
}

fn no_progress(_: crate::schema::AdoptProgress) {}

/// 测试 1：混合目录分组。
#[test]
fn scan_groups_unmanaged() {
    let fixture = Fixture::new();

    // 一条受管 archive：正常导入 + 部署。
    let zip = fixture.zip("Managed.zip", &[("Managed/managed.archive", b"managed".as_slice())]);
    let entry = crate::installer::install_zip(&fixture.store, zip.to_str().unwrap()).unwrap();
    {
        let mut state = fixture.store.data.lock().unwrap();
        state.mods.push(entry);
        fixture.store.save(&state).unwrap();
    }
    let game_info = validate_game_dir(&fixture.game).unwrap();
    let mod_id = fixture.store.snapshot_data().mods[0].id.clone();
    deploy_mod(&fixture.store, &mod_id, &game_info).unwrap();

    // 未受管：foo.archive + 同词干 foo.xl；独立 bar.xl；modlist.txt。
    fixture.game_file("foo.archive", b"foo-archive");
    fixture.game_file("foo.xl", b"foo-xl");
    fixture.game_file("bar.xl", b"bar-xl");
    fixture.game_file("modlist.txt", b"modlist");

    let report = adopt::scan(&fixture.store).unwrap();

    // foo 组 + bar 独立 xl + 已受管的 managed.archive（already_managed 标记）。
    assert_eq!(report.candidates.len(), 3, "{:?}", report.candidates);

    let foo = report
        .candidates
        .iter()
        .find(|item| item.name == "foo")
        .expect("foo group missing");
    assert_eq!(foo.files.len(), 2, ".xl must follow its .archive");
    assert!(!foo.already_managed);
    assert_eq!(foo.id, adopt::candidate_id("archive/pc/mod/foo.archive"));

    let bar = report
        .candidates
        .iter()
        .find(|item| item.name == "bar")
        .expect("standalone xl missing");
    assert_eq!(bar.files.len(), 1);
    assert_eq!(bar.archive_rel, "archive/pc/mod/bar.xl");

    let managed = report
        .candidates
        .iter()
        .find(|item| item.name == "managed")
        .expect("managed archive should still be listed");
    assert!(managed.already_managed);

    assert!(report
        .candidates
        .iter()
        .all(|item| item.files.iter().all(|file| !file.rel.ends_with("modlist.txt"))));
}

/// 测试 2：同卷收编 → 硬链接反向建链、目标不动、load_order 追加。
#[test]
fn adopt_hardlink_same_volume() {
    let _guard = lock();
    let fixture = Fixture::new();
    let target = fixture.game_file("baz.archive", b"baz-content");
    let before = fs::metadata(&target).unwrap().modified().unwrap();

    let candidates = vec![candidate(&fixture, "archive/pc/mod/baz.archive")];
    let report = adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();
    assert_eq!(report.adopted, 1);
    assert_eq!(report.failed, 0);

    let state = fixture.store.snapshot_data();
    assert_eq!(state.mods.len(), 1);
    let entry = &state.mods[0];
    assert!(entry.enabled);
    assert!(entry.managed);
    assert_eq!(entry.layout, InstallLayout::Archive);
    assert_eq!(entry.deployed_files[0].link_type, LinkType::HardLink);
    assert!(state
        .load_order
        .iter()
        .any(|item| item.eq_ignore_ascii_case("archive/pc/mod/baz.archive")));

    let staging_file = PathBuf::from(&entry.staging_path).join("baz.archive");
    assert!(staging_file.is_file());
    assert!(same_file_identity(&staging_file, &target));

    // 目标文件字节与 mtime 不变（硬链接不改写原文件）。
    assert_eq!(fs::read(&target).unwrap(), b"baz-content");
    assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), before);
}

/// 测试 3：强制 Copy 收编 → 内容一致、目标不变；undeploy 后目标删除、
/// 暂存副本存活；再 deploy_mod 成功重建。
#[test]
fn adopt_copy_and_redeploy() {
    let fixture = Fixture::new();
    let rel = "archive/pc/mod/copy.archive";
    let target = fixture.game_file("copy.archive", b"original-bytes");

    let staging_dir = fixture.store.staging_dir().join("adopt-0000000000000042");
    fs::create_dir_all(&staging_dir).unwrap();
    let staging_file = staging_dir.join("copy.archive");
    let link = adopt::materialize(&target, &staging_file, MaterializeMode::Copy).unwrap();
    assert_eq!(link, LinkType::Copy);
    adopt::verify_copy(&target, &staging_file, link).unwrap();
    assert_eq!(fs::read(&staging_file).unwrap(), b"original-bytes");
    // 复制不动目标。
    assert_eq!(fs::read(&target).unwrap(), b"original-bytes");

    // 按收编语义手工登记一个 Copy 条目（与 execute 的 build_entry 同构）。
    let (size, mtime) = file_stamp(&target);
    let entry = ModEntry {
        id: "adopt-0000000000000042".to_string(),
        raw_name: None,
        name: "copy".to_string(),
        version: None,
        author: None,
        category: "其他".to_string(),
        category_locked: false,
        description: String::new(),
        source_zip: None,
        nexus: None,
        staging_path: staging_dir.to_string_lossy().to_string(),
        cover_path: None,
        enabled: true,
        installed_at: now_iso(),
        updated_at: None,
        size_bytes: size.unwrap_or(0),
        file_count: 1,
        layout: InstallLayout::Archive,
        mod_folder: None,
        metadata_source: "adopted".to_string(),
        planned_files: vec![rel.to_string()],
        warnings: Vec::new(),
        deployed_files: vec![DeployedFile {
            source: staging_file.to_string_lossy().to_string(),
            target: target.to_string_lossy().to_string(),
            link_type: LinkType::Copy,
            relative_path: rel.to_string(),
            size,
            modified_time: mtime,
        }],
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
        is_translation: false,
        parent_mod_id: None,
        ai_loc: None,
        ai_fix: Vec::new(),
    };
    {
        let mut state = fixture.store.data.lock().unwrap();
        state.mods.push(entry);
        state.load_order.push(rel.to_string());
        fixture.store.save(&state).unwrap();
    }

    // undeploy：游戏项删除、暂存副本存活。
    let warnings = undeploy_mod(&fixture.store, "adopt-0000000000000042", &fixture.game).unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(!target.exists());
    assert!(staging_file.is_file());
    assert_eq!(fs::read(&staging_file).unwrap(), b"original-bytes");

    // 再部署：deploy_mod 从暂存副本重建（同卷 → 硬链接）。
    let game_info = validate_game_dir(&fixture.game).unwrap();
    let report = deploy_mod(&fixture.store, "adopt-0000000000000042", &game_info).unwrap();
    assert_eq!(report.deployed, 1);
    assert!(target.is_file());
    assert_eq!(fs::read(&target).unwrap(), b"original-bytes");
}

/// 旧状态仍记录已经搬走的 staging 路径：撤除前先从自己的部署清单恢复，
/// 随后正常撤除并再次部署。不会改写或搬动游戏侧原文件来“凑”暂存。
#[test]
fn broken_staging_recovers_before_undeploy_and_redeploys() {
    let _guard = lock();
    let fixture = Fixture::new();
    let target = fixture.game_file("recover.archive", b"verified-original");
    adopt::execute(
        &fixture.store,
        &[candidate(&fixture, "archive/pc/mod/recover.archive")],
        &mut no_progress,
    )
    .unwrap();
    let id = fixture.store.snapshot_data().mods[0].id.clone();
    let old = PathBuf::from(&fixture.store.snapshot_data().mods[0].staging_path);
    let moved = fixture.root.join("old-staging-location");
    fs::rename(&old, &moved).unwrap();

    undeploy_mod(&fixture.store, &id, &fixture.game).unwrap();
    assert!(!target.exists());
    let repaired = fixture.store.snapshot_data().mods.remove(0);
    assert!(!repaired.enabled);
    assert_eq!(repaired.staging_path, fixture.store.staging_dir().join(&id).to_string_lossy());
    assert_eq!(fs::read(PathBuf::from(&repaired.staging_path).join("recover.archive")).unwrap(), b"verified-original");
    // 清单保留到 save 完成后的旧文件不在内存中被提前清空；这里验证最终重新部署。
    let game = validate_game_dir(&fixture.game).unwrap();
    assert_eq!(deploy_mod(&fixture.store, &id, &game).unwrap().deployed, 1);
    assert_eq!(fs::read(target).unwrap(), b"verified-original");
}

#[test]
fn broken_staging_recovers_while_mod_remains_enabled() {
    let _guard = lock();
    let fixture = Fixture::new();
    let target = fixture.game_file("in-place.archive", b"same-game-bytes");
    let before = fs::metadata(&target).unwrap();
    adopt::execute(
        &fixture.store,
        &[candidate(&fixture, "archive/pc/mod/in-place.archive")],
        &mut no_progress,
    )
    .unwrap();
    let id = fixture.store.snapshot_data().mods[0].id.clone();
    let old = PathBuf::from(&fixture.store.snapshot_data().mods[0].staging_path);
    fs::rename(&old, fixture.root.join("moved-staging")).unwrap();
    let game = validate_game_dir(&fixture.game).unwrap();
    let report = deploy_mod(&fixture.store, &id, &game).unwrap();
    assert_eq!(report.deployed, 0);
    let state = fixture.store.snapshot_data();
    assert!(Path::new(&state.mods[0].staging_path).join("in-place.archive").is_file());
    assert_eq!(fs::read(&target).unwrap(), b"same-game-bytes");
    assert_eq!(fs::metadata(&target).unwrap().len(), before.len());
}

#[test]
fn broken_staging_refuses_changed_game_file() {
    let _guard = lock();
    let fixture = Fixture::new();
    let target = fixture.game_file("changed.archive", b"before");
    adopt::execute(
        &fixture.store,
        &[candidate(&fixture, "archive/pc/mod/changed.archive")],
        &mut no_progress,
    )
    .unwrap();
    let id = fixture.store.snapshot_data().mods[0].id.clone();
    let old = PathBuf::from(&fixture.store.snapshot_data().mods[0].staging_path);
    fs::rename(&old, fixture.root.join("moved-staging")).unwrap();
    fs::remove_file(&target).unwrap();
    fs::write(&target, b"externally changed").unwrap();
    let error = undeploy_mod(&fixture.store, &id, &fixture.game).unwrap_err();
    assert_eq!(error.code, "STAGING_RECOVERY_CHANGED");
    assert_eq!(fs::read(&target).unwrap(), b"externally changed");
    assert!(fixture.store.snapshot_data().mods[0].enabled);
}

/// 测试 4：verify_copy 大小不符 → ADOPT_VERIFY_FAILED；
/// execute 场景一个候选目标缺失 → failed=1、其余 adopted、原始文件不动。
#[test]
fn adopt_verify_failure_skips() {
    let _guard = lock();
    let fixture = Fixture::new();

    // 直接验证：复制后篡改暂存副本，verify_copy 必须拒绝。
    let target = fixture.game_file("tampered.archive", b"same-size-content");
    let staging_file = fixture.store.staging_dir().join("tamper-check.archive");
    let link = adopt::materialize(&target, &staging_file, MaterializeMode::Copy).unwrap();
    fs::write(&staging_file, b"different-size!!").unwrap();
    let err = adopt::verify_copy(&target, &staging_file, link).unwrap_err();
    assert_eq!(err.code, "ADOPT_VERIFY_FAILED");
    let _ = fs::remove_file(&staging_file);

    // execute 场景：一个候选指向不存在的目标。
    fixture.game_file("kept.archive", b"kept-content");
    let ok = candidate(&fixture, "archive/pc/mod/kept.archive");

    let missing_rel = "archive/pc/mod/ghost.archive";
    let mut missing = candidate(&fixture, missing_rel);
    missing.files[0].size_bytes = 0;
    missing.size_bytes = 0;

    let report = adopt::execute(&fixture.store, &vec![ok, missing.clone()], &mut no_progress).unwrap();
    assert_eq!(report.adopted, 1);
    assert_eq!(report.failed, 1);

    let failed = report
        .outcomes
        .iter()
        .find(|item| item.id == missing.id)
        .unwrap();
    assert_eq!(failed.error.as_ref().unwrap().code, "ADOPT_STAGING_FAILED");

    // 原始文件全部不动。
    assert_eq!(
        fs::read(fixture.game.join("archive/pc/mod/kept.archive")).unwrap(),
        b"kept-content"
    );
    assert!(
        !fixture.store.staging_dir().join(missing.id).exists(),
        "failed candidate staging must be rolled back"
    );
}

/// 测试 5：收编后 undeploy_mod —— 游戏项删除、暂存文件仍在、无 warning。
#[test]
fn adopt_then_undeploy() {
    let _guard = lock();
    let fixture = Fixture::new();
    fixture.game_file("kept.archive", b"kept-content");
    let candidates = vec![candidate(&fixture, "archive/pc/mod/kept.archive")];
    let report = adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();
    assert_eq!(report.adopted, 1);
    let id = report.mods[0].id.clone();
    let staging_file = PathBuf::from(&report.mods[0].staging_path).join("kept.archive");

    let warnings = undeploy_mod(&fixture.store, &id, &fixture.game).unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(!fixture.game.join("archive/pc/mod/kept.archive").exists());
    assert!(staging_file.is_file());
    assert_eq!(fs::read(&staging_file).unwrap(), b"kept-content");
}

/// 测试 6：收编后目标被外部替换 → undeploy 拒绝删除被替换的文件。
#[test]
fn adopt_undeploy_refuses_replaced_target() {
    let _guard = lock();
    let fixture = Fixture::new();
    fixture.game_file("swapped.archive", b"ours");
    let candidates = vec![candidate(&fixture, "archive/pc/mod/swapped.archive")];
    let report = adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();
    let id = report.mods[0].id.clone();

    let target = fixture.game.join("archive/pc/mod/swapped.archive");
    fs::remove_file(&target).unwrap();
    fs::write(&target, b"user replaced this").unwrap();

    let warnings = undeploy_mod(&fixture.store, &id, &fixture.game).unwrap();
    assert!(
        warnings.iter().any(|warning| warning.contains("拒绝删除")),
        "{warnings:?}"
    );
    assert_eq!(fs::read(&target).unwrap(), b"user replaced this");
}

/// 测试 7：收编后 uninstall —— 条目移除、staging 目录删除、load_order 清理。
#[test]
fn adopt_then_uninstall() {
    let _guard = lock();
    let fixture = Fixture::new();
    fixture.game_file("gone.archive", b"soon-gone");
    let candidates = vec![candidate(&fixture, "archive/pc/mod/gone.archive")];
    let report = adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();
    let id = report.mods[0].id.clone();
    let staging_dir = PathBuf::from(&report.mods[0].staging_path);
    assert!(staging_dir.is_dir());
    assert!(fixture
        .store
        .snapshot_data()
        .load_order
        .iter()
        .any(|item| item.eq_ignore_ascii_case("archive/pc/mod/gone.archive")));

    uninstall_mod(&fixture.store, &id, Some(&fixture.game)).unwrap();
    let state = fixture.store.snapshot_data();
    assert!(state.mods.is_empty());
    assert!(!staging_dir.exists());
    // uninstall_mod 零修改复用：state.load_order 里的陈旧路径要等下次
    // normalized_order（加载顺序视图/modlist 写入）才被剪掉 —— 与既有
    // 普通模组卸载行为一致。这里验证规范化后确实清理。
    let normalized = crate::loadorder::normalized_order(&state);
    assert!(!normalized
        .iter()
        .any(|item| item.eq_ignore_ascii_case("archive/pc/mod/gone.archive")));
}

/// 测试 8：预先请求取消 → execute 零改动、cancelled=true。
#[test]
fn adopt_cancel_rolls_back_current() {
    let _guard = lock();
    let fixture = Fixture::new();
    fixture.game_file("pending.archive", b"pending-content");
    let candidates = vec![candidate(&fixture, "archive/pc/mod/pending.archive")];

    let _ = adopt::request_cancel();
    let report = adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();
    assert!(report.cancelled);
    assert_eq!(report.adopted, 0);

    let state = fixture.store.snapshot_data();
    assert!(state.mods.is_empty());
    assert!(fixture.game.join("archive/pc/mod/pending.archive").is_file());
    assert!(!fixture
        .store
        .staging_dir()
        .join(&candidates[0].id)
        .exists());

    // 取消旗标在 execute 结束后自动复位：下一次执行不受影响。
    let again = adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();
    assert!(!again.cancelled);
    assert_eq!(again.adopted, 1);
}

/// 测试 9：登记落盘失败 → ADOPT_STATE_WRITE、暂存回滚、库内零残留。
#[test]
fn adopt_rollback_on_state_write_fail() {
    let _guard = lock();
    let fixture = Fixture::new();
    fixture.game_file("sabotaged.archive", b"sabotage-content");
    let candidates = vec![candidate(&fixture, "archive/pc/mod/sabotaged.archive")];
    let id = &candidates[0].id;

    // 注入 save 失败：把状态文件替换成同名目录（fs 写入必然失败）。
    let state_file = fixture.store.state_file.clone();
    fs::remove_file(&state_file).unwrap();
    fs::create_dir(&state_file).unwrap();

    let err = adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap_err();
    assert_eq!(err.code, "ADOPT_STATE_WRITE");

    // 暂存回滚、游戏文件原样、库内零残留。
    assert!(!fixture.store.staging_dir().join(id).exists());
    assert!(fixture.game.join("archive/pc/mod/sabotaged.archive").is_file());
    assert!(fixture.store.snapshot_data().mods.is_empty());

    // 清理注入，避免 Drop 阶段目录删除出现意外。
    fs::remove_dir(&state_file).unwrap();
}
