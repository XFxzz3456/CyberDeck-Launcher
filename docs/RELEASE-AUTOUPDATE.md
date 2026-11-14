# 自动更新与发版流水线

本文只讲「客户端怎么拿到更新」和「怎么发一个能被客户端认出来的版本」。
构建链、门禁、便携包结构的来龙去脉见 `AGENTS.md` 与 `scripts/release.mjs` 顶部注释。

---

## 1. 链路总览

```
客户端                                   GitHub
────────────────────────────────────────────────────────────────────
设置 → 检查启动器更新
  └─ tauri-plugin-updater check()
       └─ GET plugins.updater.endpoints
          https://github.com/XFxzz3456/CyberDeck-Launcher
                 /releases/latest/download/latest.json   ──────►  latest.json
       ◄── version / notes / platforms["windows-x86_64"].url
       ◄── platforms["windows-x86_64"].signature
  └─ 版本比本机新 → 问用户 → downloadAndInstall()
       ├─ 下载 url 指向的更新包（zip / exe / msi）
       ├─ 用 latest.json 里的 signature 对照内置 pubkey 验签
       ├─ 解压（zip 只读第一层，找 .exe / .msi）
       └─ 调起安装器（windows.installMode = passive，静默带进度条）
```

三个环节缺一不可，任何一环不对，客户端只会表现为「检查更新失败」：

| 环节 | 由谁保证 | 失效表现 |
| --- | --- | --- |
| `latest.json` 存在且是**最新 Release** 的资产 | 发版流水线第 15 步 | 404，客户端报网络/解析错误 |
| `signature` 能被 `pubkey` 验通 | `scripts/make-latest-json.mjs`（签名）+ 仓库里的 pubkey | 签名不匹配 |
| `url` 指向**可安装**的更新包 | 流水线第 8/9 步 | 下载成功但安装阶段报 `BinaryNotFoundInArchive` |

---

## 2. 一次性配置：GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → **New repository secret**，加两个：

| Secret 名 | 值 | 从哪来 |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件的**全部内容**（含 `untrusted comment:` 行与换行） | `src/.tauri/updater.key` 的正文 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设的密码 | 生成时由你自己定；没设密码就留空字符串 |

要点：

- 密钥是 `tauri signer generate` 的产物。本项目的密钥对**已经生成好了**：
  私钥在 `src/.tauri/updater.key`（`.gitignore` 第 46 行已忽略，从未入库），
  公钥在 `src/.tauri/updater.key.pub`，公钥的 base64 已经写进
  `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
- **不要重新生成密钥**。重新生成等于换公钥，所有已发布客户端立刻验不过新包（见第 6 节）。
- 私钥只经环境变量进入工作流（`TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD`），
  不进命令行参数、不进仓库、不 `echo`。`scripts/make-latest-json.mjs` 的
  `--key` 参数只用于本机调试。
- 私钥也有时效风险：丢私钥 = 以后再也签不出能被旧客户端接受的包，只能让用户手动重装。
  所以 `src/.tauri/` 记得另存一份离线副本（密码管理器 / 加密盘）。

---

## 3. 发一个版本（tag 触发）

```bash
# 1) 升版：三处版本号 + CHANGELOG 一起改（脚本保证同值）
npm run bump                     # 或 npm run release 一次性做完升版+构建

# 2) 提交
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore(release): 1.8.5"

# 3) 打 tag 并推送 —— 这一步会触发 .github/workflows/release.yml
git tag v1.8.5
git push origin main --tags
```

推送 tag 之后，工作流按顺序做 15 步（每步都有带序号的中文名，红叉停在哪一步就是哪一步出问题）：

1. 检出源码 → 2–5. pnpm / Node 20 / Rust stable / cargo 缓存 / 装依赖
6. **版本守门**：`tag` 必须等于 `package.json` 版本，且三处版本号同值，否则立刻停
7. **全量门禁** `npm run gate`（cargo test + tsc + vite build + 38 个 UI 验收脚本）
8. **构建**：`tauri build --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":true}}'`
9. 定位产物并改成稳定文件名（NSIS 产物名带空格，上传前换成无空格名）
10. 组装便携包（4 条目结构见第 5 节）
11. 解压实测校验便携包结构
12. 生成更新说明
13. **生成 latest.json**（用 secrets 里的私钥对更新包签名）
14. 校验 latest.json（版本、平台键、url 指向本次更新包）
15. 发布 Release 并上传四个资产

发完之后手动确认一次：

```bash
curl -sL https://github.com/XFxzz3456/CyberDeck-Launcher/releases/latest/download/latest.json
```

返回的 `version` 应该是刚发的版本，`url` 能直接下载到更新包。
再拿一个旧版本客户端点一次「检查启动器更新」，能弹出更新提示即为打通。

---

## 4. latest.json 各字段含义

```json
{
  "version": "1.8.5",
  "notes": "### CyberDeck Launcher v1.8.5\n\n- ...",
  "pub_date": "2026-11-14T13:24:02Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "url": "https://github.com/XFxzz3456/CyberDeck-Launcher/releases/download/v1.8.5/CyberDeck.Launcher.1.8.5.x64-setup.nsis.zip"
    }
  }
}
```

| 字段 | 含义 | 注意 |
| --- | --- | --- |
| `version` | 更新包声称的版本号，与客户端当前版本比较 | 必须与 tag、`package.json`、`tauri.conf.json` 同值，否则客户端要么看不到更新，要么装错包 |
| `notes` | 更新说明，客户端弹窗会显示 | 由 `dist-release/notes.md` 生成，与 Release 正文同源 |
| `pub_date` | 发布时间（UTC，秒级） | 只用于展示与排查，不参与升级判定 |
| `platforms` | 平台键 → 资产表 | 本项目只有 `windows-x86_64` |
| `platforms.*.url` | 更新包下载地址 | **必须 https**；更新器默认拒绝明文 http |
| `platforms.*.signature` | 更新包的 minisign 签名（`.sig` 文件全文） | 用内嵌 `pubkey` 验；验不过就不装 |

### 为什么资产名 `latest.json` 一个字都不能改

`src-tauri/tauri.conf.json` 里写死了：

```
plugins.updater.endpoints[0] =
  https://github.com/XFxzz3456/CyberDeck-Launcher/releases/latest/download/latest.json
```

这个地址只有「资产名精确等于 `latest.json`」时才命中。改名 / 挪到别的 Release /
只在 draft 里存在，都会让所有已发布客户端 404。同理，这条 URL 走的是
`/releases/latest/`，所以每次发布都必须**成为 latest Release**——工作流里
`make_latest: true` 就是干这个的，别随手改成 draft 或 prerelease。

---

## 5. 更新包 ≠ 便携包（最容易踩的坑）

Tauri v2 的更新器**不负责替换文件**，它只负责「把下载到的安装器跑起来」。
`tauri-plugin-updater` 的 `extract_zip` 只读 zip 的**第一层**、且只认 `.exe` / `.msi`。

| 资产 | 谁用 | 能否作为更新源 |
| --- | --- | --- |
| `CyberDeck.Launcher.<版本>.zip`（便携包，根目录是 `CyberDeck Launcher <版本>/`） | 人手下载、解压即用 | ❌ 解压后第一层没有 exe，报 `BinaryNotFoundInArchive` |
| `CyberDeck.Launcher.<版本>.x64-setup.exe`（NSIS 安装器） | 人手动安装 | ✅ 可用 |
| `CyberDeck.Launcher.<版本>.x64-setup.nsis.zip`（NSIS 更新包，内含 setup.exe） | **自动更新**（latest.json 的 `url` 指向它） | ✅ 本项目的选择 |
| `latest.json` | 自动更新清单 | — |

便携包结构固定四条，改之前先想清楚（老用户按这个形态放置数据目录）：

```
CyberDeck Launcher <版本>/
  ├ CyberDeck Launcher.exe
  ├ WebView2Loader.dll
  ├ 使用说明.txt
  └ cyberdeck-data/说明-数据目录.txt        ← 必须自带，否则首跑把数据落进 %APPDATA%
```

> ⚠️ 已知语义差异：自动更新跑的是 NSIS 安装器，它会把新版本装到
> `%LOCALAPPDATA%`（`installMode: currentUser`），**不会**就地替换便携目录里的 exe。
> 只用便携包的用户建议手动下载新版覆盖；长期方案（便携版就地更新）需要自研
> 解压替换逻辑，不在当前插件能力范围内。

---

## 6. ⚠️ 换签名密钥 = 旧客户端全部断更

签名验证是「包里的签名」对「客户端内置的 pubkey」。一旦换了密钥对：

- 旧客户端里内置的还是**旧 pubkey**，新包用的是**新私钥** → 验签失败，
  自动更新永久不可用（表现就是「检查更新失败」，且没有任何自动恢复手段）；
- 唯一出路是让用户手动下载新版重装一次；
- 如果新旧客户端的 identifier 一致、但 `pubkey` 不同，也不会「自动迁移」。

所以：

1. **不要**为了「重置」而重新 `signer generate`；
2. 私钥与密码都要有离线备份；
3. 真的必须换（比如私钥泄露）时，按「大版本迁移」处理：
   提前在公告里说明，让所有人手动下载一次新版，并在新版本里保留一段时间的
   降级提示（当前实现：`App.tsx` 的 `handleCheckAppUpdate` 在失败时给
   「打开发布页」按钮，正是给这种场景留的出口）。

---

## 7. 排查表

| 现象 | 先看哪里 |
| --- | --- |
| 客户端一直提示「自动更新暂不可用」 | 浏览器打开 `.../releases/latest/download/latest.json`：404 → 资产名/Release 状态不对；能下载 → 签名或 url 问题 |
| 工作流红在第 6 步 | tag 与 `package.json` 版本不一致，删 tag 重打 |
| 工作流红在第 8 步 | 两个 secrets 没配或密码不对（`createUpdaterArtifacts` 需要私钥才能签名） |
| 工作流红在第 9 步 | `createUpdaterArtifacts` 没生效：`--config` 里的 JSON 被 shell 吃掉引号了 |
| 工作流红在第 11 步 | 便携包结构被改动（多套/少套一层目录，或漏了 `cyberdeck-data/说明-数据目录.txt`） |
| 工作流红在第 13 步 | 签名失败：私钥正文不完整（缺 `untrusted comment:` 行或多行被压成一行）、密码错 |
| 下载成功但提示安装失败 | `url` 指向的是便携包而不是 `*-setup.nsis.zip` |
| 新版本发了但客户端看不到 | `version` 没升、或这次 Release 不是 latest、或客户端缓存（重启客户端再试） |
