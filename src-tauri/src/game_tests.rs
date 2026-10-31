#![cfg(test)]

//! 启动链路的单元测试（计划【2】绕过官方启动器直启）。
//!
//! 只测纯函数与目录侦探：不 spawn 游戏、不要求 Steam 在运行，
//! 这样任何机器上结果都一致。

use crate::game::{
    fallback_routes, inspect_launch, plan_launch, platform_of, Platform, LaunchPlan, LaunchRoute,
};
use crate::schema::GameInfo;
use std::path::PathBuf;

fn temp_root(tag: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(".test-tmp")
        .join(format!("launch-{tag}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(root.join("bin").join("x64")).unwrap();
    root
}

fn fake_game(root: &PathBuf, source: &str) -> GameInfo {
    let exe = root.join("bin").join("x64").join("Cyberpunk2077.exe");
    std::fs::write(&exe, b"MZ fake").unwrap();
    GameInfo {
        root: root.to_string_lossy().to_string(),
        exe_path: exe.to_string_lossy().to_string(),
        version: Some("2.31".to_string()),
        source: source.to_string(),
        valid: true,
        archive_dir: None,
        mods_dir: None,
        language: None,
        game_updated: false,
        last_game_version: Some("2.31".to_string()),
    }
}

fn check(
    platform: &str,
    exe_present: bool,
    prelauncher_present: bool,
    client_running: bool,
    steam_available: bool,
) -> crate::game::LaunchCheck {
    crate::game::LaunchCheck {
        platform: platform.to_string(),
        platform_label: platform.to_string(),
        exe_present,
        prelauncher_present,
        drm_client: Platform::from_id(platform).drm_client().map(str::to_string),
        drm_client_running: client_running,
        steam_available,
        can_direct: exe_present && client_running,
        reasons: Vec::new(),
        notes: Vec::new(),
    }
}

#[test]
fn platform_comes_from_source_hint_first() {
    let root = temp_root("hint");
    assert_eq!(platform_of(&root, "steam"), Platform::Steam);
    assert_eq!(platform_of(&root, "steam:library"), Platform::Steam);
    assert_eq!(platform_of(&root, "gog"), Platform::Gog);
    assert_eq!(platform_of(&root, "epic"), Platform::Epic);
    assert_eq!(platform_of(&root, "manual"), Platform::Manual);
}

#[test]
fn platform_falls_back_to_path_and_markers() {
    let steam_like = PathBuf::from(r"D:\SteamLibrary\steamapps\common\Cyberpunk 2077");
    assert_eq!(platform_of(&steam_like, "manual"), Platform::Steam);

    let gog = temp_root("gog");
    std::fs::write(gog.join("goggame-1423049311.info"), b"{}").unwrap();
    assert_eq!(platform_of(&gog, "manual"), Platform::Gog);

    let epic = temp_root("epic");
    std::fs::create_dir_all(epic.join(".egstore")).unwrap();
    assert_eq!(platform_of(&epic, "manual"), Platform::Epic);

    let plain = temp_root("plain");
    assert_eq!(platform_of(&plain, "manual"), Platform::Manual);
}

#[test]
fn inspect_detects_prelauncher_and_marks_gog_direct_ready() {
    let root = temp_root("inspect-gog");
    std::fs::write(
        root.join("bin").join("x64").join("REDprelauncher.exe"),
        b"MZ",
    )
    .unwrap();
    let game = fake_game(&root, "gog");
    let info = inspect_launch(&game);
    assert_eq!(info.platform, "gog");
    assert!(info.prelauncher_present);
    // GOG 版没有 DRM 客户端，直启条件天然满足。
    assert!(info.can_direct);
    assert!(info.drm_client.is_none());
    assert!(info.notes.iter().any(|note| note.contains("REDprelauncher")));
}

#[test]
fn inspect_reports_missing_exe_as_hard_blocker() {
    let root = temp_root("inspect-missing");
    let game = GameInfo {
        root: root.to_string_lossy().to_string(),
        exe_path: root
            .join("bin")
            .join("x64")
            .join("Cyberpunk2077.exe")
            .to_string_lossy()
            .to_string(),
        version: None,
        source: "gog".to_string(),
        valid: false,
        archive_dir: None,
        mods_dir: None,
        language: None,
        game_updated: false,
        last_game_version: None,
    };
    let info = inspect_launch(&game);
    assert!(!info.exe_present);
    assert!(!info.can_direct);
    assert!(info.reasons.iter().any(|reason| reason.contains("Cyberpunk2077.exe")));
}

#[test]
fn auto_prefers_direct_when_prerequisites_hold() {
    let info = check("steam", true, true, true, true);
    let plan: LaunchPlan = plan_launch(&info, "auto").unwrap();
    assert_eq!(plan.route, LaunchRoute::Direct);
}

#[test]
fn auto_falls_back_to_steam_when_client_is_not_running() {
    let info = check("steam", true, true, false, true);
    let plan = plan_launch(&info, "auto").unwrap();
    assert_eq!(plan.route, LaunchRoute::Steam);
    assert!(plan.notes.iter().any(|note| note.contains("Steam 启动")));
}

#[test]
fn auto_reports_blocker_when_steam_missing_entirely() {
    let info = check("steam", true, true, false, false);
    let err = plan_launch(&info, "auto").unwrap_err();
    assert_eq!(err.code, "LAUNCH_CLIENT_REQUIRED");
}

#[test]
fn epic_requires_client_even_in_auto_mode() {
    let info = check("epic", true, true, false, true);
    let err = plan_launch(&info, "auto").unwrap_err();
    assert_eq!(err.code, "LAUNCH_CLIENT_REQUIRED");
    // 客户端在跑的时候就能直启（只是不跳过 DRM，不需要跳过）。
    let ready = check("epic", true, true, true, true);
    assert_eq!(plan_launch(&ready, "auto").unwrap().route, LaunchRoute::Direct);
}

#[test]
fn gog_and_manual_go_direct_by_default() {
    assert_eq!(
        plan_launch(&check("gog", true, true, true, false), "auto")
            .unwrap()
            .route,
        LaunchRoute::Direct
    );
    assert_eq!(
        plan_launch(&check("manual", true, false, true, false), "auto")
            .unwrap()
            .route,
        LaunchRoute::Direct
    );
}

#[test]
fn direct_mode_never_silently_switches_route() {
    let info = check("steam", true, true, false, true);
    let err = plan_launch(&info, "direct").unwrap_err();
    assert_eq!(err.code, "LAUNCH_CLIENT_REQUIRED");
    assert!(err.message.contains("自动"));
}

#[test]
fn forced_steam_requires_steam_installation() {
    let info = check("gog", true, true, true, false);
    let err = plan_launch(&info, "steam").unwrap_err();
    assert_eq!(err.code, "STEAM_NOT_FOUND");
}

#[test]
fn missing_exe_blocks_every_route() {
    let info = check("gog", false, true, true, false);
    let err = plan_launch(&info, "auto").unwrap_err();
    assert_eq!(err.code, "GAME_EXE_NOT_FOUND");
}

#[test]
fn fallback_order_prefers_steam_then_prelauncher() {
    assert_eq!(
        fallback_routes(&check("steam", true, true, false, true)),
        vec![LaunchRoute::Steam, LaunchRoute::Official]
    );
    // 没有 Steam 安装时直接交给官方启动器。
    assert_eq!(
        fallback_routes(&check("steam", true, true, false, false)),
        vec![LaunchRoute::Official]
    );
    // GOG 版没有官方启动器时，只能靠 Steam 兜底（如果装了）。
    assert_eq!(
        fallback_routes(&check("gog", true, false, true, true)),
        vec![LaunchRoute::Steam]
    );
    // 什么都没有：明确返回空，让上层报「请从平台客户端启动」。
    assert!(fallback_routes(&check("manual", true, false, true, false)).is_empty());
}
