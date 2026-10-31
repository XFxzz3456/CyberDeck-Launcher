# INCIDENT 2026-10-29 — 新增的 6 个 Tauri 命令只定义未注册（前端 invoke 必炸）

> 批次：0.9.0-r22
> 影响面：Safe Mode（进入 / 退出 / 状态）、全局配置导入导出、过期插件扫描 —— **本轮交付的 4 个功能里有 3 个在运行时不可用**
> 发现方式：编译器 `never used` 警告 + exe 字符串取证（**不是因为功能测试失败**）

---

## 1. 现象

构建输出里出现 5 条 dead_code 警告，全部指向 `src-tauri/src/safemode.rs`：

```
warning: function `state` is never used
  --> src\safemode.rs:59:8
warning: function `enter` is never used
  --> src\safemode.rs:98:8
warning: function `exit` is never used
  --> src\safemode.rs:159:8
warning: function `residual_files` is never used
```

编译**成功**、exe **正常产出**、启动冒烟 `stage=frontend mods=195` **一切正常**。
如果没顺着这几条警告往下查，交付出去的 0.9.0 会是「Safe Mode 点了没反应 / 报 command not found」。

## 2. 真因

`src-tauri/src/lib.rs` 里新增的 12 个命令，只做了两件事中的第一件：

```rust
#[tauri::command]
fn safemode_state(...) -> safemode::SafeModeState { ... }   // ← 定义了
```

但 `tauri::generate_handler![...]` 列表里只补了 glossary 的 6 个，**漏了**：

- `config_export` / `config_import`
- `safemode_state` / `safemode_enter` / `safemode_exit`
- `compat_scan`

漏登记 ⇒ 命令函数不可达 ⇒ 它内部调用的 `safemode::state/enter/exit` 也一并变成死代码 ⇒ 编译器报的就是模块函数 never used。
**注意警告指的不是命令函数本身**（`#[tauri::command]` 宏会掩盖掉），所以只看警告文字容易误判成「模块写多了」。

## 3. 走过的错误假设

1. 先怀疑「警告是 cargo 回放旧编译缓存的假象」——因为 `lib.rs` 里明显 grep 得到 `safemode::enter(store.inner())`。
   证伪：看 `grep -n safemode lib.rs` 只找到**定义处与调用处**，`generate_handler!` 段（2608 行之后）里一个都没有。
2. 再怀疑「是不是 async 命令必须写进另一个列表」——项目里其它 async 命令（`nexus_download` 等）就在同一个列表里，排除。

## 4. 取证方式（可复用）

对 exe 做字符串检索，比「读代码猜」快且不可辩驳：

```bash
for s in safemode compat_scan config_export glossary; do
  printf "%-14s %s\n" "$s" "$(grep -ao "$s" target/release/cyberdeck-launcher.exe | wc -l)"
done
# safemode 0 / compat_scan 0 / config_export 0 / glossary 11
```

`glossary` 有 11 次、另外三个 0 次 —— 注册进 handler 的命令名会以字符串常量留在二进制里，没注册的一个都不会出现。
（注意：前端 bundle 是 brotli 压缩嵌入的，**不能**用「exe 里 grep 不到前端字符串」判断前端没打进去，这条只对 Rust 侧字符串有效。）

修复后交叉校验：`commands=102 registered=102 invoked=98 missing=0 unresolved=0`。

## 5. 新规则

1. **新增命令改两处，缺一不可**：`#[tauri::command] fn xxx` + `tauri::generate_handler![..., xxx]`。
2. **看到 `never used` 警告必须查到底**，尤其是「模块里的函数整组 never used」——那是命令没注册的典型指纹，不是代码冗余。
3. **已加门禁** `scripts/check-commands.mjs`（并挂进 `scripts/gate.mjs` 的 COMMANDS）：
   - 扫 `lib.rs` 收集 `#[tauri::command]` 定义的函数名；
   - 扫 `generate_handler![...]` 收集已注册名；
   - 扫 `src/**/*.ts(x)` 收集 `invoke("x")` 与项目包装 `call("x")` 的调用名；
   - 三处对不上就非零退出（`missing` = 定义了没注册，`unresolved` = 前端调了没注册）。

## 6. 代价

- 多一次完整构建（约 1 分半）。
- 教训：**「编译通过 + 启动冒烟过」不能证明新命令可用**。冒烟只看 `stage=frontend` 心跳，看不到 IPC 注册表。

## 7. 下次第一步查什么

新增/改动了 Tauri 命令后，**先跑 `node scripts/check-commands.mjs`**，再构建。
如果怀疑某个功能「点了没反应」，第一步不是看前端，而是：

```bash
grep -n "<命令名>" src-tauri/src/lib.rs     # 有没有进 generate_handler
grep -ao "<命令名>" <exe> | wc -l           # 二进制里有没有这个名字
```

## 8. 遗留

- 无。修复已在 0.9.0-r22 内完成，门禁已加。
