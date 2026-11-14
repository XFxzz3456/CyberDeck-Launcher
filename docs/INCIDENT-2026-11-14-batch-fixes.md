# 复盘：GitHub #10 + #11 五项缺陷批次（2026-11-14，未发版）

> 用户授权原话：「一起修吧，还有 GitHub 上的 issue」；范围确认「修 #10+#11，并关闭/回填 issue」，#2–#9 长期功能轨道不动。
> 本轮只改源码与门禁，**未升版本号（三处 `version` 仍 1.8.3）、未构建 exe、未替换 release、未打 ZIP、未发 Release**。

## 现象

用户上一轮明确要求「先不修复，查找出原因然后放到待办」，于是登记了两条 issue：

- **#10**（1.8.3 界面）三项：
  1. 「消息按钮提示有消息但是点了还是显示，没有变成已读状态」；
  2. 铃铛面板「没有遮住下面的『所有状态 名称』等」，工具栏文字透出来；
  3. 「点击这个去获取结果打开了文件资源管理器」。
- **#11**（新待办）两项：
  1. 存档快照「错误提示没有折叠，全部展开着」，刷屏；
  2. 「帮我查一下 archiveXL 前置怎么没了，我应该没动过」。

诊断阶段确认 #11 的两项**是同一条链**：批量更新把 ArchiveXL 的 DLL 弄丢 → 38 个启用模组报「缺少前置：ArchiveXL」→ 存档扫描把这条全局风险复制进每张存档卡 → 没有折叠导致整屏错误。

## 真因

1. **角标永不归零**：`badgeCount = unreadCount + updateCount`。`updateCount` 是「待更新模组数」这个**持续状态量**，不是「未读事件」，只要还有待更新项，点开铃铛写 `bellSeenAt` 也清不掉它。同时 `bellSeenAt` 在打开瞬间就写，面板内所有活动一次性变已读，缺「打开前水位」概念，看不出哪些是这次新到的。
2. **面板被盖不是 z-index 数字小**：`.bell-panel` 是 `position: absolute`，挂在 `.topbar` 内；topbar 自身 `position: relative` + `z-index` 形成**层叠上下文**，子元素的 z-index 再大也出不去，工具栏（同层更高）必然盖住它。
3. **「去获取」弹资源管理器**：`explorer.exe <URL>` 对带 `?gsearch=` 这种 query 的**未加引号参数**会当本地路径解析，于是 explorer 打开「我的电脑/资源管理器」而不是浏览器。且 `Command::arg()` 会二次转义，必须用 `raw_arg` 把**整条带双引号的 URL** 原样写入命令行。URL 本身没错，`startup.log` 里的 `result=ok` 只代表 explorer 进程 spawn 成功。
4. **刷屏的根在数据层，不在样式层**：`scan_save_games` 把「当前启用集合的依赖缺口」这条**报告级**风险，在 `for dir in save_dirs` 循环里塞进**每张存档**的 `risks`（N 个存档 × 38 条缺口）；前端又无条件 `save.risks.map(...)` 全渲染、无折叠，`.save-grid` 默认等高把同行卡片一起拉长。
5. **ArchiveXL 前置消失**：`refine_payload_root` 用「直接子目录里散文件个数」打分挑安装根。ArchiveXL 包里 `Bundle/` 有 21 个 `.xl`，压过真正包根的 6 分 → `Bundle` 被误判为安装根，只把 `.xl` 部署到 `archive/pc/mod/`，`red4ext/plugins/ArchiveXL/ArchiveXL.dll` 根本没进 `plannedFiles`。批量更新按这份新清单「卸旧 → 装新」，DLL 从游戏目录被卸掉且没装回 → 框架探测失败 → 38 个启用模组缺前置。**不是用户删的**。

## 走过的错误假设

- 一开始怀疑用户手动删了 ArchiveXL（用户已明确「我应该没动过」）。查环境快照、更新备份与 `launcher-state.json` 后确认：是批量更新自己重写了 `plannedFiles` / `deployedFiles`。
- 以为存档刷屏是纯前端问题，「加个折叠就行」。折叠只能治标，数据层仍在复制 38×N 条；必须把风险提升到报告级 `globalRisks`。
- 以为面板遮盖是 `z-index` 数字不够大，加大即可。父级层叠上下文困住子元素，改数字完全无效；最终 `createPortal` 到 `document.body` + `position: fixed` + 视口夹取。
- 以为角标不消失是 `localStorage["ncl.ui.bellSeenAt.v1"]` 没写进去 / 被重置。实测写入正常，是角标表达式里混进了永远不衰减的状态量。
- 以为「去获取」是 URL 拼错、缺协议头或 scheme 未注册。日志里的 URL 完整且 `result=ok`；真因在 explorer 的**命令行参数解析**，与 URL 内容无关。
- 修安装根时第一版想「给 `Bundle/` 加黑名单」。治标，遇到 `Scripts/`、`r6/` 这类还会错；改成「游戏根锚点优先」这个**正向判据**：包里只要存在 `archive/bin/r6/red4ext/engine/mods` 直接子目录，最浅的那个就是安装根，散文件数量不再能翻盘；无锚点才退回原打分。
- 本机数据修复脚本首次报 `TypeError: unsupported operand type(s) for +: 'WindowsPath' and 'str'`：`base/'backups'/'incidents'/'archivexl-misplaced-' + stamp` 里 Path 与 str 用了 `+`。改成括号包住字符串拼接后成功。
- `cargo check --lib` 冒出 1 个 `unused doc comment` warning：局部变量上误写 `///`，改成普通 `//`。

## 代价 / 新约束

- `SaveScanReport` 新增 `globalRisks`，**改了序列化契约**：`types.ts`、`mock.ts`、`check-saves.mjs` 必须同步；旧扫描结果靠 `#[serde(default)]` 兜底为空数组。前端 `RiskList` 每张卡片 / 全局横幅**各自独立**记展开状态，默认只显示 3 条。
- 铃铛面板 portal 到 body 后：点击外部判定必须同时检查按钮 ref 与面板 ref；坐标要乘 `currentUiZoom()` 并夹取视口；`resize` / `blur` 主动收起。新增 `bellEntrySeenAt`（打开前水位）用于区分新旧活动。
- `explorer_url_arg()` 拒绝引号与控制字符，含这些字符的外链会被 `INVALID_URL` 直接拒掉（刻意保守）；`open_via_explorer` 的兜底 `open::that_detached` 仍走 ShellExecute、仅在 spawn 失败时触发，**提权进程下该分支表现未单独验证**。保留 explorer 中等权限转交约束，未改回裸 ShellExecute。
- 安装根锚点判据下，若包内出现**多个同级**游戏根锚点目录，返回 `LAYOUT_AMBIGUOUS` 要求手工导入，不再猜。
- `apply_update` 新增核心 DLL 护栏：对比旧 `deployedFiles[].relativePath` 与新 `plannedFiles`，缺 `deps::is_core_framework_file` 命中项就报 `UPDATE_INCOMPLETE`、清理临时暂存、**旧版原封不动**。对「框架 DLL 改名」会保守误拦，需手动导入。
- `deps::is_core_framework_file` 成为 deps 与 updates 的共享判据，以后框架清单调整要同步两处语义。
- 本机 `launcher-state.json` 属**运行时数据、不在仓库内**：本次修复（备份 + 28 文件重新硬链接 + 清单重建 + 21 个错位文件归档）只对本机生效；别的机器若已中招需重导 ArchiveXL 或按同一手法处理。
- 本轮未升版本号 / 未构建 exe / 未替换 release / 未打 ZIP / 未发 Release。按交付顺序先 localhost 验收，用户确认「没问题」后才走收尾；便携 ZIP 仍需单独确认。

## 下次第一步查什么

1. **角标 / 红点不消失**：先分清「未读事件数」与「持续状态量」，看角标表达式里混了什么；再查 localStorage 水位写入时机，别默认「没存上」。
2. **浮层被盖**：先用 `getComputedStyle` 找父级层叠上下文（`relative + z-index` / `transform` / `filter` / `opacity`），别急着加 z-index 数字；用 `document.elementFromPoint` 做命中测试断言。
3. **外链拉错程序**：先看**实际命令行参数**，再严格区分「进程 spawn 成功」与「目标程序行为正确」；日志 `result=ok` 不是验收。
4. **列表刷屏**：先查数据源是不是把报告级信息 replicated 到每个条目，再谈前端折叠与样式。
5. **模组前置莫名消失**：先 diff 更新前后 `plannedFiles` / `deployedFiles` 清单，再看安装根判定结果；别先怀疑用户删文件。
6. **「判根 / 判型」类修复**：优先找正向锚点，不要靠黑名单逐个排异常目录。

## 验证留痕

- 全量门禁 **39/39 全绿**（373s 工时，含 `cargo test` core-tests 66.4s、`tsc --noEmit`、`vite build`、存档管理与通知降噪新增断言）。
- `i18n:check` 0 处、`i18n:unused` 0 条（词表 2300 条、未引用 0 条）；`cargo check --lib` 0 warning。
- 新增回归：`url_tests` 4 条（query URL / plain URL / 多参数+fragment / 拒绝注入字符）、`update_guard_tests` 4 条（丢 DLL / 保留 DLL / 普通文件不误判 / 大小写与分隔符归一化）、`framework_bundle_does_not_steal_payload_root` 真实 ArchiveXL 包结构 1 条。
- Playwright 门禁：`check-notify-noise.mjs` 补 5 条已读态断言 + 1 条 `elementFromPoint` 命中测试；`check-saves.mjs` 把恒真的 `>= 0` 换成 6 条真实断言（卡片 ≤3 条、横幅只出现一次、默认 3 → 展开 12 → 收起 3、卡片不再重复整批环境风险、`align-items:start`）。
- 本机数据：备份 `launcher-state.json.before-20261114-archivexl-fix` 与 21 个错位文件到 `backups/incidents/archivexl-misplaced-20261114-archivexl-fix/`；`red4ext/plugins/ArchiveXL/ArchiveXL.dll` 1,963,008 B 存在；**28/28** 部署目标存在；`archive/pc/mod/` 条目 162 → 141。

## 遗留

- #10③ 浏览器拉起需**真机点「去获取」**确认；`startup.log` 的 `result=ok` 不能当验收。
- 兜底 `open::that_detached`（ShellExecute）在提权进程下的表现未单独验证。
- 更新护栏对「框架 DLL 改名」保守误拦；多个同级游戏根锚点会要求手工导入。
- #2–#9 长期功能轨道本轮未动（用户范围确认）。
- 同批改动尚未经用户 localhost 视觉与交互验收；验收通过前不构建 exe、不替换 release。
