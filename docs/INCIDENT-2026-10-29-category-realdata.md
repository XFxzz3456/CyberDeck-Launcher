# INCIDENT 2026-10-29 · 分类引擎在真实库上失效（连写句柄 + 并列决胜反向）

> 关联：`CHANGELOG.md` 0.9.0-r23「四之补」、`HANDOFF.md` r23 真实库校准段、`src-tauri/src/category.rs`。

## 现象

玩家库 195 个模组，**168 个被归到「工具」**（截图可见，视觉 11 / 框架 7 / 玩法 5 / 任务 2 / 车辆 1 / 音频 1）。

## 真因（第一层，已修）

`infer_category(description, name, folder)` 把 **description 拼进了关键词海**。
195 个模组里绝大多数是「收编」（从 Vortex 接管的），它们的 description 是同一句模板：

> 由外部**工具**（如 Vortex）部署、经「收编」纳入启动器管理。

模板里有「工具」二字 ⇒ 关键词命中「工具」⇒ 168 个一起进去。
分类器看的是**我们写的那句说明**，不是模组本身。

**修法**：新 `category.rs`，输入只有 `name` / `folder` / `plannedFiles`，description 彻底退出（`Signals` 结构体里根本没有这个字段，`check-category.mjs` 静态守卫断言所有 `Signals{...}` 块不许出现 description）。

## 真因（第二层，本轮才抓到）

第一层修完，单测 9/9 全绿、代码也「看起来对」，但把真实库喂进去才发现：**它并没有判对，只是从「一起错」变成「一起空」**。

### 2a. 收编模组的名字是连写句柄

真实库里 `plannedFiles` 全是 `archive/pc/mod/*.archive` —— 内容证据层（character/、weapon/、.reds）**在收编库上没有区分度**，唯一能用的信号是名字。而名字长这样：

```
compactweaponmodslots
alwaysfirstequip
npc-silverhand
weaponsimproved_grenades
```

原来的 `haystack_has` 是**整词匹配**（为防 `cet` 命中 `cetocide`、`car` 命中 `cargo` 而设计）——对上面这种没有任何分隔符的名字，一律落空。实测 **169/195 判不出来**。

**修法**：`word_hit` 按词长分层。

| 词长 | 匹配方式 | 理由 |
|---|---|---|
| `>= 5` | 子串 | `weapon` 必须能在 `compactweaponmodslots` 里被发现 |
| `< 5` | 整词 | `cet` / `gun` / `hud` / `car` 放开就会命中 `cetocide` / `gunpowder` / `cargo` |
| 中文 | 子串 | 中文没有词边界 |

### 2b. 并列决胜方向是反的

文档写的是「并列按 `CATEGORY_ORDER` 靠前者胜」，代码却是：

```rust
CATEGORY_ORDER.iter().filter_map(...).max_by_key(|(_, v)| *v)
```

**`max_by_key` 在并列时返回最后一个最大值**，正好相反。真实反例：

> `Disappearing NPC and Vehicle Fix (Crowd LOD spawn distance)`
> 同时命中 玩法(spawn) / 车辆(vehicle) / 视觉(lod) / 任务(npc)，各 3 分
> ⇒ 被判成「任务」（顺序里最靠后的那个），应为「玩法」。

**修法**：顺序扫描，**严格大于**才替换 `best`；补单测 `ties_resolve_to_the_earlier_category`。

## 走过的错误假设

1. **「单测全绿 = 修好了」** —— 耗时最长的一条。9 个单测都是我自己构造的样本，样本里名字带空格、路径带目录层级，恰恰绕开了真实数据里最脏的两种形态（连写句柄、扁平 archive 路径）。
2. **「内容证据优先就够了」** —— 设计时把 6 分权重给了 `plannedFiles`，以为它是可靠信号。真实库里它是 `archive/pc/mod/名字.archive`，**等于把文件名又抄了一遍**，没有额外信息。
3. **「词表再补点词就行」** —— 一度想把 `amm` / `sp0` / `nova` 写进词表。那是拿这一库数据过拟合：换个人装别的模组就全错。**词表只收通用词，品牌句柄不进。**
4. **把 `max_by_key` 当成「取第一个最大」** —— 这是 Rust 里很容易记反的一条，而且没有任何警告。

## 可执行规则（下次直接照做）

1. **规则类改动，必须有一份「真实数据快照」跑一遍**。为此留下诊断入口：
   ```bash
   CDL_DIAG_STATE=<launcher-state.json> cargo test --lib diagnose_real_library -- --ignored --nocapture
   ```
   只打印「名字 → 分类」+ 分布，**不写盘**；`#[ignore]` 保证 CI 不受影响，也保证它不会被当成正式测试。
2. **改完判定逻辑，先看分布再看抽检**：分布用来发现「一起倒向某一类」，抽检用来发现「个别离谱」。两样都要。
3. **要写用户数据时，先证明等价再动手**：本次流程 = 导出 Rust 逐条判定 → 与 Rust 同构的脚本复算 → **195/195 完全一致才写盘**（不一致就退出）→ 写前备份 `launcher-state.pre-r23.json`。不做「差不多就行」。
4. **`max_by_key` / `min_by_key` 并列语义要显式验证**。要么用 `max_by_key` + `Reverse`，要么自己写循环 + 严格比较；别靠记忆。
5. **短词/长词分层匹配**：ASCII 词表里混着 `cet`（3）和 `weapon`（7）时，一律按词长分层，别问「要不要整词」这种二选一。

## 诊断手法（可复用）

- **分布对比**：`Group-Object category` 一眼看出倒向。
- **抽检**：把某一类的全部条目打印出来逐条读（21 条任务全部读了，才发现并列决胜问题）。
- **反例驱动**：一旦发现某条判错，先找「它命中了哪几类」，而不是直接改词表——`Disappearing NPC…` 就是这么暴露 `max_by_key` 的。

## 修复后结果（195 个模组）

| | 工具 | 其他 | 任务 | 玩法 | 视觉 | 服装 | 框架 | 武器 | 车辆 | 音频 |
|---|---|---|---|---|---|---|---|---|---|---|
| 修复前 | 168 | 0 | 2 | 5 | 11 | 0 | 7 | 0 | 1 | 1 |
| 修复后 | **0** | 132 | 21 | 17 | 8 | 5 | 5 | 4 | 2 | 1 |

## 遗留（明确不做的部分）

- **132 个「其他」不再自动猜**。`amm_props`、`###-novalut4`、`_0sp0_natural_breast` 这类纯句柄，名字里没有任何语义。硬猜就是制造新的「168 个工具」。
- 出路有两条：① 右键「修改分类」手动归属（已上线，写入即 `category_locked`，此后自动重算跳过）；② **Nexus 分类反查**（`nexus.modId` 库里已有，需要 API Key + 195 次请求 + 缓存），登记为 0.9.1 待办。
- 归类的本质是「知道这个模组是什么」，不是「名字里有什么词」。要再进一步，就得引入外部元数据，而不是继续堆关键词。
