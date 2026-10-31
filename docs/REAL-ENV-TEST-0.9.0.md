# 0.9.0 真机验收：自动化脚本 + 手动检查清单（对应看板【10】）

> 真机环境：`D:\steam\steamapps\common\Cyberpunk 2077`（本机实测，2026-10-29）
> 自动化脚本：`scripts/real-env-check.ps1`
> 结论：**预检 0 failure**；破坏性链路（部署/启动/卸载）需按下面清单人工跑一遍并留证。

## 一、自动化预检结果（本次实测，2026-10-29 01:55）

命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\real-env-check.ps1 -GameDir "D:\steam\steamapps\common\Cyberpunk 2077"
```

输出摘要（`RESULT: 0 failure(s)`）：

| 项 | 结果 | 值 |
|---|---|---|
| 游戏可执行文件 | PASS | `bin\x64\Cyberpunk2077.exe` |
| 卷 / 文件系统 | PASS | `D:` NTFS |
| 剩余空间 | INFO | 137.7 GB |
| 游戏版本 | INFO | `3.0.5294808` |
| 提权状态 | INFO | 普通权限（硬链接不需要提权） |
| `archive\pc\mod` | PASS | 存在可写 |
| RED4ext | PASS | `red4ext\RED4ext.dll` |
| ArchiveXL | PASS | `red4ext\plugins\ArchiveXL\ArchiveXL.dll` |
| TweakXL | PASS | `red4ext\plugins\TweakXL\TweakXL.dll` |
| CET dll | WARN | 未安装（`bin\x64\plugins\cyber_engine_tweaks\` 缺失） |
| redscript-cli | WARN | 未安装 |
| ModSettings / user.ini | WARN | 未安装（依赖 CET） |
| redscript.log | WARN | 未生成（依赖 redscript 运行） |
| CET log | PASS | 存在 |
| 启动器状态文件 | WARN | 脚本按 ANSI 读取导致中文乱码解析失败（**脚本侧问题，非产品缺陷**；见下"已知脚本缺陷"） |

> 说明：WARN 项代表"该框架未安装"，不影响 ArchiveXL 类 Mod 的验收；CET / redscript 相关链路需先装对应框架才能验。

### 已知脚本缺陷（待修，不影响产品）

`real-env-check.ps1` 用 `Get-Content` 默认编码读 `launcher-state.json`，遇到中文（"其他"分类、中文描述）会把 UTF-8 当 ANSI 解读并截断 JSON，输出"could not parse"。修法：`Get-Content -Raw -Encoding UTF8`。该项列入 0.9.1 小修，不在本次验收阻塞项内。

## 二、手动检查清单（必须逐项留证）

> 每项记录：操作时间 / 预期 / 实际 / 证据路径（截图存 `docs/screenshots/0.9.0/`，日志贴关键行）。

### A. 硬链接部署（同卷）

1. 导入一个真实 `.archive` Mod（或带 `.archive` + `.xl` 的组合包）。
2. 启用 → 打开 `archive\pc\mod`。
3. 预期：文件出现；`fsutil hardlink list "<文件>"` 显示 2 条路径（暂存区 + 游戏目录）。
4. 证据：`fsutil` 输出贴到本文件"验收记录"段。

### B. 启动游戏生效

1. 启动 CP2077，进主菜单 → 读档进游戏。
2. 预期：Mod 效果可见（服装/载具/UI 至少一项可肉眼确认）。
3. CET 类 Mod：按 `~` 打开控制台，`Game.GetMods()` 或 CET 日志中能看到该 Mod 名。
4. 证据：CET 日志路径 `bin\x64\plugins\cyber_engine_tweaks\cyber_engine_tweaks.log` 关键行。

### C. 卸载无残留

1. 停用并卸载该 Mod。
2. 预期：`archive\pc\mod` 中对应文件消失；`deployed_files` 清单为空。
3. 反查残留：列出 `archive\pc\mod` 全部文件名，与库中 Mod 清单比对，未登记文件数 = 0。
4. 证据：比对结果截图 + 状态文件中该 Mod 的 `deployedFiles: []`。

### D. 跨盘降级

1. 用 `subst X: D:\cdl-crossdrive-test` 造第二卷（或用真实不同盘符的暂存目录）。
2. 把暂存目录设到 `X:`，部署同一 Mod。
3. 预期：`linkType` 为 `copy`，日志有"跨卷，降级为复制"字样；功能与硬链接一致。
4. 收尾：`subst X: /D`，删除测试目录。

### E. 冲突与诊断

1. 同时启用两个含同名文件的 Mod → 打开诊断页。
2. 预期：冲突条目列出双来源与相对路径；不会自动改文件。

### F. 安全模式（0.9.0 新增）

1. 记录当前启用 Mod 数与游戏目录文件数。
2. 设置 → 安全与维护 → 进入安全模式 → 二次确认。
3. 预期：启用数归 0、部署文件全部撕除、**暂存区文件数不变**（这是关键红线）。
4. 启动游戏：能进主菜单，无任何用户 Mod 加载。
5. 恢复到禁用前 → 预期：启用集合与顺序完整还原，部署文件数回到步骤 1。
6. 证据：三步的数字截图（前 / 安全模式下 / 恢复后）。

### G. 过期插件扫描（0.9.0 新增）

1. 构造夹具：一个 `manifest.json` 声明 `game_version: "2.21"` 的假 Mod。
2. 扫描 → 预期：该 Mod 标红"待适配"。
3. 再放一个无任何版本声明的 Mod → 预期：标黄"兼容性未知"，**不标红**。

### H. 配置导入导出（0.9.0 新增）

1. 导出配置 → 打开 JSON 检查：无 `api_key` / `dpapi` / 密钥字段。
2. 手动改坏一个字符 → 导入 → 预期：明确报错，设置未被改动。
3. 清空设置后导入正常文件 → 预期：主题/AI 地址/路径/播放集还原，提示重新填 Key。

### I. 帮助中心（0.9.0 新增）

1. 断网 → 打开帮助中心。
2. 预期：6 篇教程 + ≥8 条 FAQ 完整可读，折叠面板展开正常。

### J. AI 三条链路

1. DeepSeek（云端）：列模型 → 翻译一条 Mod 名 → 诊断一次。
2. Ollama（本地，若已装）：Base URL `http://localhost:11434/v1`，Key 留空，重复上一步。
3. 预期：两条链路都成功；失败时错误为中文可照做的提示（401/429 映射）。

## 三、破坏性操作的代码级兜底（已实现，验收时抽查）

| 风险 | 兜底 | 位置 |
|---|---|---|
| 路径越界写入 | `safe_join` + `is_within` 双重校验 | `store.rs` |
| 卸载误删 | 只按 `deployed_files` 撕除，不做任何推测匹配 | `installer.rs` |
| 部署半途失败 | 整批回滚，不留半成品 | `installer.rs` |
| 安全模式删用户文件 | 只断链接，不删 staging；二次确认弹窗 | `safemode.rs` |
| 配置导入写脏状态 | schema 版本校验 + 白名单 + 解析失败即中止 | `config_pack.rs` |
| 状态文件解析失败 | 保留 `broken-*.json` 备份，不静默清空 | `store.rs` |

## 四、验收记录（人工填写）

| 项 | 日期 | 结果 | 证据 |
|---|---|---|---|
| A 硬链接部署 | | | |
| B 启动生效 | | | |
| C 卸载残留 | | | |
| D 跨盘降级 | | | |
| E 冲突诊断 | | | |
| F 安全模式 | | | |
| G 过期扫描 | | | |
| H 配置导入导出 | | | |
| I 帮助中心 | | | |
| J AI 三条链路 | | | |

发现的缺陷一律回录看板【1】bug 轨道，修复后在本表追加"复测"行。

## 五、发布前预检里补上的两项（2026-10-29 02:15）

### 5.1 命令契约门禁（`scripts/check-commands.mjs`）

发布前发现 6 个命令只定义未注册（详见 `docs/INCIDENT-2026-10-29-command-not-registered.md`），现固化为门禁：

```bash
node scripts/check-commands.mjs
# 期望：commands=102 registered=102 invoked=98 missing=0 unresolved=0
```

`missing` = 定义了没进 `generate_handler!`（前端必报 command not found）；
`unresolved` = 前端 `invoke` / `call` 了没有的命令。任一非零即失败。

### 5.2 便携包解压实测（自动化）

解压到临时目录 → 运行 exe → 读该目录下的 `cyberdeck-data/startup.log`（**必须 `-Encoding UTF8`**）。

判据（两条都要看，只看第一条会漏）：

1. `stage=frontend` —— 前端挂上了；
2. `stage=load ok dir=<临时目录>\...\cyberdeck-data` —— **数据落在 exe 同级**，便携模式成立。

> ⚠️ 已知边界：在一台**运行过** CDL 的机器上首跑，会把 `%APPDATA%\com.arol.cyberdeck` 的旧状态继承进来
> （模组库、`stagingDir` 仍指向 AppData）。这是既有迁移逻辑（当年改名靠它救回 195 个模组），不是本次回归。
> 想要干净的便携体验：在从未运行过 CDL 的机器上用，或首跑前把 AppData 目录改名。

### 5.3 本次实测结果（2026-10-29 02:20）

| 项 | 结果 |
|---|---|
| `check-commands.mjs` | commands=102 registered=102 invoked=98 missing=0 unresolved=0 |
| 便携包结构 | 父文件夹 + exe + WebView2Loader.dll + `使用说明.txt` + `cyberdeck-data`（含占位说明） |
| 解压首跑 | `stage=load ok dir=<临时目录>\...\cyberdeck-data`、`stage=frontend mods=195` |
| 继承 AppData 旧状态 | 已确认存在（195 个模组，`stagingDir=C:\Users\...\com.arol.cyberdeck\staging`），属既有行为 |
