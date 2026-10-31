# 代码审查报告：Bug 与质量全面检查

- **审查时间**：2026-10-30 22:00（GMT+8）
- **审查对象**：`D:\用户\CyberDeck-Launcher\src`（v0.9.0）
- **代码规模**：Rust 后端 24,092 行 / 34 文件；前端 23,435 行 / 99 文件
- **审查人**：CyberDeck Launcher 代码审查（自动化任务）
- **方法**：静态扫描（模式匹配 + 计数）→ 热点精读 → 编译器/类型检查实跑 → 关键缺陷最小复现验证

## 0. 执行结论（先看这一段）

| 项目 | 结果 |
|---|---|
| Rust `cargo check` | ✅ 通过，**0 warning**（4.36s 增量） |
| 前端 `tsc --noEmit` | ❌ **失败（3 个语法错误）→ 当前源码无法构建** |
| 生产代码 `unwrap()` | 仅 2 处（均为常量正则，理论安全） |
| TODO / FIXME / XXX | 0 处 |
| 依赖漏洞（前端生产依赖） | ✅ `pnpm audit --prod`：No known vulnerabilities |
| 依赖漏洞（Rust） | ⚠️ **未能审计**：本机未安装 `cargo-audit`，见 §6 |

**一句话**：安全与健壮性底子远超同类项目（解压防穿越、路径白名单、DPAPI 存密钥、CSP 收得很紧、panic 面几乎清空），但**当前 HEAD 是「编译不过」的状态**，且 `nxm://` 解析里有一个可被网页远程触发的 panic。

---

## 1. Critical（阻断级，必须立即修）

### C-1　`DiagnosticsView.tsx` 第 485 行多余 `</div>`，整文件语法错误，构建无法产出

- **位置**：`src/components/DiagnosticsView.tsx:485`
- **现象**：
  ```
  src/components/DiagnosticsView.tsx(195,5): error TS2657: JSX expressions must have one parent element.
  src/components/DiagnosticsView.tsx(725,5): error TS1005: ')' expected.
  src/components/DiagnosticsView.tsx(726,3): error TS1109: Expression expected.
  ```
- **真因**（已用 TS 解析器定位到 AST，不是靠肉眼看）：
  第 485 行的 `</div>`（8 空格缩进）**提前关闭了 `diagnostics-main`**，导致后续 `DEPENDENCIES` 面板（487–580）、`<aside>` 侧栏（583–696）逐级外溢成兄弟节点；`</div>`(697) 关掉了页面根 div，`<ConfirmDialog>`/`<LogViewerDialog>` 变成根级兄弟（触发 TS2657），最后 725 行的 `</div>` 成了孤儿（触发 TS1005）。
  解析器实测的错位嵌套：
  ```
  <div "diagnostics-grid">  L360..L581   ← 本该包住 main + aside
    <div "diagnostics-main"> L361..L485   ← 提前在 485 关闭
  <aside "diagnostics-side"> L583..L696   ← 被挤到页面根级
  ```
- **影响**：`package.json` 的 `build` = `tsc --noEmit && vite build`，因此 `pnpm build` / `tauri build` 全部失败。`dist/` 仍是 21:30 的旧产物，说明这处破坏是 22:01 之后引入的（文件 mtime 22:01，疑似正在编辑中）。
- **修复建议**：**删除第 485 行那个孤立的 `        </div>`**。保留 580 行 `</section>` 后的 `</div>`(581) 关闭 `diagnostics-main`、697 行关闭 `diagnostics-grid`、725 行关闭页面根 div。
- **已验证**：在临时副本上删除该行后，`parseDiagnostics = 0`；AST 复核嵌套恢复正确：
  ```
  <div "diagnostics-grid"> L360..L696
    <div "diagnostics-main"> L361..L580   ← 含 issues / frameworks / DEPENDENCIES
  ```
  本次审查**未直接改动源码**（避免与其他编辑会话冲突），修复待人工执行后 `pnpm build` 复验。

---

## 2. High（安全/稳定性，建议本轮修）

### H-1　`nxm://` 链接解析按字节切片 `&str`，`%` 后跟多字节字符必 panic；可被任意网页远程触发

- **位置**：`src-tauri/src/nxm.rs:135`
  ```rust
  if bytes[index] == b'%' && index + 2 < bytes.len() {
      let hex = &value[index + 1..index + 3];   // ← 不是边界就 panic
  ```
- **可达路径**（无需用户交互，只需用户已接管过 nxm 协议）：
  网页执行 `location.href = "nxm://cyberpunk2077/mods/1/files/2?key=%中"` → Windows 拉起本启动器 → `lib.rs:2724 nxm::links_from_args(args)` → `nxm.rs:157 parse_link` → `percent_decode` → **panic**。
- **实测复现**（函数原样抽出来编译运行）：
  ```
  about to decode evil payload: %中
  thread 'main' panicked at pct.rs:7:29:
  end byte index 3 is not a char boundary; it is inside '中' (bytes 1..4 of string)
  ```
  退出码 101。
- **放大因素**：`Cargo.toml [profile.release] panic = "abort"` ⇒ release 下不是「抛异常」而是**进程直接终止**，表现为启动器闪退/起不来，用户侧无从诊断。
- **修复建议**：改用字节切片 + UTF-8 校验，不要碰 `&str` 索引：
  ```rust
  if bytes[index] == b'%' && index + 2 < bytes.len() {
      if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
          if let Ok(byte) = u8::from_str_radix(hex, 16) { … }
      }
  }
  ```
  同时建议给 `parse_link` 补一条回归用例：`parse_link("nxm://cyberpunk2077/mods/1?key=%中")` 必须返回 `Err` 而不是 panic。

### H-2　45 处 `.expect("state mutex poisoned")` + `panic = "abort"`：任一 panic 都是进程级故障

- **位置**：`lib.rs`(19 处)、`installer.rs`(7 处)、`nexus.rs`(5 处)、`safemode.rs`、`selfcheck.rs`、`adopt.rs`、`ai.rs`、`config_pack.rs`、`download_queue.rs`、`vortex.rs` 等，共 **45 处** `store.data.lock().expect(...)`，另有 2 处 `staging_dir` 锁。
- **问题**：全仓库已把 `unwrap()` 清到只剩 2 处常量正则，但锁获取仍用 `expect`。在 `panic = "abort"` 下，任何一处 panic（如 H-1、越界、OOM）都直接终止进程而不展开；开发态（unwind）则会把互斥锁永久标记为 poisoned，此后**每个命令都 panic**，等于应用整体不可恢复。
- **修复建议**：
  1. 引入 poison 容忍的取锁助手（推荐，改动集中）：
     ```rust
     fn data_guard(store: &Store) -> MutexGuard<'_, AppStateData> {
         store.data.lock().unwrap_or_else(|e| e.into_inner())
     }
     ```
     状态文件本身是「整份读写 + 原子落盘」，读一个可能半更新的快照并不比崩溃更危险。
  2. 保留 `panic = "abort"`（减小体积）但装一个 `std::panic::set_hook`，把 panic 位置写进 `logs/`，否则用户只能看到闪退。

### H-3　`ai_base_url` 允许明文 `http://`，API Key 可能被中间人截获

- **位置**：`src-tauri/src/lib.rs:1258-1266`（校验）、`ai.rs:790`（`x-api-key` 头）、`ai.rs:757-760`（`Authorization: Bearer`）
- **问题**：校验只要求 `http://` 或 `https://` 前缀。填入任意**远程** `http://` 地址时，`Authorization: Bearer <key>` 会以明文发出；用户从「一键配置」或群里复制的 base URL 很容易踩到。
- **修复建议**：`http://` 仅放行回环地址，其余强制 HTTPS：
  ```rust
  let host = url::Url::parse(base).ok().and_then(|u| u.host_str().map(str::to_owned));
  let is_loopback = matches!(host.as_deref(), Some("127.0.0.1") | Some("localhost") | Some("::1"));
  if scheme == "http" && !is_loopback { return Err(...); }
  ```
  本地 Ollama / LM Studio 场景不受影响。

---

## 3. Medium

### M-1　异步 `listen()` 与清理函数存在竞态，可能永久泄漏事件监听

- **位置**：`src/App.tsx:531-556`、`src/App.tsx:564-596`、`src/components/NexusView.tsx:137-150`
- **问题**：典型写法
  ```tsx
  let unlisten: (() => void) | undefined;
  void (async () => { unlisten = await listen("x", cb); })();
  return () => unlisten?.();
  ```
  若组件在 `await listen` 落地前卸载，cleanup 已跑（此时 `unlisten` 仍是 `undefined`），随后 Promise 落地并**永久挂上监听器**。`App.tsx:514` 已有 `alive` 标志却只在 `nxmPending` 分支里用，`listen` 分支没用。
- **影响**：热重载/切换视图频繁时监听器累积，回调里 `setState` 打到已卸载组件；`download-status` 监听重复挂载会重复弹 toast。
- **修复建议**：
  ```tsx
  let disposed = false;
  void (async () => {
    const off = await listen(...);
    if (disposed) { off(); return; }
    unlisten = off;
  })();
  return () => { disposed = true; unlisten?.(); };
  ```

### M-2　i18n 闸门未通过：`dependencies.ts` 有 4 处硬编码中文

- **位置**：`src/lib/dependencies.ts:200`、`202`、`230`、`231`
  ```ts
  ? `随「${...}」一起安装`
  ? `游戏目录已安装${...}`
  : "游戏目录中未检测到该框架",
  ```
- **实测**：`node scripts/check-i18n.mjs --fail` → `合计 4 处，涉及 1 个文件` → 以 ❌ 退出（非零），即项目自带的 i18n 闸门现在是红的。
- **影响**：英文界面会在依赖卡片里直接显示中文；`i18n:gate` 无法进 CI。
- **修复建议**：改为返回 i18n key（如 `dep.installedWith` / `dep.installedInGameDir`），文案进 `zh-CN.ts`，渲染层 `t(key, { name, version })`。该文件顶部注释本就写着「只存 key，渲染层用 t() 取」，属实现与约定脱节。

### M-3　`open_path` 无白名单，与 `open_in_explorer` 的策略不一致

- **位置**：`src-tauri/src/lib.rs:2500-2512`（`open_path`）vs `lib.rs:752-784`（`open_in_explorer`）
- **问题**：`open_in_explorer` 限定在「暂存区 / 数据目录 / 游戏目录」三个根内；`open_path` 只判 `exists()` 就 `open::that_detached`，实际是「打开任意路径」原语，可拉起 `.exe/.bat/.lnk`。
- **现状**：当前所有调用点传的都是后端给的目录（staging/download/game/log），未发现外部可控输入，因此不是现实漏洞；但它是最容易被未来功能（Nexus 描述里的链接、`.nxm` payload、配置包字段）误用的入口。
- **修复建议**：把 `open_in_explorer` 的三根校验抽成 `assert_within_known_roots()`，`open_path` 复用；确需打开任意路径时另开 `open_any_path` 并在命名上显式标注风险。

### M-4　`open_in_explorer` 的前缀校验未规范化，`..` / 联接点可绕过

- **位置**：`src-tauri/src/lib.rs:753-771`
  ```rust
  let target = PathBuf::from(&path);
  let allowed = roots.iter().any(|root| target.starts_with(root));
  ```
- **问题**：`starts_with` 是逐组件比较，`D:\staging\..\..\Windows\System32` 会通过校验（组件序列确实以 `D:\staging` 开头）却指向根外；同理暂存区里的联接点/符号链接也不解析。
- **建议**：先 `fs::canonicalize(&target)` 再与 `canonicalize` 过的根比较（与 `installer.rs:1418`、`logs.rs:168-173` 已有做法保持一致），失败即拒绝。

### M-5　`launch_pre_command` 无任何校验，经 `cmd /C` 执行

- **位置**：`src-tauri/src/lib.rs:1325`（仅 trim）、`src-tauri/src/game.rs:1014-1021`（`cmd /C <command>`）
- **问题**：这是设计功能（用户自定义前置命令），但**没有长度上限、没有字符提示、导入配置包也不携带该字段**（已确认 `config_pack.rs` 未导入），风险主要来自「用户从别处粘一段命令」。一旦 `settings` 被外部改写，就等价于持久化 RCE。
- **建议**：加长度上限（如 512）、空命令直接视为不设置、UI 上明示「将以当前用户权限执行任意命令」，并在日志里记录实际执行的命令文本（便于事后排查）。

---

## 4. Low

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| L-1 | `ai.rs:326`、`ai.rs:330` | 脱敏用的两条 `Regex::new(...).unwrap()` 在**每次调用时重新编译**（`Regex` 编译不便宜），且是本仓库仅存的两处生产 `unwrap` | 提为 `static`（`std::sync::OnceLock<Regex>`），既去掉 unwrap 又省编译开销 |
| L-2 | `installer.rs:1430`、`adopt.rs:92` | 硬链接失败只 `eprintln!`，打包后的 GUI 程序没有控制台，这条降级信息**用户与日志都看不到** | 改为写 `logs/`（项目已有 `log_startup`）并计入 `DeployReport.warnings` |
| L-3 | `installer.rs:1485` | `safe_join(game_root, &file.relative).unwrap_or_default()`：不安全路径被静默吞掉（变成空 PathBuf 后跳过） | 解压阶段已拦截，这里属纵深防御，但应至少 `warnings.push` 一条，别让「文件去哪了」无据可查 |
| L-4 | `theme.ts:171`、`uiPrefs.ts:41`、`notify.ts:62`、`preferences.ts:93` | `localStorage.setItem` 未包 try/catch；配额满或 WebView 隐私限制下会抛异常，可能打断主题/偏好切换 | 统一走一个 `safeSetItem()` 空吞异常并降级为内存态 |
| L-5 | `App.tsx:748` | `if (!snapshot) return;    let cancelled = false;` 两条语句挤在一行；`DiagnosticsView.tsx:163-167` 用 `void ignoreTick` 绕过 lint | 分行；后者改成把 `ignoreTick` 放进 `useMemo` 依赖，去掉这种「假引用」 |
| L-6 | `ai.rs:566` | `merged.last_mut().expect("last() 已判定存在")` — 判定与取值之间隔着若干行，后续改动容易失效 | 改为 `if let Some(last) = merged.last_mut()` |
| L-7 | `Category` 分类 | `whole_word_hit`（`category.rs:49-73`）每命中一次 `start = abs + 1` 逐字节推进，中文名称下是 O(n²) | 目前名称短、无实测影响，量大时改用 `match_indices` |

---

## 5. 已核查且**未**发现问题的部分（避免误以为漏查）

写成清单是因为这些正是同类项目最常翻车的地方，而本项目做得比预期好：

- **ZIP 解压防穿越**：`installer.rs:109-215` 用 `entry.enclosed_name()`、拒绝 `0o120000` 符号链接条目、条目数上限 30k、解压总量上限 8 GB、`safe_join` 二次校验、去重（大小写归一）。`7z` 同样拒绝 `0x400` 重解析点。**未见 zip-slip / 解压炸弹缺口**。
- **路径工具**：`store.rs:242-256 safe_join` 逐段拒绝 `..` 与 `:`；`is_within` 组件级比较并小写归一（不会把 `Games` 误判为 `Games2`）。
- **密钥存储**：`secret.rs` 走 DPAPI（`CRYPTPROTECT_UI_FORBIDDEN`），落盘前加密、原子替换、读完即 `LocalFree`，密钥不进 `launcher-state.json`；前端两个密钥框都是 `type="password"` 且保存后清空 state。
- **命令注入面**：`Command::new` 均按参数向量传参（不经 shell）；仅 `game.rs:1015` 走 `cmd /C` 且输入来自用户设置（见 M-5）；`parse_launch_args` 有 256 字符上限 + 字符白名单。
- **URL 打开**：`open_url` 只放 `http/https` 且拒绝空白字符（`lib.rs:2279-2289`）。
- **CSP / 能力面**：`tauri.conf.json` CSP 为 `default-src 'self'`、`script-src 'self'`、`object-src 'none'`；`assetProtocol.scope` 只开 `$APPDATA/$APPLOCALDATA`；`capabilities/default.json` 仅 9 项窗口权限 + dialog。前端**无** `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function`。
- **同名 `npm` 依赖供应链**：11 个生产依赖 + 10 个开发依赖，`pnpm audit --prod` 未发现已知漏洞。
- **XSS 面**：Nexus 描述类远程文本走自研 `markdownLite.ts`，未发现 HTML 直插。
- **定时器**：`App.tsx:737/829`、`CollectionWizard.tsx:112`、`DownloadsView.tsx:122` 等 `setInterval` 均有 `clearInterval` 且含 `cancelled` 守卫；`useEffect` 101 处、`addEventListener` 全部成对。
- **空状态**：`LibraryView`（区分「搜索无结果 / 暂存区为空 / 分类为空」三类文案）、`NexusView`、`DownloadsView`、`DiagnosticsView` 日志列表均有显式空态。
- **JSON 解析**：`uiPrefs.ts`、`notify.ts`、`preferences.ts`、`theme.ts`、`dependencies.ts` 的 `JSON.parse` **全部**在 try/catch 内且做了类型收窄。
- **落盘原子性**：`installer.rs:1314-1360` 部署失败回滚已建链接、`store.save` 失败回滚文件与状态、`secret.rs` 临时文件 + rename。
- **TODO/FIXME**：前后端均 0 处（`grep` 全库无命中），不存在「注释即缺陷」的积压。

---

## 6. 依赖版本与漏洞

**前端**（`package.json`）：`pnpm audit --prod` → `No known vulnerabilities found`。版本均为 caret 锁定，建议在 `pnpm-lock.yaml` 基础上加 `pnpm audit --prod` 进发布前检查。

**Rust**（`Cargo.toml` / `Cargo.lock`）：直接依赖 22 个（tauri 2、reqwest 0.13、zip 2.4、sevenz-rust 0.6、rusty-leveldb 3、open 5、winreg 0.55、windows-sys 0.59、tokio 1、toml 0.8 等）。

> ⚠️ **本项未能完成，如实报告**：本机 `cargo audit` 不存在
> （`error: no such command: 'audit'`，仅有 `cargo add` 提示）。
> 未擅自 `cargo install cargo-audit`（需联网编译，耗时且会改动本机环境），
> 因此 **Rust 侧 RUSTSEC 漏洞数据库比对没有执行**，不能给出「无漏洞」结论。
>
> 补做方式（建议一次性）：
> ```
> cargo install cargo-audit
> cd src-tauri && cargo audit
> ```
> 若 CI 可用，改用 `cargo deny check advisories` 更省事。

---

## 7. 摘要统计

| 等级 | 数量 | 条目 |
|---|---|---|
| **Critical** | **1** | C-1 前端语法错误致构建失败 |
| **High** | **3** | H-1 nxm 解析 panic（远程可触发）；H-2 45 处锁 expect + panic=abort；H-3 明文 http 泄漏 API Key |
| **Medium** | **5** | M-1 监听器泄漏竞态；M-2 i18n 闸门红；M-3 open_path 无白名单；M-4 前缀校验可绕过；M-5 前置命令无校验 |
| **Low** | **7** | L-1 正则每次重编译；L-2 硬链失败静默；L-3 不安全路径静默跳过；L-4 localStorage 未防护；L-5 代码风格；L-6 expect 与判定分离；L-7 分类 O(n²) |
| **合计** | **16** | — |

## 8. 建议修复顺序

1. **C-1**（删 1 行）→ 立刻恢复可构建，`pnpm build` 复验。
2. **H-1**（改 4 行 + 1 条回归用例）→ 消除唯一的「远程可触发崩溃」。
3. **H-3**（补回环地址判断）→ 密钥安全，改动极小。
4. **M-2**（把 4 条中文抽成 key）→ 让 `i18n:gate` 转绿，可进 CI。
5. **H-2 / M-1 / M-3 / M-4 / M-5** → 结构性加固，可排入下一个迭代。
6. **L-1 ~ L-7** → 顺手清理，建议与相近模块改动合并提交。

---

*本报告所有行号基于 2026-10-30 22:00 的文件状态。其中 `DiagnosticsView.tsx` 的 mtime 为 22:01，若该文件仍在编辑，C-1 的行号请以「删除 `diagnostics-main` 提前闭合的那个孤立 `</div>`」为准。*
