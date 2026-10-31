#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--self-check`: 无窗口自检（提权 / 数据目录 / DPAPI 密钥 / 状态往返），
    // `--nxm-takeover` / `--nxm-release`: 命令行接管/交还 nxm:// 协议。
    // 三条都是脚本入口，命中时不建窗口、直接退出。
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = cyberdeck_launcher_lib::self_check(&args) {
        std::process::exit(code);
    }
    cyberdeck_launcher_lib::run()
}
