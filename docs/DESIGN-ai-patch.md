# AI 补丁生成（AI Patch）设计边界

- 状态：**已实现 v1**（2026-10-31，`src-tauri/src/aifix.rs`；见下方「实现落地说明」）

> **实现落地说明（2026-10-31）**：v1 已落地 G1 结构校验（模块名 / `@wrapMethod|@replaceMethod` / 括号配平 / 危险 API 黑名单 / 400 行上限）、用户确认门、独立 `AIFix_*.reds` 写入与单独撤销；**G2 编译校验未接入**（无 redscript 编译器集成），报告里明确 `compiled:false`，不宣称已验证。
- 日期：2026-10-30
- 适用范围：CyberDeck Launcher 的「AI 诊断 → 生成 redscript 覆盖补丁」模块。本文只定边界、接口与交互，不含实现，不接真实 API。

## 1. 设计原则

核心约束只有一条：**AI 产出的东西是「额外的补丁层」，不是对他人作品的修改。**

不可协商的不变量：

| 编号 | 不变量 | 违反后果 |
| --- | --- | --- |
| P1 | 只生成覆盖补丁，绝不写入、重命名、移动原 `.reds` | 破坏作者资产；不可回滚 |
| P2 | 绝不修改原 `.archive`（不重打包、不替换、不删除条目） | 文件校验和失配，Nexus 更新覆盖，无法还原 |
| P3 | 补丁一律独立成文件，命名 `AIFix_<mod>_<hash8>.reds` | 无法与作者文件区分，卸载时误删 |
| P4 | 产物落在独立分类 `AIFixes/`，可一键全部撤销 | 用户无法判断哪些文件是 AI 加的 |
| P5 | 应用前必须弹窗明示风险，且手动勾选确认 | 责任边界不清，用户以为作者背书 |
| P6 | 校验不通过就不落地，不留半成品 | 半成品会导致游戏启动崩溃且难定位 |

风险弹窗文案（固定，不随服务商变化）：

> 此补丁由 AI 分析生成，非原作者发布，可能引发新 Bug。应用后请重新进入游戏验证；若出现异常，请在「AIFixes」中卸载本补丁。

勾选框文案（必须手动点击，不接受默认勾选、不接受「本次会话不再提示」）：

> 我已了解风险并同意应用

## 2. 分析阶段

**输入（三样，缺一不可）：**

1. 冲突报告：来自 `diagnostics.rs` / `compat.rs` 的结构化结果——冲突双方 Mod、目标类名与方法名、冲突类型（重复定义 / wrap 顺序 / 缺失方法 / tweak 覆盖）。
2. 相关 `.reds` 文本：**只取冲突函数周边的裁剪片段**，不是整文件。
3. 目标游戏版本（`game.rs` 检测结果）+ 相关框架版本（redscript / RED4ext）。版本决定 API 签名，缺版本号时 AI 输出不可信。

**上下文裁剪规则：**

- 以冲突报告给出的 `类名.方法名` 为锚点，向上下各取 N 行（默认 60，硬上限 150），按函数边界对齐，不切断花括号。
- 一个请求最多包含 2 个 Mod × 1 个锚点；命中多锚点时串行多次请求，不合并成大 prompt。
- 片段之外只允许附带：文件相对路径、`@wrapMethod`/`@replaceMethod` 注解行、父类名。
- 去掉注释中的个人信息、作者邮箱、本地绝对路径（含 Windows 用户名）。
- 单次外发总字符上限定为 20K（含系统提示），超限直接裁剪，不重试放大。

**隐私边界：**

- 默认关闭。用户必须在「设置 → AI」中显式开启「允许将 Mod 脚本片段发送给 AI 服务」，并二次确认外发范围（行数上限明示）。
- 未开启时，分析按钮置灰，tooltip 指向设置项，不做"先试一次"的引导。
- 只走用户自配端点（自建 / Ollama / 商业 API），不内置任何默认公网端点，不代持密钥。
- 请求体不写入日志；日志只记「请求了哪个 Mod、多少字符、耗时、结果码」。

## 3. 生成补丁阶段

### 3.1 注解选择

| 冲突形态 | 允许的注解 | 说明 |
| --- | --- | --- |
| 需要在原逻辑前后加判断，原实现仍须执行 | `@wrapMethod`（首选） | 保留 `wrappedMethod()` 调用链，出错时影响面可控 |
| 需要在原逻辑之前提前返回，且不能执行原实现 | `@replaceMethod` | 等于抹掉作者行为，默认关闭，需单独开关 |
| 目标方法在原 Mod 中不存在（调用方引用了未提供的方法） | `@addMethod` | 只补缺失成员，不动既有逻辑 |
| 类被另一 Mod 整体重定义 | 不允许 | 任何注解都会改变类结构语义 |
| 冲突在 `.archive` 资源层 | 不允许 | 越界，见 P2 |
| 冲突在 `.tweak` / `.csv` 数值表 | 不允许 | 本模块不做数值补丁 |

`@wrapMethod` 与 `@replaceMethod` 的取舍不是风格问题，是责任问题：wrap 出错时最坏结果是功能异常但原逻辑还在；replace 出错时原逻辑已被绕过，故障表现会远离补丁文件本身。因此**默认只允许 wrap 与 add**，replace 需要用户显式打开「允许替换方法体」并在弹窗中二次标注。

### 3.2 为什么不允许直接覆盖原文件

- 原文件是作者资产，覆盖即改写，卸载补丁无法还原（除非保留完整副本，那又变成第二份存档负担）。
- 覆盖后文件校验和与 Nexus / 作者发布版本不一致，后续更新会静默冲突。
- 用户无法在同一次会话里对比"作者原本写了什么"。
- 一旦 AI 判断错误，错误混进作者文件，问题定位成本从"删一个补丁"变成"重装一个 Mod"。

### 3.3 命名与加载顺序

- 文件名：`AIFix_<modSlug>_<hash8>.reds`；`hash8` = `sha256(conflictId + parentVersion + patchBody)` 前 8 位，保证同一补丁可复现、不同补丁不撞名。
- 目录：`r6/scripts/zz_CyberDeckAIFixes/`（REDmod 场景下映射到对应 mod 目录的 `scripts/` 子路径）。
- 顺序要求：补丁必须**在原 Mod 之后**参与编译，否则 wrap 会包在错误的一层。
  - REDmod 路径：在 `modlist.txt` 中插入到父 Mod 条目之后一行；父 Mod 不在列表时追加到末尾并提示。
  - redscript 路径：依赖 `zz_` 目录前缀保证字典序遍历靠后。
  - **该顺序假设必须在实现前实测确认**（两种部署路径各测一次），未确认前不得宣称"顺序安全"。
- 同名补丁已存在时：不覆盖，先生成新 hash 文件，旧文件在应用成功后清理（见 4.3）。

## 4. 校验阶段

### 4.1 三道闸门

任一失败即终止，**不保留产物**。

| 闸门 | 手段 | 判定 |
| --- | --- | --- |
| G1 结构 | 内置检查：必须是单一 `.reds` 文件、只含允许的注解、无 `import`、无文件 IO、无网络、无 `exec` 类调用、类名与方法签名必须出现在分析阶段的上下文中 | 任一不符 → `E_PATCH_SHAPE` |
| G2 语法 / 语义 | redscript 编译器（框架随包的 `redscript-cli` / `scc`）对「原脚本目录 + 补丁」整体编译 | 非零退出 → `E_LINT_FAILED` |
| G3 交叉 | WolvenKit 的脚本校验（可选，检测到 CLI 时启用） | 报错 → 降级为警告并阻断应用 |

- G1 是白名单，不是"尽力而为"：AI 输出里出现上下文之外的标识符，直接判失败，因为那意味着它在猜 API。
- G2 必须带原脚本一起编译，单独编译补丁文件没有意义（引用全在外部）。
- 编译器未检测到：不静默放行，返回 `E_LINT_UNAVAILABLE`，提示"未找到 redscript 编译器，无法校验补丁"，默认阻断。是否允许降级为 G1-only 由用户裁决（见第 10 节）。

### 4.2 失败时的行为

- 立即删除临时文件与刚写入的目标文件，`AIFixes/` 下不残留任何本次产物。
- 不写 `modlist.txt`，不改任何状态字段。
- UI 统一提示：**「AI 无法解决此冲突」**，附失败阶段与错误码，附「查看详情」折叠区（原始错误输出，脱敏后）。
- 不自动重试、不换模型重试、不放宽校验重试。重试由用户手动触发，且进入下一轮时上下文按 2 节重新裁剪。

### 4.3 回滚与清理

- 生成阶段所有写入先落 `data_dir/tmp/aipatch-<planId>/`，通过 G1–G3 后才原子移动到目标目录。
- 进程退出或应用崩溃：启动自检清理 `tmp/aipatch-*`，超过 24 小时的残留一律删除并记审计日志。
- 应用成功后保留一份补丁正文副本（`data_dir/aipatches/<planId>.json`），用于「查看已应用补丁」与卸载校验；只留元数据与正文，不留原 Mod 源码副本。

## 5. Rust 端接口与伪代码

> 以下均为**伪代码，未实现**。AI 调用只留 trait 桩，不接真实 API。

```rust
// 伪代码，未实现
// 放置位置：src-tauri/src/aipatch.rs（新模块），复用 ai.rs 的端点与密钥配置

pub struct ConflictContext {
    pub conflict_id: String,
    pub kind: ConflictKind,          // DuplicateMethod | WrapOrder | MissingMethod | TweakOverlap
    pub parent_mod_id: String,
    pub parent_mod_name: String,
    pub parent_version: String,
    pub target_class: String,
    pub target_method: String,
    pub game_version: String,
    pub framework: FrameworkVersions, // redscript / RED4ext
    pub snippets: Vec<ScriptSnippet>, // 已裁剪、已脱敏，<= 2 个
    pub log_excerpt: Option<String>,  // 可选，<= 8KB
}

pub struct ScriptSnippet {
    pub rel_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    pub annotations: Vec<String>,     // 仅注解行，供 G1 校验
}

pub enum PatchStrategy { Wrap, Replace, Add }  // Replace 需设置开关

pub struct PatchPlan {
    pub plan_id: String,
    pub parent_mod_id: String,
    pub status: PlanStatus,           // Ready | Rejected | Stale
    pub strategy: Vec<MethodStrategy>, // { class, method, strategy }
    pub patch_path: PathBuf,          // AIFixes/AIFix_<mod>_<hash8>.reds（未落盘时为预期路径）
    pub patch_body: String,
    pub patch_hash: String,
    pub diff: String,                 // 统一 diff，供 UI 预览，最多 200 行
    pub lint: LintReport,             // { gate: G1|G2|G3, passed, output }
    pub warnings: Vec<Warning>,       // 非阻断提示（如 replace 语义）
    pub expires_at: String,           // 绑定 game_version，版本变化即失效
}

pub struct LintReport { pub g1: GateResult, pub g2: GateResult, pub g3: Option<GateResult> }
pub struct GateResult { pub skipped: bool, pub passed: bool, pub output: String }

pub enum AiPatchErrorCode {
    AiDisabled, AiNoConsent, AiTimeout, AiBadOutput,
    PatchShape, LintFailed, LintUnavailable, CompileFailed,
    WriteDenied, ParentMissing, ParentUpdated, GameVersionUnsupported,
    PatchConflict, Cancelled,
}

pub struct ApplyReport {
    pub applied: bool,
    pub patch_path: PathBuf,
    pub uninstall_token: String,      // 用于一键撤销
    pub inserted_after: Option<String>, // modlist 插入位置
    pub backup: Option<PathBuf>,      // modlist.txt 备份
    pub message: String,
}
```

```rust
// 伪代码，未实现
pub fn analyze_conflict(ctx: &ConflictContext, ai: &dyn AiClient) -> Result<Analysis, CommandError> {
    // 前置：AI 已启用 + 用户已授权外发 + 有密钥，否则直接返回 AiDisabled / AiNoConsent
    // 1. 二次裁剪：按函数边界对齐、去注释个人信息、总字符 <= 20K
    // 2. ai.complete(system, prompt) —— 只要求它输出「定位结论 + 建议策略」，不要求写代码
    // 3. 解析为 Analysis { anchors: Vec<Anchor>, strategy_hint, confidence }
    // 4. confidence 过低 / anchors 为空 => AiBadOutput
    todo!("未实现")
}

pub fn generate_ai_patch(req: PatchRequest) -> Result<PatchPlan, CommandError> {
    // req = { conflict_id, allow_replace: bool, allow_replace_confirmed: bool }
    // 1. analyze_conflict
    // 2. 若策略含 Replace 且未获双重确认 => 返回 AiBadOutput（附原因：需用户裁决）
    // 3. ai.complete 生成 patch_body；解析失败 => AiBadOutput
    // 4. 落 tmp/aipatch-<planId>/，跑 G1 -> G2 -> G3
    //    任一失败：删除临时目录，返回对应错误码，不写任何正式路径
    // 5. 生成 diff（原片段 vs 补丁），截断到 200 行
    // 6. 返回 Ready 的 PatchPlan（此时仍未落到 AIFixes/）
    todo!("未实现")
}

pub fn apply_ai_patch(plan_id: &str) -> Result<ApplyReport, CommandError> {
    // 1. 取 plan，校验 status == Ready 且未过期（game_version 未变、父 Mod 版本未变）
    // 2. 原子移动补丁文件到 AIFixes/，备份 modlist.txt，插入条目
    // 3. 写状态：aiPatch 条目 { parentId, planId, hash, appliedAt, gameVersion }
    // 4. 失败任一步 => 逆序回滚（删条目 -> 还原 modlist -> 删文件），返回 WriteDenied / PatchConflict
    todo!("未实现")
}

/// AI 唯一入口。当前只有桩实现，不发起网络请求。
pub trait AiClient {
    fn complete(&self, system: &str, prompt: &str) -> Result<String, CommandError>;
}
```

**进度事件**：`ai-patch-progress`，payload `{ planId, stage, pct, message }`，
`stage` ∈ `reading | analyzing | generating | linting | ready | failed`。
事件名与现有 `adopt-progress` 保持 kebab-case 一致；`failed` 必带 `errorCode`，前端据此选文案。

## 6. 前端「AI 补丁确认弹窗」UI 结构

```text
AiPatchConfirmDialog  (Modal，宽 720，禁止点击遮罩关闭)
├─ Header
│  ├─ Title                  aiPatch.confirm.title          "AI 补丁确认"
│  └─ Badge "AI 生成"         aiPatch.confirm.badge
├─ RiskBanner  (警示条，常驻，不可折叠)
│  ├─ 正文                   aiPatch.confirm.riskBanner
│  └─ 补充                   aiPatch.confirm.riskBannerDetail
├─ ConflictSummary  (两列定义列表)
│  ├─ 父 Mod / 版本           aiPatch.confirm.summary.parent
│  ├─ 冲突目标                aiPatch.confirm.summary.target     "类.方法"
│  ├─ 冲突类型                aiPatch.confirm.summary.kind
│  └─ 采用策略                aiPatch.confirm.summary.strategy   wrap / add / replace(标红)
├─ DiffPreview  (只读，最大高 260，超出滚动)
│  ├─ Toolbar  展开全部 / 复制   aiPatch.confirm.diff.expand / .copy
│  └─ CodeBlock  统一 diff，新增行绿、删除行红、行号列固定
├─ LintBadge   (三枚徽标：G1 结构 / G2 编译 / G3 WolvenKit)
│  ├─ pass                     aiPatch.confirm.lint.pass
│  ├─ fail                     aiPatch.confirm.lint.fail
│  ├─ skipped                  aiPatch.confirm.lint.skipped
│  └─ 点击展开原始输出           aiPatch.confirm.lint.detail
├─ Consent  (Checkbox，默认未勾选，不接受回车提交)
│  └─ Label                    aiPatch.confirm.consent
├─ ErrorPanel  (仅失败态出现，替换 Consent 与主按钮)
│  ├─ 主文案                   aiPatch.failed.headline          "AI 无法解决此冲突"
│  ├─ 阶段 + 错误码             aiPatch.failed.reason
│  └─ 详情折叠                  aiPatch.failed.detail
└─ Footer
   ├─ Button 取消 (ghost)       aiPatch.confirm.actions.cancel
   └─ Button 应用补丁 (primary, disabled 条件见下)  aiPatch.confirm.actions.apply
```

**按钮 disabled 规则**（任一成立即禁用）：`!consent`、`applying`、`plan.status !== "Ready"`、`plan.lint` 任一闸门未通过、`plan` 已过期。

**失败态**：不显示 Consent，不显示主按钮，只留「关闭」与「查看详情」；错误码到文案的映射见第 8 节。

```ts
// 伪代码，未实现
interface AiPatchConfirmDialogProps {
  open: boolean;
  plan: PatchPlan | null;            // 失败时为 null
  failure?: { code: AiPatchErrorCode; stage: string; detail?: string };
  applying?: boolean;
  onCancel: () => void;
  onApply: (planId: string) => void;  // 只传 id，风险确认在后端再校验一次
  onOpenSettings?: () => void;        // AI 未开启时跳设置
}
```

**i18n key 约定**（前缀 `aiPatch.`，全部进 `src/i18n/zh-CN.ts` 与 `en-US.ts`，缺 key 直接构建失败）：

- `aiPatch.confirm.title` / `.badge` / `.riskBanner` / `.riskBannerDetail`
- `aiPatch.confirm.summary.parent` / `.target` / `.kind` / `.strategy`
- `aiPatch.confirm.diff.expand` / `.copy` / `.truncated`
- `aiPatch.confirm.lint.pass` / `.fail` / `.skipped` / `.detail`
- `aiPatch.confirm.consent` / `.actions.cancel` / `.actions.apply` / `.applying`
- `aiPatch.failed.headline` / `.reason` / `.detail`
- `aiPatch.stale.parentUpdated` / `aiPatch.stale.gameVersion`
- `aiPatch.uninstall.confirm` / `.done`

## 7. 生命周期与卸载

- **建模**：补丁是**附属件**，不是独立 Mod 条目。状态里记为 `entry.kind = "aiPatch"`，`parentId` 指向父 Mod，`planId` 指向补丁元数据。列表页默认折叠在父 Mod 下，`AIFixes` 仅作为筛选分类。
- **卸载父 Mod**：级联提示「该 Mod 有 1 个 AI 补丁，将一并移除」，默认勾选；不允许留下孤儿补丁。
- **父 Mod 更新**：比对 `parent_version` 与补丁记录的版本，不一致 → 补丁标记 `Stale`，列表显示黄色「需重新生成」，**不自动删除**（用户可能仍在用），但禁止再次应用。
- **游戏版本变化**：熔断。所有 `AiPatch` 条目进入 `Disabled`，启动时提示「游戏版本已变更，AI 补丁已暂停，请重新生成或卸载」。切换仅需一次，不做逐补丁判断——签名变化不可靠推断。
- **一键全部撤销**：删除 `AIFixes/` 下全部 `AIFix_*.reds`、移除 `modlist.txt` 中对应条目（先备份）、清理状态中的 `aiPatch` 条目。撤销是幂等的，重复调用返回"无补丁可撤销"而非报错。
- **父 Mod 被手动删除**：启动自检发现孤儿补丁 → 移入 `data_dir/quarantine/aifixes/`，不直接删，提示用户确认。

## 8. 失败与降级路径

| 场景 | 用户可见文案 | 系统行为 |
| --- | --- | --- |
| AI 未启用 / 无密钥 | 「AI 功能未启用，请先在设置中配置服务端点」 | 分析按钮置灰，不发起请求，附跳设置入口 |
| 用户未授权外发源码 | 「需要允许发送脚本片段才能分析，当前未授权」 | 不裁剪、不请求；引导到设置，不提供"仅本次"绕过 |
| AI 超时（> 45s） | 「AI 分析超时，未生成任何文件」 | 中止请求，清临时目录，不重试；保留冲突报告可再次手动触发 |
| 返回非法代码（结构不符） | 「AI 无法解决此冲突（输出不合法）」 | G1 失败，丢弃输出，不落盘 |
| lint 不通过 | 「AI 无法解决此冲突（补丁未通过语法校验）」 | G2 失败，删临时产物，展示编译输出前 20 行 |
| 编译报错（G2 部分成功、整体失败） | 同上，附「存在未解析的符号」 | 同上；不尝试自动修错、不二次请求 |
| 未找到 redscript 编译器 | 「未找到 redscript 编译器，无法校验补丁」 | `E_LINT_UNAVAILABLE`，阻断；不静默放行 |
| 写入被拒（权限 / 文件被占用） | 「写入失败：目标目录不可写，请关闭占用该文件的程序」 | 回滚 modlist 与已写文件，状态不变；错误带具体路径 |
| 用户导出不给权限（拒绝落盘） | 「已取消，未写入任何文件」 | 视为正常取消，无错误码，不提示重试 |
| 父 Mod 已更新 / 游戏版本变化 | 「父 Mod 已更新，补丁需重新生成」 | `Stale`，禁用应用按钮，保留卸载入口 |

统一原则：失败一律「不落盘、不改状态、不自动重试」，只提供明确下一步。

## 9. 风险与不做的事

明确不做：

- 不替换、不改写、不移动任何原 `.reds` / `.archive` / `.tweak` 文件。
- 不做数值补丁（伤害、掉率、负重等），数值修改交给用户手动或专门工具。
- 不把补丁打包进原 archive，不进原 Mod 目录树。
- 不把用户源码上传到任何未授权端点；不上传整文件，只上传裁剪后的片段。
- 不代持密钥，不内置默认公网 AI 端点。
- 不在用户未确认时自动应用补丁；不做"自动修复全部冲突"的默认行为。
- 不承诺补丁正确性，不提供"已验证可用"这类背书。

法律边界一句话：**补丁是对作者文件的旁路覆盖，不构成对原作品的再分发或改写；但它仍是衍生修改，是否合规取决于具体 Mod 的许可条款，最终由用户自行判断并承担后果。**

## 10. 待用户裁决的问题

1. **是否允许 `@replaceMethod` 语义？** 默认关闭时可用性明显下降（很多冲突只能靠 replace）。若开放，是否要求弹窗中额外标注"此补丁绕过原作者逻辑"？
2. **lint 走哪条路？** 仅内置 G1 结构白名单（不依赖外部工具，弱），还是接 `redscript-cli`（准，需用户机器上存在编译器），还是再接 WolvenKit CLI（最准，多一个外部依赖与启动成本）？
3. **编译器缺失时是否允许降级？** 现在设计是阻断。若允许"仅结构校验 + 用户自担风险"，会把风险从工具转移到用户，需明确文案。
4. **是否允许批量修复？** 一次为多个冲突生成多个补丁，会放大误判面积，也放大上下文外发量。建议首批只做单冲突。
5. **外发范围上限**：20K 字符 / 150 行 / 2 个片段，这组数字是否可接受？是否要求只允许本地模型（Ollama）才开启源码外发？
