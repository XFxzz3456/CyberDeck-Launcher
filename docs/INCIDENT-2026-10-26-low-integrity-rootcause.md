# 事故复盘（最终定案）：目录 Low 完整性标签导致进程被降权

> 日期：2026-10-26
> 关联：`docs/INCIDENT-2026-10-26-webview-and-datadir.md`（第一回合，结论已被本文件修正）
> 一句话：**不是代码问题，不是依赖问题，不是权限表问题——是 exe 所在目录带了 Low 完整性标签，把进程一起拉低了。**

---

## 1. 现象总览（三个症状，一个根因）

| # | 现象 | 表面归因 |
|---|---|---|
| 1 | 所有「打开浏览器」按钮静默失效、无报错 | 以为 `open` crate 升级回归 |
| 2 | 非管理员启动时 Nexus API Key「消失」 | 以为数据目录解析错 |
| 3 | 后来新版本点按钮弹 `explorer.exe 0xc0000142`（应用程序无法正常启动） | 以为 explorer 转交方式不对 |

## 2. 真因

```
icacls "D:\用户\工作区"
→ Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
→ S-1-4-97085777-170313022:(OI)(CI)(W,D,DC)      ← 另一台机器的孤儿 SID
```

两条 Windows 规则叠加，产生全部症状：

1. **目录的完整性标签向下继承**：`工作区` 被标成 Low 后，放进来的每个 exe 都带 Low 标签；
2. **文件标签会向下"否决"进程令牌**：即使 explorer（Medium）启动它，进程最终仍是 **Low IL**（日志实测 `integrity=0x1000`，正常应为 `0x2000`）。

Low 进程的代价：
- 不能往 Medium 对象写 → `%APPDATA%\com.arol.cyberdeck` 写入被拒（os error 5），旧代码随即静默回退到 exe 同级目录，形成两套数据 → API Key「消失」；
- 子进程继承 Low 令牌 → 浏览器（`msedge --single-argument`）卡死不显示窗口、`explorer.exe` 初始化失败报 0xc0000142。

根子在于**这个工作区是从旧电脑打包搬过来的**，把当时的低完整性标签和孤儿 SID 一起搬了过来。所以"别的软件跳转都正常、只有它不正常"——别的软件不在这个被标记的目录里。

## 3. 这一轮走过的错误假设（务必记住）

| 轮次 | 假设 | 实测结论 |
|---|---|---|
| 1 | `open` 5.4 的 Windows launcher 链回归（powershell→explorer） | **部分成立**（确实会假成功），但不是本案主因 |
| 2 | 用户 Edge 以提权实例运行，UIPI 拦截普通进程 | 曾出现该弹窗，但清掉 Edge 后仍失败 |
| 3 | 需要管理员运行 | 管理员下"能用"只是因为两边令牌一致，掩盖了问题，还引入提权浏览器与拖拽失效 |
| 4 | 数据目录路径解析错（环境变量不可信） | 实测路径完全正确（`apdata_env` 正确），卡在**写**被拒 |
| 5 | 进程令牌被安全软件降权 | 方向对了（确实是 Low IL），但一直没找到**谁**降的 |
| 6 | **exe 所在目录带 Low 标签** | ✅ 一击命中，`icacls` 一眼看到 |

**关键教训：每轮都只验"用户说好了/没好"，没有取到能区分假设的观测值。** 真正破局的是两行硬证据：`integrity=0x1000`（证明是 Low）和 `icacls` 的 `Mandatory Label`（证明来源）。

## 4. 修复动作

1. `icacls "D:\用户\工作区" /setintegritylevel "(OI)(CI)Medium"` —— 根目录修正，**此后新建文件自动 Medium**；
2. 存量 `release` 目录改标签需要提权（被环境拦截）→ 采用等效方案：旧目录改名 `CyberDeck-Launcher-0.7.0-release-old` 留备份，新建同名目录后**复制** exe/dll（复制出的对象继承父目录 Medium），数据目录移过去；
3. 验证：新 exe `Mandatory Label\Medium Mandatory Level`，启动日志 `integrity=0x2000`，浏览器跳转恢复正常。

## 5. 沉淀成规则

### 5.1 排查顺序（进程行为异常时，先查环境再查代码）
1. `icacls <exe>`：看是否有 `Mandatory Label\Low`、异常 SID；
2. 程序内取 `GetTokenInformation(TokenIntegrityLevel)`：Low=0x1000 / Medium=0x2000 / High=0x3000；
3. 对照实验：同用户、同目录，用 PowerShell 做同一操作（能写而程序不能写 → 令牌问题，不是 ACL）；
4. 只有前三步都排除后，才怀疑代码与依赖。

### 5.2 搬运目录必须体检
从别的机器/压缩包搬来的目录，一律检查：
- 完整性标签（Low 会让所有 exe 降权）；
- 孤儿 SID（`S-1-4-*`、`S-1-5-21-*` 未解析项）；
- 必要时 `icacls /setintegritylevel` 与 `/remove:d` 清理。

### 5.3 应用侧
- 子进程会继承令牌与标签，**任何"拉不起来"的子进程问题都要先确认自身 IL 是否正常**；
- 数据目录策略：exe 同级优先、可写探测、迁移只补齐不覆盖（沿用上一版结论）；
- 关键启动路径必须落地日志（`startup.log` 已含 `elev/integrity/appcontainer`，本次就是靠它破局）。

### 5.4 不要再做的两件事
- 不要用"整程序提权"去绕权限问题；
- 不要在没有观测值的情况下连续修改代码（这次因此多花了一小时、多打了 5 个包）。

## 6. 交付前必答三问

1. **哪个观测值证明了结论？** `integrity=0x1000`（进程）+ `icacls` 显示目录 `Low Mandatory Level`（来源）；
2. **这次修复的代价与新约束？** 发布目录重建了一次（旧目录留作 `-old` 备份，19MB 可删）；数据目录固定在 exe 同级 `cyberdeck-data`；`startup.log` 会持续累积，可在诊断页做清理入口；
3. **下次同类问题第一步查什么？** `icacls` 看 exe 与所在目录的完整性标签和孤儿 SID，其次看进程 token 的 integrity。
