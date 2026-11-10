#![cfg(test)]

//! AI 汉化（T5）/ AI 补丁（T6）的确定性用例。
//!
//! 只测纯函数：联网与打包依赖外部服务，不能进测试基线。
//! 这些断言覆盖真正会「悄悄做错事」的地方——作者意愿判定、本地化 JSON 识别、
//! 覆盖层 YAML 生成，以及补丁结构校验。

use crate::aifix::validate_structure;
use crate::ailoc::{author_policy, build_archive_xl, entries_from_json, scan_entries};
use crate::schema::ModEntry;
use std::fs;
use std::path::PathBuf;

fn temp_dir(tag: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(".test-tmp")
        .join(format!("ai-tools-{tag}-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn entry(name: &str, description: &str) -> ModEntry {
    ModEntry {
        id: "adopt-0000000000000001".to_string(),
        raw_name: None,
        name: name.to_string(),
        version: None,
        author: None,
        category: "其他".to_string(),
        category_locked: false,
        description: description.to_string(),
        source_zip: None,
        nexus: None,
        staging_path: String::new(),
        cover_path: None,
        cover_cache_path: None,
        enabled: false,
        installed_at: "2026-10-31T00:00:00Z".to_string(),
        updated_at: None,
        size_bytes: 0,
        file_count: 0,
        layout: crate::schema::InstallLayout::Archive,
        mod_folder: None,
        metadata_source: "adopted".to_string(),
        planned_files: Vec::new(),
        warnings: Vec::new(),
        deployed_files: Vec::new(),
        has_archive: true,
        has_redmod: false,
        has_cet: false,
        translated_name: None,
        translated_at: None,
        translated_by: None,
        managed: false,
        origin: "adopted".to_string(),
        modpack_id: None,
        nexus_cover_url: None,
        is_translation: false,
        parent_mod_id: None,
        ai_loc: None,
        ai_fix: Vec::new(),
    }
}

/// 作者明确写「禁止汉化」时，必须是 denied —— 这是唯一硬阻断的分支。
#[test]
fn policy_detects_explicit_denial() {
    let root = temp_dir("policy-deny");
    fs::write(root.join("readme.txt"), "禁止汉化，谢谢配合。").unwrap();
    let (policy, evidence) = author_policy(&entry("Some Mod", ""), &root);
    assert_eq!(policy, "denied");
    assert!(evidence.iter().any(|item| item.contains("禁止汉化")));
    let _ = fs::remove_dir_all(root);
}

/// "translation is allowed" 不能被当成拒绝：许可词在附近时降级为 uncertain。
#[test]
fn policy_downgrades_when_permission_nearby() {
    let root = temp_dir("policy-uncertain");
    fs::write(
        root.join("readme.md"),
        "Do not translate without asking, but translation is allowed with permission.",
    )
    .unwrap();
    let (policy, _) = author_policy(&entry("Mod", ""), &root);
    assert_eq!(policy, "uncertain");
    let _ = fs::remove_dir_all(root);
}

/// 没有任何声明时默认 allowed，不能因为描述里有 "translation" 就误伤。
#[test]
fn policy_defaults_to_allowed() {
    let root = temp_dir("policy-allow");
    let (policy, evidence) = author_policy(&entry("Mod", "Includes localization support."), &root);
    assert_eq!(policy, "allowed");
    assert!(evidence.is_empty());
    let _ = fs::remove_dir_all(root);
}

/// onscreens 条目格式（WolvenKit JSON 形状）必须能被识别。
#[test]
fn entries_parsed_from_onscreens_json() {
    let raw = r#"{
      "Header": {"DataType": "CR2W"},
      "Data": {"RootChunk": {"root": {"Data": {"entries": [
        {"secondaryKey": "Mod-Item-Name", "femaleVariant": "Prototype Deck"},
        {"secondaryKey": "Mod-Item-Desc", "femaleVariant": "", "maleVariant": "Buffer overflow"}
      ]}}}}
    }"#;
    let (entries, recognised) = entries_from_json("localization/en-us.json", raw);
    assert!(recognised);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0, "Mod-Item-Name");
    assert_eq!(entries[1].1, "Buffer overflow");
}

/// 扫描时已中文的条目进 blocked，不进待翻译列表——避免反复花钱翻同一条。
#[test]
fn scan_skips_already_chinese() {
    let root = temp_dir("scan");
    fs::create_dir_all(root.join("localization")).unwrap();
    fs::write(
        root.join("localization").join("en-us.json"),
        r#"{"entries": [
            {"secondaryKey": "A", "femaleVariant": "Hello"},
            {"secondaryKey": "B", "femaleVariant": "你好"}
        ]}"#,
    )
    .unwrap();
    let (entries, blocked) = scan_entries(&root);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].secondary_key, "A");
    assert_eq!(blocked.len(), 1);
    assert_eq!(blocked[0].reason, "ALREADY_CHINESE");
    let _ = fs::remove_dir_all(root);
}

/// 覆盖层 YAML 必须用反斜杠路径，且 extend 只在有原 .xl 时出现。
#[test]
fn archive_xl_uses_backslash_paths() {
    let with_extend = build_archive_xl("adopt-1", Some("Origin.archive.xl"));
    assert!(with_extend.contains("  extend: Origin.archive.xl"));
    assert!(with_extend.contains("zh-cn: localization\\zh-cn\\adopt-1-ai-loc.json"));
    let without = build_archive_xl("adopt-1", None);
    assert!(!without.contains("extend:"));
}

/// 补丁结构校验：没注解 / 危险 API / 括号不配平都要拒绝。
#[test]
fn patch_structure_rejects_unsafe_code() {
    let ok = "module CyberDeck.AiFix.X\n\n@wrapMethod(Foo)\nfunc Bar() -> String {\n  return wrappedMethod();\n}\n";
    let (passed, issues) = validate_structure(ok);
    assert!(passed, "{issues:?}");

    let (passed, _) = validate_structure("func NoModule() -> Void {}");
    assert!(!passed);

    let (passed, issues) = validate_structure(
        "module CyberDeck.AiFix.X\n@wrapMethod(Foo)\nfunc Bar() -> String {\n  FileSystem.WriteText(\"x\");\n  return \"\";\n}",
    );
    assert!(!passed);
    assert!(issues.iter().any(|item| item.contains("FileSystem")));

    let (passed, _) = validate_structure(
        "module CyberDeck.AiFix.X\n@wrapMethod(Foo)\nfunc Bar() -> String {\n  return \"\";",
    );
    assert!(!passed);
}

/// 字符串里的花括号不能影响配平判断。
#[test]
fn patch_structure_ignores_braces_in_strings() {
    let code = "module CyberDeck.AiFix.X\n\n@replaceMethod(Foo)\nfunc Bar() -> String {\n  return \"}{ not code\";\n}\n";
    let (passed, issues) = validate_structure(code);
    assert!(passed, "{issues:?}");
}
