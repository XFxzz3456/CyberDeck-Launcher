use std::path::{Path, PathBuf};

fn main() {
    // 保持 Tauri 默认清单（asInvoker）：启动器按普通权限运行。
    // 管理员运行会让浏览器/拖拽等跨完整性交互失效，只在个别操作确需提权时
    // 由用户自行「以管理员身份运行」——此时 open_url 会自动改走 explorer 转交。
    tauri_build::build();

    // Tauri embeds the frontend directory at compile time. Make sure a rebuilt
    // dist actually triggers recompilation of the binary.
    println!("cargo:rerun-if-changed=../dist");

    // Windows GNU builds load WebView2Loader.dll dynamically. MSVC builds link
    // it through the import library, so this is a no-op / harmless there too.
    println!("cargo:rerun-if-changed=WebView2Loader.dll");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("WebView2Loader.dll");
    if !source.is_file() {
        println!(
            "cargo:warning=WebView2Loader.dll not found next to Cargo.toml; \
             GNU builds will need it beside the executable at runtime"
        );
        return;
    }

    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let out_dir = PathBuf::from(out_dir);
    // OUT_DIR = <target>/<profile>/build/<pkg>/out
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    for destination in [profile_dir.to_path_buf(), profile_dir.join("deps")] {
        if let Err(err) = std::fs::create_dir_all(&destination) {
            println!("cargo:warning=could not create {}: {err}", destination.display());
            continue;
        }
        let target = destination.join("WebView2Loader.dll");
        if let Err(err) = std::fs::copy(&source, &target) {
            println!(
                "cargo:warning=could not copy WebView2Loader.dll to {}: {err}",
                target.display()
            );
        }
    }
}
