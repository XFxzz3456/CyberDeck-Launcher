# WorkBuddy「项目」配置草稿 — NightCity Loader

> 用法：WorkBuddy 侧边栏 → 更多 → 项目 → 新建项目，把下面各栏内容粘贴进去。

## 项目名称

```
NightCity Loader
```

## 指令（直接粘贴）

```
【项目】NightCity Loader —— Cyberpunk 2077 模组启动器（v0.7.0 开发中）。
【代码】D:\用户\工作区\NightCity-Loader-src-0.7.0，技术栈 Tauri 2 + React 19 + TypeScript + Rust。
【架构原则】React 只画状态，Rust 只做文件操作，Tauri 只做 IPC。
【安全红线（不可违反）】
1. 卸载只信任 deployed_files 清单，绝不推测；
2. 路径拼接必须过 safe_join + is_within 校验；
3. 硬链接身份比对必须用 GetFileInformationByHandle；
4. Mutex 内不做 IO（无锁 IO → 短锁登记 → 锁外 emit）。
【构建/测试】
- 前端类型检查：node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
- 前端构建：node node_modules/vite/bin/vite.js build
- Rust 测试：cargo test（先设 NO_PROXY=127.0.0.1,localhost，否则 mock 服务器被代理拦）
- 发布构建：tauri build --no-bundle，CARGO_PROFILE_RELEASE_LTO=false
- 产物部署目录：D:\用户\工作区\NightCity-Loader-0.7.0-release（替换 exe 前必须先确认用户已关闭程序）
【环境注意】系统工具链 C:\Users\mc236\.cargo 可用；不要碰 D:\用户\工作区\.tools（ACL 已损坏）。
【工作约定】
1. 每次功能更新/重大修改后，同步更新资料库「NightCity Loader 项目文档」文件夹中的对应文档；
2. 模糊需求先用选择题向用户确认，不要猜；
3. 宁选快速、不过度工程；大功能走 PM→架构→工程师→QA 团队 SOP，小改动直接做；
4. 改 Rust 前先读 docs/ARCHITECTURE.md 与 HANDOFF.md。
```

## 连接器

暂不需要（本地桌面开发，文件操作为内置能力；如后续要查 Nexus API 限流等在线服务再加）。

## 专家

- **软件团队**（software-company）：PM / 架构师 / 工程师 / QA 四角色 SOP，与本项目工作方式一致。✅ 推荐必选

## 技能

| 技能 | 用途 | 建议 |
|---|---|---|
| `library` | 资料库文档同步（每次更新后重传项目文档） | ✅ 必选 |
| `web-access` | 查 Nexus Mods API 文档、外部资料 | ✅ 建议 |
| `local-image-ocr` | 你发 UI 截图报 bug 时提取图中文字 | 可选 |
| `xlsx` / `workbuddy-docx` / `workbuddy-pptx` | 生成报表类文档 | 不选（与开发无关） |
| `cloud-service` | 托管后端 | 不选（本地应用） |
