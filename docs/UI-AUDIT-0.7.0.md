# UI 审计与主题升级报告（0.7.0）

> **执行状态（2026-10-25）：本报告与《UI评估与功能差距报告》中的全部意见（A1–E3、#1–#7）已全部实现，**
> 明细见 `HANDOFF.md` 第 2 节「0.7.1 批量升级」。样式分层后 tokens 位于 `src/styles/tokens.css`。

> 审计对象：`CyberDeck-Launcher-src-0.7.0` 前端（React 19 + 纯手写 CSS，`src/styles.css` 约 9700 行）
> 方法：Playwright 驱动本机 Edge，对 6 套主题 × 6 个页面截图，逐张实看；所有结论都有对应截图与代码位置
> 截图目录：`shots/audit/`（运行期产物）、`docs/screenshots/`（文档用图）

---

## 一、审计发现的六个核心问题

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 1 | **卡片封面不跟随主题** | 五套主题下封面渐变完全相同（黄/紫/青/彩虹并存） | 视觉噪音压过主题色，「换主题」感知为零 |
| 2 | **基础层大量硬编码颜色** | `.sidebar` 464 行 `#090c10`、`.mod-card` 1620 行 `#0d1218` + `#202833`、`.topbar-search` 886 行 `#080b0f` 等 26 处 | 主题变量只覆盖到外层，内层仍是深色，亮色主题直接翻车 |
| 3 | **暗色偏暗、层次扁平** | 深色背景 `#070a0d` + 面板 `#0d1218`，对比不足 | 长时间阅读疲劳，界面像一层灰 |
| 4 | **所有强调都是同一个红** | ARASAKA 下面板描边、图标、按钮、状态点全用 `--accent` | 层级靠颜色不靠形状／字重，看起来「脏」 |
| 5 | **主题只换颜色** | 5 套主题共用同一套按钮圆角、标题装饰、导航标记 | 「五套主题」实际是一套配色 × 5 |
| 6 | **字号偏小** | 正文 8–9px 为主，`--muted` 在深底上对比不足 | 中文在 1440×900 下费眼 |

---

## 二、已实施的改造

### 1. 封面配色主题化

`:root` 新增 `--cover-a` / `--cover-b` / `--cover-c` / `--cover-ink`，每套主题各给一组：

| 主题 | cover-a | cover-b | cover-c |
|---|---|---|---|
| ARASAKA | `#ff2b47` | `#8a1020` | `#ff7a3d` |
| NCPD | `#fcee0a` | `#31e6ff` | `#ff3b5c` |
| NETRUNNER | `#31e6ff` | `#7a5cff` | `#31e6ff` |
| MILITECH | `#b6d94c` | `#5f7a2a` | `#d9c98a` |
| MONO | `#4a4a4a` | `#2a2a2a` | `#3a3a3a` |
| DAYLIGHT | `#b23a0e` | `#1c6b86` | `#a8894f` |

`CoverArt` 改为读取 CSS 变量，切主题时封面一起变。

### 2. 基础层变量化

用精确色值替换（每处替换后 grep 验证零残留）：

| 硬编码 | 替换为 | 次数 |
|---|---|---|
| `#080b0f` | `var(--bg-2)` | 13 |
| `#0a0e13` | `var(--bg)` | 5 |
| `#202833` | `var(--line)` | 2 |
| `#090c10` / `#070a0d` | `var(--bg-2)` / `var(--bg)` | 各 1 |
| `#151b22` | `var(--panel-3)` | 1 |
| `#0d1218` | `var(--panel-2)` | 1 |

同时把 UI 状态色收敛为语义变量：`--ok` / `--warn` / `--danger` / `--red` / `--green`，替换 `#ff8295`（9 处）、`#c9d2dd`、`#53606e` 等散落值。

### 3. 主题形态层（这是「不只是换色」的关键）

新增一组形态变量，每套主题给不同值：

| 主题 | `--btn-cut` | `--nav-mark-width` | `--panel-rule-width` | 标题装饰 |
|---|---|---|---|---|
| ARASAKA | 7px | 2px | 46px / 0.42 | — |
| NCPD | 0px（直角） | 3px | 通栏 0.2 | 标题后 38×3px 实心短杠 |
| NETRUNNER | 8px + 发光 | 3px + 外发光 | 72px / 0.55 | 96×2px 渐变下划线 |
| MILITECH | 3px（近直角） | 4px | 26px / 0.5 | 标题去发光 |
| MONO | 0px | 0（无标记） | 0（无装饰） | 标题强调色改纯白 |
| DAYLIGHT | 6px | 2px | 46px / 0.5 | — |

`.btn` 的 `clip-path` 改用 `var(--btn-cut)`，其余同理。

### 4. ARASAKA 降红

- `--line` `#3a1a22 → #2d151b`、`--line-soft` `#2a1017 → #1e0c11`、`--line-hot` `#5e2733 → #4a1f28`
- 新增 `--corner-opacity`（`:root` 为 1，ARASAKA 为 0.45），`.panel` 的 45° 角标透明度降到原来的 45%

### 5. 字号与可读性

一次正则替换（避免链式覆盖），约 280 处：

| 原 | 新 |
|---|---|
| 5.5 / 5.8px | 7px |
| 6 / 6.5 / 6.8 / 7 / 7.1px | 8px |
| 7.5px | 8.5px |
| 8 / 8.8px | 9px |
| 8.5px | 9.5px |
| 9 / 9.2px | 10px |
| 9.5px | 10.5px |

次级文字提亮（深色三主题）：

| 变量 | 原值 | 新值 |
|---|---|---|
| `--muted` | `#7e8997` | `#93a0af` |
| `--muted-2` | `#5d6877` | `#717e8d` |
| NETRUNNER `--muted` | `#708e9a` | `#8aa8b4` |
| NETRUNNER `--muted-2` | `#4b6572` | `#64808d` |
| ARASAKA `--muted` | `#9a737c` | `#b08b95` |
| ARASAKA `--muted-2` | `#6e4b54` | `#8a626c` |

字号变大后主题卡说明被截断 → `.theme-option` 加高到 `min-height: 78px`。

### 6. 主题卡从「两个色块」改成真实缩略图

`public/theme-thumbs/<id>.png`：从每套主题的模组库首屏截图裁出 `(248, 96, 1000, 590)` 区域，缩放到 176×104。主题卡左侧显示该主题的真实界面缩影，一眼能分辨。

### 7. 新增 DAYLIGHT 亮色主题

纸白底 + 深墨字，`--bg:#eeebe4`、`--panel:#f8f6f1`、`--accent:#b23a0e`，关闭扫描线与网格。亮色下需要单独覆盖的白色薄膜（`.theme-option`、`.framework-card`、`.cover-shade`）统一改成 `rgba(0,0,0,0.02)` 系。

### 8. 诊断页层级与键盘可达性

- 「检查结果」「前置框架」支持折叠（`aria-expanded` + `ChevronDown`，2 个面板独立）
- `.framework-card` 的字号重新分档：标题 10.5px / 描述 9px / 路径 7.5px
- 补 `.btn:focus-visible` / `.nav-item:focus-visible` 的 `outline: 2px solid var(--accent)`

---

## 三、六套主题的设计语言

| 主题 | 关键词 | 色彩 | 形态 |
|---|---|---|---|
| **NCPD** | 赛博警用档案 | 黄 `#fcee0a` + 冷青 | 直角按钮、通栏面板顶线、标题短杠、封面黄青红 |
| **NETRUNNER** | 深空冰蓝 / 终端 | 青 `#31e6ff` + 紫 | 大圆角切角、外发光、标题渐变下划线、导航发光 |
| **ARASAKA** | 高级、低明度、高危险 | 暗红 `#ff4058` | 中切角、细描边、低透明度角标 |
| **MILITECH** | 军用科技 / 实体感 | 橄榄绿 `#b6d94c` | 近直角、短装饰线、去发光 |
| **MONO** | 纯粹极简 / 文档纸 | 纯黑白灰 | 零圆角、无标记、无装饰、无扫描线 |
| **DAYLIGHT** | 白昼纸面 / 投屏 | 纸白 + 橙 `#b23a0e` | 中切角、柔描边、无扫描线 |

---

## 四、可复跑的验收

```powershell
pnpm dev                                    # 另开一个终端
node scripts/audit-shots.mjs                # 6 主题 × 6 页面，输出 shots/audit/
node scripts/check-collapse.mjs             # 诊断页折叠
node scripts/check-env-panel.mjs            # 环境体检面板
node scripts/check-context-menu.mjs         # 右键菜单
node scripts/check-profiles.mjs             # 播放集切换
node scripts/check-update-lock.mjs          # 游戏更新熔断
node scripts/check-platform.mjs             # 平台选择器
```

`audit-shots.mjs` 会在控制台打印 `no page errors` 作为断言；任何一页有 console error 都算失败。

---

## 五、遗留与已知不足

1. **亮色下部分语义色对比仍偏弱**：诊断页的 warning 文案（`#a8620a`）在纸白底上约 4.4:1，接近但未达到 WCAG AA 的 4.5:1。如需更严格可再压深一档。
2. **Nexus 发现页在浏览器模式一直转圈**：这是缺 Tauri 后端的固有限制，不是 UI 缺陷；桌面端正常。若要在浏览器演示，需要给 mock 补一份 Nexus 列表。
3. **诊断页 AI 面板的加载时序**：`networkidle` 后立即截图会拍到「正在读取 AI 配置…」，属于 mock 延迟，不影响真实运行。
4. **主题缩略图是静态图片**：主题改了配色后需要重新跑裁图脚本，否则缩略图会滞后。裁图脚本尚未固化进 `scripts/`（当前是一次性 PowerShell 命令）。
5. **未做**：主题/皮肤 JSON 包导入导出、亮色模式的打印样式。

---

## 六、改动文件清单

| 文件 | 改动 |
|---|---|
| `src/styles.css` | 主题变量、形态层、字号、语义色、折叠面板、右键菜单、熔断横幅、播放集、体检面板、错误边界（约 9700 行） |
| `src/lib/preferences.ts` | 新增 `daylight` 主题定义 |
| `src/components/ModCard.tsx` | 封面变量化、双语名称、右键回调、Nexus 官方图 |
| `src/components/AppearanceSettings.tsx` | 主题卡缩略图 |
| `src/components/DiagnosticsView.tsx` | 折叠、体检面板、环境自检 |
| `src/components/VirtualModGrid.tsx` | 错误边界包裹、右键透传 |
| `src/components/ModContextMenu.tsx` | 新增 |
| `src/components/ModCardErrorBoundary.tsx` | 新增 |
| `src/components/SettingsView.tsx` | 平台选择、播放集管理、补封面 |
| `public/theme-thumbs/*.png` | 6 张主题缩略图 |
