# 新会话接手卡（CyberDeck Launcher）

> **2026-11-07 起生效**：WorkBuddy 项目功能已停用，进度载体迁到 GitHub。
> 本文件是**任何新会话的第一个入口**，已提交进仓库，桌面端与手机端都能读到。
> 配套：`AGENTS.md`（执行规范）、`docs/MEMORY-CANON.md`（铁律与坑）、`HANDOFF.md §0 / §12`（版本口径与接手）。

---

## 1. 三种新会话，分别怎么接上

| 场景 | 能自动读到 | 必须手动补的 |
|---|---|---|
| **同一工作空间新建任务（桌面）** | 云端记忆 + 用户级 `MEMORY.md` + 工作区 `.workbuddy/memory/MEMORY.md` + 本地仓库文件 | 选工作空间时指向 `D:\用户\CyberDeck-Launcher\src`（或含本仓库的父目录）；第一句话给下面的模板 |
| **手机 App「连接电脑」模式** | 桌面端全部本地文件（远程操控） | 桌面端开「允许移动端连接」+「保持唤醒」；新建任务时选同一工作空间 |
| **手机小程序「云上模式」** | 云端记忆 + 联网能力 | **读不到本机 D 盘和 MEMORY.md**。第一句话必须给 GitHub 原始文件 URL，让 Agent 联网拉取 |

**关键限制**：云上模式的 Agent 在云端沙箱，碰不到本地源码，也不能执行 `cargo` / `npm`。它适合看进度、评论 issue、做调研、改文档；**改代码/构建必须回桌面端本机模式**。

---

## 2. 新会话第一句话（直接复制）

### 桌面 / 本机模式

```
接手 CyberDeck Launcher。先读 D:\用户\CyberDeck-Launcher\src 下的
docs/SESSION-START.md、AGENTS.md、HANDOFF.md §0 与 §12、CHANGELOG.md 顶部。
进度以 https://github.com/XFxzz3456/CyberDeck-Launcher/issues 的 9 条 issue 为准（P0/P1/P2）。
读完后回报：当前版本号、git 工作区状态、未提交改动、下一步建议。不要先改 UI，不要先构建 exe。
```

### 手机云上模式（无本地文件）

```
接手 CyberDeck Launcher。用联网读取以下原始文件：
https://raw.githubusercontent.com/XFxzz3456/CyberDeck-Launcher/main/docs/SESSION-START.md
https://raw.githubusercontent.com/XFxzz3456/CyberDeck-Launcher/main/AGENTS.md
并查看 https://github.com/XFxzz3456/CyberDeck-Launcher/issues 。
本项目进度以 GitHub Issues 为准，不要依赖本地会话记忆。读完回报当前状态与下一步。
```

> 想回忆更早的讨论，明确说「检索一下之前关于 XX 的会话」，才会触发历史会话检索；默认不会自动带上。

---

## 3. 当前状态快照（2026-11-13）

| 项 | 值 |
|---|---|
| 版本 | **1.8.2**（tag `v1.8.2`；exe 已构建并替换 release；1.8.2 便携 ZIP 未打） |
| 远端 | `main` 含 1.8.2 发版提交；tag 最新 **`v1.8.2`** |
| 进度 | GitHub Issues **#1 已关闭、#2–#9 open**，标签 `P0` / `P1` / `P2` / `migrated` |
| 门禁基线 | `cargo test --lib` **395 passed / 2 ignored**；全量门禁 **43/43 全绿**；`tsc --noEmit` 0 错误 |
| release exe | 11,165,696 B（10.65 MB）/ md5 `11b32961281214f13ca4a7ccd0ee49bd`；PE `1.8.2`（2026-11-13 00:22） |
| 便携版 ZIP | 仍是 `发布产物/CyberDeck Launcher 1.8.0 便携版.zip`（5,713,819 B / md5 `8d203a9b843e104d7ed7468e1dda9e68`）；**1.8.2 的 ZIP 未打**，GitHub Release 最新仍 `v1.8.0` |
| 未做 | 内置 Nexus 窗口端到端真机（登录 → Mod Manager Download → 任务条）；第三方 OAuth 登录；UI/UX 顺延（首次向导 / 选择态上提 / 技术信息分层 / 样式全量令牌化）；#8 实机双端验收；全类型汉化真机样本；Vortex A1–A10；腾讯文档进度表停在 1.5.0，是否继续维护待定 |

---

## 4. 上下文落点（谁自动注入，谁要手喂）

| 层 | 位置 | 新会话是否自动有 |
|---|---|---|
| 云端记忆 | 服务端，每晚从会话提取，仅本人可见 | ✅ 自动注入（偏偏好/习惯，**不保证带项目细节**） |
| 用户级记忆 | `C:\Users\mc236\.workbuddy\user-...-personal\MEMORY.md` | ✅ 桌面端自动注入；**手机云上模式读不到** |
| 工作区记忆 | 对应工作区 `.workbuddy/memory/MEMORY.md` + 当日日志 | ✅ 同工作空间自动注入；换空间就没有 |
| 仓库内文档 | `AGENTS.md` / `HANDOFF.md` / `docs/*`（本文件） | ❌ 要让 Agent 读；**但已进 GitHub，手机可联网拉取** |
| 进度本身 | GitHub Issues | ❌ 要给链接 |

**所以最稳的一条**：把交接卡和进度都放 GitHub。任何设备、任何新会话，给一个 URL 就能接上。

---

## 5. 不变的红线（别在新会话里被推翻）

1. 卸载只信任 `deployed_files` 清单，绝不推测。
2. 路径拼接必过 `safe_join` + `is_within`。
3. 硬链接身份比对用 `GetFileInformationByHandle`。
4. `Mutex` 内不做 IO（无锁 IO → 短锁登记 → 锁外 emit）。
5. 交付顺序：**先 localhost 跑起来给用户验收 → 用户确认 → 才允许构建 exe / 替换 release**；禁止任务一开始就开 dev 窗口。
6. 便携 ZIP 对外分发**必须先问**。
7. 新模块/复杂难点先调研开源并出简报，用户确认后才装依赖。
8. 改 Rust 前先读 `docs/ARCHITECTURE.md` 与 `HANDOFF.md`。

## 6. 已作废的旧约定

- ~~每次任务完成后自动同步项目网盘 `YbyPEuDRRBHW` + 资料库同名文档~~ → 2026-11-07 起文档以 GitHub 仓库为准，不再主动覆盖网盘 / 新建资料库节点。
- ~~项目待办 / 项目留言作为进度载体~~ → 已迁入 GitHub Issues，项目留言停用。
- `HANDOFF.md §12` 的「新电脑上的 AI 助手可以先读…」仍然有效，但**漏了进度载体迁移这一层**；以本文件为准。
