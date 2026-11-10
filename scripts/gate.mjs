#!/usr/bin/env node
// 合入门禁：一条命令跑完「后端单测 + 类型检查 + 前端构建 + 单点验收脚本」。
//
// 为什么要有这个脚本：验收脚本原先只是「打印一堆 key=value，人眼看」，
// 打印 `menu=0` 也算跑完、退出码是 0，等于没有门禁。这里把每条输出变成断言：
// 不满足就非零退出，并写一份 report.json 说明哪一项、期望什么、实际什么。
//
// 用法：
//   node scripts/gate.mjs                 # 全量（40 项左右，串行时约 7min，现在并发约 2-3min）
//   node scripts/gate.mjs --fast          # 只跑 tsc / vite build / 命令契约 / 版本号，约 40s
//                                         # 改 CSS、文案、截图这类不碰 Rust 与交互的改动用它
//   node scripts/gate.mjs --skip-ui       # 只跑 cargo test / tsc / vite build（无浏览器环境时用）
//   node scripts/gate.mjs --only=profiles # 只跑名字里含 profiles 的检查（调试用）
//   node scripts/gate.mjs --jobs=5        # 调 UI 检查的并发度（默认 3，也可用 GATE_JOBS 环境变量）
//
// 为什么 UI 检查要并发：38 个脚本各自起一个 headless Chromium、各自加载一次页面，
// 每个约 10s 里只有 2s 在断言、8s 是「起浏览器 + 加载」的固定开销。串行时这 5 分钟
// 纯粹是在等浏览器启动。并发 3 路后总时长压到 1/3 左右，判定逻辑与报告格式不变。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// --fast：只跑静态检查（tsc / vite build / 命令契约 / 版本号），跳过 cargo test 与全部 UI 脚本。
// 改 CSS、文案、截图这类不碰 Rust 和交互的改动，用它，约 40s 出结果。
const fast = flag("fast");
// 并发度：38 个 UI 脚本串行时，每个约 8s 的「起浏览器 + 加载页面」固定开销要吃掉 5 分钟。
// 本机 8 核 32G，默认 3 路并发就够把总时长压到 1/3，再高会和 cargo / 浏览器抢 CPU。
const jobs = Math.max(
  1,
  Number(value("jobs") ?? process.env.GATE_JOBS ?? 3) || 3,
);
const UI_TIMEOUT_MS = 240_000;

/** 脚本是否要起浏览器（= 需要 vite preview 在跑）。按源码里有没有 import playwright 判定。 */
const browserScriptCache = new Map();
function isBrowserScript(script) {
  if (!browserScriptCache.has(script)) {
    let source = "";
    try {
      source = readFileSync(join(ROOT, "scripts", script), "utf8");
    } catch {
      // 读不到就按「要浏览器」处理：宁可多起一次预览，也不要因为判错而漏跑。
      browserScriptCache.set(script, true);
      return true;
    }
    browserScriptCache.set(script, /\bplaywright\b/.test(source));
  }
  return browserScriptCache.get(script);
}

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

/**
 * 异步版：并发池里必须用它。spawnSync 会卡住事件循环，导致「并发」退化成串行。
 * 每个脚本各自起一个 headless Chromium，彼此不共享 localStorage / 页面状态，
 * 只读同一个 vite preview，因此并发是安全的（已核对：没有脚本自起服务或占固定端口，
 * 写文件的四个脚本各写各的 shots 子目录，mkdirSync recursive 可重复执行）。
 */
function runUiScriptAsync(spec) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join("scripts", spec.script)], {
      cwd: ROOT,
      env: { ...baseEnv, NO_PROXY: "127.0.0.1,localhost", GATE_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // stdout 只用来解析 key=value，封顶避免异常脚本刷爆内存。
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4 * 1024 * 1024) stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, UI_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(collectUiResult(spec, started, { stdout, stderr, status: code, timedOut }));
    });
  });
}

/** 同步 / 异步两条路径共用的结果整形与断言，保证判定逻辑只有一份。 */
function collectUiResult(spec, started, { stdout, stderr, status, timedOut }) {
  const map = parseOutput(stdout);
  const expectations = spec.expect.map((expression) => ({
    expression,
    ...checkExpectation(map, expression),
  }));
  const failures = expectations.filter((item) => !item.ok).map((item) => item.detail);
  if (timedOut) {
    failures.push(`脚本超时（${Math.round(UI_TIMEOUT_MS / 1000)}s）`);
  } else if (status !== 0) {
    failures.push(
      `脚本退出码 ${status}：` +
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

/**
 * 并发池：按 UI_SCRIPTS 顺序发车，结果按下标回收，报告里的顺序与串行时一致。
 * 完成即打一行，失败详情紧跟其后；成功项不再逐条打断言（要看细节就 --only=xxx 单跑）。
 */
async function runUiPool(specs, concurrency) {
  const collected = new Array(specs.length);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= specs.length) return;
      const spec = specs[index];
      const result = await runUiScriptAsync(spec);
      collected[index] = result;
      done += 1;
      log(
        `  ${result.ok ? "✓" : "✗"} [${done}/${specs.length}] ${result.name}（${(
          result.ms / 1000
        ).toFixed(1)}s）`,
      );
      if (!result.ok) {
        log(indent(result.detail));
        log(indent(result.failures.join("\n")));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, specs.length)) }, worker),
  );
  return collected.filter(Boolean);
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

// 单点验收脚本：每项都能单独重跑，这里只负责把它们变成断言。默认并发执行（见 --jobs）。
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
    // 发版纪律：三处版本号必须一致（package.json / Cargo.toml / tauri.conf.json）
    name: "版本号一致性",
    script: "check-version-sync.mjs",
    expect: ["version_sync=1"],
  },
  {
    // 1.0.0 批次 9：多套 AI 配置（本地/云端/中转站各一套，可切换可测试）
    name: "AI 多套配置",
    script: "check-ai-profiles.mjs",
    expect: [
      "profiles>=2",
      "activeMarked=1",
      "switched=1",
      "testResult=1",
      "testBadStyle=1",
      "created=1",
      "pageerrors=0",
    ],
  },
  {
    // 1.0.0 批次 9：退出确认开关 + Nexus 401 出口
    name: "关闭确认与 Nexus 401",
    script: "check-close-nexus.mjs",
    expect: [
      "closeAskToggle=1",
      "closeAskToggleWorks=1",
      "nexus401=1",
      "nexusRegenEntry=1",
      "pageerrors=0",
    ],
  },
  {
    // 1.0.0 批次 8：AI 诊断给出可执行动作（确认 + 快照后才动手）
    name: "AI 可执行修复",
    script: "check-ai-actions.mjs",
    expect: [
      "reportSteps=1",
      "actionButtons>=1",
      "actionHint=1",
      "confirmShown=1",
      "confirmMentionsSnapshot=1",
      "cancelNoop=1",
      "actionApplied=1",
      "snapshotReported=1",
      "pageerrors=0",
    ],
  },
  {
    // 1.0.0 批次 6：收编禁用只断链接（用户实测「恢复目标已存在」）+ 测试接线
    name: "收编禁用红线",
    script: "check-adopt-safety.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // 1.0.0 批次 6：兼容性体检重构（只查核心前置、版本号换社区叫法、不再报"未知"）
    name: "兼容性体检（防焦虑）",
    script: "check-compat-health.mjs",
    expect: [
      "rendered=1",
      "targetIsCommunity=1",
      "targetHasVerdict=1",
      "healthyBanner=1",
      "riskItems=0",
      "warnBlock=0",
      "frameworkChips=4",
      "legacyWording=0",
      "pageerrors=0",
    ],
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
    // T5 暴露：详情页按钮 / 工具栏批量下拉 / 卡片「中·AI」徽标。
    name: "AI 汉化入口",
    script: "check-ailoc-entry.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // P6：批量改分类（选择模式 → 分类下拉 → 落盘 + 锁定）。
    name: "批量改分类",
    script: "check-batch-category.mjs",
    expect: ["checks_failed=0"],
  },
  {
    // 2026-11-01：工具栏两组分家 + AI 工具合并 + 窄屏收纳不换行。
    name: "模组库工具栏",
    script: "check-toolbar.mjs",
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
    // scaleMaxDelta：80 / 100 / 125% 三档缩放下，菜单左上角相对鼠标落点的最大偏差。
    // body 上有 zoom，fixed 坐标会被二次缩放——曾经 125% 下菜单整体右飘上百像素，
    // 用户看到的就是「右键菜单和右键的位置不在一起」。
    expect: ["menu=1", "items>=3", "afterEsc=0", "scaleMaxDelta=0", "scaleCases=3"],
  },
  {
    name: "播放集切换",
    script: "check-profiles.mjs",
    // alignLeft：浮层左边界 − 外层胶囊左边界。曾经拿内层按钮当锚点，右飘 11px；
    // scaleMaxDelta：90 / 100 / 110% 三档 UI 缩放下都要为 0（body zoom 会让 fixed 坐标二次缩放）。
    expect: [
      "options>=2",
      "before!=after",
      "rows>=1",
      "dialog>=1",
      "alignLeft=0",
      "alignInViewport=1",
      "scaleMaxDelta=0",
      "scaleCases=3",
    ],
  },
  {
    name: "环境体检面板（防误报）",
    script: "check-env-panel.mjs",
    expect: [
      "level>=1",
      "metrics>=1",
      // 轻微差异只给灰色「提示」，且措辞里不许出现"异常/被改写"
      "badgeInfo=1",
      "toleranceHint=1",
      "summaryCalm=1",
      "alarmWording=0",
      // 只有状态变化时"一键修复"没有可修的东西，按钮置灰
      "fixDisabledParked=1",
    ],
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
    name: "AI 配置协议中立 + 动作安全边界",
    script: "check-ai-config.mjs",
    expect: [
      "actionKinds=1",
      "actionsSanitized=1",
      "applyRechecks=1",
      "snapshotBlocks=1",
      "patchHandsOff=1","protocol=1", "chromeVendor=0", "presetMatched=1", "diagProtocol=1", "diagVendorBadge=0", "diagModelShown=1"],
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
    // 10 项：个性化 → 高级设置里的「动画速度」滑块（574438）。
    // 只断言可稳定观测的 DOM/存储事实，不采样弹簧曲线——
    // 曲线阈值留给 check-motion.mjs（不进合入闸，边际太窄会假红）。
    name: "动画速度滑块",
    script: "check-motion-speed.mjs",
    expect: [
      "advanced=1",
      "collapsed=1",
      "slider=1",
      "scale150=1.5",
      "stored150=150",
      "motion150=on",
      "scale0=0",
      "motion0=off",
      "underline0=0",
      "transition0=1",
      "resetOk=1",
      "scaleReload=1.3",
      "motionReload=on",
      "errors=0",
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
if (fast) log(`  模式 --fast：跳过 cargo test 与需要浏览器的检查，只验静态项`);

const activeCommands = COMMANDS.filter((spec) => {
  if (only && !spec.name.toLowerCase().includes(only.toLowerCase())) return false;
  // --fast 下 cargo test 也跳过：它只跟 Rust 改动相关，占了 40 多秒。
  if (fast && spec.name.includes("cargo")) return false;
  return true;
});

for (const spec of activeCommands) {
  log(`\n▸ ${spec.name}`);
  const result = runCommand(spec);
  results.push(result);
  log(result.ok ? `  ✓ 通过（${(result.ms / 1000).toFixed(1)}s）` : `  ✗ 失败（${result.detail}）`);
  if (!result.ok) log(indent(result.failures.join("\n")));
}

// 脚本要不要浏览器，按「源码里有没有 import playwright」自动判定——比手工加标记可靠，
// 新脚本放错分组也不会漏。纯静态的那几个（版本号/命令契约/安全模式/收编/impeccable 审计）
// 在 --fast 下照跑，因为它们本来就不需要预览服务。
const uiSpecs = skipUi
  ? []
  : UI_SCRIPTS.filter(
      (spec) => !only || spec.script.toLowerCase().includes(only.toLowerCase()),
    ).filter((spec) => !fast || !isBrowserScript(spec.script));
const needPreview = uiSpecs.some((spec) => isBrowserScript(spec.script));

let preview = null;
if (needPreview) {
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
}

// 预览服务起不来时，浏览器脚本没法跑，但纯静态脚本不受影响，照跑。
const runnable = preview
  ? uiSpecs
  : uiSpecs.filter((spec) => !isBrowserScript(spec.script));

if (runnable.length > 0) {
  log(`\n▸ 检查 ${runnable.length} 项 · 并发 ${Math.min(jobs, runnable.length)}`);
  const uiResults = await runUiPool(runnable, jobs);
  results.push(...uiResults);
  const uiFailed = uiResults.filter((item) => !item.ok).length;
  log(
    `\n  ${uiFailed === 0 ? "✓ 全部通过" : `✗ 失败 ${uiFailed} 项`}` +
      `（合计 ${(uiResults.reduce((sum, item) => sum + item.ms, 0) / 1000).toFixed(0)}s 工时）`,
  );
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
