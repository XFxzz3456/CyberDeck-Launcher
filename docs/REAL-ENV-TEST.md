# 真实游戏环境验收清单

> **2026-10-26 更新**：本机已安装 CP2077（`D:\steam\steamapps\common\Cyberpunk 2077`），
> 第 0 节的预检与写探针/硬链接探针都已实测通过（`RESULT: 0 failure(s)`）。
> 0.7.0 时期的文件操作测试是在合成目录上完成的，下面的手工项仍然值得在真机上过一遍。

这台开发机一度没有安装 Cyberpunk 2077，所以 0.7.0 的文件操作测试是在合成游戏目录上完成的。真实环境请按下面顺序跑一遍；每一步都给出“看什么”，避免把“窗口没报错”当成成功。

## 0.0 一条命令的自动门禁（每次发版必跑）

```powershell
node scripts\gate.mjs
```

跑 cargo test → `tsc --noEmit` → `vite build` → 8 个单点验收脚本（虚拟滚动/脏数据、更新熔断、
平台选择器、右键菜单、播放集、环境体检、NXM 接管、状态恢复提示）。**失败会非零退出**并写
`shots/gate/report.json`。无浏览器环境用 `--skip-ui`。
`cargo test` 当前 96 项（含 nxm 9 项、状态恢复 2 项），另有 `probe_repeat` 1 项。

## 0.0.1 提权 / DPAPI 对照

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-elevation.ps1
# 需要对比提权时（会弹一次 UAC）：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-elevation.ps1 -Elevated
```

看三件事：**提权后 `dataDir` 必须和普通权限完全一致**（否则用户会看到“模组全没了”）、
`secrets.nexusKey` 仍为 `readable`、`state.mods` 数量不变。

## 0. 先跑只读预检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\real-env-check.ps1 -GameDir "D:\SteamLibrary\steamapps\common\Cyberpunk 2077"
```

加 `-ProbeWrite` 会实际创建/删除一个临时文件，验证 `archive/pc/mod` 的 ACL；加 `-ProbeHardlink` 会在同卷创建/删除一对临时硬链接，验证卷和权限。

预期：

- `game executable`、`archive/pc/mod` 为 PASS；
- 未安装的框架显示 WARN，不会伪装成 PASS；
- 启动器状态里的 `gameDir` 必须和传入目录一致，否则先到设置里重新选择。

## 1. 真实 archive 部署

1. 从 Nexus 浏览器下载一个**只有 `.archive` 文件**的模组 ZIP。
2. 拖进启动器，确认导入结果写的是 `INFO.JSON` 或 `FILENAME`，并选分类。
3. 启用后看 toast 的三个计数：硬链接 / 符号链接 / 复制。
4. 打开 `archive\pc\mod\`，确认文件存在；用 `fsutil hardlink list <目标>` 能看到暂存区源文件。

如果游戏在 `C:\Program Files` 或受保护库：

- 硬链接失败后应尝试符号链接；符号链接无权限时应回退复制。
- 复制不是失败，但 toast 会显示 `复制 1`，并在 warnings 里说明“卸载只删除游戏目录副本”。

禁用后：

- 游戏目录里的文件消失；
- 暂存区源文件仍存在；
- `launcher-state.json` 里该模组的 `deployedFiles` 为空。

## 2. 嵌套目录 / 散装 CET

准备两个 ZIP：

```text
A: Wrapper/Inner/archive/pc/mod/nested.archive
   Wrapper/Inner/r6/scripts/nested.reds

B: bin/x64/plugins/cyber_engine_tweaks/mods/TestCET/init.lua
```

预期：

- A 的 staging 根目录应被嗅探到 `Inner`，布局为“游戏目录结构”；
- B 的布局为 CET，部署后落在 `bin\x64\plugins\cyber_engine_tweaks\mods\<name>`；
- 如果 ZIP 里同时有 `ModA/archive/a.archive` 和 `ModB/archive/b.archive`，应报 `LAYOUT_AMBIGUOUS`，**不能**只装其中一个。

CET 进游戏后按 `~`，能看到模组列表才算 Lua 加载成功；只看文件存在不算。

## 3. `.xl` 与加载顺序

- 一个 ArchiveXL 模组通常包含 `foo.archive` + `foo.xl`（有时还有 `.xlp`）；两者应同时出现在 `archive\pc\mod`。
- `.xl` 不单独排序，跟随所属 archive。加载顺序页只列 `.archive` 是正确的。
- 制造两个不同路径但同名的 `.archive`：启动器应在部署前拦截，因为目标路径相同。
- 两个 archive 内部资源冲突无法从文件路径检测；这种情况只能靠作者说明/游戏日志，启动器不会假装能检测。

## 4. Mod Settings

1. 安装 Mod Settings 框架和一个使用它的模组，进游戏改一次设置，生成：
   `bin\x64\plugins\cyber_engine_tweaks\mods\ModSettings\user.ini`。
2. 打开启动器的「Mod 设置」，确认 section / key 出现。
3. 改一个布尔值和一个数字，保存。
4. 检查：
   - `user.ini.bak` 存在；
   - 原文件里的注释、其它 key、section 顺序未变；
   - 当前修改的那个值已变。
5. 点「恢复 .bak」，确认值回到保存前；`user.ini.before-restore.bak` 存在。

数字项是精确输入框，不是滑块：`user.ini` 不保存 min/max/step，滑块范围只能来自模组 Lua 描述，启动器不猜。

## 5. 日志查看器

打开「运行诊断 → 查看日志」：

- `r6\logs\redscript.log` 应被列出；
- 末尾 100 行显示，`[ERROR]` / `failed` 行红色，`[WARN]` 行橙色；
- 文件大于 256 KB 时显示截断提示；
- 选择 300/500 行会重新读取；
- 日志目录外的文件不能通过 IPC 读取（这是后端白名单，不是前端隐藏）。

## 6. AI 服务（任意 OpenAI 兼容端点）与 Nexus 真实 Key

这两项没有真实 Key 时无法完成线上验收：

- AI 服务：选一次预设（或手填 Base URL + 模型名）→ 填 Key → 勾选同意 → 运行一次诊断，确认返回 JSON 建议；在该服务商的用量页确认请求确实发生。Key 应只存在 DPAPI 文件 `<data>/secrets/ai-api.key` 中，不出现在 `launcher-state.json`。
- Nexus：免费账号只能浏览/打开下载页；Premium 才能「下载并导入」。如果 API 返回 401/429，界面应显示真实错误，不回退到假数据。

## 7. 回滚

1. 启用两个模组。
2. 点「恢复原状」。
3. 确认所有 `deployedFiles` 被撤除、`r6/config` 和 `modlist.txt` 恢复到首次部署前。
4. 确认暂存区仍在，重新启用不需要重新解压。

## 8. 状态文件往返（每次发版必做）

改过 schema、反序列化器或数据目录后，在真机上做一次**往返**验证：

```text
1) 记录当前规模
   state = %APPDATA%\com.arol.cyberdeck\launcher-state.json
   （若不存在则用 exe 同级 cyberdeck-data\launcher-state.json）
   before = 该文件里的 mods 条数

2) 启动器启动 → 正常退出 → 记 after1 → **再启动一次** → 正常退出 → 记 after2
   期望：after1 == before 且 after2 == after1，
        且 **没有** launcher-state.broken-*.json 出现

   为什么要连续两次：本次事故的性质是「**每次启动都清空一次**」，
   单次往返可能刚好看起来正常（首次读到的已是被上一版清空过的状态）；
   连续两次才能稳定暴露"每次启动都在清"这类问题。

3) 判定
   mods 数变 0，或出现 broken-*.json  ⇒ 反序列化把文件判成损坏并清空了，必须修
```

判定要点：**状态文件里的模组数在一次"启动→退出"前后必须完全一致**；
出现 `broken-*.json` 就说明走了"判定损坏"分支（无论界面看起来是否正常）。

## 8.1 确认 exe 里的前端产物与当前源码一致

发版前确认"你手上这个 exe 真的装了最新前端"。**光看时间戳会看错**：`vite build` 重跑会重写
文件的 mtime，但内容可能一字未改；反过来 exe 也可能早于某次改动。

判定原理：**vite 的产物文件名里带的是内容哈希**（`index-<hash>.js`）。内容不变 → 哈希不变 →
文件名不变。所以"文件名对得上"就等于"内容对得上"，比 mtime 可靠得多。

```text
1) 记下当前 dist 的产物名
   dist\assets\index-*.js   和   dist\assets\index-*.css

2) 看 exe 内嵌的是不是同一份
   exe 若是明文嵌入，可以在二进制里搜产物名（用 PowerShell 读成 ASCII 再匹配，
   比 findstr 干净——findstr 搜二进制会吐一堆乱码，容易误判）：
     $b=[IO.File]::ReadAllBytes('<exe 路径>')
     $s=[Text.Encoding]::ASCII.GetString($b)
     $s.Contains('index-<hash>.js')      # True = 带的是当前这份 dist
   搜到当前 hash、且搜不到任何旧 hash 名 ⇒ exe 带的是最新前端

3) 要更强的证据就做一次双向实验
   a) 改一处**会进 bundle 的真实字符串**（例如某个界面文案）
   b) vite build → 产物文件名应变成别的 hash
   c) 还原源码 → vite build → 产物文件名应精确回到原来的 hash
   d) 还原后的产物与 exe 内嵌的那份逐字节相同 ⇒ 完全同步
```

两个容易踩的点：

- **只改注释不会让 hash 变** —— 注释在打包时被 strip 掉。所以第 3 步必须改**真实字符串**，
  否则会误以为"hash 不敏感"。
- **exe 改成压缩嵌入后，第 2 步的搜索会失效** —— 这是嵌入方式变了，不是异常。
  这时改用第 3 步的双向实验来判定，不要因为搜不到就断定"exe 里是旧产物"。


## 9. 失败时带什么回来

请把以下内容一起发回，不要只说“没生效”：

- 启动器版本（侧边栏底部）；
- 导入结果里的 `INFO.JSON` / `FILENAME` 和布局；
- 启用 toast 的三个链接计数；
- `launcher-state.json` 里该模组的 `deployedFiles`；
- `scripts\real-env-check.ps1` 的完整输出；
- 相关日志的末尾 100 行（用查看器截图或复制）。

**最硬的判定方法（2026-10-26 事故后新增）**：真机启动后看 `cyberdeck-data/startup.log` 有没有
`stage=frontend`——这行是前端挂载后调用 `bootstrap` 时写的。**有 = 界面真的起来了；没有 = 界面没加载**
（典型原因：用 `cargo build --release` 而漏了 `--features custom-protocol`，产物退化成 dev 形态，
去连 `http://localhost:1420`，用户看到的是「localhost 拒绝连接」）。
注意：exe 里出现 `localhost:1420` **不能**作为 dev 判据——那是被内嵌的配置文本，正常包也有。

## 10. 本地模型（Ollama / 任意 OpenAI 兼容端点）待验项

> 2026-11-07 补回：`PROJECT_HISTORY §3.7` 一直引用「已知差异 6 项，见本文」，此前本文并没有这份清单。
> 代码层已用 mock HTTP 服务器覆盖同等协议路径；**实机链路仍未跑**（用户 2026-11-07 明确不装 Ollama）。

**静态已确证**

| 项 | 结论 |
|---|---|
| 无 `usage` 字段 | 无影响：`ChatResponse` / `AnthropicResponse` 都不解析 `usage` |
| 流式响应 | 无影响：请求不含 `stream`，响应按完整 JSON 一次性解析 |
| `/v1/models` 形状 | 已兼容 `data` / `models` / 裸数组 + `name` / `model` 别名 |
| 无 Key 调用 | 2026-11-07 已修：`resolve_chat_key` 仅对回环地址放行匿名；公网漏填 Key 仍报 `AI_NOT_CONFIGURED`。复盘见 `docs/INCIDENT-2026-11-07-ollama-no-key.md` |

**待实机（装 Ollama 后逐条打勾）**

1. `response_format: {"type":"json_object"}` 是否被 Ollama OpenAI 兼容层接受；不接受则诊断 / 翻译全落 `AI_HTTP` 或空响应。
2. `max_tokens` 是否映射到 `num_predict`；400–3000 档是否被截断。
3. `/v1/models` 实际 `id` 是否带 `:latest`，与预设示例名是否对得上。
4. 错误响应形状（模型未拉取 / 上下文超限）能否被 `error_body_message` 抠出 `message`。
5. 代理劫持：`NO_PROXY=127.0.0.1,localhost` 是铁律；`build_client` 静态未见 `.no_proxy()`，需实测 `http://localhost:11434` 是否被系统代理拦。
6. 75s 总超时 / 15s 连接超时：7B 小模型首次冷启动是否够。
7. 三条链路双端：列模型 / 翻译一条 Mod 名 / AI 诊断，DeepSeek 云端 + Ollama 本地都跑通。
8. Key 隐私：只出现在 `<data>/secrets/ai-api.key`，`launcher-state.json` 无明文。

配置步骤：设置 → AI 配置 → 选 Ollama 预设（Base URL `http://localhost:11434/v1`）→ **Key 留空** → 模型名以 `ollama list` 为准 → 勾选同意后运行。帮助中心 FAQ `ai-setup` 同源。
