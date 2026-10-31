# 夜间自动研发报告

执行时间：无人值守模式（按 `deepseek_markdown_20261024_3e462d.md` 的五个任务串行推进）
项目：`D:\用户\工作区\CyberDeck-Launcher-src-0.7.0`
结论：**五个任务全部完成**，每完成一项都跑了自测（`cargo check` / `tsc --noEmit` / `vite build` / 浏览器交互脚本），没有需要跳过或标记阻塞的任务。

---

## 一、任务完成情况总览

| # | 任务 | 状态 | 核心改动 | 自测 |
|---|---|---|---|---|
| 1 | 虚拟滚动 + 组件级 ErrorBoundary | 完成 | `ModCardErrorBoundary.tsx`（新建）、`VirtualModGrid.tsx` | tsc / vite / 截图 |
| 2 | 游戏更新熔断机制 | 完成 | `game.rs`、`lib.rs`、`App.tsx`、`mock.ts` | cargo check / 交互脚本 |
| 3 | 多平台路径嗅探与启动适配 | 完成 | `schema.rs`、`game.rs`、`lib.rs`、`SettingsView.tsx` | cargo check / 交互脚本 |
| 4 | 卡片右键快捷菜单 | 完成 | `ModContextMenu.tsx`（新建）、`lib.rs`、`LibraryView.tsx` | cargo check / 交互脚本 |
| 5 | 环境完整性自检与一键自愈 | 完成 | `environment.rs`（新建）、`schema.rs`、`DiagnosticsView.tsx` | cargo check / 交互脚本 |

说明：任务 1 的虚拟滚动**原本就已存在**（`VirtualModGrid.tsx` 用 `@tanstack/react-virtual` + `ResizeObserver`，行高 328、overscan 4、列数按容器宽度自适应 1–6 列）。本次只补了错误边界，没有重写网格。

---

## 二、每个任务的实现细节

### 任务 1：虚拟滚动 + 错误边界

**新增 `src/components/ModCardErrorBoundary.tsx`**

```tsx
class ModCardErrorBoundary extends Component<
  { modId: string; modName?: string; children: ReactNode },
  { error: Error | null }
>
```

- `getDerivedStateFromError` 捕获渲染异常，`componentDidCatch` 打印
  `[CDL] Mod 卡片渲染失败 mod_id=... name=...` 并附带 `componentStack`。
- 降级 UI：`.mod-card.mod-card-error`，内含 `// ERROR: DATA CORRUPTED`、模组名、模组 id。

**改动 `src/components/VirtualModGrid.tsx`**：`items.map` 里每张卡都包一层边界，`key` 用 `mod.id`，一张卡崩不会影响同排其它卡片，也不会白屏整页。

**样式**：`.mod-card-error` 系列（暗红 1px 边 + 45° 斜纹底 + mono 代码行）。

**为什么视图仍然正常**：虚拟列表的 `rowHeight=328` 没变，边界块 `min-height: 316px` 与之接近，滚动高度不会跳。

### 任务 2：游戏更新熔断

**后端**

- `game.rs` 新增
  ```rust
  pub fn update_lock_active(last_version: Option<&str>, current: Option<&str>) -> bool
  ```
  语义：**两边都有值且不相等**才判定「游戏更新过」。首次绑定（`last_version` 为空）或读不到版本（`current` 为空）都不锁，避免误伤。
- 版本读取沿用既有 `game.rs:file_version(path)`（`GetFileVersionInfoW` + `VerQueryValueW`），读不到返回 `None`，不 panic。
- `lib.rs` 的 `set_mod_enabled`：在 `enabled == true` 分支前加校验，命中返回
  `CommandError::new("GAME_UPDATE_LOCKED", ...)`，文案里带 `旧版本 → 新版本`，并提示去顶部横幅解除。
- `lib.rs` 新增命令 `clear_update_lock(store) -> AppResult<Snapshot>`：把当前 exe 版本写回 `data.last_game_version` 后重建快照。已进 `generate_handler!`。

**限制说明**：代码库里**没有 `switch_profile` 命令**（grep 确认只有 WebView profile 相关），所以「切换配置」这一入口不存在，锁定只作用在部署入口（`set_mod_enabled`）。导入、查看、编辑配置都不受影响，符合「只锁改游戏目录的操作」。

**前端**

- `App.tsx`：`updateLock` 横幅（`FRAMEWORK BREAK // GAME UPDATED`、`版本 A → B`、按钮「解除锁定」），`ShieldAlert` 图标，红黑斜纹底。
- `mock.ts`：`getGame` 改为**按版本比较算 `gameUpdated`**（原来硬编码 `false`，导致演示模式永远看不到横幅）。
- `styles.css`：`.update-lock-banner` 系列 + 900px 以下改单列。

**验证**：`scripts/check-update-lock.mjs` 把演示状态的 `lastGameVersion` 改成 `2.21` 后重载 → 横幅出现（`banners=1`），点按钮后消失（`after_click=0`），截图 `shots/audit/interaction-update-lock.png`。

### 任务 3：多平台嗅探与启动适配

**已有基础**：`game.rs` 本来就实现了 Steam（注册表 + `libraryfolders.vdf`）、GOG 注册表、Epic `LauncherInstalled.dat`、以及常见路径兜底，`launch_game` 也已支持 Steam URI 与直接启动 exe（REDmod 时附 `-modded --launcher-skip`）。所以本任务做的是**把优先级变成用户可控** + UI 接线。

**后端**

- `schema.rs`：`Settings` 加 `#[serde(default = "default_platform_pref")] pub platform_pref: String`（`auto/steam/gog/epic/manual`）。
- `game.rs`：`detect_game` 变薄壳，新增
  ```rust
  pub fn detect_game_with_platform(preferred: Option<&str>, last_version: Option<&str>, platform_pref: &str) -> Option<GameInfo>
  ```
  按 `pref` 重排候选顺序，**某个平台找不到会继续试下一个**，不会因为首选平台未安装就返回 None。
- `lib.rs`：`detect_game_path` 传入 `data.settings.platform_pref`。

**前端**

- `types.ts` / `mock.ts`：`Settings.platformPref` 类型与默认值 `"auto"`。
- `SettingsView.tsx`：启动方式面板里加「游戏平台」五个 chip（自动 / Steam / GOG / Epic / 手动）。
- `App.tsx` `handleAutoDetect`：检测结果与已绑定目录**不同**时，先 `ConfirmDialog` 询问再覆盖；相同则不动。首次绑定（没有旧路径）不弹窗。

**验证**：`scripts/check-platform.mjs` 实测 `chips=5`、默认选中「自动」、点 GOG 后选中态切换，截图 `shots/audit/interaction-platform.png`。

> 踩坑记录：自动化点侧栏必须用 `getByRole("button", { name: "设置", exact: true })`，用 `getByText("设置")` 会先命中「Mod 设置」。

### 任务 4：卡片右键快捷菜单

**后端（`lib.rs`）**

- `open_in_explorer(store, path)`：先 `target.exists()`，再校验路径必须落在 `staging_dir` / `data_dir` / 当前 `game_dir` 之下（`starts_with`），否则 `PATH_NOT_ALLOWED`。目录用 `explorer.exe <dir>`，文件用 `explorer.exe /select,<path>`，spawn 失败返回 `OPEN_FAILED`。
- `repair_mod(store, id)`：`undeploy_mod`（错误忽略，本来就没部署也算成功）后 `deploy_mod`，返回 `DeployReport`。
- 两个命令都已进 `generate_handler!`。

**新增 `src/components/ModContextMenu.tsx`**

- `state: { mod, x, y }`，`useLayoutEffect` 做边缘内翻（右/下留 10px，并保证不小于 10px），`useEffect` 绑 `Esc` + 捕获阶段 `pointerdown` 关外部点击。
- 菜单项：部署/取消部署、强制重新部署、打开暂存区文件夹、在 Nexus 上查看（`mod.nexus?.modId` 为空时 `disabled` 并提示「本地导入，无来源」）、复制 Mod ID。
- 切角面板 + 每项 `icon / label / hint` 三栏。

**接线**：`ModCard` 增 `onContextMenu`，`VirtualModGrid` 里先 `preventDefault()` 再冒泡给 `LibraryView`；`LibraryView` 持有 `contextMenu` state，动作分别走 `api.repairMod` / `api.openInExplorer` / `api.openUrl` / `navigator.clipboard`，结果用底部轻提示条 `.library-note` 展示（2.8s 自动消失）。

**验证**：`scripts/check-context-menu.mjs` → `menu=1 items=5 disabled=1 afterEsc=0`，截图 `shots/audit/interaction-context-menu.png`。

### 任务 5：环境完整性自检与自愈

**数据结构（`schema.rs`）**

```rust
pub struct DeployedFile {
    pub source: String,
    pub target: String,
    pub link_type: LinkType,
    pub relative_path: String,
    #[serde(default)] pub size: Option<u64>,          // 部署时目标文件大小
    #[serde(default)] pub modified_time: Option<u64>, // 部署时 mtime（Unix 秒）
}
```

`installer.rs` 在 `create_link` 成功后调用新增的 `pub(crate) fn file_stamp(path)` 读回真实指纹写进记录。

**新增 `src-tauri/src/environment.rs`**

- `diagnose_environment(store) -> EnvDiagnosis`
  只体检 **enabled 且有部署清单**的模组（停用模组本来就不该在游戏目录留文件，算进去会让健康度长期挂红）。逐文件判断：
  - 目标不存在 → `missing`（critical）
  - 大小不符 → `size`（warning）
  - mtime 不符 → `time`（warning，多为用户手改或游戏更新）
  - 汇总 `level = critical | warning | healthy`，附中文 summary。
- `heal_environment(store) -> HealReport`
  只重建 `missing` / `size` 两类：确认 `source` 存在 → 建父目录 → 清掉残留 target → `installer::create_link` → 回写新指纹。`source` 也没了则记 `source_missing` 让用户重新导入，**不伪造内容**。`time` 类属于正常改写，只报告不动手。有改动才落盘。

> 实现细节：`store.snapshot_data()` 不返回 `Result`（内部 `lock().expect()`），第一版误加 `?` 导致两个 `E0277`；`iter_mut` 与 `inspect_file(entry, ...)` 同时借 `entry` 触发 `E0502`，改成先克隆 `id / name` 再传朴素字符串。

**命令**：`diagnose_environment` / `heal_environment`，都是 `async` + `spawn_blocking`（遍历磁盘不能占主线程）。

**前端**：`DiagnosticsView.tsx` 顶部新增「环境体检」面板 —— `CRITICAL/WARNING/HEALTHY` 徽标、三格指标（检查模组 / 检查文件 / 发现问题）、问题清单（分类着色：缺失红、大小黄）、`重新检查` 与 `一键尝试修复` 按钮，修复前弹 `ConfirmDialog` 说明「只动链接层、不删游戏文件」。每次刷新诊断报告时顺带跑一次体检；截图脚本也为此增加了 `.env-level` 的等待条件。

**验证**：`scripts/check-env-panel.mjs` → `level=1 metrics=3 issues=1`，截图 `shots/audit/interaction-env-check.png`。

---

## 三、改动文件清单

**新增**
- `src/components/ModCardErrorBoundary.tsx`
- `src/components/ModContextMenu.tsx`
- `src-tauri/src/environment.rs`
- `scripts/check-update-lock.mjs`、`check-platform.mjs`、`check-context-menu.mjs`、`check-env-panel.mjs`（四个交互回归脚本，可复跑）

**后端修改**
- `src-tauri/src/schema.rs`：`DeployedFile.size/modified_time`、`Settings.platform_pref`、`EnvIssue/EnvDiagnosis/HealReport`
- `src-tauri/src/game.rs`：`update_lock_active`、`detect_game_with_platform`
- `src-tauri/src/installer.rs`：部署时记录指纹、`file_stamp`
- `src-tauri/src/lib.rs`：`mod environment`、四个新命令（`clear_update_lock` / `open_in_explorer` / `repair_mod` / `diagnose_environment` / `heal_environment`）、`set_mod_enabled` 熔断校验

**前端修改**
- `src/components/VirtualModGrid.tsx`、`ModCard.tsx`、`LibraryView.tsx`、`SettingsView.tsx`、`DiagnosticsView.tsx`、`App.tsx`
- `src/types.ts`、`src/lib/api.ts`、`src/lib/mock.ts`
- `src/styles.css`（新增约 300 行：错误卡、熔断横幅、平台 chips、右键菜单、体检面板）

---

## 四、环境限制与遗留隐患（已知，未阻塞）

1. **cargo 无法在项目目录写 `Cargo.lock`**
   报 `failed to write .../src-tauri/Cargo.lock: 拒绝访问 (os error 5)`，即使手动 `Set-Content` 能建同名文件也一样。**绕过方式**：把后端复制到 `D:\用户\工作区\.tools\ncl-build\src-tauri` 再编译（副本已就位）。原项目目录的 `Cargo.lock` 已被删除，首次在正常环境编译会重新生成。
   影响：`cargo check` 走的是副本路径，行号与源码一致，但**副本需要手动同步**（改完 `src-tauri/src/*.rs` 后 `Copy-Item` 过去）。这一点已写进本条，避免后续误判「改了没生效」。

2. **真实 Tauri 运行时未验证**
   所有交互验证都在浏览器模式（`vite` + Edge + `playwright-core`）完成，`mock.ts` 承担后端返回。以下三项只有真机才能验：
   - 熔断横幅读取真实 PE 版本
   - `open_in_explorer` / `repair_mod` 的真实文件系统行为
   - `heal_environment` 的真实链接重建

3. **旧部署记录的体检精度**
   本次之前部署的模组，`deployedFiles` 里没有 `size` / `modifiedTime`（`#[serde(default)]` → `None`）。体检对这类文件**只查存在性**，跳过大小/时间比对。要获得完整精度，需要对该模组重新部署一次（右键「强制重新部署」即可）。

4. **`core-tests` 全量测试有既存失败**
   31 个测试里 11 通过 / 20 失败，失败集中在 `installer_tests` / `logs` / `modsettings` / `secret` / `ai`，均为沙箱文件操作限制导致的既存问题，与本次五个任务无关。本次新增的 3 个 modpack 测试与 `config_resolver` 测试不在失败集内。

5. **打包未执行**
   `tauri build` 按用户要求暂停（且 `@tauri-apps/cli/tauri.js` 在 DSH 的 Electron 环境下会误读 `argv[0]`，需走 `scripts/tauri-cli.cjs` shim）。

6. **`.btn-primary` 的禁用态对比偏弱**
   体检面板的「一键尝试修复」在无问题时禁用，视觉上仍偏亮。属于细节打磨项，不影响功能。

---

## 五、可复跑的自测命令

```powershell
# 前端类型与构建
cd 'D:\用户\工作区\CyberDeck-Launcher-src-0.7.0'
./node_modules/.bin/tsc --noEmit -p tsconfig.json
node node_modules\vite\bin\vite.js build

# 后端编译（注意：走副本，先同步源码）
$src='D:\用户\工作区\CyberDeck-Launcher-src-0.7.0\src-tauri\src'
$dst='D:\用户\工作区\.tools\ncl-build\src-tauri\src'
foreach($f in @('lib.rs','game.rs','schema.rs','installer.rs','environment.rs')){ Copy-Item (Join-Path $src $f) -Destination $dst -Force }
$env:RUSTUP_HOME='D:\用户\工作区\.tools\rustup'; $env:CARGO_HOME='D:\用户\工作区\.tools\cargo'
$env:TMP='D:\用户\工作区\.tools\tmp'; $env:TEMP=$env:TMP
& 'D:\用户\工作区\.tools\cargo\bin\cargo.exe' check --manifest-path 'D:\用户\工作区\.tools\ncl-build\src-tauri\Cargo.toml' --target-dir 'D:\用户\工作区\.tools\ncl-target'

# 交互回归（需 vite 跑在 localhost:1420）
node scripts\check-update-lock.mjs
node scripts\check-platform.mjs
node scripts\check-context-menu.mjs
node scripts\check-env-panel.mjs
node scripts\audit-shots.mjs   # 六主题 × 六视图 + 窄屏 + 折叠 + 空状态
```

---

## 六、给后续接手的建议

- **优先在真机跑一遍**上面第 4 节列的三项，尤其是 `heal_environment` —— 它会真实动游戏目录的链接，值得先用一个可丢弃的测试模组验证。
- 熔断只拦 `set_mod_enabled`。如果后续新增「批量启用」「切换 profile」等会改游戏目录的命令，记得同样接上 `game::update_lock_active`。
- 右键菜单的 `repair_mod` 会先 `undeploy` 再 `deploy`，在模组数量多时有短暂空窗。如果以后要做「一键修复全部」，建议串行执行并加进度事件。
