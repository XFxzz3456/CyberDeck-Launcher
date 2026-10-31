# 项目记忆权威索引（MEMORY-CANON）

> 建立于 2026-10-27 21:45。**目的：终结并行会话造成的记忆分散。**
> 背景：多端协同开发期间，同一个项目的长期结论被写进了 4 处 `.workbuddy/memory`，出现重复与漂移。
> 本文件是**唯一权威索引**：任何工作区的会话先读这里，再按需展开历史快照。

## 0. 目录（2026-10-28 起）

| 用途 | 路径 |
|---|---|
| 源码（项目根，本文件所在仓库） | `D:\用户\CyberDeck-Launcher\src` |
| 发行产物 | `D:\用户\CyberDeck-Launcher\release` |
| 便携包产物 | `D:\用户\CyberDeck-Launcher\发布产物` |
| 工具链缓存（Low IL，普通进程写不进） | `D:\用户\CyberDeck-Launcher\.tools` |

> 2026-10-29 由 `D:\用户\工作区` 重命名而来；2026-10-28 由 `CyberDeck-Launcher-src-0.7.0` / `...-0.7.0-release` 改为 `src` / `release`。
> **改名后必须 `pnpm install`**：pnpm 旧版写指向绝对路径的软链，改父目录名会整片断链（2026-10-29 实测重装后已是相对软链）。
> 旧路径出现在 2026-10-29 之前的 `CHANGELOG` / `INCIDENT` / 历史报告里属**历史事实，不回改**。
> 版本发布流程见 `AGENTS.md`《版本更新自动化规范》。

## 0.1 三条分工（先读这段）

| 要查什么 | 去哪 |
|---|---|
| **版本事实**（改了什么、何时、哪个模块） | `CHANGELOG.md` + `HANDOFF.md` |
| **长期规则 / 铁律 / 环境坑** | 本文件 |
| **过程细节 / 当时的错误假设** | 对应历史快照（只读，见第 1 节） |

## 1. 记忆分布与状态

| # | 位置 | 内容 | 状态 |
|---|---|---|---|
| 1 | `D:\用户\CyberDeck-Launcher\.workbuddy\memory` | 源码根会话：文案审查（0.8.0-r7）、影子工程预演方法 | **历史快照 · 只读** |
| 2 | `D:\用户\工作区（WorkBuddy）\.workbuddy\memory` | 容器根会话：文档同步管线（create_doc / doc_sync_driver）、资料库 node id、10-25~10-27 日志 | **历史快照 · 只读** |
| 3 | `...\2026-10-25-23-32-55\.workbuddy\memory` | 主力开发：19KB 日志 + 10.8KB MEMORY（事故铁律、品牌决策、部署流程） | **活跃 · 权威工作记忆** |
| 4 | `...\2026-10-26-01-49-40\.workbuddy\memory` | PM/看板/文档：CHANGELOG 重建、看板盘点、资料库与网盘同步 | **历史快照 · 只读** |
| 5 | `...\2026-10-25-22-46-11\.workbuddy\memory` | 专家包转化（cp2077-mod-expert「夜之城管家」），一次性交付 | **历史快照 · 只读** |
| — | `...\Claw` | 空目录，无记忆 | **已于 2026-10-27 21:46 删除** |

**规则**：只有 #3 继续追加；其余四处只读。新结论按第 6 节写入。

## 2. 不可违反的铁律

### 2.1 安全红线（改 Rust 前必读）
1. 卸载**只信任 `deployed_files` 清单**，绝不推测；
2. 路径拼接必须过 `safe_join` + `is_within`；
3. 硬链接身份比对必须用 `GetFileInformationByHandle`；
4. **Mutex 内不做 IO**：无锁 IO → 短锁登记 → 锁外 emit。
5. **`store.data` 不可重入**（0.9.0 r22 立）：持锁期间**绝不调用** `installer::deploy_mod` / `undeploy_mod`（它们要读游戏目录、耗时且可能再取锁）。凡批量部署/撤除一律走四段式：**读快照（短暂持锁 clone）→ 逐条操作（完全不持锁）→ 短锁写内存状态 → 锁外落盘**。`safemode.rs` 的 enter/exit 是标准样板。
6. **「安全/救援」类操作一次只动链接，不动本体**：Safe Mode 只按 `deployed_files` 撕除，**绝不删 staging 里的 Mod 本体**（用户原始缓存是救援前提）。恢复失败时必须保留快照供重试，只有 `failed_mods == 0` 才允许删快照。

### 2.2 构建铁律
- 正式包只能 `node_modules\.bin\tauri.cmd build --no-bundle`（`CARGO_PROFILE_RELEASE_LTO=false`）。
- 🔴 **绝不能只用 `cargo build --release`**：`tauri/build.rs` 里 `dev = !has_feature("custom-protocol")`，缺该 feature 就不内嵌前端 → 用户看到 `ERR_CONNECTION_REFUSED`。必须用 cargo 时加 `--features custom-protocol`。
- 判据：正式 ≈8.3MB / dev ≈6.8MB；**最硬判据是 `startup.log` 里有 `stage=frontend`**。exe 里能 grep 到 `localhost:1420` 不是判据。
- `tauri` CLI 必须走 `node_modules\.bin\tauri.cmd`；直接跑 `@tauri-apps/cli/main.js` 会静默空转、退出码 0、不产出 exe。
- 验证产物含最新前端：比对部署 exe 与 `target/release` 的 md5（Tauri 会 brotli 压缩嵌入，明文 grep 会失效）。
- **新增 Tauri 命令要改两处**：`src-tauri/src/lib.rs` 里的 `#[tauri::command] fn xxx` + `tauri::generate_handler![...]` 列表。漏登记 → 前端 invoke 直接报 command not found，编译期不报错。
- **i18n 门禁会对「非界面文案的数据表」误报**（r22）：帮助中心 `helpContent.ts`、mock 数据等长中文内容，用 `// i18n-ignore-start` / `// i18n-ignore-end` 包整块；单行用行尾 `// i18n-ignore`。`scripts/check-i18n.mjs --fail` 与 `--unused` 双向必须归零才算过。

### 2.3 数据文件铁律
- **禁止用 shell 的 JSON 往返**（读→解析→重序列化→覆盖）改 `launcher-state.json`，会写出非法 JSON 被判损坏；改字段只用 python `json.load/json.dump` 或走界面。
- **`serde` 自定义 `deserialize_with` 必须消费输入**（`IgnoredAny::deserialize(d)?`）；空数组形态同样触发。改 schema 前**必须用真实旧数据跑一次解析**，单测全绿 ≠ 旧数据能读。
- **改字符串前先判它是哪一类**（2026-10-28 r17 立的判据）：①**纯瞬时**（临时文件/目录名、日志前缀）→ 随便改，无残留；②**落盘值**（`origin`、状态里的绝对路径）→ 未发布可直接改，已发布必须配套迁移或 serde alias；③**识别判据**（`modlist.txt` 表头、版本戳）→ 同时用于「是否本程序所写」的判断，改名就要保留旧值兼容，除非确认无历史文件。
- **持久化绝对路径一律按「必须已存在」校验，不许 `create_dir_all` 兜底**：目录被改名/搬走后路径永久失效，自动建会把旧目录树原地复现 → 新旧两份数据并存。失效就回落默认位置并写回状态。
- **配置导出必须是白名单，不是黑名单**（r22）：列举允许导出的字段；**绝不导出** API Key、DPAPI 密文、Mod 库、`deployed_files`、`staging_dir`。导入先全内存校验（解析 → schema 版本 → 白名单）后再落盘，**校验失败不写任何脏状态**。单测要断言导出文本里搜不到 `api_key`/`apikey`/`secret`/`dpapi`/`bearer`（小写比对，防大小写漏网）。
- **版本号不能按数字大小硬比**（r22 教训）：赛博朋克 `2.21` 是 2.2.1 补丁，**早于** `2.5`；`(2,21) > (2,5)` 会得出反结论。做法：逐位取数字得 `[2,2,1]` vs `[2,5]`，字典序比较、短的一侧补 0。所有版本比较集中在一个 `version_lt()` 里，禁止散落。
- **词表类本地库的主键要含原文指纹**（r22）：`mod_id + FNV-1a64(原文)`。Mod 更新后原文变化即失配，**天然版本隔离、无需迁移**；合并优先级 本地(user/ai) > 云端(cloud)，`by=="user"` 的条目永不被覆盖。

### 2.4 环境与归因铁律
- **进程行为异常（写被拒／子进程崩溃／跳转静默失败）先查环境**：`icacls <exe>` 看 `Mandatory Label` 与孤儿 SID（`S-1-4-*`），再查 token integrity（Low=0x1000 / Medium=0x2000）。
- 搬运目录必查 Low 完整性标签；修标签 `icacls <dir> /setintegritylevel "(OI)(CI)Medium"`。
- **一次只改一个变量**（品牌改名 / schema 变更 / 数据迁移分三次提交）。
- **禁止静默回退到另一个数据目录**（会造成状态分裂、密钥"消失"）。
- 不靠整程序提权解决局部权限问题（会让浏览器被提权、UIPI 阻断拖拽）；提权进程打开外链必须转交 `explorer.exe`。
- GUI 无控制台，`eprintln!` 等于没日志 → 关键启动路径落 `startup.log`。

### 2.5 工具链踩坑
- PS 5.1 三坑：`Start-Process` 遇 `HTTPS_PROXY`/`https_proxy` 并存报"字典关键字重复"（先删小写变体）；`-Verb RunAs` 不能配 `-RedirectStandardError`；`Get-Content` 默认 ANSI，读 UTF-8 JSON 必须 `-Encoding UTF8`。
- **PowerShell 脚本含中文路径必须带 UTF-8 BOM**，否则按 GBK 解码会生成乱码目录（`D:\鐢ㄦ埛` 事故）。
- 字节级批量编辑前先确认换行符；Python 读写都要 `newline=''`，落盘前用二进制 `count(b'\r\n')` 比对。
- 文案/字符串批量替换只做字面匹配，**查不出条件分支错位** → 改完必须回读三元/if 上下文。
- 跑门禁前先停掉手起的 `vite preview`（端口 1420 占用会让 gate 直接判失败）。
- 截屏验收一律用 playwright 在浏览器预览里做；PowerShell `Add-Type System.Windows.Forms` 会被安全策略拦。

## 3. 文档落点（三处必须同步）

| 落点 | 位置 |
|---|---|
| 源码 | `CHANGELOG.md`、`HANDOFF.md`、`AGENTS.md`（执行规范）、`docs/*` |
| 资料库 | space `btCAC0glhsDub7qu3xaeLI`；**以空间内最新同名节点为准**（每次上传都新建节点）；「历史归档」`BCdu1Ae573PdgfNEQ9c7AD` |
| 项目网盘 | tdrive 根 `CyberDeck Launcher 项目文档` = `YbyPEuDRRBHW`，2026-10-28 起按用途分 6 个子目录（下表），**上传时 `dir_id` 必须用子目录 id，不要传根 id** |

**项目网盘目录结构（2026-10-28 23:16 整理）**

| 目录 | dir_id | 收录 |
|---|---|---|
| `00-入口` | `YwJhEpFsXioM` | README.md |
| `01-协作规范` | `YBlKfqQbokOb` | AGENTS.md、MEMORY-CANON.md、HANDOFF.md |
| `02-变更记录` | `YFiYbkIKkSsC` | CHANGELOG.md |
| `03-技术文档` | `YXAxLrMnQAMP` | ARCHITECTURE.md、I18N.md |
| `04-测试报告` | `YnEunuvMfcEw` | REAL-ENV-TEST.md |
| `99-历史归档` | `YjcSwOIMFcOp` | 被取代的旧版本文档（当前为空） |

- 每次迭代固定要覆盖的是 `01-协作规范`（AGENTS / MEMORY-CANON / HANDOFF）+ `02-变更记录`（CHANGELOG），共 2 个目录。
- **打包便携 zip 必须自带 `cyberdeck-data` 目录**（r18 教训，2026-10-28）：`resolve_data_dir()` 的规则是「exe 同级 `cyberdeck-data` **已存在**才优先，否则落 `%APPDATA%\com.arol.cyberdeck`」。全新解压的包里没有这个目录 ⇒ 首跑数据进 AppData，便携名不副实。修法 = 包内放该目录 + 一个占位说明文件；解压实测要看 `stage=load ok dir=<exe同级>`，只看 `stage=frontend` 发现不了（frontend 心跳写在数据目录的 startup.log，诊断行才写 exe 侧）。
- **`.app-shell` 锁视口禁止用 `100vh/100vw`**（r18 教训）：body 上有 `zoom`（UI 缩放 90%/110%），vh/vw 会被 zoom 二次缩放，110% 挡位外壳撑破视口；必须走 html/body/#root 的 `height:100%` 链 + `overflow:hidden`（ui-theme-test 有断言）。
- **framer AnimatePresence 退场三条铁律**（r19，2026-10-29）：①退场期间旧元素仍挂载且**挡点击**——portal 层要用 `useIsPresent()` 设 `pointerEvents:none`，而该 hook 必须在 AnimatePresence **直接子组件**里调用（`ui.Modal` 为此拆出 `ModalShell`）；②「关闭动效=瞬移」不能靠 `MotionConfig reducedMotion` 兜底——它只跳 transform 不跳 opacity，要在变体工厂给 `animated=false`（时长 0 三态）；③新接管某处 CSS `@keyframes` 入场时，`data-motion="on"` 下必须让对应 keyframes 退位，否则 JS/CSS 各推一套、结束闪帧。

- 腾讯文档 MCP（tdoc）本机 `no_token`，**无法原地改写**资料库节点，只能新增节点；因此 doc 里不记录自身 node id（会永远差一代），改为「最新同名节点为准」。
- 资料库**没有删除接口**：清理只能用户手动删，或我移入「历史归档」。
- 上传 tdrive 时 `curl` 返回 `InvalidAccessKeyId` **仍然 exit 0**，必须检查响应体再确认落库。
- tdrive 的 `file_upload` 凭证偶发失效（`q-ak` 轮换）：`InvalidAccessKeyId` 时**重新申请一次即可**，不要反复重试同一份 headers。
- 若对**同一文件名**连续多次申请都报 `InvalidAccessKeyId`（换 ak、换签名、改 size 都无效），说明坏凭证是**按文件名复用**的，与凭证轮换无关。绕法：改用临时名上传（如 `HANDOFF-v2.md`）→ 下载比对确认内容 → `file_delete` 删旧节点 → `file_rename` 改回原名。2026-10-28 的 `HANDOFF.md` 就是这样卡住 4 次后绕过的。
- tdrive `dir_list` 的 `size` 字段**不随 overwrite 刷新**，核实内容必须 `file_download` 下载后比对字节数。
- 手抄预签名 header 进 `curl` 极易 403（长 token 转录错一个字符，exit 0 但 403 响应体）：**上传用 python `urllib.request` 脚本按原样传 header**（r18 已验证），跑完删脚本。

## 4. 当前版本状态（2026-10-29 更新）

- 已部署基线：**0.9.0-r22**（r20 / r21 / r22 全部内容）
- 已部署 exe：**0.9.0-r22**（2026-10-29 02:21，8,736,768 B，md5 `6e498e3dce314a9fcc3602ac088589cd`，**零编译警告**；上一版 r21 备份在 `CyberDeck Launcher.prev.exe`；冒烟 `stage=frontend mods=195` integrity=0x2000，数据目录 `release\cyberdeck-data`）
- 三处版本号已统一 **0.9.0**（2026-10-29 02:10）
- 安装包：`src-tauri/target/release/bundle/nsis/CyberDeck Launcher_0.9.0_x64-setup.exe`（3,332,269 B）
- 便携版：`CyberDeck Launcher 0.9.0 便携版.zip`（2026-10-29 02:20，4,148,716 B；带父文件夹结构 + `使用说明.txt` + **自带 `cyberdeck-data` 目录**，解压实测 `stage=load ok dir=<exe同级>`）。**已知边界**：在运行过 CDL 的机器上首跑会继承 `%APPDATA%\com.arol.cyberdeck` 的旧状态（含 staging 绝对路径）
- r20–r22 批次内容：
  - r20：下载中心重排为任务列表页（设置项迁「设置 → 工具组件 → 下载设置」）+ 分类引擎增强（`haystack_has` 整词匹配 + `reclassify_unclassified`「智能归类」只动「其他」）+ CD 图标全套重制 / 窗口标题缩为 `CyberDeck` + Logo 纯文字化 / 删 Mono 主题 / 缩放 80–150% 滑块
  - r21：AI 配置 Anthropic 原生协议（`api_protocol` + `x-api-key` / `anthropic-version` / `max_tokens` / `system` 提权 / `sanitize_anthropic_messages`）
  - r22（0.9.0 冲刺，看板【7】~【14】）：`glossary.rs`（词表 + 云端共享）、`docs/AI-LOCALIZATION-REVIEW.md`（【8】仅架构评审，M1 未启动）、`SplashScreen`（【9】）、`HelpCenterView` + `docs/help/*`（【11】）、`config_pack.rs`（【12】）、`safemode.rs` + `compat.rs`（【13】）、`docs/REAL-ENV-TEST-0.9.0.md`（【10】）、`docs/OLLAMA-LOCAL-MODEL.md` + `check-ollama.ps1`（【14】）
- **待构建**：无。
- ⚠️ 标号冲突未裁决：`0.7.0-r4` 与 `0.8.0-r4` 撞号，CHANGELOG 按实际时间排序、标号未改。

## 5. 计划看板（16 项，看板是唯一权威）

**以 WorkBuddy 界面【计划 (Plan)】看板为准**（`mcp__wb-issues__todo_list`）。不要从旧文档或历史会话里「脑补」任务清单（2026-10-29 踩过：读了 v3 的 T1–T8 旧表，方向全错）。

2026-10-29 0.9.0 冲刺后的状态：

| 编号 | 项 | 状态 |
|---|---|---|
| 0 | 文本优化去 AI 味 | done |
| 1 | bug 测试与修复（P0 持续轨道） | running |
| 2 | 绕过官方启动器直启游戏 | done |
| 3 | N 网下载经 NXM 接管 | done |
| 4 | 皮肤 UI 进一步优化（含自定义背景图） | claim |
| 5 | mod 列表及切换功能 | claim |
| 6 | 意见反馈通道 | claim |
| 7 | AI 汉化结果入库与云端共享 | **done（r22）** |
| 8 | AI 深度汉化（含框架菜单） | running（仅架构评审交付，M1 未启动） |
| 9 | 启动动画 | **done（r22）** |
| 10 | 真机环境最终排雷 | running（文档+清单已交付，实机项需人工跑） |
| 11 | 内置帮助中心 | **done（r22）** |
| 12 | 全局配置导入/导出 | **done（r22）** |
| 13 | 2.5 灾后重建 Safe Mode + 过期插件扫描 | **done（r22）** |
| 14 | 多模型 API 兼容验证（Ollama） | running（文档+探针脚本已交付，实机需人工跑） |
| 15 | 自动更新流水线（GitHub Actions + Tauri Updater） | claim（0.9.0 冲刺按要求跳过） |

**已实现不再重复立项**：双语显示、中英搜索、官方术语库、框架黑名单、NXM 协议接管、Collections 向导、WolvenKit 深扫、OpenAI 兼容多模型、Anthropic 原生协议、启动动画、帮助中心、配置导入导出、Safe Mode、过期插件扫描。

## 6. 写入规则（给未来的会话）

1. **变更级** → 追加 `CHANGELOG.md`（时间 / 标号 / 模块 / 新增·变更·修复 / 验证 / 边界）。
2. **规则级**（新铁律、新环境坑）→ 追加本文件第 2 或第 3 节，并在 `HANDOFF.md` 留一句引用。
3. **过程级**（当天细节）→ 写当前工作区 `memory/YYYY-MM-DD.md`，并在条目里注明「已收敛至 MEMORY-CANON」。
4. **不要**在各历史快照里继续追加，避免二次分叉。
5. **不要删除任何 `.workbuddy/memory` 目录**：删会话不会删它们，但手删会丢历史。
6. 修完 bug 仍按老规矩写 `docs/INCIDENT-<日期>-<主题>.md`（现象 → 真因 → 走过的错误假设 → 新约束 → 下次第一步查什么）。

## 7. 并行产物归档（2026-10-27 21:45–21:47）

并行会话散落在容器根的报告与脚本，已**复制**（非移动，原件保留）进源码仓库，使项目自包含：

| 原位置（`D:\用户\工作区（WorkBuddy）\`） | 归档到 |
|---|---|
| `NightCity-Loader-架构设计与长期规划.md` | `docs/REPORT-架构设计与长期规划.md` |
| `NightCity-Loader-UI评估与功能差距报告.md` | `docs/REPORT-UI评估与功能差距.md` |
| `NightCity-Loader-项目配置草稿.md` | `docs/REPORT-项目配置草稿.md` |
| `doc_sync_driver.py` | `tools/doc_sync_driver.py` |
| `md_to_doc_tables.py` | `tools/md_to_doc_tables.py` |

已清理（删除前已打包快照）：

- `Claw/`（空）、`arch_tables/`、`arch_tables3/`、`handoff_tables/`、`handoff_tables3/`（文档同步中间表格，内容已在资料库）
- `D:\用户\工作区\CyberDeck-便携版打包目录-可删\`（8.3MB，r4 构建残留；便携 zip 仍在根目录）

**回滚快照**：`D:\用户\工作区（WorkBuddy）\.workbuddy\snapshots\2026-10-27-cleanup.zip`（66 条目 / 4.06MB，integrity OK）。

**保留未删**：`2026-10-25-22-46-11/`（会话工作区，删文件夹会让该会话历史失联；仅 402B 记忆 + 1 图标，留着成本极低）、`acl-backup-release-dir.txt`（事故证据）。

