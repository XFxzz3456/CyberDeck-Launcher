# 内置 Nexus 浏览窗口（open_nexus_browser）

> 2026-11-10 落地。目的：不用切系统浏览器，在启动器内浏览 Nexus 并直接接管下载。

## 行为

| 项 | 实现 |
|---|---|
| 窗口 | `nexus-browser`，1280×860，可缩放，独立标题栏；重复点击只聚焦，不重复开窗 |
| 落地页 | `https://www.nexusmods.com/cyberpunk2077` |
| 登录态 | 与主窗口共用 `cyberdeck-data/EBWebView` 用户数据目录，Cookie 共享 |
| 站内导航 | 仅 `nexusmods.com` 与 `*.nexusmods.com` 放行；`about:` / `data:` / `blob:` 放行（WebView 内部页） |
| 外部链接 | 交给系统浏览器（`explorer` 转交，与 `open_url` 同一条成熟路径），窗口留在 Nexus |
| `nxm://` | 在导航处理器里拦截，转交 `lib.rs::intake_nxm`，**与协议拉起/单实例转交走同一收件箱与 `nxm-link` 事件**，解析与下载核心零改动 |

## 为什么这样接

- `on_navigation` 返回 `false` 即可阻止 WebView 自己处理 `nxm:`，同时我们手动投递，避免「WebView 弹系统协议框」或「依赖注册表/单实例」的时序问题。
- 即使用户没接管 `nxm://` 协议，内置窗口里的下载按钮也能工作——这条路径不依赖注册表。
- 收件箱本身按 `uri` 去重，所以「导航拦截 + 系统协议转发」同时命中也不会下两遍。

## 已知边界

1. **第三方 OAuth 登录**（Google / Discord 等）会跳外部域名，按导航白名单会被交给系统浏览器，登录态回不到内置窗口。**建议在窗口内用 Nexus 邮箱 + 密码登录**；Nexus 账号本身支持。
2. 窗口未加入 `capabilities/default.json`，因此页面没有 Tauri IPC 权限——这是刻意的，浏览外部站点不需要任何本地能力。
3. 免费账号点「Mod Manager Download」仍走 Nexus 的慢速/验证流程，与系统浏览器行为一致；启动器只负责接管 `nxm://`。
4. 真机端到端（登录 → 点下载 → 任务条出现）需人工验收；自动化只覆盖导航白名单单测与主窗口冒烟。

## 相关代码

- `src-tauri/src/nexus_browser.rs`：窗口创建、导航白名单、4 条单测
- `src-tauri/src/lib.rs`：`open_nexus_browser` 命令、`intake_nxm` / `open_via_explorer` 改为 `pub(crate)`
- `src/lib/api.ts`：`openNexusBrowser()`（浏览器预览回退 `window.open`）
- `src/components/NexusView.tsx`：工具栏「在 N 网浏览」主按钮
- `src/i18n/zh-CN.ts`：`nexus.browseInApp` / `browseInAppTitle` / `browseFailed`
