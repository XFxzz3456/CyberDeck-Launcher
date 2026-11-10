# 加载顺序自动整理（一键整理 / AI 整理）— 设计方案

> 提出：2026-11-10 23:12（用户提问：「能否软件自带一键整理顺序或者 AI 整理？先看看如何实现」）
> 状态：**已落地（2026-11-10 23:5x，1.7.0）**。原文保留设计推演过程，实施后的偏差与实盘数据记在 §4 / §8 / §10。
> 读法：§1–§3 是当时的判断，§4 之后已按实盘结论回改；两者冲突时以 §4 为准。

## 1. 结论先说

能做，但**不能做成「点一下就得到最优顺序」**——CP2077 的 archive 顺序不存在公认的最优解，也没有 LOOT 那样的社区 masterlist。可做的是三件事：

1. **规则整理（离线、确定性、可解释）**：框架前置 + 冲突对定向 + 其余保持原相对顺序。这是有价值的部分，覆盖「排得乱」的真实痛点。
2. **锁定保护**：用户手拖过的行不被自动整理推翻。
3. **AI 建议（可选增强）**：让模型只输出**相对约束**（谁该在谁之后），不输出全量顺序；约束必须过后端校验器才生效。

**优先级建议（依据 §2.5 实盘数据）**：先做规则整理（P1）。AI 那条链的边际收益比预期低——真正需要判断方向的 archive 冲突当前只有 2 组，投入一整套 AI 链路换 2 组判断不划算；等规则版上线、用户实际用一段时间后再决定 P3 是否值得做。

> **后续**：用户 2026-11-10 决定三层一次做完（「全都改吧，加上 AI 的」），P3 已实施并带完整降级路径，因此本条优先级建议作废。另外第 1 条里的「冲突对定向」经实盘验证无效，已从实现中删除（§4）。

不建议做「AI 直接吐一份 158 行顺序」——不可验证，出错的代价是玩家进游戏发现贴图错乱却找不到原因。

## 2. 先厘清语义（这决定了功能能做到什么）

`loadorder.rs` 现有事实：

- 只收集**已启用**模组的 `.archive`（`deployed_archives`），顺序存 `state.load_order`（元素是 archive 相对路径，不是 mod id）。
- 写进游戏 `archive/pc/mod/modlist.txt` 的**行序即加载顺序**；界面上的口径是「越靠上越早加载，后加载覆盖先加载」。
- 已经做了两件对的事：`normalized_order` 保证「已知项保序 + 新项按 ASCII 追加」，`is_ascending` 判断「等于游戏默认顺序就删文件不写」。

关键推论：

> **只有当两个 archive 提供同一个内部路径（同名文件）时，它们的先后才有意义。** 其余 90 多个 archive 谁前谁后，游戏结果完全一样。

所以「一键整理」的实质不是给 158 项求全序，而是：

- 给**冲突对**排出确定的、可解释的相对顺序（截图那次是 64 条文件级冲突，其中 4 条来自未启用暂存模组）；
- 给其余项一个**稳定基线**（框架在前、其余沿用当前相对顺序），让列表看起来不像随机堆放；
- 不推翻用户已经手排好的成果。

## 2.5 实盘数据（2026-11-10 23:20，直接读 `release/cyberdeck-data/launcher-state.json`）

| 指标 | 数值 |
| --- | --- |
| 库内 mod | 251 |
| 已启用 archive | **162** |
| `loadOrder` 已记录 | 158（余 4 项由 `normalized_order` 按 ASCII 补齐） |
| 界面「64 个文件级冲突」 | 计的是 `liveConflicts + pendingConflicts` 的条目数（同一 target 撞 3 个 mod 即 3 条） |
| 启用态撞车 target | **43** |
| └ `.archive` | **4**（`chipwareexpansion` 1 组、`lizziesbds` 3 个文件 1 组） |
| └ `.reds` | 15 |
| └ `.lua` | 19 |
| └ `.xl` / `.html` / `.json` / `.yaml` | 5 |
| 与 ASCII 顺序一致的最长子序列 | 78 / 158 → **80 项不在 ASCII 基线位置上** |

这份数据把功能边界钉死了：

1. **「列表乱」是真的**：158 项里 80 项不在默认基线上，框架位置也没有保证——整理有实际价值。
2. **「顺序能解决冲突」是假的**：只有 4 个 `.archive` 撞车受 `modlist.txt` 行序影响。剩下 39 个 target 是 `.reds` / `.lua` / `.xl` 这类脚本与配置文件的覆盖，由**部署顺序**或框架自身加载机制决定，怎么拖 archive 顺序都没用。
3. 所以这个功能的正确定位是：**让「谁覆盖谁」变得可解释、让列表不再是随机堆放**，而不是「一键消灭 64 条冲突」。界面上如果暗示后者，用户点完发现冲突数没变会直接失去信任——文案需要写明「仅 archive 类冲突受加载顺序影响」。

> 顺带记一条副产品需求：那 39 个脚本/配置冲突目前只告诉你「撞了」，没说「谁盖了谁」。要解决它们，需要的是**部署覆盖顺序**或「保留哪个版本」的选择器，属另一条功能线（与 load order 无关），不在本文范围。

## 3. 现有数据够不够

| 需要的输入 | 现状 | 结论 |
| --- | --- | --- |
| archive 列表与当前顺序 | `LoadOrderView.archives` / `state.load_order` | ✅ 有 |
| 冲突对（谁和谁撞在同一个 target） | `installer::collect_conflicts` → `ConflictInfo{target, modId, otherModId, pending}` | ✅ 有，且已按无序对去重 |
| 冲突是否来自未启用模组 | `ConflictInfo.pending` | ✅ 有（整理时必须排除） |
| 父级/汉化包关系 | `is_parent_child`（汉化包覆盖父级不算冲突） | ✅ 有 |
| 模组分类 / 是否框架 | `ModEntry.category` + `ai::is_framework_name` | ✅ 有 |
| 安装/更新时间 | `ModEntry.installed_at` / `updated_at` | ✅ 有 |
| **mod → mod 依赖** | `deps::build_report` 只把声明依赖映射到**框架**，不建 mod 间关系 | ❌ 缺，需补 |
| 谁覆盖谁（方向） | 无。冲突只说明「撞了」，不说「谁该赢」 | ❌ 本质上不可知 |

两处缺口决定了功能边界：**方向必须由策略或用户给出，不能靠计算得出**。

## 4. 三层设计

### L1 规则整理（默认，无网络，毫秒级）

算法（纯函数，`loadsort.rs`，输入只有内存数据）：

1. **清洗**：剔除未启用/未部署项，`pending` 冲突不参与排序。
2. **按 MOD 分组**：同一 MOD 的多个 archive 视为一个**不可拆的组**，整组一起移动、组内顺序不变。否则 mod 内部文件顺序被打散，症状比乱序更难查。
3. **分层**：
   - `T0 框架/核心`：`is_framework_name` 命中，或 category 为「框架」→ 永远最前（框架的 archive 被后加载的东西覆盖必炸）。
   - `T1 其余`：拓扑排序（AI 给的相对约束作为高优先级边）→ 无约束处按 `filename` ASCII 兜底，保证「同一输入永远得到同一输出」。
4. **pin 分段**：已锁定的 MOD 保持原位，把列表切成若干自由段，L1 只在段内重排，最后拼接。
5. **反环保底**：拓扑排序出现环（AI 给了互相矛盾的约束）时强制出队并记 warning，绝不进入死循环。

> **与初稿的重大偏差（实盘验证后改的）**：初稿第 4 步写的是「冲突定向」——按 `installed_at` 让新模组排后来覆盖旧的。实测发现这个前提不成立：CP2077 的**同路径覆盖在部署阶段就已经决出胜负**（磁盘上只剩一份文件，`modlist.txt` 里也只有一行），此时改行序不产生任何效果。162 个 archive 里只有 4 个 archive 级同路径撞车，其余 39 处撞车全在 `.reds` / `.lua` / `.xl`，归属由**部署覆盖**决定，与加载顺序无关。
>
> 所以冲突段现在**只统计、只提示、不重排**：预览条上写明「另有 N 处重合是同一路径被多个 MOD 部署，由部署顺序决定，调整加载顺序不会改变它们」。宁可告诉用户「这个按钮治不了这个病」，也不做看起来有效实则无效的重排。

输出：

```rust
struct LoadOrderSuggestion {
    mode: String,                  // "rules" | "ai"
    order: Vec<String>,            // archive 相对路径，最终顺序
    moves: Vec<OrderMove>,         // { id, from, to } 只列真正动了位置的
    reasons: Vec<OrderReason>,     // { kind, note, subjects }
    skipped: Vec<String>,          // 被锁定或数据不足而未动的项
    ai_used: bool,
    ai_note: Option<String>,       // AI 降级原因 / 约束被丢弃的原因
    pending_conflicts: usize,      // 来自未启用模组的冲突数，未纳入排序
}
```

**可解释性是硬要求**：每一处移动都要能回答「为什么」。`reasons` 的 kind 目前有四种：`framework`（框架前置）、`ai`（AI 给出的相对约束）、`fallback`（ASCII 兜底）、`deployConflict`（同路径部署重合，不重排只提示）。UI 用 `<details>` 展开逐条列出——不用右侧抽屉，因为窄窗口下抽屉会把列表挤没。

### L2 锁定（pin）

`state.load_order_pins: Vec<String>`（存 mod id，避免 archive 改名失效）。

语义：**pin 住的 MOD 位置不动**，把列表切成若干自由段，L1 只在段内重排。写入前过滤未知 id 并去重，防止卸载后残留的 id 长期占位。

UI：每行右侧一个图钉图标（`Pin` / `PinOff` + `aria-pressed`），点亮即锁。已锁的图钉**常驻可见**，不随悬停淡出——否则「我锁了哪几个」只能挨行悬停去找。

### L3 AI 建议（可选，需已配置模型）

不做全量输出。给模型的输入（`build_ai_brief`）只含必要子集，最多 220 条：

- 框架清单（明确告知「这些不能后置」）
- 按当前顺序的全部已启用 MOD：名｜分类｜描述摘要（80 字）｜安装时间
- 一句明确约束：**同路径重合不要作为排序依据**（否则模型会一本正经地按文件重合去排，而这件事对结果无效）

要求输出相对约束：

```json
{
  "rules": [
    { "before": "GoneAway.archive", "after": "Gone_Away_Better_Partner.archive", "reason": "前者是基础版，后者是补丁" }
  ],
  "notes": ["无法判断 X 与 Y 的关系，建议保持现状"]
}
```

**五道校验（任一不过就丢弃该条并记 warning，不整体失败）**：

1. 两端必须能映射到当前已部署的 archive：依次尝试 archive 路径 → 文件名 → MOD 名（大小写不敏感）。
2. 增量拓扑检测不能成环（`would_cycle`）。
3. 不能把框架项排到非框架项之后（框架出现在 `after` 一侧直接丢弃）。
4. 条数上限 `MAX_AI_RULES = 200`，防灌水；超出部分按顺序截断。
5. 解析前先剥掉代码围栏（模型习惯 ```json 包裹），解析失败不抛错。

没有单独一条「不能拆分 MOD 组」的校验：边是加在**组**之间的，组本身不可再分，天然满足。

AI 不可用（未配 key / Ollama 未起 / 超时 / 返回非 JSON）时**静默降级到 L1**，不报错打断流程，只在预览条上标一句 `ai_note`。请求参数：`temperature 0.0`、`max_tokens 1500`、优先 `json_object`，失败退回纯文本解析。

AI 的真实价值在「读名字和描述判断这是补丁还是大改」，比纯规则略准；但它给不出可验证的全序，所以只当建议源，不当执行者。

## 5. 命令契约与数据结构

新增两条（不改造 `save_load_order`，保持既有链路稳定）：

```rust
#[tauri::command] fn suggest_load_order(
    app: tauri::AppHandle,
    ai: Option<bool>,           // true 时走 L3，失败降级到 L1
) -> AppResult<LoadOrderSuggestion>;

#[tauri::command] fn set_load_order_pins(
    store: State<'_, Store>,
    pins: Vec<String>,          // mod id
) -> AppResult<LoadOrderView>;
```

`suggest_load_order` 里没有 `strategy` 参数：三策略（newer-wins / preserve / manual）随「冲突定向」一起删掉了，只留 `mode` 回显是规则还是 AI。少一个参数就少一处前后端对不齐。

读快照用 `app.state::<Store>().snapshot_data()` 拿**克隆**，避免在 `spawn_blocking` 里跨线程持有锁；AI 调用本身在 `spawn_blocking` 内执行（`ai::` 是 reqwest blocking）。

应用顺序**不新增命令**：前端拿到 `suggestion.order` 后调现有 `save_load_order(order)`——它已经负责「校验未部署/重复 → 写 state → 可选写 modlist.txt → 同步 Vortex」。这样整理和手动拖拽走同一条落地链路，不会出现两套写入逻辑。

## 6. UI 交互

加载顺序页顶部（现有「写入游戏 modlist」左侧）加两个按钮，不做下拉菜单——只有两种来源，下拉反而多一次点击：

```
[ ✦ 一键整理 ]  [ ✨ AI 建议 ]  [ 写入游戏 modlist ]
```

点击后**不立刻落盘**，先出预览条（列表同步按建议顺序重排，但不写 state、不写 `modlist.txt`）：

```
✦ 将移动 12 项                              [ 应用 ]  [ 放弃 ]
  另有 25 处重合是「同一路径被多个 MOD 部署」… 由部署顺序决定
  ▸ 查看依据（14 条）
```

- 依据用 `<details>` 展开，逐条列 `kind` 标签 + 说明，按 kind 上色（框架=青、AI=品牌色、部署重合=红、兜底=灰）。
- 「放弃」把列表还原到预览前的 `snapshot.loadOrder.archives`，不落盘。
- 应用走 `save_load_order`，成功后进入既有保存流程。
- 保存中 / 求建议中禁用两个按钮（复用 `saving`，新增 `suggesting`）。
- 建议里出现已不存在的项（期间卸载过）时**不预览**，提示重新点一次，而不是展示一个少行的列表。

行内新增：图钉（锁定）、来源角标（仅冲突行，沿用既有 `inline-conflict`）。


## 7. 边界与风险

| 场景 | 处理 |
| --- | --- |
| 冲突来自未启用暂存模组（`pending=true`） | 不参与排序，只在预览条注明「N 条冲突来自未启用模组，未纳入」 |
| 汉化包覆盖父级文件 | `installer::parent_links` 判父子，不算冲突（见 §10.3） |
| 同一 mod 多个 archive | 视为不可拆组，整组移动 |
| 同路径被多个 MOD 部署 | 顺序无效（部署阶段已定胜负），只统计提示、不重排 |
| 目录里的未托管 archive（`deployed=false`） | 排除，且 `save_load_order` 本来就会拒绝未知项 |
| REDmod 顺序 | 本次不做。RedMod 是 mod id 级、且改顺序要重跑 redMod 部署（几秒），另开一条设计 |
| Vortex 接管中 | `save_load_order` 已会 `vortex_apply`；若 `vortex_guard` 拦截，沿用现有报错提示，不绕过 |
| 用户在预览态改了别的模组状态 | 应用前由 `save_load_order` 重新校验，失败则提示重新整理 |
| 162 项规模 | 纯内存 <10 ms；AI 一次请求 2–4 s，需 loading 态 |

## 8. 落地情况

原计划分三次提交（P1 规则 / P2 锁定 / P3 AI），用户 2026-11-10 明确「全都改吧，加上 AI 的」，因此**一次做完三层**，提交时按后端 / 前端 / 文档拆开，保持「一次提交只做一件事」可回退：

| 层 | 文件 | 状态 |
| --- | --- | --- |
| L1 规则整理 | `src-tauri/src/loadsort.rs`（新建，≈1100 行，15 条单测） | ✅ |
| L2 锁定 | `schema.rs` `load_order_pins` + `set_load_order_pins` + 行内图钉 | ✅ |
| L3 AI 建议 | `ai.rs` `ORDER_SYSTEM_PROMPT` + `suggest_order_constraints` + `parse_constraints` 五道校验 | ✅ |
| 命令 | `suggest_load_order` / `set_load_order_pins`（166 条命令契约对齐） | ✅ |
| 前端 | `LoadOrderView.tsx` 预览条 / 依据 `<details>` / 图钉；`styles.css` 对应样式 | ✅ |
| 词条 | `loadOrder.*` 新增 19 条 | ✅ |

门禁结果：`cargo test --lib` 364 passed / 0 failed；`check-commands` 166/166；`check-i18n` 0 处待收敛；`gate --fast` 全绿。

## 9. 明确不做的事

- 不做「云端 masterlist / 社区共享排序」——没有数据源，也没有维护人力。
- 不让 AI 直接写 `modlist.txt`，也不让 AI 输出全序。
- 不改 `normalized_order` 的既有语义（未知项按 ASCII 追加）——它是多条链路共用的不变式。
- 不把 archive 顺序与 REDmod 顺序混成一个列表。
- 不做「冲突定向 / newer-wins 策略」——§4 已说明为什么它无效。

## 10. 同一批次附带的两个修复

### 10.1 WebView2 原生右键菜单

WebView2 默认在页面上右键会弹出「返回 / 刷新 / 另存为 / 打印 / 检查 / 创建 QR Code / 全选」，既盖住应用自己的右键菜单，也把一个桌面应用做成了「像浏览器」的观感。

处理：`src/lib/nativeMenu.ts` 在 **capture 阶段**挂 `contextmenu` 监听并 `preventDefault()`。

- 用 capture 而不是冒泡：要在 WebView2 内部处理器之前拦下来。
- 只 `preventDefault`，**不** `stopPropagation`：否则 React 的 `onContextMenu`（应用自己的右键菜单）也收不到事件。
- 输入框（`input` / `textarea` / `contenteditable`）放行，保留系统级剪切复制粘贴菜单。
- 顺手拦 `F5` 与 `Ctrl+R`：桌面应用里误按刷新会丢掉未保存的界面状态。

### 10.2 汉化包覆盖父级被误报为冲突

现象：加载顺序页显示「64 个文件级冲突」，其中 35 条是汉化包覆盖它自己父级 MOD 的文件——这是汉化包的**正常工作方式**，不是冲突。而实盘 8 个汉化包的 `parentModId` **全是 `None`**，所以原有的显式父子判定一条都没命中。

处理（`installer::parent_links` 重写）：

1. 显式 `parent_mod_id` 优先（原逻辑保留）。
2. 否则对**名字像汉化包**的已启用 MOD 自动认父：名字前缀命中（双方 ≥3 字符，如 `Audioware` / `Audioware CN`），或满足下面的严格覆盖条件。
3. 覆盖条件必须「两头都严」：`shared == 汉化包自己的文件数` **且** `父级文件数 > 汉化包文件数`。

第 3 条是刻意收紧的：如果只要求「重合比例过半」就认父子，那么「只翻一个文件、恰好撞到一个无关的单文件 MOD」也会被认成父子，**真冲突就被藏起来了**——误判比漏判更糟。

实测效果：自动认父 6 个（Audioware / Authentic Shift / DigitalVixenCore / Immersive Third Person / Immersive V Dialogue Expanded / RedTweakDB），启用态冲突 **60 条 → 25 条**，被正确忽略 35 条；保留的 25 条里仍有 Lizzie's Braindances、Chipwareexpansion、Night City Traffic Overhaul 等真冲突。三条单测锁住行为：`translation_pack_over_parent_is_not_a_conflict`、`unrelated_overlap_is_still_a_conflict`、`single_file_translation_hitting_unrelated_mod_stays_conflict`。

