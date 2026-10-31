/**
 * 重拍 README 截图（docs/screenshots/*.png）。
 *
 * 为什么单独写一个：README 里 33 处图片引用全是 2026-10-22~25 的旧截图，
 * 之后经历了 T8 自定义字体、主题改版、侧栏新增「存档管理」、r30-r35 布局修复，
 * 图里的界面和现在对不上。原有的 audit-shots.mjs 只出「主题 × 页面」的组合图，
 * 文件名与 README 引用的语义名对不上，不能直接拿来用。
 *
 * 约定：
 *   - 默认输出到 shots/readme-new/，人工看过再覆盖 docs/screenshots/（--write）。
 *     直接覆盖 git 跟踪的图片风险太大，先比对再落盘。
 *   - 浏览器预览本身就是 demo 模式（src/lib/mock.ts 提供 16 个演示模组），
 *     不需要连 Tauri 后端。
 *   - 每个场景独立 context，失败只跳过该张，不中断整批。
 */
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.GATE_PORT || "1420";
const BASE = `http://localhost:${PORT}/`;
const ROOT = path.resolve(import.meta.dirname, "..");
const WRITE = process.argv.includes("--write");
const OUT = WRITE ? path.join(ROOT, "docs", "screenshots") : path.join(ROOT, "shots", "readme-new");
fs.mkdirSync(OUT, { recursive: true });

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const VIEWPORT = { width: 1600, height: 1000 };

// 主题只有这 5 套（src/lib/theme.ts 的 STYLE_THEME_IDS）。
// mono 在 r20 被删除（老配置迁到 modern），daylight 更早。
// README 里写的「六套含 Mono / Daylight」是十几个版本前的信息。
const THEME_ACCENT = {
  ncpd: "#fcee0a",
  netrunner: "#31e6ff",
  arasaka: "#ff4058",
  militech: "#b7f04b",
  modern: "#1a1a1a",
};

const NAV = {
  library: "模组库",
  nexus: "发现",
  loadorder: "加载顺序",
  diagnostics: "运行诊断",
  saves: "存档管理",
  settings: "设置",
};

const done = [];
const failed = [];

async function open(browser, { theme = "ncpd", mode = "dark", collapsed = false, animations = false } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1.5 });
  await context.addInitScript(
    ([prefs, th, md]) => {
      localStorage.clear();
      // 关键：clear() 之后每次都是「首次运行」，EULA 弹窗会盖住整个界面、
      // 并且吃掉所有点击（导航按钮点不到，脚本全是 click Timeout）。
      // 第一版就踩了这个坑：截出来的图全是 EULA 蒙版，11 个场景全失败。
      localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
      // 主题真正生效的 key 是 theme.v2（preferences.v1 里那个 theme 字段只是
      // 旧版迁移来源）；modern 的明暗也在这个 key 的 colorMode 里。
      localStorage.setItem("ncl.ui.theme.v2", JSON.stringify({ styleTheme: th, colorMode: md }));
      localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify(prefs));
    },
    [
      {
        theme,
        useCustomAccent: false,
        accent: THEME_ACCENT[theme],
        scale: 1,
        sidebarCollapsed: collapsed,
        animations,
      },
      theme,
      mode,
    ],
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => failed.push(`pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return { context, page };
}

async function go(page, view) {
  const label = NAV[view];
  if (!label) return;
  const btn = page.locator(`button.nav-item[aria-label="${label}"]`).first();
  await btn.click({ timeout: 5000 });
  await page.waitForTimeout(700);
}

async function snap(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, name) });
  done.push(name);
  console.log(`shot ${name}`);
}

async function scene(browser, name, opts, fn) {
  let handle;
  try {
    handle = await open(browser, opts);
    // fn 返回 true 表示「这个场景自己截了图」（比如要截局部区域），别再截整页
    const selfShot = fn ? await fn(handle.page) : false;
    if (!selfShot) await snap(handle.page, name);
    else {
      done.push(name);
      console.log(`shot ${name} (局部)`);
    }
  } catch (err) {
    failed.push(`${name}: ${err.message.split("\n")[0]}`);
    console.log(`SKIP ${name} — ${err.message.split("\n")[0]}`);
  } finally {
    if (handle) await handle.context.close().catch(() => {});
  }
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

// ── 首页 / 各主题 ────────────────────────────────────────────
await scene(browser, "library.png", { theme: "ncpd" });
for (const theme of ["ncpd", "netrunner", "arasaka", "militech"]) {
  await scene(browser, `${theme}.png`, { theme });
}
// modern 是唯一支持明暗切换的风格，两张都要（原来是 mono / daylight 的位置）
await scene(browser, "modern-dark.png", { theme: "modern", mode: "dark" });
await scene(browser, "modern-light.png", { theme: "modern", mode: "light" });

// ── 主页面 ─────────────────────────────────────────────────
await scene(browser, "loadorder.png", { theme: "ncpd" }, (p) => go(p, "loadorder"));
await scene(browser, "diagnostics.png", { theme: "ncpd" }, async (p) => {
  await go(p, "diagnostics");
  await p.locator(".env-level").first().waitFor({ timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(400);
});
await scene(browser, "nexus.png", { theme: "ncpd" }, (p) => go(p, "nexus"));
await scene(browser, "settings.png", { theme: "ncpd" }, (p) => go(p, "settings"));

// 个性化 tab（主题选择卡）
await scene(browser, "appearance.png", { theme: "ncpd", collapsed: true }, async (p) => {
  await go(p, "settings");
  const tab = p.locator(".settings-tab").filter({ hasText: /个性化|Personal/i }).first();
  await tab.click({ timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(700);
});

// 侧栏收起（侧栏按钮在左下）
await scene(browser, "sidebar-collapsed.png", { theme: "ncpd" }, async (p) => {
  const btn = p.locator(".sidebar-collapse button, button[aria-label*='收起']").first();
  await btn.click({ timeout: 5000 });
  await p.waitForTimeout(600);
});

// 命令面板
await scene(browser, "command-palette.png", { theme: "ncpd" }, async (p) => {
  await p.keyboard.press("Control+k");
  await p.waitForTimeout(600);
});

// 卡片右键菜单
await scene(browser, "context-menu.png", { theme: "ncpd" }, async (p) => {
  const card = p.locator(".mod-card").first();
  await card.click({ button: "right", timeout: 5000 });
  await p.waitForTimeout(500);
});

// 详情抽屉
await scene(browser, "detail.png", { theme: "ncpd" }, async (p) => {
  await p.locator(".mod-card").first().click({ timeout: 5000 });
  await p.waitForTimeout(800);
});

// 冲突中心（模组库页头部的 CONFLICTS 统计块，是个 button）
await scene(browser, "conflict-center.png", { theme: "ncpd" }, async (p) => {
  const hit = p.locator("button.head-stat").filter({ hasText: /CONFLICT/i }).first();
  await hit.click({ timeout: 5000 });
  await p.waitForTimeout(700);
});

// 播放集切换：顶栏的是原生 <select>，下拉弹层由浏览器绘制、不进页面截图，
// 整页截图会与首页一模一样（第一版就这么翻车的）。改为截顶栏局部特写。
await scene(browser, "profile-switch.png", { theme: "ncpd" }, async (p) => {
  const el = p.locator(".profile-picker").first();
  const box = await el.boundingBox();
  if (!box) throw new Error("找不到 .profile-picker");
  await p.waitForTimeout(200);
  await p.screenshot({
    path: path.join(OUT, "profile-switch.png"),
    clip: {
      x: Math.max(0, box.x - 250),
      y: Math.max(0, box.y - 10),
      width: 620,
      height: Math.min(80, box.height + 20),
    },
  });
  return true;
});

// 存档管理页
await scene(browser, "saves.png", { theme: "ncpd" }, (p) => go(p, "saves"));

// AI 配置 tab
await scene(browser, "ai.png", { theme: "ncpd" }, async (p) => {
  await go(p, "settings");
  const tab = p.locator(".settings-tab").filter({ hasText: /AI 配置|AI/i }).first();
  await tab.click({ timeout: 5000 });
  await p.waitForTimeout(700);
});

// 播放集面板（在「工具组件」tab 里，不是游戏与路径）
await scene(browser, "profiles-panel.png", { theme: "ncpd" }, async (p) => {
  await go(p, "settings");
  const tab = p.locator(".settings-tab").filter({ hasText: /工具组件|Tools/i }).first();
  await tab.click({ timeout: 5000 });
  await p.waitForTimeout(600);
  const block = p.locator(".profile-panel").first();
  await block.scrollIntoViewIfNeeded({ timeout: 6000 });
  await p.waitForTimeout(600);
});

// 空状态（搜索一个不存在的关键词）
await scene(browser, "empty-state.png", { theme: "ncpd" }, async (p) => {
  const box = p.locator("input[type='search'], .search-input input, input[placeholder*='搜索']").first();
  await box.fill("zzzz-not-exist");
  await p.waitForTimeout(800);
});

// 日志查看（诊断页的日志面板）
await scene(browser, "log-viewer.png", { theme: "ncpd" }, async (p) => {
  await go(p, "diagnostics");
  await p.waitForTimeout(600);
  const logBtn = p.locator("button, .tab").filter({ hasText: /日志|LOG/i }).first();
  await logBtn.click({ timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(800);
});

await browser.close();

console.log(`\n完成 ${done.length} 张，失败 ${failed.length} 张`);
if (failed.length) for (const f of failed) console.log(" - " + f);
console.log(`输出目录: ${OUT}`);
