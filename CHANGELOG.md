# CHANGELOG — CyberDeck Launcher（原 NightCity Loader）

> 本文件记录每一次迭代的主要变更、时间与涉及模块，供快速回查。
> 项目自 2026-10-31 起已是 git 仓库并以 MIT 开源：https://github.com/XFxzz3456/CyberDeck-Launcher 。**本文件 + `HANDOFF.md` + `docs/` + git 历史共同构成版本追踪依据**，因此每次迭代收尾必须追加。

- 维护约定：新迭代**插入在「版本总览」之后的最前面**（最新的在上），不改历史条目；未构建/未部署的批次在标题里明确标注，构建发布后再去掉标注。
- 版本标记：`rN` 为构建批次号（同日多次重建时区分），沿用 `HANDOFF.md` 原有标号，未擅自重命名。
- ⚠️ 标号冲突（待裁决）：`0.7.0-r4`（21:45 界面/交互批次）与 `0.8.0-r4`（22:58 回归门禁 + NXM 批次）同为 `r4`，本文件按**实际时间顺序**排列，标号原样保留；建议后续统一改为「按日期递增的 build 号」。
- ✅ 版本号口径（2026-10-28 已执行）：`package.json` / `Cargo.toml` / `tauri.conf.json` 三处已统一升到 **0.8.0**。
- 事故复盘、架构决策与里程碑：统一归档在 `docs/PROJECT_HISTORY.md`，按锚点引用；本文件只留摘要与链接。
- 📁 **2026-10-31 文档合并**：20 份零散报告 / 设计草稿已提炼进 `docs/PROJECT_HISTORY.md`，原文删除（git 历史可回溯）。

### 0.9.0-r41（2026-10-31，待构建：标题栏拖动残影修复）

| 项 | 内容 |
|---|---|
| 修复 | **拖动标题栏出现跟着鼠标跑的花白残影**：同一次 `mousedown` 里有两条拖动通路各调一次 `plugin:window|start_dragging`——React 的 `onMouseDown`/`onPointerDown`（`beginWindowDrag`）与容器上的 `data-tauri-drag-region`（Tauri 注入的 `drag.js` 在 `document` 上监听）。第二次调用发生在第一次已开启的系统模态拖动循环内，两套位移叠加 + WebView2 拖动期间不重绘，表现为花白残影。 |
| 变更 | **整套 JS 拖动逻辑删除**：`src/lib/windowDrag.ts`（`beginWindowDrag` / `beginWindowPointerDrag` / `INTERACTIVE` 选择器）移除，`TitleBar` / `TopBar` 不再挂任何鼠标/指针事件，拖动与双击最大化全部交给 Tauri 原生路径。 |
| 变更 | 拖动区改用 `data-tauri-drag-region="deep"`（Tauri 2.12.5 起支持）：子树内任意元素被点中都能拖，`BUTTON/INPUT/SELECT/TEXTAREA/A/LABEL` 等可交互标签自动阻断。当年「点在文字 span 上拖不动」的补丁前提已不成立，一并删掉 `.titlebar-brand > * { pointer-events: none }` 的绕行规则。 |
| 新增 | 三档属性语义落地：`.titlebar` / `.topbar` = `deep`（整条可拖）；`.topbar-search` / `.profile-picker` / `.topbar-actions` / `.titlebar-controls` = `false`（点搜索框边缘要聚焦输入框、点档案选择器要展开下拉，不能被拖动吃掉）。 |
| 修复 | `.topbar` 缺 `user-select: none`：拖动时会把整片内容刷成文字选区，选区高亮在深色底上是一块白斑——残影的第二个来源。两条顶部栏统一关掉选区（`user-select` + `-webkit-user-select` + `cursor: default`），并给 `.topbar-search input` 显式开回 `user-select: text`，否则已输入的词无法拖选。 |
| 重写 | `scripts/check-window-drag.mjs` 契约整体换轨：旧脚本数的是 JS 发起的 `start_dragging` 次数，新实现下必须为 0。现在断言 12 项——静态（`windowDrag.ts` 已删、TSX 剥离注释后无 `startDragging`）、属性（`deep` × 2 + `false` × 4）、运行期（点拖动区不产生任何 invoke）、以及按 `tauri-2.12.5/src/window/scripts/drag.js` 的 `isDragRegion` 复算判定矩阵（文字可拖 / 输入框·下拉框·按钮不可拖）。 |
| 验证 | 12/12 PASS（`checks_failed=0`）· `tsc --noEmit` 通过 · 命令契约 131/131（missing=0）· i18n 缺口 0 / 死条目 0 · `gate.mjs` UI 脚本清单名称同步为「窗口拖动（data-tauri-drag-region 原生通路）」。 |

### 0.9.0-r40（2026-10-31，已构建：通知降噪 P1）

| 项 | 内容 |
|---|---|
| 变更 | **单次启用 / 禁用完全静默**：不再弹 toast、不再占任务中心一行。结果由三处承载——卡片角标即时翻转、活动流逐条留痕（含 CET / redscript 的「接下来注意什么」）、状态栏汇总。改因：连续开关 5 个模组原本会刷 5–9 条 toast + 5 行任务，把有用信息推进噪声里。 |
| 新增 | **2 秒合并窗口**（`src/lib/feedback.ts` 的 `createCoalescer`）：窗口内只有 1 次操作 → 完全静默；≥2 次 → 窗口结束时合并成一条「已切换 N 个模组 · 启用 x / 禁用 y」汇总，走 `deploy` 类别，仍受设置页通知开关约束。窗口从**最后一次操作**起算，所以一整串连点必然落在同一批，停下才说话。 |
| 新增 | **常驻（sticky）toast**：冲突、权限不足、跨盘降级、缺前置依赖、未挂游戏目录这五类必须用户动手，改为一律不自动消失（图钉图标 + 抬高底色），只能手动关。`toast()` 增加 `options: { ttl, sticky }`。 |
| 新增 | `scripts/check-notify-noise.mjs`（194 行，8 条断言）+ 接入 `scripts/gate.mjs` 的 UI 脚本清单：卡片就绪、单次静默、连串只留一条、汇总非常驻、任务中心 0 行、活动流逐条、角标同步。 |
| 修复 | `scripts/gate.mjs` 在 Windows 下 `node` 装在 `C:\Program Files\` 会被命令行按空格拆开（报 `'C:\Program' is not recognized`），改为命中含空格路径时自动补引号。 |
| 修复 | `scripts/check-deepseek.mjs` 仍按旧文案「界面显示管理」断言——r38 把它改名成「左侧导航栏」后这条断言必失，改为同时断言卡标题 + 卡说明。 |
| 清理 | 删除 5 条无引用词条（`appearance.groupLayout` / `groupLayoutHint` / `hiddenViewsLabel` / `title`、`settings.windowBehaviorTitle`，均为 r38 卡片化的残留）；`.vscode/` 加入 `.gitignore`。词表 1689 条、死条目 0。 |
| 验证 | `cargo test`（core-tests）101s 通过 · `tsc --noEmit` 通过 · `vite build` 通过 · 命令契约 131/131（missing=0）· i18n 缺口 0 / 死条目 0 · `check-notify-noise` 8/8 PASS · 合入门禁 `node scripts/gate.mjs --skip-ui` 全绿。 |

### 0.9.0-r39（2026-10-31，未构建：文档治理）

| 项 | 内容 |
|---|---|
| 新增 | **`docs/PROJECT_HISTORY.md`**（367 行）：把 20 份零散报告 / 草稿按**里程碑 / 事故复盘 / 架构决策**三条线重新提炼，每条带稳定锚点供跨文档引用 |
| 删除 | 20 份原文（`INCIDENT-*`、`UI-AUDIT-*`、`AUDIT-*`、`REPORT-*`、`DESIGN-ai-*`、`REAL-ENV-TEST-0.9.0`、`OLLAMA-LOCAL-MODEL`、`AI-LOCALIZATION-REVIEW`、`NIGHT_SHIFT_REPORT`、夜间批处理总结等，合计删除 3032 行）；git 历史可回溯 |
| 保留 | `docs/REAL-ENV-TEST.md` 是**活文档**（配套 `scripts/real-env-check.ps1`，README 有入口），不是报告，不在删除范围 |
| 修复 | 引用断链：`README.md` 1 处、`HANDOFF.md` 12 处、`CHANGELOG.md` 18 处、`docs/MEMORY-CANON.md` 3 处、`docs/ARCHITECTURE.md` 1 处、`src-tauri/src/{aifix,ailoc,safemode}.rs` 各 1 处，**合计 38 处**指向原文件的线索改为指向锚点（19 个锚点全部命中，死锚点 0） |
| 规则 | **任务分级 L1/L2/L3** 入 `~/.workbuddy/rules.md` 同源会话规则，并附「报告长度纪律」，防止再长出成堆长篇报告 |

---

### 0.9.0-r38（2026-10-31，未构建：个性化页卡片化）

| 项 | 内容 |
|---|---|
| 变更 | **个性化页从「一张大卡 + 四段虚线」拆成 6 张独立卡片**：01 主题与配色 / 02 左侧导航栏 / 03 窗口与侧边栏 / 04 字体与排版 / 05 背景图 / 06 动效与启动。01·04·05·06 满宽，02·03 半宽并排；窄窗（<1120px）自动落单列。改因：原结构把 12 个设置项混在一张卡里，只靠 `01–04` 编号和虚线分隔，是 10-30 治「坨在一起」的补丁式做法，没有真正分类。 |
| 变更 | **两处功能归位**：①「关闭窗口时（最小化到托盘 / 直接退出）」原本是卡片外的独立 `panel`，现并入「03 窗口与侧边栏」，与「收起侧边栏」同卡；②「导航显示管理」5 个开关从「界面元素」右列拆出，独立成「02 左侧导航栏」；③「实况预览 LIVE PREVIEW」从背景段移到主题卡底部——它预览的是配色，不是底图。 |
| 新增 | `.setting-list` / `.setting-item` 作用域样式：卡片内每个开关/字段自成一个圆角小块（`--panel-2` 底 + `--line-soft` 描边 + 10px 圆角），开关行改 `grid-template-columns: minmax(0,1fr) auto` 左对齐，替代原来 `space-between` 把文字顶到卡片两端的做法。`.settings-grid` 的 `align-items` 由 `start` 改 `stretch`，同排两卡等高、右侧不再留洞。 |
| 不变 | **零存储键变更**：`ncl.ui.*` 一个没动，用户现有主题 / 字体 / 缩放 / 侧栏状态不会重置；`settings.closeBehavior` 的读写路径原样保留（只换 UI 位置）。`SwitchRow` 组件本身未改，`CollectionWizard` / `NexusSettingsCard` / `GlossaryShareCard` 三处复用外观零变化。 |
| 验证 | `tsc --noEmit` 通过；`check-i18n --fail` 0 处、`check-commands` `missing=0`；实测 6 张卡、`01–06` 序号齐全、卡内 9 个设置项；1280 与 150% 缩放横向溢出均 **0**；1040 宽下单列（805px）、`ultraContentW=1680`、`contrastFails=0`、`hoverRules=10`、`pageErrors=0`。 |

---

### 0.9.0-r37（2026-10-31，未构建：纯前端样式与文档）

| 项 | 内容 |
|---|---|
| 修复 | **超宽屏无最大宽度**：`.page` 原本直接铺满 `.content`，2560×1440 下内容实测宽 **2300px**（一行塞 8 张卡片、正文行超百字），加 `max-width: 1680px` + `margin-inline: auto` 后收窄居中、两侧各留 310px；**1680 是「1920 屏不触发」的临界值**，1920 及以下零回归。**次要文字对比度不足**：`--muted-2` `#767a83` 在 `--bg #161617` 上实测 4.2:1、`.mod-meta` 硬编码 `#687483` 实测 3.8:1，均低于 WCAG AA 的 4.5:1，且都用在 8-10px 小字上；`--muted-2` 提到 `#82868f`（5.0:1）、`.mod-meta` 改走该变量，两套主题对比度失败项 **5 → 0**。**四类控件无按下反馈**：`.nav-item` / `.mod-card` / `.settings-tab` / `.nexus-tab` 只有 hover 没有 `:active`，点下去界面无任何变化，触屏易误判「没点上」而重复点击；补齐后 hover/active 规则覆盖 **6/10 → 10/10**。**中文说明字号过小**：`.switch-desc` 9.5→11px、`.platform-label` 9→11px、`.link-btn` 8.5→10.5px（按钮文字看不清是高成本错误） |
| 新增 | **UI 量化审查进 门禁**（`check-ui-audit.mjs`，九项断言：四档分辨率内容宽度 / 长文本溢出 / 80·125·150% 缩放 / 两套主题对比度 / 字号离群 / 表单对齐 / hover-active 规则 / 页面报错），门禁项数 26 → **27**，耗时约 31s；`make-readme-shots.mjs` 按 README 语义文件名批量出图；`docs/PROJECT_HISTORY.md#audit-ui-1031` 量化审查报告 |
| 变更 | **README 事实错误修正**：原文写「六套主题（含 Mono / Daylight）」——`mono` 在 r20 已删除（老配置迁到 `modern`）、`daylight` 更早下线，实际只有 **5 套**且仅 Modern 支持明暗；ARASAKA 那格贴的其实是 NCPD 的图；「原生 0.7.0」引用 0.7.0 时代截图已无意义。主题段落整段重写为五套（Modern 明暗各一张），删除 `mono.png` / `daylight.png`。**补齐从未写过的「存档管理」**：r30 新增的侧栏第六项，README 功能表与截图都没有，现补功能行 + 截图。**重拍 23 张截图**（原图全部是 10-22~25 的旧界面，未体现 T8 自定义字体、主题改版、存档管理页） |
| 修复（工具） | **审查脚本自身两处假阳性**：① 塌陷判定只查元素自身 `display`，把 `[data-vh-tight] .sidebar-storage { display:none }` 这类**有意的让位设计**的子元素全算成塌陷，每档缩放稳定报 2-11 个（改用 `checkVisibility` 后可识别祖先隐藏）；② `<option>` 本就不生成布局盒，被误判。修正后 `scaleBroken 3 → 0`——**缩放布局本来就没坏**，差点照着假阳性去改正常代码 |
| 验证 | 门禁 **27/27 全绿**（新增项 9 个断言全通过）；UI 实测 `viewports=4 · hScrollMax=0 · overflowTotal=0 · scaleBroken=0 · contrastFails=0 · alignSpread=0 · hoverRules=10 · pageErrors=0`；README 图片引用缺失 **0**；git 4 个提交已推送 `eeaae0f` |
| 边界 | 8 张特殊状态截图（`warning-strip` / `game-root-warning` / `update-lock` / `missing-prereq` / `danger-hold` / `import-review` / `task-center` / `log-extract`）**仍是旧图**——它们依赖 mock 未提供的后端状态（未链接游戏目录、版本变化熔断、缺前置、导入中、长按确认态），硬凑只能造假，已单独立项。装饰性小字（版本号 9.5px、`logo-sys` 7.5px、`kbd` 8.5px 等 27 处）保留原尺寸，属 HUD 风格视觉语言 |

---

### 0.9.0-r36（2026-10-31，**未构建**：仅版本控制与仓库对外发布）

| 项 | 内容 |
|---|---|
| 新增 | **GitHub 开源**：仓库 https://github.com/XFxzz3456/CyberDeck-Launcher （public，MIT，默认分支 `main`，tag `v0.9.0-r35`）；远端 309 个 blob 与本地 `git ls-files` 数量一致，远端 HEAD 与本地 `065a192` 哈希一致；仓库 topics 设为 `cyberpunk-2077 / mod-launcher / mod-manager / tauri / react / rust / typescript / windows` |
| 变更 | 提交身份由 `Arol <arol@localhost>` 改写为 `XFxzz3456 <mc2364694314@163.com>`（`git filter-branch --env-filter`，仅改作者/提交者，不改内容与日期），否则旧提交不计入账号贡献；本仓库局部配置 `http.proxy` / `https.proxy` = `http://127.0.0.1:7897`（本机 verge-mihomo） |
| 修复 | **README 破图**：主题表格里 NCPD 截图写成 `docs/screenshots/cpd.png`，实际文件为 `ncpd.png`（少一个 `n`），公开后首页会显示裂图；已改正，全量复检 README 引用图片缺失数 0 |
| 验证 | 公开前安全扫描：`git grep` 全历史匹配 `sk-真实值` / `ghp_` / 私钥头 / `AKIA` 均无命中；`src-tauri/src/secret.rs` 仅含单元测试假值 `sk-test-secret-value`；`tokens.css` 为 CSS 设计变量；无 `.env` / `.pem` / `.key` / `secrets/` 被跟踪。推送全程用一次性 `http.extraHeader` 携带凭据，`.git/config` 内 `ghp_` 残留数 **0**，`origin` URL 不含 token |
| 边界 | 该批次**未构建 exe、未替换 release**，前端与 Rust 代码零改动；公开仓库意味着全部源码与提交历史对任何人可读，需持续避免把本机路径之外的隐私与密钥写入仓库 |

---

### 0.9.0-r35（2026-10-31，已构建部署 + 便携版）

| 项 | 内容 |
|---|---|
| 修复 | **存档管理页滚不动**：`.page` 的 `overflow-y: auto` 是按页面类名逐个登记的（`loadorder-page` / `diagnostics-page` / `settings-page`），新增页面时漏了 `.saves-page`，整页被 `.content` 的 `overflow: hidden` 直接裁掉——不是滚不动，是压根没有滚动容器。已补进同一规则，并加 `scrollbar-gutter: stable` + `overscroll-behavior: contain`；**切页时文字横跳**：可滚页面有 9px 滚动条占位、`overflow:hidden` 的页面（模组库/设置）没有，切页内容宽度差 9px，观感是「文字横向飘一下」——`.page` 统一 `scrollbar-gutter: stable` 后各页内容宽度一致（实测差值 9 → 0）；**文本行盒比字号还矮**：`.page-head h1` `line-height: 0.98`（33px 字号配 32.34px 行盒）→ `1.14`，`.nav-label` / `.nav-en` 未设行高被祖先 `line-height: 1` 压成「行盒=字号」→ `1.35` / `1.3`，`.settings-tab` `1` → `1.35`，`.env-metrics strong` `1` → `1.15`，`.appearance-section-index` `1` → `1.2`，logo 两处 `1` → `1.12` / `1.15`。这类行盒裁切在中文满格字形上表现为上下沿被切一丝，换字体（T8）后更明显，观感即「文字在飘」 |
| 新增 | `scripts/check-layout-scroll.mjs`：1280×800 下遍历 5 个页面，断言「长内容必须真能滚」（写 `scrollTop` 后必须 >0，内部有可滚后代则豁免）、「所有承载文本的元素行高 ≥ 字号 ×1.1」（图标字/单字母徽标白名单）、「各页 `clientWidth` 一致」；`check-window-drag.mjs` 正式进 `gate.mjs`（成功时也输出 `checks_failed=0`，否则门禁按 key=value 判成缺失） |
| 验证 | UI 门禁 **26/26 全绿**（`GATE_PORT=1427`，新增「页面滚动与文本行高」「窗口拖动」两项）；布局回归实测 `pages=5 · stuck=0 · tightText=0 · widthSpread=0 · savesCanScroll=1`；`cargo test` / `tsc` / `vite build` / i18n 全绿 |
| 产物 | exe 9,115,136 B / md5 `88c8605d4f80710c001f7a540a74e650`，已替换 `release`（r34 备份为 `CyberDeck Launcher.prev.exe`），冒烟 `stage=frontend mods=195`、`integrity=0x2000`（非提权）；便携版 `发布产物\CyberDeck Launcher 0.9.0 便携版-r35.zip`（4,173,061 B），解压实测 `data_dir` 指向解压目录（便携生效）、`stage=frontend mods=195` |
| 边界 | 自动化只能证明「页面能滚、行盒不裁字、各页宽度一致」；**「某个具体控件的文字位置偏了」这类主观观感无法靠脚本判定**——已用 1600×1050 / 1280×800 两种尺寸逐页截图核对（模组库/发现/加载顺序/运行诊断/存档管理/设置/下载中心），未发现残留错位，若仍有需指认具体页面与文字 |

---

### 0.9.0-r34（2026-10-31，已构建部署 + 便携版）

| 项 | 内容 |
|---|---|
| 新增 | **T5 AI 汉化落地**（`ailoc.rs`：扫描 onscreens/扁平本地化 JSON → 作者意愿三态判定 → 词表优先、未命中走真实 AI（`ai::translate_locale_strings`，与名称翻译分开，不剥标点）→ 生成 WolvenKit 格式 JSON + ArchiveXL 覆盖层 → WolvenKit 打包 `.archive` → 部署并登记 `ai_loc` 清单 → 一键撤销；右键菜单「AI 汉化…」+ 确认弹窗 8 项状态分支）；**T6 AI 补丁落地**（`aifix.rs`：脚本片段外发前告知字符数 → AI 生成独立 `AIFix_*.reds` → G1 结构校验（模块名/注解/括号配平/危险 API 黑名单）→ 确认后写入 `r6/scripts/cyberdeck-ai-fix/` → 单独撤销）；`ai_tools_tests.rs` 新增 8 条确定性用例 |
| 变更 | UI 门禁脚本统一跟随 `GATE_PORT`（35 个脚本 / 47 处硬编码 1420 地址），独立端口跑门禁不再全红；弹窗加 `max-width: calc(100vw - 48px)`、右键菜单加 `max-height + overflow`；侧栏断言更新为 5 项（新增「存档管理」）；便携版包名去掉「可直接发人」后缀，统一 `CyberDeck Launcher 0.9.0 便携版-r34.zip` |
| 修复 | **取消部署后无法重新部署**：`installer.rs` 新增 `recover_staging()`，暂存断链时按原部署清单从游戏侧文件重建副本（校验归属 + 大小 + 修改时间，只 copy 不硬链），`undeploy_mod` 在清空清单**之前**先恢复，`deploy_mod` 的回滚基准改为恢复之后的条目；数据被外部改过时返回 `STAGING_RECOVERY_CHANGED` 拒绝恢复；**触屏/手写笔无法拖动顶部栏**：`windowDrag.ts` 增加 Pointer Events 通路（`pointerType==="mouse"` 不走、`preventDefault` 阻断兼容鼠标事件、交互控件排除），`.titlebar/.topbar` 加 `touch-action: none`；`aifix` 路径 id 净化（防状态文件被改成 `..` 越界）；AI 汉化撤销同时比对大小与修改时间 |
| 验证 | `src-tauri` + `core-tests` 全量 cargo test **177 passed / 2 ignored**（新增 `ai_tools_tests` 8 条、`broken_staging_*` 3 条）；`tsc --noEmit` 通过；i18n 0 处硬编码 / 0 条死词条；UI 门禁 **24/24 全绿**（`GATE_PORT=1425`）；部署后冒烟 `stage=frontend mods=195`、`integrity=0x2000`（非提权）；便携版解压实测：自带 `cyberdeck-data`、启动 `stage=frontend` |
| 产物 | exe 9,115,136 B / md5 `96aeb0e90c1c28b124fae5d40eb7f4ff`，已替换 `release`（r33 备份 `CyberDeck Launcher.prev.exe`）；便携版 `发布产物\CyberDeck Launcher 0.9.0 便携版-r34.zip`（4,172,810 B，父文件夹 + exe + WebView2Loader.dll + 空数据目录 + 使用说明） |
| 边界 | ① AI 汉化**必须**有 WolvenKit CLI 才能打包部署，缺失时只生成到 `staging/ai-loc/<id>/` 并返回 `AI_LOC_WOLVENKIT_REQUIRED`，不产出装上也无效的文件；② 硬编码在 `.archive`/`.inkwidget`/`.csv` 的文本不支持，`.reds` 文本硬编码走 blocked 原因码；③ AI 补丁只有结构校验，**未接编译校验**（报告 `compiled:false` 并提示看 REDscript 日志）；④ 便携版首启若本机已有 `%APPDATA%\com.arol.cyberdeck` 状态，会按既有数据目录策略迁移进来（避免"密钥消失"），换机器则从空库开始 |

---

### 0.9.0-r33（2026-10-30，已构建部署）

| 项 | 内容 |
|---|---|
| 新增 | 依赖检查系统（`deps.rs` 规则库 + 诊断「依赖检查」面板 + 缺依赖徽标/启用拦截/忽略表）；汉化包挂载（`is_translation`/`parent_mod_id` + 绑定弹窗 + 级联启用/禁用/卸载 + 父子冲突豁免）；模组库「卡片 ⇄ 列表」视图切换（列表同样虚拟滚动，偏好落盘）；游戏进程联动（运行检测 5s 轮询 + 顶栏红色「关闭游戏」） |
| 变更 | CET 探测三候选（dll → init.lua → 目录兜底）+ 两档大小写匹配（原样 → squash）；标题栏最大化时显示向下还原图标（onResized + 120ms 防抖）；侧栏/顶栏导入按钮统一改名「导入压缩包」，库工具栏下拉改「更多导入方式」；版本号社区化映射（3.0.80.51928 → 2.5，原始号进 tooltip）；收编完成后立即刷新诊断 |
| 修复 | 顶部重复游戏胶囊删除；DPAPI 硬编码文案词条化；`core-tests` 未注册新模块导致的 cargo test E0432；4 条死词条清理 |
| 验证 | src-tauri cargo test 136 passed；core-tests 161+1 passed（真实 195 条状态解析回归通过）；tsc + vite build + i18n（0/0）+ gate 23/23（新增 check-library-view.mjs 11 项） |
| 边界 | `r6/scripts` 空目录仍会误判 redscript 已装（漏判代价更高，见 r33 段取舍）；列表行高固定 56px，改行高必须同步 `VirtualModGrid.LIST_ROW_HEIGHT` |

---

## 发布记录

- **2026-10-31 13:28（0.9.0-r35，已构建部署 + 便携版）**：存档管理页滚动容器补齐（`.saves-page` 漏登记 `overflow-y:auto`）+ `.page` 统一 `scrollbar-gutter: stable`（切页宽度差 9px → 0）+ 9 处行高小于字号导致的文字上下裁切（h1 0.98、nav 标签、设置 Tab、诊断数值、个性化序号、logo 两处）。新增门禁 `check-layout-scroll.mjs`（5 页遍历 / stuck / tightText / widthSpread / savesCanScroll），`check-window-drag.mjs` 正式进 gate。exe 9,115,136 B / md5 `88c8605d4f80710c001f7a540a74e650`，替换 release（r34 备份 `.prev.exe`），冒烟 `stage=frontend mods=195`、integrity=0x2000。门禁 26/26（`GATE_PORT=1427`）。便携版 `发布产物\CyberDeck Launcher 0.9.0 便携版-r35.zip`（4,173,061 B，无后缀），解压实测 `data_dir` 落在解压目录、`stage=frontend mods=195`。
- **2026-10-31 01:38（0.9.0-r34，已构建部署 + 便携版）**：暂存恢复（取消部署后可再部署）+ 触屏拖动 + T5 AI 汉化 + T6 AI 补丁 + UI 门禁端口统一。exe 9,115,136 B / md5 `96aeb0e90c1c28b124fae5d40eb7f4ff`，替换 release（r33 备份 `.prev.exe`），冒烟 `stage=frontend mods=195`、integrity=0x2000。门禁 24/24（cargo 177 + tsc + vite + UI 脚本全绿）。便携版 `发布产物\CyberDeck Launcher 0.9.0 便携版-r34.zip`（4,172,810 B，包名去掉「可直接发人」后缀），解压实测通过。
- **2026-10-30 22:45（0.9.0-r33，已构建部署）**：两份实测 bug 报告（55c158 / bf7889）全量修复 + 27 号遗留 T3 依赖检查、T4 汉化挂载收尾（详见下方 r33 段）。exe 8,897,536 B / md5 `ee28ffa27d21273401b97312de1a08b7`，替换 release（r32 备份 `.prev.exe`），冒烟 `stage=frontend mods=195`、integrity=0x2000（非提权）。门禁全绿（cargo 136 + core-tests 161+1 + tsc + vite + 23 个 UI 脚本，新增 `check-library-view.mjs`）。未打包便携版（按惯例等确认）。
- **2026-10-30 02:30（0.9.0-r28 + r29 + r30，已构建部署 + 便携版重制）**：自定义背景图（r28）+ modlist 工具与批量操作（r29）+ deepseek 四模块（r30）一并构建。exe 8,848,896 B / md5 `FEFDA28F258853A481EEDCED0F0012C6`，替换 release（r27 备份 `.prev.exe`），门禁全绿（cargo 126 tests + tsc + vite + 21 个 UI 脚本）。便携版 `发布产物\CyberDeck Launcher 0.9.0 便携版-r30重制-可直接发人.zip`（4,196,942 B，带父文件夹 + 自带 cyberdeck-data + r30 版使用说明），解压实测 + 冒烟 `stage=frontend mods=195`、integrity=0x2000。旧 `CyberDeck Launcher 0.9.0 便携版.zip`（根目录 + 发布产物两处）已删除。任务文件 `deepseek_markdown_20261029_97d09a.md` 已归档至 `WorkBuddy会话\任务\_已完成归档\`。
- **2026-10-30 00:40（0.9.0-r26 + r27，已构建部署）**：模组库工具栏左右分区重构（r26）+ Modern 主题明暗色板重校（r27）一并构建。exe 8,754,176 B / md5 `51689FA5F09172610774FE2D9B2B9DB3`，替换 release（r24/r25 备份 `.prev.exe`），冒烟 `stage=frontend mods=195`（非提权）。
- **2026-10-29 23:47（0.9.0-r24 + r25，已构建部署）**：AI 模型预设两级化（r24）+ 侧栏纵向收口（r25）一并构建。exe 8,753,664 B / md5 `95C99B3E9CC52C783D4C00AD230EE626`，替换 release（r23 备份 `.prev.exe`），冒烟 `stage=frontend mods=195`、`integrity=0x2000`（非提权）。
- **2026-10-29 22:20（0.9.0-r23，已构建部署）**：侧边栏重构 + 帮助中心迁入设置 + 设置页间距 + 分类引擎重写（详见下方 r23 段）。exe 8,751,104 B / md5 `543cf70867bf163d05b2b1cfe3861fdc`（**零编译警告**），NSIS 安装包 3,335,988 B；部署 release（r22 备份 `.prev.exe`），冒烟 `stage=frontend mods=195`、integrity=0x2000（**非提权启动**）。分类引擎在真实 195 个模组上校准后，「工具」从 168 降到 0。
- **2026-10-29 02:21（0.9.0 正式发布）**：版本号三处统一升至 **0.9.0**，完成看板【7】~【14】八项任务（AI 汉化词表共享 / AI 深度汉化架构评审 / 启动动画 / 帮助中心 / 配置导入导出 / Safe Mode + 过期扫描 / 真机验收 / Ollama 本地模型）。`tauri build` 构建正式包 —— exe 8,736,768 B / md5 `6e498e3dce314a9fcc3602ac088589cd`（r22 批次，**零警告**），NSIS 安装包 `CyberDeck Launcher_0.9.0_x64-setup.exe` 3,332,269 B，便携版 `CyberDeck Launcher 0.9.0 便携版.zip` 4,148,716 B（带父文件夹 + 自带 `cyberdeck-data`）。部署至 release 目录（r21 备份为 `CyberDeck Launcher.prev.exe`），冒烟 `stage=frontend mods=195`、integrity=0x2000。
  - ⚠️ 发布前抓到并修掉一个 P0：`config_export`/`config_import`/`safemode_state`/`safemode_enter`/`safemode_exit`/`compat_scan` **6 个命令只定义未进 `generate_handler!`**，编译通过、冒烟正常，但前端 invoke 会报 command not found（Safe Mode / 配置导入导出 / 过期扫描三项功能实际不可用）。线索是编译器 `never used` 警告。已加门禁 `scripts/check-commands.mjs`（定义 / 注册 / 调用三处对齐，102/102）。复盘见 `docs/PROJECT_HISTORY.md#incident-command-not-registered`。
- **2026-10-28 02:08（r13 正式发布）**：版本号三处统一升至 **0.8.0**，`tauri build --no-bundle` 构建正式包（8,515,584 B，md5 `de41338e022bc66bc3ba34c950fd5b53`），部署至 release 目录（旧版备份 `CyberDeck Launcher.prev.exe`），启动验证 `stage=frontend mods=195`、integrity=0x2000；便携版 `CyberDeck Launcher 0.8.0 便携版-可直接发人.zip`（4,045,477 B，带父文件夹结构，内含 `使用说明.txt` 更新版+便携模式说明），解压实测通过后交付。内容 = r10–r13 全部（UI 文案整改 + 通知分类门 + 下载中心 + 四模块静态审查）。

## 版本总览

| 时间 | 标记 | 主题 | 主要模块 |
|---|---|---|---|
| ≤2026-10-24 | 0.7.0 | 基线功能全部落地 | 库/导入/部署/冲突/排序/主题/诊断/Nexus/AI/播放集 |
| 2026-10-25 | 0.7.1 | UI 审计 13 条 + Nexus 差距 7 项 | 前端全视图、nexus.rs、schema.rs |
| 2026-10-26 01:30–06:11 | 0.7.0-r2 | 跳转/数据目录/完整性事故修复 | lib.rs、store.rs、build.rs、Cargo.toml |
| 2026-10-25 22:00 → 10-26 06:33 | 0.8.0-r1 | 品牌更名 + 主题解耦 + 设置 Tabs + Nexus Collections | 全仓改名、theme.ts、collection.rs、SettingsTabs |
| 2026-10-26 06:45–07:40 | 0.8.0-r2 | 状态文件被误判损坏（丢 195 条索引）修复 | schema.rs、collection.rs、core-tests |
| 2026-10-26 12:25–12:35 | 0.7.0-r3 | 单实例 / 托盘 / 关闭到托盘 / 退出确认 / 便携版 | lib.rs、main.rs、SettingsView |
| 2026-10-26 20:00–21:04 | 0.8.0-r3 | 绕过官方启动器直启游戏 | game.rs、game_tests.rs、SettingsView |
| 2026-10-26 21:45–22:20 | 0.7.0-r4 | 浮层重叠 / 暂存区可迁移 / 自动查找 / 设置分类 | styles.css、App.tsx、store.rs、SettingsView |
| 2026-10-26 22:58–23:49 | 0.8.0-r4 | 回归门禁 + 脏数据白屏 + NXM 协议接管（**已构建，2026-10-27 00:01 部署**） | gate.mjs、normalize.ts、AppErrorBoundary、nxm.rs、selfcheck.rs、NxmIntake、NexusSettingsCard |
| 2026-10-27 00:00–00:25 | 0.8.0-r5 | 「现代通用」主题预览图重做 + 预览框圆角统一 | theme.ts、AppearanceSettings.tsx、styles.css、make-modern-thumb.mjs |
| 2026-10-27 20:36–21:05 | 0.8.0-r6 | AI 接入去服务商化（文案/徽标/默认值/预设回填） | aiPresets.ts、AiSettingsCard.tsx、AiDiagnosisPanel.tsx、LogViewerDialog.tsx、schema.rs、lib.rs、check-ai-config.mjs |
| 2026-10-27 20:45–20:58 | 0.8.0-r7 | 全局 UI 文案去 AI 味（**仅前端，未 tauri build / 未部署 exe**） | src 全量 .tsx/.ts（24 个文件 105 处字符串） |
| 2026-10-27 21:06–21:15 | 0.8.0-r8 | i18n 预留架构（词表 + `t()` 占位 + 守卫脚本，**未实现语言切换；未 tauri build / 未部署**） | src/i18n/*、scripts/check-i18n.mjs、8 个组件、docs/I18N.md |
| 2026-10-27 21:55–22:20 | 0.8.0-r9 | i18n 全量迁移收尾（1207→0）+ 品牌残留修复（modlist 标记兼容 + User-Agent + 测试 crate 改名） | src 全量、src-tauri/loadorder.rs、backup.rs、diagnostics.rs、lib.rs、ai.rs、core-tests、scripts/* |
| 2026-10-27 23:00–23:55 | 0.8.0-r10 | UI 文案规范整改（四条禁令 + 七场景，66 条，**仅前端文案，未 tauri build**） | src/i18n/zh-CN.ts、21 个组件、README/ARCHITECTURE、ui-polish-test.mjs |
| 2026-10-28 00:30–01:40 | 0.8.0-r12 | 通知分类门（四类可关 + system 直达 + 设置页通知分区） | src/lib/notify.ts、App.tsx、SettingsView/SettingsTabs/ui、zh-CN.ts |
| 2026-10-28 00:45–01:55 | 0.8.0-r13 | 下载中心（队列/暂停续传/429 重试/免 Key 通道/设置卡/侧栏角标）+ 静态审查四模块 | src-tauri/download_queue.rs、lib.rs、nexus.rs、ai.rs、DownloadsView、api/mock/types、Sidebar、zh-CN.ts、main.tsx、dependencies.ts |
| 2026-10-28 20:35–21:05 | 0.8.0-r14 | EULA 协议门渲染架构重构（毛玻璃遮罩盖底、不再白屏）+ 浅色视觉细节 | App.tsx、EulaDialog.tsx、styles.css、zh-CN.ts、ui-test.mjs、check-eula-gate.mjs |
| 2026-10-28 深夜 | 0.8.0-r15 | ① 浅色主题对比度修复（accent-text 令牌 + 自定义强调色 WCAG 钳制）② Mod 设置收进详情抽屉 + 后端多框架配置解析 ③ framer-motion 动效试点（已随 r18 构建发布） | styles/tokens.css、styles.css、preferences.ts、config_resolver.rs、modsettings.rs、lib.rs、ModSettingsPanel.tsx（新）、ModDetailDrawer、Sidebar、CommandPalette、ModSettingsView（删）、SettingsTabs、ModCard、motion.ts（新）、check-contrast.mjs / check-motion.mjs（新） |
| 2026-10-28 21:12–22:10 | 0.8.0-r16 | 目录规范化（`src` / `release`）+ 版本号动态化（去 i18n 硬编码）+ **门禁 EULA 回归修复**（7/12→复跑）（已随 r18 构建发布） | vite.config.ts、lib/appVersion.ts（新）、global.d.ts（新）、Sidebar、SettingsView、i18n/zh-CN.ts、scripts/check-*.mjs（9 个）、AGENTS.md（新）、HANDOFF、README |
| 2026-10-28 22:47–23:05 | 0.8.0-r17 | 旧品牌残留全清（`origin` 值 / 临时文件前缀 / 旧 modlist 表头兼容层一起删）+ 暂存目录失效后不再就地重建旧目录树（已随 r18 构建发布） | schema.rs、ai.rs、collection.rs、config_resolver.rs、installer.rs、loadorder.rs、modsettings.rs、wolvenkit.rs、store.rs、types.ts、mock.ts、check-legacy-state.mjs、real-env-check.ps1、AGENTS.md、HANDOFF |
| 2026-10-28 23:05–23:50 | 0.8.0-r18 | ① 窗口缩放布局修复（侧栏底部沉底 + 内容区自适应）② Modern 浅色对比度收尾 ③ Tabs 响应式（**随 r14–r18 一并构建并部署，便携版同步发布**） | styles.css、Sidebar.tsx、VirtualModGrid.tsx、check-layout.mjs（新）、docs/PORTABLE-README-0.8.0.txt（新） |
| 2026-10-28 23:55 → 10-29 00:10 | 0.8.0-r19 | 动效推广收尾：抽屉滑入/退场 + 弹窗弹入 + 路由切换 AnimatePresence（已构建部署） | motion.ts、ModDetailDrawer.tsx、ui.tsx（Modal/ModalShell）、App.tsx、styles.css、check-motion.mjs |
| 2026-10-29 00:20 → 01:00 | 0.8.0-r20 | 发版前验收批：①下载中心重排为任务列表页（设置项迁到设置页）②分类引擎增强 + 智能归类按钮 ③CD 图标全套重制 + 窗口标题缩短 ④Logo 纯文字化 / 删 Mono 主题 / 缩放 80–150% 滑块 / 超时输入框排版 / 侧栏溢出（**已构建，2026-10-29 00:55 部署**） | DownloadsView（重写）、SettingsView、installer.rs、lib.rs、theme.ts、preferences.ts、Sidebar、AppearanceSettings、LibraryView、styles.css、icons/*（全套重制）、api/mock/zh-CN、ui-theme-test.mjs |

| 2026-10-29 01:00 → 01:30 | 0.8.0-r21 | AI 配置支持 Anthropic 原生协议：①「接口协议」下拉框（OpenAI 兼容 / Anthropic 原生）+ 持久化 api_protocol ② Rust 双协议请求分发（x-api-key + anthropic-version + max_tokens + system 提权 + messages 净化）③ 401/429 友好映射 + 中转站灰字提示（**已构建，2026-10-29 01:28 部署**） | schema.rs、lib.rs、ai.rs、types.ts、normalize.ts、mock.ts、api.ts、aiPresets.ts、AiSettingsCard、AiDiagnosisPanel、zh-CN.ts、check-ai-config.mjs |

| 2026-10-29 01:35 → 02:15 | 0.9.0-r22 | 0.9.0 版本冲刺（看板【7】~【14】）：AI 汉化词表本地库 + 云端共享、AI 深度汉化架构评审、启动动画、内置帮助中心、全局配置导入导出、2.5 灾后重建 Safe Mode + 过期插件扫描、真机验收脚本与清单、Ollama 本地模型接入指引（**已构建，2026-10-29 02:11 部署**） | glossary.rs（新）、config_pack.rs（新）、safemode.rs（新）、compat.rs（新）、lib.rs、ai.rs、HelpCenterView（新）、SplashScreen（新）、GlossaryShareCard（新）、ConfigPackCard（新）、SafeModeCard（新）、CompatBadge（新）、apiGlossary/apiConfigPack/apiSafety（新）、zh-CN.ts、check-help.mjs（新）、check-safemode.mjs（新）、real-env-check.ps1 |
| 2026-10-29 20:10 → 22:00 | 0.9.0-r23 | 侧边栏导航层级重构（主操作区 + 辅助区 Flex 沉底）+ 帮助中心迁入设置 + 设置页间距 + Mod 分类引擎重写（内容证据优先，修 168 个「工具」）+ 手动改分类（右键）+ 顶栏版本号动态化（**已构建部署**） | Sidebar、styles.css、category.rs（新）、installer.rs、schema.rs、lib.rs、SettingsTabs/SettingsView、HelpCenterView、ModContextMenu、LibraryView、TitleBar、check-sidebar.mjs（新）、check-category.mjs（新） |
| 2026-10-29 22:55 → 23:10 | 0.9.0-r24 | AI 模型预设扩充为「厂商 → 模型」两级 + 三分区（国外/国内/本地部署），14 家厂商 38 个模型；反查改为按接口地址认厂商（旧模型名不再退回「手动配置…」）（**已随 23:47 构建部署**） | aiPresets.ts、AiSettingsCard.tsx、AiDiagnosisPanel.tsx、zh-CN.ts、check-ai-presets.mjs（新）、check-ai-config.mjs、gate.mjs |
| 2026-10-29 23:10 → 23:25 | 0.9.0-r25 | 侧栏三段式 Flex 收口 + 滚动条可见化 + 折叠过渡 + 纵向档位（按「窗口高 ÷ 缩放」算，修 90%/110% 下菜单被挤成三项）（**已随 23:47 构建部署**） | styles.css、Sidebar.tsx、lib/viewportTier.ts（新）、App.tsx、check-sidebar.mjs |
| 2026-10-30 00:16 → 00:40 | 0.9.0-r26 | 模组库工具栏左右分区重构：左侧视图过滤（结果数/智能归类/排序）+ 右侧操作区（导入收拢为下拉菜单 / 检查更新 / 补全信息 / 翻译名称），重要操作强调样式；check-layout.mjs 期望值对齐 r25 档位 + 修 127.0.0.1 老坑（**已随 00:40 构建部署**） | LibraryView.tsx、styles.css、zh-CN.ts、check-layout.mjs |
| 2026-10-30 00:40 → 00:55 | 0.9.0-r27 | Modern 主题明暗色板重校：暗色对齐 VS Code 五级表面（bg→bg-2→panel→panel-2→panel-3 相邻级拉开 4-6 步亮度），亮色对齐 Linear（白卡+阴影从灰侧栏浮起）；对比度门禁 26/26（**已随 00:40 构建部署**） | styles.css、check-contrast.mjs（修 127.0.0.1 地址） |
| 2026-10-30 01:00 → 01:40 | 0.9.0-r28 | 自定义背景图（看板【皮肤 UI 优化】P0 子项）：设置只存路径、后端读图校验（类型/20MiB 上限）转 data URL；个性化页加不透明度+模糊双滑杆实时预览与一键恢复；背景层 z-index:-1 + 启用时壳/侧栏半透明；设置保存改合并队列（滑杆连拖不刷爆状态文件）；新增 check-background.mjs 13 项 + base64 单测 3 项 | schema.rs、lib.rs、types.ts、api.ts、mock.ts、normalize.ts、App.tsx、SettingsView.tsx、AppearanceSettings.tsx、styles.css、zh-CN.ts、check-background.mjs（新）、gate.mjs |
| 2026-10-30 01:40 → 02:20 | 0.9.0-r29 | mod 列表及切换功能收尾（看板）：modlist 导入导出（导出 JSON 带 kind/version 签名 + 模组元数据快照；导入按 id 优先名字兜底对回库，unmatched 如实报告）+ 批量启用/禁用（多选模式 + 批量条，后端逐个走部署/撤除语义、单个失败不中断）；新增 check-modlist-tools.mjs 9 项 + safe_filename 单测（**未构建部署**） | profiles.rs、lib.rs、types.ts、api.ts、mock.ts、SettingsView.tsx、LibraryView.tsx、VirtualModGrid.tsx、ModCard.tsx、styles.css、zh-CN.ts、check-modlist-tools.mjs（新）、gate.mjs |
| 2026-10-30 02:20 → 03:30 | 0.9.0-r30 | deepseek 任务四模块：①路径/部署方式/启动高级选项（暂存区磁盘建议、部署方式 hardlink/symlink/copy、显卡偏好注册表、进程优先级 creation_flags、启动前置命令）②下载中心升级（令牌桶限速、NXM 协议修复、.nxm 拖拽投递、速度折线图、拖拽接收区）③外部工具链管理器（登记/启动/固定到侧栏）④界面显示管理（侧栏入口隐藏 + 持久化 + 隐藏页跳回模组库）；新增 nxm_intake/nxm_intake_file/suggest_staging_dir/external_tool_* 共 9 个命令；check-deepseek.mjs 21 项（**未构建部署，随本次版本一并打包**） | schema.rs、lib.rs、installer.rs、game.rs、environment.rs、download_queue.rs、types.ts、normalize.ts、api.ts、mock.ts、SettingsView、ExternalToolsCard（新）、AppearanceSettings、Sidebar、uiPrefs.ts（新）、App.tsx、DownloadsView、styles.css、zh-CN.ts、check-deepseek.mjs（新）、check-platform.mjs、gate.mjs |
| 2026-10-30 20:30 → 21:05 | 0.9.0-r31 | 合规自检 P1 两项修复（用户确认后执行）：①下载 429 限流等待期点暂停/取消被下一圈清旗标吞掉 → 改为就地收尾 `settle_interrupted` 并 return；②混合包（.archive + .reds/.lua）被判单布局后异类文件静默丢弃 → 新增 `layout_skipped` 统计，导入与部署两处都出 warning（列前 3 个文件名 + 建议拆包）；新增 6 个单测；自检报告 `docs/PROJECT_HISTORY.md#audit-7modules` 已标修复状态（**未构建部署**） | download_queue.rs、installer.rs、docs/PROJECT_HISTORY.md#audit-7modules |
| 2026-10-30 21:05 → 21:45 | 0.9.0-r32 | 实测反馈四项：①框架探测 P0（redscript 改认 `r6/scripts` 目录或 `engine/tools/redscript-cli.exe`；Mod Settings 改认 `red4ext/plugins/mod_settings/ModSettings.dll`，CET 版 `mods/ModSettings/init.lua` 兜底；新增 `resolve_ci` 逐级大小写不敏感解析，7 个单测）②顶栏版本号 `CDL vv0.9.0` → `CDL v0.9.0`（词条去掉写死的 v）③账户占位头像改 flex 居中 + `line-height:1` 消除基线偏移，新增 `nexusBus` 广播让侧栏「发现」未连接角标随连接/断开即时刷新 ④诊断结论卡重构为圆角卡片（48px 警告图标 / 两行文案 / 19px 统计数字，ISSUES 用警告色，窄屏自适应）；新增 check-feedback-fixes.mjs 22 项（**未构建部署**） | game.rs、zh-CN.ts、styles.css、DiagnosticsView.tsx、NexusSettingsCard.tsx、NexusView.tsx、App.tsx、lib/nexusBus.ts（新）、mock.ts、check-feedback-fixes.mjs（新）、gate.mjs |

---

## 0.9.0-r32 — 实测反馈四项：框架探测 / 版本号 / 头像与状态同步 / 诊断横幅（2026-10-30 21:05 → 21:45，未构建部署）

### 一、问题

1. **框架探测误报 MISSING（P0）**：本地已装 redscript 与 Mod Settings，诊断页仍显示 `MISSING`。
   - redscript 旧判据只有 `engine/tools/redscript-cli.exe` 一条路。真实安装里 cli 常常不在（分发版本不同、Vortex 装的只落 `.reds` 标准库），玩家装好了也被判没装。
   - Mod Settings 旧判据只有 `bin/x64/plugins/cyber_engine_tweaks/mods/ModSettings` 这个**目录**。新版 Mod Settings 走 RED4ext，核心文件是 `red4ext/plugins/mod_settings/ModSettings.dll`，路径完全对不上；而且只看文件夹名，空目录也算装。
2. **顶栏版本号多一个 v（P1）**：显示 `CDL vv0.9.0`。`appVersion.format()` 统一补 `v`，而词条 `titleBar.build` 又写死了 `CDL v{version}`，两处重复。
3. **账户占位头像歪（P1）**：`.integration-avatar` 用 `display:grid + place-items:center`，等宽字体的 ascent/descent 不对称，字母靠 line box 居中会偏上 1–2px。
4. **状态不同步（P1）**：侧栏「发现」的未连接角标只在 `[view, snapshot?.demoMode]` 变化时刷新。在设置页里连接账号后 view 没变，角标继续亮着——就是用户说的「明明关联了却一直显示」。
5. **诊断结论横幅难看（P2）**：条纹底 + 大字一句话 + 带竖线的迷你表格，窄屏挤成一坨。

### 二、改动

- **`game.rs` 框架探测重写**：新增 `resolve_ci(root, segments)` 逐级解析（先试原样，未命中就 `read_dir` 做 `eq_ignore_ascii_case` 比对）+ `locate(root, candidates)` 多候选按序命中；`status()` 改收候选列表，命中路径回显，未命中回显首选路径供用户核对。redscript 候选 = `engine/tools/redscript-cli.exe` → `r6/scripts`；Mod Settings 候选 = `red4ext/plugins/mod_settings/ModSettings.dll` → CET `mods/ModSettings/init.lua` → 同名目录兜底。文件不是普通文件时跳过 `file_version` 的 Win32 调用。
- **版本号**：`titleBar.build` 改 `"CDL {version}"`；`appVersion.ts` 仍是唯一补 `v` 的地方。顺手给诊断页两处 `v{...}` 换成 `withV()`，避免同类重复。
- **头像**：`.integration-avatar` / `.nexus-account-icon` 改 flex 居中 + `line-height:1` + `padding:0`，svg `display:block`；图标块补 `flex: 0 0 <size>` 防挤压。
- **状态同步**：新增 `src/lib/nexusBus.ts`（window 事件 + source 去重），`NexusSettingsCard` / `NexusView` / `App.tsx` 三处订阅；连接与断开成功后各自广播。App 侧订阅直接修掉侧栏角标不刷新的问题。
- **诊断结论卡**：结构改为「48px 圆角图标块 + 主标题（`发现 N 个警告` / `一切正常，可以启动`）+ 后端一句话副标题 + 极简统计」，统计三格数字 19px 加粗、标签 8px mono，ISSUES 非零时套 `is-warning` 走警告色；容器改 `var(--panel)` + `color-mix` 混色（浅色主题不会发灰），`border-radius: 12px`，760px 以下统计换行到第二行并加上边线。
- **mock**：诊断 `summaryLevel` 补 warning 分支（之前只有 error/ok，明明有 warning 还说「环境状态良好」）；`clearNexusKey` 记住断开标记、`setNexusKey` 清除，让跨页状态可测；redscript / Mod Settings 演示数据改用新探测口径。

### 三、验证

- `cargo test framework_tests`：7 passed（r6/scripts 单判、CLI 单判、空目录未装、RED4ext dll、CET init.lua、大小写变体、未装仍回显首选路径）。
- `tsc --noEmit` / `vite build` 通过。
- 新脚本 `check-feedback-fixes.mjs` 22 项全过：版本号格式、头像 flex/居中/正方形、断开→卡片消失+角标出现、重连→角标消失+卡片回来、结论卡圆角/标题/加粗/副标题/三格/19px/警告色/48px 图标、redscript 与 Mod Settings 卡片 `OK`、720px 下统计换行不溢出。

### 四、已知边界

- `r6/scripts` 目录存在即判 redscript 已装。若玩家建了空目录却删了框架，会误判为「已装」——比漏判好（漏判会让人反复重装框架）。
- 大小写不敏感解析只在**直接命中失败**时枚举目录；NTFS 本身不区分大小写，这条主要兜住 exFAT/网络盘与从别人压缩包解出来的大小写变体。
- 诊断结论卡的副标题仍用后端 `summary` 原句，主标题由前端按 `summaryLevel` + 问题数生成；两者措辞可能不完全一致（例如 info 级显示「一切正常」而副标题说「还没导入模组」），属可接受的层次差异。

---

## 0.9.0-r31 — 合规自检 P1 两项修复（2026-10-30 20:30 → 21:05，未构建部署）

> 来源：`docs/PROJECT_HISTORY.md#audit-7modules` 自检报告的 P1-1 / P1-2，用户确认后执行。P2 七项保持记录在案、未动。
> 这是「修复缺陷」批次，不新增功能。

### 一、P1-1 下载 429 限流等待期的暂停/取消被吞（download_queue.rs）

- **现象**：任务处于 N 网 429 限流等待（30–300 秒）时点「暂停」或「取消」，界面点了没反应，任务继续下载；取消的任务还会继续消耗重试次数。
- **真因**：`worker_body` 每循环开头无条件 `flags.pause.store(false)` / `flags.cancel.store(false)`；等待函数 `sleep_interruptible` 感知到旗标后返回 false，两个调用点却只做 `continue` —— 回到循环开头把用户刚按下的旗标清掉，再重新发起下载。
- **修法**：新增纯函数 `settle_interrupted(task, cancelled)`（取消优先于暂停、清空 error、取消补 `finished_at`）；两处等待中断改为「读旗标 → patch 收尾 → return」，并在代码里写明**为什么不能 continue**。
- **测试**：`interrupted_wait_settles_as_paused_or_cancelled`、`interruptible_sleep_returns_immediately_when_flagged`（断言旗标已置时 30 秒等待在 2 秒内返回）。

### 二、P1-2 混合包静默丢文件（installer.rs）

- **现象**：压缩包同时含 `.archive` 与 `.reds`/`.lua` 时，界面显示「导入成功」，部署后脚本/插件部分缺失，游戏内功能不全且毫无提示。
- **真因**：`detect_layout` 取第一个命中的布局（`.archive` 优先于 `.reds`），`plan_for` 随后把不属于该布局的文件 `continue` 跳过；导入 warning 只覆盖 GameRoot 根目录散文件与 REDmod 提示。
- **修法**：新增 `layout_label()` + `layout_skipped(payload, layout, sample_limit) -> (总数, 前 N 个文件名, 布局标签)`，统计口径与 `plan_for` 的跳过条件逐条对齐（REDmod/CET/redscript 不跳过任何文件，直接返回 0 以免误报）。两处接入：
  - 导入时 `finalize_install` 拼 warning（替换掉原来只管 GameRoot 根目录的 `count_unknown_root_files`）；
  - 部署时 `deploy_mod` 再报一次（旧库模组导入时的提示早被划走）。
  - 文案列出前 3 个文件名，并提示「如果是多框架合集包，请把各部分拆开分别安装」。
- **刻意不做**：没有改 `detect_layout` 的返回结构（改动面大），也不尝试把裸 `.reds` 自动装上——裸文件没有 `r6/scripts/<folder>/` 归属信息，硬猜会把文件塞错位置，比跳过更糟。折中 = 显式告知 + 让用户拆包。
- **测试**：`mixed_loose_archive_and_redscript_reports_skipped`、`pure_archive_pack_reports_nothing_skipped`、`game_root_pack_flags_stray_files`、`redmod_pack_reports_nothing_skipped`。

### 三、验证

- `cargo test`：**105 passed / 0 failed**（新增 6 项，1 ignored 为既有网络用例）。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：通过。
- `node node_modules/vite/bin/vite.js build`：通过。
- 未改前端、未改数据格式，因此**无需迁移**；旧库模组无需重新导入（部署时会即时统计跳过项）。

### 四、已知边界

- 429 等待结束后、`continue` 生效前的**微秒级窗口**内点暂停，仍可能被清旗标（`worker_body` 开头的无条件清旗标保留，因为要用它清理残留态）。秒级以上的等待窗口已完全覆盖。
- 混合包只提示、不自动拆分。要真正「一次装全」，需用户把包拆成 archive / redscript / CET 分别导入。

---

## 0.9.0-r27 — Modern 主题明暗色板重校（2026-10-30 00:40 → 00:55，已随 00:40 构建部署）

### 一、问题

Modern 暗色各级表面（bg #1e1e1e → panel #252526 → panel-2 #2b2b2c）只差 2-4 个色阶值，面板、卡片、背景糊成一片；亮色面板 #f3f4f6 比背景更深、与侧栏抢层级，卡片靠边框硬撑。

### 二、重校（只动令牌值，不动主题切换逻辑）

- **暗色（VS Code 五级表面）**：`bg #161617`（最深）→ `bg-2 #1b1b1d`（侧栏）→ `panel #1f1f22` → `panel-2 #252629`（卡片/悬浮菜单）→ `panel-3 #2e3034`（hover/内嵌块），相邻级至少 4-6 步亮度；边框 `line #3c3d42` / `line-soft #292a2e` / `line-hot #5c5e66` 相应加深；卡片阴影加强一档。
- **亮色（Linear）**：底色保持纯白；`bg-2 #f3f4f7`（侧栏灰）→ `panel #f7f8fa`（靠边框与底分离）→ `panel-2 #ffffff`（卡片纯白 + 阴影浮起）→ `panel-3 #e9ebef`；边框略加强；侧栏选中项改**纯白卡浮在灰侧栏上**（替代原「浅灰底」），带 1px 投影。
- 附带修复：`check-contrast.mjs` 残留的 `127.0.0.1` 地址改 `localhost`（与 2026-10-29 三个脚本同坑）。

### 三、验证

- 对比度门禁 26/26（modern 亮/暗两组断言全过，含自定义亮黄强调色场景）。
- 明暗两模式 1440×900 截图目视：暗色卡片从深底清晰浮起、侧栏选中项高亮明确；亮色白卡带阴影、灰侧栏/白卡片/灰面板三层分明。截图存 `shots/theme/modern-{light,dark}.png`。

## 0.9.0-r29 — mod 列表及切换功能收尾（2026-10-30 01:40 → 02:20，未构建部署）

看板【mod 列表及切换功能】的存量核对 + 缺口补齐。**存量已实现**（不重做）：播放集重命名/复制/删除/切换/保存、切换前差量预览确认卡（撤除/部署/保留计数 + 三段步骤）、按分类与「已启用」过滤。

### 新增

- **modlist 导出**：`export_profile_modlist` 把播放集写成 JSON（kind `cyberdeck-profile` + version 1 签名，含 enabledModIds、loadOrder 与已启用模组的名称/分类/版本元数据快照），落 `<data_dir>/exports/播放集-<名>-<时间戳>.json`。文件名经 `safe_filename` 清洗 Windows 保留字符（单测覆盖）。
- **modlist 导入**：`import_profile_modlist` 校验签名后，按模组 id 精确对（同机往返）→ 名字兜底（跨机器分享）；对上的进新建播放集，对不上的进 `unmatched` 如实报告，一个都不对上报 `PROFILE_NO_MATCH` 拒绝创建。load_order 不随导入带过（跨机无意义），界面提示「切换后保存状态」固化顺序。
- **批量启用/禁用**：`set_mods_enabled(ids, enabled)` 逐个走与单个开关完全相同的部署/撤除语义（启用前先查更新熔断一次），单个失败不中断整批，failed/warnings 如实返回。前端：模组库工具栏「多选」开关 → 卡片出复选框（点卡=选中）→ 批量条（已选计数 / 批量启用 / 批量禁用 / 全选当前结果 / 退出），结果走本页 note 回显。

## 0.9.0-r30 — deepseek 任务四模块（2026-10-30 02:20 → 03:30，已构建部署 + 便携版重制）

### 模块一：路径 / 部署方式 / 启动高级选项

- **暂存区磁盘建议**：`suggest_staging_dir` 走 PowerShell CIM 枚举固定磁盘（DriveType=3），按剩余空间排序返回 `{drive, freeBytes, totalBytes}`；查询失败返回空列表（「建议」是锦上添花，不阻塞手动选择）。前端在暂存区行加「建议」按钮，点击候选即迁移到该盘 `CyberDeck-Staging`（复用既有 changeStagingDir 搬迁语义）。
- **部署方式**：`deploy_mode` 三选（hardlink 默认 / symlink / copy），`installer::create_link_with_mode` 统一落盘；symlink 跳过硬链尝试、copy 直复制；`deploy_mod` / environment heal 全部走新函数。非法值在 set_settings 白名单拦截并回退 hardlink。
- **启动高级选项**：显卡偏好 `launch_gpu_pref`（非 auto 时写 HKCU UserGpuPreferences 注册表，`apply_gpu_preference`）；进程优先级 `launch_priority`（creation_flags 0x80 高 / 0x4000 低，直启路径生效）；前置命令 `launch_pre_command`（cmd /C 执行一次，失败中止启动并带回输出）。

### 模块二：下载中心升级

- **限速**：`DownloadQueueSettings.speed_limit_mbps`（0–100 钳制，0=不限），下载循环令牌桶（窗口字节配额 + 补睡差值）；多任务并发各自限速。设置页「速度限制」按钮组。
- **NXM 修复**：下载设置显示协议归属 + 「修复（接管协议）」按钮，复用既有 nxm_takeover。
- **.nxm 拖拽**：后端新增 `nxm_intake`（单条 URI）与 `nxm_intake_file`（读 .nxm 文本逐行解析，一行都没有才报错）；App 全局 onDragDropEvent 分流——.nxm 进收件箱（与协议拉起同链路：去重 + nxm-link 事件），其余走既有导入队列。浏览器预览（mock）走 HTML5 drop + File.text()。
- **速度折线图 + 接收区**：下载中心每次轮询采样总速率（60 点窗口）画 SVG polyline；拖拽接收区为可视化提示（Tauri 内 HTML5 拖拽被禁用，真实落点由 App 层接管）。

### 模块三：外部工具链管理器

- `ExternalToolEntry { id, name, path, icon?, pinned, createdAt }` 存进 AppStateData；5 个命令（list/add/update/remove/launch，launch 设 cwd 为 exe 目录）。前端 ExternalToolsCard（添加表单 / 列表 / 启动 / 固定 / 删除），变更后广播 `cdl.tools-changed` 事件让 App 侧栏固定工具区同步；侧栏新增 `sidebar-tools-nav` 独立 class（不混入 check-sidebar 的主操作区断言）。

### 模块四：界面显示管理

- `ncl.ui.hiddenViews.v1`（localStorage，沿用 ncl.ui.* 键名约定）：可隐藏 discover/loadorder/downloads/diagnostics 四个入口；模组库/设置受保护。个性化页四个开关 + 侧栏过滤；当前页被隐藏时 useEffect 自动跳回模组库。侧栏折叠开关（既有）即极简模式。

### 验证

- cargo 126 tests 全绿（含既有 base64 / safe_filename 单测）；tsc、vite build 全绿。
- 门禁 21 个 UI 脚本全绿，其中 check-deepseek.mjs 21 项为新脚本（部署方式写入/建议列表/限速选中/NXM 修复/工具卡片/添加表单/侧栏固定工具/折线卡/接收区/隐藏入口 + 持久化 + 自动恢复）；check-platform.mjs 因新增两组 chip 改为限定「游戏平台」行断言（strict mode 修复）。
- 便携版重制并删除旧 0.9 包（见发布记录）。

### 已知边界

- mock 的队列设置只存内存（不落 demo db），验收断言走 UI 选中态。
- GPU 偏好 / 优先级 / 前置命令只影响直启路径；Steam 转发路径不生效（说明文案已注明注册表语义）。

### 验证

- `check-modlist-tools.mjs`（新，gate 第 12 个脚本）9 项全过：导出按钮/回显、多选复选框、批量条、计数、全选、操作后自动退出多选、演示库状态真实变更。
- cargo test `import_export_tests` 过（safe_filename）；i18n 0 违规 0 死键；tsc / vite build 通过。

### 已知边界

- 导入对话框在浏览器演示模式不可用（mock 直接造半匹配数据）；真机导入路径待实机验证。
- 批量启用遇到更新熔断整批拒绝（GAME_UPDATE_LOCKED），这是有意的防呆。

## 0.9.0-r28 — 自定义背景图（2026-10-30 01:00 → 01:40，未构建部署）

看板【皮肤 UI 优化（含自定义背景图）】的 P0 子项。主题细节打磨部分由 r25/r27（侧栏收口、Modern 明暗色板重校）覆盖。

### 新增

- **Settings 三字段**：`backgroundImage`（空 = 不启用）/ `backgroundOpacity`（0–100，默认 45）/ `backgroundBlur`（0–40px，默认 0）；`set_settings` 钳制数值，旧状态缺字段 serde 兜底。
- **`read_background_image` 命令**：校验扩展名（png/jpg/jpeg/webp/bmp/gif）与 20 MiB 体积上限，读字节转 `data:` URL 返回。不放宽 asset 协议白名单（asset scope 只开 AppData，用户图可以放任何盘）；CSP `img-src data:` 原样放行。base64 编码器手写 20 行（RFC 4648 向量单测），不引入新依赖。
- **个性化页控制块**：选择图片（plugin-dialog，图片扩展名过滤）+ 恢复默认 + 双滑杆（不透明度/模糊）。拖滑杆 = 乐观更新快照，背景层**同一帧**跟着变；落盘走新的合并队列。
- **背景层**：`.app-backdrop` 挂 `.app-shell` 内 `z-index:-1`（shell 有 `isolation:isolate`，负 z 只盖住壳背景不反噬面板）；启用时 `[data-backdrop="on"]` 把壳的不透明 `var(--bg)` 底去掉、侧栏换 color-mix 半透明——面板本来就是半透明 color-mix，图片从缝里透出。`inset:-28px` 是 blur 毛边补偿。
- **设置保存合并队列**：`handleSettings` 由「每次全量写盘」改为「只保留最新值 + 串行 + 250ms 合并窗口」。滑杆一秒几十次输入不再逐次写 launcher-state.json。

### 验证

- `check-background.mjs`（新，挂入 gate.mjs 第 11 个脚本）13 项全过：控制块渲染、无图禁用态、data URL 背景层、初始值落样式、滑杆实时预览、恢复默认写回。
- cargo test `background_tests` 3 项过（RFC 4648 向量 / 二进制形状 / 上限常量）。
- i18n 门禁 0 违规 0 死键；tsc / vite build 通过。

### 已知边界

- 背景图路径是绝对路径，换机器/挪文件后读不到 → 背景层退场 + 报错，路径保留（重新选一次即可）。
- GIF 动图可用但 blur 用 CSS filter，性能取决于图尺寸；20 MiB 上限兜底。
- mock（浏览器演示）模式返回内置 SVG，选图对话框不可用。

## 0.9.0-r26 — 模组库工具栏左右分区重构（2026-10-30 00:16 → 00:40，已随 00:40 构建部署）

### 一、改前的问题

模组库顶部一行塞了 8 个控件（结果数 / 排序 / Vortex 导入 / 补全信息 / 导入清单 / 检查更新 / 智能归类 / 翻译名称），第二行只剩「智能归类」与「翻译名称」两个孤立按钮；`195 RESULTS` 与排序框贴在一起，基线对齐导致垂直观感错位。

### 二、布局与逻辑分组（按用户任务书执行）

- **左侧（视图与过滤区）**：`195 RESULTS`（右侧边距 +8px）→ `[智能归类 (N)]`（从第二行移入，紧挨排序）→ `[最近安装 ▼]` 排序框。
- **右侧（操作区）**：低频导入收拢为 `[导入 ▼]` 下拉菜单（「从 Vortex 导入」「导入清单」两项，点击外部 / Esc 收起）→ `[检查更新]`（强调样式）→ `[补全信息]`（次级样式）→ `[翻译名称]`（强调样式，从第二行移入）。
- **样式分级**：新增 `.btn-accent`（`var(--yellow)` 边框 + 图标/文字着色，hover 增强），只用于「检查更新」「翻译名称」；「导入」「补全信息」保持 ghost 次级样式。
- **对齐与溢出**：工具栏改 `align-items: center`（RESULTS 与按钮/下拉框垂直居中，实测偏差 0.0px）；左右两区都 `flex-wrap: wrap`，窄窗口时右侧自动折行，按钮不挤压变形（check-layout 六档尺寸「工具条不裁切按钮」全过）。

### 三、验证

- tsc / vite build / i18n 门禁全绿；新增 8 项临时交互断言（分区顺序、强调样式归属、下拉开合、菜单项、垂直居中）全过。
- `check-layout.mjs` 复跑 54/54：期望值按 r25 档位改写（STAGING 到 tight 才隐、版本号行到 mini 才隐），并修掉该脚本残留的 `127.0.0.1` 地址（vite 绑 `[::1]`，见 2026-10-29 备忘老坑）。

## 0.9.0-r25 — 侧栏纵向布局收口（2026-10-29 23:10 → 23:25，已随 23:47 构建部署）

### 一、用户报的现象与真因

用户反馈「侧栏只剩模组库 / 下载中心 / 设置三项，菜单和 GAME LINK 挤在一起，中间只有一条极细的滚动条」。

- **三项没丢**：`PRIMARY_NAV` 一直是 4 项（模组库 / 发现 / 加载顺序 / 运行诊断），`AUX_NAV` 2 项，`check-sidebar.mjs` 有断言兜着。丢的是**可视高度**：中间 `.sidebar-scroll` 被上下固定区块夹到只剩 100 多 px，滚出视口的两项用户根本不知道存在。
- **根因**：纵向预算只按「标准窗口」算过。`body { zoom: var(--ui-scale) }` 会等比放大整个界面，**媒体查询量不到 zoom**——1280×800 在 110% 缩放下实际可用高度只剩 ≈727 CSS px，`@media (max-height: 780px)` 仍按 800 判，永远差一档。
- **次因**：滚动条用的是系统默认细条（≈2px 且无轨道），滚得动但看不见，等于没滚。

### 二、改法

1. **三段式权限写实**：`.sidebar` 列注释写明三段 `flex` 权限（Logo `0 0 auto` / 菜单 `1 1 auto` / 底部固定区 `0 0 auto`），并点明 `min-height: 0` 是菜单能滚的前提（Flex 子项默认 `min-height: auto`，会顶破侧栏）。
2. **滚动条可见**：`.sidebar-scroll` 显式 6px 轨道 + 强调色滑块（hover 加深），`scrollbar-gutter: stable` 保证滚动条出现时菜单宽度不跳。
3. **纵向档位（新模块 `lib/viewportTier.ts`）**：按 **有效高度 = innerHeight ÷ scale** 分 `full / compact / tight / mini` 四档，写在 `:root[data-vh-compact|tight|mini]`，CSS 按档位逐级让位——`compact` 收紧间距且 STAGING 只留标题行；`tight` 隐去 STAGING / logo 副标题 / 游戏路径；`mini` 再隐去版本号行并收紧底部区块间距。
4. **折叠补过渡**：`.sidebar` 过渡 `width / flex-basis / padding` 180ms；`data-motion="off"`（用户关动效）时瞬时完成，与全站口径一致。折叠逻辑本身没改：状态在 `preferences.sidebarCollapsed`（localStorage `ncl.ui.preferences.v1`），`App.tsx` 只是接线。另补 `data-collapsed` 与 `aria-expanded`。

### 三、实测（有效高度 = 窗口高 ÷ 缩放，菜单可视 / 内容高度）

| 窗口 × 缩放 | 改前 | 改后 |
|---|---|---|
| 1440×900 @100% | 390 / 390 全显示 | 390 / 390 全显示 |
| 1280×800 @110% | 219 / 224 **需滚（差 5px）** | 289 / 289 全显示 |
| 1280×720 @110% | 179 / 216 需滚（见 3 项） | 216 / 216 全显示 |
| 1024×700 @110% | 161 / 216 需滚（见 2 项） | 263 / 263 全显示 |
| 900×600 @100% | 207 / 216 需滚 | 225 / 225 全显示 |
| 900×600 @110% | 154 / 216 需滚（见 2 项） | 202 / 202 全显示 |
| 820×560 @110% | 118 / 216 需滚（见 2 项） | 166 / 196 需滚（见 3 项，该档为极端组合） |

### 四、门禁

`check-sidebar.mjs` 从 8 项扩到 21 项，新增：110% 缩放档下 `overflow-y` 仍为 auto、滚动条槽位 ≥6px、滚到底最后一项完整可见、GAME LINK 不溢出侧栏；折叠状态写回偏好存储、带折叠初值的页面渲染为 66px、开/关动效时过渡分别为 180ms / 0s。**完整 `gate.mjs` 全绿（2m44s，10 个 UI 脚本）**。

---

## 0.9.0-r24 — AI 模型预设扩充（2026-10-29 22:55 → 23:10，已随 23:47 构建部署）

### 一、为什么改结构而不只是加条目

原预设是「一家一个模型」的平铺数组，`AiPreset.model` 单值，反查要求地址与模型名**同时**精确命中。任务要求每家列出多个模型，若只往数组里塞条目，会出现：同一个 baseUrl 出现 4 次、反查只能命中被写死的那一个、模型清单更新时要把整条记录改一遍。因此改成**厂商 → 模型**两级：`AiPreset` 增加 `group` 与 `models: AiPresetModel[]`，`model` 保留为「选中该厂商时的默认模型」。

### 二、数据

- 14 家厂商、38 个模型：国外 5 家（OpenAI / Anthropic / Google / Meta / xAI），国内 7 家（DeepSeek / Moonshot / GLM / 豆包 / 通义千问 / MiniMax / 小米 MiMo），本地 2 家（Ollama / LM Studio）。
- 全部仍是 OpenAI 兼容端点：Gemini 走 `generativelanguage.googleapis.com/v1beta/openai`，智谱走 `/api/paas/v4`，火山方舟走 `/api/v3`。**Anthropic 预设保持 `protocol: "anthropic"`（原生协议），未改成 OpenAI 兼容**——那是 r21 已测通的分发路径，改它等于改后端契约。
- Meta 官方无 OpenAI 兼容接口，预设指向 Together 托管，`keyHint` 里写明「换 OpenRouter / Groq 等托管商时地址与模型 ID 要一并改」。
- 模型目录整块加了 `// i18n-ignore-start…end` 区块豁免（`check-i18n.mjs` 的官方机制）：模型 ID、商业名、定位描述是随厂商发版同步变化的上游快照数据，拆进词表等于每次上新改两个文件；分区标题与提示语仍全部走 `t()`。i18n 门禁 0 处、死键 0 条。

### 三、交互

- 服务商下拉框改 `<optgroup>` 三分区；新增「模型预设」下拉框，选项文案为 `显示名称 · 模型ID`，选中即填模型名。
- **选模型不覆盖接口地址**：只有切换厂商才写 baseUrl；地址与当前厂商不一致时，在预设项下方显示「该服务商常用地址：…（只作提示，不会覆盖你已填的内容）」。
- 本地部署：模型名输入框始终可编辑，提示语改为「填写你在 Ollama / LM Studio 中已下载的模型名称」。
- `matchAiPreset` 判定改为**只看接口地址**：一个厂商挂着一排模型、用户还会手改厂商刚发的新名字，要求模型名精确命中会让老配置一升级就退回「手动配置…」。反查只影响下拉框显示，不回写任何状态，用户输入框里的值不会被改。

### 四、抓到的两个真问题

1. **`kimi-k2.7-code` 会被弃用警告误伤**：原正则 `/^kimi-(latest|thinking-preview|k2)/` 前缀匹配把在售的 `kimi-k2.7-code` 判成「kimi-k2 系列已下线」。改为只认 `kimi-k2` / `kimi-k2-preview` / `latest` / `thinking-preview` 四种旧名。
2. **门禁 `check-ai-config.mjs` 按下标取控件**：新增「模型预设」下拉框后 `selects.nth(1)` 不再是协议框，脚本直接超时。改为 `select[aria-label="接口协议"]` 定位，后续再加字段不会错位。

### 五、验证

- `npm run build`：tsc 0 错 + vite 构建通过（aiPresets chunk 7.71 kB）。
- `npm run i18n:gate`：0 处硬编码；`--unused` 0 条死键（顺手删掉被新提示语取代的 `aiSettings.localModelHint`）。
- 新增第 10 个门禁 `scripts/check-ai-presets.mjs`（10 项）：分区数=3、分区顺序、厂商数=14、每个模型选项都带 ID、选厂商填对地址与模型、选模型不覆盖地址、本地分区可编辑且提示可见。
- **完整 `node scripts/gate.mjs` 全绿**（2m36s）：cargo test + tsc + vite build + 10 个 UI 脚本（含 check-ai-config 6 项、check-ai-presets 10 项）。

---

## 0.9.0-r23 — 侧边栏重构 + 分类引擎重写（2026-10-29 20:10 → 22:00）

### 一、侧边栏导航层级（P0）

- **分区**：主操作区 = 模组库 / 发现 / 加载顺序 / 运行诊断；底部辅助区 = 下载中心 / 设置。
- **沉底实现**：`.sidebar-scroll` 是整条侧栏唯一 `flex: 1 1 auto` 的一段，吃掉中间空白，辅助区 `flex: 0 0 auto` 被自然顶到 GAME LINK 正上方——**纯 Flex，无 absolute**，窗口缩放不会重叠（`check-sidebar.mjs` 在 1100×700 / 900×600 / 820×560 三档断言了几何关系）。
- **拥挤感**：`.sidebar-nav` gap 3px → 8px，行高 44 → 42；辅助区与主操作区之间加分隔线。
- **高亮**：active 判定不变，两个分区共用同一个 `renderNav`，`aria-current="page"` 补上。

### 二、帮助中心迁移（P1）

- 侧栏删除「帮助」项；`SettingsTabId` 新增 `help`（在「关于」左侧，`BookOpen` 图标）。
- `HelpCenterView` 增加 `embedded` 变体：跳过整页头部，**搜索 / 三段切换 / 折叠动画 / 空态原样保留**。
- `check-help.mjs` 导航路径同步改为「设置 → 帮助」两步；`check-sidebar.mjs` 额外断言帮助 Tab 内条目 ≥14 且搜索框还在。

### 三、设置页间距（P1）

- `.sidebar-pref .switch-row { padding: 0 }` 是拥挤真因（三行贴死）→ `.sidebar-pref` 改 flex 列 + `gap: 24px`。
- `.setting-row` 上内边距 9px → 14px。

### 四、Mod 分类引擎重写（P0）

- **真因（先说清楚，不是"关键词不够多"）**：`infer_category(description, ...)` 把描述拼进关键词海，而 168 个收编模组的 description 是同一句模板——「由外部**工具**（如 Vortex）部署、经「收编」纳入启动器管理。」，正好命中「工具」。实测分布：工具 168 / 视觉 11 / 框架 7 / 玩法 5 / 任务 2 / 车辆 1 / 音频 1。
- **新引擎 `src-tauri/src/category.rs`**：加权投票——内容证据 6 分 > 名称/目录关键词 3 分 > 布局 1 分，并列按固定类别顺序决胜。
  - 内容证据读 `planned_files`（导入时缓存的目标路径）：`bin/x64/plugins`（且不在 `cyber_engine_tweaks/mods` 下）⇒ 框架；`.archive` 含 `weapon/guns/` ⇒ 武器；`character/`、`body/`、`clothing` ⇒ 服装；`.reds` / `.tweak` / `r6/scripts` ⇒ 玩法；`.wav` / `.bnk` ⇒ 音频。
  - **description 彻底退出分类输入**，静态守卫断言所有 `Signals{...}` 块里不得出现 description。
  - 9 个单测覆盖：收编模板不再污染、武器优先于服装（枪模也在 character/ 下）、CET mods 目录 ≠ 框架本体、内容压过误导性名称。
- **老条目补证据**：没有 `planned_files` 缓存的（收编 / 旧状态）扫暂存目录（上限 4000 文件 / 6 层深）。
- **重算语义**：`reclassify(all)` —— 默认只动「其他 / 工具」两类兜底值；Shift+点击「智能归类」重算全部。
- **手动改分类（终极兜底）**：卡片右键「修改分类」→ 10 个分类 chip（排除「全部 / 已启用」）→ 写入即保存，同时打 `category_locked`，此后任何自动重算跳过（面板里当前分类高亮、已锁定条目菜单显示「手动指定」）。
- 新命令 `set_mod_category` / `reclassify_all`（均已注册 `generate_handler!`，`check-commands` 104/104）。

### 四之补、真实库校准（22:10 → 22:40）

规律自洽 ≠ 玩家的库会判对。9 个单测全绿之后，把真实的 195 个模组喂进去，抓出三件事：

- **新增真实库诊断入口**：`#[ignore] diagnose_real_library`，用法
  `CDL_DIAG_STATE=<launcher-state.json> cargo test --lib diagnose_real_library -- --ignored --nocapture`。
  只打印「名字 → 分类」与分布，**不写盘**，CI 不受影响。存在的意义：单元测试证明不了玩家那一库的温度。
- **发现 1：收编模组的名字是连写句柄，整词匹配全废。**
  真实库里 `plannedFiles` 全是 `archive/pc/mod/*.archive`（内容证据在收编库上没有区分度），唯一能用的信号是名字，而名字长这样：`compactweaponmodslots`、`alwaysfirstequip`、`npc-silverhand`。
  整词匹配对这类无分隔符的名字一律落空：**169 个判不出来**。
  修正 `word_hit` 按词长分层：`< 5` 字符仍整词（`cet`/`gun`/`hud`/`car` 不能命中 `cetocide`/`cargo`/`gunpowder`），`>= 5` 允许词中词。放开后 169 → 143，且命中项逐条核对无误判。
- **发现 2：并列决胜方向反了。** `max_by_key` 在并列时返回**最后一个**最大值，与「`CATEGORY_ORDER` 靠前者胜」正好相反。反例（真实库里的条目）：`Disappearing NPC and Vehicle Fix (Crowd LOD spawn distance)` 同时命中玩法(spawn)/车辆(vehicle)/视觉(lod)/任务(npc) 各 3 分，被判成「任务」。改为顺序扫描、严格大于才替换，并补 `ties_resolve_to_the_earlier_category` 单测。
- **发现 3：词表缺通用词。** 补 `garage`（车辆）、`equip` / `loadout` / `inventory` / `cyberware` / `chipware` / `progression`（玩法）、`lod`（视觉）。
  **刻意不补** `amm` / `sp0` / `nova` 这类品牌句柄——那是拿这一库数据过拟合，换个人装别的模组就错。

真实库（195 个模组）前后对比：

| | 工具 | 其他 | 任务 | 玩法 | 视觉 | 服装 | 框架 | 武器 | 车辆 | 音频 |
|---|---|---|---|---|---|---|---|---|---|---|
| 修复前 | 168 | 0 | 2 | 5 | 11 | 0 | 7 | 0 | 1 | 1 |
| 修复后 | **0** | 132 | 21 | 17 | 8 | 5 | 5 | 4 | 2 | 1 |

- 抽检命中项全部正确：`weaponsimproved` → 武器、`romancehangoutsenhanced` → 任务、`Environment Textures Overhaul` → 视觉、`badlandsgarage-cht` → 车辆、`alwaysfirstequip` → 玩法。
- **剩余 132 个「其他」是证据边界，不是漏判**：`amm_props`、`###-novalut4`、`_0sp0_natural_breast` 这种纯句柄，名字里没有任何语义。这批只能靠「修改分类」手动归类，或等 Nexus 分类反查（已登记 0.9.1 待办）。
- **写入方式**：先导出 Rust 的逐条判定 → 用与 Rust 同构的复算脚本比对 → **195/195 一致才写盘**（不一致直接退出，不做「差不多就行」）；写前备份 `launcher-state.pre-r23.json`。

### 五、顺手修的

- **顶栏版本号**：`titleBar.build` 硬编码「CDL 0.7.0」，0.9.0 的 exe 顶栏还挂着旧号 → 改为 `useAppVersion()` 动态渲染。

### 验证

cargo test --lib **95/95**（+12 分类用例，含连写句柄与并列决胜两条回归）、core-tests **122/122**（**注意：core-tests 自 0.9.0-r22 起就编译失败——glossary 模块没挂进去，本轮已修**）、tsc 0 错、i18n 1386 双向归零、**`gate.mjs` 17/17 全绿**（含 check-sidebar 22 项、check-category 13 项、check-help 5 项）、check-commands 104/104。

> 门禁曾出现 3 项「零输出」失败，真因不是组件坏了：`vite preview` 绑定在 `[::1]:1420`，而 r23 新写的三个脚本硬编码 `127.0.0.1`，Playwright 等 `networkidle` 直接超时。已统一为 `localhost`（与其余 20 个脚本一致），并把这条写进 MEMORY。

---

## 0.9.0-r22 — 0.9.0 版本冲刺：看板【7】~【14】八项任务（2026-10-29 01:35 → 02:15）

> 版本号 `package.json` / `Cargo.toml` / `tauri.conf.json` 三处统一 `0.8.0` → `0.9.0`。
> 编码按文件边界切分给子 Agent 并行；本轮子 Agent 两次分派共 6 个进程均被环境回收（零产出），改由主 Agent 按同一边界自行实现，文件冲突面为零。

### 【7】AI 汉化结果入库与云端共享

- 新增 `src-tauri/src/glossary.rs`（约 430 行）：本地词表 `glossary.json`，主键 = `mod_id + FNV-1a64(原文)`。
  - **版本隔离天然成立**：Mod 更新后原文变化即失配，无需迁移、不会误用旧译文。
  - `GlossaryEntry{source, target, by, updated_at}`，`by ∈ ai | user | cloud`。
  - `record()` 冲突规则：已存在且 `by=="user"` 的条目永不被非 user 覆盖（手动校正优先）。
  - `merge_pack()`：本地优先，云端只补空缺；带冲突计数；坏包返回 `GLOSSARY_PACK_INVALID` 且**不改动本地文件**；`version > 1` 返回 `GLOSSARY_PACK_VERSION`。
  - `sync_remote()`：reqwest blocking + 5s 超时；未启用或空地址直接返回空结果（视为常态，不报错）。
- `ai.rs` 的 `translate_mod_names` 接入词表：发请求前 `glossary::lookup` 命中直接 `persist_translations` 复用（**不消耗 API 配额**），批次落库后 `glossary::record(..., "ai")` 回写。
- 前端 `src/components/GlossaryShareCard.tsx` + `src/lib/apiGlossary.ts`：AI 配置 Tab 内新增卡片，含共享开关、地址输入、立即同步、导出 / 导入、状态回显。
- 新增 5 个单测：本地优先、版本隔离、导出回环、坏包拒绝、未来版本拒绝。

### 【8】AI 深度汉化（含模组框架菜单）—— 架构评审

- 交付 `docs/PROJECT_HISTORY.md#ai-loc-review`：三条路线裁决 —— 离线资源（A）采用、overlay 覆盖（B）禁止、词表（C）已实现。
- 含写入白名单表、词表主键与冲突规则、生成到部署的流程、回滚矩阵、M1/M2/M3 里程碑、不做清单。
- **状态**：架构定案交付，M1 编码未启动，看板保持 running。

### 【9】启动动画

- `src/components/SplashScreen.tsx` + `.css`：620ms 主体 + 200ms 淡出（总时长 ≤820ms，满足 ≤1.5s 约束）。
- `pointerdown` / `keydown` 立即跳过；`prefers-reduced-motion` 与「界面动效」关闭时退化为静态。
- 只用主题变量（`--accent` / `--accent-ink` / `--display` / `--mono` / `--bg` / `--muted`），**Cyber / Modern × 明暗四组合自动适配**，无硬编码色。
- 设置 → 个性化 → 动效后新增「启动动画」开关（`preferences.splash`，默认开、缺省视为开），可随时关闭。

### 【11】内置帮助中心

- `src/components/HelpCenterView.tsx` + `.css`：搜索框 + 三段切换（全部 / 教程 / 常见问题）+ `AnimatePresence` 高度动画折叠面板 + 空结果文案。
- `src/lib/helpContent.ts`：6 篇图文教程（每步带 `where` 定位提示）+ 10 条 FAQ；内容表用 `// i18n-ignore-start/end` 区块忽略（属内容而非界面文案）。
- `docs/help/01..06*.md`：绑定游戏目录 / 导入 Mod / 部署与取消部署 / 启动游戏 / 冲突排障 / 卸载与回滚。
- 侧栏新增 `help` 视图项（`LifeBuoy` 图标）；`App.tsx` lazy 加载。
- 新增 `scripts/check-help.mjs`（Playwright）：实测 tutorials 6 / faq 10 / expanded 1 / searchHits 8 / restored 16，5 项全过。

### 【12】全局配置导入 / 导出

- 新增 `src-tauri/src/config_pack.rs`（约 330 行）：`ConfigPack` 带 `schema_version`、`exported_at`、`app_version`、`settings`、`game_dir`、`profiles`、`active_profile_id`、`ignored_keys`。
- **白名单 15 个标量**：aiBaseUrl / aiModel / aiProtocol / nexusHideAdult / nxmAutoDownload / wolvenkitCliPath / wolvenkitTimeoutSecs / archiveToolPath / launchMethod / platformPref / closeBehavior / autoBackup / confirmUninstall / writeModlist / launchArgs。
- **绝不导出**：API Key、DPAPI 密文、Mod 库、deployed_files、staging_dir。`ignored_keys` 用中文说明列出未迁移项（不再写字段名，避免被密文扫描误判）。
- 导入策略：先全内存校验（解析 → 版本 → 白名单）再落盘，**失败不写脏状态**；非法 `aiProtocol` 进 `ignored` 不写入；`wolvenkit_timeout_secs` 钳制 10–600；profiles 覆盖后校验 `activeProfileId` 归属；`needs_game_reverify` 提示核对游戏路径。
- 前端 `ConfigPackCard.tsx` + `apiConfigPack.ts`，位于设置 → 安全与维护。
- 4 个单测：导出文本不含 api_key / apikey / secret / dpapi / bearer（小写匹配）、坏 JSON 不改状态、未来版本拒绝、非法协议进 ignored。

### 【13】2.5 灾后重建：Safe Mode + 过期插件智能扫描

- 新增 `src-tauri/src/safemode.rs`（约 300 行）：
  - `enter()`：写 `safemode-snapshot.json`（created_at / enabled_ids / load_order / active_profile_id）→ 逐条 `installer::undeploy_mod`（**不持锁**）→ 短锁置 `enabled=false` + 清 `load_order` → 落盘。
  - **红线**：只按 `deployed_files` 撕除链接，**绝不删除 staging 中的 Mod 本体**（实现段无 `remove_dir_all`，已由静态守卫断言）。
  - `exit()`：短锁恢复 enabled + 合并 load_order（快照为准、新条目追加）→ `game::validate_game_dir` → 逐条重新部署累加 `deploy.deployed`；**仅 `failed_mods==0` 时才删快照**，失败保留以便重试。
  - `residual_files()`：只读反查 deployed_files 是否仍留在游戏目录，供验收使用。
  - **Mutex 不可重入铁律**：全程遵循四段式（读快照 → 逐条撤除不持锁 → 短锁写状态 → 落盘）。
- 新增 `src-tauri/src/compat.rs`（约 380 行）：`TARGET_GAME_VERSION = "2.5"`，5 条正则（JSON gameVersion、game_version_min、target/required_game_version、TOML/INI `game_version=`、compatibleVersions 数组），`OnceLock` 缓存。
  - **版本比较语义修正**：`2.21` 是 2.2.1 补丁，早于 `2.5`。逐位取数字得 `[2,2,1]` vs `[2,5]`，字典序短补 0 比较；**按整数比 21>5 会得出相反结论**。
  - 读不到版本声明 → 记 `warn`（**绝不判 stale**）；声明低于目标 → `stale`；满足目标 → 不出报告。
- 前端 `SafeModeCard.tsx`（进入 / 退出**均走 Modal 二次确认**，文案明示「不删除任何 Mod 文件」）、`CompatBadge.tsx`，位于设置 → 安全与维护；`SafetyCards.css` 统一双主题样式。
- 新增 `scripts/check-safemode.mjs`：12 项静态守卫（复用 undeploy_mod、实现段无 remove_dir_all、二次确认、快照命名、无快照报错、失败保留快照、warn 分支、version_lt 集中、目标版本常量），实测 `checks_failed=0`。

### 【10】真机环境最终排雷：完整链路验收

- `docs/PROJECT_HISTORY.md#real-env-090`：自动化预检实测表（**0 failure**）、10 组手动验收清单（A 硬链接 ~ J AI 三链路）、代码级兜底表、验收记录表。
- 对 `D:\steam\steamapps\common\Cyberpunk 2077` 实跑 `real-env-check.ps1`：游戏版本 3.0.5294808；RED4ext / ArchiveXL / TweakXL **PASS**；CET / redscript / ModSettings **WARN**（未安装）。
- 已知脚本缺陷登记：`Get-Content` 未指定 UTF8，导致中文状态文件解析失败（已在文档标注，待修）。

### 【14】多模型 API 兼容验证：Ollama / 本地模型

- `docs/PROJECT_HISTORY.md#ollama`：配置表、三条链路（名称汉化 / 日志诊断 / 内容汉化）验证步骤、6 项已知差异与处理（上下文长度、并发、模型名大小写、/v1 后缀、超时、JSON 模式支持）、排查表。
- 新增 `scripts/check-ollama.ps1`：本地 OpenAI 兼容端点探针（GET `/v1/models` + POST `/chat/completions`，处理 NO_PROXY）。

### 命令契约（新增 12 个 Tauri 命令，两处同步注册）

`glossary_status` / `glossary_export` / `glossary_import` / `glossary_config` / `glossary_set_config` / `glossary_sync` / `config_export` / `config_import` / `safemode_state` / `safemode_enter` / `safemode_exit` / `compat_scan`。

### 验证

| 项 | 结果 |
|---|---|
| `cargo test` | **83 / 83 通过** |
| `tsc --noEmit` | 0 错 |
| i18n 双向 | 1380 条，`--fail` 0 / `--unused` 0 |
| check-help.mjs | 5 / 5 |
| check-safemode.mjs | 12 / 12（`checks_failed=0`） |
| ui-test / ui-theme-test / ui-polish-test / check-ai-config / check-profiles | 全绿 |
| check-layout 54 / check-contrast 26 / check-motion 38 | 全绿 |
| 启动冒烟 | `stage=frontend mods=195`、integrity=0x2000 |

---

## 0.8.0-r21 — AI 配置支持 Anthropic 原生协议（2026-10-29 01:00 → 01:30）

### 一、前端（设置 → AI 配置）

- 新增「接口协议」下拉框：`OpenAI 兼容`（默认，DeepSeek / 第三方聚合 / 本地 Ollama）/ `Anthropic 原生`（Claude 官方 API 或原生代理）。
- 持久化：`api_protocol: "openai" | "anthropic"`，后端 `set_settings` 校验合法值（非法值拒绝保存并回显提示），旧状态文件缺省自动为 `openai`。
- 动态提示：选择 Anthropic 时 Base URL 提示变为 `https://api.anthropic.com/v1`、模型名示例 `claude-3-5-sonnet-20240620` 等；并附灰字「注：若使用中转站且兼容 OpenAI，请选择 OpenAI 协议」。
- `aiPresets` 新增 Anthropic 官方预设（带 `protocol` 字段），选中带协议的预设时协议下拉框同步切换。

### 二、Rust 双协议请求分发（ai.rs）

- `AiProtocol` 枚举 + `match protocol` 分出两套 Header / Body 组装：
  - **OpenAI**（保持现状）：`Authorization: Bearer <key>`，标准 `messages` 数组；`GET /v1/models` 拉模型列表。
  - **Anthropic**（新增）：URL 拼接 `<base>/v1/messages`（容错：已带 `/v1` 或 `/messages` 时不重复补）；Header `x-api-key` + `anthropic-version: 2023-06-01`；Body 强制 `max_tokens: 4096`；系统提示词提权到顶层 `system` 字段；`messages` 只放 user/assistant。
- **消息净化** `sanitize_anthropic_messages`：user 必须开头（开头 assistant 丢弃）、连续同角色合并、空消息剔除——规避 Anthropic 对消息顺序的 400 拒绝。
- **响应解析**：Anthropic 取 `content[0].text`（专用结构体），OpenAI 仍走 `choices[0].message.content`。
- **模型列表**：Anthropic 走 `GET /v1/models`（`x-api-key` 鉴权），复用同一解析。
- **错误映射**：401（Key 无效）/ 429（限流）继续走 `http_error_message` 中文友好文案，不透传原始错误。
- JSON 遵循仍靠 prompt 约束 + 既有 ```json 剥壳（Anthropic 不支持 `response_format`，未引入）。
- **流式**：当前诊断 / 翻译均为整段返回，无 SSE，本轮不涉及流式适配（任务书第三节按约定忽略）。

### 三、验证

- cargo test 67/67（ai 模块 15：含 Anthropic 端点拼接、消息净化、mock HTTP 服务器全链路双协议用例）。
- tsc 0 错；i18n 1313 条双向归零（新增 protocol / anthropic 提示词条）。
- 回归脚本全绿：check-ai-config（扩协议下拉框断言后 12 项）、ui-test、ui-theme-test、ui-polish、check-layout 54、check-contrast 26、check-motion 38。

### 四、构建与部署

- 正式包：`cyberdeck-launcher.exe` 8,607,232 B，md5 `FCF49BDFA23E212F05006161953620D0`。
- 2026-10-29 01:28 部署到 `release` 目录（旧版备份 `.prev.exe`），冒烟通过：`startup.log` 全链路 ok、`stage=frontend mods=195`、integrity=0x2000。

## 0.8.0-r20 — 发版前验收：下载中心重排 + 分类引擎 + 图标/细节（2026-10-29 00:20 → 01:00）

### 一、下载中心重排（P0）

- **剥离设置项**：下载目录 / 同时下载数 / 完成后自动导入 / 代理四张表单全部迁到「设置 → 工具组件 → 下载设置」卡；下载中心页不再是"全是表单的设置页"。
- **任务列表页**：新增全局操作条 `[全部开始] [全部暂停] [清除已完成] [打开文件夹]`——批量操作在前端逐个调既有单任务命令，**不新增 Tauri 命令**；行内保留 暂停/继续/取消/移除；新增「打开文件夹」（目录 = 队列设置 dir ?? `<数据目录>/downloads`，与 Rust 侧解析一致）。
- **空状态**：按任务书文案「暂无下载任务。请在 N 网点击 Mod Manager Download 自动接管。」。
- **约束兑现**：`download-progress` 事件监听（App 层 toast）原样未动；全部 invoke 命令名与参数未改。

### 二、P0 遗留修复

- **分类引擎**：`infer_category` 关键词扩到 9 组 60+ 词，ASCII 短词改整词匹配（旧版 `"car "` 尾随空格的 hack 会漏 "car"行首、`contains("cet")` 会误命中 cetocide）；新增 armor/jacket/hair/vehicle 等高频词。**新增 `reclassify_unclassified` 命令 + 库页「智能归类 (N)」按钮**：只动「其他」分类的模组（模组名优先于目录名，目录常是解压壳名），手动设置过的分类不碰，推断仍是「其他」的不产生写入。
- **图标与标题**：`assets/icon-cd.png`（1024²，沿用旧图视觉语言：黄底切角 + 黑 CD + 网格 + // 2077）经 `tauri icon` 重制全套（ico/png/Square*，android/ios 产物已清）；`assets/icon.png` 旧 NC 图标退役；窗口标题 `CyberDeck Launcher` → **`CyberDeck`**（productName 不动，exe 名不变）。
- **侧栏溢出**：`.game-link-row span`（未关联提示带长路径）加 `word-break: break-all` + `overflow-wrap: anywhere`；`.game-path` 补 `word-break`。

### 三、细节（P1/P2）

- **Logo 纯文字化**：删 r7 的几何 SVG，`.logo-mark` 黄块上直接压 19px/900 大号粗体「CD」，hover 光晕走 text-shadow。
- **删 Mono 主题**：`StyleTheme`/`STYLE_PRESETS`/`MODE_CAPABLE_STYLES` 摘除；老配置 `mono` 在 `readPersisted` 原样迁到 **modern（保留明暗偏好）**；`theme.presets.mono.*` 词条删除；styles.css 里 36 行 mono 选择器暂留（死代码零运行时成本，后续清理批次再剥）。
- **缩放 80%–150%**：三档按钮换滑块（step 5%），`clampScale` 钳到 0.8–1.5 并按 5% 取整，`scale: number` 贯穿三层 props。
- **超时输入框**：`.wolvenkit-timeout-row` 左右布局（标签左、输入框固定 120px 右对齐）。
- **WolvenKit/解压工具输入框**：加 `title` 属性悬停看全路径。

### 验证

- `cargo test` 64/64；`tsc` 0 错；i18n 双向归零（1305 条，含删 mono 词条与新增下载/归类词条）；ui-test 全量、polish/hardware/eula 20/layout 54/contrast 26/motion 38 全绿；**ui-theme-test 两处断言按新 UI 更新**（5 套主题、滑块设 110%/90%）。
- 演示（mock）截图核验：下载中心 = 操作条 + 空状态无表单；设置页下载设置卡完整（含免费账户并发提示）。
- **构建部署**：exe 8,585,216 B，md5 `C7F00C3EC47AF456222F68F45632FD16`；冒烟 `startup.log` 全链路 ok（`stage=frontend mods=195`、integrity=0x2000、数据目录 exe 同级）。
- 备注：tauri build 首次后台跑报 `vite build` exit 1（输出被截断只见 `errors: [Getter/Setter]`），单独前台重跑一次即通过、产物正常——判为后台并发瞬时问题，非代码问题，未复现。


## 0.8.0-r19 — 动效推广收尾：抽屉 / 弹窗 / 路由切换（2026-10-28 23:55 → 10-29 00:10 · 已构建部署）

r15 试点的 framer-motion 正式推广到其余三层动效，全部走 `motion.ts` 参数中心与 `useMotionSprings()` 主题差异化（赛博家族 400/20 机械感，modern/mono 柔和族）。

### 新增
- **抽屉滑入**：`ModDetailDrawer` 改 `motion.aside`，从右侧整幅滑入（`x: 100% → 0`，弹簧入场）+ 退场走贝塞尔快一档；遮罩只动 opacity（毛玻璃随 opacity 一起浮现，不动画 backdrop-filter——那是整屏重绘）。App 侧外包 `<AnimatePresence>`，退出动画期间 framer 继续渲染已移除的元素，`detailMod` 变 null 不闪空；`key` 用常量——抽屉里切换模组不会重新滑入一次。
- **弹窗弹入**：`ui.Modal`（10 处调用点一处覆盖）改 `AnimatePresence + ModalShell`，`scale 0.94 → 1` 弹入（0.9 起跳在 560px 宽弹窗上位移感过强；终点必须精确 1，停在 0.99x 文字会一直发虚）+ 遮罩淡入淡出。
- **路由切换**：视图区包 `<AnimatePresence mode="wait">` + `motion.div.view-stage`——旧页淡出偏左（0.1s）→ 新页从右 10px 轻滑入（0.2s）。`initial={false}`，冷启动不播"页面飞入"。
- **退场期间不挡点击**：`useIsPresent()` 在退场那 ~200ms 里给 portal 设 `pointerEvents: none`，否则整屏是一块透明挡板（自动化测试与真实双击都会踩）。
- `motion.ts` 新增工厂：`makeDrawerVariants / makeBackdropVariants / makeModalVariants / makeRouteVariants`（`animated=false` 返回时长 0 的瞬移三态——`MotionConfig reducedMotion` 只跳 transform 不跳 opacity，不能靠它兜底"关掉=瞬移"）。

### 变更
- CSS 互斥规则扩展：`data-motion="on"` 时 `.drawer / .drawer-backdrop / .modal / .page` 的 `@keyframes` 退位（JS 与 CSS 各推一套会闪帧）；新增 `.view-stage` 绝对定位贴满 `.content`（过渡期不参与文档流，`.page` 的 height:100% 解析不变）。
- **有意不做**：虚拟滚动卡片列表的 `layout` 补位动画——卡片按行号绝对定位且随滚动挂载/卸载，`layout`/入场动画会与虚拟化打架（快速滚动时闪帧）。决策记录在 motion.ts。

### 验证
- `check-motion.mjs` 扩到 **38/38**：新增 D（抽屉滑入采样 maxX=359px、终态归位、遮罩淡入、退场保挂载 + 不挡点击 + 彻底卸载）、E（弹窗 min scale 0.955 → 精确 1、退场行为）、F（路由过渡帧 minOpacity=0 / maxX=10px、全程 ≤1 个视图舞台、稳定后落设置页）、G（关动效后抽屉瞬现瞬退）。
- 回归全绿：ui-test 全量、ui-polish / ui-theme / ui-hardware、check-eula-gate 20、check-layout 54、check-contrast 26、`tsc` 0 错、`vite build` 通过。
- **构建部署**：`tauri build --no-bundle` → 8,577,536 B，md5 `8B34349F08D3D29F9D77777063A2DD42`，部署 release 目录（旧版备份 `.prev.exe`），冒烟启动 `stage=frontend mods=195`、integrity=0x2000。


## 0.8.0-r18 — 窗口缩放布局修复 + Modern 浅色对比度收尾（2026-10-28 23:05–23:50 · 已构建部署）

### 一、全局响应式骨架（P0）

- **侧栏底部挤压的真因**：`@media (max-width: 980px)` 把侧栏整体缩成 66px 图标条并 `display:none` 掉游戏路径 / STAGING / 版本号——窄窗口下这三块直接消失。本轮删除该整段媒体查询（窄窗口压缩的是 `flex:1` 的内容区，侧栏保持 260px 全功能）。
- **骨架重写**：`.app-shell` 锁死视口 + `overflow:hidden`（**必须用 100% 而不是 100vh/100vw**——body 上有 `zoom` UI 缩放，vh/vw 会被二次缩放，110% 挡位下外壳撑破视口，ui-theme 有断言）；`.app-body` 加 `min-width:0`；`.sidebar` 固定 260px + `height:100%` + `overflow:hidden`。
- **侧栏纵向三段式**：Logo 区 `flex-shrink:0`；新增 `.sidebar-scroll` 包裹导航区（`flex:1` + `overflow-y:auto`，超高自己滚）；`.sidebar-game/.sidebar-storage/.sidebar-collapse/.sidebar-footer` 一律 `flex:0 0 auto` 自然沉底，**不用绝对定位**。`.sidebar-spacer` 元素随之删除。
- **卡片网格**：`VirtualModGrid` 列数公式抽成 `CARD_MIN=300`（1920→4 列 / 1440→3 列 / 1280→2 列 / 极窄单列），即虚拟滚动版的 `repeat(auto-fill, minmax(300px,1fr))`。说明：任务书写的 320px 在 1440 窗口（内容宽 ~964px）只放得下 2 列 475px 的巨卡，实测后取 300 兜底。
- **工具条**：`.library-toolbar` 由固定 32px 改 `min-height` + `flex-wrap:wrap`，窄窗口按钮自动换行不再被右缘裁切。
- **Tabs 响应式**：`.nexus-tabs` 加 `overflow-x:auto` + `.nexus-tab` `white-space:nowrap`（设置页 Tabs 本就有横向滚动）。

### 二、Modern 浅色对比度（P0，r15 的落地收尾）

- 面包屑与小标签（`// SETTINGS / LOCAL CONFIG`、`// INTERFACE / PERSONALIZATION`）在 modern+light 下从强调色改为中性深灰 `#4b5563`。
- 侧栏选中项：`#f3f4f6` 底 + `#111827` 字，英文小字 `#4b5563`（6.46:1），选中边条保留主题色但只 2px。
- 主题预览卡选中态：卡内回归纸面白 `#fafbfc`，"MODERN" 等主题名一律 `#111827` 深黑，说明文字 `#374151`，强调色只留在边框与左侧色条。
- Modern 主题滚动条极细极淡：6px，浅色 `rgba(15,23,42,.14)` / 暗色 `rgba(255,255,255,.16)`。

### 三、验证与发布

- 新增 `scripts/check-layout.mjs`（54 项）：6 个窗口尺寸（1440×900 → 820×560）逐一断言——无横向溢出、侧栏底部三块可见且不重叠、工具条不裁切、卡片列数达标（最窄一档单列）。
- 全量回归：`check-layout` 54/54、`check-contrast` 26/26、`check-motion` 16/16、`check-eula-gate` 20/20、`ui-test` / `ui-polish-test` / `ui-theme-test` / `ui-hardware-test` 全绿；`tsc` 0 错；`cargo test` 64/64。
- **正式包**：`tauri build --no-bundle`（8,575,488 B，md5 `EAAE7D5159F81C8A392CE6F7D435EBBB`，与 `target/release` 产物 md5 一致），部署至 `release` 目录（旧 r13 版备份 `.prev.exe`），冒烟启动 `stage=frontend mods=195`、`integrity=0x2000`。本次构建包含 r14–r18 全部改动。
- **便携版**：`CyberDeck Launcher 0.8.0 便携版-可直接发人.zip`（4,081,142 B，带父文件夹结构 + 全新 `使用说明.txt`）。⚠️ 本轮发现并修复便携包缺陷：**全新解压的目录里没有 `cyberdeck-data` 时首跑会把数据落进 `%APPDATA%\com.arol.cyberdeck`**（resolve 逻辑是"exe 同级目录**已存在**才优先"）——修复 = 包内自带 `cyberdeck-data` 目录（含占位说明文件），解压实测 `stage=load ok dir=<exe同级>\cyberdeck-data`、`stage=frontend mods=195`。

---

## 0.8.0-r17 — 旧品牌残留全清 + 暂存目录失效修复（2026-10-28 22:47–23:05 · 已随 r18 构建发布）

> **前提**：用户明确本作尚未正式对外发布 → 无需兼容任何旧数据格式，`nightcity` 字面量可全部清除。若未来再改名，`origin` 这类**同时充当持久化值**的字符串必须配套数据迁移（本轮之所以能直接改，是因为落盘 195 条的 `origin` 全是 `adopted`，无一条 `nightcity`）。

### 一、`origin` 值统一为 `cyberdeck`（6 处）

- Rust：`schema.rs` `default_origin()`、`ai.rs`、`collection.rs`、`config_resolver.rs`、`installer.rs` 的 `origin: "nightcity".to_string()` → `"cyberdeck"`；`schema.rs` 的字段注释补全枚举说明（含 `adopted`）。
- 前端：`types.ts` 的 `ModOrigin` 联合类型、`mock.ts` 演示数据同步。
- 影响面核实：全仓只有 `ModCard.tsx:102` 用 `origin === "modpack"` 做判断，无任何分支依赖 `"nightcity"`；`origin` 也不参与 UI 文案（前端不展示该值）。故改值对界面零影响。

### 二、删除旧 modlist 表头兼容层

- 删除 `loadorder.rs` 的 `LEGACY_MANAGED_HEADERS = ["# Managed by NightCity Loader"]` 与 `is_managed_modlist()` 的双表头分支，现只认 `# Managed by CyberDeck Launcher`。
- 同步删除测试 `legacy_nightcity_header_still_managed`（其余 2 项表头测试保留）。
- **代价（已确认可接受）**：用户游戏目录里若存在 0.7.0 版写出的 `modlist.txt`，会被判为「非本启动器管理」（弹「备份并接管」）。实测本机 `Cyberpunk 2077\modlist.txt` 与 `r6\config\modlist.txt` **均不存在**（从未部署过），无实际文件受影响。

### 三、临时文件/目录前缀改为 `cyberdeck`

- `loadorder.rs`：`txt.nightcity-tmp` → `txt.cyberdeck-tmp`
- `modsettings.rs`：`user.ini.nightcity-{}.tmp` / `user.ini.nightcity.tmp` → `cyberdeck` 前缀
- `wolvenkit.rs`：`nightcity-wolvenkit-<uuid>` → `cyberdeck-wolvenkit-<uuid>`
- 均为**瞬时命名**，每次运行重新生成，不落盘复用，改前缀无残留风险（已确认 `cyberdeck-data` 下无 `*nightcity*` 残留文件）。

### 四、脚本与测试资产

- `mock.ts`：演示开关 localStorage 键 `nightcity-demo-no-nexus` → `cyberdeck-demo-no-nexus`（旧键失效仅影响该演示场景）。
- `check-legacy-state.mjs`：虚构旧状态的 `C:\Users\mc236\.nightcity.loader\staging` → `.cyberdeck.loader`、`origin` 同步；该脚本测的是「缺 `profiles` 字段不白屏」，改名不影响断言。
- `real-env-check.ps1`：写探针/硬链接测试文件 `.nightcity-*.tmp` → `.cyberdeck-*.tmp`，写入内容同步改。

### 五、修复：暂存目录失效后旧目录树被就地重建

- **现象（代码审查发现，非用户报障）**：`launcher-state.json` 的 `stagingDir` 仍写着 `D:\用户\工作区\CyberDeck-Launcher-0.7.0-release\cyberdeck-data\staging`，而该目录已随 r16 改名消失。
- **真因**：`store.rs` 的 `usable_staging_dir()` 先 `fs::create_dir_all(candidate)` 再写探测文件。父目录 `D:\用户\工作区` 可写 → 创建**必然成功** → 判定可用 → 把整条旧路径（含 `CyberDeck-Launcher-0.7.0-release\cyberdeck-data\staging`）原地复建出来，形成新旧两份数据目录并存。这与「数据目录分裂」事故同一类成因：**把「不存在」误判为「可用」**。
- **修复**：校验条件由「能创建且能写」改为「**必须已存在**且能写」，不再代为建目录；失效时由调用方（`Store::load`）回落到 `data_dir/staging` 并把实际生效位置写回状态（原有回落分支已具备，本轮只是让它真正能被触发）。
- **回归测试**：新增 `store::staging_dir_tests` 2 项——`missing_staging_dir_is_rejected_without_recreating_it`（断言返回 Err 且目录没被建出来）、`existing_staging_dir_is_accepted`。
- **副作用**：若用户曾把暂存区设在外接盘且该盘未挂载，现在会回落默认位置（原先会尝试在失效路径建目录）。属更安全的行为，且 `stderr` 记录原路径。

### 验证

- `cargo test`：**64 项全绿**（原 62 + 新增 2 项暂存目录测试；净减 1 项 legacy 表头测试）。
- `npx tsc --noEmit`：0 错。
- `node scripts/gate.mjs`：**12/12 全绿**（约 2 分钟，含 9 个 UI 脚本）。
- 全局残留复查：`grep -ril nightcity src/ src-tauri/src/ scripts/ tools/ dist/ package.json vite.config.ts index.html` → **0 命中**。

### 已知边界

- **exe 未重建**：`release\CyberDeck Launcher.exe` 仍是 10-28 02:08 的 r13，二进制内仍嵌旧字符串。要真正清除需 `tauri build`（建议与 r14–r17 的待构建内容一次性发布）。
- 未改：`localStorage` 键名 `ncl.ui.*`（改了会重置主题/语言/通知已读/EULA 同意状态，A3 决策仍有效）。
- 未改：`docs/` 下的历史事故报告与旧版报告文件名（按「历史事实不回改」约定保留）。
- 未删：`%APPDATA%\com.nightcity.loader`（11 MB，旧版运行时数据，非源码；`com.arol.cyberdeck` 已 84 MB 且为当前在用目录）。
- 未验证的部分：`stagingDir` 回落需下次启动程序才会实际触发并写回状态。

--- 

## 0.8.0-r16 — 目录规范化 + 版本号动态化 + 门禁 EULA 回归修复（2026-10-28 21:12–22:10 · 已随 r18 构建发布）

> 本轮只有工程结构与前端改动，**未 `tauri build`、未替换 release exe**。部署中的 exe 仍是 10-28 02:08 的 r13 正式包。

### 一、目录名称规范化

- 源码 `CyberDeck-Launcher-src-0.7.0` → `D:\用户\工作区\src`；产物 `CyberDeck-Launcher-0.7.0-release` → `D:\用户\工作区\release`。
- ⚠️ 改名**必然**断开 pnpm 的绝对路径软链（`node_modules/react -> /d/用户/工作区/CyberDeck-Launcher-src-0.7.0/node_modules/.pnpm/...`）。已用 `pnpm install --prefer-offline` 重装（15.1s，store 全命中共 19 个包），软链全部重绑到 `/d/用户/工作区/src/...`，`react`/`vite`/`@tauri-apps/cli` 解析验证通过。
- 改名前置动作：结束占用 release 的启动器进程（PID 2096）。
- `release` 清理 4 项（删前逐个记录 md5 与 mtime）：

| 文件 | 大小 | 时间 | md5 |
|---|---|---|---|
| `CyberDeck Launcher_0.7.0_x64-setup.exe` | 2,975,863 | 10-25 10:33 | `d6406e4d…` |
| `NightCity Loader.prev.exe` | 7,964,672 | 10-26 03:30 | `00b47116…` |
| `run-err.txt` | 363 | 10-26 12:17 | `bc7403d9…` |
| `run-out.txt` | 0 | 10-26 12:16 | `d41d8cd9…` |

- **保留**：`CyberDeck Launcher.exe`（`de41338e…`, 8,515,584 B）、`CyberDeck Launcher.prev.exe`（`864200341d…`, 8,438,272 B，最近回滚点）、`WebView2Loader.dll`、`cyberdeck-data/`（138MB 真实运行数据：launcher-state/secrets/staging/EBWebView/startup.log）。目录由 165MB 降至 155MB。

### 二、版本号：三处已统一 0.8.0，前端去硬编码

- 核实 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处均已是 `0.8.0`（10-28 02:08 批次已完成，本轮无需再改）。
- 新增 `src/lib/appVersion.ts`：`useAppVersion()` 为**唯一取数入口**，优先级 `Tauri app.getVersion()` → vite 注入 `__APP_VERSION__` → `"DEV"`（刻意不回退到任何看起来真实的号），结果进程内缓存。
- `vite.config.ts` 增加 `define.__APP_VERSION__`（从 `package.json` 的 version 注入，覆盖浏览器预览与 UI 测试）；新增 `src/global.d.ts` 声明该常量。
- **移除两处硬编码**：删除 `src/i18n/zh-CN.ts` 的 `app.version: "v0.7.0"` 键；`Sidebar.tsx`（侧边栏底部）与 `SettingsView.tsx`（设置→关于）改用 `useAppVersion()`。

### 三、新增 `AGENTS.md`（版本更新自动化规范）

项目根新增执行层规范，含：目录约定（含「改名必须重装依赖」告警）、三处 version 同步表 + 一行自检命令、前端禁硬编码（含违规 grep 自检）、打包输出动态命名（并点名 `CyberDeck Launcher 0.7.0 便携版-可直接发人.zip` 这类手写版本的反例）、git tag（明确标注仓库尚未 `git init`）、版本发布收尾 checklist、常用命令、安全红线、`release\cyberdeck-data` 不可当垃圾清、文档落点。

### 四、修复：门禁 UI 脚本 7/12 失败（r14 引入的回归）

- **现象**：`gate.mjs` 12 项中 7 项报 `<缺失>`（游戏更新熔断/平台选择器/右键菜单/播放集切换/体检面板/NXM/AI 配置），而「脏数据不白屏」「状态恢复」两项通过。
- **真因**：r14 把 EULA 门改为 `App.tsx:1744 inert={eulaAccepted ? undefined : true}` —— 未同意时**整个应用不可交互**；而 gate 跑的 9 个 `check-*.mjs` 只写了 `ncl.ui.preferences.v1`，没写 `ncl.ui.eulaAccepted.v1`，于是所有 `click` 都在等一个永远不可交互的元素直到超时。
- **对照实验**（决定性）：同一 `check-platform` 链路补上 EULA 标记后，`.platform-chip` 计数 = 5（断言要求 ≥2）、侧栏「设置」可点、`#settings-tab-game` 存在。证明与业务代码、与 r16 改动无关。
- **修复**：9 个脚本统一在 `addInitScript` 补 `localStorage.setItem("ncl.ui.eulaAccepted.v1", "true")`；`check-nxm.mjs` 无 init 块，单独补一段。换行符按各文件原样写入（2 个 CRLF、7 个 LF），复核无混用。
- **连带修复第二处**：`check-nxm.mjs` 断言 `/下载并导入/`，而 r10 文案整改已把按钮改成「下载导入」→ `installButtons=0`。改为 `/下载(并)?导入/` 兼容两种写法。
- EULA 门本身未削弱，仍由 `check-eula-gate.mjs` 专项覆盖。

### 五、其他

- `scripts/make-theme-thumbs.ps1` 补 UTF-8 BOM（含 11 行中文路径；PS 5.1 无 BOM 会按 GBK 解码并创建乱码目录，即 `D:\鐢ㄦ埛` 事故同源）。`real-env-check.ps1` 无中文，未改。
- `HANDOFF.md` 第 136/714 行、`README.md` 目录树更新为新路径；`check-elevation.ps1` 的 exe 探测路径改为 `D:\用户\工作区\release\CyberDeck Launcher.exe`。
- `docs/CHANGELOG-*`、`docs/INCIDENT-*`、历史报告里的旧路径按**历史事实**保留不回改。

### 验证

- `cargo check`：通过（10.14s，仅既有的 `WebView2Loader.dll not found` 提示级 warning）。
- `tsc --noEmit`：通过（首轮因 `appVersion.ts` 漏 `useState/useEffect` 导入报 2 处 TS2304，已修）。
- `vite build`：通过（3.09s）。
- `check-i18n.mjs`：0 处违规。
- `gate.mjs`：**12/12 全绿**（cargo test core-tests / tsc / vite build / 9 个 UI 脚本）。修复前 7/12 失败，补 EULA 标记后降至 1/12，修 NXM 文案选择器后归零。单次约 2 分钟（cargo 缓存热）。

### 已知边界

- `src-tauri/target` 原样保留；改名后 cargo 增量指纹部分失效，但首次 `cargo check` 仅 10s，增量缓存仍有效。
- `release\nightcity-data\`（1KB，仅 startup.log）为旧品牌名残留，**已于 2026-10-28 22:28 删除**。删前确认其 startup.log 记录的是 `data_dir=...\CyberDeck-Launcher-0.7.0-release\nightcity-data`、identifier `com.nightcity.loader` —— 即 0.7.0 旧 exe 的产物，与当前 0.8.0（`com.arol.cyberdeck` + `cyberdeck-data`）无关。⚠️ 若再手动运行 `CyberDeck Launcher.prev.exe`（0.7.0 回滚点），该目录会被重新创建，属预期行为。
- 源码内 `nightcity` 字样当时判断为「刻意保留」，**该结论已被 r17 推翻并执行清除**（项目尚未发布，无需兼容旧格式）；见 r17 段。保留的教训：`origin` 这类同时充当持久化值的字符串，一旦项目已发布就必须配套迁移才能改名。
- `scripts/tmp-swap-accent-text.py` 为 r15 批次遗留的临时脚本，本轮未清理（避免干扰并行工作）。

### 文档同步（2026-10-28 22:26–22:36）

- 网盘 `CyberDeck Launcher 项目文档`（`YbyPEuDRRBHW`）四份已同步：`AGENTS`（新增，`YKBTbrgbmFfy`）、`CHANGELOG`（覆盖，`YcqAkDZfRRJz`）、`HANDOFF`（覆盖，`YTyXPUSjLppj`）、`MEMORY-CANON`（覆盖，`YvOFDjiopXNv`）。
- 资料库 space `btCAC0glhsDub7qu3xaeLI` 四份已新增：AGENTS `u1fDUwN6Cwtd5wN1CYH6CA`、CHANGELOG `PP5CGG0sQraw3OnYaGf5DB`、HANDOFF `y19AdBbHIfwXxaiYLyupx1`、MEMORY-CANON `UJSaUB1Bn7U0oEWx45BR6r`（上一版 `zXY7BdgsSQG3bXDUcVpS0v` 已被取代，需移入「历史归档」或手删）。
- 两个 tdrive 坑已写进 MEMORY-CANON 第 3 节：`file_upload` 的 `q-ak` 会轮换，`InvalidAccessKeyId` 重新申请一次即可（不要反复重试同一份 headers）；`dir_list` 的 `size` 不随 overwrite 刷新，核实内容必须下载比对字节数（本轮已 `file_download` 验证 CHANGELOG 82,840 B、MEMORY-CANON 11,637 B 与本地一致）。

---

## 0.8.0-r15（2026-10-28 深夜 · 浅色对比度 + 抽屉专属配置 + 动效试点，已随 r18 构建发布）

### 修复：Modern 浅色主题对比度（P0）
- **根因**：玩家自选强调色（如 `#fcee0a`）会写进 `<html>` 内联 `--accent`，浅色主题里所有拿强调色当文字色的地方（面包屑、标题句点、侧栏选中项）都变成「亮黄字配白底」（1.2:1）。
- **修法（令牌层）**：新增 `--accent-text` / `--accent-text-rgb` / `--accent-text-hover`。全站 79 处 `color: var(--yellow|--accent)` 与 2 处 `rgba(--accent-rgb)` 文字色迁到 `--accent-text`；强调色作为填充（按钮底、边框、进度条）仍走 `--accent`，不受影响。
- Modern 浅色 `--accent-text: #1e40af`（8.7:1，AAA）；mono 浅色 `#1a1a1a`；深色主题 `--accent-text = --accent` 不变。
- **自定义强调色 WCAG 钳制**（preferences.ts）：浅色模式把文字用强调色逐档混黑到 ≥7:1，深色模式 ≥4.5:1；`--accent-ink` 逻辑不变（亮黄按钮自动配深字）。切换明暗时自动重算。
- 次要文字在浅色下去掉 opacity 压暗（面包屑 0.82 / 页面说明 0.88 会让对比度掉到 5.6 / 3.8），层级改由颜色分档承担；`--muted-2` 在浅色下加深到 4.8:1。
- 侧栏选中项（浅色）：浅灰底 `rgba(15,23,42,0.07)` + 深色文字。
- 硬编码黄清理：`.cover-upd`、`.drawer-update`、`.bell-head` 等 4 处改走令牌。
- **验证**：新增 `scripts/check-contrast.mjs`（26 项断言：modern-light 默认蓝 / modern-light 自定义亮黄 / ncpd 暗色三场景，逐选择器算 WCAG 对比度）26/26 通过；截图 `shots/contrast-modern-light-yellow.png`。

### 重构：Mod 设置收进详情抽屉（P1）
- 删除全局「Mod 设置」页与侧栏入口（`ModSettingsView.tsx` 删除，Sidebar/CommandPalette/App 分支摘除），命令面板原位换成「下载中心」。
- 新增 `ModSettingsPanel.tsx`：抽屉内「专属配置」折叠面板，打开抽屉即按 `modId` 自动加载；有配置渲染表单（开关/数字/文本），无配置显示「该 Mod 无独立配置项」，读不到文件平静显示「未检测到配置文件」（遵循文案克制的空状态原则）；底部「保存修改」只提交当前模组动过的字段。
- **写入安全（防误伤）**：`save_config_field` 前端只传 `source_id`，真实路径由后端重新解析（拒绝符号链接/越界/超大）；ini 走逐行 patch（`update_ini_text`），json 走值级 patch（键集合与其余值不变、拒绝凭空造键、类型不符拒绝）；写前一律 `.bak`。多个模组共用 `user.ini` 时只写目标 key，其它模组的 section 原样保留（有专项测试断言）。

### 后端：ConfigResolver 多框架配置解析（P1）
- `resolve_for_mod` 按优先级探五类来源：① Mod Settings `user.ini`（RED4ext 版优先，RED4ext/CET 模组通用）② 模组自己目录的 `config.json`/`settings.json`（从部署清单反查真实路径）③ Native Interactions `projects/*.json`（只读）④ AudioXL `.ini` ⑤ CET 全局 `config.json`（只读兜底，仅当模组带 CET 特征且无任何自有配置）。
- 纯内容层模组（ArchiveXL/TweakXL/REDmod）仍然返回空，不会造假表单。
- 新增 5 项单元测试（mod_json patch、共用 ini 防误伤、AudioXL 绑定、只读拒绝写、CET 全局兜底），config_resolver 12/12 通过。

### 新增：framer-motion 动效体系（试点，等手感确认后推广）
- `pnpm add framer-motion@14.7.1`；新增 `src/lib/motion.ts` 参数中心（三族弹簧 + overlay/backdrop variants 骨架 + indicatorLayoutId）。
- **试点 1**：设置页 Tabs 下划线 `layoutId` 补间（`springSnappy`）；动效关时退回 CSS `::after`，两套渲染互斥不会出现两条线。
- **试点 2**：ModCard 换 `motion.article`，`whileHover: y-3` + `whileTap: scale 0.984`（`springHover`）；`data-motion="on"` 时 CSS 的 hover translateY 退位，避免两套 transform 打架。
- **主题差异化弹簧**：`useMotionSprings()` 按 `styleTheme` 分两族——赛博家族（cyberpunk/ncpd/netrunner/arasaka/militech）用 400/20（阻尼比≈0.53，收尾有极轻过冲），modern/mono 沿用柔和族（480/38、360/34、520/30）。组件不再直接 import 常量。
- **总开关**：个性化 → 「界面动效」（`preferences.animations`，默认开）；落 `data-motion="on|off"`，off 时 CSS 过渡时长归零 + framer `MotionConfig reducedMotion="always"`；系统 prefers-reduced-motion 走 `reducedMotion="user"` 自动尊重。
- **验证**：新增 `scripts/check-motion.mjs` 16/16（下划线跟随/退位、悬停弹簧采样 0→-3px、开关往返、off 时 framer 卸载、主题弹簧曲线对比：ncpd min=-3.40 / modern min=-3.02）。
- 预埋未启用：`overlayVariants`/`backdropVariants` 给 Drawer、Modal、路由切换推广用。

### 验证汇总（r15）
- `cargo test` 全量通过；`tsc` 0 错；`npm run build` 通过；i18n 词表双向归零。
- UI 回归：ui-test（42 项）/ ui-polish / ui-theme / ui-hardware / check-eula-gate（20 项）/ check-contrast（26 项）/ check-motion（16 项）全绿。
- **未 `tauri build`、未部署、未打便携包**（等用户确认动效手感与抽屉交互后一起走发布流程）。

---

## 0.8.0-r14 — EULA 协议门渲染架构重构 + 浅色视觉细节（2026-10-28 20:35–21:05，仅前端，已随 r18 构建发布）

### r14 · 渲染架构（P0）

- **取消短路渲染**：`App.tsx` 删掉 `if (!eulaAccepted) return <EulaDialog/>`。主界面（含启动骨架/致命错误两种形态）照常渲染在底层，协议门变成一层盖在上面的全屏遮罩——首帧不再白屏/黑屏，用户能认出这是自己刚打开的软件。
- **遮罩拦截**：遮罩 `pointer-events: auto` + 底层 `app-shell` 切 `inert`（React 19 原生支持）双保险，鼠标点击与 Tab 焦点都进不去底层；`EulaDialog` 内再兜一层 Tab 焦点锁。全局快捷键（Ctrl+K / Ctrl+Enter）是 window 监听、inert 挡不住，单独加了 `!eulaAccepted` 守卫。
- **毛玻璃**：`backdrop-filter: blur(8px) brightness(0.6)`；赛博朋克四主题再叠 `rgba(var(--accent-rgb), 0.07)` 极淡主题色滤镜（NCPD 黄 / ARASAKA 红 / …），modern 保持纯净。不支持 backdrop-filter 时退化为纯压暗（0.82）。
- **平滑过渡**：点「同意继续」先播 260ms `opacity` 淡出（`EULA_FADE_MS` 与 CSS 对齐）再卸载遮罩；淡出期间 `pointer-events: none` 防误触。
- **防闪烁**：启动骨架（`!snapshot`）形态也挂同一遮罩，首帧即盖上。
- **回车确认**：勾选后按 Enter 即同意；按钮/协议正文里的回车有各自含义，不抢。

### r14 · 视觉与文案（P1）

- 删掉「三句话版本」小标题（`eula.summaryTitle` 词条同步删除，i18n 归零），直接展示三条摘要。
- 顶部装饰图标浅色下改用正文色 + 中性底（原 accent 色在白底上几乎不可见）。
- 「阅读全文」改为下划线链接样式 + ChevronDown 箭头，展开时箭头 180° 翻转，hover 加粗下划线。
- 浅色模式卡片边框改 `rgba(0,0,0,0.06)` 极淡灰边（原 accent 描边在白底上发灰），阴影同步调浅。
- 未勾选时「同意继续」改为明确的灰底禁用态（`panel-3` 底 + `muted-2` 字），不再依赖半透明。

### r14 · 验证与影响

- 新增 `scripts/check-eula-gate.mjs`（20 项断言全绿）：遮罩架构（shell 渲染+inert+backdrop-filter+pointer-events）、事件拦截（点击不穿透、Ctrl+K 被挡）、键盘流（勾选→Enter→淡出卸载→持久化）、浅色视觉（灰边/图标色/箭头翻转）。
- `ui-test.mjs` 旧断言「eula gate blocks the app」按新架构改写为「overlays the app（shell rendered but inert）」；四套 UI 回归全绿。
- tsc 0 错、vite build 通过、i18n 双向归零（1309 条）。
- 双主题截图：`shots/eula-gate-ncpd.png`、`shots/eula-gate-modern-light.png`。
- **边界**：仅前端改动，Rust 无涉及；`eula.viewer`（关于页查看）形态不受影响；未构建 exe、未部署、未打便携包（等用户本地确认效果）。

---

## 0.8.0-r13 — 下载中心 + 全面静态审查（2026-10-28 00:30–01:55）

### r12 · 通知分类门（与 r13 同批部署）

- **新增 `src/lib/notify.ts`**：`ToastCategory = download | deploy | conflict | update | system`。前四类可在设置里关掉；`system`（用户直接操作的即时反馈）永远放行、不出现在设置页。`conflict` 按需求强制开启，就算 localStorage 里存了 false 也拉回 true（双保险）。
- **门只拦 Toast**：52 处 toast 调用点集中在 App.tsx，签名加第 4 参 `category`（缺省 `system`），仅 15 处打扰型通知标注类别——改动面从 52 处压到 15 处。
- **有意为之的边界**：活动记录（铃铛面板）保留完整历史不被门拦——打开面板即清零角标，不构成打扰；静默它会丢操作痕迹。
- **设置页新增「通知」分区**（个性化之后）：四行开关 + 每行「测试」按钮（关掉的行按钮禁用，点了也不弹——测试按钮走的就是真门）。`SwitchRow` 增加 `action` 插槽；`onChange` 改为可选（强制开启的行不传）。
- 偏好持久化 `ncl.ui.notifications.v1`，独立于外观偏好。

### r13 · 下载中心

- **新后端模块 `src-tauri/src/download_queue.rs`**（约 900 行 + 5 项单测）：
  - 队列并发 1-3；**HTTP Range 断点续传**（`.part` 保留，暂停/失败/重启后续传字节不归零；服务端不支持 Range 回 200 时自动重头）。
  - **429 自动挂起重试**：按 `Retry-After` 头（缺省 30s、上限 300s、最多 5 次）回 Queued 并倒计时，等待期间响应暂停/取消。
  - **免 Key 通道**：NXM 链接自带的 `key`/`expires` 直接调 `download_link.json`（不带 apikey 头），免费账号从 N 网点「Mod manager download」即可直下——此前必须填 API Key。
  - **独立持久化 `download-queue.json`**（数据目录内）：不碰主状态文件 schema（7b 红线）；坏 JSON 静默归零不拖垮启动器；重启时 Downloading 拉回 Queued（线程已死）；写临时文件再 rename 防半写。
  - 完成后可选自动导入：复用 `installer::install_archive` 同一管线；导入失败不影响任务完成态，ZIP 保留并单独报错。
  - worker 崩溃兜底：`catch_unwind` 把卡死的 Downloading 落成 Failed，绝不变砖。
  - 下载客户端**不设总超时**（只限连接 12s）——旧 nexus.rs 的 30s 总超时对大文件是隐患；支持 HTTP 代理。
- **前端 `DownloadsView.tsx`**：设置卡（目录/并发 1-2-3/自动导入/代理）+ 队列列表（暂停/继续/取消/移除/清理已完成），1.2s 轮询（浏览器 mock 与真后端同一条路）；进度条赛博主题为动态数据流条纹、现代主题纯色。侧栏新增「下载中心」导航 + 活动任务数角标（3s 轮询）。
- **NXM 接收条改走队列**：点「下载并导入」→ 入队（带签名）→ toast「已加入下载队列」→ 完成事件回收接收条。`nexusDownload` 直连路径保留未删（r13 未用）。
- 完成事件 `download-status`（含 name/modId/fileId）：完成 → toast（download 类别，可被通知门关掉）+ 活动记录；失败 → 错误 toast。

### r13 · 全面静态审查（四模块，先审后修）

1. **Rust 后端崩溃风险**：全仓非测试代码 unwrap/expect 共 34 处，逐一核验——锁中毒 `expect` 30 处（项目统一约定）、编译期字面量正则 2 处、Tauri 启动 expect 1 处，**零真风险**。Zip Slip 三层防护确认（`enclosed_name` + `safe_join` 拒 `..`/盘符 + 条目/体积上限）；`restore_backup` 持锁调用不重入锁；队列锁内无 IO。
2. **前端健壮性**：依赖全有引用（`@tauri-apps/plugin-opener` 为脚手架残留：Rust 注册但无人调用，删除风险大于收益，保留并记录）；AppErrorBoundary 已存在，**新增 `main.tsx` 全局 `unhandledrejection`/`error` 兜底**（异步错误不再静默消失）；全部定时器/事件监听清理配对核验通过。
3. **业务边界**：**新增 5 项 download_queue 单测**（入队拒绝/状态机/断电恢复/坏文件容忍/设置持久化，测试互斥锁防全局单例污染）；`.part` 清理路径审计（取消/0 字节/8GB 删，失败/暂停留作续传——语义正确）；**修 dependencies.ts 一处依赖误判**：`CET Framework` 这类带后缀的框架条目此前会被提示"需要 CET"，缩写 `cet` 补进框架名单（空格要求挡掉 Cetmix 形似名，与 Rust 侧 `is_framework_name` 对齐）。
4. **文案规范**：敬语句式/AI 腔高频词零命中；按钮长度 8 处超 4 字的逐一定性为危险确认/功能所需，按 7f 规则（不能拿更早快照当基准）不动；i18n 双向归零（1310 条）。

### 顺手修掉的既有缺陷（与本批功能无关，审查中发现）

- **ai.rs 两个测试并行跑必挂的 flaky**（历史遗留）：mock 服务器单次 `read(16KB)` 不保证读全请求 → 断言随机失败。新增 `read_http_request` 按 Content-Length 读全。**坑：hyper 写 HTTP/1.1 头是小写 `content-length:`**，第一版大小写敏感匹配仍然漏 → 修成大小写无关后连跑 8 次全绿。这条对任何手写 TCP mock 都适用。
- `nexus::safe_download_name` 改 `pub(crate)` 供队列复用。

### 验证

- Rust 58 项（53 + 队列 5 新增）连跑 8 次全绿；core-tests 99+1 全绿；`tsc --noEmit` 0 错；`vite build` 通过；i18n 守卫双向归零（1310 条，死条目 0）；四套 UI 回归全绿（下载页 9 项专项断言 + 三套主题截图核对）。
- 中途出现过一次 `nexus user shown` 回归失败，复跑通过——为后台 cargo test 抢占 CPU 导致的等待超时 flake，非代码回归。

---

## 0.8.0-r11 — 首启使用协议 + 侧栏品牌图标（2026-10-28 00:05–00:25）

**仅前端；已 `tauri build` 并部署 release 目录 exe。未重打便携版。**

### 一、首启强制同意（新增）

- `src/assets/eula.md` 收录协议正文六节；构建时用 Vite `?raw` 内联成字符串，**不存在运行时读取失败**这条路径，仍保留解析为空时的摘要兜底。
- `src/lib/markdownLite.ts`：自写极简解析（标题/列表/段落/行内加粗）。不引 `react-markdown`——协议只用到这几种块，而离线装依赖在本项目是已知麻烦。
- `src/components/EulaDialog.tsx`：一套排版两种形态。
  - `gate`：遮罩不可点、无关闭按钮、Esc 不关；勾选前「同意继续」禁用；出口只有同意或拒绝退出（`getCurrentWindow().close()`）。
  - `viewer`：设置 → 关于 →「许可协议」，只展示可随时关。
- 状态存 `ncl.ui.eulaAccepted.v1`（沿用 `ncl.ui.*` 前缀）。独立成键而非塞进 `preferences.v1`：偏好随时会被重写，「重置外观」不该顺带把协议同意状态清掉。
- 首启时 App 直接 `return <EulaDialog mode="gate" />`，主界面完全不渲染，不做"遮一层但仍加载"。

### 二、侧栏品牌图标（替换）

- `.logo-mark` 内的 `N`/`C` 两个 `<span>` 和小方块换成内联 `<svg>`：切角八边形外框 + 中心节点 + 四条引出线，纯几何、不含字母。
- 颜色走 `currentColor`，前景用 `--accent-ink` 而不是 `--bg`——现代亮色主题里 `--bg` 是纯白，压在 accent 色块上会和底色撞掉。
- hover 微光挂在 svg 自己身上：`.logo-mark` 有 `clip-path`，挂在容器上的 `drop-shadow` 会被裁掉。

### 三、文案合规（对齐 r10 规范）

摘要三条与按钮按 r10 的四禁令/场景规则写：去掉敬语「请」（→「记得定期备份存档」）、按钮压到 4 字（「阅读全文」「收起全文」「同意继续」「拒绝退出」「许可协议」）。摘要里的「免费开源」改为「免费使用」——协议正文只承诺免费，没承诺开源。

### 四、回归脚本同步

- `ui-test.mjs` 新增 5 项门断言（拦截生效 / 勾选前禁用 / 摘要三条 / 全文渲染 / 同意后消失）。
- **门必须用独立 context 验**：主流程会为设置页另开一页，而 `context.addInitScript` 每页都跑，一直 `localStorage.clear()` 会把同意标记一起清掉，第二页又弹一次门。
- 其余三套脚本改为「清空后直接置为已同意」，不重复验门。

### 五、验证

`tsc --noEmit` 0 错 · `i18n:gate` 0 处硬编码 · `i18n:unused` 0（1260 条）· `vite build` 通过 · 四套 UI 回归全绿（含新增门断言）· 赛博 / 现代亮 / 现代暗三套主题截图逐张核对，Logo 与弹窗对比度、切角、滚动区均正常。

---

## 0.8.0-r10 — UI 文案规范整改（2026-10-27 23:00–23:55）

**仅前端文案；未 `tauri build`、未重打便携版。**

### 一、依据

《CyberDeck UI 文案编写规范》：四条绝对禁令（防御性免责 / 敬语 / 解释技术废话 / 情绪化安抚）+ 七个场景（按钮 ≤4 字、去主语、空态、报错、弹窗、引导、关于页）。

### 二、改了 66 条

| 规则 | 条数 | 典型 |
|---|---|---|
| 禁令 2 敬语 | 13 | 「恢复前请不要导入」→「恢复前不要导入」；「请先升级 RED4ext」→「先升级 RED4ext」 |
| 禁令 1 防御性免责 | 4 | 「所有配置保存在本机，不上传」→ 直接删（旁边已有 LOCAL ONLY 徽标）；「不解析、不上传」→「不解析」 |
| 场景 1 按钮 ≤4 字 | 47 | 「我已更新前置，解除锁定」→「解除锁定」；「禁用冲突模组并重试」→「禁用重试」；「查看日志内容（末尾 100 行）」→「查看日志」 |
| 场景 2 去主语 | 1 | 「点击定位游戏目录」→「定位游戏目录」 |
| 引用同步 | 1 | 按钮改名后，说明里引用的按钮名同步（「使用「提取关键错误」时」→「提取错误」） |

### 三、做法（两个关键决定）

1. **提取用 TypeScript AST，不用正则**：第一遍正则只认「同一行 `>文本<`」，多行 JSX 文本节点全漏——扫出 4 条「请」，实际有 13 条。改用 `ts.createSourceFile` 遍历 `JsxText` + `StringLiteral` + `jsx` 属性值，1290 条全量、带行号，且能区分注释。
2. **替换写成「数据表 + 幂等脚本」**：每条含（文件、原文、新文、依据条款、理由、是否允许多处命中）；`_apply2.py` 先在内存里按顺序累积应用，命中数不符立即判失败并退出，绝不盲改；读写都 `newline=''`，CRLF 文件不被改写。
3. **改完必须回读三元分支**：`LibraryView` 空库标题是 `mods.length === 0 ? A : B`，第二轮误把「筛选无结果」的提示填进了「库完全为空」分支——能编译、能构建，但对空库用户是错的指引。字面替换查不出条件分支错位。

### 验证

- `tsc --noEmit` **0 错**；`vite build` 通过（2.18s）；`npm run i18n:gate` **0 处硬编码中文**；
- 词表 1246 条重扫：敬语「请/您/抱歉/哦/啦/呀」**0**，免责句式 **0**；
- 146 个 `<button>` 经 `t()` 解析成实际文案后按汉字数判定：**纯文字按钮全部 ≤4 字**，剩余「超长」项全部是三元分支（`禁用/启用`）或卡片式结构（冲突卡片的「角色 + 状态 + 路径」）；
- 每条 `len(new) <= len(old)`，不存在变长撑破布局的风险。

### 五、与 i18n 迁移的交接

本轮先在组件内落地 62 条，随后 i18n 全量迁移把这些文案抽成了词条（`diagnostics.startAdopt: "开始收编"`、`conflictDialog.disableRetry: "禁用重试"`、`library.importZip: "导入 ZIP"`…），**短文案被继承**；迁移后复查词表，又补了 4 条：`showPayload` / `hidePayload`（「查看/隐藏发送内容」→「查看/隐藏内容」）、`extractErrors`（「提取关键错误」→「提取错误」）以及引用该按钮名的说明文案。

改名连带同步：`scripts/ui-polish-test.mjs` 的按钮名断言、`README.md` ×3、`docs/ARCHITECTURE.md` ×1、`.i18n-parts/A.json` ×4（避免下次合片段把旧值合回来）。

**规则：以后改文案只改 `src/i18n/zh-CN.ts`，组件里已没有面向用户的字符串。**

### 六、已知边界

- **exe 未重打**：release 目录里的 exe 是 r9（22:50）产物，不含本轮 4 条词表改动。
- **49 条超过 50 字的长说明**未动：规范要求这类文案进 Help/FAQ 折叠面板，属加组件改交互，另开一项。
- `ui-polish-test.mjs` 的断言已同步，但**未实跑**（需起预览环境）；`tsc`/`build`/`i18n:gate` 已确认不受影响。

---

## 0.8.0-r9 — i18n 全量迁移收尾 + 品牌残留修复（2026-10-27 21:55–22:20）

**仅前端 + 少量 Rust；已 `tauri build --no-bundle` 并部署到 release 目录（22:50），未打包便携版。**

### 一、i18n 全量迁移（1207 → 0）

- **规模**：词表 `src/i18n/zh-CN.ts` 收敛到 **1246 条**（清理 14 条无人引用的 `common.*` 储备项后），覆盖 37 个文件；`npm run i18n:gate` 归零、`npm run i18n:unused` 归零。
- **并行迁移流程**：App.tsx 与 SettingsView、lib 层分三路；子代理只改组件并把词条产出到 `.i18n-parts/*.json`（扁平点路径），由主流程用 `scripts/merge-i18n-parts.mjs` 统一合并——幂等，且对「上级已是字符串」「同 key 不同值」直接报错。合并脚本用 `fileURLToPath` 还原中文路径（`URL.pathname` 是百分号编码的，直接用会 ENOENT）。
- **B 类数据值（不可翻译，只做显示映射）**：`CATEGORIES`（持久化分类值）、`InstallLayout`、主题预设名、集合状态、依赖原因、AI 预设文案——数据里存 `MessageKey` 类型的 key 字符串（`labelKey` / `reasonKey` 等）或经 `categoryLabel()` 显式对照表（缺映射时**原样返回入参**，绝不漏裸 key）。
- **守卫脚本增强**：`--unused` 反向检查（词表里有、源码没用）；豁免支持行内 `// i18n-ignore` 与区块 `// i18n-ignore-start/end`。key 匹配用自定界 token 正则——「成对引号」正则在同一行有多个字符串（尤其 `: ""` 空串）时会配对错位，把 `t("palette.modDeployed")` 误判成没被引用。
- **文案基准纠正（原「词汇漂移修复」已回退）**：迁移后我曾用 r7 轮留下的 `文案全量清单.csv` 做逐字比对，把 13 处更短的文案判成「抽取时被擅自改短」并改回清单原文。**这个判断是错的**：r7 的「全局文案去 AI 味」是另一个会话的成果，那份 CSV 是去 AI 味**之前**的快照，短的那一版才是当前应有的文案。13 处已全部回退到迁移时的源码原样（「保存分类」「查看日志」「恢复原状」×2「深度扫描」「清空任务」「开始收编」「一键修复环境」「解除锁定」「按序部署了…」「到模组页查看」「通过 Nexus API 下载导入」「定位游戏目录」「返回完整」）。**规则：文案回归的基准只能是「抽取当时的源码」，不能拿更早的审查快照做逐字比对——快照一旦落后于并行会话的文案改写，方向就是反的。**
- **UI 回归断言同步（4 处）**：`ui-test.mjs` 的「保存分类并关闭」「查看日志内容」、`ui-polish-test.mjs` 的「查看日志内容」「恢复原始状态」（×2）是去 AI 味**之前**写下的旧期望值，与词表不一致；已按当前文案改为 `/保存分类/`、`/查看日志/`、`/恢复原状/`。为避免再出现零散遗漏，用一次性比对脚本核对：把四个脚本里的中文正则 / `name:` 断言全部提取，逐段与 `zh-CN.ts` 的词条值比对，**只剩这 4 处**，其余全对得上。
- **文档里的 UI 名称同步（5 处）**：文案变了，文档里直接引用按钮名的位置就成了死引用——`README.md`（防误触表 ×2）、`docs/ARCHITECTURE.md`（恢复语义）、`docs/REAL-ENV-TEST.md`（日志入口 + 恢复步骤）、`docs/PROJECT_HISTORY.md#night-shift`（熔断横幅按钮）已按当前文案更新为「恢复原状」「查看日志」「解除锁定」。
- **验证**：`tsc --noEmit` 0 错；`vite build` 通过；`i18n:gate` / `i18n:unused` 双向归零（1246 条，死条目 0）；四套 UI 回归（ui-test / polish / theme / hardware）**在文案回退后复跑全绿**；Rust 53 项 + core-tests 99+1 项全绿。
- **构建与部署（2026-10-27 22:50）**：`tauri build --no-bundle`（`CARGO_PROFILE_RELEASE_LTO=false`）2m05s，产物 `src-tauri/target/release/cyberdeck-launcher.exe` **8,435,200 B**，md5 `49a25cb90483523eccf7af947dff00f2`。旧 exe 备份为 `CyberDeck Launcher.prev.exe`（md5 `451d7496…`），新 exe 已就位并启动验证：`startup.log` 记录 `stage=resolve → load ok → tray ok → lifecycle ok → **stage=frontend mods=195**`，数据完好、前端正常挂载。**便携版未打包**（按规矩等用户确认）。

### 二、品牌残留修复（品牌更名遗漏排查）

1. **🔴 `modlist.txt` 管理标记不兼容（实质缺陷）**：`MANAGED_HEADER` 在 2026-10-26 更名时从 `# Managed by NightCity Loader` 改成 `# Managed by CyberDeck Launcher`，但它在 6 处被用作**识别判据**（`starts_with`）——老用户游戏目录里由旧版写出的 modlist.txt 会被判成「不是本启动器写的」：误弹「备份并接管」，或拒绝移除自己的文件。已从旧 exe 二进制取证确认旧标记原文，新增 `loadorder::is_managed_modlist()`（两代标记都认，写入永远用新标记，下次写入自然升级），替换全部 6 处判据，补 3 项回归测试。
2. **AI 客户端 User-Agent**：`NightCityLoader/{version}` → `CyberDeckLauncher/{version}`（外发给 AI 服务商标识）。
3. **启动页品牌字形**：`NIGHTCITY LOADER` → `CYBERDECK LOADER`，`NC` 字形 → `CD`（本就走词表，值修正）。
4. **测试 crate**：`nightcity-core-tests` → `cyberdeck-core-tests`，探测临时目录前缀 `ncl-probe-repeat-` → `cdl-probe-repeat-`。
5. **确认为有意保留（兼容锚点，不动）**：持久化 `origin: "nightcity"`、临时文件前缀 `*.nightcity-tmp` / `nightcity-wolvenkit-*`、localStorage `ncl.ui.*`、`docs/REPORT-*.md` 等历史文档标题（记录当时事实）。

### 已知边界

- `docs/ARCHITECTURE.md` 与本文件描述的 `is_managed_modlist` 兼容逻辑需要随下次 `tauri build` 才进 exe；**当前 release 目录里的 exe 还是旧逻辑**（但对老用户反而是「误报 unmanaged」级别的问题，建议下次构建时一并带上）。
- 结构化文案拆段（`confirm.restore.detailPrefix/Middle/Suffix`）在换语序的语言时需改富文本占位方案，见 `docs/I18N.md` §8。

---

## 0.8.0-r8 — i18n 预留架构（2026-10-27 21:06–21:15）

- **背景**：界面文案全部硬编码在 30+ 个组件里（脚本实测 **1207 处 / 37 个文件**）。暂不做多语言，但要把「文案」与「代码」解耦，避免将来国际化时重写 UI 层。
- **边界（用户明确要求）**：**不引入** `react-i18next` 等库、**不实现**语言切换、**不新增**运行时依赖；只建立占位契约，未来替换 `t` 的实现即可。

### 新增

- `src/i18n/zh-CN.ts` —— 唯一文案来源。嵌套命名空间（`app` / `common` / `titleBar` / `sidebar` / `topBar` / `settings` / `errorBoundary` / `danger`），支持 `{name}` 插值，`as const` 提供字面量类型。
- `src/i18n/index.ts` —— 占位实现：
  - `t(key, vars?)`：查表 + 插值；key 不存在时**返回 key 本身**并在 DEV 下 `console.warn`（错误可见，不静默空白）；
  - `MessageKey`：由词表结构递归推导的字面量联合 —— **key 拼错会在 `tsc --noEmit` 阶段报错**；
  - `tDyn(key)`：动态拼装 key 的逃生口（不校验，仅 `settings.tabs.${id}` 这类场景）；
  - 不用 React Context：`t` 需在模块级常量、事件回调、class 组件里同步可调。
- `scripts/check-i18n.mjs` —— 守卫脚本。剥注释后扫 `\p{Script=Han}`，输出按文件的剩余条数；`--list` 逐条打印、`--fail` 作门禁。行内 `// i18n-ignore` 可豁免（开发者日志用）。`package.json` 增加 `i18n:check` / `i18n:list` / `i18n:gate`。
- `docs/I18N.md` —— 规则、契约、命名空间约定、剩余清单与推进顺序、未来接真库的四步。

### 迁移（8 个文件，1207 → 1055 处）

| 文件 | 迁移内容 |
|---|---|
| `SettingsTabs.tsx` | 六个 tab 的 label、`aria-label` |
| `Sidebar.tsx` | NAV 的 label/en、品牌块、GAME LINK、STAGING 计量、折叠按钮、页脚版本 |
| `TopBar.tsx` | 游戏胶囊、搜索占位、播放集说明、通知中心（标题/未读/空态）、导入、启动按钮 |
| `TitleBar.tsx` | 品牌串、build 标识、DEMO 标记、三个窗控 `aria-label` |
| `ui.tsx` | Toggle / Spinner / Modal / ConfirmDialog / ToastHost 的默认文案与 aria |
| `AppErrorBoundary.tsx` | 兜底页标题/正文/重载/复制按钮 |
| `ModCardErrorBoundary.tsx` | 卡片错误码 |
| `DangerConfirmModal.tsx` | 按住确认的 aria 与三段提示；顺带把 `(holdMs/1000).toFixed(1)` 提为 `holdSeconds`，消除两处格式漂移 |

### 验证

- `tsc --noEmit`：**0 错误**（含 `MessageKey` 类型校验）。
- `vite build`：成功，产物正常（`index-Dp0ZbG8v.js` 499.60 kB / gzip 154.29 kB）。
- `node scripts/check-i18n.mjs`：剩余 1055 处 / 30 个文件（清单已入 `docs/I18N.md`）。

### 已知边界

- **未做 Rust 侧文案**：`startup.log`、原生确认框（`rfd`）文案仍是硬编码，属托盘/退出链路，后续单独一轮。
- **`TitleBar` 仍显示旧品牌 `NIGHTCITY` / `NC/ML 0.7.0`**：本次只搬运不改值（已存入 `titleBar.brandName`），确认后一处替换即可。**（已回退/已在 r9 解决：`titleBar.*` 已改为 CYBERDECK / CDL 0.7.0）**
- **数据值型中文**（`types.ts` 的模组分类、`lib/format.ts` 的相对时间）需单独设计「稳定 id + 显示名」分离，不能简单搬进词表。**（已在 r9 完成：`categoryLabel()` + `LAYOUT_LABEL_KEY` + `*Key` 字段，见 docs/I18N.md §5）**
- **未构建 exe、未部署**：按用户 2026-10-26 立规，便携版打包前必须先询问。

---

## 0.8.0-r7 — 全局 UI 文案去 AI 味（2026-10-27 20:45–20:58）

- **背景**：设置项说明、弹窗正文、tooltip 里有大量「AI 生成痕迹」——防御性免责（「是否写入游戏由你决定」「永远不会自动删除」）、一条描述里解释两件事、对外暴露内部实现（`标记头`、`导入链路`、`副作用最小`）、同一状态四种写法。目标风格是「老练的独立开发者在写工具」：专业、克制、直白。
- **做法（脚本化，不靠肉眼改）**：
  1. `_extract.py` 剥离注释后提取 `src/` 全部含中文的字符串字面量、模板字符串、JSX 文本节点与 `title / placeholder / description / aria-label` 属性 —— **1075 条**（46 个 ts/tsx 中 39 个含中文）；
  2. 按四条判据逐条判定：能否再砍字 / 是否在替用户预先担心 / 是否外露内部实现 / 同概念是否多种写法；
  3. `_changes.py` 存改动数据源，`_apply.py` 做「字面匹配 + 唯一性校验」替换（命中数不为 1 即中止），`_verify.py` 反向替换还原校验；
  4. **先在影子工程 `_shadow/` 预演**（src 副本 + node_modules 目录联接），tsc/build 全绿后才落真实源码；原 src 快照留在 `文案审查/_src-backup`。
- **改动规模**：24 个文件、**105 处**字符串、102 行。全量清单与报告见 `D:\用户\工作区\文案审查\`（`文案审查报告.md`、`文案全量清单.csv`、`改动预览.diff`）。
- **六类问题与代表改动**：

  | 类型 | 条数 | 代表 |
  |---|---|---|
  | 防御性表达 | 18 | 「.zip / .7z / .rar · 只进暂存区，是否写入游戏由你决定」→「…只进暂存区，不写游戏」；「永远不会自动删除或覆盖」→「不会自动删除或覆盖」 |
  | 冗长 | 52 | 「启动器已登记它们：现在可以禁用、卸载、参与冲突检测」→「已登记：可禁用、卸载、参与冲突检测」 |
  | 书面腔 | 19 | 「其他格式**请**先解压」→「其他格式先解压」；「留空**表示**不改变已保存的 Key」→「留空则不改动…」 |
  | 术语不统一 | 10 | 安装/导入 → 统一「导入」；版本不符/不一致 → 「版本不一致」；「尚未定位游戏 / 游戏目录还没有链接 / 还没定位游戏目录」→ 「未定位游戏目录」 |
  | 语病 | 4 | 「启动器会先按 `<code>` 清单撤掉…」语序读不通 → 「按 … 清单撤掉…」；「拖加载顺序不能解决它」→「排序解决不了这类冲突」 |
  | 空态 | 1 | 「系统就绪，等待注入组件」→「换个关键词，或切回「全部」。」 |

- **明确不改**：安全警告（卸载/退出类）、AI 隐私授权勾选、`deployed_files` / 硬链接 / WolvenKit 等技术术语、`lib/mock.ts` 116 条演示数据、两字分类名。
- **验证**：`tsc --noEmit` 退出码 0；`vite build` 通过（`index-QFHpnyWi.js`）；落盘后按 `_changes.py` 从原 src 快照重放，结果与真实文件**逐字节一致**（24 文件 / 105 处 / 102 行，0 异常）；换行符分布与原件一致。
- **落盘后自查抓到并修掉一处语义错误**：模组库空态标题是三元表达式 `search ? "没有匹配的模组" : mods.length === 0 ? … : "这个分类还没有模组"`，第二个分支是「库完全为空」而不是「筛选无结果」。我最初把它替换成「换个关键词，或切回『全部』。」——能编译、能构建，但对空库用户是错的指引。已改为「还没有任何模组」。**这类错误只有回读三元/条件上下文才能发现，跨行替换脚本查不出来**，故本次专门加了「改动文案是否出现在比较 / 映射键 / 三元分支」的扫描（3 处命中全部人工确认：2 处为展示分支，1 处为同行的无关比较）。
- **已知边界**：未实现「按主题切换语气」（赛博主题「已挂载/断开链接」vs 现代主题「已启用/禁用」）——需读主题状态选词，属改逻辑，另开一项；`lib/mock.ts` 演示数据保持原样（仅影响浏览器预览）。
- **得失复盘（工具链缺陷，落盘前拦住）**：
  - **现象**：影子工程 `App.tsx` 被整文件改写成 LF，原文件是 CRLF（1931 行全部「变更」），一旦直接落盘，diff 会把 105 处文案改动淹没在 1931 行假变更里，回滚与 review 都无法进行。
  - **真因**：`open(...)` 默认 `newline=None` 做通用换行翻译，读取时 CRLF→LF；写回时 `newline=''` 不翻译，于是换行符被永久改写。读写两端语义不一致。
  - **走过的错误假设**：以为「只做字符串 replace，其余字节不动」——文本模式下的换行翻译不在 `replace` 管辖范围内，`str.replace` 的精确性给了假的安全感。
  - **代价**：影子预演一次 + 脚本返工 + 复验一轮（约 10 分钟），但零污染真实源码。
  - **新约束**：任何「字节级只改一处」的批量编辑，读写都必须 `newline=''`，并在落盘前用二进制比对校验换行符分布（`\r\n` 计数）是否与原件一致。
  - **下次第一步查什么**：批量改文件前先跑 `open(p,'rb').read().count(b'\r\n')`，确认目标文件是 CRLF 还是 LF，再看脚本是否保持。


---

## 0.8.0-r6 — AI 接入去服务商化（2026-10-27 20:36–21:05）

- **背景**：AI 接入已从「只支持 DeepSeek」改成「任何兼容 OpenAI 协议的端点」，但设置页/诊断面板仍留着单一服务商的痕迹——徽标直接显示模型名（看起来像品牌标签）、占位符与错误文案写死 DeepSeek、诊断面板「获取 Key」在没有预设时兜底跳 DeepSeek 控制台、出厂默认值仍是 DeepSeek 端点。
- **界面口径统一到协议层**：
  - 徽标：`{模型名}` → **`OPENAI 兼容`**（两处：设置页 AI 卡片、智能诊断卡片）；模型名改在诊断面板正文如实显示（`当前模型 xxx`），信息不丢、也不冒充实品牌。
  - 占位符：`https://api.deepseek.com/v1` → `https://api.openai.com/v1`，`deepseek-v4-flash` → `gpt-5.4-nano`。
  - 兼容说明：改为「任何兼容标准 OpenAI /v1/chat/completions 接口的服务都能接入」并以 OpenAI 起头；补一句「地址填到版本段（如 /v1），程序自动补 /chat/completions」。
  - 日志查看器同意文案：`发送到 DeepSeek` → `发送到已配置的 AI 服务`。
- **修掉一处真实不一致**：预设下拉框的状态是本地 state，默认永远停在「手动配置…」，于是保存过预设的配置显示成「手动配置 + 一堆像手填的值」。新增 `matchAiPreset(baseUrl, model)`（归一化去尾斜杠 / `/chat/completions` / 版本段后比对，地址与模型名**同时**命中才算），下拉框现在反映真实配置。
- **去掉硬编码兜底**：诊断面板的「获取 Key」在未选预设时会跳 `platform.deepseek.com`；改成「只有能确定服务商（选中或反查命中）且有 `keyUrl` 时才出现」。
- **默认值去服务商化**：`default_ai_base_url` → `https://api.openai.com/v1`，`default_ai_model` → `gpt-5.4-nano`（保持一致的是「必须非空」——`set_settings` 会拒绝空模型名，空默认值会让用户只改别的设置也存不下去）。同步 `normalize.ts` 的 `FALLBACK_SETTINGS`（原本兜底值还是已弃用的 `deepseek-chat`）与 mock 演示数据。
- **后端文案**：`set_settings` 的两条校验错误由「DeepSeek 地址…／DeepSeek 模型名…」改为「接口地址（Base URL）…／模型名称…」。
- **保留项（不是残留）**：`AI_PRESETS` 里的 DeepSeek/Moonshot/通义/Ollama 预设、`DEPRECATED_MODELS` 的厂商模型名、`secrets/deepseek-api.key` 的迁移读取——前者是可选服务商，后者是历史文件名，删了会断旧用户。
- **新增门禁**：`scripts/check-ai-config.mjs`（第 9 个 UI 检查）：`protocol=1`（徽标是协议口径）、`chromeVendor=0`（框架级文案不得出现服务商名）、`presetMatched=1`、`diagProtocol=1`、`diagVendorBadge=0`、`diagModelShown=1`。
- 验证：`cargo test` 96 项 + `probe_repeat` 1 项全绿；门禁 **12/12 全绿**；设置页/诊断页暗色实拍核对（`shots/audit/ai-settings-after.png`、`ai-diagnostics-after.png`）。
- 未动：用户状态文件里已有的 `aiBaseUrl` / `aiModel` 原样保留（那是用户自己的配置，不该被版本升级悄悄改写）。

---

## 0.8.0-r5 — 「现代通用」主题预览图重做（2026-10-27 00:00–00:25）

- **问题**：modern（现代通用）没有缩略图，外观页里退化成一块蓝色渐变示意，和其余五套（真实界面截图）放一起明显是占位符。
- **做法**：与其余五套同源——截真实模组库首屏；三点差别：① 3× 采样再降采样（2× 源在 5.7 倍降采样下起摩尔纹）；② 取景按真实 DOM 坐标算（标题整块 + 工具条 + 两列整卡，右缘落在卡片间隙上，不再从标题中间切一刀）；③ **明暗两套各出一张**（`modern-dark.png` / `modern-light.png`，另有 `modern.png` 兜底），卡片按当前生效的明暗自动换。
- **顺手修的样式**：`.theme-swatch` 的圆角改为跟随主题 token `--radius`（赛博 2px、modern 8px），六个预览框永远和所在卡片一致；modern 下预览框底色改用面板色。
- **产物**：`public/theme-thumbs/modern-{dark,light}.png`（176×104，88×52 卡片的 2 倍）；删除过期资源 `daylight.png`（旧主题 id，已并入 modern+light 迁移映射）。
- **工具**：`scripts/make-modern-thumb.mjs`（先 `vite preview:1420` 再跑）；`make-theme-thumbs.ps1` 的主题清单去掉 daylight 并注明 modern 走新脚本。
- 验证：`vite build` ✅、门禁 11/11 全绿、外观页暗/亮各截一张核对（`shots/audit/appearance-qa/`）。

---

## 0.8.0-r4 — 回归门禁 + 脏数据白屏 + NXM 协议接管（2026-10-26 22:58–23:49 · 已于 2026-10-27 00:01 构建部署）

**模块**：`scripts/gate.mjs`（新增）、`scripts/check-scroll.mjs`、`scripts/check-nxm.mjs`（新增）、`scripts/check-elevation.ps1`（新增）、`src/lib/normalize.ts`（新增）、`src/components/AppErrorBoundary.tsx`（新增）、`NxmIntake.tsx`（新增）、`NexusSettingsCard.tsx`（新增）、`src-tauri/src/nxm.rs` / `nxm_tests.rs`（新增）、`selfcheck.rs`（新增）、`adopt_tests.rs`、`lib.rs`、`main.rs`、`schema.rs`、`api.ts` / `mock.ts`、`docs/ARCHITECTURE.md`、`docs/REAL-ENV-TEST.md`

> 对应项目看板计划【1】bug/测试基础设施 与【3】NXM 接管下载。**release 目录 exe 仍停在 22:15 的 0.7.0-r4 构建**，本轮产物未打包、未部署。

### 一、回归门禁（计划【1】）

- **新增** `scripts/gate.mjs`：一条命令串起 `cargo test` → `tsc --noEmit` → `vite build` → 7 个单点 UI 脚本，自动起/停 `vite preview`，按脚本 stdout 的 `key=value` 断言（支持 `a<b`、`a!=b` 这类 key 间比较），失败非零退出并写 `shots/gate/report.json`；`--skip-ui` 供无浏览器环境用。cargo 不在非交互 shell 的 PATH 里，脚本自动补 `~/.cargo/bin`。
- **门禁第一次跑就抓到 4 个真问题**（全部已修）：
  1. `adopt_tests.rs`（22:58 新增）4 处直接读 `Store.staging_dir` **私有字段** → `cargo test` 根本编译不过；
  2. 文档里写的 `check-scroll.mjs` **文件不存在**，「6 个脚本」实际跑不全 → 23:07 补建；
  3. 设置页改成 Tabs 后 `check-platform.mjs` 与 `check-profiles.mjs` 选择器全失效（chip 落在 `display:none` 的未激活页、播放集面板已挪到「工具组件」）；
  4. 播放集确认按钮文案是「开始切换」，脚本按 `/^(切换|确认)/` 匹配，永远超时。
- **新增** `scripts/check-nxm.mjs`：断言接收条渲染、忽略后清空、接管/交还后 handler 变化（mock 里预置 Vortex 占位）。

### 二、P0 脏数据白屏（门禁的首个真实收益）

- **现象**：注入一条 `translatedName: 12345` 的模组后 `#root` 子节点数为 0，界面全白。
- **真因**：`LibraryView` 排序里 `(x ?? "").trim()` 抛异常，抛点在**卡片之外**（排序/筛选/统计），卡片级错误边界接不住 → React 卸载整棵树。
- **修复两层**：新增 `src/lib/normalize.ts`——**在状态入口**统一降级（字符串/布尔/数字/数组 + `Settings`），于 `api.bootstrap()` 内对 Tauri 与 mock 两条路都生效，不再指望每个组件自己防御；新增 `AppErrorBoundary.tsx` 作最外层兜底，真崩了给「重新加载 + 复制错误」面板（卡片级边界 0.7.0 已有，本次只补全局）。
- **验证**：门禁用例「虚拟滚动 / 脏数据不白屏」`afterDirty=18 >= 1`、`fault=0`。

### 三、提权 / DPAPI 回归可脚本化

- **新增** `src-tauri/src/selfcheck.rs` + `--self-check <out.json>`：无窗口把结论压成 JSON（`elevated` / `dataDir` / 写探针 / 状态往返 mods&profiles / 密钥**只报能否解密、绝不输出内容** / 游戏目录 / NXM 归属），写文件同时打 stderr（发布包是 `windows_subsystem="windows"`，无控制台）。`main.rs` 在 `run()` 之前拦参数，命中即退出、不建窗口。
- **新增** `--nxm-takeover` / `--nxm-release`（`selfcheck::run_nxm`）：把界面上两个按钮变成可脚本调用的命令行入口，输出 JSON。用途是启动器被另一实例占着、界面点不动时，也能把注册表修回来。
- **新增** `scripts/check-elevation.ps1`：普通权限跑一次、提权再跑一次，diff 两份 JSON 出结论。
- **实测本机**（`shots/gate/selfcheck-standard.json` / `-elevated.json`）：普通权限 `dataDirProbe=ok / mods=195 / nexusKey=readable`；提权后 `elevated=true / dataDir 不变 / mods=195 / nexusKey 仍 readable`，**0 failure**。
- **真实环境预检**：本机已装 CP2077（`d:\steam\steamapps\common\Cyberpunk 2077`，`exePresent=true`），`real-env-check.ps1 -ProbeWrite -ProbeHardlink` 全 PASS（写探针、同卷硬链接均成功）。
- **PS 5.1 新坑**（已写进脚本注释）：① `Start-Process` 遇到 `HTTPS_PROXY` 与 `https_proxy` 同时存在会抛「字典中的关键字重复」→ 先删小写变体；② `Get-Content` 默认按 ANSI 读 UTF-8 JSON 会报「无法识别的转义序列」→ 必须 `-Encoding UTF8`。

### 四、NXM 协议接管（计划【3】）

- **新增** `src-tauri/src/nxm.rs`：`parse_link`（只认 `cyberpunk2077`，别家 domain 报 `NXM_UNSUPPORTED_GAME` 而**不是悄悄丢弃**；兼容 `nxm:` 省略斜杠与大小写；`%xx` 解码签名 key）、`links_from_args`（首次协议拉起与单实例转交共用）、`status` / `takeover` / `release`。
- **三条硬边界**：只写 `HKCU\Software\Classes\nxm`（不需提权，卸载/交还只动自己的键）；接管前把别人的命令行原样备份进 `cyberdeck-data/nxm-handler.json`，「交还」时精确写回；无备份时只删自己建的子树，且当前命令不指向本 exe 就报 `NXM_NOT_OURS` 拒绝动手。
- **归属判定不靠进程名**：`is_ours` 先归一化命令行（去引号、去 `%1`、统一斜杠、压空白）再按 exe 路径比对；`registered` 与 `ours` 分开——Vortex 占着时是 `registered=true / ours=false`，`owner` 取 `us|other|none`。
- **注册表根参数化**（`*_at(root, …)`）：单测用一次性 `Software\Classes\nxm-test-<uuid>` 沙箱键做**真实读写**、跑完即删，**不碰用户真实绑定**；2 项集成测试覆盖「备份→接管→交还写回」与「无备份→接管→交还删干净」。
- **接线** `lib.rs`：`NxmInbox` 收件箱（`setup` 先收 argv 再建窗，单实例回调**先入队再唤窗**，避免链接丢失）+ `nxm_status / nxm_takeover / nxm_release / nxm_pending / nxm_dismiss` 五个命令；`startup.log` 记 `stage=nxm links=N mod=… file=…`，**不写链接里的 key**。新增设置项 `nxmAutoDownload`（默认 `true`）。
- **前端**：`NxmIntake.tsx` 右下角接收条（下载并导入 / 打开页面 / 忽略 / 全部忽略，带 percent 进度与错误重试）；`NexusSettingsCard.tsx` 新增 `// NXM PROTOCOL` 区块（归属文案三分支、实际 handler 原文、备份时间与命令、接管/交还按钮、自动下载开关）；`api.ts` / `mock.ts` 同步五个方法与 `NxmLink` / `NxmStatus` 类型，mock 初始假装 Vortex 占着，便于演示「备份 + 交还」全链。
- **下载口径**：复用 `nexus_download`（API 直链 → `.part` → `install_archive`）；免费账号没有直链，只能「打开页面」，不承诺自动下载。

### 五、验证

- `shots/gate/report.json`（**23:47–23:49 复跑**，`total=10 / failed=0`）：cargo test **96 项** + 1 探针全通过、`tsc --noEmit` exit 0、`vite build` exit 0；UI 七项断言全部命中（脏数据不白屏 / 更新熔断 / 平台选择器 / 右键菜单 / 播放集切换 / 环境体检面板 / NXM 接管）。主 bundle 496KB（gzip 153KB）。
- **末段改动已覆盖**：23:36–23:37 落的 `nxm.rs`、`selfcheck.rs`、`lib.rs`、`schema.rs`、`main.rs`（CLI 分派）已进本次复跑范围——测试数从 92 增到 **96**（新增 4 项 NXM 注册表沙箱用例），全绿。
- 已知非阻断：`cargo test` 仍余 2 条 unused import 警告（`wolvenkit.rs` 的 `safe_join`、`adopt_tests.rs` 的 `Path`）。

### 六、配套（文档 / 计划 / 工程环境）

- `docs/ARCHITECTURE.md`（23:33）补 NXM 子系统与门禁入口；`docs/REAL-ENV-TEST.md`（23:34）新增「0.0 一条命令的自动门禁」「0.0.1 提权 / DPAPI 对照」两节，真机验收改为**连续启动两次** + exe 内前端产物 md5 一致性校验。
- 项目看板按「价值 × 成本 × 依赖」重排为 **9 项功能优先级计划**（覆盖旧 9 项工程待办）：旧「验证 requireAdministrator 构建」并入【1】回归清单，旧「Vortex 元数据增强 A+C」并入【3】下载后闭环。
- **环境事故清理**：删除 `D:\鐢ㄦ埛` 乱码镜像目录——其实是 `D:\用户\工作区\.tools` 的 UTF-8 字节被 GBK 误读的产物（仅 1 个 1.3KB 日志 + 空 `rustup` 子目录）。根因是 UTF-8 **无 BOM** 的 `.ps1` 被 PowerShell 5.1 按 GBK 解析，中文路径字面量被打乱 → **新规则：含中文路径的 .ps1 必须带 UTF-8 BOM，或改用 ASCII 路径变量**。
- 新增本 `CHANGELOG.md`（此前只有按批次的 `docs/PROJECT_HISTORY.md#batch-1026`，无全量日志）。

### 七、已知边界

- 真机「在 N 网点『Mod manager download』→ 系统真的把链接交给本启动器」仍需用户点一次接管后手验；本机没有 Vortex，`other` 分支的真实命令来自测试构造。
- 接管/交还只覆盖当前用户（HKCU），不做机器级（HKLM）注册。
- 本轮**未构建 exe、未更新 release 目录**，便携包与安装包均未重打。

---

## 0.7.0-r4 — 界面/交互四项 + 设置信息架构（2026-10-26 21:45–22:20）

**模块**：`styles.css`、`App.tsx`、`store.rs`、`lib.rs`、`SettingsView.tsx`、`SettingsTabs.tsx`

- **浮层重叠结构性修复**：toast(90)/任务队列(68)/抽屉(60) 三层各自 `position: fixed`，靠 `.has-tasks .toast-host { right: 382px }` 魔法数字互躲，抽屉 470px 宽时 toast 正好压进去。改为**统一层级变量 + 单一浮层栈**：`--z-drawer/--z-floating/--z-modal/--z-command/--drawer-w`，`<ToastHost/>` 与 `<TaskCenter/>` 包进 `.floating-stack`；抽屉打开时 `app-shell.has-drawer` 令整栈左移，窗口 <1320px 改左下贴边。新增 `scripts/check-floating.mjs` 断言两矩形不相交。
- **暂存区可自由改位置**：此前 `Store::load` 每次把 `staging_dir` 覆盖为 `<dataDir>/staging`，状态文件里的值是装饰品。改为 `Arc<RwLock<PathBuf>>` + 尊重持久化值；新命令 `change_staging_dir`（校验不得落在游戏/数据目录内、可写探测 → 逐项搬迁 → 重写 `stagingPath`/`sourceZip` → 落盘），**搬迁失败项留原处并在报告中列出，绝不静默删除**。
- **「自动查找」变独立按钮**：新命令 `detect_tool(tool)`，复用 `find_archive_tool` / `wolvenkit::detect_cli`；工具字段配「自动查找 + 手动选择 + 保存」三按钮，结果就地回显。
- **设置分类重排**：关闭行为从「安全与维护」移到「外观与行为 → 窗口行为」；该 Tab 最终定名 **个性化**（id 仍 `appearance`）。
- 22:20 补齐：上一轮脚本在断言处提前退出导致 **WolvenKit「自动查找」实际未写入**（曾误报为已加），本轮补上并 grep 复核。

**验证**：`tsc --noEmit` 0 错、Rust 48 测试全绿、`ui-test` `ERRORS []`、真机 `stage=frontend mods=195`、1080 宽下工具两行溢出 0。便携包重建 3.78MB（顶层目录 `CyberDeck Launcher 0.7.0`）。

**环境坑**：vite 8 默认只监听 `::1`，脚本用 `127.0.0.1` 连不上 → 必须 `--host 127.0.0.1`，且 curl/node 都要 `NO_PROXY=127.0.0.1,localhost`。

---

## 0.8.0-r3 — 绕过官方启动器直启游戏（2026-10-26 20:00–21:04）

**模块**：`game.rs`、`game_tests.rs`（新增）、`lib.rs`、`schema.rs`、`SettingsView.tsx`、`types.ts`

对应项目看板计划【2】。目标：消掉每局一次「REDprelauncher 点 Play」。

- **平台判定** `platform_of(root, source)`：快照里已绑定目录来源恒为 `manual`，故加路径兜底（含 `steamapps`→Steam、`goggame-*.info`→GOG、`.egstore`→Epic），**没有兜底就判断不出 DRM 前提**。
- **直启前提** `inspect_launch` / `LaunchCheck`：Steam 需 `steam.exe` 运行中（`auto` 改走 `steam -applaunch`，`direct` 明确报错）；Epic 需 `EpicGamesLauncher.exe` 运行中（否则 `LAUNCH_CLIENT_REQUIRED`，不偷偷改道）；GOG/手动目录无前提。
- **进程探测**：`tasklist /FI "IMAGENAME eq <x>" /NH /FO CSV`，只读、不注入、不枚举句柄；查询失败一律按「没在运行」（保守）。
- **路由**：`plan_launch` 纯函数（可单测）：`auto` 前提满足→直启 / `direct` 只直启 / `steam` 强制 `--launcher-skip`。
- **失败自愈**：直启后观察 2 秒，提前退出或创建失败 → `fallback_routes` 依次试 Steam → `REDprelauncher.exe`；成功后 `LaunchResult.fallbackFrom="direct"` 并 warn toast「已回退官方启动器」。
- **顺序与并发**：熔断校验 `update_lock_active` **先于**任何 spawn；进程探测与 spawn 全在状态锁外（守住「Mutex 内不做 IO」）；`Cyberpunk2077.exe` 已在运行返回 `method=already-running`，不双开。
- **设置页**：启动方式三项文案重写 + 「启动能力状态卡」（绿色=直启就绪，橙色=受限并给出第一条原因）。

**测试**：新增 `game_tests.rs` 14 项（纯函数 + 假目录）；`core-tests` 85 项 + 1 探针全绿。
**已知边界**：本机无真实 CP2077，直启/回退的真机验收（Steam DRM、Epic 客户端）待做。

---

## 0.7.0-r3 — 单实例 / 托盘 / 关闭到托盘 / 退出确认 / 便携版（2026-10-26 12:25–12:35）

**模块**：`lib.rs`、`main.rs`、`Cargo.toml`、`schema.rs`、`types.ts`、`SettingsView.tsx`、`mock.ts`

- **单实例**：`tauri-plugin-single-instance 2.5.4`（要求 tauri ^2.12），在 `run()` builder **第一个注册**；二次启动不建窗口，`show + unminimize + set_focus` 唤起已有窗口；首实例 setup 未完成时回调重试 20×150ms。
- **系统托盘**：`tauri` 加 `tray-icon` feature；`setup_tray()` 用 `default_window_icon()`（不依赖外部资源），菜单「显示主界面 / 彻底退出」，左键留给显隐切换。
- **关闭到托盘**：`CloseRequested` → `prevent_close()` → 按 `settings.close_behavior`（`tray`|`exit`）分支；偏好存 Rust `Settings`，由 `set_settings` 单一入口校验。
- **退出前安全检查**：`BusyTasks` + RAII `BusyGuard` 登记 8 个长任务（install/uninstall/update/repair/apply_collection/adopt_execute/nexus_download/mods_translate），有待办任务时弹**原生** OkCancel 确认框。
- **可观测**：`startup.log` 记录 `stage=close action=hide-to-tray|exit`、`stage=exit action=immediate|confirm busy=…`。
- **便携版**：发布包内必须带**空的 `cyberdeck-data/`**（含标记文件），否则 `resolve_data_dir` 会退到 `%APPDATA%`（实测踩到）。

**同批修掉的事故（12:35）**：一度发出 dev 构建（用户截图 `ERR_CONNECTION_REFUSED`）。原因：用 `cargo build --release` 且缺 `--features custom-protocol`，`tauri/build.rs` 判 `dev = !has_feature("custom-protocol")` ⇒ 不内嵌前端、去连 1420。已用 `tauri build --no-bundle` 重编（8335872B）并双处实测 `stage=frontend`。顺手加 `bootstrap` 日志 `stage=frontend mods=N`。另：同一 shell 并发跑两次 `tauri build` 会抢 `dist` 失败，构建只能串行。

---

## 0.8.0-r2 — 状态文件被误判损坏、195 条模组索引清空（事故修复 2026-10-26 06:45–07:40）

**模块**：`schema.rs`、`collection.rs`、`store.rs`（行为未改）、`core-tests`、`docs/ARCHITECTURE.md`、`docs/REAL-ENV-TEST.md`

- **现象**：改名后启动界面模组全空；数据目录出现 `launcher-state.broken-*.json`（完整内容）+ 968 字节空状态。游戏目录里的模组文件未丢，丢的是**索引**。
- **真因**：`schema.rs::deserialize_always_empty`（用于作废旧 `modpacks`）**丢弃反序列化器参数、不消费输入** → serde 解析位置错位（探针错误 `expected ',' or '}' at line 9392 column 15`）→ 整个状态文件解析失败 → `store.rs` 判损坏 → 改名 `.broken` 并用空状态启动。
- **放大因素**：空数组形态 `"modpacks": []`（启动器**每次落盘都写出的形态**）同样触发 ⇒ 该版本**每次启动都清空一次库**，不只是升级时丢一次。
- **修复**：改用 `IgnoredAny::deserialize(deserializer)?` 消费输入（`schema.rs:502`）。
- **三道回归测试**：`schema::modpacks_cleared_on_load::modpacks_field_is_ignored_but_still_consumed`（schema.rs:998）、`collection::tests::legacy_modpacks_records_are_dropped_on_load`（collection.rs:963）、`collection::tests::empty_modpacks_array_also_parses`（collection.rs:1059）——均断言「整个文件仍能解析 + 其它字段保留 + 不产生 `broken-*.json`」。
- **数据恢复**：从 `.broken` 复原 → `mods=195 / loadOrder=125 / modpacks=0`，Nexus 引用完整。
- **连带修复**：删 `modpack.rs` 时漏改平行 crate `core-tests` 的 `#[path]` 引用，导致无 GUI 测试 harness 编译不过 → 改指向 `collection.rs`，`core-tests` 72 项全绿。
- **规则沉淀**：① 自定义 `deserialize_with` 必须消费输入；② 改 schema 前必须用真实旧数据跑解析（单测全绿 ≠ 旧数据可读）；③ 品牌改名 / schema 变更 / 数据迁移分三次提交。规则已同时写入 `ARCHITECTURE.md` 与 `REAL-ENV-TEST.md`（真机验收改为**连续启动两次** + exe 前端产物 md5 一致性校验）。

> 复盘：`docs/PROJECT_HISTORY.md#incident-state-parse`

---

## 0.8.0-r1 — 品牌更名 + 主题解耦 + 设置页 Tabs + Nexus Collections（2026-10-25 22:00 → 10-26 06:33）

**模块**：全仓命名、`src/lib/theme.ts`（新增）、`styles/tokens.css`、`SettingsTabs.tsx`（新增）、`collection.rs`（新增）、`CollectionWizard.tsx`（新增）、`schema.rs`、`lib.rs`、`mock.ts`

### 一、品牌更名（NightCity Loader → CyberDeck Launcher / CDL）

| 项 | 旧 | 新 |
|---|---|---|
| identifier | `com.nightcity.loader` | `com.arol.cyberdeck`（**发布后不再改**） |
| exe | `NightCity Loader.exe` | `CyberDeck Launcher.exe` |
| exe 同级数据目录 | `nightcity-data` | `cyberdeck-data` |
| `%APPDATA%` | `com.nightcity.loader` | `com.arol.cyberdeck` |
| 源码/发布目录 | `NightCity-Loader-*` | `CyberDeck-Launcher-*` |

- 数据一次性迁移：`launcher-state.json` 在 **JSON 结构层**逐字段改写旧路径（否则卸载/重部署指向不存在的暂存目录），**195 模组 / 125 条 loadOrder / Nexus Key 全部保留**。
- **有意保留未改**（兼容锚点，改名需配套迁移）：`origin: "nightcity"` 等持久化格式值、临时文件前缀（`*.txt.nightcity-tmp`）、localStorage 键 `ncl.ui.*`（避免主题与通知已读态重置）。
- 踩坑：pnpm 的 `node_modules` 是绝对路径软链，目录改名后全部悬空 → `rm -rf node_modules && pnpm install --offline`。

### 二、主题系统解耦（styleTheme × colorMode）

- 新增 `theme.ts::useTheme()` → `{ styleTheme, colorMode, resolvedMode, modeCapable, setStyleTheme, setColorMode }`，写 `documentElement.dataset.style / mode / modeCapable`。
- 风格：ncpd / netrunner / arasaka / militech / mono / **modern（新增）**；**daylight 删除**（老用户自动迁移为 modern+light）。
- 明暗：仅 mono / modern 可切 light/dark/system（`matchMedia` 实时监听），赛博风格强制暗色。
- CSS 契约 `--radius / --clip-corner / --glow`：modern 一律 8px 圆角、`clip-path: none !important`、零发光；mono 增浅色变体。
- 切换过渡只在切换瞬间挂 `data-theme-transition`（300ms），避免常驻 transition 拖慢滚动；首屏防闪脚本支持新键 `ncl.ui.theme.v2`。

### 三、设置页 → 顶部水平 Tabs

六个 Tab：个性化（原「外观与主题」，id 仍 `appearance`）/ 游戏与路径 / AI 配置 / 工具组件 / 安全与维护 / 关于。内容区独立滚动、切 Tab 回顶、**用隐藏而非卸载**（不丢未保存输入）。新增 `SettingsTabs.tsx`。

### 四、Nexus Collections（废弃本地大 ZIP 整合包）

- **删除**：`modpack.rs` 的递归扫描子目录 / 自动剥多层嵌套 / 批量注册逻辑、`import_modpack` 命令、前端「导入整合包」入口、`ModpackProgress`/`ImportedPack` 类型。**单 ZIP 导入（`installer::install_archive`）完整保留**。
- **新增** `collection.rs`：`parse_collection_manifest(path)`（校验 `domain=cyberpunk2077` → 先 `nexus.mod_id` 后 `nexus.file_id` 匹配本地，**MD5 不参与**；状态 `installed/version_mismatch/missing`）、`apply_collection_order(ids)`（按清单顺序重写 `modlist.txt` 并部署）、**modRules 拓扑排序**（before/after/requires，有环回退原序不 panic）。
- 前端 `CollectionWizard.tsx`：绿勾/红缺/版本不符、可选标记、「去 N 网获取」、全部就绪后「按预设顺序部署」。
- **部署语义裁决**：进入部署的 ids 取 `localId !== null`（**含「已装但版本不符」**）——后端 `ready_to_deploy` 判据是「无 missing」，少传会丢 modlist 位次导致集合顺序断裂。
- **合规边界**：Nexus 只向 Premium 签发直链，**不做自动下载器**，走「开网页下载 → 拖回导入 → 一键部署」。

### 五、附带修复

`ui-test.mjs` 双 file input 的 strict mode 报错改用 `.first()`；主题数量断言 5→6；发现页新增「网页搜索」按钮（API v1 无搜索端点，把过滤词拼成 Nexus 搜索页）；`mock.ts::installMods` 造了 mod 却**从不 `db.state.mods.push`**（演示模式导入后分类存不上、遮罩卡死）；清理 `TaskKind` 死值 `"modpack"`（`ModOrigin` 保留）。

> 批次详情：`docs/PROJECT_HISTORY.md#batch-1026`、`docs/PROJECT_HISTORY.md#batch-1026`

---

## 0.7.0-r2 — 跳转失效 / 数据目录分裂 / 目录完整性事故（2026-10-26 01:30–06:11）

**模块**：`lib.rs`、`store.rs`、`build.rs`、`Cargo.toml`、`schema.rs`、`TopBar.tsx`

- **现象**：所有「打开浏览器」按钮（获取 Key、打开 Nexus 页等）静默失效；API Key 偶发「消失」；子进程 `explorer.exe` 报 `0xc0000142`。
- **真因（定案）**：`D:\用户\工作区` 从旧电脑搬来携带 **Low 完整性标签**（`Mandatory Label\Low`）+ 孤儿 SID `S-1-4-…`，向下继承到 exe **并否决进程令牌** → 进程以 Low IL 运行（`startup.log` `integrity=0x1000`）→ 写不了 Medium 目录（os error 5 → 静默回退 → 双数据目录）→ 子进程继承 Low 令牌失败。
- **环境修复**：`icacls "D:\用户\工作区" /setintegritylevel "(OI)(CI)Medium"`；存量 release 目录改为「旧目录改名 `-old` 备份 + 新建同名目录 + 复制 exe/dll + 移动 data 目录」，让新对象继承 Medium。验证：exe 标签 Medium、`integrity=0x2000`、跳转恢复。
- **代码侧保留的有效改动**：
  - `open_url` 一律经 `explorer.exe`（绝对路径、不加 `CREATE_NO_WINDOW`）转交外链，失败回退 ShellExecute，每次写 `startup.log`；
  - `Cargo.toml`：`open = { version = "5", features = ["shellexecute-on-windows"] }`（open 5.4 默认 launcher 链会假成功）；
  - `resolve_data_dir()`：exe 同级 `cyberdeck-data` 优先 → 可写探测通过的 `%APPDATA%` → exe 同级；`migrate_other_data()` 只补齐不覆盖；**禁止静默回退**；
  - `startup.log` 记录 `elev / integrity / appcontainer / probe / 错误码`（本次破局关键）；
  - 通知角标：`ncl.ui.bellSeenAt.v1` 已读时间戳，角标移出带 `clip-path` 的按钮（原来会被裁切）。
- **权限策略**：**asInvoker**，不声明 `requireAdministrator`（曾短暂加过，已回退）。
- **排查铁律**：进程行为异常（写被拒／子进程崩溃／跳转静默失败）→ 先 `icacls <exe>` 看 `Mandatory Label` 与孤儿 SID，再查 token integrity（Low=0x1000 / Medium=0x2000）；对照实验用同用户 PowerShell 做同一操作。

> 复盘：`docs/PROJECT_HISTORY.md#incident-low-integrity`（定案）+ `docs/PROJECT_HISTORY.md#incident-webview-datadir`（误判过程：6 轮错误假设、多打 5 个包）

---

## 0.7.1 — UI 审计 13 条 + Nexus 差距 7 项（2026-10-25）

**模块**：前端全视图、`styles/tokens.css`、`api.ts`/`mock.ts`、`nexus.rs`、`schema.rs`、`lib.rs`

**UI 审计（A1–E3）**

| 项 | 内容 |
|---|---|
| A1 | 阅读型文本字号提升（page-sub/empty/confirm/drawer 段落 12–12.5px；卡片内部不动，行高 328 保持） |
| A2–A4 / D1 / D3 | 行高 1.6、warning 对比、中文回退、`--mono` 回退、主题缩略图脚本 `scripts/make-theme-thumbs.ps1` |
| B1 | 侧栏徽标：加载顺序/诊断=冲突数，发现=Nexus 未连接「!」，设置=游戏目录未链接「1」 |
| B2 | 搜索框全局语义 placeholder + Ctrl+K 面板按钮 |
| B3 | 空状态动态引导（未绑目录→「先绑定游戏目录」；已绑定→「导入第一个模组 / 去发现页」） |
| B4 | 播放集切换确认卡：撤除/部署差量预览 + 三段步骤指示器 |
| C1 | 活动流：最近 10 条「时间+动作+文件数」，复用 TaskItem 结构 |
| C2 | 全窗口拖拽导入落点层（`onDragDropEvent` + `.drop-overlay`），清掉重复监听 |
| C3 | 虚拟网格按 `分类:排序` 锚点记忆/恢复滚动位置 |
| E1 | 按视图拆包（Nexus/诊断/设置/ModSettings 懒加载），主 bundle 457KB |
| E2 | `styles.css` 分层：`tokens.css`（13 组变量）+ 组件层 + `index.css` 入口 |
| E3 | mock 漂移防护：`ApiSurface = typeof api` + `mock.ts` 末尾编译期断言 |

**Nexus 差距功能（#1–#7）**

| # | 内容 | 落点 |
|---|---|---|
| 1 | 更新检查 `nexus_check_updates`（250ms 节流、上限 40、无版本号跳过不误报），UPD 徽标 + 库页「检查更新」；只发现不自动装 | `nexus.rs`、ModCard/Drawer/LibraryView |
| 2 | 集合报告：导入完成对照现有库出「同名重复 / 目标重叠」 | `ImportDialog.tsx` |
| 3 | 前置引导闭环：缺失框架卡加「官方发布页」（7 个 URL 表） | `DiagnosticsView.tsx` |
| 4 | 依赖结构化列表：推断前置 + 已装/缺失状态 | `ModDetailDrawer.tsx` |
| 5 | External Changes 沟通：未受管 archive 提到诊断首屏，强调永不自动删除 | `DiagnosticsView.tsx` |
| 6 | 启动参数 `launchArgs`（`parse_launch_args` 白名单、≤256 字符、逐参不经 shell） | `schema.rs`、`game.rs`、SettingsView |
| 7 | 通知中心：顶栏铃铛（活动流 12 条 + 更新数徽标） | `TopBar.tsx` |

---

## 0.7.0 — 基线功能（≤2026-10-24）

**模块全览**

| 模块 | 状态 |
|---|---|
| 模组库 / 分类 / 搜索 / 虚拟滚动 | 完成 |
| ZIP / 7z / RAR 导入 | 完成（ZIP、7z 纯 Rust；RAR 依赖本机 7-Zip/WinRAR） |
| 暂存区与部署分离 | 完成（禁用只撤链接，卸载才删暂存） |
| 硬链接部署 + 跨盘回退 | 完成（硬链接 → 符号链接 → 复制，失败整批回滚） |
| 冲突预判中心 | 完成（已启用冲突 + 暂存模组「启用后会冲突」） |
| 加载顺序 / `modlist.txt` | 完成（`.xl` 跟随所属 archive，不独立排序） |
| 主题与缩放 | 完成（6 套主题、强调色、90/100/110% 缩放、侧栏折叠） |
| 硬件视觉层 | 完成（切角、噪点/网格、红黑警告带、虚线接收面板） |
| Mod Settings（CET `user.ini`） | 完成（行级修改、`.bak`、恢复） |
| 多框架配置解析 | 完成（A 类绑定 Mod / B 类全局 / C 类不生成表单） |
| 日志查看器 | 完成（末尾读取、级别过滤、错误前后 5 行） |
| Nexus 发现 / Premium 下载 / 官方封面 | 完成（需用户自己的 API Key） |
| AI 诊断 | 完成（标准 OpenAI 接口兼容、逐次同意、脱敏、focus 白名单） |
| WolvenKit 深度扫描 | 完成（CLI 路径可手填或自动检测，超时可配） |
| Mod 名 AI 翻译 | 完成（框架名黑名单免翻译、原名不被覆盖） |
| 整合包导入 | 完成（后被 0.8.0-r1 的 Nexus Collections 取代） |
| 播放集（Profile） | 完成（快照 → 撤销 → 写状态 → 部署 四段切换） |
| 右键菜单 / 打开文件夹 / 修复 | 完成（`open_in_explorer` 路径白名单、`repair_mod` 先撤后装） |
| 游戏更新熔断 | 完成（`lastGameVersion` 对比锁定部署入口） |
| 环境体检与自愈 | 完成（`deployedFiles` 记 size/mtime + `diagnose_environment` / `heal_environment`） |
| 多平台嗅探 | 完成（Steam 注册表 + `libraryfolders.vdf`、GOG、Epic） |
| 卡片错误边界 | 完成（单卡异常只坏一格，显示 `// ERROR: DATA CORRUPTED`） |

**同期完成的五项无人值守任务**（详见 `docs/PROJECT_HISTORY.md#night-shift`）：虚拟滚动错误边界、游戏更新熔断、多平台嗅探与启动适配、卡片右键菜单、环境完整性自检与自愈；配套四个可复跑验收脚本 `check-update-lock / check-platform / check-context-menu / check-env-panel`。

---

## 事故与复盘索引

| 日期 | 事故 | 影响 | 复盘文档 |
|---|---|---|---|
| 2026-10-26 | 目录 Low 完整性标签 → 跳转失效 / 数据目录分裂 / 子进程失败 | 6 轮错误假设、多打 5 个包 | `docs/PROJECT_HISTORY.md#incident-low-integrity`、`…-webview-and-datadir.md` |
| 2026-10-26 | `deserialize_with` 未消费输入 → 状态文件被判损坏 | 195 条模组索引清空（文件未丢） | `docs/PROJECT_HISTORY.md#incident-state-parse` |
| 2026-10-26 | 发出 dev 构建（缺 `custom-protocol`） | 用户看到 `ERR_CONNECTION_REFUSED` | `HANDOFF.md` §0.7.0-r3 构建铁律 |

---

## 新增版本条目模板

```markdown
## X.Y.Z-rN — <一句话主题>（YYYY-MM-DD HH:MM–HH:MM）

**模块**：<涉及文件/子系统>

- **新增**：…
- **变更**：…
- **修复**：…
- **移除**：…
- **验证**：tsc 0 错 / Rust N 项全绿 / UI 脚本 / 真机 startup.log 摘录
- **已知边界**：…

> 复盘：docs/INCIDENT-<日期>-<主题>.md（如有）
```

**收尾 checklist**：本文件追加 → `HANDOFF.md` 对应段同步 → 事故类另写 `docs/INCIDENT-*.md` → 资料库「NightCity Loader 项目文档」同步。
