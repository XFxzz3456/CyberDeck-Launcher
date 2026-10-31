# 合规性自检报告 — 2026-10-30（r30 部署后）

> 范围：用户指定的 7 大模块。方法：逐模块人工读码核对（含 r30 新增代码），结论全部带 文件:行号 证据。
> 处置约定：P0 直接修；P1/P2 报告待确认。**本次未发现 P0**。
> **2026-10-30 21:00 更新**：用户确认后 P1-1、P1-2 已修复并补单测（见各条「修复记录」），cargo test 105 passed / 前端 tsc + vite build 通过。

## 一、结论总览

| 模块 | 结构认定 | P0 | P1 | P2 |
|---|---|---|---|---|
| A1 installer.rs 结构解析/冲突裁决 | 良好（拦截式冲突 + 失败回滚 + 身份校验） | 0 | 1（混合包静默丢文件）**已修** | 0 |
| A2 download_queue.rs | 良好（Retry-After 尊重、Range 续传、206 校验、令牌桶正确） | 0 | 1（等待期暂停/取消失效）**已修** | 1（HTTP 层 429 无上限） |
| A3 nxm.rs | 良好（只写 HKCU、先备份、domain 白名单、解析健壮） | 0 | 0 | 2 |
| A4 config_resolver.rs | 良好（间接寻址防任意写、写前备份、JSON 值级 patch） | 0 | 0 | 2 |
| A5 硬链接降级链 | 正确（copy 模式短路、symlink 跳过硬链、同卷才硬链、copy 兜底） | 0 | 0 | 1 |
| A6 modsettings.rs | 良好（注释/缩进/键序保留、CRLF 自适应、原子替换） | 0 | 0 | 1 |
| A7 ai.rs | 良好（双协议单测覆盖、key 不落日志、75s 超时、前端纯文本渲染） | 0 | 0 | 0 |

## 二、P1（用户已确认，2026-10-30 已修复）

### P1-1 下载等待期的暂停/取消被吞（download_queue.rs）— ✅ 已修

- **链路**：`worker_body` 每圈开头无条件清旗标（`download_queue.rs:594-595` `flags.pause.store(false); flags.cancel.store(false)`）。而 429 等待在 `sleep_interruptible`（:742-752）里逐秒查旗标，被暂停/取消时返回 false → 两个调用点（`Attempt::RateLimited` :631-634、`NEXUS_RATE_LIMITED` :645-647）直接 `continue` → 下一圈开头**把用户刚按下的旗标清掉**，任务继续下载。
- **触发**：任务处于 429 限流等待（30–300s）时点「暂停」或「取消」。
- **后果**：操作静默失效，取消的任务继续消耗带宽与重试次数；界面上任务仍显示队列中。
- **修复方案**：`sleep_interruptible` 返回 false 时**立即按旗标收尾并 return**（cancel → patch Cancelled + 删 .part；pause → patch Paused），不走 continue。
- **代价**：约 30 行改动 + 2 个单测（等待期 pause / 等待期 cancel）。
- **修复记录（实际落地）**：
  - 新增纯函数 `settle_interrupted(task, cancelled)`（`download_queue.rs:763`）：取消优先于暂停，`error` 清空，取消时补 `finished_at`。
  - 两个 429 等待点的 `continue` 全部替换为「读旗标 → `patch(settle_interrupted)` → `return`」（:631-640、:645-655），并在代码里写明为什么不能 continue。
  - 单测：`interrupted_wait_settles_as_paused_or_cancelled`、`interruptible_sleep_returns_immediately_when_flagged`（后者断言旗标已置时 30s 等待在 2s 内返回）。

### P1-2 混合包静默丢文件（installer.rs）— ✅ 已修

- **链路**：`detect_layout`（:813-884）按「GameRoot 深路径 > info.json > .archive/.xl/.xlp > .reds > .lua > 顶层目录」取第一个命中，混合包（如 `.archive` + `.reds`）会判成靠前的布局；`plan_for`（:922-936）随后把不属于该布局的文件 `continue` 静默跳过。`finalize_install` 的 warnings（:636-647）只覆盖 GameRoot 根目录未知文件与 REDmod 提示——Archive/Redscript/Cet 布局吞掉异类文件**没有任何提示**。
- **触发**：压缩包同时含 `.archive` 与 `.reds`/`.lua`（或 `.reds` + `.lua`），且没有游戏目录深路径前缀。
- **后果**：显示「导入成功」，部署后脚本/插件部分缺失，游戏内功能不全，用户极难定位。
- **修复方案**：detect_layout 返回布局时同时统计异类文件数，finalize_install 追加 warning「此包还含 X 个 .reds/.lua/.archive 文件，将不会被部署；请确认」。
- **代价**：detect_layout 改返回结构 + 单测 2 项。
- **修复记录（实际落地）**：
  - 新增 `layout_label()`（installer.rs:959）与 `layout_skipped(payload, layout, sample_limit) -> (总数, 前 N 个文件名, 布局标签)`（:977）。统计口径与 `plan_for` 的 `continue` 条件逐条对齐：GameRoot 看首段是否在 `RECOGNIZED_ROOTS`，Archive 只看 `.archive/.xl/.xlp`，REDmod/CET/redscript 不跳过任何文件（直接返回 0，避免误报）。
  - 两处接入：导入时 `finalize_install` 拼 warning（:636-652，替换掉原来只管 GameRoot 根目录的 `count_unknown_root_files`），部署时 `deploy_mod` 再报一次（:1258-1270，防旧库模组的提示早已被划走）。
  - 文案带可操作建议：列出前 3 个文件名 + 「如果这是多框架合集包，请把各部分拆开分别安装」。
  - 单测：`mixed_loose_archive_and_redscript_reports_skipped`（散装 archive+reds → 报 1 个）、`pure_archive_pack_reports_nothing_skipped`（不误报）、`game_root_pack_flags_stray_files`（tool.exe 被算）、`redmod_pack_reports_nothing_skipped`（Redmod 不误报）。
  - **未做的取舍**：没有改 `detect_layout` 的返回结构（改动面大、易引入回归），也没有尝试"自动把 .reds 也装上"——裸 `.reds` 没有 `r6/scripts/<folder>/` 归属信息，硬猜会把文件塞错位置，比跳过更糟。折中方案 = 显式告知 + 让用户拆包。

## 三、P2（记录在案，暂不动）

1. **write_modlist 原子写间隙**（loadorder.rs:200-203）：先 `remove_file` 再 `rename`，两步之间崩溃会丢 modlist.txt（temp 仍在，可手工恢复）。建议改为备份旧文件后 rename。
2. **undeploy 对 Copy 文件不验身份**（installer.rs:1564-1573 只对 HardLink 做 `same_file_identity`）：用户手动改过 copy 部署出的文件后卸载，改动随文件一起删除。清单语义内可接受，建议对 Copy 也比对 size/modified_time 并提示。
3. **replace_file 临时名可碰撞**（modsettings.rs:404-407）：temp 名 = `user.ini.cyberdeck-{pid}.tmp`，同进程两线程并发写同一配置文件会互踩；save_field 无文件级锁。单用户 GUI 场景概率极低。
4. **ini 不剥 UTF-8 BOM**（config_resolver.rs:1023 读入后，JSON 分支 :1054 剥了 `\u{feff}`，ini 没有）：带 BOM 的 ini 首个 section 匹配失败 → 走「追加到文件尾」分支，改动可能落到重复 section。
5. **nxm 备份单级覆盖**（nxm.rs:268-271）：Vortex→A→CDL 链条下最早的 handler 丢失；release 时会把 handler 写回已失效的旧路径。单级撤销语义，与常见工具一致。
6. **HTTP 层 429 重试无上限**（download_queue.rs:629-641）：`Attempt::RateLimited` 分支只对 resolve 阶段的 429 限 5 次（:643），文件下载 HTTP 429 每次都按 Retry-After（≥30s，封顶 300s）无限重试。不会打爆服务器，但任务可能长期挂着重试；可手动取消。建议同样接入 MAX_429_RETRIES。
7. **hard_link 失败只 eprintln**（installer.rs:1360）：GUI 无控制台等于没有日志，排查部署降级原因时缺证据。建议并入 deploy 的 warnings。

## 四、「未发现风险」明细（核对过证据的项）

- **冲突裁决确定性**（installer.rs:1384-1429）：冲突 = 拦截（DEPLOY_CONFLICT），不存在「后部署覆盖先部署」；同包内目标重复也拦截（PLAN_DUPLICATE :1163-1172）；部署中途 target.exists() 再校验（DEPLOY_RACE :1208-1213）；save 失败回滚已建文件并恢复 modlist（:1274-1290）。
- **卸载只信清单**（installer.rs:1545-1573）：safe_join + is_within 双重路径校验；HardLink 身份不符拒绝删除。
- **限速令牌桶**（download_queue.rs:852-895）：除数恒 >0、无死循环（elapsed≥budget 跳过睡眠）、cancel/pause 每 128KiB 内必查；limit=0 完全跳过。
- **429 主链路**：Retry-After 尊重 + 300s 封顶（:802-811）、resolve 阶段 5 次上限（:643）。
- **Range 续传**：.part 长度续传、206 才算续传否则 truncate 从头（:820）、total=part_len+len 校验（:821-825）、8GB 上限双检查（:826-833、:871-877）。
- **nxm parse_link**（nxm.rs:39-126）：大小写不伤 key、`nxm:` 无斜杠兼容、percent_decode 无 off-by-one（边界 `%3D` 结尾验证）、domain 白名单拒绝。
- **nxm takeover/release**：只写 HKCU；release 无备份时先确认当前 handler 是 ours 才删整棵（:313-320）；有单测覆盖（takeover_backs_up_previous_handler_and_release_restores_it 等）。
- **AI 双协议**：headers 由单测断言（:1843-1852 Anthropic 无 Bearer、:1755 OpenAI Bearer）；key 只进鉴权头，错误文案不拼接（:762 注释即约定）；75s 总超时 + 15s 连接超时（:696-698）；前端全仓无 dangerouslySetInnerHTML。
- **配置写入防呆**：source_id 间接寻址（config_resolver.rs:965-991 注释即设计）、editable 白名单、symlink 拒写（:740-763）、游戏目录 containment 校验、写前 .bak + .bak 符号链接检查（:1008-1021）、值禁换行限长（:723-737）。
- **INI 保真**（modsettings.rs:304-370）：注释/缩进/键序/其它 section 保留，CRLF 自适应，注释切分引号感知；MoveFileExW 原子替换（:400-429）；restore_backup 有测试。
- **modlist 兼容锚点**：MANAGED_HEADER 两代兼容层已于 r17 按决策移除（CHANGELOG r17）；现状 = 0.7.x 老文件判 unmanaged 时**拒绝写入并提示备份接管**（loadorder.rs:165-173），fail-safe 不破坏用户文件。

## 五、执行状态

1. ✅ **P1-1**（等待期暂停/取消失效）——2026-10-30 已修，2 个单测。
2. ✅ **P1-2**（混合包静默丢文件）——2026-10-30 已修，4 个单测。
3. ⏳ P2 第 1、6 条（modlist 原子写、HTTP 429 上限）——低成本高价值，等下一轮确认。
4. ⏳ 其余 P2 择机。

验证：`cargo test` 105 passed / 0 failed（含新增 6 项）；`tsc --noEmit` + `vite build` 通过。
