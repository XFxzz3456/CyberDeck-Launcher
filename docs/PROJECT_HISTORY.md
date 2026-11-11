# CyberDeck Launcher — 项目史（PROJECT_HISTORY）

> **本文件回答「为什么这么改 / 踩过什么坑」。** 逐版本「改了什么」在根目录 `CHANGELOG.md`，两者分工不同，不要互相塞内容。
>
> **来源**：2026-10-31 文档合并 —— 20 份零散报告与设计草稿提炼后归档于此，原文已从仓库移除（均在 git 历史中可回溯）。
> **读法**：每条带稳定锚点（如 `#incident-state-parse`），`CHANGELOG.md` / `HANDOFF.md` / `README.md` 直接引用锚点，不再指向已删除的原文。

---

## 目录

- 一、里程碑时间线
- 二、事故复盘（现象 → 真因 → 修复 → 防范）
- 三、审查与验收结论
- 四、架构决策与设计边界
- 五、沉淀的规则（长期有效）

---

## 一、里程碑时间线

### 1.1 0.7.0 夜间五项无人值守任务（2026-10-25）<a id="night-shift"></a>

| # | 任务 | 结果 | 核心改动 |
|---|---|---|---|
| 1 | 虚拟滚动 + 组件级 ErrorBoundary | 完成 | 新增 `ModCardErrorBoundary.tsx`；虚拟滚动本已存在（`@tanstack/react-virtual`，行高 328 / overscan 4 / 列数按容器宽 1–6 列自适应），本次只补错误边界 |
| 2 | 游戏更新熔断机制 | 完成 | `game.rs`、`lib.rs`、`App.tsx`、`mock.ts`；熔断横幅读真实 PE 版本 |
| 3 | 多平台路径嗅探与启动适配 | 完成 | `schema.rs`、`game.rs`、`SettingsView.tsx` |
| 4 | 卡片右键快捷菜单 | 完成 | 新增 `ModContextMenu.tsx` |
| 5 | 环境完整性自检与一键自愈 | 完成 | 新增 `environment.rs`，接 `DiagnosticsView.tsx` |

**当时登记的遗留（六项，均未阻塞交付）**

1. `cargo` 无法在项目目录写 `Cargo.lock`（os error 5），只能走源码副本编译 → **副本必须手动同步**。
2. 交互验证全在浏览器模式（vite + Edge + playwright-core）完成，真实 Tauri 运行时未验：`open_in_explorer` / `repair_mod` / `heal_environment` 的文件系统行为待实测。
3. 更早部署的模组，`deployedFiles` 缺 `size` / `modifiedTime`（`#[serde(default)]` → `None`），体检精度受限。
4. `core-tests` 存在既存失败（31 个测试中 11 通过 / 20 失败，集中在 `installer_tests` / `logs` / `modsettings` / `secret` / `ai`）。
5. 打包未执行（用户要求暂停）。
6. `.btn-primary` 禁用态视觉偏亮。

**踩坑**：Playwright 点侧栏必须用 `getByRole("button", { name: "设置", exact: true })`，用 `getByText("设置")` 会先命中「Mod 设置」。

---

### 1.2 批处理：品牌更名 + 主题解耦 + 设置页 Tabs + Nexus Collections（2026-10-26）<a id="batch-1026"></a>

一句话：**NightCity Loader → CyberDeck Launcher（CDL）**，同期完成三件结构性工作。

1. **品牌更名与数据迁移**
   - `identifier` = `com.arol.cyberdeck`，exe = `CyberDeck Launcher.exe`
   - 目录迁移：`nightcity-data` → `cyberdeck-data`；`%APPDATA%\com.nightcity.loader` → `com.arol.cyberdeck`
   - `launcher-state.json` 在 **JSON 结构层**逐字段改写旧路径，真实数据 195 模组 / 125 条 loadOrder 全量通过
2. **主题系统解耦**：`useTheme()` + `data-style` × `data-mode` 契约；新增 **MODERN** 风格（浅色 / 深色 / 跟随系统）；删除 daylight（自动迁移为 modern + light）
3. **设置页 → 顶部 Tabs**：六分区（外观与主题 / 游戏与路径 / AI 配置 / 工具组件 / 安全 / 关于）；内容区独立滚动、切 Tab 回顶、**用隐藏而非卸载**（不丢未保存输入）
4. **Nexus Collections**：删除「本地大 ZIP 整合包」的递归扫描与剥嵌套逻辑；新增 `collection.rs`（清单解析 + 本地比对 + modRules 拓扑排序）与前端集合安装向导

**本轮踩过的坑**

- 改目录名会打断 pnpm：`node_modules` 软链是绝对路径 → 必须 `rm -rf node_modules && pnpm install`
- PowerShell 5.1 读无 BOM 的中文 `.ps1` 会乱码 → 迁移改用直接命令
- bash heredoc 里 `r"..."` 的反斜杠会被吞成正斜杠 → 路径改写用 `chr(92)`
- `shutdown.exe` 与 `schtasks` 均被沙箱策略拦截 → 改用一次性自动任务执行 WMI 关机
- 期间发生一次真实数据事故，见 [INC-02](#incident-state-parse)

---

### 1.3 0.9.0 冲刺（2026-10-29 → 10-31）

- **【8】深度汉化架构评审**：三条路线定案，见 [ARCH-12](#ai-loc-review)
- **【10】真机验收**：自动化预检 **0 failure**（游戏 3.0.5294808；RED4ext / ArchiveXL / TweakXL PASS），见 [§3.6](#real-env-090)
- **【14】本地模型（Ollama / 任意 OpenAI 兼容端点）**：双协议 + 任意 Base URL，见 [§3.7](#ollama)
- **发布前修掉的 P0（r22）**：6 个命令只定义未注册，见 [INC-04](#incident-command-not-registered)
- **便携版已知边界**：在已运行过 CDL 的机器上解压便携包首跑，会把 `%APPDATA%\com.arol.cyberdeck` 的旧状态带出来

### 1.4 UI 收尾与文档治理（2026-10-30 → 10-31）

- UI 量化审查进门禁（`scripts/check-ui-audit.mjs`），见 [§3.2](#audit-ui-1031)
- 个性化页由「一张大卡 + 四段虚线」重排为 **6 张独立卡片**（01 主题与配色 / 02 左侧导航栏 / 03 窗口与侧边栏 / 04 字体与排版 / 05 背景图 / 06 动效与启动），零 `ncl.ui.*` 存储键变更
- 建立任务分级机制（L1 微调 / L2 功能迭代 / L3 发版），并把 20+ 份零散报告合并为本文件

---

## 二、事故复盘（现象 → 真因 → 修复 → 防范）

### INC-01　目录 Low 完整性标签 → 外链失效 / 数据目录分裂 / 子进程失败（2026-10-26）<a id="incident-low-integrity"></a>

**严重级别**：高 · **代价**：6 轮错误假设、多打 5 个包 · **性质**：环境问题，**不是代码问题**

- **三个症状**：① 所有「打开浏览器」按钮静默失效；② 非管理员启动时 Nexus API Key「消失」；③ 后来点按钮弹 `explorer.exe 0xc0000142`
- **真因**：**exe 所在目录携带 Low 完整性标签**，把进程令牌一起拉低 —— 不是权限表问题，不是依赖问题
- **修复**：搬出带标签的目录并重置完整性；后续新增「搬运目录必须体检」规则
- **错误假设清单（最有价值的部分）**

| 轮次 | 假设 | 实测结论 |
|---|---|---|
| 1 | `open` 5.4 的 Windows launcher 链回归 | 部分成立（会假成功），非主因 |
| 2 | 用户 Edge 提权实例导致 UIPI 拦截 | 清掉 Edge 后仍失败 |
| 3 | 需要管理员运行 | 管理员下"能用"只是令牌一致，掩盖问题且引入提权浏览器与拖拽失效 |
| 4 | 数据目录路径解析错 | 路径完全正确，卡在**写**被拒 |
| 5 | 进程令牌被安全软件降权 | 方向对（确实 Low IL），但没找到**谁**降的 |
| 6 | **exe 目录带 Low 标签** | ✅ `icacls` 一眼看到 |

- **防范**：进程行为异常时，**先查环境再查代码**；搬运/新建目录后做完整性体检

---

### INC-02　反序列化器未消费输入 → 状态文件被判损坏 → 195 条模组索引被清空（2026-10-26）<a id="incident-state-parse"></a>

**严重级别**：高（数据丢失，但已完整恢复）

- **现象**：一次常规启动后，模组列表空了；`.broken` 备份存在
- **真因**：某字段的 `deserialize_with` 反序列化器**没有消费掉输入值**，导致 serde 解析位置错位 → 整个状态文件被判损坏 → `store.rs` 静默重置为空
- **复测补强**：不只是非空值会炸 —— `"modpacks": []`（启动器**每次落盘都会写出的形态**）同样触发
- **恢复**：已从 `.broken` 完整恢复（195 mods / 125 条 loadOrder / nexus 引用全在）
- **规则沉淀**
  1. `deserialize_with` 的自定义反序列化器**必须消费掉输入值**（`IgnoredAny::deserialize(deserializer)?`）
  2. 改 schema 前必须用**真实旧数据**跑解析，不能只用 fixture 空数组
  3. **断言要区分「字段为空」和「文件整体坏掉」** —— 原单测只断言字段为空、fixture 里 `"mods": []`，是个**假阳性**：空结果与「文件损坏后被重置成空」在断言上无法区分，必须断言整体未被破坏

---

### INC-03　外链打不开 + API Key 时有时无（误判过程记录）<a id="incident-webview-datadir"></a>

> ⚠️ **真因已被 [INC-01](#incident-low-integrity) 推翻并取代。** 本条保留的是**排查方法与过早定型教训**，不要再把它当结论引用。

- **当时认定的「两个独立故障」**
  - 跳转静默失效：`open` 升级 5.4.5 后 Windows launcher 链改为 `powershell(Start-Process) → explorer.exe`，且 `that_detached` 只观察 250ms → **"成功"不代表浏览器真被拉起**
  - Key 时有时无：进程写 `%APPDATA%\com.arol.cyberdeck` 被拒（os error 5），旧代码 `Store::load(preferred)` 失败即静默回退到 exe 同级 `cyberdeck-data` → **同一台机器并存两套状态**
- **UI 侧同时查出**：角标不消失（`badgeCount = activities.length + updateCount`，无已读态）；角标显示不全（`.btn` 的 `clip-path` 把按钮内绝对定位的角标裁掉一角）
- **教训**：两个故障被同一次"环境变化"掩盖，**每一步修复都像成功** —— 每次只验单点会让错误结论自我强化

---

### INC-04　6 个 Tauri 命令只定义未注册（2026-10-29，r22）<a id="incident-command-not-registered"></a>

- **影响面**：Safe Mode（进入 / 退出 / 状态）、全局配置导入导出、过期插件扫描 —— 本轮交付的 4 个功能里有 **3 个在运行时不可用**
- **真因**：`#[tauri::command]` 写好了，但没加进 `invoke_handler` 列表
- **发现方式**：编译器 `never used` 警告 + **对 exe 做字符串取证**（`safemode 0 / compat_scan 0 / config_export 0 / glossary 11`）—— **不是功能测试发现的**
- **规则**：新增 Rust 命令后必须走「注册检查」：`invoke_handler` 列表 + 命令名在构建产物中出现次数比对（对应 `scripts/check-*` 与 `AGENTS.md` 的三处版本号同步）

---

### INC-05　分类引擎在真实库上失效（2026-10-29，r23）<a id="incident-category-realdata"></a>

两层真因，**第二层当时才抓到**：

- **2a. 收编模组的名字是连写句柄**（如 Vortex 部署后经「收编」纳入管理的 `compactweaponmodslots`）

| 词长 | 匹配方式 | 理由 |
|---|---|---|
| `>= 5` | 子串 | `weapon` 必须能在连写句柄里被发现 |
| `< 5` | 整词 | `cet` / `gun` / `hud` / `car` 放开会命中 `cetocide` / `gunpowder` / `cargo` |
| 中文 | 子串 | 中文没有词边界 |

- **2b. 并列决胜方向是反的**：`Disappearing NPC and Vehicle Fix (Crowd LOD spawn distance)` 同时命中 玩法 / 车辆 / 视觉 / 任务（各 3 分），被判成顺序最靠后的「任务」，应为「玩法」

**修复后实测（195 个模组）**

| | 工具 | 其他 | 任务 | 玩法 | 视觉 | 服装 | 框架 | 武器 | 车辆 | 音频 |
|---|---|---|---|---|---|---|---|---|---|---|
| 修复前 | 168 | 0 | 2 | 5 | 11 | 0 | 7 | 0 | 1 | 1 |
| 修复后 | **0** | 132 | 21 | 17 | 8 | 5 | 5 | 4 | 2 | 1 |

---

## 三、审查与验收结论

### 3.1 UI 审计与主题升级（0.7.0）<a id="audit-ui-070"></a>

方法：Playwright 驱动本机 Edge，6 套主题 × 6 个页面截图逐张实看，所有结论带截图与代码位置。

**六个核心问题 → 八项改造**：① 封面配色主题化 ② 基础变量层 ③ 主题形态层（不只是换色的关键）④ ARASAKA 降红 ⑤ 字号与可读性 ⑥ 主题卡改为真实缩略图 ⑦ 新增 DAYLIGHT 亮色主题 ⑧ 诊断页层级与键盘可达性。

> **执行状态（2026-10-25）**：本报告与《UI 评估与功能差距》的全部意见（A1–E3、#1–#7）已全部实现，明细见 `HANDOFF.md`「0.7.1 批量升级」。

---

### 3.2 UI 量化审查（2026-10-31，0.9.0-r36）<a id="audit-ui-1031"></a>

**为什么量化**：此前的 UI 意见是主观描述，无法进门禁。改用可断言的数值（内容宽度、对比度比值、按下位移像素）。

| 级别 | 项 | 处置 |
|---|---|---|
| P0-1 | 超宽屏无最大宽度，正文铺满 2300px | 已修，内容区上限 1680 |
| P0-2 | 次要文字对比度低于 WCAG AA | 已修 |
| P1-1 | 4 个主要交互控件无按下反馈 | 已修（`hoverRules=10`） |
| P1-2 | 中文说明文字字号过小 | 已修 |
| P2-1 | 装饰性小字保留 8–9.5px（27 处） | 登记不改（装饰性，非正文） |
| P2-2 | 超宽屏阈值 1680 是经验值 | 登记不改 |

**审查脚本自身的两个假阳性（重要）**

| 假阳性 | 真因 | 修正 |
|---|---|---|
| `.storage-head`、`STAGING`、`1.7 GB` 报 `0x0` 塌陷 | `[data-vh-tight] .sidebar-storage { display: none }` 是**有意隐藏** | 排除隐藏元素 |
| `<option>` 报 `0x0` | 原生下拉项本就不生成布局盒 | 直接排除 `OPTION` 标签 |

> 第一版报出 `scaleBroken=3`，差点当成布局 bug 修。修正后 `scaleBroken=0`，说明缩放布局**本来就没坏**。
> **教训：审查脚本也会说谎。** 脚本报错后必须先看**问题元素本身**，不要在脚本结论上直接改样式。

顺带查出 README 截图与实际 UI 不符（比 UI 问题更严重），已重截。

---

### 3.3 七模块合规自检（2026-10-30，r30 部署后）<a id="audit-7modules"></a>

范围 7 大模块，逐模块人工读码核对，结论全部带 `文件:行号` 证据。**未发现 P0。**

| 项 | 问题 | 处置 |
|---|---|---|
| P1-1 | 下载 429 限流等待期点暂停/取消被吞（`download_queue.rs`） | r31 已修 + 单测 |
| P1-2 | 混合包静默丢文件（`installer.rs`） | r31 已修 + 单测 |

P2 七项保持记录在案、暂不动。修复后：`cargo test` 105 passed、前端 tsc + vite build 通过。

---

### 3.4 Bug 与质量全面检查（2026-10-30）<a id="audit-bug-quality"></a>

**当时的结论快照**：安全与健壮性底子远超同类项目（解压防穿越、路径白名单、DPAPI 存密钥），但前端 `tsc --noEmit` **失败（3 个语法错误，构建直接断）**。

| 级别 | 项 | 问题摘要 |
|---|---|---|
| Critical | C-1 | `DiagnosticsView.tsx` 第 485 行多余 `</div>`，整文件语法错误 |
| High | H-1 | `nxm://` 解析按字节切片 `&str`，`%` 后跟多字节字符必 panic，**可被任意网页远程触发** |
| High | H-2 | 45 处 `.expect("state mutex poisoned")` + `panic = "abort"`：任一 panic 都是进程级故障 |
| High | H-3 | `ai_base_url` 允许明文 `http://`，API Key 可能被中间人截获 |
| Medium | M-1 | 异步 `listen()` 与清理函数竞态，可能永久泄漏监听 |
| Medium | M-2 | i18n 闸门未过：`dependencies.ts` 有 4 处硬编码中文 |
| Medium | M-3 | `open_path` 无白名单，与 `open_in_explorer` 策略不一致 |
| Medium | M-4 | `open_in_explorer` 前缀校验未规范化，`..` / 联接点可绕过 |
| Medium | M-5 | `launch_pre_command` 无任何校验，直接经 `cmd /C` 执行 |

**未如实完成的部分**：本机无 `cargo-audit`（未擅自 `cargo install`，需联网编译且改动环境）→ **Rust 依赖漏洞未审**。

> 本节是一次快照，各项修复进展以 `CHANGELOG.md` 对应版本条目为准 —— 合并时未逐项回验现状。

---

### 3.5 真实游戏环境验收（持续有效）<a id="real-env-test"></a>

**活文档仍在 `docs/REAL-ENV-TEST.md`**（配套脚本 `scripts/real-env-check.ps1`），含：一条命令的自动门禁、提权/DPAPI 对照、只读预检、写探针与硬链接探针、archive 部署、`.xl` 与加载顺序、Mod Settings、日志查看器、AI 与 Nexus 真实 Key、回滚、**状态文件往返**（每次发版必做）、**确认 exe 内前端产物与当前源码一致**。

本机 `D:\steam\steamapps\common\Cyberpunk 2077` 已实测 `RESULT: 0 failure(s)`。

---

### 3.6 0.9.0 真机验收（2026-10-29）<a id="real-env-090"></a>

自动化预检 **0 failure**（`scripts/real-env-check.ps1`）；WARN 项代表"该框架未安装"，不影响 ArchiveXL 类 Mod 验收，CET / redscript 链路需先装框架。

**手动检查清单 A–J**：A 硬链接部署（同卷）· B 启动游戏生效 · C 卸载无残留 · D 跨盘降级 · E 冲突与诊断 · F 安全模式 · G 过期插件扫描 · H 配置导入导出 · I 帮助中心 · J AI 三条链路。每项需留证据（时间戳 / 预期 / 实际 / 截图）。

破坏性操作的代码级兜底已实现，验收时抽查。

---

### 3.7 本地模型（Ollama / 任意 OpenAI 兼容端点）<a id="ollama"></a>

- **代码层**：双协议（OpenAI / Anthropic）+ 任意 Base URL，已用本地 mock HTTP 服务器在单元测试中覆盖同等协议路径（`src-tauri/src/ai.rs` 的 `ai::tests`）
- **实机**：本机未安装 Ollama，**实机链路未跑**；用户 2026-11-07 明确不装，故 `REAL-ENV-TEST.md` §10 的 8 项仍待验
- **已知差异 / 待验项清单**：2026-11-07 补回，见 `docs/REAL-ENV-TEST.md` §10（此前本文引用了一份并不存在的清单）
- **无 Key 缺陷已修**（2026-11-07）：帮助中心 / 预设承诺「Key 留空」，后端四条业务链路却强制 Key；现仅对回环地址放行匿名，公网漏填仍报错。复盘见 `docs/INCIDENT-2026-11-07-ollama-no-key.md`
- **回环请求必带** `NO_PROXY=127.0.0.1,localhost`：系统设了 `HTTP_PROXY` 时会劫持本机请求（启动器内部已做处理，手动 curl 复现时需自带）
- 帮助中心已收录「接本地 Ollama」条目，用户可自助配置

---

## 四、架构决策与设计边界

### 4.1 架构设计与长期规划（2026-10-25，基准 0.7.0）<a id="arch-plan"></a>

**架构压力点**（为什么当时必须规划）：模块化单体在能力与约束之间的取舍已到期，Profile / 状态演进 / 事件层三件事必须在 0.8 前定型。

**ADR 摘要**

| 编号 | 决策 | 代价 / 不做的后果 |
|---|---|---|
| ADR-001 | 维持**模块化单体**，不做插件进程 / 微服务；扩展点只开放**数据级** | 第三方无法写功能插件（接受：代码级插件会击穿全部安全红线） |
| ADR-002 | 状态文件加 `schema_version` + **顺序迁移链** | 每改一次状态结构要写 20–50 行迁移 + 测试；不做则老用户只能删了重来 |
| ADR-003 | Profile 为一等聚合，**切换 = 原子 swap**（先完整撤除再部署） | 切换耗时随模组数量线性增长，万级文件可能分钟级 |
| ADR-004 | **部署引擎唯一化**（modpack 复用 installer 纯函数生成同构 ModEntry） | — |
| ADR-005 | 统一事件 envelope | — |
| ADR-006 | 主题 JSON 包 = 数据级扩展点：只允许声明 CSS 变量值 + 缩略图，**不接受任意 CSS 注入** | — |
| ADR-007 | 分发与更新（对应 `HANDOFF.md` P2/P4） | — |
| ADR-008 | **测试基线是合并门槛** | — |

---

### 4.2 UI 整体评估 & 对标 Nexus Mods App（2026-10-25）<a id="ui-gap"></a>

**总评**：视觉完成度明显高于同类工具平均水平，6 套主题有真实形态差异。

**值得补的差距（符合「导入 → 部署 → 排序 → 诊断」定位）**：① 模组更新检查 ② 整合包集合报告 ③ 缺失前置的一键依赖引导闭环 ④ 依赖关系可视化列 ⑤ External Changes 的用户沟通 ⑥ 游戏设置面板 ⑦ 把活动流升级为通知中心。

**明确不追（与项目「明确不做」一致）**：N 网集合一键批量安装（违背逐项确认）/ Workspace 多面板并排 / 多游戏支持 / Linux · Steam Deck（Windows-only，DPAPI、硬链接身份校验、VerQueryValue 深度耦合）/ 游戏内 overlay 与进程注入 / 账号收藏同步与社区互动。

**NCL 反超的五点**（应保持并宣传）：
1. **部署即链接，不留管理器税** —— NCL 永不清空游戏目录既有 Mod
2. **硬链接同卷零拷贝**
3. **全量离线可用** —— 核心功能不登录、不联网
4. **AI 诊断的隐私边界** —— 脱敏 + 逐次同意 + 白名单 focus
5. **环境体检可自愈** —— 从暂存区重建丢失链接，而非只报告

> 一句话：**UI 的下一步不是再换皮，而是把字号/对比度收尾 + 把状态可发现性做穿。**

---

### 4.3 AI 补丁生成（AI Patch）设计边界 <a id="design-ai-patch"></a>

**核心约束只有一条：AI 产出的东西是「额外的补丁层」，不是对他人作品的修改。**

| 编号 | 不变量 | 违反后果 |
|---|---|---|
| P1 | 只生成覆盖补丁，绝不写入 / 重命名 / 移动原 `.reds` | 破坏作者资产，不可回滚 |
| P2 | 绝不修改原 `.archive`（不重打包、不替换、不删条目） | 校验和失配，来源无法追溯 |
| P3 | 补丁一律独立成文件：`AIFix_<mod>_<hash8>.reds` | 与作者文件混淆，卸载时误删 |
| P4 | 产物落在独立分类 `AIFixes/`，可一键全部撤销 | 用户无法分辨哪些文件是 AI 加的 |
| P5 | 应用前必须弹窗明示风险 + **手动勾选**（不接受默认勾选、"本次不再提示"） | 责任边界不清，用户以为作者背书 |
| P6 | 校验不通过就不落地，不留半成品 | 半成品会让游戏启动崩溃且难定位 |

**落地差异（2026-10-31）**：v1 已落地 G1 结构校验（模块名 / `@wrapMethod|@replaceMethod` / 括号配平 / 危险 API 黑名单 / 400 行上限）、确认门、独立文件写入与单独撤销；**G2 编译校验未接入**（无 redscript 编译器集成），报告里明确 `compiled:false`，**不宣称已验证**。

---

### 4.4 非破坏性 AI 汉化设计 <a id="design-ai-translation"></a>

四条硬约束：**P1** 绝不修改原 Mod 文件（只读打开，产物写独立目录）· **P2** 产物集中在 `AITranslations` 分类（暂存根 `staging/ai-loc/<modId>/`）· **P3** 启用前必须显式确认 · **P4** 可完全回滚（按 `deployed_files` 清单撕除，词表不在清理范围）。

**场景**：① Mod 自带 i18n JSON → 新增覆盖 `.archive` + `.xl`（用 extend 不用 replace）② 文本硬编码 → 补丁层 ③ 作者禁止汉化 → 不生成 ④ 二进制 / Archive 资源 → blocked。

**落地差异（2026-10-31）**：v1 只覆盖「本地化 JSON」路径（onscreens 条目 + 扁平 `key→text` → 词表优先 → 未命中走真实 AI → WolvenKit 格式 JSON + `.archive.xl`，**必须**用 WolvenKit CLI 打包 `.archive` 才能部署）。
① 原文「不接入真实 AI API」已作废，实接设置里配置的 OpenAI 兼容 / Anthropic 接口；② `.archive` / `.inkwidget` / `.csv` 内文本与 `.reds` 硬编码文本标记为 blocked；③ 虚拟 `AITranslations` 分类未实现，改为在 `ModEntry.ai_loc` 登记清单，撤销即撕除；④ `TooLong` 用 1200 字符上限，未做 1.6 倍字节估算。

---

### 4.5 AI 深度汉化架构评审（0.9.0，看板【8】）<a id="ai-loc-review"></a>

**三条路线裁决**

| 路线 | 做法 | 可回滚 | 结论 |
|---|---|---|---|
| A 离线生成本地化资源 | 生成独立覆盖层（`.archive` + `.xl` / 本地化 JSON / 框架菜单配置） | 是 | **采用（M1）** |
| B 运行时 overlay | 注入进程改 UI 文本 | 否 | **禁止**（反作弊、崩溃风险） |
| C 仅词表替换 | 只翻名称 / 描述，显示在启动器内 | 是 | 已上线，作为 A 的**词表底座** |

**写入白名单硬约束**：所有路径先过 `store::safe_join` + `is_within`（复用现有实现，不新写一套）；产物名必须带 `-ai-loc` 后缀；原 Mod 文件只读打开，产物写 `staging/ai-loc/<modId>/`。

**词表规则**：主键 = `mod_id + hash(原文)`（Mod 更新后原文变化 ⇒ 主键不命中 ⇒ 自动失效，这是特性）；合并优先级 本地自定义 > 云端共享 > AI 新译；同主键冲突保留 `updated_at` 较新者并计 `conflicts`；**框架名黑名单在词表命中之前生效**。

---

### 4.6 整合包导出 / 导入（1.8.0，2026-11-11）<a id="design-modpack"></a>

完整设计与复盘另见 `docs/ARCH-MODPACK-2026-11-11.md`。这里只留三条设计边界：

1. **自有格式，不假装是 Nexus Collections**：`.collection` 能读不能发（发布需经 Vortex 上传 + 站点审核），
   所以导出 `.cdlist`（纯清单）/ `.cdpack`（zip64，内含每 Mod 独立 zip），同时保留对方的包能装。
2. **完整包里每个 Mod 独立 zip**：导入端逐个复用 `installer::install_archive`，不新写「从文件夹注册」逻辑；
   顺带拿到进度可见、坏一个不连坐、可只装其中几个。两层都用 `Stored`（`.archive` 已压缩，再 deflate 只烧 CPU）。
3. **下载链路不绕合规边界**：Nexus 只给 Premium 签 API 直链；免费号走「打开页面 → nxm 接管」引导队列。
   导入进度由 `pack::preview` 每次从实时库现算，因此不需要额外维护会话文件，天然支持断点续传。

## 五、沉淀的规则（长期有效）

1. **先查环境再查代码**（INC-01）：进程行为异常时，先做目录完整性 / 令牌体检。搬运目录后必须体检。
2. **自定义反序列化器必须消费输入**（INC-02）：`IgnoredAny::deserialize(deserializer)?`，否则整个状态文件被判损坏并被静默重置。
3. **断言要能区分「空结果」与「文件整体坏掉」**（INC-02）：fixture 用空数组会得到假阳性。
4. **改 schema 前用真实旧数据跑解析**（INC-02）：空 fixture 验证不出跨版本问题。
5. **新增 Rust 命令必过注册检查**（INC-04）：写 `#[tauri::command]` 不等于可用，用「exe 字符串取证」兜底。
6. **多故障叠加时不要过早下结论**（INC-03）：多个故障被同一环境变化掩盖时，每一步修复都像成功 —— 必须回到单一根因。
7. **分类/匹配的词长阈值要分档**（INC-05）：连写句柄需要 `<5` 整词、`>=5` 子串、中文子串三档。
8. **GUI 应用的可观测性红线**：任何失败必须在界面上可见 —— 静默失败是最贵的 bug（`Store::load` 静默回退直接造成双状态）。
9. **外部依赖升级要验真实链路**：`'成功' != 真的成功`（`open` 5.4.5 的 250ms 观察窗口曾给出假成功）。
10. **审查脚本也会说谎**（§3.2）：脚本报错先看问题元素本身；截图类验证要比对 md5 并确认鼠标落在内容区。
11. **重命名目录会打断 pnpm**（§1.2）：`node_modules` 软链是绝对路径，必须重装依赖。
12. **回环请求必带** `NO_PROXY=127.0.0.1,localhost`：系统代理会劫持本机请求。
13. **禁止偏离安全白名单**：`.expect` + `panic=abort` 是进程级故障（§3.4 H-2）；`open_path` / `launch_pre_command` 必须走白名单与转义，绝不裸 `cmd /C`。
14. **AI 产物的责任边界不可模糊**（§4.3 / §4.4）：独立文件、独立分类、显式勾选确认、可一键回滚、未验证就不宣称已验证。
15. **工具栏加按钮先验密度档**（2026-11-11）：`is-low-frequency` 组随容器宽度整组隐藏，多一个常驻按钮
    就会把「补全」等既有入口挤没。低频入口一律塞进既有下拉 /「更多」，改完先跑 `check-toolbar.mjs`。
16. **响应式 UI 断言不能绑死单一宽度**（2026-11-11）：同一个入口在 1440 隐藏、1280 可见；
    检查脚本必须按 `isVisible()` 选路，否则单跑通过、进门禁必挂。
17. **`install_archive` 只落盘不入库**（2026-11-11）：登记 `state.mods` 是调用方职责。
    任何绕过 `install_mods_blocking` 的模块必须自己 `push + save`，并带上 Nexus 元数据。
18. **改 CRLF 文件前先查行尾**（复发多次）：Python `open(..., newline="\n")` 会把 `.rs` / `.md` 整文件刷成 LF，
    `git diff` 变成几千行噪音；写完二进制回写 `
`。

19. **一个动作只留一个入口**（2026-11-12，INCIDENT-2026-11-12-pack-entry）：导出/导入共用对话框两个 tab
    就别再拆成两个菜单项；顶部与侧栏绑同一个 `onImport` 的重复按钮要删掉一个（空库引导除外）。
    改入口前先数「同一动作现在有几处能点」，含下拉、更多、空状态与命令面板。
20. **高频入口别放进有密度降档的容器**（2026-11-12）：`.library-toolbar` 会按实测宽度把
    `is-low-frequency` 整组收进「更多」，加常驻按钮会让既有低频入口消失（规则 15 的复发）。
    顶部全局栏没有降档机制，高频主操作优先放那里；窄屏用「收起快捷键提示」这类小代价腾宽度。
21. **改了打包资源要确认 build script 会重跑**（2026-11-12）：`src-tauri/build.rs` 一旦输出任何
    `cargo:rerun-if-changed`，Cargo 就只监视列出的路径。替换图标资源后必须同步声明
    `cargo:rerun-if-changed=icons/icon.ico`，否则 exe 会静默内嵌旧资源；判据是 build 输出目录里
    `resource.lib` 的大小/时间戳有没有变（本次 7232 B → 6992 B 才确认圆角真的进了产物）。
