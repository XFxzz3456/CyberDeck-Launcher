<p align="center"><img src="assets/brand/badge.svg" width="96" height="96" alt="CyberDeck Launcher"></p>

# CyberDeck Launcher

**v1.8.2 · 最新正式版（STABLE）**

> 版本号的唯一事实源是 `package.json` 的三处 `version`（`node scripts/check-version-sync.mjs` 校验）；本行、`docs/SESSION-START.md` §3、`HANDOFF.md` §0 的「当前版本」由同一脚本一并校验。历史版本见 [CHANGELOG](CHANGELOG.md)。

一个只服务《赛博朋克 2077》的轻量 Mod 启动器。**Tauri 2 + React 19 + TypeScript + Rust**。

它不试图成为第二个 Vortex。它只把四件事做好：**导入、部署、排序、诊断**。

![模组库](docs/screenshots/library.png)

## 现在能做什么

| 能力 | 实现 |
|---|---|
| 模组库 | 卡片网格、分类、搜索、排序，虚拟滚动支持 500+ 条 |
| 安全安装 | ZIP / 7z 内置解压；RAR 调用本机 7-Zip/WinRAR；先解压到暂存区，解析 `info.json`，识别 archive / REDmod / CET / redscript / 完整游戏目录 |
| 路径嗅探 | 自动剥离 `Wrapper/Inner/...` 多层包装；同一层出现多个模组根目录时返回 `LAYOUT_AMBIGUOUS`，不静默漏装 |
| 导入确认 | 导入后逐项显示 `info.json` / 文件名回退来源；没有 `info.json` 时明确提示，并可直接选择分类 |
| 部署 | 优先硬链接；跨盘自动尝试符号链接，最后回退复制；失败整批回滚 |
| 卸载 | 严格按 `deployed_files` 清单删除；硬链接删除前校验文件 ID，目标被替换就拒绝删 |
| 冲突中心 | 右上角冲突计数可点开；同时列出「已启用冲突」和「暂存模组启用后会冲突」的目标，可禁用一方或跳转加载顺序 |
| AI 冲突建议 | 冲突中心可选让已配置的 AI 服务只分析当前冲突，给出保留/禁用建议；仍需逐次同意，只发送脱敏摘要 |
| 加载顺序 | Archive 指针拖拽排序（带跟随浮层）；可选写入游戏原生 `archive/pc/mod/modlist.txt`；REDmod 按文件夹 ASCII 顺序只读展示；路径级冲突高亮并说明“排序不能解决” |
| Mod 设置 | 读取 CET `ModSettings/user.ini`，按 true/false / 数字 / 文本渲染控件；写前备份 `user.ini.bak`，只改目标行，保留注释和顺序；可一键恢复 |
| 日志查看 | 扫描 `r6/logs`、`red4ext/logs`、CET 日志；末尾 100/300/500 行；级别过滤、错误高亮；「提取错误」只保留每条错误前后 5 行，并可选择性交给 AI |
| 卡片状态机 | DEPLOYED / STAGED / CONFLICT 角标、状态色边、悬停操作区；平时只显示封面、名称与元数据 |
| 外观与主题 | NCPD / Netrunner / Arasaka / Militech / Modern 五套风格，每套有独立的按钮轮廓、标题装饰、面板走线与封面配色（Modern 支持明暗切换）；自定义强调色；自定义字体；90% / 100% / 110% 界面缩放；可收起侧边栏 |
| 动效细节 | Inter 正文 + Rajdhani 标题 + JetBrains Mono 等宽；卡片骨架屏、筛选淡入、冲突计数故障闪烁、低透明度扫描线 |
| 硬件外壳 | 面板 / 卡片 / 主题选择卡使用 CSS 切角；选中主题带电路走线、强调色呼吸与外发光；背景叠加低透明度工业噪点与双层网格 |
| 警告带 | 未链接游戏目录时显示红黑斜纹工业警告带与纯黑文字；设置页的未链接目录改为虚线接收面板，悬停有扫描反馈 |
| 任务中心 | 多文件导入进入右下角队列；逐个显示解压/落盘状态、进度和失败记录；失败可重试、记录可手动清理 |
| 命令面板 | `Ctrl+K` / `Ctrl+Shift+P`；模糊搜索模组，或执行导入、启动、冲突、日志、排序等命令 |
| 前置检查 | 根据 CET / redscript / `.xl` 推断需要的前置框架；缺失时卡片与详情抽屉提示，并提供 Nexus 搜索入口 |
| 防误触 | 「恢复原状」「清除游戏目录」使用按住 1.5 秒确认，单次点击不会执行 |
| 启动 | Steam `-applaunch 1091500` 或直接运行 exe；有 REDmod 时自动附加 `-modded --launcher-skip` |
| 发现 | 通过官方 Nexus API 浏览趋势/最新/更新；查看文件列表；Premium 可直接下载并导入，免费账号打开下载页 |
| 诊断 | RED4ext / CET / redscript / ArchiveXL / TweakXL / Codeware / Mod Settings，游戏版本、写权限、日志入口、备份状态 |
| 智能诊断 | 可选 AI 服务（任何兼容 OpenAI 协议的端点，预设含 OpenAI / DeepSeek / Moonshot / 通义千问 / 本地 Ollama）：只发送脱敏诊断摘要，逐次同意，Key 用 Windows DPAPI 保存 |
| 备份回滚 | 首次部署前备份 `modlist.txt` 与 `r6/config`；一键撤除全部部署并还原配置 |
| 整合包导入 | 一个压缩包里含多个 Mod 时自动拆开：识别每个模组根目录、逐个建立暂存区，并按包内 `modlist.txt` 预排加载顺序；拆不开的保留为单个模组并给出警告 |
| 播放集（Profile） | 把「启用哪些模组 + 加载顺序」存成一套预设，顶栏下拉一键切换；切换时先撤销当前部署再按目标集合重装，游戏文件不删除；支持新建 / 重命名 / 复制 / 删除，内置 Default 不可删 |
| 卡片右键菜单 | 右键任意模组卡片弹出快捷菜单：部署 / 取消部署、强制重新部署、打开暂存区文件夹、在 Nexus 上查看、复制 Mod ID；边缘自动内翻，Esc 或点空白关闭 |
| Mod 更新检查 | 「检查更新」命中后出现「全部更新」：下载新版前先把旧版本打成 zip 备份，更新后可随时回滚；版本比较按段数值（`1.0` = `1.0.0`、`1.10` > `1.9`） |
| 启动器自更新 | 设置 → 关于里检查新版本，从 GitHub Releases 的 `latest.json` 拉取并校验 minisign 签名，下载后重启生效（NSIS 安装版） |
| 环境自愈 | 启动 / 刷新时自动比对暂存区与部署文件：能救回的先救回、确认丢失的孤儿链接自动清理、模组登记同步修正；游戏目录整体不可用时两道保护闸拦住不误删 |
| 展示名清洗 | 从文件名导入的 Mod 自动得到可读展示名（去噪音前缀、`_` 转空格、智能首字母大写）；原始文件名保留在详情页 |
| 存档管理 | 一键快照存档目录，应用前强制确认并自动备份；扫描存档并给出上次扫描时间 |
| 通知中心 | 顶栏铃铛聚合活动流 + 未读角标；通知分类开关（冲突强制开启）；停留时长可配 3/5/10 秒、1–60 秒自定义或不自动隐藏；警告与错误强制手动关闭 |
| 自定义背景图 | 本地图片作全局背景；大图自动压缩（长边 1920 / JPEG q80）；头像式拖拽裁切构图 + 滚轮缩放；焦点平移、暗化遮罩、模糊滑块（模糊跑在独立合成层，不糊 UI） |
| 批量操作 | 模组库多选批量部署 / 撤销 / 启停；modlist 导出与批量选择工具条 |
| AI 能力 | 冲突建议 / 智能诊断 / 生成 AI 汉化覆盖层 / 脚本冲突 AI 补丁；任何 OpenAI 兼容端点（OpenAI / DeepSeek / Moonshot / 通义千问 / 本地 Ollama），可在线拉取模型列表，Key 用 Windows DPAPI 保存 |
| 列表视图 | 模组库卡片/列表双视图；列表支持按分类折叠、状态筛选（已启用 / 已禁用 / 缺前置）、版本与大小列对齐 |
| 游戏更新熔断 | 记录上次部署时的游戏版本，检测到版本变化后锁定部署并在顶栏显示红黑警告带；升级完 RED4ext / CET 等前置后点「解除锁定」恢复。导入与查看不受影响 |
| 环境体检与自愈 | 记录每个已部署文件的大小与修改时间，异步核对目标文件是否还在、是否被替换，给出 healthy / warning / critical 与缺失清单；「一键尝试修复」从暂存区重建链接，暂存区也丢失则标记为需要重新导入 |
| 多框架配置解析 | 按模组识别它真正拥有的配置：Mod Settings 的 `user.ini`（按 Section 模糊匹配）与 Native Interactions 的 JSON 绑定到详情抽屉；RED4ext 的 TOML 配置、CET `config.json`、AudioXL 归入全局设置只读展示。redscript / ArchiveXL / TweakXL / Codeware / REDmod 属于本体，不生成设置表单 |
| 多平台嗅探 | 依次查 Steam（注册表 + `libraryfolders.vdf`）、GOG 注册表、Epic `LauncherInstalled.dat`，可在设置页限定优先平台；启动按平台走 Steam URI 或直接运行 exe 并附 `-modded --launcher-skip` |
| Nexus 封面 | 从 Nexus 下载的模组自动带上官方封面图，加载失败回退程序生成封面；设置页「补全封面」可为已有模组批量回查封面地址（不改变已启用的模组） |
| Mod 名翻译 | 可选 AI 把英文模组名译成中文（原名保留在副行，搜索中英皆可）；框架与底层库自动跳过，不消耗额度 |
| 渲染容错 | 单张卡片数据异常时只降级该卡片（暗红边框 + `ERROR: DATA CORRUPTED` 并在控制台打印 mod_id），不会整页白屏 |
| 存档管理 | 每次部署前静默记一份环境快照（当时启用的模组 + 前置框架版本）；读档出问题时选中快照「应用此环境」，把部署状态回溯到那一刻。扫描本地存档目录，能读日志里读档失败报错时高亮「该存档可能依赖已禁用的 Mod」。**全程只读**：绝不读写 `.dat` 存档二进制，结构性修复交给 CyberCAT / Night City Save Editor 等外部工具，界面只提供入口与路径 |

### 界面

| 外观与主题 | Netrunner 冰蓝 |
|---|---|
| ![外观与主题](docs/screenshots/appearance.png) | ![Netrunner](docs/screenshots/netrunner.png) |

| 收起侧边栏 | Modern 深色 |
|---|---|
| ![收起侧边栏](docs/screenshots/sidebar-collapsed.png) | ![Modern 深色](docs/screenshots/modern-dark.png) |

| 工业警告带 | 未链接的游戏目录 |
|---|---|
| ![工业警告带](docs/screenshots/warning-strip.png) | ![未链接游戏目录](docs/screenshots/game-root-warning.png) |

| 加载顺序 | 诊断 |
|---|---|
| ![加载顺序](docs/screenshots/loadorder.png) | ![诊断](docs/screenshots/diagnostics.png) |

| Nexus 发现 | 智能诊断 |
|---|---|
| ![Nexus](docs/screenshots/nexus.png) | ![AI](docs/screenshots/ai.png) |

| 导入确认 | 冲突中心 |
|---|---|
| ![导入确认](docs/screenshots/import-review.png) | ![冲突中心](docs/screenshots/conflict-center.png) |

| Mod 设置 | 日志查看器 |
|---|---|
| ![Mod 设置](docs/screenshots/mod-settings.png) | ![日志查看器](docs/screenshots/log-viewer.png) |

| 命令面板 | 任务队列 |
|---|---|
| ![命令面板](docs/screenshots/command-palette.png) | ![任务队列](docs/screenshots/task-center.png) |

| 关键错误提取 | 防误触 |
|---|---|
| ![关键错误](docs/screenshots/log-extract.png) | ![防误触](docs/screenshots/danger-hold.png) |

| 缺失前置 | 空状态 |
|---|---|
| ![缺失前置](docs/screenshots/missing-prereq.png) | ![空状态](docs/screenshots/empty-state.png) |

| 模组详情 |
|---|
| ![详情](docs/screenshots/detail.png) |

### 五套主题

> 旧版是六套，`mono` 在 r20 被移除（老配置自动迁到 `modern`），`daylight` 更早下线。
> 现在只有下面五套，其中 **只有 Modern 支持明暗切换**，其余强制深色。

| NCPD 经典 | NETRUNNER 冰蓝 |
|---|---|
| ![NCPD](docs/screenshots/ncpd.png) | ![Netrunner](docs/screenshots/netrunner.png) |

| ARASAKA 荒坂红 | MILITECH 军用绿 |
|---|---|
| ![Arasaka](docs/screenshots/arasaka.png) | ![Militech](docs/screenshots/militech.png) |

| MODERN 现代 · 深色 | MODERN 现代 · 浅色 |
|---|---|
| ![Modern 深色](docs/screenshots/modern-dark.png) | ![Modern 浅色](docs/screenshots/modern-light.png) |

### 播放集与容错

| 播放集切换 | 播放集管理 |
|---|---|
| ![播放集切换](docs/screenshots/profile-switch.png) | ![播放集管理](docs/screenshots/profiles-panel.png) |

| 卡片右键菜单 | 游戏更新熔断 |
|---|---|
| ![右键菜单](docs/screenshots/context-menu.png) | ![更新熔断](docs/screenshots/update-lock.png) |

| 环境体检 | 存档管理 |
|---|---|
| ![环境体检](docs/screenshots/env-check.png) | ![存档管理](docs/screenshots/saves.png) |

## 快速开始

### 主题与缩放

「设置 → 个性化」可以切换 NCPD、Netrunner、Arasaka、Militech、Modern 五套风格，也可以直接选一个强调色；标题使用 Rajdhani，正文使用 Inter，日志与数据使用 JetBrains Mono（字体可换成系统字体，见「排版与缩放」）。五套主题不只是换色：按钮切角、标题装饰、导航标记、面板走线、封面配色各自一套。**Modern 是唯一能在明暗之间切换的风格**，其余四套强制深色；旧版的 Mono 与 Daylight 已下线，老配置会自动迁移到 Modern。主题卡片上直接显示该主题的模组库缩略图。界面缩放支持 90% / 100% / 110%，侧边栏可收成图标栏。主题、强调色、缩放和侧栏状态保存在本机 `localStorage`，启动时在首帧前恢复，不会闪回默认黄黑。

### 外观

- **视觉风格**：NCPD（经典黄黑）/ NETRUNNER（冰蓝黑客）/ ARASAKA（荒坂暗红）/ MILITECH（军用科技）/ MONO（纯黑白）/ **MODERN（现代扁平，支持浅色/深色）**。
- **明暗模式**：MONO 与 MODERN 可切 浅色 / 深色 / 跟随系统；其余赛博风格固定深色。
- 设置页顶部 Tabs 分区：外观与主题 / 游戏与路径 / AI 配置 / 工具组件 / 安全与维护 / 关于。

## 整合包（Nexus Collections）

支持 Nexus 官方 **collection.json** 清单：导入后逐条比对本地状态（已装 / 缺失 / 版本不符），
缺失项给「去 N 网获取」入口，下载完拖回启动器即可一键按清单顺序部署。
（Nexus 不向非会员签发直链下载，因此不做自动下载器。）

## 直接使用

两种产物：免安装的 `cyberdeck-launcher.exe`（约 6.3 MB，旁边需要 `WebView2Loader.dll`），以及 NSIS 安装包 `CyberDeck Launcher_0.7.0_x64-setup.exe`（约 2.8 MB，按当前用户安装）。

1. 打开 `release` 文件夹。
2. 双击 `CyberDeck Launcher.exe`。**`WebView2Loader.dll` 必须和 exe 放在同一目录。**
3. 在「设置」里选择 `Cyberpunk 2077` 根目录（包含 `bin\x64\Cyberpunk2077.exe` 的那一层）。
4. 从 Nexus 用浏览器下载 ZIP / 7z / rar，拖进窗口，或点「导入模组」；也可以在「发现」里连接 Nexus API Key。
5. 在模组卡片上启用。首次部署会自动备份；启用后点「开始游戏」。

> 运行环境：Windows 10/11 x64，WebView2 Runtime。发行版没有内置游戏，也不提供下载器。
> 数据默认在 `%APPDATA%\com.arol.cyberdeck`。如果该目录不可写，会自动回退到 exe 同级的 `cyberdeck-data`（便携模式）。
> .rar 需要本机安装 7-Zip 或 WinRAR；.zip 与 .7z 不需要额外工具。
> Nexus 直连下载需要 Premium；免费账号仍可浏览和打开下载页。AI 诊断需要自备任一兼容 OpenAI 协议服务的 API Key。
> exe 未做代码签名，Windows SmartScreen 可能提示；这是本地构建，可自行签名后再分发。

### 从源码构建

前置：Node.js 20+（CI 用 20，本地建议 22）、pnpm 12.8.1（见 `package.json` 的 `packageManager`）、Rust stable、Tauri 2 的 Windows 依赖。

```powershell
pnpm install
pnpm build
pnpm tauri build --no-bundle
```

生成 `src-tauri/target/release/cyberdeck-launcher.exe`。Tauri CLI 会自动启用 `custom-protocol`（内嵌前端资源）；如果直接用 cargo 构建发布版，必须显式加 `--features custom-protocol`，否则会去连开发服务器。

```powershell
cargo build --release --features custom-protocol
```

如果没有使用安装包，需要把 `WebView2Loader.dll` 放在 exe 旁边（本仓库的 `release` 目录已经准备好）。

本机没有 MSVC 时也可以用 GNU 工具链构建：把项目放在**不含空格**的路径（或建 junction），安装 `x86_64-pc-windows-gnu` target、MinGW-w64，并准备 `WebView2Loader.dll`。Windows 资源编译对路径空格敏感。

## 测试

核心文件操作与 Tauri 完全解耦，可以在无 WebView2 的环境里跑：

```powershell
cd core-tests
cargo test
```

当前 **42 项通过**（`cargo test` 全绿）：

- Archive 模组部署 / 禁用 / 卸载往返，暂存源文件保留
- REDmod 映射到 `mods/<folder>/`，并记录 `info.json` 元数据来源
- 完整游戏目录结构保持相对路径；散装 CET 的 `init.lua` 能部署到 `bin/x64/plugins/cyber_engine_tweaks/mods/`
- ArchiveXL 的 `.xl` 跟随 `.archive` 部署到 `archive/pc/mod`
- 同名目标冲突在写入前被拦截
- 暂存模组在启用前就能被标记为「会冲突」，且不会改动游戏目录
- ZIP Slip 路径穿越被拒绝
- 未知布局返回可操作错误
- 多层包装目录（`Wrapper/Inner/archive/...`）自动嗅探到真实根目录
- 一个包里出现多个模组根目录（同层或根+嵌套）时返回 `LAYOUT_AMBIGUOUS`，不丢文件
- 原生 `modlist.txt` 按保存顺序写入，且拒绝覆盖非启动器文件
- 目标被用户替换后，卸载拒绝删除
- 7z 解压、包装目录识别与暂存整理
- RAR 解压（本机有 WinRAR 时）
- Mod Settings `user.ini` 读写：保留注释/空格、写前 `.bak`、恢复
- 日志列表与末尾截取，Error 行分类
- 日志路径越界拒绝
- DPAPI 密钥加密/解密往返
- AI 脱敏、HTTP 请求、JSON 回复解析（本地 mock 服务器）
- AI 只接受固定的「冲突」「日志」意图，任意用户文本不会进入提示词
- 日志聚焦发送只保留错误前后 5 行
- 整合包导入：一个包内的多个 Mod 被拆成独立条目，包内 `modlist.txt` 转成推荐顺序
- 单 Mod 整合包不被误拆；`Wrapper/README.md` 这类包装目录被正确剥掉
- 播放集：切换时先撤销旧部署再部署新目标，`active_profile_id` 落盘，删除播放集自动落到 Default
- 配置解析：Mod Settings 段落按 60% 字符覆盖率模糊匹配，`Better` 这类通用词不会被误绑
- 多框架配置分流：RED4ext 的 `config.ini` 走 TOML 解析，Native Interactions 只读，`hud` 等通用 section 被过滤

前端交互测试（浏览器 + Mock 后端，使用本机 Edge）：

```powershell
pnpm dev
node scripts/ui-test.mjs
node scripts/ui-polish-test.mjs
node scripts/ui-theme-test.mjs
node scripts/ui-hardware-test.mjs
```

测试覆盖启用/禁用、搜索、7z 导入、加载顺序指针拖拽、Nexus 列表与文件选择、免费账号下载门禁、AI 同意门禁与结果渲染、Mod 设置编辑/恢复、日志查看器、设置与 1120×720 最小窗口。`ui-polish-test.mjs` 额外覆盖悬停操作、命令面板、多文件任务队列、日志级别过滤与关键错误提取、按住确认的取消/执行、缺失前置抽屉和空状态。`ui-theme-test.mjs` 覆盖五套主题、自定义强调色、90%/100%/110% 缩放、侧栏收起、首帧前恢复以及 1120/90% 下的无横向溢出。`ui-hardware-test.mjs` 额外断言面板/卡片切角、主题卡选中走线、全局噪点层、未链接警告带的斜纹与纯黑文字、虚线接收面板，以及 1120 宽度下警告带和按钮不溢出。

无人值守改造后新增的验收脚本（每项都能单独重跑）：

```powershell node scripts/check-scroll.mjs          # 虚拟滚动 + 卡片错误边界 node scripts/check-update-lock.mjs     # 游戏更新熔断横幅与解除 node scripts/check-platform.mjs        # 平台选择器 node scripts/check-context-menu.mjs    # 卡片右键菜单 node scripts/check-profiles.mjs        # 播放集切换与设置页面板 node scripts/check-env-panel.mjs       # 环境体检与修复 ```

## 关键设计

### 1. 安装与部署分离

```
ZIP / 7z / RAR ──解压──> %APPDATA%\...\staging\<id>\payload ──硬链接──> 游戏目录
                                      │
                                      └── 禁用只撤链接，暂存保留；卸载才删除暂存
```

- **禁用 ≠ 卸载**。禁用只移除游戏目录里的链接；重新启用不需要重新解压。
- 导入后显示元数据来源：`info.json` 或文件名回退；没有 `info.json` 时可以直接在导入结果里选分类。
- 导入时缓存 `planned_files`，冲突中心无需每次启动都遍历所有暂存目录。
- ZIP 解压做路径穿越、符号链接、条目数（30k）与解压体积（8 GB）防护。
- 7z 使用纯 Rust 解压并逐条检查路径；RAR 通过本机 7-Zip/UnRAR 解压后再做同样的路径、符号链接与体积检查。
- 外部解压器产生的包装目录不会整个重命名：文件逐个移入暂存，避免 Windows ACL 下目录重命名失败。
- 路径嗅探按“直接子项中的游戏根锚点”打分；如果同层出现两个一样高的根目录，宁可报 `LAYOUT_AMBIGUOUS` 也不漏装。
- 部署前检查每个目标；冲突返回结构化错误，不静默覆盖。
- 目标已存在未受管文件时**默认阻止**。游戏原始文件永远不会被当作“旧版本”删掉。

### 2. 链接策略

1. 同卷：`std::fs::hard_link`
2. 跨盘或硬链接失败：Windows `symlink_file`
3. 符号链接权限不足：复制
4. 部署中途失败：删除本次已创建的目标，回滚状态

卸载时：

- 符号链接：直接删链接（不会碰目标）
- 硬链接：用 Win32 `GetFileInformationByHandle` 校验卷序列号 + 文件索引；不一致就拒绝删除
- 复制：删除游戏目录副本；暂存源始终保留

### 3. 加载顺序的真实规则

这部分和很多“教程”写的不一样，代码按游戏实际行为实现：

- 游戏先加载 `archive/pc/mod` 下的 `.archive`，默认按**文件名的 ASCII 顺序**。
- `archive/pc/mod/modlist.txt` 可以覆盖这个顺序；文件内容是 archive 文件名，一行一个。
- REDmod 永远在 archive 之后，按 `mods` 下的**文件夹名 ASCII 顺序**，不受 `modlist.txt` 影响。
- `.xl` 是 ArchiveXL 的资源注册文件，不参与独立排序，跟随所属 archive。
- 没有同名冲突时，不建议接管 `modlist.txt`；UI 默认关闭自动写入，写入前会备份非启动器创建的文件。

> 参考：[Cyberpunk 2077 Modding Wiki — Archive files Load Order](https://wiki.redmodding.org/cyberpunk-2077-modding/for-mod-users/users-modding-cyberpunk-2077/load-order)

### 4. 多框架配置边界

配置分散在不同框架里，格式各不相同，所以按「谁能绑到单个 Mod」分三类处理，不是给所有框架都造表单：

| 类别 | 框架 | 路径 | 处理 |
| --- | --- | --- | --- |
| A（绑定到 Mod） | Mod Settings | `red4ext/plugins/mod_settings/user.ini` | INI。section 名归一化后与 Mod 名比对，生成表单 |
| A（绑定到 Mod） | Native Interactions | `bin/x64/plugins/cyber_engine_tweaks/mods/nativeInteractions/projects/<Mod>.json` | JSON。按文件名匹配，默认只读，手动切换才可编辑 |
| B（框架级全局） | RED4ext | `red4ext/config.ini` | **内容是 TOML**，扩展名是 .ini。必须用 `toml` crate |
| B（框架级全局） | CET | `bin/x64/plugins/cyber_engine_tweaks/config.json` | 两层结构，显示键扁平化为 `first.second` |
| B（框架级全局） | AudioXL | `red4ext/plugins/AudioXL/AudioXL.ini` | 全局只读或高级编辑，不绑定 Mod |
| C（无玩家配置） | redscript / ArchiveXL / TweakXL / REDmod / Codeware | `.reds` / `.archive` / `.yaml` / `.xl` | 只展示文件清单与部署状态，不生成表单 |

几条边界：

- **模糊匹配防误伤**：`[BetterVehicleHandling]` 能匹配「Better Vehicle Handling」，但「Better」单独出现时不能绑到它身上——要求较短的一侧覆盖较长一侧 60% 的字符才算同一个 Mod 的写法差异。
- **通用 section 过滤**：`General` / `ModSettings` / `hud` 这类保留名不当作 Mod 专属配置。
- **解析失败退回空集**：某个配置文件坏了，详情抽屉只显示「无需设置」，不会打不开。
- **Mod Settings 写入**仍是行级替换：只改目标 key，保留注释、缩进、顺序和其他 section；写前 `user.ini.bak`，再写临时文件原子替换。
- `user.ini` 不保存 min/max/step，数字项用精确输入框，不伪造滑块范围。

### 5. 交互层与危险操作

- 卡片状态由 `enabled`、冲突集合推导，不额外维护一份易漂移的 UI 状态；冲突优先于 DEPLOYED。
- 悬停操作区只影响可见性，不影响部署状态机；键盘 Tab 进入卡片时同样会出现。
- 多文件导入在前端串行执行，每个文件一个任务；后端 `install_mods` 仍可接收一批路径，任务中心只是把批次拆成可观察的进度。
- 「恢复原状」「清除游戏目录」使用指针/键盘按住 1.5 秒的 `DangerConfirmModal`；松开、失焦或指针离开都会取消。
- 前置检查是保守推断：CET Lua → CET，`.reds` → redscript，`.xl/.xlp` → ArchiveXL；不把每个 archive 都当成缺框架，也不冒充作者声明的完整依赖图。

### 6. 主题与可读性

- 颜色全部走语义 token：`--accent` / `--accent-rgb` / `--accent-ink` 和 `--bg` / `--panel` / `--line` / `--text`。切换 `data-theme` 时按钮、焦点环、进度条、发光和选中态一起变，不是只换一个黄色。
- 正文用 Inter，标题和品牌用 Rajdhani，日志/路径/数据用 JetBrains Mono，均由 `@fontsource` 本地打包，不依赖网络字体。
- 自定义强调色会用 WCAG 亮度计算自动选择黑/白前景，避免用户选深色后按钮文字消失。
- 90% / 100% / 110% 使用 `body { zoom }`，同时让 `body` 保持 100% 宽高；在 WebView2 的 125% DPI 和 1120×720 窗口下都验证过无横向溢出。
- Modern 主题关闭扫描线、网格和卡片悬浮阴影；`prefers-reduced-motion` 下所有动画会被压到近乎静止。

### 7. 数据模型

Rust 侧 `src-tauri/src/schema.rs` 与前端 `src/types.ts` 镜像。UI 只渲染 `ModEntry`，所有文件操作只通过 Tauri `invoke`。

```ts
interface ModEntry {
  id: string;
  name: string;
  version: string | null;
  category: string;
  enabled: boolean;
  layout: "gameRoot" | "archive" | "redmod" | "cet" | "redscript";
  stagingPath: string;
  deployedFiles: DeployedFile[]; // 卸载的唯一依据
  // ...
}
```

### 8. 错误与回滚

后端返回结构化错误：

```ts
{ code: "DEPLOY_CONFLICT", message: "...", conflicts: [...] }
```

`deploy_mod` 先在内存中生成完整计划并预检，再创建目标；状态文件写入失败时会把刚创建的链接全部删除并恢复旧状态。`write_modlist` 也不会覆盖非启动器创建的文件。

### 9. Nexus 边界

启动器只调用 `api.nexusmods.com/v1`，不解析网页 DOM：

- `trending` / `latest_added` / `latest_updated` 读取列表；
- 模组详情和文件列表来自 API；
- `download_link` 只有 Premium Key 能拿到；免费账号会看到明确提示；
- 下载文件保存在数据目录 `downloads/`，然后走同一套解压、布局识别和暂存流程；
- 导入后的 `ModEntry.nexus` 记录 mod id、file id 和页面 URL，方便回看来源。

API Key 使用 Windows DPAPI（当前用户范围）加密后写入 `secrets/nexus-api.key`；明文不进入状态 JSON。

### 10. 智能诊断边界

- 默认关闭；必须在面板里逐次勾选同意。
- 只发送游戏版本、框架状态、模组名单、冲突、加载顺序；日志尾部是可选，且每个文件只取最后 8 KB。
- 从日志查看器点「提取错误」时，发送的是每条错误前后 5 行，不是完整日志；前端只允许固定 `logs` 意图。
- 发送前替换游戏目录、数据目录、用户目录、任意绝对 Windows 路径和邮箱。
- Key 同样用 DPAPI 保存；模型只返回 JSON 建议，**不会自动改文件**。

### 11. 播放集（Profile）

一套播放集 = 「启用哪些 Mod + 加载顺序」的存档。顶栏下拉切换，设置页管理。

- 存储为 `profiles: ProfileEntry[]` + `activeProfileId`，默认自动生成一个 `Default` 播放集。
- 切换流程被拆成四段：**快照 → 撤销旧部署 → 短锁写入状态 → 部署新目标**。原因是 `deploy_mod` / `undeploy_mod` 内部各自锁 `store.data`，`std::sync::Mutex` 不可重入，全程持锁会当场死锁。
- 部署新目标前同样走游戏更新熔断校验，避免「切换播放集」绕过锁定。
- 删除正在使用的播放集会退回 `Default`；`Default` 本身不可删除。
- 导入整合包时自动建一个同名播放集并置为当前，但**不自动部署**——装完先看，再手动部署。

### 12. 环境体检与自愈

- 部署时在 `deployedFiles` 里记录目标的 `size` 与 `modifiedTime`（旧记录没有这两个字段，体检会自动降级为「只查存在性」）。
- `diagnoseEnvironment()` 返回 `healthy / warning / critical` 与问题清单：文件丢失、大小不符、修改时间被外部改写。
- `healEnvironment()` 只动链接层：从暂存区重建缺失的文件；暂存区也丢了就标记为 Broken 并提示重新导入，不删游戏文件。
- 熔断：`bin/x64/Cyberpunk2077.exe` 的版本与 `lastGameVersion` 不一致时，部署入口直接拒绝，顶栏显示红黑横幅，点「解除锁定」才恢复。首次绑定路径不触发。

### 13. 日志查看边界

- 只扫描 `r6/logs`、`red4ext/logs`、CET `logs` 和 CET 插件目录。
- 读取前校验路径在游戏根目录内、扩展名 `.log/.txt`、非符号链接、≤32 MB。
- 只读末尾 256 KB；Error/Warn 只是关键词分类，不冒充完整日志解析。
- 「提取错误」在本地按级别/关键词取错误前后 5 行；只有用户逐次勾选同意后才把这段脱敏片段发给 AI。

## 目录结构

```
cyberdeck-launcher/
├─ src/                       React UI
│  ├─ components/             卡片、虚拟网格、任务中心、命令面板、危险确认、加载顺序、Mod 设置、诊断、设置、抽屉、导入
│  ├─ lib/api.ts              Tauri invoke 封装 + 浏览器 Mock 切换
│  ├─ lib/dependencies.ts     前置框架推断（保守规则）
│  ├─ lib/tasks.ts            任务中心类型
│  └─ types.ts                与 Rust schema 镜像
├─ src-tauri/
│  ├─ src/installer.rs        ZIP/7z/RAR 解压、路径嗅探、部署/卸载、冲突
│  ├─ src/nexus.rs            Nexus API、密钥、下载与导入
│  ├─ src/ai.rs               OpenAI 兼容 AI 诊断、脱敏、日志尾部
│  ├─ src/modsettings.rs      CET user.ini 读取、行级写入、.bak
│  ├─ src/config_resolver.rs  多框架配置解析（A/B/C 分类、60% 模糊匹配、TOML/JSON/INI）
│  ├─ src/profiles.rs         播放集切换：快照 → 撤销 → 写状态 → 部署
│  ├─ src/collection.rs       Nexus Collections 清单解析、匹配与加载顺序
│  ├─ src/logs.rs             日志发现与末尾读取（只读）
│  ├─ src/loadorder.rs        archive 顺序、modlist.txt
│  ├─ src/diagnostics.rs      前置框架与问题检查
│  ├─ src/backup.rs           r6/config 与 modlist 备份/恢复
│  ├─ src/game.rs             路径检测、版本、Steam、启动、文件 ID
│  └─ src/schema.rs           数据结构
├─ core-tests/                无 Tauri 的核心测试 crate
├─ scripts/                   图标、UI 测试、真实环境预检
├─ docs/screenshots/
├─ docs/REAL-ENV-TEST.md      真实游戏环境验收清单
├─ docs/PROJECT_HISTORY.md    项目史：里程碑、事故复盘、架构决策
└─ ../release/               便携发行版（exe + WebView2Loader.dll）
```

更多分层说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

UI 审计的方法、发现的问题、六套主题的设计语言与遗留项，见 [项目史 · UI 审计 0.7.0](docs/PROJECT_HISTORY.md#audit-ui-070)。

真实游戏目录验收步骤、权限/硬链接/CET/`.xl`/AI 服务检查清单见
[docs/REAL-ENV-TEST.md](docs/REAL-ENV-TEST.md)。只读预检可以直接跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\real-env-check.ps1 -GameDir "D:\SteamLibrary\steamapps\common\Cyberpunk 2077"
```

## 明确不做

- ❌ 不抓取 Nexus 网页，也不内置账号密码登录；只使用官方 API + 可撤销的 personal key。
- ❌ 不绕过 Nexus 的 Premium 下载限制；免费账号使用浏览器下载。
- ❌ 不做自动冲突合并。只列冲突、禁用一方或让你手动处理，绝不替用户决定覆盖顺序。
- ❌ 不做游戏内 overlay 或进程注入。启动器只做安装、部署、排序、诊断。
- ❌ 不随包提供游戏本体、未授权模组或盗版资源。

## 已知限制

- RAR 依赖本机 7-Zip 或 WinRAR；没有工具时会给出明确错误，不会尝试不安全的替代方案。
- Nexus API 不提供全文搜索。发现页的搜索框只过滤当前已加载列表；要完整检索请打开 Nexus 网站。
- Nexus API 只向 Premium 账号签发下载链接。免费账号的「下载并导入」按钮会禁用并提示。
- REDmod 的 `-modded` 参数已自动处理；但某些 REDmod 还需要作者自己的启动参数，启动器不会猜。
- 文件冲突检测是“目标相对路径”级别，不解析 archive 内部资源冲突。
- 游戏更新后框架兼容性只做版本变化提示，不联网查询框架兼容表。
- 原生 `modlist.txt` 的接管是显式操作；没有同名冲突时保持 ASCII 顺序最稳。
- AI 诊断需要网络与自己服务商的 API Key（任何兼容 OpenAI 协议的端点）；它只给建议，不会自动修改模组或游戏文件。
- Mod 设置的控件类型从值推断；`user.ini` 不保存 min/max/step，所以数字项用精确输入框，不伪造滑块范围。
- 日志查看器只读末尾 256 KB，不解析完整日志，也不上传。
- Native Interactions 的 JSON 是交互点定义，结构复杂；当前只读展示 + 语法校验，写坏 Mod 的风险由用户手动切换编辑承担。
- 环境体检对「部署时尚未记录 size/mtime」的旧条目只查存在性，不查内容是否被替换。
- 播放集切换不做额外的全量备份，只依赖 `deploy_mod` 内部已有的自动备份。
- 游戏更新熔断只拦部署入口（`set_mod_enabled` / 播放集切换 / 修复）；导入、浏览、看配置不受影响。
- 当前发行版是便携目录，不含 NSIS 安装包。

## 下载安装

1. 到 [GitHub Releases](https://github.com/XFxzz3456/CyberDeck-Launcher/releases) 下载最新的 `CyberDeck Launcher` 便携版 ZIP（免安装，解压即用）。
2. 解压到任意可写目录，运行 `CyberDeck Launcher.exe`。首次启动会引导你定位游戏目录。
3. 数据保存在 exe 同级的 `cyberdeck-data`（或 `%APPDATA%\com.arol.cyberdeck`），卸载启动器删掉这个目录即可，不动游戏文件。

从旧版（NightCity Loader / 0.x）升级：直接替换 exe，数据目录会自动识别与迁移。

## 赞助支持

启动器完全免费开源。如果它帮到了你，欢迎到 [GitHub 仓库](https://github.com/XFxzz3456/CyberDeck-Launcher) 点一个 Star，这是对独立开发者最直接的支持。

## 许可与声明

代码以 MIT 许可发布。与 CD Projekt Red、Nexus Mods、Vortex 无隶属关系。
“Cyberpunk 2077” 是 CD Projekt Red 的商标。请只使用你有权使用的模组与游戏内容。
