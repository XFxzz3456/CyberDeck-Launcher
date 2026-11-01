#!/usr/bin/env node
// 合入门禁：一条命令跑完「后端单测 + 类型检查 + 前端构建 + 单点验收脚本」。
//
// 为什么要有这个脚本：验收脚本原先只是「打印一堆 key=value，人眼看」，
// 打印 `menu=0` 也算跑完、退出码是 0，等于没有门禁。这里把每条输出变成断言：
// 不满足就非零退出，并写一份 report.json 说明哪一项、期望什么、实际什么。
//
// 用法：
//   node scripts/gate.mjs                 # 全量
//   node scripts/gate.mjs --skip-ui       # 只跑 cargo test / tsc / vite build（无浏览器环境时用）
//   node scripts/gate.mjs --only=profiles # 只跑名字里含 profiles 的 UI 脚本（调试用）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = join(ROOT, "shots", "gate");
const PORT = Number(process.env.GATE_PORT ?? 1420);
const BASE = `http://localhost:${PORT}/`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const skipUi = flag("skip-ui");
const only = value("only");

// ---------------------------------------------------------------- 环境准备

/** cargo 不一定在非交互 shell 的 PATH 里；补上官方默认安装位置。 */
function cargoPath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const bin = join(home, ".cargo", "bin");
  const current = process.env.PATH ?? "";
  return existsSync(join(bin, "cargo.exe")) ? `${bin};${current}` : current;
}

const baseEnv = {
  ...process.env,
  PATH: cargoPath(),
  // ai::tests 会起本机 HTTP server；代理会把 127.0.0.1 也劫走。
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

// ---------------------------------------------------------------- 断言引擎

/**
 * 断言语法（对照脚本 stdout 里的 key=value）：
 *   "banners=1"     相等
 *   "items>=3"      下限（右侧可以是数字，也可以是另一个 key，例如 "rendered<total"）
 *   "issues<=2"     上限
 *   "before!=after" 两个 key 不相等
 */
function parseOutput(stdout) {
  const map = new Map();
  const pair = /([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g;
  for (const match of stdout.matchAll(pair)) {
    const [, key, raw] = match;
    if (!map.has(key)) map.set(key, raw);
  }
  return map;
}

function checkExpectation(map, expression) {
  const eq = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  const cmp = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(>=|<=|<|>)(-?\d+|[A-Za-z_][A-Za-z0-9_]*)$/);
  const ne = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)!=([A-Za-z_][A-Za-z0-9_]*)$/);

  if (cmp) {
    const [, leftKey, operator, rightRaw] = cmp;
    const actual = Number(map.get(leftKey));
    // 右侧可能是数字，也可能是另一个 key（用于「渲染数 < 总数」这类比较）。
    const bound = /^-?\d+$/.test(rightRaw) ? Number(rightRaw) : Number(map.get(rightRaw));
    const rightLabel = /^-?\d+$/.test(rightRaw) ? rightRaw : `${rightRaw}=${map.get(rightRaw) ?? "<缺失>"}`;
    const pass =
      Number.isFinite(actual) &&
      Number.isFinite(bound) &&
      {
        ">=": actual >= bound,
        "<=": actual <= bound,
        ">": actual > bound,
        "<": actual < bound,
      }[operator];
    return pass
      ? { ok: true, detail: `${leftKey}=${actual} ${operator} ${rightLabel}` }
      : {
          ok: false,
          detail: `${leftKey}=${map.get(leftKey) ?? "<缺失>"}，期望 ${operator} ${rightLabel}`,
        };
  }
  if (ne) {
    const left = map.get(ne[1]);
    const right = map.get(ne[2]);
    return left !== undefined && right !== undefined && left !== right
      ? { ok: true, detail: `${ne[1]}(${left}) != ${ne[2]}(${right})` }
      : { ok: false, detail: `${ne[1]}=${left ?? "<缺失>"} 与 ${ne[2]}=${right ?? "<缺失>"} 相等` };
  }
  if (eq) {
    const actual = map.get(eq[1]);
    return actual === eq[2]
      ? { ok: true, detail: `${eq[1]}=${actual}` }
      : { ok: false, detail: `${eq[1]}=${actual ?? "<缺失>"}，期望 ${eq[2]}` };
  }
  return { ok: false, detail: `无法解析断言 ${expression}` };
}

// ---------------------------------------------------------------- 执行器

function runCommand(spec) {
  const started = Date.now();
  // Windows 下开了 shell：可执行文件本身带空格（node 常装在 C:\Program Files\nodejs）
  // 会被命令行拆成两个词，报 "'C:\Program' is not recognized"。这里补引号。
  const executable =
    process.platform === "win32" && spec.cmd.includes(" ") && !spec.cmd.startsWith('"')
      ? `"${spec.cmd}"`
      : spec.cmd;
  const result = spawnSync(executable, spec.args ?? [], {
    cwd: spec.cwd ?? ROOT,
    env: baseEnv,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return {
    name: spec.name,
    kind: "command",
    ok: result.status === 0,
    ms: Date.now() - started,
    detail: result.status === 0 ? "exit 0" : `exit ${result.status}`,
    expectations: [],
    output: tail(output, 4000),
    failures:
      result.status === 0
        ? []
        : [output.split(/\r?\n/).filter((line) => line.trim()).slice(-12).join("\n")],
  };
}

function runUiScript(spec) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join("scripts", spec.script)], {
    cwd: ROOT,
    env: { ...baseEnv, NO_PROXY: "127.0.0.1,localhost", GATE_PORT: String(PORT) },
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const map = parseOutput(stdout);
  const expectations = spec.expect.map((expression) => ({
    expression,
    ...checkExpectation(map, expression),
  }));
  const failures = expectations.filter((item) => !item.ok).map((item) => item.detail);
  if (result.status !== 0) {
    failures.push(
      `脚本退出码 ${result.status}：` +
        stderr.split(/\r?\n/).filter(Boolean).slice(-6).join(" | "),
    );
  }
  return {
    name: spec.name,
    kind: "ui",
    ok: failures.length === 0,
    ms: Date.now() - started,
    detail: expectations.map((item) => `${item.ok ? "✓" : "✗"} ${item.detail}`).join(" · "),
    expectations,
    output: tail(stdout.trim(), 2000),
    failures,
  };
}

function tail(text, limit) {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

// ---------------------------------------------------------------- 预览服务

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // 还没起来，继续等。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

async function portBusy(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1200) });
    return true;
  } catch {
    return false;
  }
}

async function startPreview() {
  if (await portBusy(BASE)) {
    throw new Error(
      `端口 ${PORT} 已有服务在跑。门禁要求用本次构建的 dist，请先关掉旧的服务（或设 GATE_PORT 换端口）。`,
    );
  }
  const child = spawn(
    process.execPath,
    [join("node_modules", "vite", "bin", "vite.js"), "preview", "--port", String(PORT), "--strictPort"],
    { cwd: ROOT, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  const ready = await waitForServer(BASE);
  if (!ready) {
    child.kill();
    throw new Error(`预览服务没起来：${logs.join("").slice(-800)}`);
  }
  return child;
}

// ---------------------------------------------------------------- 检查清单

const COMMANDS = [
  {
    // 0.9.0 r22 事故门禁：命令漏登记 generate_handler! 编译期不报错、运行时才炸。
    name: "Tauri 命令契约（定义 / 注册 / 调用三处对齐）",
    cmd: process.execPath,
    args: [join("scripts", "check-commands.mjs")],
  },
  {
    name: "cargo test（core-tests）",
    cmd: "cargo",
    args: ["test"],
    cwd: join(ROOT, "core-tests"),
  },
  {
    name: "tsc --noEmit",
    cmd: process.execPath,
    args: [join("node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.json"],
  },
  {
    name: "vite build",
    cmd: process.execPath,
    args: [join("node_modules", "vite", "bin", "vite.js"), "build"],
  },
];

// 九个单点验收脚本：每项都能单独重跑，这里只负责把它们变成断言。
const UI_SCRIPTS = [
  {
    // r22：侧栏主操作区/辅助区分区 + 辅助区 Flex 沉底（无 absolute）
    name: "侧栏导航层级",
    script: "check-sidebar.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // r22：分类引擎（内容证据优先，不再读 description）+ 手动改分类
    name: "Mod 分类引擎",
    script: "check-category.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // 0.9.0：帮助中心离线可用（看板【11】）
    name: "内置帮助中心",
    script: "check-help.mjs",
    expect: ["tutorials>=6", "faq>=8", "expanded=1", "searchHits>=1"],
  },
  {
    // 0.9.0：安全模式红线（看板【13】）
    name: "安全模式红线",
    script: "check-safemode.mjs",
    expect: ["checks_failed=0"],
  },
  {
    name: "虚拟滚动 / 脏数据不白屏",
    script: "check-scroll.mjs",
    expect: ["total>=10", "rendered>=1", "rendered<total", "afterScroll>=1", "afterDirty>=1", "fault=0"],
  },
  {
    name: "存档管理（快照/确认弹窗/扫描/设置跳转）",
    script: "check-saves.mjs",
    expect: ["saves=PASS", "pageerrors=0"],
  },
  {
    // 2D：通知停留时长。warn/error 强制常驻的判定是 notify.ts::toastTtl 纯函数，
    // 这里只卡「配置真的生效」：落盘、越界修正、字符拦截、never 常驻、5 秒自动消失。
    name: "通知停留时长",
    script: "check-notifications.mjs",
    expect: [
      "segs>=5",
      "preset10=10",
      "customClamped=60",
      "digitsOnly=8",
      "emptyRevert=8",
      "never=never",
      "stickyToast=1",
      "normalToast=1",
      "autoDismissed=1",
      "pageErrors=0",
    ],
  },
  {
    // 2026-10-31：「存档管理」页漏登记 overflow-y，整页被 .content 裁掉、滚不动。
    // 这里同时卡住「长内容滚不动」和「行盒比字号还矮」两类，别让它们再回归。
    name: "页面滚动与文本行高",
    script: "check-layout-scroll.mjs",
    expect: [
      "pages=5",
      "stuck=0",
      "tightText=0",
      "widthSpread=0",
      "savesCanScroll=1",
      "pageErrors=0",
    ],
  },
  {
    // 2026-10-31（deepseek_markdown_20261030 那份 UI 自查任务）：把「肉眼看不出来」的
    // 三类问题变成数字卡住 —— 超宽屏内容铺满、小字对比度不足、可点控件没有按下反馈。
    // ultraContentW（2560 屏实际内容宽度）只记录不断言：它取决于 .page 的 max-width，
    // 属可调设计参数，写死数字会让「改设计」直接判红。这里只卡横向滚动与溢出。
    name: "UI 量化审查（超宽屏限宽 / 对比度 / 按下反馈）",
    script: "check-ui-audit.mjs",
    expect: [
      "viewports=4",
      "hScrollMax=0",
      "narrowHScroll=0",
      "overflowTotal=0",
      "scaleBroken=0",
      "contrastFails=0",
      "alignSpread=0",
      "hoverRules=10",
      "pageErrors=0",
    ],
  },
  {
    // r41：JS 拖拽整套删除，改由 data-tauri-drag-region 原生通路驱动。
    name: "窗口拖动（data-tauri-drag-region 原生通路）",
    script: "check-window-drag.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // r42：字重收拢到 400 / 500 / 700 三档。--font 栈首的 "Microsoft YaHei UI"
    // 只有 Regular(400) / Bold(700) 两个字面，600 会吸附到 700，于是「区块小标题」
    // 和「页面大标题」一样粗、层级塌掉。这里同时卡住「全量 CSS 无字面字重」和
    // 「页面计算字重只有三档」两条，别让 600 再从组件级 CSS 侧门溜回来。
    name: "排版层级（字重三档 / 令牌化 / 开关药丸型）",
    script: "check-typography.mjs",
    expect: [
      "checks_failed=0",
      "noLiteralWeight=1",
      "noPhantomWeight=1",
      "noPhantomComputed=1",
      "tokensDefined=1",
      "noSynthWeight=1",
      "toggleStateColor=1",
    ],
  },
  {
    // bf7889：卡片 ⇄ 列表视图切换（列表也要虚拟滚动，且选择要落盘）。
    name: "模组库视图切换",
    script: "check-library-view.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // P5-5B：更新检查 → 全部更新 → 命中清空。
    name: "Mod 更新落地",
    script: "check-updates.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // 4A：开背景图时顶栏 / Tabs / 设置卡片的毛玻璃（含「不叠嵌套」与「关图回退」）。
    name: "毛玻璃补齐",
    script: "check-glass.mjs",
    expect: ["checks_failed=0"],
  },
  {
    name: "游戏更新熔断",
    script: "check-update-lock.mjs",
    expect: ["banners=1", "after_click=0"],
  },
  {
    name: "平台选择器",
    script: "check-platform.mjs",
    expect: ["chips>=2", "after_click=GOG", "selected!=after_click"],
  },
  {
    name: "卡片右键菜单",
    script: "check-context-menu.mjs",
    expect: ["menu=1", "items>=3", "afterEsc=0"],
  },
  {
    name: "播放集切换",
    script: "check-profiles.mjs",
    expect: ["options>=2", "before!=after", "rows>=1", "dialog>=1"],
  },
  {
    name: "环境体检面板",
    script: "check-env-panel.mjs",
    expect: ["level>=1", "metrics>=1"],
  },
  {
    // 7 项：接收条 + 协议归属。多这一项是因为它跨了「注册表状态 → 前端 → 下载队列」三段。
    name: "NXM 协议接管",
    script: "check-nxm.mjs",
    expect: [
      "rows=1",
      "installButtons=1",
      "afterIgnore=0",
      "handlerVortex=1",
      "afterTakeover=1",
      "afterRelease=1",
      "takenOver=1",
    ],
  },
  {
    // 8 项：状态文件坏掉时，用户必须被告知"原件还在哪"，否则等于静默清空。
    name: "状态恢复提示",
    script: "check-state-recovery.mjs",
    expect: ["bannerClean=0", "bannerRecovered=1", "mentionsPath=1", "mentionsDeleted=1"],
  },
  {
    // 9 项：接入方式改成「任何 OpenAI 兼容服务」后，界面不许再长回单一服务商的口径。
    name: "AI 配置协议中立",
    script: "check-ai-config.mjs",
    expect: ["protocol=1", "chromeVendor=0", "presetMatched=1", "diagProtocol=1", "diagVendorBadge=0", "diagModelShown=1"],
  },
  {
    // 9 项：modlist 导入导出 + 批量启用禁用（看板【mod 列表及切换功能】）。
    name: "modlist 工具与批量操作",
    script: "check-modlist-tools.mjs",
    expect: [
      "exportBtn=1",
      "exportNote=1",
      "selectBtn=1",
      "checkboxes=1",
      "batchBar=1",
      "count2=1",
      "selectAll=1",
      "autoExit=1",
      "dbDisabled=1",
    ],
  },
  {
    // 23 项：2026-10-30 反馈四项——框架探测（redscript/Mod Settings）、版本号不带重复 v、
    // 账户头像 flex 居中、断开/连接后侧栏角标与卡片同步、诊断结论卡排版与窄屏自适应。
    name: "反馈修复四项",
    script: "check-feedback-fixes.mjs",
    expect: [
      "versionClean=1",
      "avatarExists=1",
      "avatarFlex=1",
      "avatarCenter=1",
      "avatarSquare=1",
      "settingsConnected=1",
      "disconnectSync=1",
      "sidebarBadge=1",
      "badgeCleared=1",
      "cardRestored=1",
      "verdictCard=1",
      "verdictRadius=1",
      "verdictTitle=1",
      "verdictBold=1",
      "verdictSub=1",
      "metricCount=1",
      "metricSize=1",
      "metricWarn=1",
      "verdictIcon=1",
      "redscriptFound=1",
      "modSettingsFound=1",
      "narrowAdapt=1",
    ],
  },
  {
    // 19 项：deepseek 四模块——部署方式/启动高级/暂存区建议（模块一）、限速/NXM 修复/折线/拖拽区（模块二）、
    // 外部工具卡片与侧栏固定（模块三）、界面显示管理与持久化（模块四）。
    name: "deepseek 四模块",
    script: "check-deepseek.mjs",
    expect: [
      "deployGroup=1",
      "deployCopySaved=1",
      "gpuChips=1",
      "priorityChips=1",
      "preCommandInput=1",
      "suggestList=1",
      "suggestRows=1",
      "speedGroup=1",
      "speedSaved=1",
      "nxmRepair=1",
      "toolsCard=1",
      "toolRows=1",
      "toolAddForm=1",
      "sidebarTool=1",
      "sparkCard=1",
      "dropzone=1",
      "hiddenViewsCard=1",
      "discoverSwitch=1",
      "discoverHidden=1",
      "hiddenPersisted=1",
      "discoverRestored=1",
    ],
  },
  {
    // 通知降噪（看板【通知/任务/活动三层】P1）：单次开关静默、连串开关只留一条汇总、
    // 任务队列不被轻操作污染、活动流逐条留痕、卡片角标同步。详见 scripts/check-notify-noise.mjs。
    name: "通知降噪",
    script: "check-notify-noise.mjs",
    expect: [
      "targetsReady=1",
      "singleSilent=1",
      "burstQuiet=1",
      "batchToast=1",
      "batchNotSticky=1",
      "taskRows=0",
      "activityLogged=1",
      "badgesOk=1",
      "checks_failed=0",
    ],
  },
  {
    // 13 项：自定义背景图（看板【皮肤 UI 优化】P0）——控制块/滑杆禁用态/背景层渲染/实时预览/恢复默认。
    name: "自定义背景图",
    script: "check-background.mjs",
    expect: [
      "block=1",
      "sliderDisabled=1",
      "clearDisabled=1",
      "noBackdrop=1",
      "backdropRendered=1",
      "opacityApplied=1",
      "blurApplied=1",
      "dataUrl=1",
      "sliderEnabled=1",
      "opacityPreview=1",
      "blurPreview=1",
      "clearWorks=1",
      "clearPersisted=1",
    ],
  },
  {
    // 10 项：预设扩成「厂商 → 模型」两级后，分区/模型 ID/地址不被覆盖/本地可编辑必须同时成立（r22）。
    name: "AI 预设目录",
    script: "check-ai-presets.mjs",
    expect: [
      "groups=3",
      "groupOrder=1",
      "vendors=14",
      "modelOptionHasId=1",
      "vendorUrlFilled=1",
      "vendorModelFilled=1",
      "modelPicked=1",
      "urlKept=1",
      "localEditable=1",
      "localHintShown=1",
    ],
  },
];

// ---------------------------------------------------------------- 主流程

const results = [];
const startedAt = new Date();

function log(line) {
  process.stdout.write(`${line}\n`);
}

log(`◆ CyberDeck Launcher 合入门禁 · ${startedAt.toLocaleString("zh-CN")}`);
log(`  根目录 ${ROOT}`);

for (const spec of COMMANDS) {
  if (only && !spec.name.toLowerCase().includes(only.toLowerCase())) continue;
  log(`\n▸ ${spec.name}`);
  const result = runCommand(spec);
  results.push(result);
  log(result.ok ? `  ✓ 通过（${(result.ms / 1000).toFixed(1)}s）` : `  ✗ 失败（${result.detail}）`);
  if (!result.ok) log(indent(result.failures.join("\n")));
}

let preview = null;
if (!skipUi) {
  log("\n▸ 启动预览服务");
  try {
    preview = await startPreview();
    log(`  ✓ ${BASE}`);
  } catch (error) {
    results.push({
      name: "启动预览服务",
      kind: "infra",
      ok: false,
      ms: 0,
      detail: String(error.message ?? error),
      expectations: [],
      output: "",
      failures: [String(error.message ?? error)],
    });
    log(`  ✗ ${error.message ?? error}`);
  }

  if (preview) {
    for (const spec of UI_SCRIPTS) {
      if (only && !spec.script.toLowerCase().includes(only.toLowerCase())) continue;
      log(`\n▸ ${spec.name}（${spec.script}）`);
      const result = runUiScript(spec);
      results.push(result);
      log(result.ok ? `  ✓ 通过（${(result.ms / 1000).toFixed(1)}s）` : `  ✗ 失败`);
      log(indent(result.detail));
      if (!result.ok) log(indent(result.failures.join("\n")));
    }
  }
}

if (preview) {
  preview.kill();
  // 等端口释放，避免下一次门禁撞端口。
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
}

const failed = results.filter((item) => !item.ok);
const summary = {
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  total: results.length,
  failed: failed.length,
  results,
};

mkdirSync(REPORT_DIR, { recursive: true });
const stamp = summary.startedAt.replace(/[:.]/g, "-");
writeFileSync(join(REPORT_DIR, `gate-${stamp}.json`), JSON.stringify(summary, null, 2), "utf8");
writeFileSync(join(REPORT_DIR, "report.json"), JSON.stringify(summary, null, 2), "utf8");

log(`\n${failed.length === 0 ? "✓ 门禁全绿" : `✗ 门禁失败 ${failed.length}/${results.length}`}`);
log(`  报告 shots/gate/report.json`);
process.exit(failed.length === 0 ? 0 : 1);

function indent(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => `    ${line}`)
    .join("\n");
}
