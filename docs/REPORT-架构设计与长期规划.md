# NightCity Loader — 整体架构设计与长期发展规划

> 作者角色：软件架构师（架构通）
> 日期：2026-10-25 · 基准版本：0.7.0（含夜班报告五项任务后的代码状态）
> 依据材料：`HANDOFF.md`、`NIGHT_SHIFT_REPORT.md`、`UI-AUDIT-0.7.0.md`、`docs/ARCHITECTURE.md` 及源码实读

---

## 0. 文档定位

本文回答三个问题：

1. 现在的架构哪些部分必须**原样守住**，哪些部分正在产生**结构债**；
2. 未来 2–3 个版本里，系统要演进成什么形状；
3. 每个关键决策的**备选项与代价**是什么（决策不写理由，等于没做）。

---

## 1. 现状盘点（As-Is）

### 1.1 分层现状

```text
┌─────────────────────────────────────────────────────────┐
│ React 19 + TS：App.tsx 单点编排 + 20 余个视图组件          │
│   只读 ModEntry[]，只调 api.ts（唯一 IPC 入口）            │
├─────────────────────────────────────────────────────────┤
│ Tauri 2：lib.rs ≈ 950 行，generate_handler 注册 40+ 命令  │
├─────────────────────────────────────────────────────────┤
│ Rust core（core-tests 复用同一批源文件，无 GUI 测试）       │
│   installer / game / loadorder / backup / store / schema  │
│   modpack / config_resolver / environment（新）           │
│   nexus / ai / modsettings / logs / secret / diagnostics  │
├─────────────────────────────────────────────────────────┤
│ 游戏目录：硬链接 → 符号链接 → 复制，deployed_files 清单      │
└─────────────────────────────────────────────────────────┘
```

### 1.2 必须守住的本体（不可妥协项）

这些是项目最大的资产，任何演进都不能破坏：

| # | 不变量 | 位置 |
|---|---|---|
| 1 | 「React 只画状态，Rust 只做文件操作，Tauri 只做 IPC」 | 全局分层纪律 |
| 2 | 卸载只信 `deployed_files` 清单，永不递归删除 | installer.rs |
| 3 | 所有目标路径先过 `safe_join` + `is_within` | store.rs |
| 4 | 状态写失败 → 回滚已创建的链接（无孤儿文件） | installer.rs |
| 5 | 非 AI 白名单 focus 不联网；密钥 DPAPI 隔离 | ai.rs / secret.rs |
| 6 | 核心逻辑与 GUI 解耦（core-tests 用 `#[path]` 复用源文件） | core-tests/ |
| 7 | 冲突预检在写入前由后端最终把关，不信前端缓存 | find_conflicts |

### 1.3 架构压力点（为什么现在必须规划）

| 压力点 | 证据 | 后果（不处理的话） |
|---|---|---|
| **命令层单文件膨胀** | `lib.rs` ≈ 950 行、40+ 命令混在 `generate_handler!` 前后；夜班新增 5 个命令全部塞进同一文件 | 每加一个功能都要改同一个文件，merge 冲突与审查成本线性上涨 |
| **前端单点编排** | `App.tsx` 800+ 行，快照/导航/任务队列/横幅/弹窗全部 state 集中 | 新横幅（熔断）、新面板（体检）都往里堆，重构窗口正在关闭 |
| **状态文件多聚合无版本** | `launcher-state.json` 一个文件装 game/mods/load_order/settings/modpacks，无 `schema_version` 字段 | 0.8 引入 Profiles 时无法安全迁移老用户状态，是**升级翻车点** |
| **Profile 是隐式单例** | `enabled`、`load_order` 直接挂在全局列表上 | HANDOFF 的 P3 需求（播放集）在现数据模型上无处安放 |
| **事件通道各自为政** | `nexus-download-progress`、`modpack-progress` 各自定义 payload | 每个长任务都要发明一次事件协议，前端任务中心适配成本高 |
| **测试基线漂移** | HANDOFF 称「28 项通过」；夜班实测 31 项中 11 过 / 20 挂（沙箱文件操作限制） | 没有可信回归基线，任何重构都是盲飞 |
| **构建工作流分叉** | 项目目录曾出现 ACL 拒写 `Cargo.lock`，现走 `D:\用户\工作区\.tools\ncl-build` 副本编译；源目录 `Cargo.lock` 已删除 | 「改了源码但编译的是旧副本」类事故；CI/新机器无法一键复现 |
| **文档落后于代码** | HANDOFF 未覆盖 modpack/config_resolver/environment 等 3 个新模块与 5 个新命令 | 接手者按旧文档理解系统会产生误判（本次已实际发生） |

---

## 2. 目标架构（To-Be）

### 2.1 总原则

保持**模块化单体**：一个 Rust 进程、一个 WebView，按限界上下文切模块，而不是拆服务。理由见 ADR-001。

### 2.2 限界上下文地图（Rust core 内部重排）

```text
src-tauri/src/
├─ lib.rs                    # 只剩 run()：窗口、插件注册、事件桥（目标 <150 行）
├─ schema.rs                 # 共享数据契约 + schema_version
├─ store.rs                  # 状态读写、版本化迁移链、safe_join
├─ commands/                 # 新增：IPC 命令按上下文分文件
│  ├─ library.rs             # install_mods / import_modpack / update_mod / uninstall_mod
│  ├─ deploy.rs              # set_mod_enabled / repair_mod / diagnose+heal_environment
│  ├─ conflict.rs            # 冲突查询（若命令面扩大再独立）
│  ├─ loadorder.rs           # get/save_load_order / modlist 三件套
│  ├─ profile.rs             # profile CRUD / switch_profile（0.8 新增）
│  ├─ game.rs                # detect / set_game_dir / launch / clear_update_lock
│  ├─ observe.rs             # logs / diagnostics / environment 体检 / ai_diagnose
│  ├─ integrations.rs        # nexus_* / ai_status / open_url / open_in_explorer
│  └─ settings.rs            # set_settings / secrets
├─ domain/                   # 纯业务逻辑，不依赖 tauri:: command 宏
│  ├─ installer.rs / modpack.rs / loadorder.rs / backup.rs
│  ├─ game.rs / environment.rs / modsettings.rs / logs.rs
│  ├─ nexus.rs / ai.rs / secret.rs / diagnostics.rs
│  └─ profile.rs             # 0.8 新增：Profile 聚合的纯逻辑
└─ events.rs                 # 新增：统一事件 envelope
```

要点：

- **commands 层只做三件事**：参数校验 → 调 domain → 错误转 `CommandError`。domain 层不出现 `tauri::` 引用，core-tests 照旧零成本复用。
- 现有文件不需要物理移动也能开工：**先在 `lib.rs` 里把命令实现体抽到 `commands/`，文件移动是 0.8 的顺手事**。避免「大搬家 + 大重构」一次落地的风险。

### 2.3 状态层演进（0.8 的前置工程）

```text
launcher-state.json（现状，单文件多聚合，无版本）
        │ 0.8 迁移
        ▼
launcher-state.json
{
  "schema_version": 2,
  "game": { ... },            // 游戏目录、last_game_version、platform_pref
  "settings": { ... },
  "profiles": [ { id, name, mod_states: { modId: {enabled, loadOrder} } } ],
  "active_profile_id": "...",
  "library": { mods: [...], modpacks: [...] }   // 库与激活态分离
}
```

- `store.rs` 启动时按 `schema_version` 走**顺序迁移链** `v1 → v2 → ...`；每个迁移是纯函数 + 单元测试。
- 迁移前自动把原文件复制为 `launcher-state.v1.bak.json`（复用已有的 `*.broken-*` 命名习惯）。
- **Mod 的 `enabled` 从 ModEntry 上移到 Profile**：这是数据模型的核心变更，`deployed_files` 仍留在 library 层（部署清单属于物理事实，不属于播放集）。

### 2.4 事件层演进

```rust
// events.rs：所有长任务事件共用一个 envelope
#[serde(tag = "type")]
pub enum AppEvent {
    TaskProgress { task_id: String, stage: String, done: u64, total: u64 },
    TaskDone     { task_id: String, ok: bool, message: Option<String> },
}
```

- 现有 `nexus-download-progress` / `modpack-progress` 包一层 envelope，前端任务中心只监听 `app-event` 一个通道。
- 好处：未来「一键修复全部」「Profile 切换进度」直接复用，不再发明协议。

### 2.5 前端演进

- `App.tsx` 拆为三个 Provider：`LibraryProvider`（快照与模组操作）、`TaskProvider`（任务队列 + 事件订阅）、`UiProvider`（导航/弹窗/横幅）。视图组件只消费 context。
- `api.ts` 保持唯一入口不变（这是项目纪律，也是 mock 模式能工作的原因）。
- 刻意不做：不引入状态库（Redux/Zustand）。当前快照刷新模型（后端返回全量 Snapshot）简单可靠，Provider 拆分已足够。

---

## 3. 关键决策记录（ADR 摘要）

### ADR-001：维持模块化单体，不做插件进程/微服务

- **背景**：桌面工具，单用户，所有领域逻辑围绕「一个游戏目录的文件操作」。
- **备选**：(a) 模块化单体（选定）；(b) 前端插件 JS 沙箱；(c) 独立 Rust 服务进程 + CLI。
- **决策**：单体 + 限界上下文模块化。扩展点只开放**数据级**（主题 JSON 包、诊断规则包），不开放代码级插件。
- **代价**：第三方无法给启动器写功能插件。接受——代码级插件会击穿全部 9 条安全不变量（任意文件删除风险），收益不成比例。

### ADR-002：状态文件加 `schema_version` + 顺序迁移链

- **代价**：每次改状态结构都要写一个迁移函数（约 20–50 行 + 测试）。
- **不做的后果**：0.8 引入 Profiles 时，老用户状态文件无桥可过，只能「删了重来」——对已部署模组的用户不可接受。

### ADR-003：Profile 为一等聚合；切换 = 原子 swap

- **决策**：切换 Profile 必须先完整撤除当前部署（按 `deployed_files` 清单），再部署目标 Profile；任何一步失败即回滚到切换前状态。禁止跨 Profile 残留链接。
- **代价**：切换耗时随模组数量线性增长（万级文件时可能分钟级）→ 必须 2.4 的事件进度 + 可取消。这是 HANDOFF P3 的架构落地方式。

### ADR-004：部署引擎唯一化

- modpack.rs 只复用 installer 纯函数生成同构 ModEntry（夜班已实现，**保持**）。未来任何新入口（Nexus 批量、集合清单导入）都不得另写部署路径。

### ADR-005：统一事件 envelope（见 2.4）。

### ADR-006：主题 JSON 包 = 数据级扩展点（HANDOFF P1）

- 主题包只允许声明 CSS 变量值（现有 token 集合）+ 缩略图，**不接受任意 CSS 注入**，导入时按白名单键校验。五主题形态层（按钮切角/导航标记等变量）已为此铺好路。

### ADR-007：分发与更新（HANDOFF P2/P4）

- NSIS 安装器 + `tauri-plugin-updater`；签名私钥**永不入库**（放用户 DPAPI 隔离的环境变量或本机密钥库）。
- 更新策略：便携包只做「检查更新 + 跳转下载页」，安装器包才做自动更新——因为便携包没有稳定的安装目录写权限承诺。
- 更新前检测「有模组已部署」→ 提示但不阻止（部署清单与 exe 版本无关，重启即恢复）。

### ADR-008：测试基线是合并门槛

- core-tests 当前 31 项中 20 项失败是**沙箱环境问题**而非逻辑回归（夜班报告结论），但接手第一天必须把它变成可信基线：在正常权限环境跑全量 → 记录真实基线 → 之后任何改动不得让基线变红。
- 修好项目目录 ACL 后，`src-tauri/Cargo.lock` 恢复入库（HANDOFF 明确它本应随源码提供），废弃 ncl-build 副本编译工作流。

---

## 4. 长期路线图

### 0.7.x — 稳定期（本周，接手第一步）

1. 恢复构建一致性：修 ACL → `Cargo.lock` 回库 → 验证项目目录内直接 `cargo check` 通过 → 停用副本编译。
2. 在正常环境跑 core-tests，确立真实基线（目标：全绿或明确豁免清单）。
3. 真机验收夜班三项新功能：熔断横幅读真实 PE 版本、`open_in_explorer`/`repair_mod` 真实文件行为、`heal_environment`（先用可丢弃测试模组验证）。
4. 用真实游戏目录跑 `scripts/real-env-check.ps1`（HANDOFF P0，已积压最久）。
5. 重新 `tauri build`，替换 `release/` 里的旧 exe（当前便携包不含全部新 UI/功能）。

### 0.8 — 结构期（Profile 与可维护性）

1. 状态层迁移（ADR-002）+ Profiles（ADR-003）。
2. `lib.rs` → `commands/` 拆分；`App.tsx` → Provider 拆分。
3. 统一事件 envelope（ADR-005），任务中心接入。
4. 整合包集合清单报告：缺失模组 / 版本不匹配 / 冲突预报告（HANDOFF P3 的后半部分）。

### 0.9 — 分发期

NSIS + 代码签名 + updater（ADR-007）；「拖 exe 进虚线面板解析路径」（Tauri 原生 drag/drop）。

### 1.0 — 验收期

真实环境全量验收清单（`docs/REAL-ENV-TEST.md`）跑完；500+ 模组压测确认虚拟滚动无掉帧；对外可用的首个正式版。

### 1.1+ — 扩展期（全部为数据级扩展点）

主题 JSON 包（ADR-006）、诊断规则包；**评估**多游戏支持——若做，Rust core 的 domain 层已按游戏无关方式组织，主要工作是 layout 嗅探与路径规则抽象；若数据不支持，明确说不做。

---

## 5. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 旧部署记录无 size/mtime 指纹，体检精度不完整（夜班已知项） | 中 | 引导用户对老模组「强制重新部署」；0.8 迁移时不尝试伪造指纹 |
| Profile 切换的原子性在真实游戏目录（UAC、只读卷）下可能出现部分撤除失败 | 高 | 切换前先跑 environment 体检；失败路径必须是「回到切换前」，不是「尽力而为」 |
| 沙箱/ACL 类环境问题反复出现（Cargo.lock、core-tests 20 项失败同源） | 中 | 0.7.x 优先解决；为 CI 准备一个「正常权限」的构建环境定义 |
| 文档与代码脱节（HANDOFF 已落后一个迭代） | 低 | 约定：每完成一个功能包，同步更新 HANDOFF.md 的模块清单，30 分钟内完成 |
| DPAPI 密钥换机不可迁移（设计使然） | 低 | 保持现状；UI 明示「换机需重新填写」 |

---

## 6. 下一步 48 小时行动清单

1. 修复项目目录 ACL，恢复 `src-tauri/Cargo.lock`，验证项目内直接编译（停用 ncl-build 副本）。
2. 正常权限环境跑 `core-tests`，把「真实基线」写回 `NIGHT_SHIFT_REPORT.md` 或新开 `TEST-BASELINE.md`。
3. 真机三项验收（熔断 / repair / heal）+ `real-env-check.ps1`。
4. 重打 exe，替换 `release/` 旧包。
5. 上述完成后，按第 4 节启动 0.8 的状态层设计（先写 ADR-002/003 的完整版再动代码）。

---

*本文档基于接手时点的代码实读产出；所有决策在实施前应先落成完整 ADR 并经确认。*
