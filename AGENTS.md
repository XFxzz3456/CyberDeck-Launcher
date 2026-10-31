# AGENTS.md — CyberDeck Launcher 执行规范

> 本文件是**执行层**规范：目录约定、版本发布流程、构建与门禁命令。
> **规则级**长期结论（铁律、环境坑、事故教训）收敛在 `docs/MEMORY-CANON.md`，两者配合阅读。
> 修改本文件需在 `CHANGELOG.md` 留痕。

---

## 0. 目录与路径（2026-10-29 起生效）

| 用途 | 路径 |
|---|---|
| 源码（项目根） | `D:\用户\CyberDeck-Launcher\src` |
| 发行产物 | `D:\用户\CyberDeck-Launcher\release` |
| 便携包产物 | `D:\用户\CyberDeck-Launcher\发布产物` |
| 一次性脚本归档 | `D:\用户\CyberDeck-Launcher\归档` |
| 构建缓存 | `src\src-tauri\target`（勿手删，改名后需重编） |
| 工具链缓存 | `D:\用户\CyberDeck-Launcher\.tools`（⚠️ 打了 Low 完整性标签，普通用户进程写不进） |

> 2026-10-29 由 `D:\用户\工作区` 重命名为 `D:\用户\CyberDeck-Launcher`；
> 2026-10-28 由 `CyberDeck-Launcher-src-0.7.0` / `CyberDeck-Launcher-0.7.0-release` 改为 `src` / `release`。
> 旧路径若出现在 2026-10-29 之前的 `CHANGELOG.md`、`docs/INCIDENT-*`、历史报告里，属**历史事实，不回改**。
>
> ⚠️ 改名后**必须** `pnpm install` 复核：pnpm 旧版写的是绝对路径软链，改父目录会整片断链。
> 2026-10-29 实测重装后（pnpm 12.8.1）软链已变为相对路径 `.pnpm/...`，理论上再改名不断，但仍需复核一遍。
> 改名后 `cargo` 侧的 `target` 会因指纹里的绝对路径变化而全量重编（数据不丢，只是慢）。

---

## 1. 版本更新自动化规范（Version Bump Rules）

**每次发布新版本（如 0.8.0 → 0.8.1 或 0.9.0）时，必须同步以下所有位置，缺一不可。**

### 1.1 配置文件同步 —— 三处，不是两处

| 文件 | 字段 | 说明 |
|---|---|---|
| `package.json` | `version` | 前端与 vite 注入源 |
| `src-tauri/Cargo.toml` | `[package] version` | Rust crate 版本 |
| `src-tauri/tauri.conf.json` | `version` | **打包进 exe 的真实版本**，`app.getVersion()` 读它 |

三者必须**完全一致**。只改前两处、漏掉 `tauri.conf.json`，会出现「关于页显示 0.8.1、实际包是 0.8.0」的假版本。

一条命令自检：

```bash
grep -H '"version"' package.json src-tauri/tauri.conf.json; grep -H '^version' src-tauri/Cargo.toml
```

### 1.2 前端显示同步 —— 严禁硬编码

- **唯一取数入口**：`src/lib/appVersion.ts` 的 `useAppVersion()`。
- 取数优先级：
  1. Tauri runtime `app.getVersion()`（真实版本）
  2. `__APP_VERSION__`（vite 在 `vite.config.ts` 从 `package.json` 注入，供浏览器预览 / UI 测试）
  3. `"DEV"`（两者都拿不到时的显式标记，**绝不**回退到某个看起来真实的版本号）
- 已改造位置：`SettingsView.tsx`（设置 → 关于）、`Sidebar.tsx`（侧边栏底部）。
- `src/i18n/zh-CN.ts` 里的 `app.version` 键**已删除**，不要再加回来。
- 新增任何显示版本号的地方，一律 `const appVersion = useAppVersion();`。
- **禁止**在 `.ts` / `.tsx` / i18n 文案里写版本字面量（`"v0.8.0"`、`"0.8.0"`）。

违规自检（排除模拟数据的模组版本号与注释行，应输出空）：

```bash
grep -rn '"v\?[0-9]\+\.[0-9]\+\.[0-9]\+"' src/ --include="*.ts" --include="*.tsx" \
  | grep -v 'src/lib/mock.ts' | grep -v ':[[:space:]]*\*'
```

> 例外：`src/lib/mock.ts` 里的 `version` 字段是**模组/游戏**版本，不是应用版本，不在此列。

### 1.3 打包输出重命名 —— 用动态变量

- 打包脚本/命令中**不得**出现写死的版本号文件名（如 `CyberDeck-Launcher-v0.8.0.exe`）。
- 主产物 `CyberDeck Launcher.exe` 自身不带版本号，版本信息在 exe 资源里（由 `tauri.conf.json` 决定），这是首选做法。
- 需要带版本号的外发文件（便携 ZIP 等）时，从 `package.json` 读版本再拼名，禁止手写。
  反例：`CyberDeck Launcher 0.7.0 便携版-可直接发人.zip` —— 手写版本，升级后必然忘记改。

### 1.4 Git 标签

- 提交后打标签：`git tag v0.8.0`，并 `git push --tags`。
- ⚠️ **本仓库当前不是 git 仓库**（无 `.git` 目录）。在 `git init` + 首次提交完成前，版本追踪依赖 `CHANGELOG.md`。建立仓库后，本条转为强制执行。

### 1.5 版本发布收尾 checklist

- [ ] 三处 `version` 完全一致
- [ ] `cargo check` 通过（`NO_PROXY=127.0.0.1,localhost`）
- [ ] `tsc --noEmit` + `vite build` 通过
- [ ] `node scripts/gate.mjs` 全绿
- [ ] `CHANGELOG.md` 追加版本段（时间 / 标号 / 模块 / 新增·变更·修复 / 验证 / 边界）
- [ ] `HANDOFF.md` 更新版本状态段
- [ ] `docs/MEMORY-CANON.md` 第 4 节「当前版本状态」更新
- [ ] 资料库 + 项目网盘双同步
- [ ] `git tag vX.Y.Z`（仓库建立后强制执行）

---

## 2. 常用命令

```bash
# 前端类型检查
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# 前端构建
node node_modules/vite/bin/vite.js build

# Rust 静态检查（必须带 NO_PROXY，否则 mock 服务器被代理拦）
NO_PROXY=127.0.0.1,localhost cargo check

# Rust 测试
NO_PROXY=127.0.0.1,localhost cargo test

# 全量门禁（cargo test → tsc → vite build → 7 个 UI 脚本）
NO_PROXY=127.0.0.1,localhost node scripts/gate.mjs

# 正式构建（只能用 tauri.cmd，且关 LTO）
CARGO_PROFILE_RELEASE_LTO=false node_modules/.bin/tauri.cmd build --no-bundle
```

🔴 **绝不能只用 `cargo build --release`**：`tauri/build.rs` 里 `dev = !has_feature("custom-protocol")`，缺该 feature 就不内嵌前端，用户看到 `ERR_CONNECTION_REFUSED`。必须用 cargo 时报加 `--features custom-protocol`。

---

## 3. 安全红线（改 Rust 前必读）

1. 卸载**只信任 `deployed_files` 清单**，绝不推测；
2. 路径拼接必须过 `safe_join` + `is_within`；
3. 硬链接身份比对必须用 `GetFileInformationByHandle`；
4. **Mutex 内不做 IO**：无锁 IO → 短锁登记 → 锁外 emit。

其余铁律（数据文件、环境归因、工具链踩坑）见 `docs/MEMORY-CANON.md` 第 2 节。

---

## 4. 数据目录（不要当垃圾清）

`release\cyberdeck-data\` 是**真实运行数据**，不是产物：

| 内容 | 说明 |
|---|---|
| `launcher-state.json` | 模组库索引（约 350 KB，195+ 条） |
| `secrets/` | DPAPI 加密的 API Key |
| `staging/` | 暂存区 |
| `EBWebView/` | WebView2 用户配置（约 130 MB） |
| `startup.log` | 启动诊断日志（GUI 无控制台，这是唯一线索） |

清理 `release` 目录时只能删 `*.prev.exe`、旧安装包、`run-*.txt`，**不得**删数据目录。
`nightcity-data/` 若再次出现，**只可能是运行了 0.7.0 旧 exe**（如 `CyberDeck Launcher.prev.exe`）——当前源码与 `tauri.conf.json`（`com.arol.cyberdeck`）已不含该名字。遇先确认是谁写的（读其 `startup.log` 的 `preferred=` 与 `data_dir=`），删前记录证据，别直接清。

---

## 5. 文档落点

| 落点 | 位置 |
|---|---|
| 源码 | `CHANGELOG.md`、`HANDOFF.md`、`docs/*`、`AGENTS.md`（本文件） |
| 资料库 | space `btCAC0glhsDub7qu3xaeLI`；**以空间内最新同名节点为准**（每次上传新建节点，不要在本文件记录 node id，会永远过期） |
| 项目网盘 | tdrive 根 `CyberDeck Launcher 项目文档` = `YbyPEuDRRBHW`；6 个子目录及 `dir_id` 见 `docs/MEMORY-CANON.md` 第 3 节，上传时 `dir_id` 必须传子目录 id |

资料库**无删除接口**，清理只能移入「历史归档」`BCdu1Ae573PdgfNEQ9c7AD` 或由人工在界面删除。
