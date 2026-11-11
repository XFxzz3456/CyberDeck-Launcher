#![cfg(test)]

//! 整合包导出 / 导入的用例。夹具风格与 adopt_tests 一致：真实文件系统 + 内存 Store，
//! 全部落在 `.test-tmp` 下，跑完不清理（与既有用例保持同一习惯，便于失败时翻现场）。

use crate::pack::{self, PackKind};
use crate::schema::{DeployedFile, InstallLayout, LinkType, ModEntry, NexusRef};
use crate::store::{now_iso, Store};
use std::fs;
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    store: Store,
}

impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("pack-{}", uuid::Uuid::new_v4().simple()));
        let data = root.join("data");
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        let store = Store::load(data).unwrap();
        {
            let mut state = store.data.lock().unwrap();
            state.staging_dir = staging.to_string_lossy().to_string();
            store.save(&state).unwrap();
        }
        Self { root, store }
    }

    /// 造一个带暂存目录的条目。`mod_id` 为 0 表示没有 Nexus 编号。
    fn entry(&self, id: &str, name: &str, mod_id: u64, version: &str, enabled: bool) -> ModEntry {
        let staging = self.root.join("staging").join(id);
        fs::create_dir_all(staging.join("archive").join("pc").join("mod")).unwrap();
        fs::write(
            staging
                .join("archive")
                .join("pc")
                .join("mod")
                .join(format!("{name}.archive")),
            b"body",
        )
        .unwrap();
        let mut entry = ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: name.to_string(),
            version: Some(version.to_string()),
            author: None,
            category: "其他".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: (mod_id > 0).then(|| NexusRef {
                mod_id,
                file_id: Some(900 + mod_id),
                url: format!("https://www.nexusmods.com/cyberpunk2077/mods/{mod_id}"),
                version: Some(version.to_string()),
                picture_url: None,
                latest_version: None,
                last_check: None,
            }),
            staging_path: staging.to_string_lossy().to_string(),
            cover_path: None,
            cover_cache_path: None,
            enabled,
            installed_at: now_iso(),
            updated_at: None,
            size_bytes: 4,
            file_count: 1,
            layout: InstallLayout::Archive,
            mod_folder: None,
            metadata_source: if mod_id > 0 { "filename" } else { "adopted" }.to_string(),
            planned_files: vec![format!("archive/pc/mod/{name}.archive")],
            warnings: Vec::new(),
            deployed_files: vec![DeployedFile {
                source: String::new(),
                target: String::new(),
                link_type: LinkType::HardLink,
                relative_path: format!("archive/pc/mod/{name}.archive"),
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
            origin: "cyberdeck".to_string(),
            modpack_id: None,
            nexus_cover_url: None,
            is_translation: false,
            parent_mod_id: None,
            ai_loc: None,
            ai_fix: Vec::new(),
        };
        entry.file_count = entry.deployed_files.len();
        entry
    }

    fn push(&self, entry: ModEntry) {
        let mut state = self.store.data.lock().unwrap();
        state.mods.push(entry);
        self.store.save(&state).unwrap();
    }

    fn out(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

/// 同一 Nexus 编号装了多个版本：清单里只能出现一条，且优先取启用的那个。
#[test]
fn manifest_dedupes_multiversion_by_nexus_id() {
    let fixture = Fixture::new();
    fixture.push(fixture.entry("old", "Lizzie 2.03", 1234, "2.03", false));
    fixture.push(fixture.entry("new", "Lizzie 3.22", 1234, "3.22", true));

    let manifest = pack::build_manifest(
        &fixture.store,
        PackKind::List,
        "测试包",
        "作者",
        "1.8.0",
        true,
    )
    .unwrap();

    assert_eq!(manifest.mods.len(), 1, "同编号多版本要合成一条");
    assert_eq!(manifest.mods[0].version.as_deref(), Some("3.22"), "取启用中的版本");
    assert!(manifest.mods[0].enabled);
    assert_eq!(manifest.mods[0].key, "nxm:1234");
}

/// 轻量清单往返：导出 → 读回 → 预览能认出「已装」，删掉条目后变「缺失」。
#[test]
fn list_export_roundtrip_and_preview() {
    let fixture = Fixture::new();
    fixture.push(fixture.entry("a", "Alpha", 501, "1.0", true));
    fixture.push(fixture.entry("b", "Beta", 502, "2.0", false));

    let manifest = pack::build_manifest(
        &fixture.store,
        PackKind::List,
        "往返包",
        "作者",
        "1.8.0",
        true,
    )
    .unwrap();
    let out = fixture.out("roundtrip.cdlist");
    let report = pack::export_list(&fixture.store, manifest, Some(&out)).unwrap();
    assert!(report.size_bytes > 0);
    assert_eq!(report.mods, 2);

    let text = fs::read_to_string(&out).unwrap();
    assert!(text.contains("cyberdeck-pack"), "清单要带 kind 标识");

    let preview = pack::preview(&fixture.store, &out).unwrap();
    assert_eq!(preview.total, 2);
    assert_eq!(preview.installed, 2, "{preview:?}");
    assert_eq!(preview.missing, 0);

    // 删掉一条 → 预览必须报缺失。
    {
        let mut state = fixture.store.data.lock().unwrap();
        state.mods.retain(|entry| entry.id != "a");
        fixture.store.save(&state).unwrap();
    }
    let preview = pack::preview(&fixture.store, &out).unwrap();
    assert_eq!(preview.missing, 1);
    assert_eq!(preview.installed, 1);
}

/// 版本不同要报 version_mismatch，而不是当成已装。
#[test]
fn preview_flags_version_mismatch() {
    let fixture = Fixture::new();
    fixture.push(fixture.entry("a", "Alpha", 601, "1.0", true));
    let mut manifest = pack::build_manifest(
        &fixture.store,
        PackKind::List,
        "版本包",
        "",
        "1.8.0",
        true,
    )
    .unwrap();
    manifest.mods[0].version = Some("9.9".to_string());
    let out = fixture.out("mismatch.cdlist");
    pack::export_list(&fixture.store, manifest, Some(&out)).unwrap();

    let preview = pack::preview(&fixture.store, &out).unwrap();
    assert_eq!(preview.version_mismatch, 1, "{preview:?}");
    assert_eq!(preview.installed, 0);
}

/// 没有 Nexus 编号的条目要单列进 unresolved，不能悄悄消失。
#[test]
fn local_only_entries_are_reported() {
    let fixture = Fixture::new();
    fixture.push(fixture.entry("nx", "Nexus Mod", 701, "1.0", true));
    fixture.push(fixture.entry("local", "私人补丁", 0, "0.1", true));

    let manifest = pack::build_manifest(
        &fixture.store,
        PackKind::List,
        "混合包",
        "",
        "1.8.0",
        true,
    )
    .unwrap();
    assert_eq!(manifest.mods.len(), 2);
    assert_eq!(manifest.unresolved.len(), 1);
    assert_eq!(manifest.unresolved[0].name, "私人补丁");
    assert!(manifest.unresolved[0].key.starts_with("local:"));

    // 轻量包不内嵌文件，unresolved 也就没有 inner。
    assert!(manifest.unresolved[0].inner.is_none());
    let out = fixture.out("mixed.cdlist");
    pack::export_list(&fixture.store, manifest, Some(&out)).unwrap();
    let preview = pack::preview(&fixture.store, &out).unwrap();
    assert_eq!(preview.local_only, 0, "本地条目在库里装着，算已装");
}

/// 完整包：内嵌 zip 能被打出来，删掉库里条目后能靠它装回来。
#[test]
fn full_pack_installs_missing_bodies() {
    let fixture = Fixture::new();
    fixture.push(fixture.entry("a", "Solo", 801, "1.0", true));

    let manifest = pack::build_manifest(
        &fixture.store,
        PackKind::Full,
        "完整包",
        "",
        "1.8.0",
        true,
    )
    .unwrap();
    assert!(manifest.mods[0].inner.is_some(), "完整包必须带内嵌文件名");
    let out = fixture.out("full.cdpack");
    let mut tick = |_: usize, _: usize, _: &str| {};
    let report = pack::export_full(&fixture.store, manifest, Some(&out), &mut tick).unwrap();
    assert!(report.size_bytes > 0);

    // 读清单：从 zip 里取 pack.json。
    let reopened = pack::read_manifest(&out).unwrap();
    assert_eq!(reopened.mode, "full");
    assert_eq!(reopened.mods.len(), 1);

    // 模拟「对方机器上还没有这个 Mod」。
    {
        let mut state = fixture.store.data.lock().unwrap();
        state.mods.clear();
        fixture.store.save(&state).unwrap();
    }
    let preview = pack::preview(&fixture.store, &out).unwrap();
    assert_eq!(preview.missing, 1, "{preview:?}");

    let mut tick = |_: usize, _: usize, _: &str| {};
    let installed = pack::install_missing(&fixture.store, &out, None, &mut tick).unwrap();
    assert_eq!(installed.installed, 1, "{installed:?}");
    assert_eq!(installed.failed, 0);

    let state = fixture.store.snapshot_data();
    eprintln!("installed={installed:?} mods={}", state.mods.len());
    for item in &state.mods {
        eprintln!("  entry {} {} {:?}", item.id, item.name, item.nexus);
    }
    assert_eq!(state.mods.len(), 1);
    assert_eq!(state.mods[0].nexus.as_ref().map(|n| n.mod_id), Some(801));
}

/// 应用清单：按清单顺序重排加载顺序，未列出的 archive 保留在末尾。
#[test]
fn apply_rewrites_load_order() {
    let fixture = Fixture::new();
    fixture.push(fixture.entry("a", "Alpha", 901, "1.0", true));
    fixture.push(fixture.entry("b", "Beta", 902, "1.0", true));
    fixture.push(fixture.entry("c", "Gamma", 903, "1.0", true));

    let mut manifest = pack::build_manifest(
        &fixture.store,
        PackKind::List,
        "顺序包",
        "",
        "1.8.0",
        true,
    )
    .unwrap();
    // 刻意把顺序倒过来写。
    manifest.order = vec![
        "nxm:903".to_string(),
        "nxm:901".to_string(),
        "nxm:902".to_string(),
    ];
    let out = fixture.out("order.cdlist");
    pack::export_list(&fixture.store, manifest, Some(&out)).unwrap();

    // 库里原本是正序 + 一条不属于任何 Mod 的残留。
    {
        let mut state = fixture.store.data.lock().unwrap();
        state.load_order = vec![
            "archive/pc/mod/Alpha.archive".to_string(),
            "archive/pc/mod/Beta.archive".to_string(),
            "archive/pc/mod/Gamma.archive".to_string(),
            "archive/pc/mod/Stray.archive".to_string(),
        ];
        fixture.store.save(&state).unwrap();
    }

    let report = pack::apply(&fixture.store, &out).unwrap();
    assert_eq!(report.missing, 0, "{report:?}");
    let state = fixture.store.snapshot_data();
    assert_eq!(
        state.load_order,
        vec![
            "archive/pc/mod/Gamma.archive".to_string(),
            "archive/pc/mod/Alpha.archive".to_string(),
            "archive/pc/mod/Beta.archive".to_string(),
            "archive/pc/mod/Stray.archive".to_string(),
        ]
    );
}

/// 回填：只补空的 nexus 字段，已有编号的条目不覆盖（玩家手改优先）。
#[test]
fn backfill_apply_skips_entries_that_already_have_ids() {
    let fixture = Fixture::new();
    fixture.push(fixture.entry("a", "Alpha", 0, "1.0", true));
    fixture.push(fixture.entry("b", "Beta", 777, "1.0", true));

    let proposals = vec![
        crate::backfill::BackfillProposal {
            entry_id: "a".to_string(),
            entry_name: "Alpha".to_string(),
            mod_id: 1111,
            file_id: Some(2222),
            matched_name: "Alpha".to_string(),
            matched_version: Some("1.0".to_string()),
            source: "vortex".to_string(),
            confidence: "exact".to_string(),
        },
        crate::backfill::BackfillProposal {
            entry_id: "b".to_string(),
            entry_name: "Beta".to_string(),
            mod_id: 3333,
            file_id: None,
            matched_name: "Beta".to_string(),
            matched_version: None,
            source: "vortex".to_string(),
            confidence: "exact".to_string(),
        },
    ];
    let written = crate::backfill::apply(&fixture.store, &proposals).unwrap();
    assert_eq!(written, 1);

    let state = fixture.store.snapshot_data();
    let alpha = state.mods.iter().find(|e| e.id == "a").unwrap();
    assert_eq!(alpha.nexus.as_ref().map(|n| n.mod_id), Some(1111));
    assert_eq!(alpha.nexus.as_ref().and_then(|n| n.file_id), Some(2222));
    assert!(alpha.nexus.as_ref().unwrap().url.contains("/1111"));
    let beta = state.mods.iter().find(|e| e.id == "b").unwrap();
    assert_eq!(beta.nexus.as_ref().map(|n| n.mod_id), Some(777), "不覆盖既有编号");
}
