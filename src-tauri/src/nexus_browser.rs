//! 内置 Nexus Mods 浏览窗口。
//!
//! 目标：在启动器内浏览 Nexus 并直接点「Mod Manager Download」，不再切系统浏览器。
//!
//! 边界（刻意为之）：
//! - **不碰** nxm 解析与下载核心：窗口里触发的 `nxm://` 一律原样交给
//!   `lib.rs::intake_nxm`，与协议拉起、单实例转交走完全相同的收件箱与事件链路。
//! - 只允许在窗口内导航到 `nexusmods.com` 及其子域；其余 **http/https** 链接交给系统浏览器，
//!   `nxm://` 拦截后交给收件箱并阻止 WebView 自己导航。`file:` / `ms-*` / 其它自定义
//!   scheme 一律直接丢弃 —— 它们不是「网页链接」，交给 shell 等于让页面执行本机程序
//!   （2026-11-10 自检 P1-2）。
//! - 不关 WebView2 沙箱：这个窗口会加载第三方 CDN 与广告，`--no-sandbox` 等于把渲染进程
//!   的隔离也一起关掉，没有收益只有风险。
//! - 与主窗口共用 `EBWebView` 数据目录，登录状态天然共享（同进程多 WebView）。

use std::path::Path;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::schema::{AppResult, CommandError};

/// 唯一窗口标签：重复点击只聚焦，不重复开窗。
pub const WINDOW_LABEL: &str = "nexus-browser";
/// 默认落地页。
pub const NEXUS_HOME: &str = "https://www.nexusmods.com/cyberpunk2077";

/// 允许在窗口内停留的站点：nexusmods.com 及其子域。
///
/// 只做「完全相等」或「以 `.nexusmods.com` 结尾」判断，
/// `evilnexusmods.com` / `nexusmods.com.evil.com` 都不会命中。
pub fn is_allowed_host(url: &tauri::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    url.host_str()
        .map(|host| {
            let host = host.to_ascii_lowercase();
            host == "nexusmods.com" || host.ends_with(".nexusmods.com")
        })
        .unwrap_or(false)
}

/// 只有 http/https 才允许「交给系统浏览器」。
///
/// 判断放在函数里而不是内联，是为了能被单测覆盖：`file:` 这类 scheme 交给 shell
/// 等于执行本机程序，这条红线必须有断言守着。
pub fn is_external_link(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// WebView 内部产生的导航（空白页、内联数据、blob）放行，避免白屏。
pub fn is_internal_scheme(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "about" | "data" | "blob")
}

/// 打开（或聚焦）内置 Nexus 窗口。
pub fn open(app: &AppHandle, data_dir: &Path) -> AppResult<()> {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let home = NEXUS_HOME
        .parse::<tauri::Url>()
        .map_err(|err| CommandError::new("NEXUS_URL_INVALID", format!("默认地址无效：{err}")))?;

    // 与主窗口同一份 WebView2 用户数据目录：Cookie / 登录态共享。
    let profile = data_dir.join("EBWebView");
    let handle = app.clone();

    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(home))
        .title("Nexus Mods — CyberDeck")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 620.0)
        .center()
        .resizable(true)
        .decorations(true)
        .data_directory(profile)
        .on_navigation(move |url| {
            // 1) nxm:// —— 不导航，直接投递到既有收件箱（解析/下载核心零改动）。
            if url.scheme() == "nxm" {
                crate::intake_nxm(&handle, &[url.to_string()]);
                return false;
            }
            // 2) Nexus 站内 + WebView 内部页面 —— 放行。
            if is_allowed_host(url) || is_internal_scheme(url) {
                return true;
            }
            // 3) 其它站点 —— 只把 http(s) 交给系统浏览器，窗口留在 Nexus。
            //    其它 scheme 直接丢弃：`file:///C:/Windows/System32/calc.exe` 这类链接
            //    出现在页面里时，交给 shell 就是把「点一下」变成「执行本机程序」。
            if is_external_link(url) {
                let _ = crate::open_via_explorer(url.as_str());
            }
            false
        })
        .build()
        .map_err(|err| {
            CommandError::new(
                "NEXUS_WINDOW_FAILED",
                format!("无法创建 Nexus 浏览窗口：{err}"),
            )
        })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: &str) -> tauri::Url {
        value.parse().expect("test url")
    }

    #[test]
    fn allows_nexus_root_and_subdomains() {
        assert!(is_allowed_host(&parse("https://nexusmods.com/cyberpunk2077")));
        assert!(is_allowed_host(&parse(
            "https://www.nexusmods.com/cyberpunk2077/mods/107"
        )));
        assert!(is_allowed_host(&parse("https://users.nexusmods.com/login")));
        assert!(is_allowed_host(&parse("http://nexusmods.com/")));
    }

    /// 页面里的 `file:` / `ms-*` 链接不能进 shell（2026-11-10 自检 P1-2）。
    #[test]
    fn only_http_links_go_to_shell() {
        assert!(is_external_link(&parse("https://www.google.com/")));
        assert!(is_external_link(&parse("http://example.com/")));
        assert!(!is_external_link(&parse(
            "file:///C:/Windows/System32/calc.exe"
        )));
        assert!(!is_external_link(&parse("ms-settings:privacy")));
        assert!(!is_external_link(&parse("javascript:alert(1)")));
    }

    #[test]
    fn rejects_lookalike_and_external_hosts() {
        assert!(!is_allowed_host(&parse("https://evilnexusmods.com/")));
        assert!(!is_allowed_host(&parse("https://nexusmods.com.evil.com/")));
        assert!(!is_allowed_host(&parse("https://www.google.com/")));
        assert!(!is_allowed_host(&parse("nxm://cyberpunk2077/mods/107")));
    }

    #[test]
    fn allows_internal_schemes_only() {
        assert!(is_internal_scheme(&parse("about:blank")));
        assert!(is_internal_scheme(&parse(
            "data:text/html,<p>hi</p>"
        )));
        assert!(!is_internal_scheme(&parse("javascript:alert(1)")));
        assert!(!is_internal_scheme(&parse(
            "https://www.nexusmods.com/"
        )));
    }

    #[test]
    fn nxm_scheme_is_detected_by_caller() {
        assert_eq!(parse("nxm://cyberpunk2077/mods/107").scheme(), "nxm");
    }
}
