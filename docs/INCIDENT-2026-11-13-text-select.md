# 复盘：文本选择「屏蔽过头」与 1.8.3 发版收尾（2026-11-13）

## 现象

先前用户反馈「误触 Ctrl+A 会把软件内文字整片框蓝」，当时加了全局 `user-select: none` + 白名单。
本轮追加反馈「好像屏蔽过头了，有些应该被复制到的也不能框选了」。

浏览器实测（观测值，不是「用户说好了」）：模组库 **95/95** 个文本节点 computed `user-select: none`，设置页 **197/236**；正文、路径、报错详情、模组名、表格数值全都复制不了。

## 真因

1. 把「防误触全选」这个**事件层问题**实现成了**全局样式层禁令**：`none` 挂在根容器上，白名单只列 `input / textarea / pre / code / .toast-copy / .selectable-text`，按「元素类型」而不是「内容 vs UI chrome」划分；页面大量内容在 `div / span` 里，必然被漏。
2. `user-select` **可继承**：给父容器放行 `auto` 后，按钮、导航、装饰 eyebrow 会跟着变可选。第一版「父容器放行」实测就把按钮字也放开了。
3. CSS 管不住 `Ctrl/Cmd+A`：节点全 none 时浏览器仍可能给出整页选区，必须在事件层拦。

## 走过的错误假设

- 以为「白名单再加几个标签」就能收敛 → 实测发现内容散落在 `div/span` 里，按标签枚举永远漏；改成按语义放行 `p / li / dd / dt / td / th / small`、代码日志、报错诊断、路径·名称·版本·数值、`[title]`、`[data-copyable]` 等**内容叶子**。
- 以为「父容器设 auto、按钮保持自己的 none」→ 实测按钮继承 auto 可选；必须**显式**再钉一条 chrome `user-select: none`。
- 以为只靠 CSS 能防全选 → 空白区 Ctrl+A 仍有选区；最终在 `App.tsx` 加 capture 阶段全局守卫，焦点在 `input / textarea / contenteditable` 时才放行。
- 差点把修后数据读反：「模组库 94 个节点只有 28 个可选」看着像漏改，逐类核对后确认其余 66 个全是按钮 / 标签 / 导航，属刻意 none。

## 代价 / 新约束

- 新增一个常驻 capture 阶段 `keydown` 监听；输入框白名单必须与未来新增编辑控件同步维护。
- CSS 白名单从「4 类元素」扩为「按内容语义枚举」，新增内容容器要主动补规则，否则又会静默不可选。
- 按钮 / 标签 / 导航 / eyebrow **刻意保持不可选**；只承诺内容区可拖选复制，不承诺 UI chrome。
- 版本口径统一回 1.8.3（短时打出的 `v1.8.4` tag 已删），release exe 按 1.8.3 重构建替换；**便携 ZIP 与 GitHub Release 未动**，对外分发需单独确认。

## 诊断手法（可复用）

Playwright 遍历文本节点读 `getComputedStyle(el).userSelect` 并按「内容 / chrome」分类计数；再做真实鼠标拖选取 `window.getSelection().toString()`；空白区与输入框分别测 Ctrl+A 的选区长度；按钮单独断言 computed 为 `none`。任何全局 CSS 改动前后都应跑这组基线。

## 下次第一步查什么

1. 遇到「误触」先分清是**事件**还是**样式**问题：全选 / 快捷键走事件守卫，别用全局样式兜底。
2. 改全局 `user-select` 前先跑文本节点可选率基线并**分类计数**，别拿「看着能选」当结论。
3. 父容器放行后立刻复查 chrome 的继承值；白名单按内容语义写，不要按标签碰运气。

## 验证留痕

- 修后实测：模组库 94 个文本节点中 28 个可选、设置页 255 中 144 个可选（均属内容类）；真实拖选拿到「NCPD 是赛博配色，只提供深色」；空白区 Ctrl+A 选区长度 `0`；输入框 Ctrl+A 选区 `0..19`；按钮 computed `user-select: none`。
- 发版链路二次全量门禁 **39/39 全绿**（207s / 合计 390s 工时，链路总耗时 403s）；`cargo test --lib` 399 passed / 0 failed / 2 ignored；`tsc --noEmit` 0 错误。
- 产物 `release/CyberDeck Launcher.exe`：11,176,960 B（10.66 MB）/ md5 `5906af219d4052e3193bc2e06266ed11` / PE `FileVersion` · `ProductVersion` 均 1.8.3 / mtime 2026-11-13 23:13:59；旧 1.8.4 临时包备份 `.prev.exe`。
- 同批三份审查报告核销的复盘见 `AUDIT-2026-11-13-bug-quality-review.md` §8「复盘（得失）」。

## 遗留

- `cargo-audit` 本机未安装，依赖 RUSTSEC 比对仍未执行（审查报告 §5 已列）。
- 审查报告 §9 顺延项（P1-3 Archive 保子路径、P1-4 MultiType、P1-8 抽 `framework.rs` 等）已定性，本轮不擅自改动。
- 便携 ZIP 与 GitHub Release 最新仍为 `v1.8.2`；本轮按规则未重打、未上传。
