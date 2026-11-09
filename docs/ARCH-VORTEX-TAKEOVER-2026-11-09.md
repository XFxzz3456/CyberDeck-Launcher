# CyberDeck Launcher 完全接管 Vortex 操作 · 方案（2026-11-09）

状态：**方案与调研，未改代码 / 未提交 / 未构建 / 未写 Vortex 状态库**。
目标：以 CyberDeck 为唯一入口，改启用状态、加载顺序及同类变更时，改动直接落到 Vortex；启动/切到 Vortex 时状态完整生效且一致，不在 Vortex 里重复设置，也不发生覆盖或冲突。

---

## 0. 先说结论（可行性与硬边界）

**可行，但不能做成「实时双向同步」，只能做成「单一入口 + 状态镜像 + 单一部署引擎 + 启动校验」。**

三条不可绕过的物理约束：

1. **Vortex 运行时独占 LevelDB 锁**（`%APPDATA%\Vortex\state.v2`）。Vortex 开着时，外部写入必然失败；硬写会损坏状态。→ 写 Vortex 状态的**生效条件是 Vortex 已完全退出**。
2. **Vortex 的 `enabled` 只是一个标记**，真正的部署是独立一步（官方设置项「Deploy mods when Enabled」）。只改数据库、不处理部署，启动 Vortex 后会看到状态对了但游戏目录没跟上。→ 必须明确**谁负责物理部署**。
3. **两边都会写 `archive/pc/mod/modlist.txt`**：CyberDeck 用 `loadorder::write_modlist`（带 `.cyberdeck-modlist` 托管标记），Vortex 用自己的 `loadOrders` 状态序列化。→ 必须**单一写入者 + 另一边只读镜像**。

因此「无需在 Vortex 中手动重复设置」可以做到；「Vortex 开着时 CyberDeck 改、Vortex 界面立刻跟着变」做不到，也不建议承诺。

---

## 1. 本机现场（实测，方案据此设计）

| 项 | 实测值 |
|---|---|
| Vortex 可执行文件 | `D:\Vortex\Vortex.exe`（官方 CLI 可用：`--get/--set/--del/--merge/--restore/--profile`） |
| Vortex 状态库 | `C:\Users\mc236\AppData\Roaming\Vortex\state.v2`（LevelDB，`LOCK` 常驻；Vortex 运行时独占） |
| 当前活动 profile | `tHYlht6Mz`（`cyberpunk2077`），DB 里还有 stardewvalley / rimworld / deeprockgalactic 等 profile |
| 模组存储根 | `D:\Vortex Mods\cyberpunk2077`，225 个 mod 目录 |
| 游戏目录 | `d:\steam\steamapps\common\Cyberpunk 2077`（同盘，硬链接部署） |
| 启用状态键 | `persistent###profiles###tHYlht6Mz###modState###<modId>###enabled`（bool），另有 `enabledTime` / `disabledTime`（epoch ms）、`modState###<modId>###...` |
| 加载顺序键 | `persistent###loadOrders###tHYlht6Mz###cyberpunk2077-archive`（JSON 数组 `[{"id":"inventoryZoom.archive","name":"...","enabled":true}, ...]`）<br>`persistent###loadOrders###tHYlht6Mz###cyberpunk2077-redmod`（含 `modId`/`data.ownerVortexProfileId`/`prefix`） |
| 模组元数据键 | `persistent###mods###cyberpunk2077###<installationPath>###attributes###modId` 等（仓库 `vortex.rs` 已在读） |
| 部署相关键 | `persistent###deployment###...`（Vortex 部署清单，外部不应改写） |
| CyberDeck 现状 | `set_mod_enabled` / `save_load_order` / `loadorder::write_modlist` 只改自身 state + 游戏目录；`vortex.rs` **只读**，全仓库**没有任何写 Vortex 的代码** |
| 缺失前提 | `ModEntry` **没有 Vortex 模组 id 字段**。现库 106 条里 28 条 `origin=vortex`、78 条 `adopted`，无法稳定映射到 `modState###<modId>` |

补充现场问题（见同日《收编卡顿与批量失败排查》）：44 个孤儿暂存目录、1 条已登记模组缺暂存目录。做状态双写前必须先体检修复。

---

## 2. 接管范围（明确边界）

### 2.1 纳入（CyberDeck 操作 → 直接落到 Vortex）

| 类别 | CyberDeck 动作 | 必须写入的 Vortex 位置 |
|---|---|---|
| 启用/禁用 | 单个 `set_mod_enabled`、批量启用/禁用、播放集切换 | `persistent###profiles###<profileId>###modState###<modId>###enabled` + `enabledTime`/`disabledTime` |
| 加载顺序 | `save_load_order`（archive）、redmod 顺序、拖拽排序 | `persistent###loadOrders###<profileId>###cyberpunk2077-archive` / `...-redmod` |
| 物理生效 | 部署/撤销、重写 `archive/pc/mod/modlist.txt` | 由 CyberDeck 独有；Vortex 侧不触发二次部署 |
| 顺序相关的同类变更 | 冲突规则变化导致的顺序调整、Mod 更新后重排 | 同上，且同步刷新 Vortex LO 数组 |
| 状态一致性 | 启动时回读 Vortex 状态并与自身比对 | 只读校验 + 漂移告警 |

### 2.2 不纳入（明确排除，避免越界承诺）

- Vortex 的下载 / 安装 / 卸载、Nexus 登录、Collection、FOMOD 安装选项、profile 新建/切换、Vortex 设置界面。
- Vortex 运行时的实时双向同步（受 DB 独占锁限制）。
- 游戏内菜单文本、AI 汉化（与本议题无关）。
- **Vortex UI 里的手动改动自动反向同步**：只做检测与告警，不静默覆盖（见 §4）。
- 其它游戏 profile（只管 `cyberpunk2077` 当前活动 profile）。

---

## 3. 生效条件（每条都是硬门槛，失败即拒绝变更并给可见错误）

1. **接管开关**：设置里显式开启「接管 Vortex（单一入口）」，默认关闭。开启前先做一次只读一致性体检并生成报告。
2. **Vortex 必须已退出**：写入前检测 `Vortex.exe` 进程 + `state.v2` 锁。检测到运行中 → **拒绝本次变更**，提示「请先退出 Vortex」，不允许强杀、不允许排队后偷偷写。
3. **状态库备份**：每次写入前把 `state.v2` 关键键导出为 JSON 快照存到 `data_dir/vortex-mirror/backups/<时间戳>.json`；保留最近 N 份；提供「一键还原」（用快照 + Vortex `--restore` 或直写回卷）。
4. **profile 校验**：从 `settings###profiles###activeProfileId` 读出活动 profile，确认 `gameId == cyberpunk2077`，且与本次接管绑定的 profile 一致；用户切了 profile → 立即停止双写并告警，绝不往别的 profile 写。
5. **模组身份映射**：`ModEntry` 新增 `vortexModId`（= Vortex `installationPath` / `modState` 键段）。开启接管时按目录名精确回填；无法映射的条目标为「仅本地」，其变更**不同步到 Vortex**并在界面明示。
6. **提交顺序（先本地后镜像，镜像失败不静默）**：
   `CyberDeck state + 物理部署成功` → 写 Vortex 镜像 → 回读校验 → 任一失败：本地保持已完成状态 + 界面红色告警「Vortex 未同步，请勿在 Vortex 中操作」+ 提供重试/回滚，不假装成功。
7. **单一部署引擎**：CyberDeck 负责物理部署；Vortex 侧关闭「Deploy mods when Enabled」或明确告知用户不要在 Vortex 点 Deploy。Vortex 只作为状态/元数据视图。
8. **单一 modlist 写入者**：`modlist.txt` 只由 CyberDeck `write_modlist` 写；Vortex 的 `cyberpunk2077-archive` LO 数组按同一顺序镜像，保证 Vortex 不认为「顺序变了」而重写文件。

---

## 4. 防覆盖 / 防冲突机制

| 风险 | 防护 |
|---|---|
| Vortex 在外部被改过（用户手点启用/排序） | 每次 CyberDeck 启动 + 每次写入前**回读** Vortex 的 `modState` / `loadOrders`，与上次成功镜像的指纹比对；发现漂移 → 弹「Vortex 侧有外部改动」，列出差异，让用户选「以 CyberDeck 覆盖 / 以 Vortex 反向同步 / 暂不处理」。**默认不自动覆盖** |
| Vortex 启动后自身重写状态 | 因为 CyberDeck 已把状态写成 Vortex 期望的形状，Vortex 读到的是一致状态；启动不产生 diff，也就不会反向覆盖 |
| 双方同时部署导致硬链接错乱 | 物理部署只由 CyberDeck 做；接管开启期间禁止在 Vortex 点 Deploy/Purge（界面提示 + 启动漂移检测兜底） |
| 写入中途崩溃 / 形状写错 | 写前快照 + 单事务批量写 + 写后回读校验；官方 CLI `--set` 自带「Improper use will break the Vortex state」警告，因此优先用受控的批量键写入而非逐键 `--set` |
| Vortex 版本升级改了键结构 | 镜像层做版本探测：读不到预期键 / 值形状不符 → **降级为只读并告警**，不猜、不写 |
| 两条来源的 mod id 对不上 | 映射失败条目标「仅本地」，绝不按名字模糊匹配去改 Vortex 的 `modState`（`vortex::import` 的模糊匹配只用于补元数据，不用于写状态） |

---

## 5. 写入路径（建议实现形态）

```
CyberDeck UI（唯一入口）
   │ set_mod_enabled / save_load_order / 批量 / 播放集
   ▼
[1] 本地事务：state 保存 + installer 部署/撤销 + write_modlist        ← 既有能力，不改语义
   ▼ 成功后
[2] VortexMirror::apply(changes)
      ├ 前置守卫：Vortex 进程? / 锁? / profile? / 映射? / 漂移?
      ├ 备份 state.v2 关键键 → JSON 快照
      ├ 批量写：modState.enabled(+Time) / loadOrders.archive / loadOrders.redmod
      ├ 回读校验：逐键比对写后值
      └ 记录 lastMirrorHash（写入 CyberDeck 侧，不动 Vortex schema）
   ▼
[3] UI 结果：本地已生效 + Vortex 已同步 / 失败可见告警（含重试与还原入口）
   ▼
[4] 下次启动或「切到 Vortex」前：ReadBack → 指纹比对 → 漂移面板
```

技术选型建议：**复用仓库已有的 `rusty-leveldb` 直写**（Vortex 关闭时），按 `###` 扁平键格式写 JSON 值；官方 `Vortex.exe --get/--merge/--restore` 作为校验与应急还原通道。不新增 crate、不常驻进程、不做隐形 agent。所有写操作都在界面上可查（改了哪些键、备份在哪、怎么还原）。

---

## 6. 验收标准（可逐条实测，全部通过才算完成）

| # | 场景 | 判定 |
|---|---|---|
| A1 | 接管开启前 | 只做只读体检，Vortex `state.v2` 的 mtime/内容零变化；报告列出 profile、可映射/不可映射模组数、现有漂移 |
| A2 | CyberDeck 禁用 1 个 Vortex 来源模组 | 游戏目录对应文件撤走；`--get persistent.profiles.<id>.modState` 该模组 `enabled=false` 且 `disabledTime` 已更新；界面显示「Vortex 已同步」 |
| A3 | 启动 Vortex | Mods 页该模组显示 Disabled，无「需要部署」提示，无需任何点击；`vortex.log` 无 state 校验错误 |
| A4 | CyberDeck 调整 archive 加载顺序 | `archive/pc/mod/modlist.txt` 行序改变（带托管标记）；Vortex `cyberpunk2077-archive` LO 数组顺序逐项一致；启动 Vortex 后 Load Order 页顺序一致，且 `modlist.txt` 未被 Vortex 改写（mtime/内容） |
| A5 | 批量 / 播放集切换 | 多个模组一次性生效；Vortex 侧全部对应；中途失败只报可见错误，不出现一半同步一半不同步的静默状态 |
| A6 | Vortex 运行时尝试在 CyberDeck 改 | 变更被拒绝并提示退出 Vortex；**Vortex 状态库零写入**，本地状态也未被改动（原子性） |
| A7 | 用户在 Vortex 里手动改了状态再开 CyberDeck | 启动漂移面板列出差异，默认不覆盖；选「以 CyberDeck 覆盖」后 Vortex 回到一致；选「反向同步」后 CyberDeck 状态跟着变 |
| A8 | 切换 Vortex profile / 升级 Vortex 后 | 双写自动停用并告警，不往错误 profile 或未知键结构写入 |
| A9 | 还原 | 用快照一键还原后，Vortex 能正常启动、模组列表与还原点一致 |
| A10 | 回归 | `cargo test --lib` ≥ 260 passed / 2 ignored、`npm run gate` 42/42；现有「不写 Vortex」路径在接管关闭时行为完全不变 |

---

## 7. 分期

| 期 | 内容 | 风险 |
|---|---|---|
| **P0** | 只读取证层：Vortex 状态读出（`modState` / `loadOrders` / activeProfileId）、`ModEntry.vortexModId` 回填、漂移检测与「接管体检」面板；同时修收编 P0 三个缺陷（见同日排查文档） | 零写入，最安全 |
| **P1** | 启用/禁用镜像：守卫 + 备份 + 批量写 + 回读校验 + 失败可见 + 一键还原 | 写 Vortex 状态，需真机验 A2/A3/A6/A9 |
| **P2** | 加载顺序镜像：archive / redmod LO 与 `modlist.txt` 单一写入者 | 需验证 Vortex 不重写 modlist（A4） |
| **P3** | 批量/播放集、漂移自动对账策略、切到 Vortex 前的一致性预检 | 上层编排 |

每期仍走：**门禁 → 提交 → localhost 验收 → 用户确认「没问题」→ 才构建 exe**；便携 ZIP 单独确认。

---

## 8. 需要你拍板的 5 件事

1. **部署引擎归属（最关键）**：推荐「CyberDeck 独占物理部署，Vortex 只作状态/元数据视图，接管期间不在 Vortex 点 Deploy/Purge」。若你要求 Vortex 也能随时部署，就要做双向部署对账，复杂度与冲突风险显著上升。
2. **Vortex 开着时的策略**：推荐「拒绝本次变更 + 提示退出 Vortex」（最安全）；备选「提示后由用户手动关闭再重试」。不建议自动结束 Vortex 进程（它可能有未落盘状态）。
3. **写入方式**：推荐「Vortex 关闭时用 `rusty-leveldb` 批量写 + 官方 CLI 做校验/还原」；备选全部走 `Vortex.exe --set/--merge`（受 CLI 路径与参数形状限制，且官方明确警告误用会破坏状态）。
4. **Vortex 侧手改后的默认处理**：推荐「告警 + 由用户选方向，默认不自动覆盖」。若你要「永远以 CyberDeck 为准强制覆盖」，需接受会抹掉 Vortex 里刚做的改动。
5. **优先级**：先修收编 bug + 清理 44 个孤儿目录/1 个缺失暂存目录，还是先上 P0 只读取证？推荐前者，避免把脏状态镜像进 Vortex。

确认后按 P0 开工；在你明确「没问题」之前不构建 exe、不升版、不打便携 ZIP。

---

## 9. P0 落地记录（2026-11-09）

用户确认「按推荐的开工」= 上述 5 项拍板取推荐值，优先级取「先修收编 bug + 只读体检，再上 P0 取证层」。本轮已落地：

- **收编事故修复**：`adopt_scan` 异步化、失败原因内联、回滚受保护、已登记候选拦截（复盘 `docs/INCIDENT-2026-11-09-adopt-freeze.md`）。
- **只读取证层** `src-tauri/src/vortex_mirror.rs`：只读打开 `state.v2`，解析 `settings###profiles###activeProfileId`、`persistent###profiles###<pid>###modState###<modId>###enabled`、`persistent###loadOrders###<pid>###cyberpunk2077-archive|-redmod`；多形态 profile 回退；状态指纹；按「游戏侧相对路径」精确配准 Vortex 目录，输出启用状态漂移与顺序一致性。
- **命令**：`vortex_takeover_preflight`、`adopt_staging_health`，两者均 `spawn_blocking`，**零写入、零删除**。Vortex 运行中 DB 锁失败会回一份 `available=false / dbLocked=true` 的报告，不抛异常。
- **前端**：设置页「工具」页新增「Vortex 接管体检」卡片，展示 profile、启用/禁用计数、加载顺序、映射覆盖率、漂移清单、指纹、暂存区孤儿/缺失目录与告警。
- **单测**：6 条（多 profile 隔离、顺序解析、指纹稳定、顺序交集比较、坏 JSON 转 warning、暂存体检不删目录、DB 不可读回报告）。

### 仍未做（P1 起，须单独授权）

- 写 Vortex 状态库（`modState` / `loadOrders`）、写前快照备份、漂移方向选择、一键还原。
- `ModEntry.vortexModId` 持久化字段与回填（P0 只在内存里算映射，不落盘）。
- 44 个孤儿暂存目录与 1 个缺失目录的清理/重建（体检只列，不删）。
- 真机验收 A1–A10（尤其 A2/A3 禁用后启动 Vortex、A4 modlist 不被 Vortex 改写）。

**当前状态**：未升版（仍 1.3.1）、未构建 exe、未打便携 ZIP；按交付顺序先挂 localhost 验收，用户确认后才出包。
