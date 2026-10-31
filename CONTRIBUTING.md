# 贡献指南（CONTRIBUTING）

感谢关注 CyberDeck Launcher！这是一个个人维护为主的开源项目（MIT），欢迎 Issue 与 PR。

## 提交 Issue

- 报 bug 请附：启动器版本（设置 → 关于）、`cyberdeck-data/startup.log` 末尾 50 行、复现步骤。
- 功能建议请说明使用场景，而不是只写「希望支持 X」。

## 提交 PR

1. Fork 后从 `main` 拉分支，一个 PR 只做一件事（对应上游「一次只改一个变量」的铁律）。
2. 提交信息带前缀：`feat:` / `fix:` / `docs:` / `chore:`；作者身份必须与 GitHub 账号一致。
3. 改完必须跑通：`npx tsc --noEmit`、`npm run build`、`cargo test --lib`（src-tauri 下）、`node scripts/gate.mjs`。
4. 涉及状态文件 / 序列化的改动，必须用真实旧数据验证「整个文件仍能解析」。

## 红线

- **密钥永不入库**：任何 API Key、PAT、DPAPI 密文不得进入提交。
- **更新签名私钥**：`tauri-plugin-updater` 的私钥放在 `.tauri/updater.key`（已在 `.gitignore` 里），发版时通过环境变量 `TAURI_SIGNING_PRIVATE_KEY` 传给构建；公钥写在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，可公开。私钥或密码丢失后，老版本将无法自动更新到新版本。
- **产物不入库**：`release/`、`发布产物/`、`node_modules`、`target`、`dist`、exe/zip 一律不提交（`testpacks/*.zip` 测试夹具除外）。
- **禁止倒卖**：本项目 MIT 开源、永久免费。任何形式打包收费、去除署名后二次分发均违反许可证与作者意愿。

## 许可

代码以 [MIT](LICENSE) 发布。“Cyberpunk 2077” 是 CD Projekt Red 的商标，本项目与其无隶属关系。
