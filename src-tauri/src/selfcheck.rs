//! `--self-check <out.json>`：无窗口自检，给回归脚本用。
//!
//! 为什么需要它：提权相关的回归（数据目录是否落到别处、DPAPI 密钥能不能读回）
//! 原先只能靠人点界面看，而且「以管理员身份运行」时界面本身也不方便截图对比。
//! 这里把结论压成一份 JSON：普通权限跑一次、提权再跑一次，diff 一下就出结论。
//!
//! 安全边界：**只报告密钥是否可解密，绝不输出密钥内容**；
//! 也不写任何状态文件（除了自检结果本身），避免"自检把用户数据改了"。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::store::Store;
use crate::{ai, exe_sibling_data_dir, nexus, probe_writable, resolve_data_dir, secret};

/// 命中 `--self-check` 就执行并返回进程退出码；没命中返回 None（正常启动）。
pub fn run(args: &[String]) -> Option<i32> {
    let index = args.iter().position(|arg| arg == "--self-check")?;
    let target = args
        .get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .map(PathBuf::from)
        .unwrap_or_else(default_path);

    let report = collect();
    let text = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string());
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let written = std::fs::write(&target, &text).is_ok();
    // 打包后的 exe 是 windows_subsystem="windows"，stdout 没有控制台；
    // 写 stderr 与文件双份，脚本读文件、人肉排查看日志都覆盖。
    eprintln!("{text}");
    if !written {
        eprintln!("self-check: 无法写入 {}", target.display());
        return Some(2);
    }
    Some(0)
}

fn default_path() -> PathBuf {
    exe_sibling_data_dir()
        .map(|dir| dir.join("self-check.json"))
        .unwrap_or_else(|| PathBuf::from("self-check.json"))
}

/// `--nxm-takeover` / `--nxm-release`：把界面上的两个按钮变成可脚本调用的命令。
///
/// 为什么需要：接管/交还改的是用户注册表，出问题时用户往往连界面都不方便点
/// （比如启动器正被另一个实例占着），给一条命令行就能修回来。
/// 输出同样是 JSON，一次性做完即退出，不创建窗口。
pub fn run_nxm(args: &[String]) -> Option<i32> {
    let takeover = if args.iter().any(|arg| arg == "--nxm-takeover") {
        true
    } else if args.iter().any(|arg| arg == "--nxm-release") {
        false
    } else {
        return None;
    };
    let data_dir = resolve_data_dir();
    let result = if takeover {
        crate::nxm::takeover(&data_dir)
    } else {
        crate::nxm::release(&data_dir)
    };
    let payload = match result {
        Ok(status) => json!({ "ok": true, "action": if takeover { "takeover" } else { "release" }, "nxm": status }),
        Err(err) => json!({ "ok": false, "action": if takeover { "takeover" } else { "release" }, "error": { "code": err.code, "message": err.message } }),
    };
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
    eprintln!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
    Some(if ok { 0 } else { 1 })
}

fn collect() -> Value {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("<unknown>"));
    let data_dir = resolve_data_dir();
    let sibling = exe_sibling_data_dir();

    let (state, state_error, mods, profiles) = match Store::load(data_dir.clone()) {
        Ok(store) => {
            let data = store.data.lock().expect("state mutex poisoned");
            (true, Value::Null, data.mods.len(), data.profiles.len())
        }
        Err(err) => (false, json!({ "code": err.code, "message": err.message }), 0, 0),
    };

    // 密钥只报"能否解密"，不报内容。
    let ai_key = secret_status(ai::key_path_from(&data_dir));
    let nexus_key = secret_status(nexus::key_path_from(&data_dir));

    let game = game_report(&data_dir);
    let nxm = crate::nxm::status(&data_dir);

    json!({
        "generatedAt": crate::store::now_iso(),
        "elevated": is_elevated(),
        "exe": exe.display().to_string(),
        "user": std::env::var("USERNAME").unwrap_or_else(|_| "<none>".into()),
        "userProfile": std::env::var("USERPROFILE").unwrap_or_else(|_| "<none>".into()),
        "appData": std::env::var("APPDATA").unwrap_or_else(|_| "<none>".into()),
        "dataDir": data_dir.display().to_string(),
        "dataDirProbe": probe_writable(&data_dir),
        "exeSiblingDataDir": sibling
            .as_ref()
            .map(|dir| dir.display().to_string())
            .unwrap_or_else(|| "<none>".into()),
        "exeSiblingIsDir": sibling.as_ref().map(|dir| dir.is_dir()).unwrap_or(false),
        "state": {
            "loaded": state,
            "error": state_error,
            "mods": mods,
            "profiles": profiles,
        },
        "secrets": {
            "aiKey": ai_key,
            "nexusKey": nexus_key,
        },
        "game": game,
        "nxm": {
            "registered": nxm.registered,
            "ours": nxm.ours,
            "owner": nxm.owner,
            "handler": nxm.handler,
            "backup": nxm.backup,
        },
    })
}

fn secret_status(path: PathBuf) -> String {
    if !path.is_file() {
        return "missing".to_string();
    }
    match secret::load(&path) {
        Ok(Some(_)) => "readable".to_string(),
        Ok(None) => "empty".to_string(),
        Err(err) => format!("error({}: {})", err.code, err.message),
    }
}

fn game_report(data_dir: &Path) -> Value {
    let Ok(store) = Store::load(data_dir.to_path_buf()) else {
        return Value::Null;
    };
    let data = store.data.lock().expect("state mutex poisoned");
    let Some(directory) = data.game_dir.as_deref().filter(|value| !value.trim().is_empty()) else {
        return Value::Null;
    };
    let root = PathBuf::from(directory);
    let exe = root.join("bin").join("x64").join("Cyberpunk2077.exe");
    json!({
        "root": directory,
        "rootExists": root.is_dir(),
        "exePresent": exe.is_file(),
        "prelauncherPresent": root.join("REDprelauncher.exe").is_file(),
    })
}

/// 复用 lib.rs 里已有的提权判定，避免同一个结论两处实现、两处漂移。
fn is_elevated() -> bool {
    crate::is_process_elevated()
}
