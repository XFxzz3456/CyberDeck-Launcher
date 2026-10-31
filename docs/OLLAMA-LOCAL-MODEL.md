# 本地模型（Ollama / 任意 OpenAI 兼容端点）接入与验证

> 对应看板【14】。代码层已支持任意标准 OpenAI `/v1` 端点；本文件是实机验证步骤、已知差异与排查表。
> 本机实测状态（2026-10-29）：**未安装 Ollama**，实机链路未跑；已用本地 mock HTTP 服务器在单元测试中覆盖同等协议路径（`src-tauri/src/ai.rs` 的 `ai::tests`）。

## 一、配置

| 字段 | 值 |
|---|---|
| 接口协议 | `OpenAI 兼容`（Ollama 走 OpenAI 兼容层，不要选 Anthropic） |
| 接口地址 | `http://localhost:11434/v1` |
| 模型名称 | 与 `ollama list` 输出**完全一致**（如 `qwen2.5:7b`、`llama3.1`） |
| API Key | 留空（本地服务不鉴权） |

> 代理注意：如果系统设置了 `HTTP_PROXY`，本机回环请求可能被代理劫持。启动器内部对 `127.0.0.1,localhost` 做了 `NO_PROXY` 处理；自己用 curl 复现时也要带上
> `NO_PROXY=127.0.0.1,localhost`。

## 二、验证步骤（三条链路）

```powershell
# 0. 起服务并拉模型（一次性）
ollama serve
ollama pull qwen2.5:7b
ollama list

# 1. 协议探针（不依赖启动器，先确认端点活着）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-ollama.ps1
```

启动器内：

1. 设置 → AI 配置 → 协议选 `OpenAI 兼容`，地址填 `http://localhost:11434/v1`，模型 `qwen2.5:7b`，Key 留空 → 保存。
2. 点「获取模型」→ 预期下拉框出现本机模型列表（走 `GET /v1/models`）。
3. 库页选一个 Mod → AI 翻译名称 → 预期返回中文且写入词表。
4. 诊断页 → 勾选同意 → 运行一次诊断 → 预期返回结构化结论，不报协议错误。

## 三、已知差异与处理

| 差异 | 表现 | 处理 |
|---|---|---|
| 无 `usage` 字段 | 响应里没有 token 统计 | 代码只读 `choices[0].message.content`，不受影响 |
| 错误体格式不同 | 400/404 返回 `{"error": "..."}` 而非 OpenAI 结构 | 统一走 `http_error_message`，非 2xx 一律显示状态码 + 正文前 500 字符 |
| 上下文窗口小 | 长描述被截断或超时报错 | 翻译按批次切分（既有实现），单批失败不中断整轮 |
| 首次加载慢 | 首个请求可能 30s+（模型换入显存） | 客户端超时已放宽；建议先 `ollama run` 预热一次 |
| JSON 遵循度弱于云端 | 返回带 ```json 围栏或多余解释 | 既有剥壳逻辑容错；仍失败则单条丢弃并计数 |
| 并发 | 本地单卡并发会排队 | 保持串行调用，不开并行 |

## 四、排查表

| 现象 | 先查什么 |
|---|---|
| 连接被拒 | `ollama serve` 是否在跑；端口是否 11434；是否被代理劫持 |
| 404 | 地址是否漏了 `/v1`（程序能识别完整端点，但建议填到 `/v1`） |
| 模型不存在 | 模型名是否与 `ollama list` 逐字一致（含 tag） |
| 返回空内容 | 模型是否支持 chat 模板；换 `qwen2.5` 复测 |
| 401 | 本地服务一般不需要 Key；若填了 Key 反而可能被拒，清空重试 |

## 五、结论与待办

- 代码层：双协议（OpenAI / Anthropic）+ 任意 Base URL 已由单元测试覆盖，协议路径无需改动。
- 实机：本机无 Ollama，等安装后按第二节跑一遍，把结果补进 `docs/REAL-ENV-TEST-0.9.0.md` 的 J 项。
- 帮助中心已收录"接本地 Ollama"条目（0.9.0），用户可自助配置。
