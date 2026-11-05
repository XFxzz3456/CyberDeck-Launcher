#![cfg(test)]

use crate::game::validate_game_dir;
use crate::installer::{
    all_conflicts, collect_conflicts, deploy_mod, install_archive, install_zip, staged_conflicts,
    undeploy_mod, uninstall_mod,
};
use crate::loadorder::{build_view, normalized_order, write_modlist, MANAGED_HEADER};
use crate::schema::{InstallLayout, ModEntry};
use crate::store::Store;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

struct Fixture {
    root: PathBuf,
    store: Store,
    game: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        // Keep fixtures on the workspace volume. Some CI/sandbox profiles deny
        // writes to the system temp directory, and the test is about file logic,
        // not about where Windows happens to put Temp.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("run-{}", uuid::Uuid::new_v4().simple()));
        let data = root.join("data");
        let game = root.join("game");
        std::fs::create_dir_all(game.join("bin").join("x64")).unwrap();
        std::fs::write(
            game.join("bin").join("x64").join("Cyberpunk2077.exe"),
            b"MZ fake test executable",
        )
        .unwrap();
        let store = Store::load(data).unwrap();
        Self { root, store, game }
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

    fn sevenz(&self, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let source = self
            .root
            .join(format!("sevenz-src-{}", uuid::Uuid::new_v4().simple()));
        for (entry_name, content) in entries {
            let target = source.join(entry_name.replace('\\', "/"));
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, content).unwrap();
        }
        let path = self.root.join(name);
        sevenz_rust::compress_to_path(&source, &path).unwrap();
        std::fs::remove_dir_all(source).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn archive_entry(name: &str) -> (String, Vec<u8>) {
    (name.to_string(), b"fake archive bytes".to_vec())
}

/// Mirrors the `install_mods` command: extract, then register in the store.
fn install(fixture: &Fixture, zip: &Path) -> ModEntry {
    let entry = install_zip(&fixture.store, zip.to_str().unwrap()).unwrap();
    let mut state = fixture.store.data.lock().unwrap();
    state.mods.push(entry.clone());
    fixture.store.save(&state).unwrap();
    entry
}

#[test]
fn archive_mod_deploys_and_undeploys_without_touching_staging() {
    let fixture = Fixture::new();
    let (entry_name, bytes) = archive_entry("MyMod/weapons.archive");
    let zip = fixture.zip("CoolWeapons.zip", &[(entry_name.as_str(), bytes.as_slice())]);
    let mod_entry = install(&fixture, &zip);

    assert_eq!(mod_entry.layout, InstallLayout::Archive);
    assert!(!mod_entry.enabled);
    assert_eq!(mod_entry.deployed_files.len(), 0);
    assert_eq!(mod_entry.metadata_source, "filename");

    let game = validate_game_dir(&fixture.game).unwrap();
    let report = deploy_mod(&fixture.store, &mod_entry.id, &game).unwrap();
    assert_eq!(report.deployed, 1);
    assert_eq!(report.hard_links, 1);
    assert!(mod_entry.enabled == false);
    assert!(fixture
        .game
        .join("archive")
        .join("pc")
        .join("mod")
        .join("weapons.archive")
        .is_file());

    let state = fixture.store.snapshot_data();
    assert!(state.mods[0].enabled);
    assert_eq!(state.mods[0].deployed_files.len(), 1);

    let warnings =
        undeploy_mod(&fixture.store, &mod_entry.id, &fixture.game).unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(!fixture
        .game
        .join("archive")
        .join("pc")
        .join("mod")
        .join("weapons.archive")
        .exists());
    assert!(PathBuf::from(&state.mods[0].staging_path)
        .join("weapons.archive")
        .is_file());

    uninstall_mod(&fixture.store, &mod_entry.id, Some(&fixture.game)).unwrap();
    assert_eq!(fixture.store.snapshot_data().mods.len(), 0);
    assert!(!Path::new(&state.mods[0].staging_path).exists());
}

#[test]
fn redmod_layout_maps_into_mods_folder() {
    let fixture = Fixture::new();
    let info = br#"{"name":"Test REDmod","version":"1.2.3","author":"Tester"}"#;
    let archive = b"redmod archive";
    let zip = fixture.zip(
        "TestREDmod.zip",
        &[
            ("info.json", info.as_slice()),
            ("archives/test.archive", archive.as_slice()),
        ],
    );
    let mod_entry = install(&fixture, &zip);
    assert_eq!(mod_entry.layout, InstallLayout::Redmod);
    assert_eq!(mod_entry.name, "Test REDmod");
    assert_eq!(mod_entry.version.as_deref(), Some("1.2.3"));
    assert_eq!(mod_entry.mod_folder.as_deref(), Some("Test REDmod"));
    assert_eq!(mod_entry.metadata_source, "infoJson");

    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &mod_entry.id, &game).unwrap();
    assert!(fixture
        .game
        .join("mods")
        .join("Test REDmod")
        .join("info.json")
        .is_file());
    assert!(fixture
        .game
        .join("mods")
        .join("Test REDmod")
        .join("archives")
        .join("test.archive")
        .is_file());
}

#[test]
fn game_root_layout_preserves_relative_paths() {
    let fixture = Fixture::new();
    let archive = b"archive";
    let script = b"script";
    let zip = fixture.zip(
        "RootLayout.zip",
        &[
            ("archive/pc/mod/root.archive", archive.as_slice()),
            ("r6/scripts/root.reds", script.as_slice()),
            ("bin/x64/plugins/cyber_engine_tweaks/mods/Test/init.lua", b"lua".as_slice()),
        ],
    );
    let mod_entry = install(&fixture, &zip);
    assert_eq!(mod_entry.layout, InstallLayout::GameRoot);
    assert!(mod_entry.has_cet, "CET files inside a game-root mod must be detected");

    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &mod_entry.id, &game).unwrap();
    assert!(fixture.game.join("archive/pc/mod/root.archive").is_file());
    assert!(fixture.game.join("r6/scripts/root.reds").is_file());
    assert!(fixture
        .game
        .join("bin/x64/plugins/cyber_engine_tweaks/mods/Test/init.lua")
        .is_file());
}

#[test]
fn archive_xl_files_are_deployed_next_to_the_archive() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "ArchiveXLMod.zip",
        &[
            ("ArchiveXLMod/weapons.archive", b"archive".as_slice()),
            ("ArchiveXLMod/weapons.xl", b"<xl/>".as_slice()),
        ],
    );
    let mod_entry = install(&fixture, &zip);
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &mod_entry.id, &game).unwrap();
    assert!(fixture.game.join("archive/pc/mod/weapons.archive").is_file());
    assert!(
        fixture.game.join("archive/pc/mod/weapons.xl").is_file(),
        "ArchiveXL .xl must follow its archive into archive/pc/mod"
    );
}

#[test]
fn conflicting_targets_are_blocked_before_writing() {
    let fixture = Fixture::new();
    let (name_a, bytes_a) = archive_entry("a/shared.archive");
    let (name_b, bytes_b) = archive_entry("b/shared.archive");
    let zip_a = fixture.zip("ModA.zip", &[(name_a.as_str(), bytes_a.as_slice())]);
    let zip_b = fixture.zip("ModB.zip", &[(name_b.as_str(), bytes_b.as_slice())]);
    let mod_a = install(&fixture, &zip_a);
    let mod_b = install(&fixture, &zip_b);
    let game = validate_game_dir(&fixture.game).unwrap();

    deploy_mod(&fixture.store, &mod_a.id, &game).unwrap();
    let error = deploy_mod(&fixture.store, &mod_b.id, &game).unwrap_err();
    assert_eq!(error.code, "DEPLOY_CONFLICT");
    assert_eq!(error.conflicts.len(), 1);
    assert_eq!(error.conflicts[0].target, "archive/pc/mod/shared.archive");
    undeploy_mod(&fixture.store, &mod_a.id, &fixture.game).unwrap();
    deploy_mod(&fixture.store, &mod_b.id, &game).unwrap();
    assert!(fixture.game.join("archive/pc/mod/shared.archive").is_file());
}

#[test]
fn staged_conflict_is_visible_before_enable() {
    let fixture = Fixture::new();
    let zip_a = fixture.zip(
        "StagedA.zip",
        &[("A/shared.archive", b"a".as_slice())],
    );
    let zip_b = fixture.zip(
        "StagedB.zip",
        &[("B/shared.archive", b"b".as_slice())],
    );
    let mod_a = install(&fixture, &zip_a);
    let mod_b = install(&fixture, &zip_b);
    assert_eq!(mod_b.planned_files, vec!["archive/pc/mod/shared.archive"]);
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &mod_a.id, &game).unwrap();

    let state = fixture.store.snapshot_data();
    assert!(all_conflicts(&state.mods).is_empty());
    let pending = staged_conflicts(&state.mods);
    assert_eq!(pending.len(), 1);
    assert!(pending[0].pending);
    assert_eq!(pending[0].mod_id, mod_b.id);
    assert_eq!(pending[0].other_mod_id.as_deref(), Some(mod_a.id.as_str()));
    assert_eq!(pending[0].target, "archive/pc/mod/shared.archive");

    let combined = collect_conflicts(&state.mods);
    assert_eq!(combined.len(), 1);
    assert!(combined[0].pending);

    // A staged conflict must not replace the enabled mod's deployed file.
    assert_eq!(
        std::fs::read_to_string(fixture.game.join("archive/pc/mod/shared.archive")).unwrap(),
        "a"
    );
}

#[test]
fn native_modlist_follows_saved_order_and_refuses_unmanaged_file() {
    let fixture = Fixture::new();
    let zip_a = fixture.zip(
        "Alpha.zip",
        &[("Alpha/alpha.archive", b"alpha".as_slice())],
    );
    let zip_b = fixture.zip(
        "Beta.zip",
        &[("Beta/beta.archive", b"beta".as_slice())],
    );
    let alpha = install(&fixture, &zip_a);
    let beta = install(&fixture, &zip_b);
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &alpha.id, &game).unwrap();
    deploy_mod(&fixture.store, &beta.id, &game).unwrap();

    let mut state = fixture.store.snapshot_data();
    state.load_order = vec![
        "archive/pc/mod/beta.archive".to_string(),
        "archive/pc/mod/alpha.archive".to_string(),
    ];
    let normalized = normalized_order(&state);
    assert_eq!(normalized[0], "archive/pc/mod/beta.archive");
    let view = build_view(&state, Some(&fixture.game));
    assert_eq!(view.archives[0].filename, "beta.archive");

    let modlist = write_modlist(&state, &fixture.game).unwrap().unwrap();
    let content = std::fs::read_to_string(&modlist).unwrap();
    // 游戏直接读这个文件，格式必须与官方一致：纯文件名、CRLF、无尾换行、无注释头。
    assert_eq!(content, "beta.archive\r\nalpha.archive");
    assert!(!content.contains('#'), "{content}");
    // 托管标记落在旁挂文件里，不污染游戏文件。
    assert!(fixture
        .game
        .join("archive/pc/mod/.cyberdeck-modlist")
        .is_file());

    // A user-authored modlist must never be overwritten implicitly.
    std::fs::write(&modlist, "my-custom-list.archive\r\n").unwrap();
    let error = write_modlist(&fixture.store.snapshot_data(), &fixture.game).unwrap_err();
    assert_eq!(error.code, "MODLIST_UNMANAGED");
    assert_eq!(
        std::fs::read_to_string(&modlist).unwrap(),
        "my-custom-list.archive\r\n"
    );
}

#[test]
fn alphabetical_order_removes_modlist_instead_of_pinning_it() {
    let fixture = Fixture::new();
    let zip_a = fixture.zip("Alpha.zip", &[("Alpha/alpha.archive", b"a".as_slice())]);
    let zip_b = fixture.zip("Beta.zip", &[("Beta/beta.archive", b"b".as_slice())]);
    let alpha = install(&fixture, &zip_a);
    let beta = install(&fixture, &zip_b);
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &alpha.id, &game).unwrap();
    deploy_mod(&fixture.store, &beta.id, &game).unwrap();

    // 顺序恰好是游戏默认的升序 → 不该留一份多余的 modlist.txt（官方也是删掉）。
    let state = fixture.store.snapshot_data();
    assert_eq!(write_modlist(&state, &fixture.game).unwrap(), None);
    assert!(!fixture.game.join("archive/pc/mod/modlist.txt").exists());
}

/// 老版本把 `# Managed by ...` 写在 modlist.txt 首行；重新写一次就应迁到旁挂标记。
#[test]
fn legacy_header_modlist_is_migrated_to_plain_names() {
    let fixture = Fixture::new();
    let zip_a = fixture.zip("Alpha.zip", &[("Alpha/alpha.archive", b"a".as_slice())]);
    let zip_b = fixture.zip("Beta.zip", &[("Beta/beta.archive", b"b".as_slice())]);
    let alpha = install(&fixture, &zip_a);
    let beta = install(&fixture, &zip_b);
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &alpha.id, &game).unwrap();
    deploy_mod(&fixture.store, &beta.id, &game).unwrap();

    let dir = fixture.game.join("archive/pc/mod");
    std::fs::write(
        dir.join("modlist.txt"),
        format!("{MANAGED_HEADER}\r\nbeta.archive\r\nalpha.archive\r\n"),
    )
    .unwrap();

    let mut state = fixture.store.snapshot_data();
    state.load_order = vec![
        "archive/pc/mod/beta.archive".to_string(),
        "archive/pc/mod/alpha.archive".to_string(),
    ];

    let written = write_modlist(&state, &fixture.game).unwrap().unwrap();
    let content = std::fs::read_to_string(&written).unwrap();
    assert_eq!(content, "beta.archive\r\nalpha.archive");
    assert!(!content.contains('#'), "老注释头必须被清掉：{content}");
    assert!(dir.join(".cyberdeck-modlist").is_file());
}

#[test]
fn undeploy_refuses_to_delete_a_replaced_target() {
    let fixture = Fixture::new();
    let zip = fixture.zip("Safe.zip", &[("Safe/safe.archive", b"ours".as_slice())]);
    let entry = install(&fixture, &zip);
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &entry.id, &game).unwrap();
    let target = fixture.game.join("archive/pc/mod/safe.archive");
    std::fs::remove_file(&target).unwrap();
    std::fs::write(&target, b"user replaced this").unwrap();

    let warnings = undeploy_mod(&fixture.store, &entry.id, &fixture.game).unwrap();
    assert!(
        warnings.iter().any(|warning| warning.contains("拒绝删除")),
        "{warnings:?}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "user replaced this");
}

#[test]
fn sevenz_archive_is_extracted_and_normalized() {
    let fixture = Fixture::new();
    let archive = fixture.sevenz(
        "SevenZMod.7z",
        &[
            ("SevenZMod/weapons.archive", b"seven zip archive".as_slice()),
            ("SevenZMod/weapons.xl", b"xl".as_slice()),
            ("SevenZMod/readme.txt", b"docs".as_slice()),
        ],
    );
    let entry = install(&fixture, &archive);
    assert_eq!(entry.layout, InstallLayout::Archive);
    assert_eq!(entry.file_count, 2);
    assert!(PathBuf::from(&entry.staging_path)
        .join("weapons.archive")
        .is_file());
    assert!(!PathBuf::from(&entry.staging_path).join("SevenZMod").exists());
}

#[test]
fn rar_archive_is_extracted_when_winrar_is_available() {
    let rar_tool = Path::new(r"C:\Program Files\WinRAR\Rar.exe");
    if !rar_tool.is_file() {
        return;
    }
    let fixture = Fixture::new();
    let source = fixture.root.join("rar-source");
    let payload = source.join("RarMod");
    std::fs::create_dir_all(&payload).unwrap();
    std::fs::write(payload.join("weapons.archive"), b"rar archive").unwrap();
    std::fs::write(payload.join("readme.txt"), b"docs").unwrap();
    let archive = fixture.root.join("RarMod.rar");
    let output = Command::new(rar_tool)
        .args(["a", "-r", "-ep1", "-idq"])
        .arg(&archive)
        .arg(source.join("*"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));

    let entry = install_archive(&fixture.store, archive.to_str().unwrap(), None).unwrap();
    assert_eq!(entry.layout, InstallLayout::Archive);
    assert_eq!(entry.file_count, 1);
    assert!(PathBuf::from(&entry.staging_path)
        .join("weapons.archive")
        .is_file());
}

#[test]
fn nested_wrapper_is_sniffed_to_the_real_game_root() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "NestedWrapper.zip",
        &[
            ("Outer/Inner/archive/pc/mod/deep.archive", b"archive".as_slice()),
            ("Outer/Inner/r6/scripts/deep.reds", b"script".as_slice()),
            ("Outer/readme.txt", b"docs".as_slice()),
        ],
    );
    let mod_entry = install(&fixture, &zip);
    assert_eq!(mod_entry.layout, InstallLayout::GameRoot);
    assert!(
        PathBuf::from(&mod_entry.staging_path).ends_with(Path::new("payload").join("Inner")),
        "{}",
        mod_entry.staging_path
    );
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &mod_entry.id, &game).unwrap();
    assert!(fixture.game.join("archive/pc/mod/deep.archive").is_file());
    assert!(fixture.game.join("r6/scripts/deep.reds").is_file());
}

#[test]
fn multiple_wrapped_mod_roots_are_rejected_instead_of_dropping_files() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "MultiModPack.zip",
        &[
            ("Pack/ModA/archive/a.archive", b"a".as_slice()),
            ("Pack/ModB/archive/b.archive", b"b".as_slice()),
        ],
    );
    let error = install_zip(&fixture.store, zip.to_str().unwrap()).unwrap_err();
    assert_eq!(error.code, "LAYOUT_AMBIGUOUS");
    assert!(error.message.contains("ModA"));
    assert!(error.message.contains("ModB"));
}

#[test]
fn root_and_nested_mod_roots_are_both_reported_as_ambiguous() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "RootAndNested.zip",
        &[
            ("archive/pc/mod/top.archive", b"top".as_slice()),
            ("Extra/archive/pc/mod/extra.archive", b"extra".as_slice()),
        ],
    );
    let error = install_zip(&fixture.store, zip.to_str().unwrap()).unwrap_err();
    assert_eq!(error.code, "LAYOUT_AMBIGUOUS");
    assert!(error.message.contains("Extra"), "{}", error.message);
}

#[test]
fn zip_slip_is_rejected() {
    let fixture = Fixture::new();
    let zip = fixture.zip("Evil.zip", &[("../evil.archive", b"nope".as_slice())]);
    let error = install_zip(&fixture.store, zip.to_str().unwrap()).unwrap_err();
    assert_eq!(error.code, "ZIP_UNSAFE_ENTRY");
    assert!(!fixture.root.join("evil.archive").exists());
}

#[test]
fn unknown_layout_is_rejected_with_actionable_error() {
    let fixture = Fixture::new();
    let zip = fixture.zip("Unknown.zip", &[("random.bin", b"data".as_slice())]);
    let error = install_zip(&fixture.store, zip.to_str().unwrap()).unwrap_err();
    assert_eq!(error.code, "LAYOUT_UNKNOWN");
    assert!(error.message.contains("archive/"));
}

/// 禁用时删不掉的文件必须留在部署清单里。
///
/// `deployed_files` 是「游戏目录里还有哪些文件属于它」的唯一凭据：旧实现不管
/// 成败一律 `clear()`，被游戏占用（游戏还在跑）的那几个文件从此无人认领，用户
/// 只能自己去 `archive/pc/mod` 里翻——正是这次要修的数据丢失点。
///
/// 用 Windows 的「独占打开」（share_mode 0）模拟文件被占用：只读属性不行，
/// `remove_link_or_copy` 会先主动清掉只读位再删。
#[cfg(windows)]
#[test]
fn undeploy_keeps_manifest_for_files_it_could_not_remove() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixture = Fixture::new();
    let zip = fixture.zip(
        "Locked.zip",
        &[
            ("Locked/keep.archive", b"keep".as_slice()),
            ("Locked/stuck.archive", b"stuck".as_slice()),
        ],
    );
    let mod_entry = install(&fixture, &zip);
    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &mod_entry.id, &game).unwrap();

    let stuck = fixture.game.join("archive/pc/mod/stuck.archive");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&stuck)
        .unwrap();

    let warnings = undeploy_mod(&fixture.store, &mod_entry.id, &fixture.game).unwrap();
    assert!(
        !warnings.is_empty(),
        "删不掉的文件必须提示用户，而不是静默吞掉"
    );
    assert!(
        !fixture.game.join("archive/pc/mod/keep.archive").exists(),
        "能删的仍然要删掉"
    );

    let state = fixture.store.snapshot_data();
    assert!(!state.mods[0].enabled);
    let remaining: Vec<&str> = state.mods[0]
        .deployed_files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect();
    assert_eq!(
        remaining,
        vec!["archive/pc/mod/stuck.archive"],
        "删不掉的文件必须留在清单里，否则永远没人认领"
    );

    // 解除占用后重新启用：部署前应先自动清掉残留，而不是撞上自己的旧文件报「被占用」。
    drop(lock);
    let report = deploy_mod(&fixture.store, &mod_entry.id, &game).unwrap();
    assert_eq!(report.deployed, 2);
    assert!(stuck.is_file());
    assert_eq!(fixture.store.snapshot_data().mods[0].deployed_files.len(), 2);
}


// ---- ASI / RED4ext 原生插件：布局判定与落位（对齐 Vortex 对应安装器） ----

fn sorted_plan(entry: &ModEntry) -> Vec<String> {
    let mut plan = entry.planned_files.clone();
    plan.sort();
    plan
}

#[test]
fn bare_asi_plugin_lands_in_bin_x64_plugins() {
    let fixture = Fixture::new();
    // ASI 包基本都多套一层壳目录：`MyAsi/xxx.asi`，壳不能带到游戏里。
    let zip = fixture.zip(
        "BareAsi.zip",
        &[("MyAsi/TeleportEverywhere.asi", b"asi".as_slice())],
    );
    let entry = install(&fixture, &zip);
    assert_eq!(entry.layout, InstallLayout::Asi);
    assert_eq!(
        sorted_plan(&entry),
        vec!["bin/x64/plugins/TeleportEverywhere.asi"]
    );

    let game = validate_game_dir(&fixture.game).unwrap();
    deploy_mod(&fixture.store, &entry.id, &game).unwrap();
    assert!(fixture
        .game
        .join("bin/x64/plugins/TeleportEverywhere.asi")
        .is_file());
}

#[test]
fn asi_loader_proxy_dll_lands_beside_the_executable() {
    let fixture = Fixture::new();
    let zip = fixture.zip("AsiLoader.zip", &[("dinput8.dll", b"dll".as_slice())]);
    let entry = install(&fixture, &zip);
    assert_eq!(entry.layout, InstallLayout::Asi);
    // 加载器 dll 必须和 exe 同目录，进 plugins/ 就永远不会被 Windows 加载。
    assert_eq!(sorted_plan(&entry), vec!["bin/x64/dinput8.dll"]);
}

#[test]
fn asi_loader_with_plugins_folder_does_not_double_the_plugins_layer() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "AsiBundle.zip",
        &[
            ("dinput8.dll", b"dll".as_slice()),
            ("plugins/Extra.asi", b"asi".as_slice()),
        ],
    );
    let entry = install(&fixture, &zip);
    assert_eq!(entry.layout, InstallLayout::Asi);
    assert_eq!(
        sorted_plan(&entry),
        vec!["bin/x64/dinput8.dll", "bin/x64/plugins/Extra.asi"]
    );
}

#[test]
fn red4ext_plugin_with_toplevel_dll_is_nested_under_its_own_folder() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "NakedPlugin.zip",
        &[
            ("NakedPlugin.dll", b"dll".as_slice()),
            ("NakedPlugin/config.json", b"{}".as_slice()),
        ],
    );
    let entry = install(&fixture, &zip);
    assert_eq!(entry.layout, InstallLayout::Red4ext);
    let folder = entry.mod_folder.clone().expect("RED4ext 必须留一层自己的目录名");
    assert_eq!(
        sorted_plan(&entry),
        vec![
            format!("red4ext/plugins/{folder}/NakedPlugin.dll"),
            format!("red4ext/plugins/{folder}/NakedPlugin/config.json"),
        ]
    );
}

#[test]
fn red4ext_plugin_in_a_single_folder_is_unwrapped() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "WrappedPlugin.zip",
        &[("PluginSrc/CyberarmsCore.dll", b"dll".as_slice())],
    );
    let entry = install(&fixture, &zip);
    assert_eq!(entry.layout, InstallLayout::Red4ext);
    let folder = entry.mod_folder.clone().unwrap();
    // 壳目录 `PluginSrc` 要剥掉，但自己的 `<folder>` 那层要留着防同名覆盖。
    assert_eq!(
        sorted_plan(&entry),
        vec![format!("red4ext/plugins/{folder}/CyberarmsCore.dll")]
    );
}

#[test]
fn tweakxl_and_audioware_packages_keep_their_game_root_paths() {
    let fixture = Fixture::new();
    // 这两种类型在 Vortex 里是「同源同目标」，本启动器的「完整游戏目录结构」
    // 分支本来就是同样落位——这条测试把它钉住，避免以后改 GameRoot 时悄悄改坏。
    let zip = fixture.zip(
        "TweakAndAudio.zip",
        &[
            ("r6/tweaks/BetterLoot.yaml", b"yaml".as_slice()),
            ("r6/audioware/impact.audioware", b"audio".as_slice()),
        ],
    );
    let entry = install(&fixture, &zip);
    assert_eq!(entry.layout, InstallLayout::GameRoot);
    assert_eq!(
        sorted_plan(&entry),
        vec!["r6/audioware/impact.audioware", "r6/tweaks/BetterLoot.yaml"]
    );
}

#[test]
fn archive_and_archivexl_pair_both_go_to_archive_pc_mod() {
    let fixture = Fixture::new();
    let zip = fixture.zip(
        "ArchiveXlPair.zip",
        &[
            ("MyMod/MyMod.archive", b"archive".as_slice()),
            ("MyMod/MyMod.xl", b"xl".as_slice()),
        ],
    );
    let entry = install(&fixture, &zip);
    assert_eq!(entry.layout, InstallLayout::Archive);
    assert_eq!(
        sorted_plan(&entry),
        vec!["archive/pc/mod/MyMod.archive", "archive/pc/mod/MyMod.xl"]
    );
}
