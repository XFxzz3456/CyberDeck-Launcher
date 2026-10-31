# CyberDeck Launcher · CodeBuddy 补充守则

> 项目主规范在仓库根 `AGENTS.md`（159 行：三处版本号、安全红线、常用命令、数据目录、文档落点）。
> CodeBuddy 会在没有 `CODEBUDDY.md` 时自动全文加载它。**本文件只补充 AGENTS.md 里没写、但接手后一定会踩的坑。**

## 1. 启动器有单实例锁：dev 版「秒退」不是崩溃

现象：`target/debug/cyberdeck-launcher.exe` 启动后**退出码 0、无任何输出、startup.log 一行不写**。

真因：Tauri `single-instance` 插件是最先注册的，只要 `release\CyberDeck Launcher.exe`（或另一个 dev 实例）还开着，新实例就被当成「第二个实例」直接退掉。

处理：启动 dev 窗口前先确认没有同名进程；`Get-Process | Where-Object { $_.ProcessName -like "*CyberDeck*" }` 应为空。
**这不是代码 bug**，别去改 Rust 找原因（2026-10-31 为此排查过一整轮）。

## 2. 端口与地址约定

| 用途 | 端口 | 说明 |
|---|---|---|
| `tauri dev` / Vite 开发服务 | 1420 | 固定，`devUrl` 写死 |
| 门禁脚本 | `GATE_PORT`（默认 1420，门禁跑 1423） | 所有脚本读 `process.env.GATE_PORT`，**不要硬编码** |
| 临时 preview | 自行指定（1425 / 1427） | 用完关掉，别长期占 |

**门禁/脚本里的地址必须写 `http://localhost:PORT/`，不能写 `127.0.0.1`**：`vite preview` 绑定的是 `[::1]`（IPv6），写 `127.0.0.1` 会连不上，表现为 `networkidle` 超时、脚本零输出，看起来像「组件坏了」。

## 3. 通知/任务/活动三层不是随便塞的

- `toast()`（`src/App.tsx`）第 4 个参数是**通知类别**，缺省 `"system"` 会**绕过设置页的所有开关**。新增调用必须显式传类别（`deploy` / `download` / `conflict` / `update`）。
- 单次开关模组属**静默级**：不进 `addTask`、不弹 toast，只改角标 + 写 `recordActivity`。
- 门禁脚本 `check-notify-noise.mjs` 会卡这条（连续开关 5 个模组后 toast ≤1 / 任务队列为空 / 活动流 ≥5）。

## 4. 文档同步需要回到 WorkBuddy

资料库（`space-library`）与项目网盘（`netdrive`）是 **WorkBuddy 内置的 MCP**，`~/.codebuddy/mcp.json` 里没有、也无法直接复用。

所以在 CodeBuddy 里改完代码后：`CHANGELOG.md` / `HANDOFF.md` / `docs/` 照常更新并提交，**同步到网盘与资料库这一步交回 WorkBuddy 会话做**。网盘目录 id：`YbyPEuDRRBHW`；资料库节点：`4NdB1FUOpNpZmbqOfQCtfP`（空间 `btCAC0glhsDub7qu3xaeLI`）。

## 5. 推送用凭据，不要写进仓库

远端 `https://github.com/XFxzz3456/CyberDeck-Launcher`（public / MIT）。仓库局部已配 `http.proxy` / `https.proxy` 指向 `127.0.0.1:7897`。

- 需要 token 时用**一次性**形式：`git -c credential.helper= -c http.extraHeader="AUTHORIZATION: basic <base64>" push`，**不要**写进 remote URL 或 `.git/config`。
- 提交身份必须是 `XFxzz3456 <mc2364694314@163.com>`，否则公开仓库的贡献不计入用户主页。
- 公开仓库：`git add` 前扫一遍密钥（`sk-` / `ghp_` / 私钥头 / `AKIA`）。进了历史再删文件是没用的。

## 6. 构建判据（别只看「构建成功」）

- 正式包只能用 `node_modules\.bin\tauri.cmd build --no-bundle`，并设 `CARGO_PROFILE_RELEASE_LTO=false`。
  **绝不能只用 `cargo build --release`**：缺 `custom-protocol` feature 会导致前端不内嵌，用户看到 `ERR_CONNECTION_REFUSED`。
- 判据：正式 exe ≈ 9.1 MB（dev 形态 ≈ 6.8 MB）；`startup.log` 里必须有 `stage=frontend`。
- 验证产物是否含最新前端：**比对部署 exe 与 `target/release` 产物的 md5**。不要用 `grep` 资源文件名——Tauri 会 brotli 压缩嵌入，明文 grep 必然失败，看着像「没打进去」。
