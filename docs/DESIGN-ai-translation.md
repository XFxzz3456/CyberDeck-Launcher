# 非破坏性 AI 汉化 — 设计方案

状态：**已实现 v1**（2026-10-31，`src-tauri/src/ailoc.rs`；见下方「实现落地说明」）
日期：2026-10-30
适用范围：CyberDeck Launcher 对已安装 Mod 生成独立中文覆盖层的设计、接口与边界约定。

> **实现落地说明（2026-10-31）**：v1 只覆盖「本地化 JSON」这一条真实可验证的路径：
> 扫描 onscreens 条目（含 WolvenKit `JsonResource` 形状）与扁平 `key→text` → 词表优先 → 未命中走真实 AI → 生成 WolvenKit 格式 JSON + `.archive.xl` → **必须**用 WolvenKit CLI 打包 `.archive` 才能部署。
> 与原文的差异：① 本文档「本轮不接入真实 AI API」一条已作废，实际接的是设置里配置的 OpenAI 兼容 / Anthropic 接口；② `.archive`/`.inkwidget`/`.csv` 内的文本与 `.reds` 硬编码文本均标记为 blocked，生产路径不生成半成品；③ 虚拟条目 `AITranslations` 分类未实现，改为在 `ModEntry.ai_loc` 上登记清单，撤销即撕除；④ `TooLong` 判定用 1200 字符上限，未做 1.6 倍字节估算。

## 1. 设计原则

四条硬约束，后续实现不得绕过：

| 编号 | 约束 | 落地手段 |
|---|---|---|
| P1 | 绝不修改原 Mod 文件 | 原文件只读打开；产物写独立目录；不写回 `staging/<id>/`、不占用游戏目录中的原文件名 |
| P2 | 产物集中在独立分类 `AITranslations` | 暂存根 `staging/ai-loc/<modId>/`；部署后归属 `AITranslations`，可整体禁用/删除 |
| P3 | 启用前必须显式确认 | 生成前弹窗，勾选「已知晓此翻译由 AI 生成，非原作者发布」后方可继续；未勾选按钮 disabled |
| P4 | 可完全回滚 | 每个产物登记进 `deployed_files`，清理时按清单撕除；词表不进清理范围 |

补充约定：

- 不做进程注入、不做游戏内实时替换（与 `docs/AI-LOCALIZATION-REVIEW.md` 红线一致）。
- 本轮**不接入任何真实 AI API**：`translate` 层只定义接口与桩函数，先把 UI、打包、回滚链路跑通。
- 所有写入先过 `store::safe_join` + 越界校验；产物文件名一律带 `-ai-loc` 或位于 `ai-loc/` 下，便于人工识别与脚本枚举。

## 2. 场景一：Mod 自带 i18n JSON

### 2.1 数据流

```
读 <mod>/localization/en-us.json（只读）
  → 提取 {primaryKey, secondaryKey, femaleVariant, maleVariant}
  → 逐条送翻译层（词表命中优先，未命中走桩/AI）
  → 生成 <产物>/localization/zh-cn.json（只含已翻译键）
  → 生成 <产物>/<modId>-ai-loc.archive.xl
  → WolvenKit CLI 打包 .archive，两文件进 archive/pc/mod/，登记清单
```

原 `en-us.json` 不重命名、不改写、不删除；原 `.archive` 不动。

### 2.2 `.archive.xl` 示例

```yaml
# 伪代码，未实现。字段名需在落地前对照目标 ArchiveXL 版本核对一次。
# 文件：staging/ai-loc/<modId>/<modId>-ai-loc.archive.xl

archive:
  mount:
    - <modId>-ai-loc.archive        # 覆盖层自身的资源根

localization:
  extend:                            # 在已有语言表之上覆盖条目，而非替换整表
    zh-cn:
      - path: ai-loc/<modId>/localization/zh-cn.json
        mode: merge                  # 只接管本文件声明的 secondaryKey
  onscreens:                         # 兼容写法：目标版本不支持 extend 时降级用
    zh-cn: ai-loc/<modId>/localization/zh-cn.json
```

### 2.3 为什么 extend 而不是 replace

- replace 是整表替换：只翻 80/100 条时，剩余 20 条会变空或回退，等于破坏原 Mod 的呈现。
- extend 是按键合并：游戏本地化按 `primaryKey` 查表，同键后者胜、缺键继续向下找。未翻译的键行为与未装覆盖层完全一致。
- 支持增量与干净回滚：先出 50 条再补 50 条不必重生成全量；删掉覆盖层即回到原状，不存在「原文件已被改过」的中间态。

### 2.4 secondary key 匹配

| 情况 | 处理 |
|---|---|
| secondaryKey 与 primaryKey 均一致 | 覆盖，写入我们的条目 |
| secondaryKey 一致、primaryKey 不一致 | 原样拷贝原 `primaryKey`，不自行重算（重算会指向不存在的键，表现为文案消失） |
| 原文件缺 primaryKey | 计算后只回填到产物副本，原文件不动 |
| 两条原文 primaryKey 冲突 | 保留第一条，计入 `conflicts`，不静默覆盖 |
| 译文与原文相同（专有名词/框架名黑名单） | 不写入产物，避免无意义条目 |

以 `secondaryKey` 做 join 主键，`primaryKey` 只做一致性校验。原 Mod 换版本重算过哈希时仍能对上。

## 3. 场景二：无 i18n、文本硬编码

### 3.1 流程

```
扫描 <mod>/r6/scripts/**/*.reds
  → 词法提取字符串字面量（跳过日志、路径、资源引用、框架名黑名单），定位所属类 + 方法签名
  → 判定可拦截性（3.3）：可拦截则生成 ai-loc/<modId>/reds/<modId>-ai-loc.reds（@wrapMethod 为主）
  → 不可拦截：标记 unsupported，UI 显示「暂不支持自动汉化」
```

产物是独立新 `.reds` 文件，由 REDscript 编译期注册生效；不 append 原脚本，不替换原文件。

### 3.2 补丁形态（伪代码，未实现）

```rust
// 生成器输出的 Redscript 文本，示意形态
module CyberDeck.AiLoc.<modId>

@wrapMethod(<TargetClass>)
func <targetMethod>(<args>) -> <Ret> {
    let original: <Ret> = wrappedMethod(<args>);
    // 仅当返回值命中已翻译字符串表时替换，否则原样返回
    return AiLocOverride(<modId>, original);
}

// 仅在原方法为纯 getter、无副作用时使用
@replaceMethod(<TargetClass>)
func <targetMethod>(<args>) -> <Ret> { return "<译文>"; }
```

优先 `@wrapMethod`（保留原逻辑，只改返回值）；`@replaceMethod` 仅用于满足 3.3 全部条件的纯取值方法。

### 3.3 「能否安全拦截」启发式

可拦截（全部满足）：具名方法且非 native-only；返回 `String` 或只改返回结构体中的单个字符串字段；方法体无网络/文件/事件副作用；未被其他 Mod 的 `@wrapMethod` 包裹；参数表可枚举、无泛型推断失败；目标字符串是常量字面量而非拼接结果。

不可拦截（任一命中，写原因码）：

| 原因码 | 触发条件 |
|---|---|
| `RESOURCE_TEXT` | 文本来自 `.archive`、`.inkwidget`、`.csv`，不是脚本常量 |
| `NATIVE_TARGET` | native 绑定或位于本体 core 包，wrap 后与其他框架冲突 |
| `VALUE_USED_IN_LOGIC` | 返回值参与 `if` 等判断，替换会改变行为 |
| `DYNAMIC_STRING` | 由拼接/查表产生，无法定位唯一注入点 |
| `WRAP_CHAIN_DEEP` | 已被 3 个及以上 Mod wrap，顺序不可控 |

不可拦截时不产出半成品，只在 `TranslationPlan.blocked` 记录原因码，前端渲染为灰色条目。

## 4. 场景三：作者禁止汉化

检测顺序：`info.json`（REDmod）→ 包内 `readme.txt` / `manifest.json` → Nexus 元数据 → Mod 名称与描述。

| 类别 | 词条（不区分大小写） |
|---|---|
| 英文显式 | `no translation`、`do not translate`、`don't translate`、`translation not allowed`、`no localization`、`no localisation`、`translation prohibited` |
| 中文显式 | `禁止翻译`、`禁止汉化`、`请勿翻译`、`谢绝翻译`、`不允许汉化` |
| 组合否定 | 同段落同时出现 `all rights reserved` 与 `translation` |

匹配策略：

- 归一化：小写化、全角转半角、压缩连续空白、剥离 Markdown/HTML 标签。
- 英文用词边界正则（`\bno[\s_-]*translat(e|ion)\b`），中文按子串匹配。
- 误报边界：命中点前后 40 字符内出现 `allowed` / `permitted` / `可以` / `欢迎` 时降级为 `Uncertain`；命中点处于 `credits` / `thanks` / `see also` 段落时不计入；只有 `localization` 而无否定词（如 `includes localization`）不计入。
- 三态结果：`Allowed` / `Denied` / `Uncertain`。仅 `Denied` 硬禁用：按钮 disabled，文案「已尊重作者意愿跳过」，提供「查看命中位置」原文高亮；不提供强制继续入口。`Uncertain` 不硬拦，弹窗多一个必选确认框。

## 5. 场景四：二进制 / Archive 资源

- 原 `.archive` 只读：不解包回写、不 rename、不重建。
- 需要替换的资源（onscreens、inkwidget 文本、csv）由 WolvenKit CLI 打成独立覆盖包 `<modId>-ai-loc.archive`；纯本地化场景可只出 `.archive.xl` + 松散 JSON。
- 命名统一 `<modId>-ai-loc.archive` / `<modId>-ai-loc.archive.xl`，目录内不放其他文件。
- 加载顺序必须在原 Mod 之后：`modlist.txt` 形态把 `-ai-loc` 条目插到原条目之后（不是追加到文件末尾）；`loadorder.json` 形态要求覆盖层 index 不小于原 Mod。字典序不可依赖，`<modId>.archive` 与 `<modId>-ai-loc.archive` 的相对顺序须显式排序，由现有 `loadorder.rs` 扩展承担，不另建一套。
- 冲突：存在第三方同目标资源时，部署前提示「可能与其他汉化包冲突」，不自动禁用对方。

## 6. 架构：Rust 端

### 6.1 模块划分

```
ailoc/
  mod.rs 命令注册 | plan.rs 只读扫描产出 TranslationPlan | onscreens.rs i18n JSON 与 key join
  archive_xl.rs .xl 生成 + WolvenKit 封装 | reds.rs .reds 扫描、字面量提取、补丁生成
  policy.rs 作者意愿（词表 + 正则 + 段落上下文） | translate.rs 翻译 trait + 桩（不联网）
  apply.rs 落盘、部署、清单登记、回滚 | report.rs Report、错误码、进度事件
```

### 6.2 接口签名（伪代码，未实现）

```rust
pub fn generate_translation_overlay(mod_id: &str) -> Result<TranslationPlan, AiLocError>;
pub fn apply_translation_overlay(plan: &TranslationPlan) -> Result<TranslationReport, AiLocError>;
pub fn revert_translation_overlay(mod_id: &str) -> Result<TranslationReport, AiLocError>;
pub fn purge_ai_translations() -> Result<PurgeReport, AiLocError>;

pub struct TranslationPlan {
    pub mod_id: String, pub mod_name: String,
    pub source_lang: String,          // "en-us"
    pub target_lang: String,          // "zh-cn"
    pub strategy: Strategy,           // Onscreens | RedsPatch | ArchiveOverlay | Mixed
    pub policy: AuthorPolicy,         // Allowed | Denied { evidence, spans } | Uncertain
    pub entries: Vec<PlanEntry>,      // 逐条：key / 原文 / 译文 / 状态
    pub blocked: Vec<BlockedItem>,    // 不可拦截项 + 原因码
    pub outputs: Vec<PlannedFile>,    // path / kind / bytes_estimate / sha256
    pub conflicts: Vec<ConflictItem>, // 与其他 Mod 的 wrap 或资源冲突
    pub warnings: Vec<String>, pub estimated_calls: u32,
}
pub struct PlanEntry {
    pub secondary_key: String, pub primary_key: u64,
    pub source_text: String, pub translated_text: Option<String>,
    pub origin: TranslationOrigin,    // Glossary | Stub | Ai | Skipped
    pub status: EntryStatus,          // Ok | TooLong | Invalid | Blacklisted
}
pub struct TranslationReport {
    pub mod_id: String, pub written: Vec<PathBuf>, pub deployed: Vec<String>,
    pub rolled_back: bool, pub duration_ms: u64, pub errors: Vec<AiLocError>,
    pub counts: ReportCounts,         // planned / written / translated / failed / skipped
}
pub enum AiLocError {
    NoTranslatableContent, PolicyDenied { evidence: String },
    AiReturnedInvalidJson { index: usize, raw_head: String },
    KeyMismatch { total: usize, matched: usize },
    WriteDenied { path: String, reason: String }, PathEscape { path: String },
    WolvenKitUnavailable, ArchivePackFailed { stderr_tail: String }, RollbackFailed { detail: String },
}
```

### 6.3 翻译层（桩）

```rust
// 伪代码，未实现。本轮不发起任何网络请求。
pub trait Translator {
    fn translate_batch(&self, items: &[SourceItem], src: &str, dst: &str)
        -> Result<Vec<String>, AiLocError>;
}

pub struct StubTranslator;   // 返回 "[zh-stub] " + 原文，长度与原文字节数接近
```

桩用于在无 API 时验证「长文本截断」「非法 JSON 剥壳」「部分失败」三条分支。真实实现后续只能落在 `translate` 层内部，`plan.rs` 及以上不感知供应商差异。

### 6.4 失败路径与回退

| 失败点 | 错误 | 回退 |
|---|---|---|
| 无 i18n 且无可拦截脚本 | `NoTranslatableContent` | 不写文件，提示「该 Mod 无自动汉化入口」 |
| 作者意愿 Denied | `PolicyDenied` | 计划阶段即终止，UI 显示跳过原因 |
| AI 返回非 JSON / 字段缺失 | `AiReturnedInvalidJson` | 单条丢弃计 `failed`，其余继续；全失败则不进入 apply |
| key 匹配率不足 | `KeyMismatch` | < 60% 拒绝生成；60%–90% 生成 + 黄条警告；> 90% 正常 |
| 写入被拒 / 路径越界 | `WriteDenied` / `PathEscape` | 立即整批回滚，`deployed_files` 回到调用前快照 |
| WolvenKit 缺失 / 打包失败 | `WolvenKitUnavailable` / `ArchivePackFailed` | 缺失时降级为「只生成 .xl + 松散 JSON」；打包失败删半成品 archive，保留 staging 供排查，不部署 |
| 回滚本身失败 | `RollbackFailed` | 保留清单原样、不删 staging，UI 明示需人工处理 |

原则：要么完整部署，要么什么都不留。任何阶段失败都不允许出现「部分文件已进游戏目录」。

### 6.5 进度事件

```rust
// 伪代码，未实现
pub struct AiLocProgress {
    pub mod_id: String, pub stage: AiLocStage,   // Scan | Policy | Translate | Build | Deploy | Verify | Done
    pub current: u32, pub total: u32, pub message: String,
}
// Tauri 事件 ai-loc://progress；命令 ai_loc_plan / ai_loc_apply / ai_loc_revert / ai_loc_purge
```

事件只推进度、不做业务判断；前端收到 `Done` 后回读一次状态，避免事件丢失卡在 99%。

## 7. 前端「汉化确认弹窗」

### 7.1 结构

```
<Modal aria-labelledby="ai-loc-title" size="lg">
├─ Header：标题「生成 AI 汉化覆盖层」 / 副标题「不会修改原 Mod 文件」
├─ Body
│   ├─ 免责说明块（常驻，不可折叠）
│   │   └─ 本译文由 AI 生成，非原作者发布，质量与语境由使用者自行判断
│   ├─ 目标信息：目标 Mod <名称> · <版本> · <作者>
│   │            语言对 English (en-us) → 简体中文 (zh-cn)
│   │            汉化方式 <本地化 JSON / Redscript 补丁 / Archive 覆盖 / 混合>
│   ├─ 文件清单（可滚动，最多 5 行 + 「另有 N 项」）
│   │   └─ [kind] archive/pc/mod/<name>-ai-loc.archive        <大小>
│   ├─ 统计条：待翻译 N · 词表命中 M · 不可拦截 K
│   ├─ 风险提示（仅有 blocked / conflicts / 匹配率不足时出现）
│   │   └─ 冲突 Mod 名、不可拦截原因、条目匹配率
│   └─ 确认区：[ ] 已知晓此翻译由 AI 生成，非原作者发布
│             [ ] 我确认原 Mod 作者未禁止翻译（policy=Uncertain 时显示）
├─ Footer：次要「取消」（Esc 可触发） / 主要「生成覆盖层」（未勾选时 disabled）
└─ 生成中：按钮 loading、弹窗不可关闭；完成后切结果视图（成功 / 失败 / 部分失败）
```

### 7.2 组件 props（伪代码，未实现）

```ts
export interface AiTranslationConfirmProps {
  open: boolean;
  plan: TranslationPlan | null;      // 来自 ai_loc_plan，null 时渲染骨架
  busy: boolean; progress: AiLocProgress | null;
  onConfirm: () => void;             // 仅两处 checkbox 均满足时可用
  onCancel: () => void;
  onOpenBlockedDetail: (item: BlockedItem) => void;
}
```

### 7.3 i18n key（词表键名风格 `translate.confirm.*`）

| key | 用途 |
|---|---|
| `translate.confirm.title` / `.subtitle` / `.disclaimer` / `.disclaimerStrong` | 标题、副标题、免责正文、其中需着色的强调片段 |
| `translate.confirm.targetMod` / `.languagePair` / `.strategy` | 三行目标信息标签 |
| `translate.confirm.filesTitle` / `.filesMore` | 文件清单标题、「另有 {count} 项」 |
| `translate.confirm.statEntries` / `.statGlossary` / `.statBlocked` | 统计条三项 |
| `translate.confirm.ackAi` / `.ackPolicy` | 两个复选框 |
| `translate.confirm.riskTitle` / `.keyMismatch` / `.conflictMods` | 风险提示 |
| `translate.confirm.cancel` / `.submit` / `.submitting` | 按钮与提交中 |
| `translate.confirm.done` / `.partial` / `.failed` | 结果态 |
| `translate.confirm.policyDenied` / `.unsupported` | 「已尊重作者意愿跳过」「暂不支持自动汉化」 |

按 `docs/I18N.md` 约定，组件内不出现中文字面量，文案全部进 `src/i18n/zh-CN.ts`。

## 8. 数据落点与生命周期

### 8.1 落点

| 阶段 | 路径 | 说明 |
|---|---|---|
| 暂存 | `staging/ai-loc/<modId>/` | 生成物先落此处，部署前可随意重建 |
| 部署 | `archive/pc/mod/<modId>-ai-loc.archive(.xl)`、`r6/scripts/ai-loc/<modId>/` | 只写这些前缀 |
| 状态 | `launcher-state.json → deployed_files`；词表主键 `mod_id + hash(原文)` | 与普通部署同表，靠路径前缀区分；清理只撕文件，词表保留 |

### 8.2 `AITranslations` 分类

- 首次生成时按需落库：`{ id: "AITranslations", builtin: true, locked: true }`，不手动预置。
- 分类内条目是虚拟条目：`staging_path` 指向 `staging/ai-loc/<modId>/`，`category_locked = true` 防智能归类挪走；新增 `origin: "ai-translation"` 与 `parent_mod_id`。
- 虚拟条目不提供「卸载」，只能走 `ai_loc_revert`，避免删条目后文件残留造成状态不一致。

### 8.3 生命周期

| 事件 | 处理 |
|---|---|
| 原 Mod 升级 / 游戏大版本更新 | 先 revert 旧覆盖层，再按新原文重新 plan（原文变 → 词表主键不命中 → 自动重译）；大版本另提示「覆盖层可能失效」并提供「重建全部」 |
| 原 Mod 卸载 | 级联 revert 该 Mod 全部覆盖层并删除虚拟条目，不弹二次确认 |
| 用户关闭汉化 | revert，撕除 `-ai-loc` 文件；虚拟条目置灰保留，可一键重新生成 |
| 一键清理 | 枚举 `origin == "ai-translation"` → 逐条 revert → 删 `staging/ai-loc/` → 保留词表 |
| 产物损坏 | 删 `staging/ai-loc/<modId>/` 重建，不重新调 AI |

清理验收：执行后游戏目录中含 `-ai-loc` 的文件数为 0，原 Mod 文件的 size 与 mtime 与生成前一致。

## 9. 风险与不做的事

### 9.1 法律与版权

- 译文为本机生成内容，不分发、不上传、不提供「导出为可分享汉化包」；不替换原作者署名、版本号、logo；作者明确禁止时一律跳过，不提供绕过开关。
- 明确不做：游戏内实时翻译与悬浮字幕、进程注入、语音本地化、字体替换、云端词表审核、译文分享、本轮接入真实 AI API。

### 9.2 不碰原文件的具体保证

1. 读取统一走只读句柄，代码路径上不出现对原目录的 `write` / `rename` / `remove`。
2. 生成前后对原 Mod 目录做 `(path, size, mtime, sha256 抽样)` 快照比对，不一致即中止并报 `OriginalMutated`（兜底断言，非主要手段）。
3. 写入前 `safe_join` + 越界校验，目标必须落在 `staging/ai-loc/` 或部署前缀白名单内；部署只新增文件，不覆盖同名文件，已存在则报冲突交由用户决定。

### 9.3 已知局限

- ArchiveXL 的 `extend` 行为随版本变化，YAML 需实机核对一次；不支持时降级为注册式，覆盖粒度变粗（整语言表）。
- Redscript 补丁依赖方法签名稳定，Mod 更新后签名变化会导致编译失败；只能靠「升级即重建」缓解，不能根治。
- 硬编码文本约三到五成属于 UI 资源而非脚本常量，本方案不覆盖；译文长度差异可能造成 UI 溢出，不做布局适配。
- 桩阶段无法评估真实译文质量；`TooLong` 先用字节数 1.6 倍粗判。

## 10. 待用户裁决的问题

1. **语言对来源**：固定 `en-us → zh-cn`，还是从 `localization/` 目录自动探测源语言（部分 Mod 只有 `ru-ru`）？探测会引入「源语言识别错误」一类失败。
2. **是否支持批量**：一次选 20 个 Mod 时是「排队串行、单条失败不阻塞」还是「只允许单个生成」？批量会放大调用成本与磁盘占用。
3. **是否允许用户手改译文后再生成**：允许则需引入「译文编辑 + 标记 local 优先」的中间态，工作量明显上升；不允许则错译只能整条重译。
4. **虚拟条目能否手动删除**：当前只允许 revert。若允许直删，需补充「条目删了但文件还在」的一致性修复流程。
5. **`Uncertain`（作者未表态）默认行为**：默认允许并加勾选，还是默认跳过、要求用户手动解锁？
