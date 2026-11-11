# 整合包导出 / 导入 — 设计决策与复盘（2026-11-11，1.8.0）

> 来源：用户「再加一个一键导出整合包的功能吧，一个是完整 mod 本体+配置的，还有一个是给一个列表，对方只用下几 MB 甚至几 KB，把那个整合包拖到我们启动器后就会自动拉取 N 网进行下载（类似于 N 网自己的整合包模式？）」。
> 追加追问：「不会吧？是不是啥遗留啊，我 mod 全是在 N 网下的啊」。

## 一、格式选择：为什么不做 Nexus Collections 的导出

调研后的硬约束：**我们只能读 `.collection`，不能产出「N 网官网一键添加」的包**。
Nexus Collections 的发布需要经 Vortex 上传到 Nexus 站点、由站点侧审核分配 revision，
这是站点能力，客户端没有对应 API。所以导出自有格式，但保留「别人的 `.collection`
拖进来照样能装」（既有 `collection.rs` 不受影响）。

| | 轻量 `.cdlist` | 完整 `.cdpack` |
| --- | --- | --- |
| 体积 | 几十 KB（纯 JSON） | 等于暂存区，实测 3.5 GB |
| 内容 | modId / fileId / 加载顺序 / 配置值 / 启用状态 | 清单 + 每个 Mod 一个内嵌 zip |
| 本体来源 | 对方从 Nexus 自己下 | 包内自带 |
| 适用 | 网络好、都是 N 网 Mod | 有本地/绝版 Mod，或要离线还原 |

**完整包里「每个 Mod 单独一个 zip」是核心决策**，不是偷懒：
导入端可以逐个复用 `installer::install_archive`（剥壳、布局识别、info.json、
分类推断、封面、警告全都在那条路径上），不新写一套「从文件夹注册」逻辑；
同时拿到进度可见、坏一个不影响其余、支持只装其中几个这三个性质。
代价是外层 zip 不能整体压缩——内层已经压过，`.archive` 本身也是压缩容器，
再 deflate 只烧 CPU，所以两层都用 `Stored`。

## 二、Nexus 编号回填：用户那句「我 mod 全在 N 网下的」是对的

真实库 251 条里有 **68 条没有 `nexus` 字段**，全部 `origin == "adopted"`、
`metadata_source == "adopted"`、`source_zip == null`。也就是说这 68 条不是
「非 N 网来源」，而是**收编时只拿到了磁盘上的文件名和路径**——收编管线刻意
不联网，`nexus::enrich_metadata` 又只从文件名里抠数字（`Mod-1234-1-2-...`），
遇到 `Goneaway` / `Panamprivacy` 这种纯名字就永远补不上。

这直接决定轻量包能不能用：没有 modId/fileId 的条目无法让对方下载。
所以回填不是「顺手优化」，而是功能前提：

1. **Vortex LevelDB 优先**（零网络、最准）。`%APPDATA%/Vortex/state.v2` 里
   存着 Vortex 自己下过的 `name / modId / fileId`，复用 `vortex::load_records`。
2. **Nexus v2 GraphQL 名字检索兜底**。v1 REST 没有全文搜索端点，v2 GraphQL
   有独立限流池、不吃 v1 配额；filter 形状是
   `{"gameDomainName":[{"value":"cyberpunk2077","op":"EQUALS"}],"name":[{"value":term,"op":"WILDCARD"}]}`。
3. **只接受完全同名或唯一强包含**（长度比 ≥ 0.55，且名字至少 6 字符），
   模糊命中一律留空。写错 modId 的代价比留空大得多：检查更新、切版本、
   二次导出全会照着错的编号跑。
4. `propose` 只读、`apply` 才写库；已有编号的条目一律不覆盖（玩家手改优先）。

## 三、下载链路：合规边界不能绕

Nexus 只给 **Premium** 签发 API 直链 (`download_link.json`)。免费账号硬排队列
只会让每个任务 403，所以：

- **Premium**：一键把缺失项压进既有 `download_queue`（断点续传 / 限速 / 失败重试
  全复用），下完自动导入。
- **免费号**：不显示「全部下载」，改为「逐个打开页面」引导队列——页面上点一次
  下载，nxm 链接被启动器接管，自动入队、自动导入。和 Vortex 装 Collections 的
  免费体验一致。
- 只知道 modId 不知道 fileId 的条目不猜版本，直接列进「需手动挑文件」。

## 四、会话为什么不需要额外落盘

导入端的「已装 / 缺失 / 版本不符」由 `pack::preview` 每次从**实时库**现算，
所以关掉软件再打开、重新预览一次就是最新进度。中途状态天然可断点续传，
不需要维护一份会过期的会话文件。这是刻意去掉的复杂度。

配置只带**值**不带文件：`config_resolver::mod_config` 采可写来源的
`sourceId/section/key/value`，导入时用 `save_field` 逐字段写回（只 patch 目标
key、写前 `.bak`）。只读来源（Native Interactions 的交互点定义）不导出。
密钥、AI 地址、外部工具路径一律不在包里。

## 五、复盘（本轮踩的坑）

### 坑 1：工具栏加一个按钮，门禁「模组库工具栏」挂了

- **现象**：`check-toolbar.mjs` 在 `补全` 下拉上等 30 秒超时，报 `element is not visible`。
- **真因**：工具栏有容器查询密度档（955 full / 859 compact / 707 tight / 607 mini），
  `is-low-frequency` 组在低档位整体 `display:none`。新增的宽屏「整合包」按钮
  把容器挤过阈值，`补全` 菜单被隐藏。**不是并发时序问题**。
- **走过的错误假设**：第一反应是门禁并发导致加载慢，白跑了一次全量门禁。
- **代价 / 新约束**：两次 3 分钟门禁。以后**模组库工具栏加任何按钮，先跑
  `node scripts/check-toolbar.mjs`**；低频入口一律放进既有下拉或「更多」，
  不新增常驻按钮。
- **下次第一步**：`node scripts/check-toolbar.mjs`，别先猜时序。

### 坑 2：UI 检查写死 1440 宽度下的「更多」入口

- **现象**：`check-modpack.mjs` 单跑通过，进门禁失败；同一个按钮在 1440 下
  `display:none`，在 1280 下才出现。
- **真因**：与坑 1 同源——密度档随容器宽度切换。单跑那次恰好是「加了宽屏按钮」
  的构建，密度掉到 compact，「更多」可见；移除按钮后又回到 full。
- **代价 / 新约束**：一次全量门禁。检查脚本**不能把响应式入口绑死在某一个宽度**，
  必须按可见性选路（宽屏走「导入方式」下拉，窄屏走「更多」）。
- **下次第一步**：先用探针列出各宽度下候选入口的 `isVisible()`，再写断言。

### 坑 3：`install_archive` 返回条目但不写库

- **现象**：`full_pack_installs_missing_bodies` 里 `installed == 1` 却
  `state.mods.len() == 0`。
- **真因**：`install_zip` → `install_archive` 只负责落盘并返回 `ModEntry`，
  **登记进 state 是 `install_mods_blocking` 的职责**。绕过它就得自己 push + save。
- **走过的错误假设**：以为 `install_zip` 和前端 `install_mods` 一样会写状态。
- **代价 / 新约束**：一次测试红。任何绕过 `install_mods` 直接调 `install_archive`
  的模块，必须自己 `data.mods.push(entry)` + `store.save`，并带上清单里的
  `NexusRef`（否则装完的条目仍不认得自己从哪来）。
- **下次第一步**：看调用链上游 `install_mods_blocking`，别只看函数返回值。

### 坑 4：`nexus.rs` 整文件 diff（老坑复发）

- **现象**：只为开放两个内部函数，`git diff --stat` 显示 2778 行变更。
- **真因**：Python `open(..., "w", newline="\n")` 把 CRLF 文件刷成 LF。
- **代价 / 新约束**：二进制回写 `replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")`
  修好后 diff 降到 13 行。**改 `.rs` / `.tsx` 前先查行尾**，这条已经写进
  项目记忆，仍然要执行而不是记住就算。
- **下次第一步**：`python -c "d=open(p,'rb').read(); print(d.count(b'\r\n'), d.count(b'\n'))"`。

## 六、验证

- `cargo test --lib`：**382 passed / 0 failed / 2 ignored**（新增 `pack_tests.rs` 7 例）。
- `npm run gate`：**39/39 全绿**（新增 `check-modpack.mjs` 9 条断言）。
- 真实库口径：251 条 / 183 条带编号（73%）/ 暂存区 3.5 GB / 68 条待回填。
