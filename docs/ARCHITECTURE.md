# 架构说明

## 一句话

**React 只画状态，Rust 只做文件操作，Tauri 只做 IPC。** 组件里没有文件系统逻辑，后端没有 UI 文案之外的展示逻辑。

```
┌──────────────────────────────────────────────────────────┐
│ React 19 + TypeScript                                    │
│  Library / LoadOrder / ModSettings / Diagnostics / Settings│
│  只读 ModEntry[]，只调用 api.*                            │
└───────────────────────┬──────────────────────────────────┘
                        │ Tauri invoke（结构化错误）
┌───────────────────────▼──────────────────────────────────┐
│ Rust core（可脱离 Tauri 测试）                             │
│  schema.rs     数据契约                                   │
│  store.rs      JSON 状态、原子写、路径安全                 │
│  game.rs       路径检测、版本、框架、启动                  │
│  installer.rs  ZIP/7z/RAR → 暂存 → 链接 → 清单 → 卸载      │
│  nexus.rs      Nexus API、下载、导入、密钥                 │
│  ai.rs         OpenAI 兼容 AI 诊断、日志尾部                 │
│  modsettings.rs CET user.ini 行级编辑、.bak                │
│  logs.rs       日志发现、末尾读取、级别分类                │
│  secret.rs     Windows DPAPI 密钥存储                      │
│  loadorder.rs  archive 顺序与 modlist.txt                  │
│  backup.rs     r6/config / modlist 备份与恢复              │
│  diagnostics.rs 规则式检查                                 │
│  config_resolver.rs 多框架配置解析（A/B/C 分类）            │
│  profiles.rs   播放集：快照 → 撤销 → 写状态 → 部署          │
│  collection.rs Nexus Collections 清单解析与加载顺序         │
└───────────────────────┬──────────────────────────────────┘
                        │ std::fs / Win32
┌───────────────────────▼──────────────────────────────────┐
│ 游戏目录                                                  │
│  archive/pc/mod/*.archive   ← 硬链接/符号链接/复制          │
│  mods/<REDmod>/info.json     ← REDmod 文件夹               │
│  r6/scripts、bin/x64/...     ← 原样映射                    │
└──────────────────────────────────────────────────────────┘
```

## 为什么把核心拆成 `core-tests`

生产 crate 链接 Tauri + WebView2。测试 crate 通过 `#[path]` 复用同一批源文件，不链接 GUI，因此：

- CI 或无桌面环境也能跑文件操作测试；
- 测试失败不会受 WebView2 profile、窗口、DPI 影响；
- 同一份实现，不存在“测试版逻辑”和“生产版逻辑”漂移。

## 分层职责

### `store.rs`

- 状态文件：`launcher-state.json`，先写 `*.tmp` 再 rename。
- 保存失败返回 `STATE_WRITE`，不会静默丢状态。
- 反序列化失败时把损坏文件改名为 `*.broken-<timestamp>.json`，再以空状态启动；不直接覆盖用户数据。
- `safe_join` / `normalize_rel` 是部署路径的最后一道防线：拒绝 `..`、盘符、绝对路径。
- 沙箱/只读 profile 下，Tauri 启动层可以回退到 exe 同级的 `cyberdeck-data`（便携模式）。

### `installer.rs`

安装阶段：

```
archive_path (.zip / .7z / .rar)
  → 安全检查（条目数、总解压体积、路径、符号链接）
  → 按“直接子项中的游戏根锚点”打分，嗅探真实根目录
  → 跳过文档 / .DS_Store / __MACOSX
  → 解压到 staging/.tmp-<id>/payload
  → 读 info.json（name/version/author/description）
  → detect_layout
  → 文件逐个移入 staging/<id>（不整体重命名目录）
  → 记录 layout、mod_folder、cover、warnings
  → 记录 metadata_source（info.json / 文件名回退）与 planned_files
```

- ZIP 使用 `zip` crate；7z 使用纯 Rust `sevenz-rust`；RAR 调用本机 7-Zip/UnRAR。
- 外部解压后再次遍历，拒绝符号链接/重解析点、超限体积和路径逃逸。
- Windows ACL 可能禁止重命名含嵌套目录的目录；暂存整理按文件移动，失败时回退复制。
- `refine_payload_root` 支持 `Wrapper/Inner/archive/...` 这类多层包装；如果同一层出现两个同样高分根目录，返回 `LAYOUT_AMBIGUOUS`，不会静默丢文件。

`detect_layout` 的优先级：

1. 含 `archive/pc/mod/`、`r6/scripts/`、`bin/x64/plugins/`、`red4ext/plugins/`、`engine/tools/` → `GameRoot`
2. 根目录有 `info.json` → `Redmod`
3. 有 `.archive/.xl` → `Archive`
4. 有 `.reds` → `Redscript`
5. 有 `.lua` → `Cet`
6. 其他 → 报 `LAYOUT_UNKNOWN`，拒绝乱塞

部署阶段：

1. 生成 `PlanFile { source, relative }`；导入时把相对目标缓存进 `planned_files`，供冲突中心快速扫描。
2. 检测同一模组计划内重复目标。
3. 对每个目标做预检：
   - 被其他已启用模组声明 → `managed` 冲突；
   - 磁盘上已存在但没人声明 → `unmanaged` 冲突；
   - 存在即阻止，不覆盖。
4. 快照额外返回 `staged_conflicts`：暂存模组的计划目标若与已部署目标重合，标记 `pending: true`。这只用于展示，真正部署仍以 `find_conflicts` 的预检为准。
5. 首次部署且 `autoBackup` 开启 → 备份。
6. 逐文件创建链接；记录实际 `LinkType`。
7. 写状态；如果状态写失败 → 删除本次创建的链接、恢复内存中的旧状态、重写 modlist。

### `loadorder.rs`

- 只把已部署的 `.archive` 作为排序单元。
- `state.load_order` 保存相对路径；`normalized_order` 去重、保留用户顺序、把新部署的 archive 按 ASCII 追加。
- `write_modlist` 输出到 **`<game>/archive/pc/mod/modlist.txt`**，首行写 `# Managed by CyberDeck Launcher`；识别用 `is_managed_modlist()`——**当前标记与更名前的 `# Managed by NightCity Loader` 都认**（品牌改名不能把老用户的文件判成 unmanaged；写入永远用新标记，下次写入自然升级），不匹配才返回 `MODLIST_UNMANAGED`。
- 存在同名 archive 时拒绝写，因为原生文件只认文件名，无法表达两个同名文件。
- REDmod 只读，按文件夹名排序；不重命名用户文件夹。

### `game.rs`

- 检测顺序：已保存路径 → Steam 注册表 + `libraryfolders.vdf` → GOG 注册表 → Epic manifest → 常见路径。
- 版本读取：`GetFileVersionInfoW` + `VerQueryValueW`，直接读 `VS_FIXEDFILEINFO` 的两个版本 DWORD。
- 跨卷：`GetVolumePathNameW` + `GetVolumeInformationW` 取卷序列号。
- 文件身份：`CreateFileW` + `GetFileInformationByHandle`，用于卸载时校验硬链接。
- 启动（0.8.0-r3 重写，计划【2】「绕过官方启动器」）：
  - **平台判定** `platform_of(root, source)`：先信探测来源（`steam:*` / `gog` / `epic`），
    来源是 `manual`（已绑定目录的常态）时按路径特征兜底——路径含 `steamapps` → Steam、
    根目录有 `goggame-*.info` → GOG、有 `.egstore` → Epic，否则 Manual。
    没有这层兜底就判断不出 DRM 前提（`validate_game_dir` 只校验 exe 存在）。
  - **直启前提** `inspect_launch(game) -> LaunchCheck`：Steam 版要求 `steam.exe` 在运行
    （Steamworks DRM）、Epic 版要求 `EpicGamesLauncher.exe` 在运行，GOG 版无 DRM。
    进程探测用 `tasklist /FI "IMAGENAME eq <x>" /NH /FO CSV`（只读、不注入、不枚举句柄）；
    取不到结果按「没在运行」处理，偏保守。
  - **路由决策** `plan_launch(check, method)`（纯函数，可单测）：
    - `auto`：前提满足 → 直启；Steam 版且装了 Steam → `steam -applaunch`
      （会自动拉起客户端，DRM 才过得去）；Epic 版客户端没开 → 直接报错说清楚原因；
    - `direct`：只直启，前提不满足就报 `LAUNCH_CLIENT_REQUIRED`，**不偷偷改道**；
    - `steam`：强制 `steam.exe -applaunch 1091500`（附 `--launcher-skip`，不弹启动器）。
  - **直启** = `bin\x64\Cyberpunk2077.exe`（REDmod 时带 `-modded`，自定义参数逐参追加），
    启动后观察 2 秒（`DIRECT_PROBE_MS`）：进程还在 = 成功，提前退出 = 失败。
  - **自动回退** `fallback_routes`：Steam 平台先试 `steam -applaunch`，再试
    `REDprelauncher.exe`；其他平台只试官方启动器；都没有就报「请从平台客户端手动启动」。
    回退成功时 `LaunchResult.fallbackFrom = "direct"`，前端用 warn toast 告知，不算失败。
  - **不双开**：启动前若 `Cyberpunk2077.exe` 已在运行，直接返回 `method=already-running`。
  - **顺序硬约束**：版本校验与「游戏更新熔断」在 `lib.rs::launch_game` 命令里**先于**任何
    spawn 执行（熔断激活时返回 `GAME_UPDATE_LOCKED`）；进程探测与 spawn 全部在状态锁外完成。

### `backup.rs`

- 首次部署或手动创建时复制：
  - `archive/pc/mod/modlist.txt`（若存在）
  - `mods/modlist.txt`（若存在，兼容某些整合包）
  - `r6/config` 整目录
- 备份清单写入 `manifest.json`；`restore_backup` 只还原清单中的文件，不删除清单外的文件。
- 恢复原状 = 先逐个 `undeploy`，再还原备份，最后清空 load order；暂存区不删除。

### `nexus.rs`

- 只使用 Nexus 官方 v1 API，不抓取网页。
- API Key 由 `secret.rs` 用 DPAPI 加密，保存在 `<data>/secrets/nexus-api.key`。
- browse 只读列表；detail 读模组与文件；download 先取 `download_link`，只有 Premium Key 会返回地址。
- 下载先用 `.part` 写入 `<data>/downloads/`，成功后重命名，再走 `installer::install_archive`。
- 下载进度通过 Tauri 事件 `nexus-download-progress` 推给前端；命令在 `spawn_blocking` 中执行，不阻塞 WebView。
- 传入的 `NexusRef` 记录来源，卸载仍只信 `deployed_files`。

### `nxm.rs`（0.8.0-r4 NXM 协议接管）

- **抢的是协议处理器，不是进程**：N 网「Mod manager download」最终会 `ShellExecute` 一个
  `nxm://cyberpunk2077/mods/<id>/files/<id>?...`。Windows 按 `HKCU\Software\Classes\nxm`
  找处理器，谁后写谁生效——所以拦不到 Vortex 的进程，只能接管这个键。
- **只写 HKCU**：不需要提权；卸载/交还也只动自己那棵子树。
- **先备份再接管**：别人的命令行原样存进 `<data>/nxm-handler.json`，交还时精确写回；
  没有备份（我们第一个注册的）就删掉自己创建的子树，且在删之前确认命令仍指向本 exe，
  否则报 `NXM_NOT_OURS` 拒绝动手。
- **链接解析**（`parse_link`）只做结构与范围校验：domain 必须是 `cyberpunk2077`，
  mod/file id 必须是正整数，`key/expires/user_id` 走 `%xx` 解码后**只存不用**
  （本启动器用自己的 API Key 取直链，链接里的签名参数仅供排查）。
- **收件箱而不是只发事件**：协议直接拉起进程时，链接在 `setup` 阶段就有了，
  而 webview 监听器要等页面挂载完——只发事件必丢。`NxmInbox` 存一份，
  前端启动后 `nxm_pending` 补拉，之后靠 `nxm-link` 增量；处理完 `nxm_dismiss` 清掉。
- **单实例转交**：已在运行时，第二进程的 argv 由 `single-instance` 回调交给
  `intake_nxm`，先入队再唤窗（顺序反了会看到窗口闪一下才出现接收条）。
- **下载走现有链路**：接收条点「下载并导入」= `nexus_download`，即 API 取直链 →
  `.part` 落 `<data>/downloads` → `install_archive`。免费账号没有直链，只能「打开页面」。
- **可核对痕迹**：收到链接写 `startup.log` 的 `stage=nxm links=N mod=… file=…`
  （不写 key），真机验收"协议是否真的拉起了启动器"就看这一行。
- **状态两个布尔别混用**：`ours` = 命令指向本 exe；`registered` = 协议本身可用（键在且有命令）。
  Vortex 占着时是 `registered=true, ours=false, owner=other`——按 `ours` 判断归属，按 `registered` 判断"双击 nxm 链接有没有程序接"。

### `selfcheck.rs`（0.8.0-r4 无窗口自检）

- `CyberDeck Launcher.exe --self-check <out.json>`：不建窗口，输出提权状态、数据目录与可写性、
  状态文件能否加载（模组/播放集数量）、DPAPI 密钥**是否可解密**（绝不输出内容）、
  游戏目录、nxm 协议归属，然后退出。
- 存在的意义：提权回归里"数据目录会不会换成另一份"和"DPAPI 能不能读回"以前只能人眼看界面，
  现在普通权限跑一次、`Start-Process -Verb RunAs` 再跑一次，diff 两份 JSON 就出结论。
- **不复用 `Store` 的写路径**：自检只读状态，避免"为了检查而改了用户数据"。
- 同一入口还挂了 `--nxm-takeover` / `--nxm-release`：把界面上的两个按钮变成可脚本调用的命令，
  输出 JSON 后直接退出。出问题时用户往往连界面都点不到（比如启动器正被另一实例占着），
  给一条命令行就能把协议改回来。

### `ai.rs`

- 兼容任何标准 OpenAI `/chat/completions` 端点：OpenAI、DeepSeek、Moonshot、通义千问、本地 Ollama。接口地址与模型名在设置中可配，设置页/诊断面板提供「一键填入预设」。
- 界面口径统一到协议层：卡片徽标写「OPENAI 兼容」而不是某家模型名；预设下拉框会用「已保存的地址 + 模型名」反查预设，不会永远停在「手动配置…」；`keyUrl` 只在能确定服务商时出现，绝不硬编码某一家控制台。
- 预设顺序有含义：`AI_PRESETS[0]` 是 OpenAI（协议参考实现），也是「没命中预设」时给用户的默认说法。
- 模型名会过时，前端硬编码的预置只是兜底：`ai_list_models` 命令请求标准 `GET {base_url}/models`，返回实时模型 ID 清单（排序去重、上限 500、解析兼容 OpenAI `data[]` / 裸数组 / `models[]` 三种形态），用户点选填入，永不过时。Key 仍从 DPAPI 读取，不经过前端；无 Key（本地服务）时匿名请求。
- 前端对已确认弃用的模型名（各服务商不一，如 deepseek-chat、moonshot-v1-*、kimi-k2、gpt-4o）显示迁移提示。
- Key 由 DPAPI 保存在 `<data>/secrets/ai-api.key`（服务商无关命名，与具体接入哪家无关）；0.7.0 时期的 `deepseek-api.key` 是历史文件名，首次读取时自动迁移，旧文件保留作回退。
- 只有用户逐次勾选同意才发起请求。
- 构造紧凑 JSON：游戏信息、框架、问题、模组、冲突（含 `pending`）、加载顺序、可选日志尾部。
- 发送前用精确路径替换 + 正则兜底，清掉绝对路径和邮箱。
- 请求目标 `{base_url}/chat/completions`（自动补全路径），`Authorization: Bearer {key}`；解析前剥离 ```json 围栏并尝试截取首尾括号，兼容不支持严格 JSON 输出的小模型；解析失败返回结构化错误，不把半截文本当结论。
- 冲突中心只传固定意图 `focus="conflicts"`；日志查看器只传固定意图 `focus="logs"`。后端白名单映射为提示词，任意用户文本不会注入。
- `focus="logs"` 时，后端只保留每条错误前后 5 行，再脱敏、截断，不发送完整日志。
- 返回 `contextPreview`，前端可以显示实际发送的脱敏内容。

### `wolvenkit.rs`（0.7.1 资源级深度扫描）

- 文件级冲突之外，用 WolvenKit.Cli 的 `unbundle` 把同名 `.archive` 解包到系统临时目录，遍历目录树收集内部资源路径（.mesh/.xbm/.ent 等白名单扩展名），前端求交集展示「两个 Mod 同时修改了资源：…」。
- WolvenKit CLI 没有「只列清单」命令，解包是唯一途径；临时目录扫描完立即删除，`kill_on_drop` 保证超时后不留孤儿进程。
- 单 archive 超时可配（`wolvenkit_timeout_secs`，默认 60 秒，钳制 10–600），超时/CLI 报错/archive 缺失都以结构化错误逐项返回，不影响其他 archive 的结果。
- CLI 路径 `wolvenkit_cli_path` 由用户在设置中指定，`set_settings` 校验文件存在；**留空时自动检测**（`%USERPROFILE%\.dotnet\tools\WolvenKit.Cli.exe` → PATH 上的 `where WolvenKit.Cli.exe`），检测只是找文件、失败立即报错，不存在误跑导致的超时等待。
- 路径解析（冲突引用 → 真实文件）在 Rust 完成（`resolve_archive_ref`，内部 `safe_join`）：优先暂存区副本，回退游戏目录；前端不做任何路径运算。

### `modsettings.rs`

- 只访问 `<game>/bin/x64/plugins/cyber_engine_tweaks/mods/ModSettings/user.ini`，前端不传任意路径。
- 用 `rust-ini`（开启 `inline-comment`）读取，按值推断 `bool / number / string`；注释不进入值。
- 写入是行级替换：只改目标 key 的值，保留注释、缩进、顺序和其他 section。
- 写前把当前文件复制为 `user.ini.bak`，再写临时文件并用 `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` 替换。
- 恢复 `.bak` 前先把当前文件另存为 `user.ini.before-restore.bak`，恢复本身可撤回。
- 拒绝符号链接、游戏目录外路径、换行注入和超大文件。

### `logs.rs`

- 只扫描 `r6/logs`、`red4ext/logs`、CET `logs` / 插件目录。
- 读取前校验 canonical path 在游戏根目录内、扩展名 `.log/.txt`、非符号链接、≤32 MB。
- 只读末尾 256 KB；超过 `tailLimit` 时截断，并标记 `truncated`。
- 不解析日志语义，只用固定关键词把行分成 error / warn / info / muted。
- 前端「提取错误」复用同一份行数据，按 error 行前后 5 行分组；AI 的 `focus="logs"` 在后端做同样的裁剪，保证发送内容与界面展示一致。

### `collection.rs`

Nexus Collections（`collection.json` 清单）支持。CP2077 的整合包生态用清单描述
「要哪些 Mod + 它们之间的加载顺序」，Mod 本体仍走各自的下载/导入流程。

- 只读解析，不下载、不安装：清单只提供元数据，Mod 由用户自行获取后导入。
- 清单上限 8 MB；`info.domainName` 必须是 `cyberpunk2077`，否则报 `WRONG_GAME`。
- 同时接受两种形状：上游标准写法（`mods[].source.{modId,fileId,md5}` 嵌套、
  规则在顶层 `modRules[]` 且每条带 `source`+`reference` 两端）与社区简化写法
  （扁平字段、规则挂在单个 Mod 的 `rules[]` 下）。非关键字段一律带默认值。
- 与本地库匹配：先按 `nexus.mod_id`，再按 `nexus.file_id`，都不中算缺失。
  **`file_md5` 不参与匹配**——本地库不存 MD5，拿它匹配只会造成
  「明明装了却显示缺失」的假象。
- 加载顺序来自 `modRules` 的稳定拓扑排序（Kahn + 按原始下标出队，
  无约束的 Mod 之间保持清单原始先后）。有环时不 panic：退回原始顺序并说明。
- **部署顺序的权威来源是 `CollectionPlanItem.order`**（拓扑位次），
  `deployOrder`（modId 列表）仅供参考。
- 部署复用 `installer::deploy_mod` 与 `loadorder::write_modlist`，
  不另写一套部署逻辑；单个 Mod 失败不中断整批。

### `secret.rs`

- Windows DPAPI `CryptProtectData` / `CryptUnprotectData`，当前用户范围。
- 先写 `.tmp` 再替换；读取失败给出“重新填写 Key”的可操作错误。
- 不把密钥写进 `launcher-state.json`、日志或 AI prompt。

### `diagnostics.rs`

纯本地规则，不联网：

- 游戏 exe / 写权限
- 游戏版本与上次启动版本比较
- 框架文件存在性
- 已启用模组与框架的依赖关系（REDmod→RED4ext、CET→CET、redscript→redscript）
- 已部署目标冲突 + 暂存模组的待启用冲突
- CET / redscript 安装后的运行时提示（CET 热键、编译日志）
- 未受管 archive / modlist
- 备份状态、语言、日志入口

## IPC 命令

| 命令 | 作用 |
|---|---|
| `bootstrap` / `refresh_game` | 返回完整快照（状态、游戏、加载顺序、冲突） |
| `detect_game_path` | 自动检测 Steam/GOG/Epic/常见路径 |
| `set_game_dir` / `clear_game_dir` | 切换/清除游戏目录（部署中禁止） |
| `install_mods` | 批量导入 ZIP/7z/RAR，逐项返回成功/错误 |
| `set_mod_enabled` | 部署/撤除，返回链接类型统计与警告 |
| `uninstall_mod` | 先撤链接，再删暂存 |
| `update_mod` | 改名称/分类 |
| `get_load_order` / `save_load_order` | 读取/保存 archive 顺序 |
| `export_modlist` / `remove_modlist` / `set_write_modlist` | 原生 modlist 接管与移除 |
| `nxm_status` | 只读：`nxm://` 当前归属（us/other/none）、实际命令行、备份的原处理器 |
| `nxm_takeover` / `nxm_release` | 接管/交还 `nxm://`（先备份别人的命令；无备份时只删自己建的子树） |
| `nxm_pending` / `nxm_dismiss` | 拉取/清空「已收到但前端还没处理」的链接收件箱 |
| `parse_collection_manifest` | 解析 Nexus Collection 清单，与本地库比对后给出安装计划（只读，不下载） |
| `apply_collection_order` | 按清单顺序重写 modlist.txt 并部署（返回整批聚合结果） |
| `nexus_status` / `nexus_set_key` / `nexus_clear_key` | Nexus 账号状态与 DPAPI 密钥 |
| `nexus_browse` / `nexus_detail` | 官方 API 列表与文件详情 |
| `nexus_download` | 下载并导入（Premium）；事件推送进度 |
| `nexus_prune_downloads` | 清理旧的下载缓存 |
| `nexus_check_updates` | 0.7.1：批量比对库内 Nexus 模组版本（每模组 1 请求 + 250ms 节流 + 上限 40），只发现不自动安装 |
| `nexus_refresh_covers` | 批量补全 Nexus 官方封面 |
| `ai_status` / `ai_set_key` / `ai_clear_key` | 智能诊断配置与 DPAPI 密钥（Key 文件 `ai-api.key`，兼容旧 `deepseek-api.key` 自动迁移） |
| `ai_diagnose` | 脱敏摘要 → 标准 OpenAI 接口 → 结构化建议 |
| `scan_archive_deep` | WolvenKit CLI 资源级深度扫描（异步 + 可配超时，逐项返回成败） |
| `ai_list_models` | 联网拉取服务商 `GET /v1/models` 实时模型 ID 清单 |
| `resolve_deep_scan_paths` | 把冲突引用（modId + target）解析成真实 archive 路径（safe_join，暂存优先） |
| `get_mod_settings` / `save_mod_setting` / `restore_mod_settings` | CET `user.ini` 读取、行级写入与 `.bak` 恢复 |
| `list_logs` / `read_log_tail` | 日志列表与末尾读取（只读） |
| `open_url` | 只允许 http/https 的外部链接 |
| `get_diagnostics` | 本地诊断报告 |
| `create_backup` / `restore_original` | 备份 / 恢复 |
| `inspect_launch` | 只读探测启动前提：平台、DRM 客户端是否在运行、`REDprelauncher.exe` 是否存在、能否直启（设置页状态卡用） |
| `launch_game` | 直启 / Steam / 官方启动器三路由；直启 2 秒探测 + 失败自动回退；已在运行则不双开；熔断激活时先拒；REDmod 自动带 `-modded`；0.7.1 起附加用户自定义参数（`settings.launch_args`，`parse_launch_args` 白名单校验后逐参传递，不经 shell） |
| `open_path` / `open_logs_folder` / `reveal_mod` | 打开目录 |
| `set_settings` | 启动方式、自动备份、卸载确认、启动参数（0.7.1）、WolvenKit CLI 路径与超时（0.7.1）、AI 接口地址与模型名 |

## 0.7.1 附加层（2026-10）

- **侧栏徽标**：加载顺序/诊断=冲突数，发现=Nexus 未连接，设置=游戏目录未链接。
- **活动流**：`ActivityItem`（`lib/tasks.ts`），部署/撤除/卸载/切换播放集/导入/收编/备份/恢复完成后落一条，任务中心与顶栏铃铛共用。
- **滚动锚点**：虚拟网格按 `分类:排序` 记忆滚动位置。
- **bundle 拆分**：Nexus/诊断/设置/ModSettings 四视图懒加载；样式层拆为 `styles/tokens.css`（全部 `:root` 变量）+ `styles.css`（组件），入口 `styles/index.css`。
- **mock 漂移防护**：`ApiSurface = typeof api`，`mock.ts` 编译期断言逐方法对齐真实 API。

## 安全不变量

1. **卸载只信 `deployed_files`**，从不“按文件夹递归删除”。
2. **任何目标路径必须先过 `safe_join` + `is_within`**。
3. **符号链接永不跟随删除**；硬链接删除前校验文件身份。
4. **非启动器写出的 `modlist.txt` 永不静默覆盖**。
5. **未受管目标文件永不默认覆盖**。
6. **ZIP 条目拒绝 `..`、绝对路径、符号链接**。
7. **状态保存失败必须回滚文件操作**，避免“清单没了但文件还在”。
8. **user.ini 编辑只落在一个白名单路径**，写前 `.bak`，不跟随符号链接。
9. **日志只读且限制在游戏目录的已知日志目录内**，不提供任意文件读取。
10. **`deserialize_with` 的自定义反序列化器必须消费掉输入值**（用
    `IgnoredAny::deserialize(deserializer)?`）。否则 serde 解析位置错位 →
    整个状态文件解析失败 → `store.rs` 判为损坏 → 静默重置为空，
    **用户数据被清空而界面毫无提示**。空数组形态（`"modpacks": []`）同样会触发，
    而空数组恰是启动器每次落盘都会写出的形态。

## 0.7.0 硬件界面层

- `ModCard` 的显示状态由 `enabled` 与 `conflicts` 推导：冲突 > 已部署 > 暂存；没有额外的 UI 状态副本。
- 悬停操作区只是可见性变化，按钮仍走 `set_mod_enabled`；键盘聚焦时同样显示。
- `TaskCenter` 的任务队列是前端串行队列：每个文件调用一次 `install_mods`，从而能逐项显示状态；真正的解压/链接仍在 Rust 中完成。失败任务保留错误，可单独重试。
- `CommandPalette` 只触发已有动作（导航、导入、启动、冲突、日志、写 modlist），不新增绕过安全检查的快捷路径。
- `DangerConfirmModal` 采用 pointer capture + `requestAnimationFrame` 计算按住时长；松开、失焦、指针离开都会取消，键盘 Space/Enter 同样需要持续按住。
- 前置检查是保守推断，不是完整依赖图：CET Lua → CET、`.reds` → redscript、`.xl/.xlp` → ArchiveXL；框架模组自身不提示自依赖。

### 主题、字体与缩放

- `lib/preferences.ts` 是唯一偏好入口：主题、强调色、缩放和侧栏折叠都从这里读取/写入 `localStorage`；`index.html` 在首帧前恢复主题，避免默认黄黑闪一下。
- 颜色 token 分为语义层（`--bg`、`--panel`、`--line`、`--text`、`--muted`）和强调层（`--accent`、`--accent-rgb`、`--accent-soft`、`--accent-ink`）。所有强调色透明度都使用 `rgba(var(--accent-rgb), α)`，切主题时不会残留黄色。
- 自定义强调色由 JS 计算 WCAG 相对亮度，决定按钮文字用黑还是白；`--accent-ink` 与 `--accent-ink-rgb` 会同步覆盖。
- 字体资产通过 `@fontsource`（Inter / JetBrains Mono / Rajdhani 的 latin 子集）进入 Vite 产物，离线可用；中文回退到微软雅黑。
- 缩放使用 `body { zoom: var(--ui-scale) }`，并让 body 保持 100% 宽高；这样 90/100/110 在 WebView2 125% DPI 下仍由视口决定，不会出现底部空白或横向溢出。
- 主题切换只改 DOM 属性和 CSS 变量，不重建 React 树；模组部署状态、任务队列和打开中的抽屉不会因为换肤丢失。
- `prefers-reduced-motion` 会压缩动画；Mono 主题额外关闭扫描线、网格和悬浮阴影。

### 硬件切角、噪点与警告带

- 切角全部由 CSS `clip-path: polygon(...)` 完成，不引入图形库，也不改组件树：面板 16px、Mod 卡 12px、主题卡 9px、次级卡片 8px，均为左上 + 右下切角。
- 切角处的“电路走线”是面板/卡片背景里的 45° 细渐变；主题卡选中时由 `::before/::after` 单独亮起，避免用边框去伪造斜线。
- 选中主题的 `filter: drop-shadow(...)` 才是外发光：`clip-path` 会裁掉普通 `box-shadow`，这一点不能混用。
- 全局噪点来自 `public/noise.svg` 的 `feTurbulence` 纹理，`body::before` 以 4.5% 透明度叠加；网格仍由 `.app-shell::after` 提供，Mono 下两者都关闭。
- 未链接游戏目录的警告带是语义化的 `role="status"`：红黑斜纹、纯黑文字、实心警示块；设置页对应 `.game-dir-box.is-unlinked` 使用虚线边框与扫描光，上传动作仍只走既有的目录选择/自动检测。
- 切角只影响绘制，不改变 DOM 尺寸、虚拟滚动行高或点击区域；组件测试按 `clip-path`、伪元素透明度和警告带计算样式断言。


## 第 4 阶段：已实现的可选能力

- `ai_diagnose` 把结构化诊断 + 可选日志尾部交给已配置的 AI 服务（任何兼容 OpenAI 协议的端点），返回「一个最可能的问题 + 最多三条修复步骤」。
- 默认关闭，逐次同意；只发送脱敏 JSON，不发送整份日志或任何模组文件。
- Key 由 DPAPI 保存；接口地址与模型名可配置，出厂默认 `https://api.openai.com/v1` + `gpt-5.4-nano`（协议参考实现，选一次预设即可换掉）。
- 结果包含 `contextPreview`，用户能看到实际发送了什么。

## 状态文件与序列化（改 schema 前必读）

状态文件是 `data_dir/launcher-state.json`，**用户数据的唯一索引**。几条硬规矩：

- **自定义 `deserialize_with` 必须消费掉输入值**：

  ```rust
  // 正确：IgnoredAny 跳过任意形状，但确实把输入读掉了
  let _ = <serde::de::IgnoredAny as serde::Deserialize>::deserialize(deserializer)?;
  Ok(Vec::new())
  ```

  不消费 → serde 解析位置错位 → **整个状态文件解析失败** → `store.rs` 判为损坏 →
  重命名为 `broken-*.json` 并**静默重置为空**。
  ⚠️ **空数组形态（`"modpacks": []`）同样会触发**，而空数组正是启动器每次落盘都会写出的形态——
  等于**每次启动都清空一次用户的模组库**（2026-10-26 实测事故，见
  `docs/PROJECT_HISTORY.md#incident-state-parse`）。
- **改 schema 必须用真实旧数据跑一次解析**：`cargo test` 全绿 ≠ 旧数据能读。
  单元测试的构造样本常常是 `"mods": []` 这种**恰好掩盖问题**的形状。
- **写这类测试必须断言三件事**：整个状态文件仍能解析；其它字段原样保留；
  **不产生 `broken-*.json`**。只断言"目标字段为空"是假阳性——"空结果"与
  "整个文件坏掉后重置成空"在断言上无法区分。
- **数据目录与状态文件里的路径是绑定的**：目录搬迁（如品牌改名）必须同步改写状态文件里的
  `stagingPath` / `deployedFiles[].source`，否则卸载与重部署会指向不存在的路径。
- **持久化的格式值（枚举取值、临时文件前缀、localStorage 键名）属于兼容锚点**：
  改它们必须配套迁移，不能顺手改。


## 窗口与进程生命周期

- **单实例**：`tauri-plugin-single-instance` 必须是 builder 链上**第一个** `.plugin()`。
  第二个进程不初始化任何东西，只把已有主窗口 `show + unminimize + set_focus`。
- **托盘**：`TrayIconBuilder` 用 `app.default_window_icon()`，避免打包后资源路径失效；
  左键切换显隐（最小化先恢复），右键两项菜单（显示主界面 / 彻底退出）。
- **关闭语义**：`CloseRequested` 里先 `api.prevent_close()`（必须同步），再按
  `settings.close_behavior` 决定隐藏或退出。真正退出只有两个入口：托盘「彻底退出」、
  以及偏好为 `exit` 时的关闭按钮。
- **退出前的任务拦截**：`BusyTasks` + `BusyGuard`（RAII）登记长任务，`request_exit()`
  仅在无任务时直接退出；有任务则弹原生确认框。**新增长任务命令时必须挂 guard**，
  否则"退出可能导致 Mod 文件损坏"的保护会漏掉它。
- **诊断**：所有生命周期决策写 `startup.log`（`stage=close/exit …`），
  用户报"点关闭后程序不见了"时先看这几行。
- **协议拉起**：进程可能由 `nxm://` 拉起（argv 带链接）。链接先入 `NxmInbox` 再建窗口；
  已在运行时由单实例回调转交，同样先入队再唤窗。


## 界面浮层与层级契约

- 层级只在 `styles.css` 顶部的 `:root` 变量里定义：`--z-drawer / --z-floating / --z-modal / --z-command`。
  **不要再在组件里写裸 z-index。**
- 右下角的常驻提示（toast）与任务面板**必须**放在 `.floating-stack` 里，由容器负责垂直排列；
  它们自己不再 `position: fixed`。新增同类浮层也放进这个栈，避免又回到"各自定位、互相遮挡"。
- 抽屉打开时 `app-shell` 带 `has-drawer`，浮层栈自动让位；新增全屏级浮层请放进 `--z-modal` 之上。


## 文案与 i18n 接缝

- **界面上的任何文本都不写在组件里**，一律 `import { t } from "../i18n"` 后 `t("命名空间.key")`。
  唯一文案来源是 `src/i18n/zh-CN.ts`（1246 条，已全量收敛）；`MessageKey` 是字面量联合，key 拼错 `tsc` 直接报错。
- 属性文案（`title` / `placeholder` / `aria-label`）与模块级常量（`NAV`、`SETTINGS_TABS`）同样适用。
- 开发者日志（`console.error`）不进词表，行内标 `// i18n-ignore`；守卫脚本靠这个标记豁免（整张数据表用 `i18n-ignore-start/end` 区块豁免，如命令面板的检索关键词）。
- **数据值型中文不进词表**：分类 `"框架"`、布局 id 等既是持久化数据又是显示文本，留在 `types.ts` / `lib/*`，渲染层经 `categoryLabel()` / `LAYOUT_LABEL_KEY` / `*Key` 字段映射——改分类体系时两处要同步。
- 当前**不提供语言切换**，`t` 只是查表 + `{name}` 插值。接真库时只改 `src/i18n/index.ts`。
- 规则、命名空间约定、并行合并流程：`docs/I18N.md`。守卫：`npm run i18n:gate`（硬编码归零门禁）、`npm run i18n:unused`（死条目检查）。

## 仍然刻意不做

- 不自动合并冲突文件；冲突中心只提供“禁用一方后重试”、查看模组和打开加载顺序。
- 不做游戏内 overlay / 进程注入；这需要 CET 运行时，且无法在没有游戏的环境里可靠验证。
- 不绕过 Nexus Premium 下载限制，不抓取 Nexus 网页。
