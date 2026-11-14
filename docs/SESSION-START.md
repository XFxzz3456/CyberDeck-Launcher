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

## 3. 当前状态快照（2026-11-14）

> **两层要分清**：对外发布的产物仍是 **1.8.3**（2026-11-13 的 exe / ZIP / Release）；仓库 `main` 上另有 **1.8.3 之后未发版**的 #10 + #11 修复批次，三处 `version` 仍写着 1.8.3，**尚未升版、尚未重构建 exe**。

| 项 | 值 |
|---|---|
| 版本 | 对外发布 **1.8.3**；源码 HEAD 为「1.8.3 之后未发版」批次（三处 `version` 仍 `1.8.3`，`CHANGELOG.md` 用 `[未发版 · 1.8.3 之后]` 单独记） |
| 远端 | `main` 含 1.8.3 合并提交 + 2026-11-14 修复批次；tag **`v1.8.3` 保持指向已发布产物对应的提交**（本轮未动 tag，待验收后升版再打新 tag）；`v1.8.4` 已删除 |
| 进度 | GitHub Issues **#1 已关闭、#2–#9 open**（长期功能轨道）；**#10 / #11 为本轮 #10+#11 五项缺陷批次，已修复并回填关闭**（用户 2026-11-14 授权「一起修吧，还有 GitHub 上的 issue」）；标签 `P0` / `P1` / `P2` / `migrated` |
| 门禁基线 | 全量门禁 **39/39 全绿**（2026-11-14，373s 工时）；`cargo test --lib` **399 passed / 2 ignored**；`tsc --noEmit` 0 错误；`i18n:check` 0 处、`i18n:unused` 0 条（词表 2300）；`cargo check --lib` 0 warning |
| release exe | **仍是 1.8.3 正式包**：11,176,960 B（10.66 MB）/ md5 `5906af219d4052e3193bc2e06266ed11` / PE 1.8.3 / mtime 2026-11-13 23:13:59；`.prev.exe` 为 1.8.4 临时包。本轮改动**未**进 exe |
| 便携版 ZIP | **仍是 1.8.3**：`发布产物/CyberDeck Launcher 1.8.3 便携版.zip`，5,714,563 B（5.45 MiB） / md5 `1a61d735ac45bdb111f7f34013187fbd` / sha256 `9d88d47765966e18cc4bd81d34948738cc91ebc31dd28bb160cd7b7930edf4c7`；GitHub Release [https://github.com/XFxzz3456/CyberDeck-Launcher/releases/tag/v1.8.3](https://github.com/XFxzz3456/CyberDeck-Launcher/releases/tag/v1.8.3)（最新）资产 `CyberDeck.Launcher.1.8.3.zip` |
| 本轮修复 | #10：铃铛角标/已读态、面板 portal+fixed 层级、带 `?query` 外链 explorer 转交；#11：存档风险报告级 `globalRisks` + 默认折叠、安装根锚点优先 + `apply_update` 核心 DLL 护栏；另含本机 ArchiveXL 运行时数据修复（不在仓库内）。复盘见 `docs/INCIDENT-2026-11-14-batch-fixes.md` |
| 当前关口 | **先 localhost:1420 验收（用户实际点一遍）→ 用户明确确认「没问题」→ 才允许升版 / 构建 exe / 替换 release**；便携 ZIP 与 Release 需另外单独确认 |
| 未做 | #10③「去获取」真机确认浏览器拉起（不能只看日志 `result=ok`）；兜底 ShellExecute 在提权进程下的表现；内置 Nexus 窗口端到端真机（登录 → Mod Manager Download → 任务条）；第三方 OAuth 登录；UI/UX 顺延（首次向导 / 选择态上提 / 技术信息分层 / 样式全量令牌化）；#8 实机双端验收；全类型汉化真机样本；Vortex A1–A10 |

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
