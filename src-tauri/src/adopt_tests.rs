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
use std::path::PathBuf;
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
        source: "archive".to_string(),
        absorb_entry_ids: Vec::new(),
    }
}

fn no_progress(_: crate::schema::AdoptProgress) {}

/// 收编暂存现在保留游戏相对结构（同一个模组可能同时含 `archive/` 与 `r6/`
/// 下的同名文件，平铺会互相覆盖），断言统一走这个辅助函数。
fn staged_path(staging: &str, rel: &str) -> PathBuf {
    PathBuf::from(staging).join(rel.replace('/', "\\"))
}

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

    let staging_file = staged_path(&entry.staging_path, "archive/pc/mod/baz.archive");
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

/// 收编 Mod 的暂存副本丢失后，禁用仍然成功：**只断链接，不重建暂存**。
///
/// 这条用例 2026-11-02 重写过。旧版本断言"撤除前先从游戏目录把文件复制回暂存区"，
/// 结果就是玩家报的那个错：`staging/adopt-xxx` 这个目录名还被占着时直接抛
/// 「恢复目标已存在」，禁用彻底卡死；即便不冲突，也会凭空多出一份用户不知道的
/// 副本，和外部工具里的原件分叉。收编语义下这层恢复本来就没有意义——母本在
/// Vortex 目录里，本启动器只是把它链进游戏目录。
///
/// 代价（有意接受）：重新启用需要重新扫描收编，不能靠暂存副本原地复活。
#[test]
fn adopted_undeploy_cuts_links_without_rebuilding_staging() {
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

    let warnings = undeploy_mod(&fixture.store, &id, &fixture.game).unwrap();
    assert!(!target.exists(), "游戏目录里的链接必须断掉");
    let entry = fixture.store.snapshot_data().mods.remove(0);
    assert!(!entry.enabled);
    assert!(entry.deployed_files.is_empty());
    assert!(
        !fixture.store.staging_dir().join(&id).exists(),
        "绝不允许把游戏目录的文件复制回暂存区：{}",
        fixture.store.staging_dir().join(&id).display()
    );
    assert!(
        warnings.iter().any(|item| item.contains("重新扫描收编")),
        "要明说重新启用需要重新收编：{warnings:?}"
    );
    // 重新启用会明确报"暂存不见了"，而不是静默失败或凭空成功。
    let game = validate_game_dir(&fixture.game).unwrap();
    assert!(deploy_mod(&fixture.store, &id, &game).is_err());
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
    assert!(staged_path(&state.mods[0].staging_path, "archive/pc/mod/in-place.archive").is_file());
    assert_eq!(fs::read(&target).unwrap(), b"same-game-bytes");
    assert_eq!(fs::metadata(&target).unwrap().len(), before.len());
}

/// 玩家实测场景的逐字复现：暂存记录指向的旧路径已经不在，但 `staging/<id>`
/// 这个**目录名被占着**（旧数据目录迁移 / 同名残留）。旧实现在这里抛
/// 「恢复目标已存在，请先检查暂存目录」，禁用彻底卡死。
#[test]
fn adopted_undeploy_survives_taken_staging_name() {
    let _guard = lock();
    let fixture = Fixture::new();
    let target = fixture.game_file("taken.archive", b"taken-name-bytes");
    adopt::execute(
        &fixture.store,
        &[candidate(&fixture, "archive/pc/mod/taken.archive")],
        &mut no_progress,
    )
    .unwrap();
    let id = fixture.store.snapshot_data().mods[0].id.clone();
    let old = PathBuf::from(&fixture.store.snapshot_data().mods[0].staging_path);
    // ① 真实成因：记录里还写着旧数据目录的绝对路径（迁移前），那个目录早就没了。
    fs::rename(&old, fixture.root.join("moved-away")).unwrap();
    {
        let mut state = fixture.store.data.lock().unwrap();
        state.mods[0].staging_path = fixture
            .root
            .join("old-data")
            .join("staging")
            .join(&id)
            .to_string_lossy()
            .to_string();
        fixture.store.save(&state).unwrap();
    }
    // ② 当前暂存区里同名目录被占着（同名残留）——旧实现正是在这里抛
    //    「恢复目标已存在」，因为它把 next_root 算成了这个路径。
    let taken = fixture.store.staging_dir().join(&id);
    fs::create_dir_all(&taken).unwrap();
    fs::write(taken.join("someone-else.bin"), b"occupied").unwrap();

    let warnings = undeploy_mod(&fixture.store, &id, &fixture.game)
        .expect("收编模组禁用不得因为暂存目录名被占而失败");
    assert!(!target.exists(), "链接必须断掉");
    assert!(
        taken.join("someone-else.bin").is_file(),
        "不得改动不属于这个模组的暂存内容"
    );
    assert!(
        !warnings.iter().any(|item| item.contains("恢复目标已存在")),
        "{warnings:?}"
    );
    let entry = fixture.store.snapshot_data().mods.remove(0);
    assert!(!entry.enabled && entry.deployed_files.is_empty());
}

/// 暂存副本没了、游戏侧文件又被外部改过：既比不了 inode，也谈不上"恢复暂存"。
///
/// 收编语义下按部署清单直删——清单是唯一凭据，母本在外部工具目录里，删了不丢
/// 数据；反过来若因此拒删，"禁用"就是假的（文件还躺在 archive/pc/mod 里被加载）。
/// 旧版本断言这里返回 `STAGING_RECOVERY_CHANGED` 硬错误，等于禁用永远失败。
#[test]
fn adopted_undeploy_trusts_manifest_when_staging_is_gone() {
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

    let warnings = undeploy_mod(&fixture.store, &id, &fixture.game).unwrap();
    assert!(!target.exists(), "禁用必须真的切断链接");
    let entry = fixture.store.snapshot_data().mods.remove(0);
    assert!(!entry.enabled);
    assert!(entry.deployed_files.is_empty());
    assert!(
        warnings.iter().any(|item| item.contains("重新扫描收编")),
        "{warnings:?}"
    );
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
    let staging_file = staged_path(&report.mods[0].staging_path, "archive/pc/mod/kept.archive");

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

/// 2026-11-06 用户反馈「模组数量怎么还不对」的根因回归。
///
/// ArchiveXL 的标准写法是 `X.archive` 配 `X.archive.xl`（元数据文件名带 archive 全名），
/// 而旧逻辑只认同词干 `X.archive` + `X.xl`。于是真机上每个 mod 都被拆成两条记录，
/// 实测 119 条里 37 条是这种碎片，用户看到的就是「数量虚高」。
#[test]
fn archive_xl_companion_follows_its_archive() {
    let fixture = Fixture::new();
    fixture.game_file("VirtualAtelier.archive", b"body");
    fixture.game_file("VirtualAtelier.archive.xl", b"meta");
    // 只有元数据、没有主体的汉化包（ArchiveXL 的 extend 写法），应独立成候选。
    fixture.game_file("zz-VirtualAtelier-CHS.archive.xl", b"chs-meta");

    let report = adopt::scan(&fixture.store).unwrap();
    assert_eq!(report.candidates.len(), 2, "{:?}", report.candidates);

    let main = report
        .candidates
        .iter()
        .find(|item| item.archive_rel.eq_ignore_ascii_case("archive/pc/mod/VirtualAtelier.archive"))
        .expect("主体候选丢失");
    assert_eq!(
        main.files.len(),
        2,
        "标准写法的 .archive.xl 必须跟随主体，不能单独成条：{:?}",
        main.files
    );
    assert!(main
        .files
        .iter()
        .any(|file| file.rel.eq_ignore_ascii_case("archive/pc/mod/VirtualAtelier.archive.xl")));

    let orphan = report
        .candidates
        .iter()
        .find(|item| item.archive_rel.contains("zz-VirtualAtelier-CHS"))
        .expect("孤立元数据应独立成候选");
    assert_eq!(orphan.files.len(), 1);
}

/// 库整理：历史遗留的「碎片条目」要能并回主体，且不改游戏目录、不动暂存文件。
#[test]
fn normalize_merges_companion_fragments_into_body() {
    let _guard = lock();
    let fixture = Fixture::new();
    fixture.game_file("Normalized.archive", b"body-bytes");
    fixture.game_file("Normalized.archive.xl", b"meta-bytes");

    // 先按修好后的配对收编一次：主体 + 伴生元数据进同一条记录。
    let candidates = vec![candidate(&fixture, "archive/pc/mod/Normalized.archive")];
    let candidates = {
        // candidate() 只带主体一个文件，这里补上伴生文件，模拟 scan 的正常输出。
        let mut list = candidates;
        let meta = fixture.game.join("archive").join("pc").join("mod").join("Normalized.archive.xl");
        let (size, mtime) = file_stamp(&meta);
        list[0].files.push(AdoptFileRef {
            rel: "archive/pc/mod/Normalized.archive.xl".to_string(),
            size_bytes: size.unwrap_or(0),
            modified_time: mtime,
        });
        list[0].size_bytes += size.unwrap_or(0);
        list
    };
    adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();

    // 还原成 bug 时代的形态：主体一条 + 碎片一条。
    {
        let mut state = fixture.store.data.lock().unwrap();
        let main = state.mods[0].clone();
        let meta = main
            .deployed_files
            .iter()
            .find(|file| file.relative_path.to_ascii_lowercase().ends_with(".archive.xl"))
            .expect("伴生文件应已登记")
            .clone();
        state.mods[0]
            .deployed_files
            .retain(|file| !file.relative_path.to_ascii_lowercase().ends_with(".archive.xl"));
        state.mods[0].file_count = state.mods[0].deployed_files.len();

        let mut fragment = main.clone();
        fragment.id = "adopt-fragment-for-test".to_string();
        fragment.name = "normalized.archive".to_string();
        fragment.deployed_files = vec![meta];
        fragment.planned_files = vec!["archive/pc/mod/Normalized.archive.xl".to_string()];
        fragment.size_bytes = 9;
        fragment.file_count = 1;
        state.mods.push(fragment);
        fixture.store.save(&state).unwrap();
    }
    assert_eq!(fixture.store.snapshot_data().mods.len(), 2, "前置：应有两条件记录");

    let report = adopt::normalize_library(&fixture.store).unwrap();
    assert_eq!(report.merged, 1, "{report:?}");
    assert_eq!(report.merged_names.len(), 1);

    let state = fixture.store.snapshot_data();
    assert_eq!(state.mods.len(), 1, "碎片条目应已并回主体");
    assert_eq!(state.mods[0].deployed_files.len(), 2, "主体的部署清单应含伴生元数据");
    assert_eq!(state.mods[0].file_count, 2);
    // 游戏目录一个字节都不该被动过。
    assert_eq!(
        fs::read(fixture.game.join("archive").join("pc").join("mod").join("Normalized.archive")).unwrap(),
        b"body-bytes"
    );
    assert_eq!(
        fs::read(fixture.game.join("archive").join("pc").join("mod").join("Normalized.archive.xl")).unwrap(),
        b"meta-bytes"
    );

    // 幂等：再跑一次没有可合并的东西。
    let again = adopt::normalize_library(&fixture.store).unwrap();
    assert_eq!(again.merged, 0);
}

/// 库整理第二段：只剩 `X.archive.xl`、主体既不在库也不在游戏目录的条目，
/// 在游戏里不产生任何效果，却占着「已安装」计数——整理时要清掉记录。
/// 只清记录：游戏目录里的 .xl 与暂存文件都不动。
#[test]
fn normalize_removes_metadata_only_entries_without_body() {
    let _guard = lock();
    let fixture = Fixture::new();
    fixture.game_file("Keep.archive", b"keep-bytes");

    let candidates = vec![candidate(&fixture, "archive/pc/mod/Keep.archive")];
    adopt::execute(&fixture.store, &candidates, &mut no_progress).unwrap();

    // 造一条 bug 时代遗留的「孤儿元数据」条目。
    {
        let mut state = fixture.store.data.lock().unwrap();
        let mut ghost = state.mods[0].clone();
        ghost.id = "adopt-ghost-metadata-only".to_string();
        ghost.name = "ghost".to_string();
        ghost.deployed_files[0].relative_path = "archive/pc/mod/Ghost.archive.xl".to_string();
        ghost.planned_files = vec!["archive/pc/mod/Ghost.archive.xl".to_string()];
        ghost.file_count = 1;
        state.mods.push(ghost);
        fixture.store.save(&state).unwrap();
    }
    assert_eq!(fixture.store.snapshot_data().mods.len(), 2);

    let report = adopt::normalize_library(&fixture.store).unwrap();
    assert_eq!(report.removed.len(), 1, "{report:?}");
    assert_eq!(report.merged, 0);

    let state = fixture.store.snapshot_data();
    assert_eq!(state.mods.len(), 1, "孤儿元数据条目应被清掉");
    assert_eq!(state.mods[0].name, "keep");
}

/// 构造一条「按文件反推」的碎片条目（模拟 2026-11-06 之前收编留下的记录）。
fn fragment_entry(id: &str, rel: &str) -> ModEntry {
    ModEntry {
        id: id.to_string(),
        raw_name: None,
        name: rel.to_string(),
        version: None,
        author: None,
        category: "其他".to_string(),
        category_locked: false,
        description: String::new(),
        source_zip: None,
        nexus: None,
        staging_path: String::new(),
        cover_path: None,
        enabled: true,
        installed_at: now_iso(),
        updated_at: None,
        size_bytes: 0,
        file_count: 1,
        layout: InstallLayout::Archive,
        mod_folder: None,
        metadata_source: "adopted".to_string(),
        planned_files: vec![rel.to_string()],
        warnings: Vec::new(),
        deployed_files: vec![DeployedFile {
            source: String::new(),
            target: String::new(),
            link_type: LinkType::HardLink,
            relative_path: rel.to_string(),
            size: None,
            modified_time: None,
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
    }
}

/// Vortex 口径：一个 mod 目录 = 一条候选，且要能吸收按文件反推的碎片条目。
///
/// 这正是实机上 82 条对 222 条的根因修复点：旧口径把同一个 mod 拆成多条，
/// 而 `archive/pc/mod/<子目录>/x.archive` 这种干脆一条都扫不到。
#[test]
fn vortex_dir_candidate_absorbs_archive_fragments() {
    let fixture = Fixture::new();
    fixture.game_file("top.archive", b"top");
    let nested = fixture.game.join("archive").join("pc").join("mod").join("skin pack");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("skin.archive"), b"skin").unwrap();
    let scripts = fixture.game.join("r6").join("scripts").join("mymod");
    fs::create_dir_all(&scripts).unwrap();
    fs::write(scripts.join("main.reds"), b"module MyMod").unwrap();

    let vortex_root = fixture.root.join("vortex-mods");
    let mod_dir = vortex_root.join("My Mod-1234-1-0-1700000000");
    for rel in [
        "archive/pc/mod/top.archive",
        "archive/pc/mod/skin pack/skin.archive",
        "r6/scripts/mymod/main.reds",
    ] {
        let path = mod_dir.join(rel.replace('/', "\\"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"mirror").unwrap();
    }

    let state = {
        let mut state = fixture.store.data.lock().unwrap();
        state
            .mods
            .push(fragment_entry("adopt-00000000000000a1", "archive/pc/mod/top.archive"));
        state.mods.push(fragment_entry(
            "adopt-00000000000000b2",
            "archive/pc/mod/skin pack/skin.archive",
        ));
        state.clone()
    };

    let mut candidates = Vec::new();
    adopt::append_vortex_candidates_from(
        &vortex_root,
        &state,
        &fixture.game,
        &fixture.root.join("staging"),
        &mut candidates,
    );

    assert_eq!(candidates.len(), 1, "一个目录只应产出一条候选");
    let candidate = &candidates[0];
    assert_eq!(candidate.source, "vortex");
    assert_eq!(candidate.name, "My Mod");
    assert_eq!(candidate.files.len(), 3);
    assert!(!candidate.already_managed);
    let mut absorbed = candidate.absorb_entry_ids.clone();
    absorbed.sort();
    assert_eq!(
        absorbed,
        vec![
            "adopt-00000000000000a1".to_string(),
            "adopt-00000000000000b2".to_string()
        ],
        "两条碎片记录都应被并入"
    );
}

/// 空目录（内容被挪走/隔离过）与纯元数据目录不能产出候选。
#[test]
fn vortex_empty_dirs_are_skipped() {
    let fixture = Fixture::new();
    let vortex_root = fixture.root.join("vortex-empty");
    fs::create_dir_all(vortex_root.join("Ghost Mod-1-1-0-1700000000")).unwrap();
    fs::create_dir_all(vortex_root.join("__vortex_backup")).unwrap();
    fs::write(vortex_root.join("__vortex_backup").join("x.bin"), b"x").unwrap();

    let state = fixture.store.snapshot_data();
    let mut candidates = Vec::new();
    adopt::append_vortex_candidates_from(
        &vortex_root,
        &state,
        &fixture.game,
        &fixture.root.join("staging"),
        &mut candidates,
    );
    assert!(candidates.is_empty());
}

/// 幽灵条目：部署清单指向的文件一个都不存在 → 清掉记录（不碰文件）。
///
/// 实机样本：早期收编把 Vortex 的存储目录名当成了游戏内目录名，在
/// `r6/scripts/DigitalVixenCore 28390 4.9.10 …/` 下记了 655 条，而该目录
/// 从未被创建。这类条目一禁用就报「目标不存在」，必须清掉。
#[test]
fn normalize_removes_ghost_entries() {
    let fixture = Fixture::new();
    fixture.game_file("alive.archive", b"alive");

    let mut ghost = fragment_entry(
        "adopt-00000000000000c3",
        "r6/scripts/DigitalVixenCore 28390 4.9.10 2026-11-02T11-50Z rxs7xRen8/dvcore.reds",
    );
    ghost.name = "Ghost Mod".to_string();
    let keep = fragment_entry("adopt-00000000000000d4", "archive/pc/mod/alive.archive");

    {
        let mut state = fixture.store.data.lock().unwrap();
        state.mods.push(ghost);
        state.mods.push(keep);
        fixture.store.save(&state).unwrap();
    }

    let report = adopt::normalize_library(&fixture.store).unwrap();
    assert_eq!(report.removed, vec!["Ghost Mod".to_string()]);
    let state = fixture.store.snapshot_data();
    assert_eq!(state.mods.len(), 1);
    assert_eq!(state.mods[0].id, "adopt-00000000000000d4");
}
