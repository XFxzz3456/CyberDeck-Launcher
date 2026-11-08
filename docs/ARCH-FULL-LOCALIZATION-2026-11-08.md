# 全类型 Mod 汉化方案（调研简报 · 待确认）

> 2026-11-08 · **决策已确认，P0 开工**。项目铁律：复杂模块先调研开源并出简报，用户确认后才动手。
> 用户拍板（22:31）：**放宽 P1 红线，允许覆盖，但必须备份原文档**；AI 由用户自己接 API 后交给启动器汉化。

## 0. 结论先行

「全类型 100% 文本变中文」做不到，也不该承诺。可实现的目标是：

**每一种安装布局 / 文本载体都有确定的处理路径** —— 能覆盖的生成独立覆盖层；不能覆盖的列进 `blocked` 并给出具体原因与手动出路；不再出现「点了一键汉化，只回一句没有本地化 JSON」。

三类硬边界（只能标记，不能翻译）：运行时拼接 / 动态生成的文本、加密或无法导出的二进制资源、作者明确禁止翻译。

**关键决策已定（2026-11-08）**：放宽 P1「绝不修改原 Mod 文件」，允许覆盖型汉化层，**前提是写入前备份原文件、可完整恢复**。规范见 §5.1。这使 CET / 游戏内菜单从「不可达」变为「P2 可实现」。

## 1. 现状差距（上一轮代码审查，v1.3.0）

| 项 | 现状 |
|---|---|
| 扫描范围 | `ailoc.rs:225-231` **只扫 `.json`**，且只认 `onscreens.entries` / 扁平 `key→text` |
| 纯 `.archive` / `.inkwidget` / `.csv` / `.reds` / Lua | 完全不进扫描，连 `blocked` 都不记 |
| 文档与实现不一致 | `schema.rs:293`、`PROJECT_HISTORY §4.4` 说这些标为 `RESOURCE_TEXT` / `UNSUPPORTED_FORMAT`；实现里这两个 reason **从未产生**，用户只看到 `AI_LOC_NO_CONTENT` |
| 粒度 | `ai_loc_plan/apply/revert` 全带单个 `mod_id`，无批量 |
| 部署 | 只新增 `.archive` + `.archive.xl` 两个文件到 `archive/pc/mod`；目标已存在即拒绝 |
| 依赖 | 必须 WolvenKit CLI 打包；无 CLI 则译文生成但不部署 |
| 已有可复用件 | `wolvenkit.rs` 的 `unbundle`、`ailoc.rs` 的 `pack`、`glossary.rs` 词表、`ai.rs` 翻译通道、`aifix.rs` 独立 `.reds` 补丁层、`deployed_files` 卸载回滚 |

## 2. 开源调研结论（有出处）

| 来源 | 可用结论 |
|---|---|
| REDModding Wiki《How I UwU-transformed localization》、WolvenKit CLI Usage | `unbundle` 解 `.archive` → `convert serialize` 把 CR2W 转可读 JSON（`Data.RootChunk.root.Data.entries`）→ 只改 `femaleVariant` / `maleVariant`，**不动 `primaryKey`/`secondaryKey`/`stringId`** → `import` + `pack` 出新 `.archive`。LTBF 仓库 `tools/pack_archive.py` 已在生产里跑同一条链 |
| psiberx/cp2077-archive-xl（v1.4.1 README） | `localization.onscreens.<lang>` 按语言合并，**改原版条目用 `primaryKey`，改 Mod 条目用 `secondaryKey`**；支持 `zh-cn`；明确「不要覆盖原 .json，ArchiveXL 负责合并」 |
| WolvenKit CLI 文档 | `unbundle -w <pattern>` 可按通配符只解需要的资源；`pack -p <dir> -o <out>` 出归档 |
| CET 社区汉化包（TDO 2.35 简中包说明） | 标准做法是**覆盖 `init.lua` + 新增 `modules/languages/zh-cn.lua`**，要求 AFTER 加载、卸载恢复原 `init.lua`、版本绑定强；CET_Translator 也是 mod 内自带翻译表 |
| 仓库 `aifix.rs` | 已有独立 `.reds` 补丁层：`@wrapMethod` / `@replaceMethod` 结构校验、危险 API 黑名单、400 行上限、单独撤销 |

⚠️ 待实测：现有 `ailoc.rs::build_archive_xl` 写的 `localization.extend:` 字段在 ArchiveXL 官方文档中未出现。若它是无效字段，应改为直接按 `primaryKey` / `secondaryKey` 生成合并条目。

## 3. 目标架构（五层，全部只读提取 + 独立产物）

1. **提取层**：按载体分适配器，只读扫描 staging；输出 `SourceUnit { mod_id, source_ref, key, text, kind }`。
2. **词条层**：`mod_id + FNV-1a(原文)` 主键；词表优先，`user` 条目永不覆盖；记录源文件指纹（含 Mod 版本），原文变化自动失效。
3. **翻译层**：复用 `ai::translate_locale_strings`，批量 + 节流 + 失败可重试；不写状态、不自动重跑。
4. **产物层**：按载体生成**独立覆盖物**（不碰 staging 母本）：
   - `.archive` + `.archive.xl`（ArchiveXL 合并）
   - `zh-cn.lua` / 覆盖型 `init.lua`
   - `AIFix_<mod>_<hash>.reds`（独立补丁）
   - `data_dir/ai-labels/*.json`（启动器内标签，已有）
5. **部署 / 回滚层**：所有产物作为 `Copy` 登记进 `deployed_files`；卸载按清单撕除并恢复被覆盖的原文件；Mod 更新后指纹失配只提示「需重做」。

红线不变：路径过 `safe_join` + `is_within`；Mutex 内不做 IO；新增 Tauri 命令三处对齐；界面中文走 i18n。

## 4. 分类型适配器矩阵

| 载体 / 布局 | 文本位置 | 提取 | 产物与覆盖机制 | 需放宽 P1 | 主要风险 |
|---|---|---|---|---|---|
| 自带本地化 JSON（ArchiveXL） | `localization/*.json` | 现有 `entries_from_json` | `.archive` + `.xl`（`secondaryKey`） | 否 | 已跑通；需修 `extend` 疑点 |
| 纯 `.archive`（onscreens / subtitles / journal） | CR2W 内 entries | WolvenKit `unbundle` + `serialize` | 新 `.archive` + `.xl`（`primaryKey` 覆盖原版条目） | 否 | CLI 版本差异、资源量、需真机验证 |
| `.inkwidget` / `.csv` / `.json` 资源 | CR2W / 表 | 同上 | 独立资源 + ArchiveXL ResourcePatch | 待验证 | 合并行为需专项实测 |
| CET Lua（菜单 / 通知） | `init.lua`、语言表 | 静态扫描字符串字面量 | 独立 `zh-cn.lua` + 覆盖 `init.lua` | **是** | 版本绑定强，Mod 更新必重做；需中文字库 |
| redscript 硬编码 | `.reds` 字符串 | 静态扫描 | 独立 `.reds` 补丁（`@replaceMethod`） | 否 | 语法风险；**不宣称已编译验证** |
| REDmod / ASI / RED4ext | 通常无 UI 文本 | 扫 `info.json` 描述 | 归「无需游戏内汉化」，只翻启动器内描述 | 否 | — |
| 启动器内标签 / 名称 / 描述 | 自有数据 | 词表 | `ailabel` + 词表 | 否 | 已落地 |
| 游戏内框架菜单（#6 范围②） | Lua / inkwidget | 同 CET 行 | 同 CET 行 | **是** | 与 M2 合并处理 |

## 5. 决策状态（2026-11-08）

| # | 决策 | 状态 |
|---|---|---|
| 1 | 放宽 P1，允许覆盖型汉化层 | ✅ **用户已确认**：可以覆盖，**必须备份原文档** |
| 2 | 覆盖率口径：只处理静态可提取文本 | ✅ 按推荐默认执行；动态拼接 / 加密资源明确 blocked |
| 3 | 是否新增依赖 | ✅ 按推荐默认：**不新增 crate**，用 WolvenKit CLI + `serde_json` + 文本扫描 |
| 4 | 是否本轮做全库一键 | ✅ 按推荐默认：P3；先做单 Mod 全类型 |

### 5.1 覆盖型汉化层安全规范（已确认，P2 实现）

用户要求「可以覆盖但是要备份原文档」。落地为五条硬约束：

1. **白名单**：只允许覆盖 `init.lua`、指定的 `modules/languages/*.lua`、以及经结构校验的 `.reds` 补丁目标；游戏目录其它文件、staging 母本**永不写**。
2. **先备份再写**：写入前把原文件原子复制到 `data_dir/ai-loc-backups/<modId>/<相对路径>/<文件名>.<时间戳>.bak`；备份失败即中止，绝不写半截译文。
3. **独立清单**：`data_dir/ai-loc/<modId>/manifest.json` 记录 `{ target, backup, size, mtime, mod_version, fingerprint }`，与 `deployed_files` 双登记；**不改 `launcher-state.json` 的 schema**。
4. **恢复**：撤销汉化 / 卸载 / Mod 更新（指纹失配）时按清单恢复；恢复前比对 size / mtime，被外部改过则**拒绝自动恢复并告警**（复用 `installer` 的拒删判据）。
5. **显式确认**：覆盖前弹窗列出「将被覆盖的文件清单 + 备份位置」，用户勾选才执行；作者 `denied` 一律不生成。

### 5.2 AI 通道口径（用户补充）

启动器**不内置模型、不代用户调用**：用户在「设置 → AI 配置」自填 Base URL / API Key / 模型名（OpenAI 兼容或 Anthropic 原生），密钥经 DPAPI 存在 `data_dir/secrets/`，不进状态文件与日志。

- 复用 `ai::translate_locale_strings`：词表命中优先，未命中才走用户配的接口；本地回环服务（Ollama / LM Studio）可留空 Key（1.3.0 已修）。
- 无 Key、网络失败、空响应按现有容错处理并如实报错；**不自动重跑 AI**、不烧额度、不覆盖 `user` 词表条目。
- 因此 P0/P1 的扫描与产物生成全部是**离线可复现**的，只有「翻译」这一跳依赖用户自己的 API。

## 6. 分期（每期一次提交、一次门禁）

| 期 | 内容 | 前置 |
|---|---|---|
| P0 | 骨架 + 可观测性：真实 `blocked` reason（`RESOURCE_TEXT` / `UNSUPPORTED_FORMAT` / `SCRIPT_TEXT` / `CONFIG_TEXT`）、按载体分类扫描、计划页展示「能翻 / 不能翻 / 为什么」。不改游戏目录，零部署风险 | **决策已确认，本轮实施** |
| P1 | `.archive` 内文本：WolvenKit `unbundle → serialize → 翻译 → import → pack`，`primaryKey` 覆盖；真机样本验证 | P0 |
| P2 | 脚本类：CET 覆盖层 + redscript 独立补丁层（复用 `aifix` 校验） | §5 第 1 项决策 |
| P3 | 全库队列、Mod 更新重做提示、批量撤销、门禁脚本 | P1/P2 |

## 7. 验收标准

- 每种 `InstallLayout`（GameRoot / Archive / Redmod / Cet / Redscript / Asi / Red4ext）各取 1 个真实样本 + 1 个纯 `.archive` 包。
- **游戏内文字确实变中文**（截图 / 日志），不是只看文件生成。
- 卸载后游戏目录与 staging 母本零残留，按 `deployed_files` 逐条对账。
- 状态文件连续两次往返无 `broken-*.json`。
- `npm run gate` 42/42 + 新增单测；新增命令过 `check-commands.mjs`。
- 按交付顺序：改完 → 门禁 → 提交 → **localhost 挂起给你验收** → 你确认后才构建 exe。

## 8. 明确不做

游戏内 overlay / 进程注入；改 staging 母本；自动重跑 AI；把译文写进 `launcher-state.json`；绕过作者禁止；把未编译的 `.reds` 补丁说成「已验证」；一次提交塞多个变量。

## 9. 本轮边界

方案已定稿并归档进仓库 `docs/ARCH-FULL-LOCALIZATION-2026-11-08.md`。**P0 已实施**：扫描器按载体分类 + 真实 `blocked` 原因 + 单测，**不写游戏目录、不做覆盖、不做备份写入**（备份规范见 §5.1，P2 落地）。P1/P2 需真机样本，另起一轮。仍按交付顺序：门禁 → 提交 → localhost 验收 → 用户确认 → 才构建 exe。

用户 22:35 追问「是不是要做成隐形 agent 平台」→ 结论：**能力平台化（扫描/备份/覆盖/恢复/登记做成通用工具层）方向对，但过程必须可审计**。项目红线是「任何失败必须在界面上可见」「静默失败是最贵的 bug」；允许覆盖后更要把「改了哪个文件 / 备份在哪 / 怎么回滚」暴露给用户。另需区分：开发会话有文件权限 ≠ 启动器运行时有常驻 agent；启动器只是一次请求-响应式调用用户自己配的 API。
