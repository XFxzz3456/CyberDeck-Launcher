# 变更记录（2026-10-26）：品牌更名 + 主题解耦 + 设置页 Tabs + Nexus Collections

> 本轮由 4 个子 Agent 并行完成后由主 Agent 集成。涉及数据迁移，已在真实数据上验证。

## 0. 一句话

产品从「NightCity Loader」更名为 **CyberDeck Launcher（CDL）**，同时完成三件结构性工作：外观系统解耦（风格 × 明暗）、设置页信息架构重排（顶部 Tabs）、整合包体系从"本地大 ZIP 猜测"换成"Nexus Collections 官方清单"。

---

## 1. 品牌更名与数据迁移

| 项目 | 旧 | 新 |
|---|---|---|
| 产品名 | NightCity Loader | **CyberDeck Launcher** |
| 简称 | NCL | **CDL** |
| npm 包名 | nightcity-loader | cyberdeck-launcher |
| Cargo 包 / lib | nightcity-loader / nightcity_loader_lib | cyberdeck-launcher / cyberdeck_launcher_lib |
| Tauri identifier | com.nightcity.loader | **com.arol.cyberdeck** |
| exe | NightCity Loader.exe | **CyberDeck Launcher.exe** |
| exe 同级数据目录 | nightcity-data | **cyberdeck-data** |
| %APPDATA% 目录 | com.nightcity.loader | **com.arol.cyberdeck** |
| 源码目录 | NightCity-Loader-src-0.7.0 | **CyberDeck-Launcher-src-0.7.0** |
| 发布目录 | NightCity-Loader-0.7.0-release | **CyberDeck-Launcher-0.7.0-release** |

**迁移做法**（一次性、幂等）：
1. 停启动器 → 改名发布目录 → 改名数据目录 → 改名 %APPDATA% 目录；
2. `launcher-state.json` 在 **JSON 结构层**逐字段改写旧路径（前缀替换），否则卸载/重部署会指向不存在的暂存目录；
3. 结果：**195 个模组、加载顺序、Nexus Key 全部保留**（`startup.log` 记录 `data_dir=…\cyberdeck-data`、`integrity=0x2000`）。

**有意保留未改**（兼容锚点，改名需配套迁移）：
- `origin: "nightcity"` 等**持久化数据格式值**；
- 临时文件前缀（`*.txt.nightcity-tmp`、`user.ini.nightcity.tmp`）；
- localStorage 键名 `ncl.ui.*`（决策 A3：避免主题与通知已读状态被重置）。

**踩坑**：pnpm 的 `node_modules` 用**绝对路径软链**，目录改名后全部悬空（`node` 报 Cannot find module）。处理：`rm -rf node_modules && pnpm install --offline` 重建。已写进项目记忆。

---

## 2. 主题系统解耦（styleTheme × colorMode）

- 新增 `src/lib/theme.ts` 的 `useTheme()`：返回 `styleTheme / colorMode / resolvedMode / modeCapable / setStyleTheme / setColorMode`；
- 写 DOM：`documentElement.dataset.style`、`.dataset.mode`（已把 system 折算成 light/dark）、`.dataset.modeCapable`；
- 风格：**ncpd / netrunner / arasaka / militech / mono / modern**；**daylight 已删除**（老用户自动迁移为 modern+light）；
- 明暗：仅 **mono / modern** 可切 `浅色 / 深色 / 跟随系统`；`system` 用 `matchMedia('(prefers-color-scheme: dark)')` 实时监听；赛博风格强制暗色；
- CSS 契约变量 `--radius / --clip-corner / --glow`：modern 下圆角 8px、`clip-path: none !important`、零发光；mono 新增浅色变体；
- 切换过渡：仅在切换瞬间挂 `data-theme-transition`（300ms）→ 避免常驻 transition 拖慢滚动；首屏防闪脚本同步支持新键。

---

## 3. 设置页 → 顶部水平 Tabs

六个 Tab：外观与主题 / 游戏与路径 / AI 配置 / 工具组件 / 安全与维护 / 关于。
内容区 `overflow-y: auto` 独立滚动，不影响全局侧边栏；切 Tab 时滚动条回顶；**用隐藏/显示而非卸载组件**，避免面板里未保存的输入丢失。赛博主题用发光下划线，modern 用扁平灰底高亮。

---

## 4. Nexus Collections（废弃本地大 ZIP 整合包）

**删除**：`modpack.rs` 的递归扫描子目录 / 自动剥多层嵌套 / 批量注册数百个 Mod 的整套逻辑、`import_modpack` 命令、前端「导入整合包」入口、`ModpackProgress`/`ImportedPack` 类型。
**保留**：单 ZIP 导入（`installer::install_archive`）完全不受影响。

**新增** `src-tauri/src/collection.rs`：
- 结构：`NexusCollectionManifest / CollectionInfo / CollectionMod / CollectionRule / CollectionPlan / CollectionPlanItem / CollectionDeployReport`；
- `parse_collection_manifest(path)`：解析清单 → 校验 `domain=cyberpunk2077` → 与本地比对（先 `nexus.mod_id`，再 `nexus.file_id`；**MD5 不参与匹配**，本地不存 MD5）→ 状态 `installed / version_mismatch / missing`；
- **modRules 拓扑排序**（before/after/requires）：排序结果写进 `CollectionPlanItem.order`，有环时回退原数组顺序并说明，不 panic；
- `apply_collection_order(ids)`：按清单顺序重写 `modlist.txt` 并部署，返回整批聚合结果。

**前端** `src/components/CollectionWizard.tsx`：集合安装向导——绿勾/红缺/版本不符、可选标记、每条「去 N 网获取」按钮、全部就绪后「按预设顺序部署」。
**合规边界**：Nexus 只向 Premium 签发直链，因此**不做自动下载器**，走「开网页下载 → 拖回导入 → 一键部署」的引导式流程。

---

## 5. 本轮附带修掉的问题

1. `ui-test.mjs`：出现第二个 file input（导入集合清单）后 strict mode 报错 → 改用 `.first()`；
2. `ui-theme-test.mjs`：主题数量断言 5 → 6（新增 modern）；
3. 发现页新增「网页搜索」按钮（官方 API v1 无搜索端点，把过滤词拼成 Nexus 搜索页链接交给浏览器）。

---

## 6. 仍需人工确认的事项

- 三个新界面（modern 主题、设置页 Tabs、集合向导）**尚未在真机点过**——构建与类型/单元测试均通过，但视觉与交互需要你醒来后过一遍；
- `origin` 等数据格式值、localStorage 键名仍是旧品牌（有意保留）；
- 工作区目录里的孤儿 SID 仍未清（需动 `.tools`，项目约定不碰）。

---

## 7. 收尾补充（06:30）

- **集合部署语义修正**：原先只把 `status === "installed"` 放进部署 ids，会漏掉「已装但版本不符」的条目——后端 `ready_to_deploy` 的判据是"没有 missing"，版本不符并不阻塞部署。排除它会导致重写 `modlist.txt` 时缺位置、集合顺序断裂。已改为**本地已有的条目（installed + version_mismatch）全部参与**，按 `item.order` 升序。
- **向导统计加第 4 格「版本不符」**（后端零改动，前端按 `items[].status` 自数）。
- **修掉一个既有 bug**：`src/lib/mock.ts` 的 `installMods` 造了 mod 却**从没 `db.state.mods.push(mod)`** → 演示模式下导入的模组不进库，保存分类报「找不到这个模组」，对话框不关、后续点击全被遮罩挡住。修后导入数 16→17、分类可存。
- 清理 `TaskKind` 里的死值 `"modpack"`（活动流只在内存里，删安全）；`ModOrigin` 的 `"modpack"` **保留**（属持久化数据格式值）。
- 最终状态：`tsc --noEmit` 0 错误、`cargo test --release` 46 项全绿、四套 UI 脚本（ui-test / ui-polish-test / ui-hardware-test / ui-theme-test）全绿、`startup.log` 显示 `data_dir=…\cyberdeck-data`、`integrity=0x2000`。

### 7.1 状态文件解析事故（静默清空用户数据）——根因与回归测试位置

`schema.rs` 里为"作废旧整合包记录"新增的自定义反序列化器**没有消费输入值**：

```rust
// 错误写法：serde 的解析位置会错位，整个状态文件被判损坏
fn deserialize_always_empty<'de, D>(_: D) -> ... { Ok(Vec::new()) }
```

→ serde 解析完 `"modpacks":` 后仍停在值开头 → 整个 `launcher-state.json` 解析失败 →
`store.rs` 判定损坏 → 重命名为 `broken-*.json` 并**用空状态继续启动** → 195 条模组索引清空
（游戏目录里的模组文件未丢，丢的是索引）。

**已修复**（`src-tauri/src/schema.rs:502`）：改用 `IgnoredAny::deserialize(deserializer)?` 消费输入后再返回空数组。

**三处回归测试（以后碰 `deserialize_with` 请先看这三条）**：
- `schema::modpacks_cleared_on_load::modpacks_field_is_ignored_but_still_consumed`（schema.rs:998）
  —— 断言**整个状态文件能解析**且 `modpacks` 为空；
- `collection::tests::legacy_modpacks_records_are_dropped_on_load`（collection.rs:963）
  —— 断言状态文件能解析、`gameDir`/`loadOrder` 等字段原样保留、**不产生 `broken-*.json`**；
- `collection::tests::empty_modpacks_array_also_parses`（collection.rs:1059）
  —— 专门守**空数组形态**（`"modpacks": []`，即启动器每次落盘写出的形态）：断言能解析、
  `gameDir`/`loadOrder` 原样保留。

> 教训：写"反序列化时丢弃字段"这类实现，**不能只断言"结果为空"**——"空结果"和"整个文件坏掉后
> 重置成空"在断言上无法区分；必须断言"整体没被破坏"。原测试只断言字段为空且 fixture 里
> `"mods": []`，所以是个假阳性。


> 🔴 **规则（务必写进代码规范）**：`deserialize_with` 的自定义反序列化器**必须消费掉输入值**
> （用 `IgnoredAny::deserialize(deserializer)?`）。否则 serde 解析位置错位 → 整个状态文件被判损坏 →
> `store.rs` 静默重置为空。
>
> **空数组形态（`"modpacks": []`）同样会触发**——而空数组恰恰是启动器**每次落盘都会写出的形态**。
> 也就是说，那个版本不是"升级时丢一次索引"，而是**每次启动都把用户的模组库清空一次**
> （实测：`[]` → 解析失败；`["x"]` → 解析失败；**没有该字段** → 解析成功）。
>
> 因此写这类实现时，**不能只断言"结果为空"**——"空结果"与"整个文件坏掉后重置成空"在断言上无法区分；
> 必须断言"**整个状态文件仍能正常解析**、其它字段原样保留、**不产生 `broken-*.json`**"。

> 📌 **排查提示（前端）**：真机上的"模组库空了 / 导入的模组不见了 / 分类存不上"，**可能不是 UI 逻辑问题**，
> 而是状态文件被当成损坏重置了。判断方法：看 `cyberdeck-data/` 下有没有多出 `broken-*.json`
> （`store.rs` 判定损坏时会把原文件改名留档）——有就是走了重置分支。
>
> 注意区分两条数据通道：真机走 `cyberdeck-data/launcher-state.json`（Rust 侧），
> 而**浏览器预览（`scripts/ui-test.mjs` 等四套 UI 脚本）走 localStorage 的 demo 态**
> （`cyberdeck-launcher-demo-state-v1`），**不碰真实状态文件**——所以那四套脚本全绿，
> 并不能证明真机的状态文件没问题，真机仍需单独验一次。
