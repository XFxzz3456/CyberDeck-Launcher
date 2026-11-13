# CyberDeck Launcher 1.8.4 代码审查报告（Bug 与质量）

- 审查日期：2026-11-13 22:00（自动化例行审查，第 2 次）
- 对象：commit `d83ea97`（1.8.4 发布记录），工作树干净
- 范围：src-tauri/src（61 个 .rs，约 47,400 行）+ src/（100 个 .ts/.tsx）
- 对照：上一次审查（2026-10-30，v0.9.0，16 项）遗留问题核销见 §5

## 摘要

| 等级 | 数量 | 编号 |
| --- | --- | --- |
| Critical | 0 | — |
| High | 1 | H1 |
| Medium | 1 | M1 |
| Low | 6 | L1–L6 |

基线健康度：`tsc --noEmit` 0 错误；`cargo check` 通过无警告（2m07s）；`pnpm audit --prod` 无已知漏洞；TODO/FIXME 0 处（唯一命中是 ai.rs:1914 AI 提示词字符串，误报）。

---

## High

### H1 · nxm.rs `percent_decode` 对 `%` + 多字节字符仍会 panic（进程级崩溃，经 nxm:// 协议远程可触发）

- 位置：`src-tauri/src/nxm.rs:129-146`（第 135 行切片）
- 描述：上次审查（2026-10-30）已修复 `%XX` 结尾越界 panic，但第 135 行 `&value[index + 1..index + 3]` 仍是 **&str 字节切片**。当 `%` 后跟多字节 UTF-8 字符（如 `中`）时，切片落在字符边界内，直接 panic：
  - 已实证复现（独立 rustc 编译该函数）：`percent_decode("key=%中")` → `end byte index 7 is not a char boundary; it is inside '中'`
- 触发链：`nxm://cyberpunk2077/mods/1/files/1?key=%中` 经协议处理器 / 单实例转交进入 `parse_link` → `percent_decode`。`Cargo.toml:75` 配置 `panic = "abort"`， panic 即整个启动器进程终止。
- 修复建议（最小改动）：
  ```rust
  let hex = value.get(index + 1..index + 3);
  if let Some(hex) = hex.filter(|h| {
      h.len() == 2 && h.bytes().all(|b| b.is_ascii_hexdigit())
  }) {
      out.push(u8::from_str_radix(hex, 16).unwrap()); // 已过滤，必成功
      index += 3;
      continue;
  }
  ```
  用 `get()` 代替切片即可根治所有 char boundary panic；加 ASCII 校验防止意外推进。补一条 `parse_link("%中")` 不 panic 的回归测试。

## Medium

### M1 · `launch_pre_command` 经 `cmd /C` 执行任意命令，渲染层被攻破后是现成的提权路径

- 位置：`src-tauri/src/game.rs:1082-1110`（`run_pre_command`），设置源 `src-tauri/src/schema.rs:705`、写入入口 `src-tauri/src/lib.rs:2309`
- 描述：启动前置命令按设计执行用户配置的任意命令行（`cmd /C`），这是正当功能（挂载/解锁/改配置）。但该设置可经 `set_settings` 命令由前端直接改写且无需二次确认——若渲染进程被攻破（如供应链投毒的 npm 依赖），攻击者可通过写设置在下一次游戏启动时获得宿主任意命令执行。当前 CSP（script-src 'self'、无远程脚本）是唯一缓解。
- 修复建议：保存 `launch_pre_command` 时弹出原生确认对话框（DangerConfirmModal 同级确认），或对该字段变更走后端白名单/长度告警；至少在设置页显著标注风险。

## Low

### L1 · 静态正则 `Regex::new(...).unwrap()/expect()`

- 位置：`src-tauri/src/ai.rs:393`、`ai.rs:397`、`src-tauri/src/ailoc_full.rs:321`
- 描述：编译期常量正则，实际不会失败，但属生产 unwrap。建议改用 `std::sync::LazyLock<Regex>`（Rust 1.80+），零运行时成本且消除模式。

### L2 · `archive_path.file_name().unwrap()`

- 位置：`src-tauri/src/ailoc.rs:797`
- 描述：路径由 `root.join(format!("{mod_id}-ai-loc.archive"))` 构造，实践中必有 file_name，但为生产 unwrap。建议 `.file_name().unwrap_or_default()` 或 `map_err`。

### L3 · 前端若干 setTimeout 未保存句柄，组件卸载后仍会 setState

- 位置：`src/App.tsx:2787`（EULA 淡出）、`src/App.tsx:3410`（导入结果清空）、`src/components/SettingsView.tsx:375`、`src/components/ExternalToolsCard.tsx:42`
- 描述：React 18 下卸载后 setState 是无操作、不再告警，实际风险≈0（App 根组件生命周期等于应用生命周期）；但与项目其余处「句柄 + cleanup」的规范不一致。建议统一用 ref 保存并在 cleanup 清除。

### L4 · `which()` 经 `where` 查找解压工具，存在 CWD/PATH 劫持面

- 位置：`src-tauri/src/installer.rs:524-533`
- 描述：`find_archive_tool` 已优先走「用户配置路径 → ProgramFiles 绝对路径」（正确），`where` 仅是最后兜底。但 Windows `where` 会搜索当前目录，若启动器 CWD 可被第三方写入则可能拉起伪装的 7z.exe。概率低（CWD 通常为安装目录且受保护）。建议兜底阶段排除 CWD 结果或要求路径位于 ProgramFiles/LOCALAPPDATA 下。

### L5 · main 入口 `.expect()` 失败即 abort，无用户可见报错

- 位置：`src-tauri/src/lib.rs:4971`
- 描述：Tauri 模板默认写法，但配合 `panic="abort"` 意味着运行时初始化失败时窗口一闪而过无提示。建议 catch 后写日志文件 + 弹原生 MessageBox。

### L6 · `download_queue.rs:161` mutex poison expect（信息项）

- 描述：`panic="abort"` 下互斥锁不可能 poison（panic 即进程终止），该 expect 实际不可达，仅作记录。

---

## §5 上次审查（2026-10-30，v0.9.0）遗留核销

| 上次编号 | 结论 |
| --- | --- |
| Critical（DiagnosticsView.tsx:485 多余 `</div>` 致语法错误） | ✅ **已修复**（本次 tsc --noEmit 0 错误） |
| High（nxm.rs percent_decode panic） | ⚠️ **部分修复**：`%XX` 结尾场景已修（本次实证通过），多字节字符边界 panic 仍在（本次 H1） |
| cargo audit 缺失、RUSTSEC 比对未执行 | ⚠️ **仍未执行**：本机无 cargo audit（连续两次审查缺失，建议安装：`cargo install cargo-audit`） |

## §6 亮点（安全加固面，抽查确认）

- Zip 解压用 `enclosed_name()`（installer.rs:173/207）防 zip-slip；7z 拒符号链接条目 + 条目数/体积上限；Rar 解压前先列清单逐条 `safe_join` 校验（installer.rs:337-429，含「事后扫看不见 payload 外文件」的教训注释）。
- `store::safe_join` 全线拒绝 `..` / 盘符；`is_within` 校验广泛用于写入点（adopt/aifix/ailoc/backup/installer 等 12+ 处）；snapshots.rs:214-227 有显式防穿越 + 回归测试。
- Tauri 安全配置严格：CSP 白名单明确、capabilities 最小化（仅窗口操作 + dialog + updater）、asset protocol 限定 `$APPDATA/$APPLOCALDATA`、更新器带 minisign 公钥。
- API Key 走 DPAPI（secret.rs）加密落盘，全仓库无 key 进日志；上传/诊断文本有路径与邮箱脱敏（ai.rs redaction）。
- 前端定时器/监听器清理规范（抽查 DownloadsView/App/CollectionWizard/TaskCenter 全部正确 cleanup）；escLayer 栈仲裁有卸载清理；无 dangerouslySetInnerHTML；mock 层定时器自带 stop。

## §7 方法与局限

- unwrap 统计按 `#[cfg(test)]` 边界切分：生产 unwrap 3 处（ai.rs 2、ailoc.rs 1）、生产 expect 5 处（ai.rs/ailoc_full.rs/download_queue.rs/lib.rs/loadsort.rs 各 1，均有护栏理由）；测试文件（*_tests.rs）不计。
- 局限：47,400 行 Rust 未逐行读完，审查为「基线 + 高风险面抽查」（链接/解压/路径/进程/密钥/前端清理）。`cargo audit` 未安装，Rust 依赖 RUSTSEC 比对未执行。

## §8 核销结果（2026-11-13 22:10–，统一计入 1.8.3）

用户要求核实并修复；本轮逐条对照代码，状态如下。**已修 = 代码改完 + 有回归用例 / 编译验证**。

| 编号 | 复核结论 | 落地 |
| --- | --- | --- |
| H1 | ✅ 属实、已修 | `percent_decode` 的 `&value[i+1..i+3]` 确会 char boundary panic；改 `str::get()` + ASCII hex 过滤。`nxm_tests.rs::percent_decode_multibyte_does_not_panic` 覆盖 `%中` / 残缺 / 非 hex / 中文混合 5 组。 |
| M1 | ✅ 属实、已修（纵深防御） | 前端 `SettingsView` 改「草稿 → 失焦/回车 → `ConfirmDialog` 二次确认 → 落盘」+ 红色风险文案；后端 `set_settings` 加 512 字符上限与控制字符拒绝。清空不弹确认。 |
| L1 | ✅ 已修 | `ai.rs`（2 条）、`ailoc_full.rs`（1 条）静态正则改 `LazyLock<Regex>`。 |
| L2 | ✅ 已修 | `ailoc.rs` 的 `file_name().unwrap()` 改确定性兜底名。 |
| L3 | ✅ 已修 | 4 处一次性 `setTimeout` 收进 ref + 卸载 cleanup；另补 `NotificationDurationControl` 的 `hintTimer`（原报告未列，同模式）。 |
| L4 | ✅ 已修 | `installer::which` 兜底只接受绝对路径、跳过 CWD 命中且要求 `is_file()`。 |
| L5 | ✅ 已修 | `lib.rs::run` 的 `.expect()` 改 `unwrap_or_else` → 写 `%TEMP%\cyberdeck-launcher-startup-error.log` + `MessageBoxW`；`Cargo.toml` 加 `Win32_UI_WindowsAndMessaging` feature。 |
| L6 | ✅ 已修（信息项） | `download_queue::lock_state` 的 poison `expect` 改 `unwrap_or_else(|p| p.into_inner())`，与全仓口径一致。 |

补充核销：

- §5 提到的「cargo audit 未安装」仍缺（本机无 `cargo-audit`），本轮未补装；不影响上述源码修复。
- 复核中确认**已修而非遗留**的两项：rar 分支已改「前置列清单 `list_archive_entries` → `validate_archive_entries` → 再解压」；`.tmp-` 崩溃残留由 `store.rs` 回收。
- 全仓 `expect("… poisoned")` 已统一为 `unwrap_or_else`（grep 0 命中），§7 的中毒面描述不再成立。

验证：`cargo check --lib` 通过；`cargo test --lib` 399 passed / 0 failed / 2 ignored；`tsc --noEmit` 0 错误；`npm run build` 通过。
