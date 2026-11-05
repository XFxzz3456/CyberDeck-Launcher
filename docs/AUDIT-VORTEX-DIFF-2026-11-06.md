# CyberDeck 与官方 Vortex 扩展架构差异审计报告

> 审计对象：`Nexus-Mods/game-cyberpunk2077`（GPL-3.0，main @ 2026-11-04，28 个安装器） vs `CyberDeck Launcher` 当前仓库
> 审计方式：**纯静态源码比对**，未运行、未改任何文件、未触碰真实游戏目录。所有结论均带两侧行号。
> 日期：2026-11-06

## 0. 基线与范围声明

- 官方侧：`cyberpunk2077_ext_redux` 即 `Nexus-Mods/game-cyberpunk2077`。它**只负责安装指令生成、加载顺序、工具钩子**；解压、链接、部署清单、冲突裁决全部由 Vortex 核心负责。因此「官方更好」的地方，很多其实是「Vortex 核心帮它做了」，我们是在**自己实现一个核心**，比对时必须分清这一点。
- 我们侧：按仓库当前真实状态审计。**汉化与参数设置重构上一轮只到调研与方案，代码未改**，本报告不假设那两处已重构。
- 五个维度：安装/解压、部署映射、加载顺序+REDmod 缓存、依赖/冲突/前置框架、Vortex 环境接管与链接安全。

## 1. 安装与解压

| 检查项 | 我们 | 官方 | 判定 |
|---|---|---|---|
| 深层嵌套剥壳 | `refine_payload_root` 打分（`installer.rs:504-541`）：`info.json +5`、`init.lua +2`、`.archive/.xl/.xlp/.reds/.lua +1`、已知根目录 `+3`，`max_depth(6)`，取最高分 | giftwrap 只剥**一层**，且要求「顶层恰好 1 个目录 + 其子目录名 ∈ KNOWN_TOPLEVEL_DIRS」（`installers.ts:428-480`） | **我们强**：`a/b/c/mod/archive/...` 我们能正确剥到 `mod/`，官方不剥，靠游戏递归扫 `archive/pc/` 碰巧生效 |
| 多根并列 | 同分候选 >1 → **直接 `LAYOUT_AMBIGUOUS` 拒装**（`installer.rs:554-572`） | 从不因并列拒绝，并列 = 不剥壳，继续走安装器 | **我们弱**：`Mod/a.archive` + `Mod/optional/b.archive` 这种「主体+可选件」合法包被误杀，用户只能自己重打包。测试 `installer_tests.rs:417-430` 把这个行为固化成了「期望」 |
| 选定根之外的兄弟目录 | **静默丢弃**：`layout_skipped` 只遍历 payload（`installer.rs:1240-1294`），payload 外的文件既不部署也不统计 | 走 `extraFilesAllowedInOtherModTypesInstructions` 移入 `<扩展目录>\mod-extra-files\<mod名>\` 并弹通知（`installer.special.extrafiles.ts:55-64`） | **我们弱**：`A/archive/x.archive` + `B/docs/y.txt` → B 整个消失，**零警告** |
| FOMOD | **零支持**（全仓 `fomod`/`ModuleConfig` 0 命中）。后果：多选项包 → `LAYOUT_AMBIGUOUS`；单选项包 → 只装其中一个变体 | 交给 Vortex 核心（`PRIORITY_FOR_PIPELINE_INSTALLER = 30; // Fomod is 20`，`installers.ts:178`），扩展不介入 | **我们缺功能**，且从不提示「这是 FOMOD」 |
| 多框架混合包 | `detect_layout` 返回**单个**枚举并 `return`（`installer.rs:934-1022`），`plan_for` 单分支（`:1160-1203`），其余类型 `continue` | `installer.multitype.ts`：10 个探测器命中 >1 即进 MultiType，各 layout 结果**拼接成一份 instructions**（`:173-233`） | **我们弱**，但有两处反例见 §1.1 |
| 压缩包安全 | 应用层自建：`MAX_ENTRIES=30000`、`MAX_UNCOMPRESSED=8GiB`、zip 解压前按 header **预扫**、`enclosed_name()` 拒 `..`、拒 unix symlink、拒 7z 重解析点（`installer.rs:138-218`、`:251-279`） | 扩展侧完全不碰压缩包字节（`wrapTestSupported` 入参已是相对路径数组，`installers.ts:543`） | **我们强**（这是核心级能力），但 rar 分支是「先全量解压后校验」（`:382` → `:478-484`），压缩炸弹可先打满磁盘 |
| 外部依赖 | `.rar` 依赖本机 7-Zip / WinRAR（`installer.rs:326-437`，找不到即 `RAR_TOOL_MISSING`）；`.zip/.7z` 纯 Rust 内置 | 无（Vortex 自带解压链） | **我们弱**：全新 Win11 上 rar 100% 不可用；且 `installer_tests.rs:364-368` 无 WinRAR 时静默 skip，CI 测不到 |
| 文件名编码 | 无任何 GBK 转码（`zip` 依赖未开编码 feature，`installer.rs:167/201` 走 `to_string_lossy`）→ 中文名包解出乱码名、不报错 | 不涉及（核心负责） | **我们弱**（可读性问题） |

### 1.1 值得记下的反向结论（我们更强的地方）

- `bin/x64/plugins/z.asi` + `red4ext/plugins/P/P.dll`：我们判 GameRoot，两条都保留；官方 ASI 安装器先命中，发现「指令数 ≠ 文件数」直接 `reject("Too many files in ASI Mod!")`（`installer.asi.ts:107-114`），**整包装不上**。
- `archive/pc/mod/x.archive` + `r6/scripts/y.reds`：我们走 GameRoot，两个首段都在 `RECOGNIZED_ROOTS`，两个都装；官方走 MultiType，等价。

### 1.2 混合包的真实丢文件组合（可复现）

| 输入 | 结果 |
|---|---|
| `r6/tweaks/t.yaml` + 根级 `x.archive` | 判 Archive → `t.yaml` 被丢（有 warning） |
| `x.archive` + `dinput8.dll` | 判 Archive → dll 被丢 |
| `bin/x64/plugins/z.asi` + `x.archive` | 判 Archive → asi 被丢 |
| `archive/pc/mod/a.archive` + `tools/foo.txt` | 判 GameRoot → foo.txt 被丢 |

## 2. 部署与路径映射

我们 7 种布局的目标模板 vs 官方对应安装器：

| 布局 | 我们的落位 | 官方 | 判定 |
|---|---|---|---|
| GameRoot | 原样保留，但首段 ∉ `[archive,bin,r6,red4ext,engine,mods]` 就**跳过**（`installer.rs:1161-1167`） | 无通用 GameRoot 装器，各类型各自同源同目标 | 大体一致；我们用白名单丢弃，官方用 `mod-extra-files` 收纳 |
| Archive | **拍平**成 `archive/pc/mod/{filename}`（`:1168-1177`） | heritage `archive/pc/patch/**` → 重写为 `archive/pc/mod/**`；其它目录 → `archive/pc/mod/<子路径>` 保子路径（`installer.archive.ts:246-311`） | **不一致，P1**：我们丢子路径 → 同名静默覆盖；`archive/pc/ep1/foo.archive` 会被我们搬进 `archive/pc/mod/`，官方不跨目录搬 |
| Redmod | `mods/{folder}/{relative}`，`folder = sanitize_folder(zip 名)` | canon 原样；named/toplevel → `mods/<modInfo.name>/…` | 一致 |
| Cet | `…/cyber_engine_tweaks/mods/{folder}/{relative}`（自造目录层，`:1179-1181`） | 只认 canonical 并**同路径，绝不改名**（`installer.cet.ts:77-93`） | **不一致，P2**：硬编码自身目录名 / 相对路径的 CET mod 改名后失效 |
| Redscript | `r6/scripts/{folder}/{relative}` | basedir/canon 同源，toplevel 加 `<modName>` | 一致 |
| Asi | 代理 dll → `bin/x64/`；其余 → `bin/x64/plugins/{剥壳后}` | 只认 `bin/x64/plugins/*.asi` canonical，无壳剥离、无代理 dll 落位 | **我们明显强** |
| Red4ext | `red4ext/plugins/{folder}/{stripped}` | basedir/toplevel 都留 `<modName>` 一层 | 一致 |

**额外缺陷（P2）**：Archive 拍平后 `plan_for` 不做目标去重。`Mod/x.archive` + `Mod/sub/x.archive` 会两条都映射到 `archive/pc/mod/x.archive`，部署后 `deployed_files` 出现两条同 `relative_path`，卸载时第二条走「拒绝删除」分支产生假告警。

**特殊前缀 `!` `~` `-` `zz_`**：两端都**不在落位层剥离**（实 grep 官方全仓 `'!'`/`'~'`/`zz_`/`stripPatterns` 均 0 命中），磁盘名原样保留。我们在展示层有 `modname.rs:17-20` 的清洗（含 `~ + %`），`category.rs:126-128` 的清洗口径不含 `~ + %` —— 两个清洗器不一致（P2，仅展示层）。CP2077 的 archive 顺序由 `modlist.txt` 决定，文件名前缀无功能意义，所以「都不剥」是等价且安全的。

## 3. 加载顺序与 REDmod 缓存

### 3.1 两份 modlist.txt

| | 我们 | 官方 |
|---|---|---|
| REDmod 顺序 `V2077/modlist.txt` | basename、CRLF、无尾换行、无 BOM、空列表写 0 字节、tmp+rename（`redmod.rs:281-306`） | 「redMod only reads the modlist with Windows line endings」+ `join(WINDOWS_LINE_ENDING)`（`load_order.ts:580-582`） |
| 判定 | **逐字同构，无需改动** | — |
| 散装 archive 顺序 `archive/pc/mod/modlist.txt` | **两行 `#` 注释头** + 文件名 + 末尾多一个裸 `\n`（`loadorder.rs:10/188-191/209`） | **纯文件名**，且「已是 ASCII 升序就删掉这个文件」（`load_order.archive.ts:90-95/151-155`） |
| 判定 | **P0**：这是游戏直接读的文件，写入注释头与官方格式不符；且首行同时是我们的 `is_managed` 判据，写脏后拒绝任何覆盖，**无法自愈** | — |

补充：`settings.write_modlist` 默认 `false`（`schema.rs:723`），即散装 archive 顺序默认不生效；而 REDmod 顺序默认生效。两个开关默认值不对称，官方没有这个开关概念。

### 3.2 REDmod 顺序算法

- 骨架等价：存储顺序 + 未登记项按文件夹名升序补后（我们 `redmod.rs:201-232`，官方 `load_order.ts:505-513` + `thenByDirnameAscending`）。
- 我们**多做了**大小写去重与确定性兜底（`redmod.rs:219-231`），比官方强：同名 folder 官方会让 redMod 互相覆盖。
- 我们**少做了** `conflictWinner: 'first'`（`load_order.registrations.ts:27-34`）：现在只有 i18n 一句「靠上的先赢」，冲突面板里没有体现。
- 我们**丢了**禁用 REDmod 的位置：视图只收 `enabled`（`loadorder.rs:101-103`），拖拽后前端只提交可见项（`LoadOrderView.tsx:101-109`），`normalize_order` 把缺席项按字母序丢到末尾。官方明确「disabled 也会记住位置」（`load_order.ts:201-203`）。**P2**

### 3.3 增量编译判定

逐条等价，无需改动：

| 场景 | 官方 `redmod.deploy.ts:81-89` | 我们 `redmod.rs:260-275` |
|---|---|---|
| 完全相同 | false | false |
| 集合相同、顺序不同 | **true** | **true** |
| 长度不等 | false（交给 redMod 自查） | false |
| 等长但集合不同 | false | false |
| 仅大小写不同 | true（白清一次缓存） | **false（我们更省一次几十秒重建）** |

### 3.4 缓存清理

| | 我们 | 官方 |
|---|---|---|
| 彻底性 | `remove_dir_all(r6/cache/modded)` + `create_dir_all`（`redmod.rs:309-329`） | 同样整目录删（`redmod.deploy.ts:99-104`） |
| 删不掉时 | **直接 abort，且 modlist 已经写了**（`redmod.rs:424-440`：先 `write_modlist` 再 `clear_cache?`） | `catch { log warn "Unable to remove deployed REDmod files, deploying anyway" }` —— 删不掉也照跑 |
| 后果 | 下一次「上一次==这一次」→ `needs_rebuild = false` → **再也不清**，旧编译产物永久留存 → 改了顺序/禁用了 mod 却照旧生效，只能手删 `r6/cache/modded` | 无此路径 |

另：`should_run` 短路「无启用 REDmod 且盘上 modlist 为空就跳过」（`redmod.rs:410-416`），叠加上述问题后，缓存脏而列表空的场景**永远不会被清理**。官方每次触发都会跑。

### 3.5 启动钩子（功能缺口）

官方在启动前自动部署，**部署失败则取消启动**：`tools.redmodding.ts:230-259`（`deployREDmodForCurrentLoadOrder` → `throw new UserCanceled('REDmod deployment failed, so the game wasn't started.')`）。

我们 `launch_game`（`lib.rs:3029-3071`）全程不调 `redmod::`，只算 `redmod_enabled` 决定要不要加 `-modded`；`flush_into` 的 8 个调用点没有一个在启动链路上。**P1**

### 3.6 换播放集不重新部署 REDmod（P0）

`profiles.rs:65-177` `switch_profile`：阶段 1 撤销全部部署 → 阶段 2 写状态（`enabled` / `deployed_files.clear()` / `load_order`）→ 阶段 3 重新部署 archive → 阶段 4 收拾半状态。**全程没有 `redmod::flush_into`**；`redmod_order` 也不进 `ProfileEntry`（`schema.rs:1483-1497` 只有 `enabled_mod_ids` + `load_order`）。

后果：切到播放集 B 进游戏，`r6/cache/modded` 里还是 A 的编译产物 → **界面显示 B、实机加载 A**，游戏不会报错。这是本次审计里唯一「必然错、且用户无法察觉」的问题。

### 3.7 redMod.exe 调用

- 六个参数与顺序**逐字一致**，`-root` 独立成参，`cwd = exe 所在目录`，argv 直传不走 shell，`CREATE_NO_WINDOW`。
- 差异：① `-rttiSchemaPath` / `-modlist` 用正斜杠常量 `join`，用户游戏目录带正斜杠时可能输出 `D:/Games/CP2077\tools\redmod\metadata.json` 混排（`redmod.rs:42/44/141-149`）；② stdout/stderr 拼接**丢交错顺序**（`:384-391`），导致 `failure_reason` 在「失败行在 stdout、原因在 stderr」时退化成「退出码 N」（官方保序收集，`redmod.deploy.ts:126-133`）；③ 无超时（`:377-382`）；④ 同步命令跑在主线程（`lib.rs:1045/862/930/845`），几十秒到几分钟界面僵住、无进度（`-reportProgress` 输出被吞）。

## 4. 依赖 / 冲突 / 前置框架

### 4.1 前置框架检测：不是死记硬背版本号，但也不止一处

好消息：**没有任何版本号硬编码**，全部靠定义文件/dll 特征，与官方同思路（官方 8 个核心安装器的判据就是 `red4ext/plugins/ArchiveXL/ArchiveXL.dll` 这类精确路径）。

坏消息：同一件事我们维护了 **4 份互不相干的清单**，口径还不一致。

| 位置 | 形态 | 条目 | 语义 |
|---|---|---|---|
| `compat.rs:45-74` `CORE_FRAMEWORKS` | 目录 + dll 双探针 | 4（RED4ext/ArchiveXL/TweakXL/Codeware，刻意不含 CET/redscript） | 装没装 / 装没装完（目录在但 dll 缺 → 黄灯 warn） |
| `deps.rs:117-125` `CORE_FILES` | 只认 dll 文件名 | 7 | 防「整合包自带前置」误报，**完全不看目录** |
| `game.rs:~402` `framework_statuses` | 多探针数组（CET 有三条含目录兜底） | ≥4 | 诊断页展示 |
| `config_resolver.rs:47` 等 | 硬编码路径族 | 6 组 | 配置从哪读 |

增删一个框架要改 4 处；`compat` 与 `deps` 对「目录在、dll 不在」会给出相反结论。**P1**，修法：抽 `framework.rs` 注册表，四处派生。

另外 `compat.rs` 的判断结果**只有兼容性页面一个消费者**（`lib.rs:2117-2140` → `SafeModeCard.tsx:32`），`CORE_FRAMEWORKS`/`probe` 均无 `pub`，汉化与配置模块都用不上它。

### 4.2 依赖检测

- 官方：**零依赖检测**（全仓 `dependenc|requires|requirement` 仅命中 `requiredFiles: []` 与核心包自洽校验）。
- 我们：`deps.rs`（875 行）按名字/框架名推断「A 需要 B」，命中后**提示不阻断**。
- 判定：**我们领先**，官方对「装了个需要 ArchiveXL 的 archive mod」一句话都不会说。风险在误报率，而非能力缺失。

### 4.3 冲突检测

- 官方：扩展层**零实现**（`testFileConflict`/`getDeploymentInfo`/`registerModType` 全仓 0 命中，唯一 `registerModType` 整段被注释），全靠 Vortex 核心的 `mergeMods: true` + manifest 裁决。`InvalidLayout.Conflict` 是「布局歧义」，不是 mod 间冲突。
- 我们：自研文件级冲突（`collect_conflicts`/`all_conflicts`/`staged_conflicts`），父子汉化包直接豁免（`installer.rs:1897-1937`，只认直接父子，祖孙不算）。
- 差距：我们没有「赢家」概念（无法表达「按加载顺序谁覆盖谁」），也没有部署时的目标校验信息（大小/时间有，hash 没有）；目录 vs 文件同路径、同 mod 内重复目标这两种边界没有专门处理（后者见 §2 拍平缺陷）。

### 4.4 散装 archive 顺序被「暂停」时不删文件（P1）

`set_write_modlist(false)` 只改开关、不删 `archive/pc/mod/modlist.txt`（`lib.rs:1125-1136`），磁盘上旧顺序继续生效，界面 Badge 却显示 `PAUSED`。用户以为已回退到原生 ASCII 顺序。

## 5. Vortex 环境接管与链接安全

### 5.1 接管到底是什么（两条完全不同的能力）

- `vortex.rs`：读 Vortex 的 LevelDB（`%APPDATA%\Vortex\state.v2`）**导入模组元数据**（Nexus modId / 作者 / 版本 / 封面），只读、需先关掉 Vortex。**它不是部署接管。**
- `adopt.rs`：把 `archive/pc/mod` 下**未受管**的 archive（+同词干 `.xl`/`.xlp`）**就地登记**进启动器；永不改游戏文件、不写 modlist、不碰 Vortex、不走 `deploy_mod`；暂存侧用硬链接反向链接，跨卷则复制并记 `Copy`；与 `undeploy` 的 `same_file_identity` 天然兼容。
- 缺口：adopt 只覆盖 `archive/pc/mod` 下的 archive，`.reds` / CET / redmod / red4ext 插件都无法收编；且收编 Vortex 部署过的文件后，**Vortex 的 manifest 仍认为它拥有该文件**，两套管理器可能互相删对方的东西（我们只保证「不碰 Vortex」，不保证 Vortex 不碰我们）。

### 5.2 链接方式

- 我们支持 hardLink / symlink / copy，跨卷自动降级。官方把这块完全交给核心（扩展只声明 `compatible: { symlinks: false }`，`index.ts:240-242`），所以这是我们**自研的核心能力**。
- 边界处理：目标已存在 → 报错；只读 → 先取消只读再删；被占用（游戏没退）→ `DEPLOY_STALE_FILES`；被外部替换 → 硬链接看 inode 身份、复制看大小/时间。

### 5.3 改配置会切断硬链接（P0）

- 部署默认硬链接（`installer.rs:1814-1820`）。
- 配置保存用「临时文件 + `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` 覆盖目标」（`modsettings.rs:406-450`），目标成为**新 inode**，与暂存区不再是同一对象。
- `undeploy` 对 `HardLink` 用 `same_file_identity` 校验，不一致就**拒绝删除**（`installer.rs:2059-2068`），文件留在游戏目录、清单留在 leftover，只给一句「有 N 个文件没能删除」。
- 用户视角：**只要在详情页调过任何参数，这个 Mod 就再也禁用不干净。**
- 同源问题：配置只写游戏目录，**暂存区仍是旧值**，所以「禁用→重新启用 / 更新 Mod / 换机重装」会用暂存区原件重新链接，用户调参被无声覆盖。

### 5.4 锁与死锁

- `DEPLOY_GATE` 覆盖「写 modlist + 删缓存（可能上万文件）+ 跑 redMod（阻塞几十秒到几分钟）」，期间所有 REDmod 操作排队。
- 锁序是**隐式约定**（gate → state），当前无可复现死锁（8 个 `flush_into` 调用点都确认在 state 锁之外）；但 `std::sync::Mutex` 不可重入，任何一次「在持 state 锁时调 `flush_into`」就会进程内自死锁、界面永久卡死。
- state 锁内做磁盘 IO：`installer.rs:1510-1728`（`write_modlist` 在锁内）、`:2093-2183`；`config_pack.rs:168-242`（`store.save` 在锁内）；`ailoc.rs:698-710`。
- `expect("state mutex poisoned")` 中毒面：`redmod.rs:490`、`lib.rs:983/992/1047/3066`、`installer.rs:1510/2093`。任一命令持锁时 panic → 之后所有命令 panic，表现为「所有按钮点了没反应」，只能重启。

### 5.5 唯一落在「解析用户文件」路径上的 panic

- `config_pack.rs:169` `lock().expect(...)`：坏 JSON 拦得住，但 Mutex 一旦中毒，每次导入都 panic。
- `modsettings.rs:369-377` `&before_comment[..=eq]`：`eq == len()` 时**字节越界 panic**；触发条件是 ini 的 key 含 `;`（`validate_token:256-282` 不禁 `;`/`#`）且该行注释里先出现 `=`。
- `config_resolver.rs` / `modsettings.rs` 生产区 0 个 `unwrap()/expect()`，容错风格是 `.ok()?` 静默丢弃 —— 代价是 `mod_config` 的 `warnings` **恒为空**，前端「解析失败」面板是死代码：文件超限 / 非 UTF-8 / 坏 JSON / 符号链接全部显示成「这个模组装上就能用」。

### 5.6 配置包导入的静默覆盖（P1）

`config_pack.rs:188-192`、`:215-216`：`PackSettings` 每个字段都有 `#[serde(default)]`，导入时 5 个布尔**无条件赋值**。一个只写了 AI 地址的最小包，会把用户的**自动备份、卸载确认、写 modlist** 静默关掉，`applied` 里只留一句含糊的「nexus/backup 开关」。导出侧还是非原子 `fs::write`（`:128`）。

### 5.7 部署/卸载与 redMod 编译之间没有互斥（P1）

`DEPLOY_GATE` 全仓只有 `redmod.rs` 两处引用（定义 `:66`、加锁 `:422`），`installer.rs` / `profiles.rs` / `aiact.rs` **零引用**。而官方每次部署或调序后都会跑完整流程，顺序由 Vortex 核心串行保证。

后果：`aiact` 批量启停或 `switch_profile` 的「撤部署 → 重新部署」与 `redmod::sync` 之间没有任何互斥 → `mods/` 内容与 `r6/cache/modded` 可能对不上（编译时 `mods/` 里还是旧内容）。这正好解释了为什么 §3.6 的播放集问题是「必然错」而不是「偶尔错」。**P1**

### 5.8 Copy 部署的删除不做身份校验（P1）

`installer.rs:2059-2068` 只对 `HardLink` 做 inode 身份校验；`Copy` 分支（`:2072-2083`）**只比对大小/时间并记 `edited`**，然后照删不误。

Vortex 部署过的文件如果被我们 adopt 成 `Copy`，Vortex 再次部署时接管该文件 → 我们 undeploy 时会**直接删掉 Vortex 正在用的文件**；「不碰 Vortex」的承诺只在 adopt 那一刻成立。**P1**

### 5.9 前置探针的文件名是旧版（P1，假告警）

`deps.rs:124`、`diagnostics.rs:100`、`game.rs:448` 都把 redscript 的前置判据写成 `engine\tools\redscript-cli.exe`；而官方 8 个核心安装器用的是 `engine\tools\scc.exe` + `engine\config\base\scripts.ini` + `r6\config\cybercmd\scc.toml` 三件套（`installers.layouts.ts:126-137`）。

现状是新版 redscript 只带 `scc.exe`，于是这几处会把「已装 redscript」判成缺失，**每个新用户都会看到假红灯**。我们自己的 `aifix.rs:232` 反而查的是 `scc.exe` —— 同一仓库两个口径。**P1**

另外 compat 探针表只覆盖 4 个框架（RED4ext / ArchiveXL / TweakXL / Codeware），**audioware / input_loader / mod_settings / CET / redscript 都没进表**；而官方 8 个核心安装器有明确判据，补表成本很低。

## 6. 定级汇总

### P0（必然错 / 数据面受损，先修）

| # | 问题 | 证据 | 修复方案 | 验收 |
|---|---|---|---|---|
| P0-1 | 换播放集不重新部署 REDmod，实机加载上一个播放集 | `profiles.rs:65-177` 无 flush；`schema.rs:1483-1497` 无 redmod 顺序 | `switch_profile` 阶段 3 之后调 `redmod::flush_into(store, Some(root), &mut warnings)` | 切 A→B 后 `V2077/modlist.txt` 内容 = B 的 REDmod 集合；缓存重建 |
| P0-2 | `archive/pc/mod/modlist.txt` 写 `#` 注释头 + 末尾裸 LF | `loadorder.rs:10/188-191/209` | 只写纯文件名、全 CRLF、无尾换行；托管标记改存同目录 sidecar（不污染游戏文件） | 文件内容与官方同构；旧格式文件能被识别并自动迁移 |
| P0-3 | 改配置切断硬链接 → 之后禁用/卸载拒绝删文件 | `modsettings.rs:406-450` + `installer.rs:2059-2068` | 写配置后把新内容回写暂存源并重建硬链接；重建失败则降级 `Copy` 并刷新 state 的 size/mtime | 改配置 → 禁用 → 游戏目录文件消失、清单清空 |

### P1（功能缺失 / 用户可感知错误）

| # | 问题 | 证据 | 修复方向 |
|---|---|---|---|
| P1-1 | 启动前不部署 REDmod，失败也不拦启动 | `lib.rs:3029-3071` vs `tools.redmodding.ts:241-259` | `launch_game` 前 flush，失败则拒绝启动并提示 |
| P1-2 | 清缓存失败仍已写 modlist → `needs_rebuild` 恒 false，幽灵产物 | `redmod.rs:424-440` | 删缓存失败时把 modlist 恢复原状或置 dirty，下次重试 |
| P1-3 | Archive 布局拍平丢子路径、把 DLC 路径搬进 canon | `installer.rs:1168-1177` | 保子路径；`archive/pc/patch/**` 重写前缀；其它目录挂 canon 下保结构 |
| P1-4 | 混合包按单枚举丢弃 | `installer.rs:934-1022/1160-1203` | 中期做 MultiType：多 layout 合并 plan；短期至少把被丢文件计入 warning |
| P1-5 | FOMOD 零支持 | 全仓 0 命中 | 识别 `fomod/ModuleConfig.xml` 并明确拒绝 + 引导（不做完整向导） |
| P1-6 | `LAYOUT_AMBIGUOUS` 误杀「主体+可选件」包 | `installer.rs:554-572` | 同分时优先祖先目录；仅「互不包含的同分根」才报错 |
| P1-7 | 选定根之外的兄弟目录静默丢弃 | `installer.rs:1240-1294` | 计入 skipped/警告，或收纳到 `V2077/mod-extra-files/` |
| P1-8 | 4 份互不相干的框架清单 | `compat.rs:45-74` / `deps.rs:117-125` / `game.rs:~402` / `config_resolver.rs:47` | 抽 `framework.rs` 单一注册表，四处派生 |
| P1-9 | 暂停写 modlist 不删文件 → 用户以为已回退 | `lib.rs:1125-1136` | 关闭开关时按官方策略删除本启动器写的文件 |
| P1-10 | 配置包缺字段即 false，静默关掉自动备份等 | `config_pack.rs:188-192/215-216` | 只覆盖「包里显式存在」的字段 |
| P1-11 | 读配置错误全吞 → `warnings` 恒空 | `config_resolver.rs:142-174` | 把 `.ok()?` 换成「记 warning + 继续」 |
| P1-12 | 部署与 redMod 编译无互斥（`DEPLOY_GATE` 只有 redmod 用） | `redmod.rs:66/422` vs `installer.rs` 零引用 | 部署路径也取同一把门锁，或改成「部署期间置 dirty 并阻止 sync」 |
| P1-13 | `Copy` 部署的删除只比大小/时间，改过照删 → 可能删掉 Vortex 的文件 | `installer.rs:2072-2083` | 改过就拒绝删除并升级为明确告警；adopt 来的 `Copy` 走更严的归属校验 |
| P1-14 | redscript 前置探针用旧文件名 `redscript-cli.exe` | `deps.rs:124`、`diagnostics.rs:100`、`game.rs:448`（官方用 `scc.exe`） | 主判据改 `scc.exe`，保留旧名作兼容兜底 |
| P1-15 | compat 框架表缺 audioware / input_loader / mod_settings / CET / redscript | `compat.rs:45-74` 仅 4 项 | 按官方 8 个核心安装器的定义文件补齐 |

### P2（可维护性 / 体验）

CET 自造目录层（`:1179-1181`）；rar 先解压后校验（`:382→478-484`）；GBK 文件名无转码；`.tmp-<id>` 崩溃残留无回收；rar 依赖外部 exe 且 CI 测不到；stdout/stderr 丢序致 `failure_reason` 退化；redMod 无超时/无进度/同步命令占主线程；禁用 REDmod 丢位置；`redmod_order` 全局且死 id 不清理；`expect` 中毒面；state 锁内 IO；`config_pack` 持锁 IO + 非原子导出；`modsettings.rs:369-377` 越界 panic；`-rttiSchemaPath` 分隔符混排；两个清洗器口径不一致；拍平后不做目标去重。

## 7. 已领先，不要动

1. **ASI 布局**：代理 dll → `bin/x64/`、`plugins/` 去重、壳目录剥离；ASI+Red4ext 混合包官方直接 reject，我们能装。
2. **深层嵌套剥壳**：打分 + max_depth 6，比官方「只剥一层」强。
3. **压缩包安全**：应用层自建的条目/体积预扫、重解析点拒绝、大小写去重，官方扩展层完全不管。
4. **依赖提示**：官方零依赖检测，我们有 `deps.rs`。
5. **冲突检测**：官方扩展层零实现，我们自研且有父子豁免。
6. **收编（adopt）**：官方无此概念。
7. **Collections**：官方零专门支持，我们有 `collection.rs`。
8. **汉化覆盖层**：官方完全没有；我们已有 ArchiveXL + WolkenKit 打包链路（覆盖面窄是另一件事）。
9. **REDmod 顺序去重**：我们大小写归一去重，官方没有。
10. **`needs_rebuild` 大小写归一**：比官方少一次几十秒的无谓重建。

## 8. 本次不采纳 / 暂缓

- **完整 FOMOD 向导**：需要解析 `ModuleConfig.xml` 的 `installSteps`/`group`/`plugin` 结构并生成交互 UI，属于独立模块（官方也是核心级组件）。本次只做识别与明确拒绝。
- **archive 内字符串提取（真解包 onscreens）**：需要 CR2W 解析或调用 WolvenKit 解包，风险与工作量都大，暂缓。
- **per-profile REDmod 顺序**：本次先保证「切换时重新部署」，顺序仍全局共享；per-profile 需要迁移 `ProfileEntry` 结构，留作 P2。

---

*本报告所有行号基于 2026-11-06 的仓库状态（HEAD `2010e6c`）。*
