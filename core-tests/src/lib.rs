#![allow(dead_code)]

//! Headless test harness for the launcher's file-operation core.
//!
//! The production crate embeds Tauri and a WebView2 host. This crate compiles the
//! same core modules without that GUI runtime so the deployment logic can be
//! exercised in CI and on machines without a WebView2 profile.

#[path = "../../src-tauri/src/adopt.rs"]
pub mod adopt;
#[path = "../../src-tauri/src/vortex_source.rs"]
pub mod vortex_source;
#[path = "../../src-tauri/src/deps.rs"]
pub mod deps;
#[path = "../../src-tauri/src/translation.rs"]
pub mod translation;
#[path = "../../src-tauri/src/schema.rs"]
pub mod schema;
#[path = "../../src-tauri/src/modname.rs"]
pub mod modname;
#[path = "../../src-tauri/src/store.rs"]
pub mod store;
#[path = "../../src-tauri/src/game.rs"]
pub mod game;
#[path = "../../src-tauri/src/nxm.rs"]
pub mod nxm;
#[path = "../../src-tauri/src/collection.rs"]
pub mod collection;
#[path = "../../src-tauri/src/profiles.rs"]
pub mod profiles;

#[path = "../../src-tauri/src/config_resolver.rs"]
pub mod config_resolver;
#[path = "../../src-tauri/src/category.rs"]
pub mod category;
#[path = "../../src-tauri/src/glossary.rs"]
pub mod glossary;
#[path = "../../src-tauri/src/installer.rs"]
pub mod installer;
// installer 的卸载逻辑要按文件类型分级（文本配置被工具重写不算篡改），
// 判定函数只有一份，放在 environment 里，两个 crate 共用。
#[path = "../../src-tauri/src/environment.rs"]
pub mod environment;
#[path = "../../src-tauri/src/loadorder.rs"]
pub mod loadorder;
// loadorder 的 REDmod 展示顺序要对 redmod::normalize_order 求解，先把模块带上。
#[path = "../../src-tauri/src/redmod.rs"]
pub mod redmod;
#[path = "../../src-tauri/src/logs.rs"]
pub mod logs;
#[path = "../../src-tauri/src/modsettings.rs"]
pub mod modsettings;
#[path = "../../src-tauri/src/backup.rs"]
pub mod backup;
#[path = "../../src-tauri/src/diagnostics.rs"]
pub mod diagnostics;
#[path = "../../src-tauri/src/secret.rs"]
pub mod secret;
#[path = "../../src-tauri/src/ai.rs"]
pub mod ai;
#[path = "../../src-tauri/src/wolvenkit.rs"]
pub mod wolvenkit;
#[path = "../../src-tauri/src/ailoc.rs"]
pub mod ailoc;
#[path = "../../src-tauri/src/ailabel.rs"]
pub mod ailabel;
#[path = "../../src-tauri/src/aifix.rs"]
pub mod aifix;

#[cfg(test)]
#[path = "../../src-tauri/src/installer_tests.rs"]
mod installer_tests;

#[cfg(test)]
#[path = "../../src-tauri/src/adopt_tests.rs"]
mod adopt_tests;

#[cfg(test)]
#[path = "../../src-tauri/src/ai_tools_tests.rs"]
mod ai_tools_tests;

#[cfg(test)]
#[path = "../../src-tauri/src/game_tests.rs"]
mod game_tests;

#[cfg(test)]
#[path = "../../src-tauri/src/nxm_tests.rs"]
mod nxm_tests;

/// `vortex.rs` depends on LevelDB, which this headless test crate does not pull in.
/// Adoption tests only need the "no records" path, so provide an empty implementation.
pub mod vortex {
    use crate::schema::{AppResult, VortexRecord};

    pub fn load_records() -> AppResult<Vec<VortexRecord>> {
        Ok(Vec::new())
    }
}
