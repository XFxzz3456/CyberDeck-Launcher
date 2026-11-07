# #6 AI 深度汉化 — 架构评审结论与范围签字（2026-11-07）

> 进度载体：https://github.com/XFxzz3456/CyberDeck-Launcher/issues/6
> 状态：**用户已按推荐签字**（2026-11-07）。本文是仓库内的结论落点；过程简报在工作区，不进仓库。

## 1. 评审不是待办

`PROJECT_HISTORY.md §4.5` 记录 **2026-10-29 已定案**（看板【8】）：

| 路线 | 做法 | 裁决 |
|---|---|---|
| A | 离线生成本地化资源覆盖层 | **采用** |
| B | 运行时 overlay / 进程注入 | **禁止**（反作弊、崩溃风险） |
| C | 仅词表替换 | 已上线，作为 A 的词表底座 |

写入白名单硬约束（继续有效）：路径先过 `store::safe_join` + `is_within`；产物名带 `-ai-loc` 后缀；原 Mod 文件只读；产物落 `staging/ai-loc/<modId>/`。
词表主键 `mod_id + FNV-1a(原文)`，原文变化即失效；合并优先级 本地自定义 > 云端共享 > AI 新译。

issue #6 正文是 2026-10-26 快照，「前置：一次架构评审」已过期。缺的是**范围裁决**，不是重开评审。

## 2. 技术纠偏（本轮最重要的结论）

issue 推荐路线里的「替换 / 新增 CET `user.ini` 与 RED4ext TOML/JSON **菜单配置**」不成立：

- `user.ini` / TOML / `config.json` 存的是**玩家设置值**（bool / number / string），`modsettings.rs` 头部注释明确它是 CET mods 经 Lua API 读写的值文件；
- 游戏内菜单项与选项说明由 **Lua 注册代码 / inkwidget / 硬编码文本**产生，不在配置文件里；
- 照 issue 原文实现会改坏玩家设置、菜单文字一个没变，并违反 P1「绝不修改原 Mod 文件」。

## 3. 范围签字（用户 2026-11-07 选「都按推荐的」）

| 类别 | 文案来源 | 裁决 |
|---|---|---|
| ① 启动器内渲染的配置项标签 / 选项说明 | `SettingField.label`、`ConfigSource` | **M1 实施**：独立本地化映射，不写游戏目录 |
| ② 游戏内 CET / Mod Settings 菜单 | Lua / inkwidget | **不做**，标注为「框架不支持，需专项方案」，写进 issue 已知边界 |

其余签字项：

- **写入白名单**：显式枚举，产物只用独立 JSON 文件，**不动 `launcher-state.json` 的 schema**（避免迁移链与旧数据解析风险）。
- **回滚**：撤销 = 删独立文件；不登记 `deployed_files`、不碰游戏目录。
- **Mod 更新重做**：记录源文件指纹（来源 + section + key + 标签，不含 `value`）；结构变化则译文自动失效，**只提示重做，绝不自动重跑 AI**（不烧额度、不覆盖本地自定义译文）。
- **M2（范围 ②）**：仅在用户单独授权 + 专项方案评审通过后启动，本轮不启动。

## 4. M1 落地（`src-tauri/src/ailabel.rs`）

- 产物 `data_dir/ai-labels/<modId>.json`；`mod_id` 经 sanitize，挡路径穿越。
- 词表优先 → 未命中走 `ai::translate_locale_strings` → 译文按现有词表规则记回（`by = "ai"`，`user` 条目永不覆盖）。
- `config_resolver::raw_mod_sources` 提供未套覆盖层的原始标签（避免把中文译文当原文重翻）；`mod_config` 在返回前套用覆盖层，过期则把提示放进 `warnings`。
- `ailoc::apply` / `ailoc::revert` 挂接生成与撤销：**best-effort**，失败只进 `warnings`，不阻断汉化主流程。
- 单测：指纹忽略 `value` / 检测 label 变化、覆盖层套用与过期、撤销、路径穿越防护。

**已知边界**：M1 依附现有「AI 汉化」入口，暂无独立 UI 按钮；游戏内框架菜单（②）未做；不装 Ollama 也能用云端 / 本地任意 OpenAI 兼容端点生成标签译文。

## 5. 未变的红线

卸载只信 `deployed_files`；路径过 `safe_join` + `is_within`；硬链接身份用 `GetFileInformationByHandle`；**Mutex 内不做 IO**；新增 Tauri 命令必须同时定义 + 注册 + 前端调用（`scripts/check-commands.mjs`）；改完先门禁 → 提交 → localhost 验收 → 用户确认后才构建 exe。
