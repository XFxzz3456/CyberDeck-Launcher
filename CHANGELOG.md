# CHANGELOG — CyberDeck Launcher（原 NightCity Loader）

> 记录每次迭代的主要变更、时间与涉及模块，供快速回查。
> 项目自 2026-10-31 起以 MIT 开源：https://github.com/XFxzz3456/CyberDeck-Launcher
> 本文件与 `HANDOFF.md`、`docs/PROJECT_HISTORY.md`、git 历史共同构成版本追踪依据。

**维护约定**

- **一个日期一条记录**：同一天内的多个批次合并为一条，按「新增 / 变更 / 修复 / 移除」归类；只有跨版本线（0.7 → 0.8 → 0.9 → 1.0）才新开版本段。
- `-rN` 是同日构建批次号，**不参与 SemVer 比较**。合并后的记录在段内用「r26–r33」标注覆盖范围，二进制产物统一登记在文末「发布产物记录」。
- 发版前跑 `node scripts/bump-version.mjs`（默认 dry-run，按证据判定 patch/minor/major）；`--apply` 同步 `package.json` / `Cargo.toml` / `tauri.conf.json` 并在本文件插入新条目。三处一致性由 `node scripts/check-version-sync.mjs` 把关（CI 也跑）。
- 整条发版链用 `npm run release`：门禁 → 升版 → `tauri build --no-bundle` → 备份并替换 `release/CyberDeck Launcher.exe`（打印大小与 md5）→ 打印 commit / tag / push 命令。脚本**不** commit、不 tag、不推送、不打便携 ZIP。
- 事故复盘、架构决策与里程碑统一归档在 `docs/PROJECT_HISTORY.md`，本文件只留摘要与锚点链接。

## 版本演进史（总览）

| 版本 | 时间 | 主题 |
| --- | --- | --- |
| `0.7.0` | ≤ 2026-10-24 | 基线功能：库 / 导入 / 部署 / 冲突 / 排序 / 主题 / 诊断 / Nexus / AI |
| `0.7.1` | 2026-10-25 | UI 审计 13 条 + Nexus 差距 7 项 |
| `0.7.0` r2–r4 | 2026-10-26 | 三起稳定性事故（完整性标签 / 状态解析 / dev 构建）+ 单实例托盘 + 界面四项 |
| `0.8.0` r1–r4 | 2026-10-25 → 10-26 | 品牌更名、主题解耦、设置 Tabs、Nexus Collections、回归门禁、NXM 接管 |
| `0.8.0` r5–r10 | 2026-10-27 | AI 接入去服务商化、UI 文案规范、i18n 架构与全量迁移 |
| `0.8.0` r11–r19 | 2026-10-28 | EULA 门、浅色对比度令牌、动效体系、响应式布局 |
| `0.8.0` r20–r21 | 2026-10-29 | 下载中心重排、图标与主题收尾、Anthropic 原生协议 |
| `0.9.0` r22–r25 | 2026-10-29 | 0.9.0 八项冲刺、分类引擎重写、侧栏三段式 |
| `0.9.0` r26–r33 | 2026-10-30 | 自定义背景图、批量操作、四模块（路径/下载/工具链/显示）、依赖检查 |
| `0.9.0` r34–r35 | 2026-10-31 | AI 汉化与 AI 补丁落地、滚动与行高修复 |
| `1.0.0` | 2026-10-31 | 首个正式版：开源、文档治理、字重体系、背景图构图、存档与通知 |
| `1.0.0` 批次 1–4 | 2026-11-01 | 更新检查与自更新、毛玻璃层级、工具栏分组 |
| `1.0.0` 批次 5–9 | 2026-11-02 | 体检降噪、兼容性体检重写、AI 可执行修复、AI 多配置、退出弹窗、Nexus 401 |
| `1.0.0` 批次 10 | 2026-11-03 | SVG 图形徽章、列表接管标签、i18n 门禁转绿 |

### 版本号规则

| 级别 | 触发条件 | 例子 |
| --- | --- | --- |
| **MAJOR** | 持久化结构变更 / 数据迁移 / 删除命令 / 改 `identifier` | 老用户升级后需要做出动作 |
| **MINOR** | 新增 Tauri 命令、新增模块、新增组件 | 功能只增不减，向前兼容 |
| **PATCH** | 修 bug、调样式、改文案 | 用户无感或只感觉到「变好了」 |

---

## [1.0.0] - 2026-11-03（批次 10）

### 新增

- **Logo 改纯 SVG 图形徽章**（新增 `LogoMark.tsx`，`Sidebar.tsx` 接入）：三套方案并存，切换只改 `LOGO_VARIANT` 一行——`A` C/D 几何融合 + 切角断线、`B` 数据芯片 + D 形插槽、`C` 六边形扫描徽章。当前启用 **B**。
  - 三套统一 `viewBox="0 0 40 40"`、主体落在 3~37 安全区；描边一律 `currentColor`，由 `.logo-mark` 的 `color: var(--accent)` 提供，赛博主题下为 `#fcee0a`、现代黑白下自动变纯黑/纯白，无需按主题各写一套。
  - 未改动：`.logo-mark` 43×43 占位、图标宽度、右侧「CYBERDECK / MOD LOADER」排版；`.logo-glyph` 类名保留，hover 的 `scale(1.06)` 与 `drop-shadow` 自动继承。
- **列表视图补齐「接管」标签**（`ModRow.tsx` + `.row-chip-adopt`）：`origin == "adopted"` 的模组此前只有卡片视图能看出文件在外部目录，现在两种视图口径一致。

### 修复

- **CI i18n 门禁红叉**：`DownloadsView.tsx` 残留 1 处中文，实为匹配 Rust 后端错误回传（`401` / `API Key 已失效` / `Key 无效`）的正则，不是界面文案。抽成模块级常量 `AUTH_ERROR_RE` 并加 `// i18n-ignore` 说明它是协议字段，`check-i18n --fail` 由 1 处降为 0 处。

### 变更

- `.logo-mark` 底板从「实心 accent 色块 + 深色字」改为 `color-mix(in srgb, var(--accent) 12%, transparent)` 淡釉 + `inset 0 0 0 1px` 45% 描边，图形本体反向变成 accent 描边。
- 移除 `.logo-mark::before` 那层 `inset: 4px` 内框：43px 方框里塞三层线会把 27~30px 的图形压糊。启动致命错误页 / 开机启动页仍是实心 accent 块，`--accent-ink` 只留给它们。

### 验证

- `npx tsc --noEmit` exit 0；`vite build` 通过。
- `check-commands` 146/146（invoked 141，missing 0）；`check-i18n --fail` 0 处 0 文件。
- 真实侧栏截图（30px 图形 / 43px 徽章，`deviceScaleFactor: 3`）在 Cyber `#FCEE0A`、Netrunner `#3DF2FF`、Mono `#F2F2F2`、Daylight `#B23A0E` 四套主题下确认可读。

### 已知边界

- A / C 方案代码完整保留在 `LogoMark.tsx`，改 `LOGO_VARIANT` 即可切换；A 在 30px 下 D 的横臂偏小、C 的三条扫描线略像「≡」。
- 本轮只改前端渲染，Rust 未动，`cargo test` 未重跑。

---

## [1.0.0] - 2026-11-02（批次 5–9）

### 新增

- **动画速度滑块**（0%–150%，默认 100%，0 = 直接关动画）：设置 → 个性化底部折叠面板 `// ADVANCED`，落盘并实时生效。实现走 `--motion-scale` + `useMotionFactor()`，弹簧按 `stiffness/f²`、`damping/f` 缩放，tween 按 `duration×f` 缩放。
- **AI 诊断可执行修复**：`ai_diagnose` 的 JSON 契约新增 `actions[]`，模型只能从四个 kind 里选——`disableMod` / `enableMod` / `moveLoadOrder`（first|last）/ `proposePatch`，最多 3 条；诊断上下文补 `mods[].id`，模型才有办法指向具体模组。
  - 文字报告与 `fixSteps` 保持原样，下方新增「可执行修复」虚线按钮；点击 → 二次确认 → 才调 `ai_apply_action`。后端再校验一遍白名单，**先写环境快照再动磁盘**，快照写不出来直接中止。执行完自动重拉整份诊断。
  - `proposePatch` 不落盘，只把用户送回既有 AI 补丁流程，补丁代码仍需逐行确认后部署。
- **AI 多套配置**：本地 Ollama / 云端 / 中转站各存一套，卡片显示名称、模型、是否已存密钥、是否在用；「使用」一键切换，「测试连接」在保存前就验通不通（显示耗时与模型数）。
  - 密钥**按配置独立 DPAPI 加密**（`secrets/ai-profile-<id>.key`），换配置不串 key；老用户原 key 变成「默认配置」继续用旧文件 `ai-api.key`，**不会丢**。激活时把值同步写回 `settings.ai_base_url/model/protocol`，诊断/翻译/AI 修复等老调用点零改动。
- **退出确认弹窗**：点 × / Alt+F4 时先问「最小化到托盘」还是「彻底退出」，可勾「记住我的选择」；托盘右键「彻底退出」始终直接退出，不弹窗。设置页新增「点 × 时先确认」开关。
- **Nexus 401 出口**：设置页 Nexus 卡片新增「测试连接」，失败给出 **HTTP 状态码 + 原因 + 去重新生成 Key** 的直达入口；下载页遇到鉴权失败也带「前往 Nexus 设置」。
- **通知限时化**：错误/警告通知不再永久常驻，停留 = 全局时长 × 2；悬停暂停、移开续跑、可手动关闭；同类通知合并为「标题（已发生 N 次）」并重置倒计时；Toast 层级提到 RECENT ACTIVITY 之上（`--z-toast: 75`）。
- **补全封面入口迁到工具栏**：设置页按钮移除，模组库工具栏新增「补全 ▾」下拉（补全信息 / 补全封面）；「更多」收纳菜单同步。

### 变更

- **兼容性体检重写**：不再遍历 186 个 Mod 去找并不存在的 `gameVersion` 元数据（老实现把 114 个标成「兼容性未知」），只查核心前置 RED4ext / ArchiveXL / TweakXL / Codeware——齐全 → 一条绿色 `[未发现明显不兼容]`；缺前置 → 红字 + 期望路径；目录在但主文件不在 → 黄字「安装不完整」。风险列表最多 4 条。
- **版本号显示社区叫法**：新增 `gamever` 模块把 exe 内部四段号按阈值映射成玩家说法（`3.0.88.46235` → **2.5**；此前截前三段显示 `3.0`，比原文更误导）。侧栏、设置页游戏卡、诊断页、安全模式卡片统一走这层，前后端阈值表由守卫脚本强制一致。
- **环境体检降噪**：`.xl` / `.xlp` / `.reds` / `.lua` / `.json` / `.toml` / `.ini` 等脚本与配置**只查存在性**（工具会反复重写）；其余文件大小比对加 **1KB 容差**；等级改为 `healthy / info / warning / critical` 四档，**只剩时间戳变化 → 灰「提示」**，不再整块打黄灯。措辞去警报化（`大小异常` → `文件状态变更`、`被改写` → `状态变更`），列表下方补一行「可忽略」小灰字。
- **一键修复在无可修项时置灰**：只有状态变化时没有需要重建的链接。底层切断链接重新部署的逻辑未改动。
- 毛玻璃质感批次：标题栏与主顶栏统一同材质、抹掉分割线；右上角统计栏改 85% 实底 + 高光描边（禁 blur）；工具栏下拉去死黑改半透明胶囊；亮色模式专项调整。卡片文字区与底部操作条垫 94% 不透明底板，封面 140→160px。

### 修复

- **播放集下拉在非 100% 缩放下歪**：真因不是锚点，而是 UI 缩放（body zoom）把 fixed 浮层坐标二次缩放（110% 右飘 80px、90% 左飘 66px）。修复为坐标除以 body zoom，门禁补 90/100/110% 三档对齐断言。
- **切页后背景图异常模糊**：主内容区 `.content` 不再叠 `backdrop-filter`，模糊只留在面板上。
- **补全封面误报**：对丢失 Nexus 引用的收编模组改为按文件名溯源 ID（`名称-28099-1-0-0` 特征），认得出就回查并写回引用。
- **Spring 参数过冲**：`springSnappy` 480/38/0.9 → 300/34/1（临界阻尼）、`springOverlay` 260/32/1、`springHover` 380/32/0.7、`mechanicalSpring` 380/22。
- **AI 偶发空响应**：拆出 `request_once`，首跳为空时延迟 1 秒、降温度 0.7、`max_tokens ≥ 2048` 重试一次；仍空则打印截尾 2000 字符的原始响应体（不含 Key）并给 `AI_EMPTY` 引导文案。`diagnose` 输出上限 1200 → 2400。
- **AI 日志塞爆上下文**：`collect_logs` 每份日志按 char 边界截尾到 2000 字符并加 `[日志已截断]` 标记。
- **收编（Vortex 接管）模组无法禁用**（用户实测「恢复目标已存在，请先检查暂存目录 …\staging\adopt-xxx」）：真因是 `undeploy_mod` 对**收编**模组也走了「暂存丢了就从游戏目录复制一份回去」的恢复逻辑——收编模组的母本在外部工具目录，这层恢复既无意义，目标目录名被占时还会把禁用卡死（本机 187 个模组全为收编，其中 24 个 `stagingPath` 仍指迁移前旧路径）。现在收编禁用**只按清单断链接**、永不进恢复分支；暂存副本不存在时硬链接的 inode 校验降级为信任清单（否则一条链接都断不掉，禁用是假的），并提示「重新启用需重新收编」。
- **启用时暂存丢失会把模组从库里删掉**：`deploy_mod` 兜底原本对收编模组执行 `forget_mod`，用户点一下启用条目就消失。改为返回 `ADOPT_STAGING_MISSING` 明确报错，条目不丢。
- **确认弹窗被关掉后窗口僵住**：关闭拦截留在 Rust（`prevent_close` + emit `close-requested`），真正的隐藏/退出由 `close_window_action` 执行。
- **5 个测试文件从未被编译**：`adopt_tests` / `installer_tests` / `game_tests` / `ai_tools_tests` / `nxm_tests` 共 1609 行，`lib.rs` 缺 `mod xxx_tests;` 导致 `cargo test` 长期只跑内联的 182 项。接回后 3 条断言旧行为的用例按新契约重写，并新增逐字复现「暂存指旧路径 + 同名目录被占」的回归用例。

### 移除

- 删除 `CompatBadge` 组件与样式（承载的正是「兼容性未知」角标语义），以及 `compat.staleLabel / staleTip / warnLabel / warnTip / warnToggle / summary` 六条词条。

### 验证

- `cargo test` **262 通过 / 2 ignored**；全量门禁 **41/41 绿**（新增「兼容性体检（防焦虑）」「AI 可执行修复」「AI 多套配置」「关闭确认与 Nexus 401」「收编禁用红线」五个脚本）。
- 构建 exe 11,262,976 B / md5 `acbe573c37bb9cd02d12245fea8d2aa0`，便携版 5,357,550 B。

### 已知边界

- 容差固定 1KB，不随文件大小浮动；时间戳差异仍会记录（排查「文件被谁动过」时它是唯一线索）。
- 「未判前置版本过旧」：判断过旧需要随游戏版本走的最低版本基线，写死数字等于制造假警报；报告里只回显读到的文件版本。
- 动作只覆盖模组级操作，不碰框架安装/卸载；`proposePatch` 只做移交提示，不自动打开补丁对话框。

## [1.0.0] - 2026-11-01（批次 1–4）

### 新增

- **Mod 自动检查更新**：工具栏「检查更新」先拉 Nexus「近一月有变更」清单（一次请求），再按配额逐条核对版本，比逐个查详情省一个量级的请求额度。
- **一键全部更新**：命中后出现「全部更新」，逐个下载 → **先备份旧版本** → 替换 → 原本启用的重新部署；单个失败不连坐。每次更新在 `cyberdeck-data/update-backups/<id>/` 留旧版 zip 与清单，详情页可「回滚到 x.y」。
- **启动器自更新**：设置 → 关于新增「检查启动器更新」，从 GitHub Releases 的 `latest.json` 拉取并校验签名（minisign 公钥内置），下载后重启生效。
- **毛玻璃层级化（L1/L2/L3）**：容器层 `rgba(18,18,20,.6)` + `blur(24px)`；卡片层 `rgba(24,24,27,.85)` + `blur(8px)` + 高光描边；悬浮层 `rgba(20,20,24,.75)` + `blur(32px)`。新增 `data-glass` 开关，只有**现代主题**或**开了自定义背景图**时才为 `on`——赛博四主题在没开背景图时一条玻璃规则都不命中。
- **赛博主题碳灰层次**：主背景 `#0a0a0c`、顶栏侧栏 `#08080a`、设置面板 `#151518`、Mod 卡片 `#18181b`，靠明度分层而非模糊。
- **工具栏左右分组**：左「视图与过滤」（结果数 / 状态筛选 / 排序 / 分组 / 视图切换）、右「动作与工具」（归类 / 多选 / AI 工具 / 检查更新 / 补全 / 导入方式），组内 8px、组间 24px；「AI 汉化」与「翻译名称」合并成「AI 工具 ▾」。窄窗口自动收档，任何宽度下按钮互不重叠、不横向溢出。
- **AI 汉化入口提到明面**：详情抽屉新增「AI 汉化…」主按钮（已汉化显示「重新生成」），卡片打「中·AI」徽标，工具栏加「AI 汉化」下拉（汉化选中 / 全部），批量进度进任务中心。
- **分类以 Nexus 官方分类为主**：判定顺序 `手动指定 > Nexus category > 文件内容 > 文件名`；官方分类映射不出来（Miscellaneous/Environment）时只看文件内容。多选后可在批量条直接改分类，写入即锁定。

### 变更

- 版本比较改为按段数值比较：`1.0` 与 `1.0.0` 视为同一版本；`1.10 > 1.9`；`1.2.3b > 1.2.3`；`1.0-beta < 1.0`。
- 更新检查不再把「配额用完没查」当成「没有更新」——报告单列 `stale` 条数并说明。
- 设置卡片与普通卡片统一底色（去掉设置页额外混的 12% 白）；工具栏下拉面板补进 L3 悬浮层。
- 文字对比度：赛博主题下 `--muted / --muted-2 / --text-2` 全部改实色，`ui-audit` 的 `contrastFails` 回到 0；`.app-shell` 那句常驻 `radial-gradient` 是「幽灵灰圈」的元凶，现只在玻璃模式保留。

### 验证

- `tsc --noEmit` 0 错、`vite build` 通过；门禁随批次累加至 35 项（批次 5 复核 `cargo test` 196 通过）。

### 已知边界

- Nexus 免费账号拿不到直连下载地址，「全部更新」需 Premium 或手动下载导入。
- 自更新只对 NSIS 安装包安装的版本生效；便携版仍需手动替换 exe。
- `updated.json` 只覆盖最近一个月有变更的模组，更早的依赖详情接口，配额内没排到的计入 `stale`。

---

## [1.0.0] - 2026-10-31（首个正式版，覆盖 r36–r45）

> 三处版本号统一升至 `1.0.0`。以下按**面向用户**的能力组织；r36–r44 的工程化过程附在其后。

### 新增

- **存档管理**：一键给存档目录拍快照，应用前强制确认并自动备份；扫描存档并显示上次扫描时间。
- **通知中心**：顶栏铃铛聚合最近活动与未读角标；四类通知可分别开关（冲突提示强制开启）；停留时长可配（3 / 5 / 10 秒、1–60 秒自定义或不自动隐藏），警告与错误始终手动关闭。
- **自定义背景图全面升级**：选大图自动压缩优化；新增「调整构图」——按住拖拽 + 滚轮缩放的头像式裁切，焦点平移、暗化遮罩、模糊滑块各司其职。
- **AI 汉化与 AI 补丁**：一键为 Mod 生成中文覆盖层（不改作者原文件）；针对脚本冲突生成独立补丁。
- **环境自愈**：启动时比对暂存区与游戏目录，能救回的救回、确认丢失的孤儿自动清理并登记。
- **Mod 展示名清洗**：从文件名导入的 Mod 自动得到可读名称（`!!!!_mime.archive` → `Mime`），原始文件名保留在详情页。
- **列表视图**：按分类折叠、状态筛选（已启用/已禁用/缺前置）、版本与大小列对齐，500+ Mod 滚动依旧流畅。
- **背景图填充与构图**（r43）：铺满 `cover` / 完整显示 `contain` / 拉伸三模式 + 焦点 X/Y 滑块（0–100%，默认 50%）+ 重置居中；新增**独立层**全局暗化遮罩 `.app-backdrop-dim`，`contain` 留白处一样被压暗（若跟着图片尺寸走，正文会压在一条全亮的白边上）。
- **UI 量化审查进门禁**（r37）：`check-ui-audit.mjs` 九项断言（四档分辨率内容宽度 / 长文本溢出 / 80·125·150% 缩放 / 两套主题对比度 / 字号离群 / 表单对齐 / hover-active / 页面报错）。

### 变更

- **字重与排版层级重构**（r42）：根因不是「中文伪粗体」，而是 `600` 被 Chromium 吸附到 `Microsoft YaHei UI` 唯一真实字面 700，导致「区块小标题」与「页面大标题」一样粗。新增 8 个排版令牌（`--fw-display/title/label/body/hint/mono/badge/logo`）+ 4 个字号语义档，63 处字面字重按行号迁移；`font-synthesis: none` 防止将来再写 600 被伪造。
- **拖动标题栏改原生通路**（r41）：删除整套 JS 拖动（`windowDrag.ts`），改用 `data-tauri-drag-region="deep"`；`deep` × 2（标题栏/顶栏）、`false` × 4（搜索框/档案选择器/动作区/窗控）三档语义。
- **通知降噪 P1**（r40）：单次启用/禁用完全静默（结果由卡片角标 + 活动流 + 状态栏承载）；新增 2 秒合并窗口 `createCoalescer`，≥2 次操作才合并成一条汇总；冲突、权限不足、跨盘降级、缺前置、未挂游戏目录五类改 sticky。
- **个性化页拆成 6 张卡**（r38）：01 主题与配色 / 02 左侧导航栏 / 03 窗口与侧边栏 / 04 字体与排版 / 05 背景图 / 06 动效与启动；窄窗（<1120px）自动单列。零存储键变更。
- **超宽屏收窄**（r37）：`.page` 加 `max-width: 1680px` 居中（2560×1440 下内容原本实测 2300px）；次要文字对比度 `--muted-2` `#767a83` → `#82868f`，失败项 5 → 0；四类控件补 `:active` 反馈（覆盖 6/10 → 10/10）。
- **顶栏按需显示**：搜索框 / 播放集 / 导入按钮只在模组库、发现、加载顺序页出现；「开始游戏」永远在。播放集下拉弃用系统原生、改毛玻璃自绘菜单。
- **全局禁用文本选中**：拖拽 / Ctrl+A 不再选中整片 UI，输入框、日志、报错文案仍可复制。
- **开源与文档治理**（r36 / r39）：仓库公开（MIT，默认 `main`，tag `v0.9.0-r35`）；提交身份改写为 `XFxzz3456 <mc2364694314@163.com>`；20 份零散报告提炼进 `docs/PROJECT_HISTORY.md`（367 行）后删除原文（3032 行），38 处引用改为锚点链接。

### 修复

- **窗口拖拽残影**：同一次 `mousedown` 有两条拖动通路各调一次 `start_dragging`，位移叠加 + WebView2 拖动期间不重绘。删 JS 通路并给两条顶部栏补 `user-select: none`（选区高亮是残影第二来源），搜索框显式开回 `text`。
- **AI「用不了」悬案**（r44）：DeepSeek 预设填的是不存在的 `deepseek-v4.1-flash-1017` → `deepseek-flash`（旧名在 `normalize.ts` 静默迁移）；裸域名获取模型 404 → 无路径段时自动补 `/v1`；「获取模型」超时 75s → 15s；HTTP 400 分场景（对话/诊断/翻译 vs 拉模型列表）。
- **遮罩拉到 0% 屏幕还是黑**：主内容区不再垫常驻深色底板，暗化只由遮罩滑块控制；模糊改跑独立合成层。
- **部署防崩溃**：暂存目录丢失时给出友好提示并自动清理登记，不再报一堆错误码。
- **审查脚本假阳性**（r37）：塌陷判定只查元素自身 `display`，把有意的让位设计算成塌陷；改用 `checkVisibility` 后可识别祖先隐藏，`scaleBroken 3 → 0`——缩放布局本来就没坏。
- **README 事实错误**：原文写「六套主题（含 Mono / Daylight）」，实际 5 套且仅 Modern 支持明暗；重拍 23 张截图，补齐从未写过的「存档管理」。
- 首发前清理的老问题（升级丢库、兼容扫描误报 2.21）真因与回归见 2026-10-26 / 0.9.0 各段，此处不重复。

### 验证

- 门禁 **27/27 全绿**（r37 时点，新增 `check-ui-audit` 9 项断言）；UI 实测 `viewports=4 · hScrollMax=0 · overflowTotal=0 · scaleBroken=0 · contrastFails=0 · alignSpread=0 · hoverRules=10 · pageErrors=0`。
- `check-typography` 22/22、`check-window-drag` 12/12、`check-notify-noise` 8/8、`check-layout-scroll` 5 页遍历全过。
- `cargo test` 145 通过 / 2 ignored；`tsc --noEmit` 0 错；`vite build` 通过。

### 已知边界

- r36 只做版本控制与仓库公开，**未构建 exe**；公开仓库意味着全部源码与历史对任何人可读，需持续避免写入隐私与密钥。
- 8 张特殊状态截图（`warning-strip` / `game-root-warning` / `update-lock` / `missing-prereq` / `danger-hold` / `import-review` / `task-center` / `log-extract`）仍是旧图，它们依赖 mock 未提供的后端状态，硬凑只能造假。
- 装饰性小字（版本号 9.5px、`logo-sys` 7.5px、`kbd` 8.5px 等 27 处）保留原尺寸，属 HUD 视觉语言。

---

## [0.9.0] - 2026-10-31（r34–r35）

### 新增

- **T5 AI 汉化落地**（`ailoc.rs`）：扫描 onscreens/扁平本地化 JSON → 作者意愿三态判定 → 词表优先、未命中走真实 AI → 生成 WolvenKit 格式 JSON + ArchiveXL 覆盖层 → WolvenKit 打包 `.archive` → 部署并登记 `ai_loc` 清单 → 一键撤销。
- **T6 AI 补丁落地**（`aifix.rs`）：脚本片段外发前告知字符数 → AI 生成独立 `AIFix_*.reds` → 结构校验（模块名/注解/括号配平/危险 API 黑名单）→ 确认后写入 `r6/scripts/cyberdeck-ai-fix/` → 单独撤销。
- `scripts/check-layout-scroll.mjs`：1280×800 下遍历 5 个页面，断言「长内容必须真能滚」「承载文本的元素行高 ≥ 字号 ×1.1」「各页 `clientWidth` 一致」。

### 变更

- UI 门禁脚本统一跟随 `GATE_PORT`（35 个脚本 / 47 处硬编码 1420 地址）；弹窗加 `max-width: calc(100vw - 48px)`、右键菜单加 `max-height + overflow`。
- 便携版包名去掉「可直接发人」后缀，统一 `CyberDeck Launcher 0.9.0 便携版-rNN.zip`。

### 修复

- **取消部署后无法重新部署**：新增 `recover_staging()`，暂存断链时按原部署清单从游戏侧文件重建副本（校验归属 + 大小 + 修改时间，只 copy 不硬链）；`undeploy_mod` 在清空清单**之前**先恢复。数据被外部改过返回 `STAGING_RECOVERY_CHANGED` 拒绝恢复。
- **存档管理页滚不动**：`.page` 的 `overflow-y: auto` 是按页面类名逐个登记的，漏了 `.saves-page`，整页被 `.content` 的 `overflow: hidden` 裁掉——不是滚不动，是压根没有滚动容器。
- **切页时文字横跳**：可滚页面有 9px 滚动条占位、`overflow:hidden` 的页面没有，切页宽度差 9px → `.page` 统一 `scrollbar-gutter: stable`（差值 9 → 0）。
- **文本行盒比字号还矮**：`.page-head h1` `line-height: 0.98`（33px 字号配 32.34px 行盒）等 9 处改为 ≥1.1，消除中文满格字形的上下沿裁切。
- **触屏/手写笔无法拖动顶部栏**：`windowDrag.ts` 增 Pointer Events 通路（`pointerType==="mouse"` 不走），`.titlebar/.topbar` 加 `touch-action: none`。

### 验证

- `cargo test` **177 通过 / 2 ignored**；`tsc` / `vite build` / i18n 双向归零；门禁 **26/26**（`GATE_PORT=1427`）。
- 布局回归 `pages=5 · stuck=0 · tightText=0 · widthSpread=0 · savesCanScroll=1`。
- 构建 exe 9,115,136 B（r35 md5 `88c8605d…`、r34 md5 `96aeb0e9…`），冒烟 `stage=frontend mods=195`、`integrity=0x2000`；便携版 4,173,061 B / 4,172,810 B。

### 已知边界

- AI 汉化必须有 WolvenKit CLI 才能打包部署，缺失时只生成到 `staging/ai-loc/<id>/` 并返回 `AI_LOC_WOLVENKIT_REQUIRED`；硬编码在 `.archive`/`.inkwidget`/`.csv` 的文本不支持。
- AI 补丁只有结构校验，**未接编译校验**（报告 `compiled:false`，提示看 REDscript 日志）。
- 自动化只能证明「页面能滚、行盒不裁字、各页宽度一致」，具体控件的主观观感无法靠脚本判定。

---

## [0.9.0] - 2026-10-30（r26–r33）

### 新增

- **自定义背景图**（r28）：`backgroundImage / backgroundOpacity / backgroundBlur` 三字段 + `read_background_image`（校验扩展名与 20 MiB 上限，读字节转 `data:` URL，不放宽 asset 协议白名单）；背景层 `z-index:-1` 挂在 `isolation:isolate` 的 shell 内；设置保存改「最新值 + 串行 + 250ms 合并窗口」，滑杆连拖不再刷爆状态文件。
- **modlist 导出 / 导入 + 批量启停**（r29）：导出带 `kind/version` 签名与模组元数据快照；导入按 id 精确对 → 名字兜底，对不上的进 `unmatched` 如实报告；`set_mods_enabled` 逐个走与单个开关完全相同的部署/撤除语义，单个失败不中断整批。
- **四模块**（r30）：① 暂存盘建议（PowerShell CIM 枚举固定磁盘按剩余空间排序）+ 部署方式三选（hardlink / symlink / copy）+ 启动高级选项（显卡偏好写 `UserGpuPreferences`、进程优先级 `creation_flags`、前置命令）；② 下载中心限速（令牌桶，0–100 Mbps）+ `.nxm` 拖拽投递 + 速度折线图；③ 外部工具链管理器（登记 / 启动 / 固定到侧栏）；④ 界面显示管理（可隐藏四个入口，当前页被隐藏自动跳回模组库）。
- **依赖检查系统**（r33）：`deps.rs` 规则库 + 诊断「依赖检查」面板 + 缺依赖徽标 / 启用拦截 / 忽略表。
- **汉化包挂载**（r33）：`is_translation` / `parent_mod_id` + 绑定弹窗 + 级联启用禁用卸载 + 父子冲突豁免。
- **卡片 ⇄ 列表视图切换**（r33）：列表同样虚拟滚动，偏好落盘。
- **游戏进程联动**（r33）：运行检测 5s 轮询 + 顶栏红色「关闭游戏」，避免在游戏运行时改部署。

### 变更

- Modern 主题明暗色板重校（r27）：暗色对齐 VS Code 五级表面（相邻级拉开 4–6 步亮度），亮色对齐 Linear（白卡 + 阴影从灰侧栏浮起），对比度门禁 26/26。
- 模组库工具栏左右分区（r26）：左「结果数 → 智能归类 → 排序」，右「导入 ▼ / 检查更新 / 补全信息 / 翻译名称」，`align-items: center` 实测偏差 0.0px。
- 收编完成后立即刷新诊断；版本号社区化映射（3.0.80.51928 → 2.5，原始号进 tooltip）；CET 探测三候选（dll → init.lua → 目录兜底）。

### 修复

- **429 限流等待期的暂停/取消被吞**（r31，来源自检报告 `docs/PROJECT_HISTORY.md#audit-7modules` 的 P1-1）：`worker_body` 每循环开头无条件清旗标，等待函数感知到旗标后两个调用点却只 `continue`，回到循环开头把用户刚按下的旗标清掉。新增 `settle_interrupted()`，两处改为「读旗标 → patch 收尾 → return」。
- **混合包静默丢文件**（r31）：`detect_layout` 取第一个命中的布局，其余文件被 `continue` 跳过且毫无提示。新增 `layout_skipped()` 统计，导入与部署两处都出 warning（列前 3 个文件名 + 建议拆包）。
- **框架探测误报 MISSING（P0，r32）**：redscript 改认 `r6/scripts` 目录，Mod Settings 改认 `red4ext/plugins/mod_settings/ModSettings.dll`（CET 版 `mods/ModSettings/init.lua` 兜底）；新增 `resolve_ci` 逐级大小写不敏感解析。
- **顶栏 `CDL vv0.9.0`**：`appVersion.format()` 补 `v`，词条又写死了 `CDL v{version}`，两处重复。
- **侧栏「发现」角标不刷新**：新增 `nexusBus`（window 事件 + source 去重），连接/断开后广播，三处订阅。
- **诊断结论卡**重构为圆角卡片（48px 图标 / 两行文案 / 19px 统计数字）。
- 模组库工具栏 8 个控件挤成两行、`195 RESULTS` 与排序框基线错位（r26）。

### 验证

- `cargo test` 105 → 126（r31 增 6 项、r30 增模块测试）→ 136（r33）；`tsc` / `vite build` / i18n 0 违规 0 死键。
- 门禁 21 个 UI 脚本全绿（新增 `check-background` 13 项、`check-modlist-tools` 9 项、`check-deepseek` 21 项、`check-feedback-fixes` 22 项）。
- 构建 exe 8,754,176 B（r26+27）→ 8,848,896 B（r28–30）→ 8,897,536 B（r33），冒烟均 `stage=frontend mods=195`。

### 已知边界

- GPU 偏好 / 优先级 / 前置命令只影响直启路径，Steam 转发不生效。
- `r6/scripts` 空目录仍会误判 redscript 已装（漏判代价更高）。
- 导入对话框在浏览器演示模式不可用；批量启用遇更新熔断整批拒绝（有意防呆）。

---

## [0.9.0] - 2026-10-29（r22–r25）

### 新增

- **0.9.0 八项冲刺**（r22）：AI 汉化词表本地库与云端共享（`glossary.rs`，主键 `mod_id + FNV-1a64(原文)`，版本隔离天然成立；`by=="user"` 永不被覆盖）；启动动画（620ms + 200ms 淡出，`pointerdown`/`keydown` 跳过）；内置帮助中心（6 篇教程 + 10 条 FAQ + 搜索 + 三段切换）；全局配置导入导出（白名单 15 个标量，**绝不导出** API Key / DPAPI 密文 / Mod 库 / `deployed_files`）；Safe Mode + 过期插件扫描（只按 `deployed_files` 撕链接，绝不删 staging 本体；仅 `failed_mods==0` 才删快照）；真机验收脚本；Ollama 接入指引。配套文档：AI 深度汉化架构评审 `docs/PROJECT_HISTORY.md#ai-loc-review`（离线资源采用 / overlay 覆盖禁止 / 词表已实现）、真机排雷 `docs/PROJECT_HISTORY.md#real-env-090`、本地模型 `docs/PROJECT_HISTORY.md#ollama`。
- **AI 模型预设两级化**（r24）：14 家厂商 38 个模型（国外 5 / 国内 7 / 本地 2），`AiPreset` 增 `group` 与 `models[]`；「选模型不覆盖接口地址」，只有切换厂商才写 `baseUrl`；反查改为**只看接口地址**。
- **分类引擎重写**（r23）：新增 `category.rs` 加权投票（内容证据 6 分 > 名称/目录关键词 3 分 > 布局 1 分），`description` 彻底退出分类输入。
- **纵向档位模块 `viewportTier.ts`**（r25）：按**有效高度 = innerHeight ÷ scale** 分 `full / compact / tight / mini` 四档，CSS 按档位逐级让位。

### 变更

- 侧边栏导航分层（r23）：主操作区 + 底部辅助区，`.sidebar-scroll` 用纯 Flex 吃掉中间空白（无 absolute）；帮助中心迁入设置 Tab；设置页间距修正。
- 侧栏滚动条可见化、6px 轨道 + 强调色滑块、`scrollbar-gutter: stable`；折叠补 180ms 过渡（关动效时瞬时）。

### 修复

- **分类 168 个模组被判「工具」**：`infer_category` 把描述拼进关键词海，而 168 个收编模组的 description 是同一句模板「由外部**工具**（如 Vortex）部署…」，正好命中「工具」。重写后在真实 195 个模组上校准：「工具」168 → **0**，「其他」132（纯句柄名属证据边界）。
- **并列决胜方向反了**：`max_by_key` 并列时返回**最后一个**最大值，与「`CATEGORY_ORDER` 靠前者胜」相反，改为顺序扫描、严格大于才替换。
- **连写句柄整词匹配全废**：`compactweaponmodslots` 这类无分隔符名字命中率极低，`word_hit` 按词长分层（<5 字符整词，≥5 允许词中词），判不出来从 169 → 143。
- **core-tests 自 0.9.0-r22 起编译失败**（glossary 模块没挂进去）。
- 顶栏版本号硬编码「CDL 0.7.0」→ `useAppVersion()` 动态渲染。
- 侧栏在 110% 缩放下只剩三项：纵向预算按「标准窗口」算，而媒体查询量不到 `body zoom`。

### 验证

- `cargo test --lib` 95/95（+12 分类用例，含连写句柄与并列决胜回归）；`core-tests` 122/122；门禁 **17/17**（`check-sidebar` 22 项、`check-category` 13 项、`check-help` 5 项）；`check-commands` 104/104。
- 构建 exe 8,736,768 B（r22）/ 8,751,104 B（r23）/ 8,753,664 B（r24+25），冒烟 `stage=frontend`。
- **发布前抓到并修掉一个 P0**：`config_export` / `config_import` / `safemode_state` / `safemode_enter` / `safemode_exit` / `compat_scan` **6 个命令只定义未进 `generate_handler!`**——编译通过、冒烟正常，但前端 invoke 会报 command not found（Safe Mode / 配置导入导出 / 过期扫描三项实际不可用）。线索是编译器 `never used` 警告。由此新增 `scripts/check-commands.mjs`（定义 / 注册 / 调用三处对齐），复盘见 `docs/PROJECT_HISTORY.md#incident-command-not-registered`。

### 已知边界

- 剩余 132 个「其他」是证据边界（`amm_props`、`###-novalut4` 这类纯句柄），只能手动改分类或等 Nexus 分类反查。
- 不补 `amm` / `sp0` / `nova` 之类品牌句柄——那是拿这一库数据过拟合。
- 分类写入前先导出 Rust 逐条判定 → 同构脚本复算 → **195/195 一致才写盘**，写前备份 `launcher-state.pre-r23.json`。

---

## [0.8.0] - 2026-10-29（r20–r21）

### 新增

- **下载中心重排为任务列表页**（r20）：目录 / 并发 / 自动导入 / 代理四张表单迁到「设置 → 工具组件 → 下载设置」；新增全局操作条 `[全部开始] [全部暂停] [清除已完成] [打开文件夹]`（前端逐个调既有命令，不新增 Tauri 命令）。
- **Anthropic 原生协议**（r21）：新增「接口协议」下拉（OpenAI 兼容 / Anthropic 原生），持久化 `api_protocol`；Rust 侧 `match protocol` 分两套 Header/Body——Anthropic 走 `<base>/v1/messages` + `x-api-key` + `anthropic-version: 2023-06-01`、强制 `max_tokens: 4096`、系统提示词提到顶层 `system`、`messages` 只留 user/assistant（`sanitize_anthropic_messages` 处理开头 assistant / 连续同角色 / 空消息）。
- **智能归类按钮**：`reclassify_unclassified` 只动「其他」分类，手动设置过的分类不碰。

### 变更

- 图标全套重制（`assets/icon-cd.png` 经 `tauri icon` 生成 ico/png/Square*，清理 android/ios 产物）；窗口标题 `CyberDeck Launcher` → **`CyberDeck`**（`productName` 不动）。
- Logo 改纯文字（删 r7 的几何 SVG，黄块压 19px/900「CD」）；**删除 Mono 主题**（老配置自动迁到 modern 并保留明暗偏好）。
- 缩放三档按钮换滑块（80%–150%，step 5%，`clampScale` 钳制并按 5% 取整）。
- 下载中心空态文案、WolvenKit/解压工具输入框补 `title` 悬停看全路径、超时输入框左右布局。

### 修复

- 分类关键词扩到 9 组 60+ 词；ASCII 短词改整词匹配（旧版 `"car "` 会漏行首、`contains("cet")` 会误命中 `cetocide`）。
- 侧栏溢出：长路径加 `word-break: break-all` + `overflow-wrap: anywhere`。

### 验证

- `cargo test` 64/64（r20）→ 67/67（r21，含 Anthropic 端点拼接、消息净化、mock HTTP 全链路双协议用例）；`tsc` 0 错；i18n 双向归零。
- 构建 exe 8,585,216 B / md5 `C7F00C3E…`（r20）、8,607,232 B / md5 `FCF49BDF…`（r21），冒烟 `integrity=0x2000`。

### 已知边界

- 流式（SSE）本轮不涉及；Anthropic 不支持 `response_format`，JSON 仍靠 prompt 约束。
- 一处 `tauri build` 后台并发瞬时失败（`vite build` exit 1），前台重跑即通过，未复现。

---

## [0.8.0] - 2026-10-28（r11–r19）

### 新增

- **首启使用协议**（r11）：`eula.md` 用 Vite `?raw` 内联（不存在运行时读取失败路径），自写 `markdownLite` 解析（不引 `react-markdown`）；`gate` / `viewer` 两种形态；状态存独立键 `ncl.ui.eulaAccepted.v1`（「重置外观」不该顺带清掉协议同意）。
- **通知分类门**（r12）：`ToastCategory = download | deploy | conflict | update | system`，前四类可在设置里关掉，`system`（用户直接操作的即时反馈）永远放行；`conflict` 强制开启（就算 localStorage 存了 false 也拉回）。门只拦 Toast，活动记录保留完整历史——静默它会丢操作痕迹。
- **下载中心**（r13，新增 `download_queue.rs` 约 900 行）：并发 1–3、**HTTP Range 断点续传**（`.part` 保留，服务端不支持 Range 时自动重头）、**429 按 `Retry-After` 挂起重试**（缺省 30s / 上限 300s / 最多 5 次，等待期响应暂停与取消）、**免 Key 通道**（NXM 链接自带的 `key`/`expires` 直调 `download_link.json`）、独立 `download-queue.json` 持久化（不碰主状态 schema）、完成后可选自动导入、worker 崩溃 `catch_unwind` 兜底、下载客户端只限连接 12s 不设总超时。
- **framer-motion 动效体系**（r15 试点 → r19 推广）：`motion.ts` 参数中心 + `useMotionSprings()` 主题差异化弹簧；抽屉滑入、弹窗弹入（`0.94 → 1`，终点精确 1）、路由 `AnimatePresence mode="wait"`；退场期间 `useIsPresent()` 给 portal 设 `pointerEvents: none`，避免整屏透明挡板。
- **`check-layout.mjs`**（r18，54 项）：6 个窗口尺寸逐一断言无横向溢出、侧栏底部三块可见不重叠、工具条不裁切、卡片列数达标。
- **`appVersion.ts` + `AGENTS.md`**（r16）：`useAppVersion()` 为唯一取数入口（Tauri `getVersion()` → vite `__APP_VERSION__` → `"DEV"`），移除两处硬编码；`AGENTS.md` 落版本更新自动化规范。

### 变更

- **EULA 门渲染架构重构**（r14）：取消「未同意就 `return <EulaDialog/>`」的短路渲染，主界面照常渲染在底层、协议门变成盖在上面的全屏遮罩——首帧不再白屏/黑屏；遮罩 `pointer-events: auto` + 底层 `app-shell` 切 `inert` 双保险（全局快捷键是 window 监听，`inert` 挡不住，单独加 `!eulaAccepted` 守卫）；赛博四主题叠一层 `rgba(var(--accent-rgb), 0.07)` 极淡滤镜；同意后先播 260ms 淡出再卸载。
- 目录规范化：源码 → `D:\用户\工作区\src`、产物 → `D:\用户\工作区\release`（改名必然断 pnpm 绝对软链，需 `pnpm install --prefer-offline` 重绑）。
- **Modern 浅色对比度**（r15）：新增 `--accent-text` / `--accent-text-rgb` / `--accent-text-hover`，79 处文字色迁到令牌（强调色作填充仍走 `--accent`）；自定义强调色按 WCAG 钳制（浅色 ≥7:1、深色 ≥4.5:1）。
- **全局响应式骨架**（r18）：`.app-shell` 必须用 `100%` 而非 `100vh/100vw`（body 有 `zoom`，vh/vw 会二次缩放）；删除「窄窗口把侧栏缩成 66px」的媒体查询；卡片网格 `CARD_MIN=300`。
- **Mod 设置收进详情抽屉**（r15）：删除全局「Mod 设置」页；写入只传 `source_id`、后端重新解析真实路径（拒符号链接/越界/超大），ini 逐行 patch、json 值级 patch，写前 `.bak`。
- **ConfigResolver 多框架解析**（r15）：按优先级探 Mod Settings `user.ini` → 模组自有 `config.json` → Native Interactions → AudioXL `.ini` → CET 全局配置。
- 旧品牌残留全清（r17）：`origin` 统一 `cyberdeck`、删旧 modlist 表头兼容层、临时文件前缀改 `cyberdeck`。

### 修复

- **门禁 7/12 失败**（r16）：r14 给 `App.tsx` 加 `inert` 后，9 个 `check-*.mjs` 只写偏好不好、没写 EULA 同意标记，所有 `click` 都在等一个永远不可交互的元素；统一补 `addInitScript` 后归零。
- **暂存目录失效后旧目录树被就地重建**（r17）：`usable_staging_dir()` 先 `create_dir_all` 再探测 → 创建必然成功 → 判定可用 → 把已消失的旧路径整条复建出来。改为「**必须已存在**且能写」，失效时回落 `data_dir/staging`。
- **拖动标题栏出现白斑残影**（首发前）：拖动把手判定与浏览器选区行为分离。
- **静态审查四模块**（r13）：Rust 非测试代码 34 处 `unwrap/expect` 逐一核验（锁中毒 30 处为项目约定、字面量正则 2 处、启动 2 处）**零真风险**，Zip Slip 三层防护确认；`main.tsx` 增全局 `unhandledrejection`/`error` 兜底（异步错误不再静默消失）；`dependencies.ts` 把 `CET Framework` 这类带后缀条目补进框架名单；修 `ai.rs` 两个测试并行必挂的 flaky——手写 TCP mock 单次 `read(16KB)` 不保证读全，且 hyper 的 HTTP/1.1 头是**小写** `content-length:`（大小写无关匹配后连跑 8 次全绿）。
- 便携包缺陷（r18）：全新解压目录里没有 `cyberdeck-data` 时首跑会把数据落进 `%APPDATA%`，修复为包内自带空数据目录。

### 验证

- `cargo test` 64/64；`tsc` 0 错；`check-layout` 54/54、`check-contrast` 26/26、`check-motion` 16/16（r19 扩到 38）、`check-eula-gate` 20/20、`check-floating` 两矩形不相交。
- 构建 exe 8,575,488 B / md5 `EAAE7D51…`（r18，含 r14–r18），冒烟 `stage=frontend mods=195`；便携版 4,081,142 B。

### 已知边界

- r11–r17 均未单独构建，统一随 r18 发布；r15 动效手感待确认。
- `localStorage` 键名 `ncl.ui.*` 仍不改（改了会重置主题/语言/通知已读/EULA 状态）。
- `%APPDATA%\com.nightcity.loader`（11 MB 旧运行时数据）保留未删。

---

## [0.8.0] - 2026-10-27（r5–r10）

### 新增

- **全局 UI 文案去 AI 味**（r7）：设置说明、弹窗正文、tooltip 里大量「AI 生成痕迹」——防御性免责、一条描述解释两件事、外露内部实现（`标记头` / `导入链路`）、同一状态四种写法。脚本化提取 1075 条含中文字符串，按四条判据（能否再砍字 / 是否替用户预先担心 / 是否外露实现 / 同概念是否多写法）改 24 个文件 105 处，先在影子工程预演、tsc/build 全绿才落真实源码。
- **i18n 预留架构**（r8）：`zh-CN.ts` 唯一文案源 + `t(key, vars?)` 占位实现（key 缺失返回 key 本身并 DEV 下 warn）+ `MessageKey` 递归字面量类型（**拼错在 `tsc --noEmit` 阶段报错**）+ `check-i18n.mjs` 守卫（`\p{Script=Han}` 扫描、`--unused` 反向检查、`// i18n-ignore` 与区块豁免）；`docs/I18N.md` 落契约。
- **i18n 全量迁移**（r9）：1207 → 0，词表收敛 1246 条覆盖 37 个文件；子代理只产出 `.i18n-parts/*.json`，由 `merge-i18n-parts.mjs` 幂等合并（上级已是字符串 / 同 key 不同值直接报错）。
- **UI 文案规范整改**（r10）：四条禁令（防御性免责 / 敬语 / 解释技术废话 / 情绪化安抚）+ 七个场景，共改 66 条。提取用 TypeScript AST（正则只认同行 `>文本<`，多行 JSX 全漏：正则扫出 4 条「请」，实际 13 条）。
- **主题预览图重做**（r5）：modern 明暗各出一张，3× 采样再降采样、取景按真实 DOM 坐标算；`.theme-swatch` 圆角跟随 `--radius`。

### 变更

- **AI 接入去服务商化**（r6）：徽标 `{模型名}` → `OPENAI 兼容`；占位符改 OpenAI 端点；日志同意文案改「发送到已配置的 AI 服务」；默认值 `default_ai_base_url/model` 去服务商化；「获取 Key」只在能确定服务商且有 `keyUrl` 时出现。
- 新增 `matchAiPreset(baseUrl, model)`（归一化去尾斜杠 / `/chat/completions` / 版本段后比对），修掉「保存过预设却显示手动配置」的不一致。

### 修复

- **`modlist.txt` 管理标记不兼容**（r9，实质缺陷）：`MANAGED_HEADER` 改名后仍在 6 处被用作识别判据（`starts_with`），老用户由旧版写出的 modlist 会被判成「不是本启动器写的」，误弹「备份并接管」或拒绝移除。新增 `loadorder::is_managed_modlist()` 两代都认、写入永远用新标记，补 3 项回归测试。
- 品牌残留：AI 客户端 User-Agent、启动页字形、测试 crate 改名；确认 `origin: "nightcity"` / 临时文件前缀 / `ncl.ui.*` 为兼容锚点，不动。
- 文案回归基准纠正：拿 r7 的文案清单 CSV 逐字比对，把 13 处更短文案判成「被擅自改短」并改回——**方向反了**，那份快照早于 r7「去 AI 味」改写。13 处全部回退，4 处 UI 断言按当前文案同步。

### 验证

- `cargo test` 96 项 + 1 探针；`tsc --noEmit` 0 错；`vite build` 通过；i18n 双向归零；门禁 **12/12**。
- 构建 exe **8,435,200 B / md5 `49a25cb90483523eccf7af947dff00f2`**（r9，22:50），冒烟 `stage=frontend mods=195`，数据完好。

### 已知边界

- 不引入 `react-i18next`、不实现语言切换、不新增运行时依赖；Rust 侧文案（`startup.log`、原生确认框）仍硬编码。
- r7 / r8 / r10 只改前端，未 `tauri build`；便携版未打包。

---

## [0.8.0] - 2026-10-26（r1–r4）

### 新增

- **品牌更名**（r1，批次详情 `docs/PROJECT_HISTORY.md#batch-1026`）：NightCity Loader → **CyberDeck Launcher（CDL）**，`identifier` = `com.arol.cyberdeck`（发布后不再改）；数据一次性迁移（在 JSON 结构层逐字段改写旧路径），195 模组 / 125 条 loadOrder / Nexus Key 全部保留。
- **主题系统解耦**（r1）：`theme.ts::useTheme()` → `{ styleTheme, colorMode, resolvedMode, modeCapable, ... }`，写 `data-style / data-mode`；风格 ncpd / netrunner / arasaka / militech / mono / modern，**删除 daylight**（老用户自动迁到 modern+light）；赛博风格强制暗色；`modern` 一律 8px 圆角 + `clip-path: none !important` + 零发光。
- **设置页顶部水平 Tabs**（r1）：个性化 / 游戏与路径 / AI 配置 / 工具组件 / 安全与维护 / 关于，内容区独立滚动、切 Tab 回顶、**用隐藏而非卸载**（不丢未保存输入）。
- **Nexus Collections**（r1）：`collection.rs` 的 `parse_collection_manifest`（校验 `domain=cyberpunk2077` → 先 `nexus.mod_id` 后 `file_id` 匹配本地，**MD5 不参与**）+ `apply_collection_order` + **modRules 拓扑排序**（有环回退原序不 panic）；删除本地大 ZIP 整合包逻辑（`install_archive` 保留）。
- **回归门禁 `gate.mjs`**（r4）：一条命令串 `cargo test` → `tsc` → `vite build` → UI 脚本，自动起停 `vite preview`，按 stdout `key=value` 断言，失败写 `shots/gate/report.json`。
- **`normalize.ts` + `AppErrorBoundary`**（r4）：状态入口统一降级（不再指望每个组件自己防御）+ 最外层兜底（重载 / 复制错误）。
- **NXM 协议接管 `nxm.rs`**（r4）：`parse_link` 只认 `cyberpunk2077`（别家 domain 报 `NXM_UNSUPPORTED_GAME` 而不是悄悄丢弃）；只写 `HKCU\Software\Classes\nxm`，接管前把别人的命令行备份进 `nxm-handler.json`，交还时精确写回；归属判定不靠进程名（归一化命令行后按 exe 路径比对）。
- **`selfcheck.rs` + `--self-check / --nxm-takeover / --nxm-release`**（r4）：无窗口把提权 / 数据目录 / 写探针 / 密钥可读性 / 游戏目录压成 JSON（密钥**只报能否解密**），供脚本化回归。

### 修复

- **P0 脏数据白屏**（r4，门禁首个真实收益）：注入 `translatedName: 12345` 后整棵 React 树卸载。真因是 `LibraryView` 排序里的 `(x ?? "").trim()` 抛点在卡片**之外**，卡片级错误边界接不住。
- 门禁第一次跑就抓到 4 个真问题（r4）：`adopt_tests.rs` 直接读 `Store.staging_dir` 私有字段导致编译不过；文档写的 `check-scroll.mjs` 不存在；设置页改 Tabs 后两个脚本选择器全失效；播放集确认按钮文案与实际不符。
- PS 5.1 两个坑（r4）：`Start-Process` 遇 `HTTPS_PROXY`/`https_proxy` 同时存在抛「字典中的关键字重复」；`Get-Content` 默认按 ANSI 读 UTF-8 JSON。
- 环境事故：删除 `D:\鐢ㄦ埛` 乱码镜像目录（UTF-8 无 BOM 的 `.ps1` 被 PS 5.1 按 GBK 解析）→ **新规则：含中文路径的 .ps1 必须带 BOM 或改用 ASCII 路径变量**。

### 验证

- `cargo test` **96 项** + 1 探针全过；`tsc` exit 0；`vite build` exit 0；门禁 `total=10 / failed=0`；主 bundle 496KB（gzip 153KB）。
- `selfcheck` 实测：普通权限与提权各一次，`dataDir` 不变、`mods=195`、`nexusKey=readable`，**0 failure**。

### 已知边界

- NXM 真机「在 N 网点 Mod manager download → 系统真的交给本启动器」需用户点一次接管后手验；接管/交还只覆盖 HKCU。
- r1–r4 均未构建 exe（部署包仍为 0.7.0 线），r4 于 2026-10-27 00:01 部署。

---

## [0.7.1] - 2026-10-25

**UI 审计 13 条（A1–E3）**

- A1 阅读型文本字号提升（12–12.5px，行高 328 保持）；A2–A4 / D1 / D3 行高 1.6、warning 对比、中文回退、`--mono` 回退、主题缩略图脚本。
- B1 侧栏徽标（加载顺序/诊断=冲突数，发现=Nexus 未连接，设置=游戏目录未链接）；B2 搜索 placeholder + Ctrl+K 面板按钮；B3 空状态动态引导；B4 播放集切换确认卡（差量预览 + 三段步骤）。
- C1 活动流（最近 10 条）；C2 全窗口拖拽导入落点层；C3 虚拟网格按 `分类:排序` 记忆滚动位置。
- E1 按视图拆包（主 bundle 457KB）；E2 `styles.css` 分层（tokens / 组件 / 入口）；E3 `ApiSurface = typeof api` 编译期断言防 mock 漂移。

**Nexus 差距 7 项**

- 更新检查 `nexus_check_updates`（250ms 节流、上限 40、无版本号跳过不误报）+ UPD 徽标，只发现不自动装；集合报告（同名重复 / 目标重叠）；前置引导闭环（7 个官方发布页 URL）；依赖结构化列表；External Changes 提到诊断首屏；启动参数 `launchArgs`（白名单、≤256 字符、逐参不经 shell）；通知中心（顶栏铃铛 + 活动流 12 条 + 更新数徽标）。

---

## [0.7.0] - 2026-10-26（r2–r4）

- **r2 · 跳转失效 / 数据目录分裂 / 目录完整性事故**：真因是 `D:\用户\工作区` 从旧电脑搬来携带 **Low 完整性标签** + 孤儿 SID，向下继承到 exe 并否决进程令牌（`integrity=0x1000`）→ 写不了 Medium 目录（静默回退 → 双数据目录）、子进程继承 Low 令牌失败。修复：`icacls /setintegritylevel Medium` + 重建 release 目录继承新标签。代码侧保留 `open_url` 经 `explorer.exe` 转交（失败回退 ShellExecute）、`open = { features = ["shellexecute-on-windows"] }`、`resolve_data_dir()` 三级策略（**禁止静默回退**）、`startup.log` 记录 `elev / integrity / appcontainer / probe / 错误码`。权限策略定为 **asInvoker**（曾短暂加 `requireAdministrator`，已回退）。
- **r3 · 单实例 / 托盘 / 关闭到托盘 / 退出确认 / 便携版**：`tauri-plugin-single-instance` 在 builder 第一个注册，二次启动 `show + unminimize + set_focus`；`setup_tray()` 用 `default_window_icon()`；`CloseRequested` → `prevent_close()` → 按 `close_behavior`（`tray`|`exit`）分支；`BusyTasks` + RAII `BusyGuard` 登记 8 个长任务。**同批事故**：一度发出 dev 构建（用 `cargo build --release` 缺 `--features custom-protocol` → 不内嵌前端、去连 1420，用户看到 `ERR_CONNECTION_REFUSED`），改用 `tauri build --no-bundle` 重编并双处实测 `stage=frontend`。
- **r4 · 界面/交互四项 + 设置信息架构**：浮层重叠结构性修复（统一 `--z-drawer/--z-floating/--z-modal/--z-command` + 单一 `.floating-stack`，抽屉打开时整栈左移，替代 `right: 382px` 魔法数字）；暂存区可自由改位置（`Arc<RwLock<PathBuf>>` + `change_staging_dir`，搬迁失败项留原处绝不静默删除）；「自动查找」变独立按钮（`detect_tool`）；设置分类重排，「外观与行为」定名**个性化**。
- 验证：`tsc --noEmit` 0 错、Rust 48 测试全绿、`ui-test ERRORS []`、真机 `stage=frontend mods=195`、1080 宽工具两行溢出 0。
- 环境坑：vite 8 默认只监听 `::1`，脚本用 `127.0.0.1` 连不上，需 `--host` 且 `NO_PROXY=127.0.0.1,localhost`。

> 复盘：`docs/PROJECT_HISTORY.md#incident-low-integrity`（定案）、`docs/PROJECT_HISTORY.md#incident-webview-datadir`（误判过程：6 轮错误假设、多打 5 个包）

---

## [0.7.0] - 2026-10-24（基线功能）

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
| 整合包导入 | 完成（后被 0.8.0 的 Nexus Collections 取代） |
| 播放集（Profile） | 完成（快照 → 撤销 → 写状态 → 部署 四段切换） |
| 右键菜单 / 打开文件夹 / 修复 | 完成（`open_in_explorer` 路径白名单、`repair_mod` 先撤后装） |
| 游戏更新熔断 | 完成（`lastGameVersion` 对比锁定部署入口） |
| 环境体检与自愈 | 完成（`deployedFiles` 记 size/mtime + `diagnose_environment` / `heal_environment`） |
| 多平台嗅探 | 完成（Steam 注册表 + `libraryfolders.vdf`、GOG、Epic） |
| 卡片错误边界 | 完成（单卡异常只坏一格，显示 `// ERROR: DATA CORRUPTED`） |

同期完成五项无人值守任务（虚拟滚动错误边界、游戏更新熔断、多平台嗅探与启动适配、卡片右键菜单、环境完整性自检与自愈），配套四个可复跑验收脚本 `check-update-lock / check-platform / check-context-menu / check-env-panel`。详见 `docs/PROJECT_HISTORY.md#night-shift`。

---

## 发布产物记录

| 时间 | 版本 | exe 大小 | md5 | 备注 |
| --- | --- | --- | --- | --- |
| 2026-11-02 23:24 | 1.0.0 批次 6+7 | 11,181,568 | `a2f360de70f7968bb572fde0cfea9c56` | 替换 release |
| 2026-11-03 00:48 | 1.0.0 批次 8+9 | 11,262,976 | `acbe573c37bb9cd02d12245fea8d2aa0` | 便携版 5,357,550 B |
| 2026-10-31 13:28 | 0.9.0-r35 | 9,115,136 | `88c8605d4f80710c001f7a540a74e650` | 便携版 4,173,061 B |
| 2026-10-31 01:38 | 0.9.0-r34 | 9,115,136 | `96aeb0e90c1c28b124fae5d40eb7f4ff` | 便携版 4,172,810 B |
| 2026-10-30 22:45 | 0.9.0-r33 | 8,897,536 | `ee28ffa27d21273401b97312de1a08b7` | 未打便携版 |
| 2026-10-30 02:30 | 0.9.0-r28–r30 | 8,848,896 | `FEFDA28F258853A481EEDCED0F0012C6` | 便携版 4,196,942 B |
| 2026-10-30 00:40 | 0.9.0-r26+27 | 8,754,176 | `51689FA5F09172610774FE2D9B2B9DB3` | — |
| 2026-10-29 23:47 | 0.9.0-r24+25 | 8,753,664 | `95C99B3E9CC52C783D4C00AD230EE626` | — |
| 2026-10-29 22:20 | 0.9.0-r23 | 8,751,104 | `543cf70867bf163d05b2b1cfe3861fdc` | 零警告；NSIS 3,335,988 B |
| 2026-10-29 02:21 | 0.9.0-r22 | 8,736,768 | `6e498e3dce314a9fcc3602ac088589cd` | NSIS 3,332,269 B；便携版 4,148,716 B |
| 2026-10-29 01:28 | 0.8.0-r21 | 8,607,232 | `FCF49BDFA23E212F05006161953620D0` | — |
| 2026-10-29 00:55 | 0.8.0-r20 | 8,585,216 | `C7F00C3EC47AF456222F68F45632FD16` | — |
| 2026-10-29 00:10 | 0.8.0-r19 | 8,577,536 | `8B34349F08D3D29F9D77777063A2DD42` | — |
| 2026-10-28 23:50 | 0.8.0-r18（含 r14–r18） | 8,575,488 | `EAAE7D5159F81C8A392CE6F7D435EBBB` | 便携版 4,081,142 B |
| 2026-10-28 02:08 | 0.8.0-r13（含 r10–r13） | 8,515,584 | `de41338e022bc66bc3ba34c950fd5b53` | 便携版 4,045,477 B |
| 2026-10-27 22:50 | 0.8.0-r9 | 8,435,200 | `49a25cb90483523eccf7af947dff00f2` | — |
| 2026-10-26 12:35 | 0.7.0-r3 | 8,335,872 | — | dev 构建事故后重编 |

> 每次替换 release 前把旧版备份为 `CyberDeck Launcher.prev.exe`。发布前 **绝不能只用 `cargo build --release`**（缺 `custom-protocol` 会产出连 `localhost:1420` 的 dev 形态）。

---

## 事故与复盘索引

| 日期 | 事故 | 影响 | 复盘 |
| --- | --- | --- | --- |
| 2026-10-26 | 目录 Low 完整性标签 → 跳转失效 / 数据目录分裂 / 子进程失败 | 6 轮错误假设、多打 5 个包 | `docs/PROJECT_HISTORY.md#incident-low-integrity`、`docs/PROJECT_HISTORY.md#incident-webview-datadir` |
| 2026-10-26 | `deserialize_with` 未消费输入 → 状态文件被判损坏 | 195 条模组索引清空（文件未丢）；且每次落盘后的空数组形态都会复现 | `docs/PROJECT_HISTORY.md#incident-state-parse` |
| 2026-10-26 | 发出 dev 构建（缺 `custom-protocol`） | 用户看到 `ERR_CONNECTION_REFUSED` | 本文件 2026-10-26 段 |
| 2026-10-29 | 分类引擎把 168 个收编模组判成「工具」 | 分类形同虚设 | 本文件 0.9.0 2026-10-29 段 |
| 2026-11-02 | 收编模组禁用卡死（「恢复目标已存在」） | 24/187 条无法禁用；测试文件 1609 行从未编译 | 本文件 2026-11-02 段 |

---

## 新增版本条目模板

```markdown
## [X.Y.Z] - YYYY-MM-DD（覆盖 rNN–rMM）

### 新增

- **一件事一句话**：做了什么 + 为什么这样做（关键取舍），必要时补数字。

### 变更

- 行为/参数/默认值的变化，注明旧值 → 新值。

### 修复

- **现象** → 真因（不是猜测，是观测到的证据）→ 修法。

### 移除

- 删掉的组件/命令/词条，以及为什么可以删。

### 验证

- `cargo test` N 通过 / M ignored；全量门禁 K/K 绿；构建产物大小与 md5。

### 已知边界

- 这一版**没解决**什么，以及为什么不解决。
```

**收尾清单**：本文件追加 / 合并 → `HANDOFF.md` 对应段同步 → 事故类另写 `docs/INCIDENT-*.md` → 网盘「CyberDeck Launcher 项目文档」与资料库同名文档同步。
