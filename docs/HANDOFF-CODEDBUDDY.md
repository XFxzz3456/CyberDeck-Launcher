# 交接给 CodeBuddy（2026-10-31 15:45）

> 这份文档是给「换到 CodeBuddy 继续开发」用的现场快照。项目长期交接文档仍是 `HANDOFF.md`，本文件只讲**从哪里接着干**。

## 一、仓库现状

| 项 | 值 |
|---|---|
| 仓库根 | `D:\用户\CyberDeck-Launcher\src`（`release` / `发布产物` / `归档` 在上级，不进库） |
| 分支 | `main` |
| 本地 HEAD | `38b1a99`（个性化页 6 卡重构） |
| 远端 HEAD | `314a7f7`（**本地领先 2 个提交，尚未推送**） |
| 远端地址 | https://github.com/XFxzz3456/CyberDeck-Launcher（public / MIT） |
| 版本 | 0.9.0，三处版本号已统一（`package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json`） |

开工前先：`git pull --rebase` → `git log --oneline -3` 对齐远端，避免和我这边的提交打架。

## 二、本轮已完成（别重做）

1. **r37 UI 量化修复**（已提交 `eeaae0f` 之后的批次）
   - `.page` 加 `max-width: 1680px` + 居中：2560 屏内容从 2300px 收窄，1920 及以下零回归
   - `--muted-2` 提到 `#82868f`、`.mod-meta` 改走变量：深色主题对比度失败项 5 → 0
   - `.nav-item` / `.mod-card` / `.settings-tab` / `.nexus-tab` 补 `:active`
   - `check-ui-audit.mjs` 进 门禁（项数 26 → 27），并修掉它自身两处假阳性（祖先隐藏、`<option>` 无布局盒）
2. **README 事实修正 + 23 张截图重拍**
   - 原文「六套主题含 Mono / Daylight」是错的：实际 5 套（`mono` r20 已删、`daylight` 更早下线），ARASAKA 那格贴的还是 NCPD 的图
   - 补齐从未写过的「存档管理」功能行与截图；删除 `mono.png` / `daylight.png`
3. **r38 个性化页卡片化**（`38b1a99`）
   - 一张大卡 + 四段虚线 → 6 张独立卡片（01 主题与配色 / 02 左侧导航栏 / 03 窗口与侧边栏 / 04 字体与排版 / 05 背景图 / 06 动效与启动）
   - 「关闭窗口时」从卡外 panel 并入 03；导航显示 5 开关独立成 02；实况预览移到主题卡底部
   - 新增 `.setting-list` / `.setting-item`；`.settings-grid` 改 `align-items: stretch`；窄窗 <1120px 单列
   - **零 `ncl.ui.*` 存储键变更**，用户现有主题/字体/侧栏状态不会重置

实测：`tsc` 通过、6 卡 `01–06` 齐全、卡内 9 个设置项、1280 与 150% 缩放横向溢出 0、`ultraContentW=1680`、`contrastFails=0`、`hoverRules=10`、`pageErrors=0`。

## 三、待办（按优先级）

### P0 — 等用户视觉验收
个性化页 6 张卡已改完但**用户还没看过实际窗口**。按项目规矩：验收通过前**不许构建 exe、不许替换 `release`**。

```bash
# 起 dev 窗口（先确认没有同名进程，见下）
cd D:/用户/CyberDeck-Launcher/src
cmd //C "set NO_PROXY=127.0.0.1,localhost&& node_modules\.bin\tauri.cmd dev"
```

### P1 — 通知降噪（方案已定稿，代码未动）
用户已确认方案，含两处取舍（任务级成功不弹 toast、CET/redscript 提示并入活动流）。要改的四处：

1. `src/App.tsx` `applyToggle`：删掉 `addTask("deploy"|"disable")` 与 4 类 toast（deploy done / CET / redscript / disable），保留 `setBusyId`；`linkSummary` 并入 `recordActivity` 的 detail
2. 新增 `src/lib/feedback.ts` 的 `createCoalescer(2000)`：2 秒窗口内同键合并，`flush(1)` 静默、`flush(n>1)` 弹一条汇总（走 `deploy` 类别，受设置页开关约束）
3. `ToastItem` 加 `sticky`，`toast()` 支持 `{ ttl, sticky }`：权限不足 / 跨盘硬链接失败 / 缺前置 / 冲突常驻不自动消失
4. 新增 `scripts/check-notify-noise.mjs` 并入 `gate.mjs`：连续开关 5 个模组 → toast ≤1、任务队列为空、活动流 ≥5、5 张卡片角标正确

**不要动** `api.setModEnabled` / `refresh()`，只删 UI 层调用；`recordActivity` 逐条记、不合并。

### P2 — 8 张特殊状态截图
`warning-strip` / `game-root-warning` / `update-lock` / `missing-prereq` / `danger-hold` / `import-review` / `task-center` / `log-extract` 仍是旧图。依赖 `src/lib/mock.ts` 未提供的后端状态（未链接游戏目录、版本变化熔断、缺前置、导入中、长按确认），需先扩 mock 再重拍——硬凑只能造假。

### P3 — 文档同步（需回 WorkBuddy 做）
`CHANGELOG.md` / `HANDOFF.md` / `docs/` 已在仓库内更新；同步到**项目网盘**与**资料库**要用 WorkBuddy 内置 MCP（CodeBuddy 没有），见 `.codebuddy/rules/cdl-guardrails.md` 第 4 条。资料库还压着 15 个旧节点（r31/r32 各一套）等用户决定是否移到「99-历史归档」。

## 四、验证命令（改完必跑）

```bash
cd D:/用户/CyberDeck-Launcher/src
export NO_PROXY=127.0.0.1,localhost

node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node scripts/check-commands.mjs
node scripts/check-i18n.mjs --fail
node node_modules/vite/bin/vite.js build
node scripts/gate.mjs            # 27 项，约 6-8 分钟
cargo test --manifest-path src-tauri/Cargo.toml
```

门禁自己起服务、自己分配端口（`GATE_PORT`），**不要同时跑两个实例**。

## 五、三个最容易浪费时间的坑

1. **dev 版秒退 = 单实例锁**，不是崩溃：`release\CyberDeck Launcher.exe` 开着就会把新实例踢掉，退出码 0、无日志。
2. **脚本里地址写 `localhost` 不写 `127.0.0.1`**：`vite preview` 绑 `[::1]`，写 IPv4 连不上，表现为 `networkidle` 超时、脚本零输出。
3. **`toast()` 第 4 参数缺省会绕过通知开关**：新增调用一律显式传类别，否则设置页关掉也会弹。

## 六、和 WorkBuddy 并行时的硬性限制

- 不能同时构建（`src-tauri/target` 共享，会抢锁/覆盖）
- 不能同时跑门禁（Playwright 抢端口，得到假失败）
- 无文件锁：改前 `git pull --rebase`，改完立刻 commit + push
- 建议分支隔离：CodeBuddy 用 `cb/xxx`，合回 `main` 前让我过一遍
