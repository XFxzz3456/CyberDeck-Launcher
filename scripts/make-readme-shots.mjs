/**
 * 重拍 README 截图（docs/screenshots/*.png）。
 *
 * 为什么单独写一个：README 里 31 处图片引用全是 2026-10-22~25 的旧截图，
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
 *   - 2026-11-03：补齐了此前只存在于旧截图里的 10 个界面。其中「未链接游戏目录」
 *     和「更新熔断」在演示数据里默认不出现，靠 seedDemoState() 改 localStorage 造出来；
 *     「导入确认 / 任务队列」靠 ImportDialog 的隐藏 file input 在浏览器里真跑一遍导入
 *     （src/components/ImportDialog.tsx 的 handleBrowserFiles 只取文件名，演示模式够用）。
 */
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.GATE_PORT || "1420";
const BASE = `http://localhost:${PORT}/`;
const ROOT = path.resolve(import.meta.dirname, "..");
const WRITE = process.argv.includes("--write");
// 调试用：SHOT_ONLY=task-center.png,log-extract.png 只跑指定几张，
// 改一个场景不必等全量 33 张跑完（全量约 3 分钟，其中两张导入场景各占 10 秒以上）。
const ONLY = process.env.SHOT_ONLY
  ? process.env.SHOT_ONLY.split(",").map((item) => item.trim()).filter(Boolean)
  : null;
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
      // addInitScript 每次导航都会重跑，包括 seedDemoState() 里的 page.reload()。
      // 早先这里无条件 clear()，于是刚播完种一刷新就被清回默认演示态，
      // 「未链接游戏目录 / 更新熔断」三个场景永远等不到提示条（踩过）。
      // 用 sessionStorage 做一次性闸门：新 context = 新会话，照旧干净起步；
      // 同一 tab 内 reload 不再重复清理。
      if (sessionStorage.getItem("__cdl_shots_booted") === "1") return;
      sessionStorage.setItem("__cdl_shots_booted", "1");
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

/**
 * 切到设置页的某个分区。
 *
 * 用 tab 的固定 id（SettingsTabs.tsx 里 id = `settings-tab-<SettingsTabId>`），
 * 不匹配文案——文案随 i18n 变，早先按「个性化」匹配，英文包里就点不中，
 * 又在 catch 里把异常吞掉，结果截图停在外观页也看不出来。
 */
async function tabTo(page, id) {
  await page.locator(`#settings-tab-${id}`).first().click({ timeout: 6000 });
  await page.waitForTimeout(450);
}

async function snap(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, name) });
  done.push(name);
  console.log(`shot ${name}`);
}

async function scene(browser, name, opts, fn) {
  if (ONLY && !ONLY.includes(name)) return;
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

// ── 两个小工具：播种演示状态、局部裁切 ────────────────────────

const DEMO_KEY = "cyberdeck-launcher-demo-state-v1";

/**
 * 改演示状态后重载页面。
 *
 * mock 的整份数据都在 localStorage 的 DEMO_KEY 里（见 src/lib/mock.ts 的 loadDb）。
 * 「未链接游戏目录」「游戏更新熔断」这类界面在演示数据里默认不存在，只能显式把状态
 * 改出来——否则截出来的图和首页一模一样，README 里两张图会重复。
 *
 * patch 用点号路径，例：{ "gameDir": null, "state.gameDir": null }。
 */
async function seedDemoState(page, patch) {
  await page.evaluate(
    ([key, entries]) => {
      const db = JSON.parse(localStorage.getItem(key) ?? "{}");
      for (const [path, value] of entries) {
        const parts = path.split(".");
        let target = db;
        for (const part of parts.slice(0, -1)) target = target?.[part];
        if (target && typeof target === "object") target[parts[parts.length - 1]] = value;
      }
      localStorage.setItem(key, JSON.stringify(db));
    },
    [DEMO_KEY, Object.entries(patch)],
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
}

/**
 * 只截某个元素（连 padding）——浮层、面板、弹窗都适用；返回 true 让 scene 别再截整页。
 *
 * maxWidth（CSS 像素，落盘时还要乘 deviceScaleFactor=1.5）用来砍掉右侧无关区域：
 * README 的图都塞在两列表格里、实际显示宽度只有 400 多像素，
 * 一张 18:1 的横幅缩下去就是一条红细线、字全糊。砍掉尾部的操作按钮后，
 * 同样的显示宽度里字号能大一倍多。
 */
async function shotClip(page, selector, name, pad = 14, maxWidth = Infinity) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded({ timeout: 6000 });
  await page.waitForTimeout(220);
  const box = await el.boundingBox();
  if (!box) throw new Error(`找不到 ${selector}`);
  const vp = page.viewportSize() ?? VIEWPORT;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: path.join(OUT, name),
    clip: {
      x,
      y,
      width: Math.min(maxWidth, vp.width - x, box.width + pad * 2),
      height: Math.min(vp.height - y, box.height + pad * 2),
    },
  });
  return true;
}

/**
 * 浏览器里真跑一次导入：点顶栏「导入模组压缩包」→ 往隐藏的 file input 塞文件名 →
 * 点底部主按钮。演示模式的 installMods 只看文件名建模组，所以不必有真 zip 内容。
 */
async function runImport(page, names) {
  await page.locator("button.btn-import").first().click({ timeout: 6000 });
  const input = page.locator("input[type='file']").first();
  await input.waitFor({ state: "attached", timeout: 6000 });
  await input.setInputFiles(
    names.map((name) => ({
      name,
      mimeType: "application/zip",
      buffer: Buffer.from("PK\u0003\u0004demo", "utf8"),
    })),
  );
  await page.waitForTimeout(300);
  await page.locator(".modal-foot .btn-primary").first().click({ timeout: 6000 });
}

/** 导入完成后的结果清单（两个场景共用：一个保持弹窗、一个关掉看任务面板）。 */
async function waitImportDone(page) {
  await page.locator(".import-review-list").first().waitFor({ timeout: 25000 });
  await page.waitForTimeout(400);
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
  await tabTo(p, "appearance");
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
  await tabTo(p, "ai");
  await p.waitForTimeout(700);
});

// 播放集面板（在「工具组件」tab 里，不是游戏与路径）
await scene(browser, "profiles-panel.png", { theme: "ncpd" }, async (p) => {
  await go(p, "settings");
  await tabTo(p, "tools");
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

// ── 2026-11-03 补齐：此前只存在于旧截图里的 10 个界面 ──────────

// 未链接游戏目录：清掉 gameDir，界面上会同时出现工业警告带 + 目录接收面板
await scene(browser, "game-root-warning.png", { theme: "ncpd", collapsed: false }, async (p) => {
  await seedDemoState(p, { gameDir: null, "state.gameDir": null });
  await p.locator(".setup-banner").first().waitFor({ timeout: 8000 });
  await p.waitForTimeout(500);
});

// 工业警告带特写（上面那张里的红色斜纹条）
await scene(browser, "warning-strip.png", { theme: "ncpd" }, async (p) => {
  await seedDemoState(p, { gameDir: null, "state.gameDir": null });
  await p.locator(".setup-banner").first().waitFor({ timeout: 8000 });
  return shotClip(p, ".setup-banner", "warning-strip.png", 0, 640);
});

// 游戏更新熔断：把「上次确认的游戏版本」改旧，getGame() 就会判成游戏更新过
await scene(browser, "update-lock.png", { theme: "ncpd" }, async (p) => {
  await seedDemoState(p, { "state.lastGameVersion": "2.28" });
  await p.locator(".update-lock-banner").first().waitFor({ timeout: 8000 });
  await p.waitForTimeout(400);
});

// 环境体检（诊断页 ENVIRONMENT 面板；报告加载后会自动跑一次体检）
await scene(browser, "env-check.png", { theme: "ncpd" }, async (p) => {
  await go(p, "diagnostics");
  await p.locator(".env-level").first().waitFor({ timeout: 12000 });
  await p.waitForTimeout(500);
  return shotClip(p, "section.panel:has(.env-level)", "env-check.png", 6);
});

// 缺失前置：?frameworks=missing 让 frameworkList() 把所有框架报成未安装，
// 依赖检查面板才会出现红色缺失芯片（否则演示数据里一切正常）
await scene(browser, "missing-prereq.png", { theme: "ncpd" }, async (p) => {
  await p.goto(`${BASE}?frameworks=missing`, { waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  await go(p, "diagnostics");
  await p.locator("#cdl-deps-panel .deps-chip.is-missing").first().waitFor({ timeout: 12000 });
  await p.waitForTimeout(300);
  return shotClip(p, "#cdl-deps-panel", "missing-prereq.png", 6);
});

// Mod 设置：详情抽屉里的「专属配置」。演示数据只给 Better Vehicle Handling
// 与 Radio Extender 配了配置来源，选前者（Mod Settings 的 user.ini）
await scene(browser, "mod-settings.png", { theme: "ncpd" }, async (p) => {
  await p.locator(".mod-card").filter({ hasText: "Better Vehicle Handling" }).first().click({ timeout: 6000 });
  await p.locator(".mod-config").first().waitFor({ timeout: 12000 });
  await p.waitForTimeout(500);
  await p.locator(".mod-config").first().scrollIntoViewIfNeeded({ timeout: 6000 });
  await p.waitForTimeout(300);
  return shotClip(p, ".drawer", "mod-settings.png", 0);
});

// 防误触：设置页「游戏与路径」分区里的「清除」会弹长按确认框
await scene(browser, "danger-hold.png", { theme: "ncpd" }, async (p) => {
  await go(p, "settings");
  // 默认停在「个性化」，清除按钮在「游戏与路径」下，必须先切分区
  await tabTo(p, "game");
  const clear = p.locator("button.danger-text").filter({ hasText: /清除/ }).first();
  await clear.click({ timeout: 6000 });
  await p.locator(".danger-hold").first().waitFor({ timeout: 6000 });
  await p.waitForTimeout(400);
  return shotClip(p, ".modal", "danger-hold.png", 10);
});

// 导入确认：真跑一遍导入，结果清单里带分类建议与冲突提示
await scene(browser, "import-review.png", { theme: "ncpd" }, async (p) => {
  await runImport(p, ["BetterVehicleHandling-0.9.4.zip", "NeonRain-ReShade-1.8.1.zip"]);
  await waitImportDone(p);
  return shotClip(p, ".modal", "import-review.png", 10);
});

// 任务队列：同一次导入会留下任务行，关掉弹窗后右下角浮层里能看到
await scene(browser, "task-center.png", { theme: "ncpd" }, async (p) => {
  await runImport(p, ["Hardcore2077-0.7.1.zip", "DogtownVibes-1.0.3.zip"]);
  await waitImportDone(p);
  await p.locator(".modal-foot .btn-ghost").first().click({ timeout: 6000 });
  await p.locator(".task-center").first().waitFor({ timeout: 8000 });
  await p.waitForTimeout(500);
  return shotClip(p, ".task-center", "task-center.png", 0);
});

// 关键错误提取：日志 mock 里 redscript.log 有一条 [ERROR]，「提取错误」才有内容
await scene(browser, "log-extract.png", { theme: "ncpd" }, async (p) => {
  await go(p, "diagnostics");
  await p.locator("button").filter({ hasText: "查看日志" }).first().click({ timeout: 8000 });
  await p
    .locator(".log-file-row")
    .filter({ hasText: "redscript.log" })
    .first()
    .click({ timeout: 8000 });
  await p.waitForTimeout(700);
  await p
    .locator(".log-viewer-filters button")
    .filter({ hasText: /提取错误/ })
    .first()
    .click({ timeout: 6000 });
  await p.waitForTimeout(500);
  return shotClip(p, ".modal", "log-extract.png", 10);
});

await browser.close();

console.log(`\n完成 ${done.length} 张，失败 ${failed.length} 张`);
if (failed.length) for (const f of failed) console.log(" - " + f);
console.log(`输出目录: ${OUT}`);
