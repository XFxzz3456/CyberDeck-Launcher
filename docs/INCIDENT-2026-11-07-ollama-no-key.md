# INCIDENT　本地 Ollama「Key 留空」实际不可用（2026-11-07）

> 关联：GitHub #8 / #6 架构评审 M1 · 修复提交见 `CHANGELOG.md` 11-07 段。

## 现象

帮助中心 FAQ、AI 预设、`aiPresets.ts` 类型注释都告诉用户「本地 Ollama / LM Studio 不需要密钥，Key 留空」。
实际效果：**点「获取模型」能拉到列表，一点「翻译 / AI 诊断」就报 `AI_NOT_CONFIGURED`**。
用户会先看到列表加载成功，误判为配置完成，再在真正用功能时撞墙。

## 真因

`src-tauri/src/ai.rs` 里 Key 的可选性只做了一半：

| 链路 | 修复前 |
|---|---|
| `list_models` / `list_models_with_key` | `Option<&str>`，无 Key 发匿名 GET（注释明确写了「Ollama 等本地服务不需要鉴权」） |
| `diagnose` / `translate_mod_names` / `translate_locale_strings` / `propose_redscript_patch` | `load_key(store)?.ok_or_else(AI_NOT_CONFIGURED)` —— 硬拒绝 |
| `chat_completion` / `request_once` | `key: &str`，OpenAI 分支无条件 `.bearer_auth(key)` |

即「本地服务无需鉴权」这个设计只落在模型列表这一条支路上，四条业务链路没跟上。
前端 `local: true` / `keyUrl: null` 只是展示数据，没有任何后端分支消费它。

## 走过的错误假设

1. **「代码层已兼容任意 OpenAI /v1 端点」= 全链路可用**。实际只覆盖了 URL 归一化、协议分发、模型列表；鉴权守卫没审。
2. **「能拉到模型列表」= 配置成功**。恰恰是最容易掩盖缺陷的观测点：它是唯一支持匿名的链路。
3. **「加预设 + 写 FAQ」= 功能完成**。没有任何一条端到端断言验证「无 Key 时能发出对话请求」。
4. 静态审查时一度怀疑 Ollama 的 `usage` / 流式 / 错误格式差异是主因，读码后排除：代码不解析 `usage`、不发 `stream`，这两处根本不会出问题。**先入为主的「兼容性差异」清单差点把真因排到后面**。

## 修复与代价

- `request_once` / `chat_completion` 的 `key` 改 `Option<&str>`；有则加鉴权头，无则匿名。
- 新增 `resolve_chat_key(store, base_url)`：有 Key 用 Key；**无 Key 只对回环地址放行**（`localhost` / `IpAddr::is_loopback()`），公网漏填 Key 仍在发请求前报 `AI_NOT_CONFIGURED`。
- `is_loopback_base_url` 用 `IpAddr` 判 IP，不靠字符串前缀 —— 防 `localhost.evil.com` / `127.evil.com` 被误放行。
- 四条业务链路统一走 `resolve_chat_key`，5 个 `chat_completion` 调用点显式 `key.as_deref()`。
- 单测钉住两条：回环无 Key 匿名成功且请求里**没有任何鉴权头**；公网无 Key 在网络前被拦。
- 文案同步：`zh-CN.ts` 的 ollama / lmStudio `keyHint` 从「随便填」改成「留空即可」。

**新约束 / 代价**

1. 匿名放行范围被限死在回环地址；以后新增本地服务（非 127/::1 的局域网地址）需要显式扩展白名单，不能靠 `http://` 前缀判断。
2. `key` 变成 `Option` 后，所有新增调用点必须显式处理「无 Key」，不能再拿 `&str` 想当然。
3. 本地服务仍会收到 `response_format: json_object`；Ollama 是否接受**未经实机验证**（用户本轮明确不装 Ollama），#8 因此保持 open。
4. 未动 `list_models` 的匿名行为：公网无 Key 时它仍会发匿名 GET 再拿 401，属既有行为，本次不扩大改动面。

## 下次同类问题第一步查什么

**先把「文档 / 预设承诺」与「后端守卫」逐条对账，尤其是声明为可选的字段在每条链路上是否真的可选。**
具体到 Rust：`grep -n "ok_or_else\|Option<&str>"`，看同一份配置在「只读查询」与「写/调用」两条路径上是否用了同一套判定。
不要从「服务商兼容性差异清单」入手 —— 先看自己代码的分支分布，通常更快。

## 遗留

- 实机双端（DeepSeek 云端 + Ollama 本地）三条链路未跑；`docs/REAL-ENV-TEST.md` 已补待验项。
- `PROJECT_HISTORY §3.7` 曾写「已知差异 6 项见 REAL-ENV-TEST.md」，该文件当时并无此清单，本次一并补回并改引用。
