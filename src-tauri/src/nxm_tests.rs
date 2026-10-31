//! `nxm://` 解析与处理器判定的单测。
//!
//! 只测纯函数：解析、参数提取、命令行比对。注册表读写不进单测——
//! 单测碰 `HKCU\Software\Classes\nxm` 会改掉开发机上真实的协议绑定。
use crate::nxm;

#[test]
fn parses_mod_link_without_file() {
    let link = nxm::parse_link("nxm://cyberpunk2077/mods/107?key=abc&expires=1700000000").unwrap();
    assert_eq!(link.domain, "cyberpunk2077");
    assert_eq!(link.mod_id, 107);
    assert_eq!(link.file_id, None);
    assert_eq!(link.key.as_deref(), Some("abc"));
    assert_eq!(link.expires.as_deref(), Some("1700000000"));
}

#[test]
fn parses_file_link_and_decodes_key() {
    let link =
        nxm::parse_link("nxm://cyberpunk2077/mods/9001/files/4567?key=a%3Db%26c&user_id=42").unwrap();
    assert_eq!(link.mod_id, 9001);
    assert_eq!(link.file_id, Some(4567));
    assert_eq!(link.key.as_deref(), Some("a=b&c"));
    assert_eq!(link.user_id.as_deref(), Some("42"));
}

#[test]
fn tolerates_case_and_scheme_without_slashes() {
    let upper = nxm::parse_link("NXM://Cyberpunk2077/Mods/107").unwrap();
    assert_eq!(upper.mod_id, 107);
    assert_eq!(upper.domain, "cyberpunk2077");

    let bare = nxm::parse_link("nxm:cyberpunk2077/mods/107/files/2").unwrap();
    assert_eq!(bare.mod_id, 107);
    assert_eq!(bare.file_id, Some(2));
}

#[test]
fn rejects_other_games_with_clear_code() {
    let err = nxm::parse_link("nxm://skyrimspecialedition/mods/1").unwrap_err();
    assert_eq!(err.code, "NXM_UNSUPPORTED_GAME");
    assert!(err.message.contains("skyrimspecialedition"));
}

#[test]
fn rejects_non_nxm_and_missing_mod_id() {
    assert_eq!(
        nxm::parse_link("https://www.nexusmods.com/cyberpunk2077/mods/1").unwrap_err().code,
        "NXM_INVALID_LINK"
    );
    assert_eq!(
        nxm::parse_link("nxm://cyberpunk2077/mods").unwrap_err().code,
        "NXM_INVALID_LINK"
    );
    assert_eq!(
        nxm::parse_link("nxm://cyberpunk2077/mods/0").unwrap_err().code,
        "NXM_INVALID_LINK"
    );
}

#[test]
fn picks_links_out_of_command_line() {
    let args = vec![
        "C:\\Games\\CyberDeck Launcher.exe".to_string(),
        "--flag".to_string(),
        "\"nxm://cyberpunk2077/mods/12/files/34?key=x\"".to_string(),
        "nxm://skyrimspecialedition/mods/9".to_string(),
    ];
    let links = nxm::links_from_args(&args);
    // 别的游戏的链接解析失败，不应出现在结果里，也不能让整批丢弃。
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].mod_id, 12);
    assert_eq!(links[0].file_id, Some(34));
}

#[test]
fn recognises_own_handler_command() {
    let ours = nxm::handler_command().unwrap();
    assert!(nxm::is_ours(&ours));
    // 带引号与否、%1 位置、斜杠方向都不应影响判定。
    let loose = format!("{} %1", ours.replace("\"%1\"", "").replace('"', "").trim());
    assert!(nxm::is_ours(&loose));
    assert!(!nxm::is_ours("C:\\Program Files\\Vortex\\vortex.exe nxm://"));
    assert!(!nxm::is_ours(""));
}

// ── 注册表真实读写（沙箱键） ────────────────────────────────────
//
// 这些用例会真的写 HKCU，但**只用一次性键**（nxm-test-<uuid>），
// 不会碰用户真实绑定的 `Software\Classes\nxm`；跑完即删。
// 之所以不 mock：接管/交还出问题往往就是注册表路径或写入顺序写错，
// 用假实现测等于什么都没测。

fn sandbox_root() -> String {
    format!(
        "Software\\Classes\\nxm-test-{}",
        uuid::Uuid::new_v4().simple()
    )
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cdl-nxm-{tag}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn takeover_backs_up_previous_handler_and_release_restores_it() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    // 用 raw string：这条命令里既有反斜杠又有引号，普通字符串容易写错。
    const VORTEX: &str = r#"C:\Program Files\Vortex\vortex.exe "%1%""#;
    let root = sandbox_root();
    let dir = temp_dir("takeover");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (seed, _) = hkcu
        .create_subkey(format!("{root}\\shell\\open\\command"))
        .unwrap();
    seed.set_value("", &VORTEX.to_string()).unwrap();

    // 被 Vortex 占着 → 接管 → 归属变成 us，且备份了原命令。
    assert_eq!(nxm::status_at(&root, &dir).owner, "other");
    let taken = nxm::takeover_at(&root, &dir).unwrap();
    assert!(taken.registered);
    assert!(taken.ours);
    assert_eq!(taken.owner, "us");
    assert_eq!(taken.backup.as_deref(), Some(VORTEX));

    // 交还 → 精确写回 Vortex，备份文件被清掉。
    let released = nxm::release_at(&root, &dir).unwrap();
    assert!(!released.ours);
    // 协议本身仍然可用（Vortex 的命令又写回去了），只是不再归我们。
    assert!(released.registered);
    assert_eq!(released.owner, "other");
    assert_eq!(released.handler.as_deref(), Some(VORTEX));
    assert!(released.backup.is_none());

    hkcu.delete_subkey_all(&root).ok();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn takeover_without_previous_handler_release_removes_the_key() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let root = sandbox_root();
    let dir = temp_dir("clean");
    assert_eq!(nxm::status_at(&root, &dir).owner, "none");

    let taken = nxm::takeover_at(&root, &dir).unwrap();
    assert_eq!(taken.owner, "us");
    assert!(taken.backup.is_none(), "没有原处理器就不该编一份备份");

    let released = nxm::release_at(&root, &dir).unwrap();
    assert_eq!(released.owner, "none");
    assert!(!released.registered);
    assert!(
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(&root).is_err(),
        "没有备份时必须把自己建的整棵子树删干净"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn overwriting_backup_archives_previous_handler() {
    // 自检 P2-5：Vortex → 别的工具 → 本启动器 的链条下，单级覆盖会丢掉最早那个 handler。
    // 这里断言「主备份仍是最新一家（release 语义不变）+ 上一家被归档成证据文件」。
    let dir = temp_dir("archive");
    nxm::write_backup(&dir, r#"C:/Tools/a.exe "%1%""#).unwrap();
    nxm::write_backup(&dir, r#"C:/Tools/b.exe "%1%""#).unwrap();

    let archived: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|item| item.ok())
        .map(|item| item.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("nxm-handler.prev-"))
        .collect();
    assert_eq!(archived.len(), 1, "{archived:?}");
    let text = std::fs::read_to_string(dir.join(&archived[0])).unwrap();
    // JSON 里反斜杠会被转义，只断言可执行文件名。
    assert!(text.contains("a.exe"), "{text}");

    let current = std::fs::read_to_string(dir.join("nxm-handler.json")).unwrap();
    assert!(current.contains("b.exe"), "{current}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn same_handler_is_not_archived_twice() {
    let dir = temp_dir("archive-idempotent");
    nxm::write_backup(&dir, r#"C:/Tools/a.exe "%1%""#).unwrap();
    // 同一家反复接管（每次 release 后又 takeover）不该堆归档文件。
    nxm::write_backup(&dir, r#"C:/Tools/a.exe "%1%""#).unwrap();

    let archived = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|item| item.ok())
        .filter(|item| item.file_name().to_string_lossy().starts_with("nxm-handler.prev-"))
        .count();
    assert_eq!(archived, 0);

    std::fs::remove_dir_all(&dir).ok();
}
