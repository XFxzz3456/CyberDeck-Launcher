// 模组库工具栏重构验收（2026-11-01）：两组分家 + 合并 AI 入口 + 窄屏收纳不换行。
//
// 断言七件事：
//   1) 工具栏只有两个 .toolbar-group（视图组 / 动作组）；
//   2) 组内 gap=8、组间 gap=24（间距差就是分组信号）；
//   3) 视图切换在「视图组」里，多选在「动作组」里（逻辑归属正确）；
//   4) AI 工具下拉含三项：翻译列表名称 / 汉化选中 / 汉化全部；
//   5) 宽屏（1440）不显示「更多」，低频按钮直显；
//   6) 窄屏（1100）低频按钮隐藏、「更多」出现，且工具栏高度不变（**不换行**）；
//   7) 窄屏下工具栏 scrollWidth 不超过 clientWidth（真的没溢出）。

import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const results = [];
function check(name, ok, detail = "", key = "") {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}${key ? ` ${key}=${ok ? 1 : 0}` : ""}`,
  );
}

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));

await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  if (!localStorage.getItem("ncl.ui.preferences.v1")) {
    localStorage.setItem(
      "ncl.ui.preferences.v1",
      JSON.stringify({
        theme: "ncpd",
        useCustomAccent: false,
        accent: "#ff4058",
        scale: 1,
        sidebarCollapsed: false,
        animations: false,
        splash: false,
      }),
    );
  }
});

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1300);

const groups = await page.locator(".library-toolbar .toolbar-group").count();
check("工具栏只有两个分组", groups === 2, `groups=${groups}`, "groupCount");

const gaps = await page.locator(".library-toolbar").evaluate((bar) => {
  const g = [...bar.querySelectorAll(".toolbar-group")];
  return {
    between: getComputedStyle(bar).columnGap,
    inner: g.length ? getComputedStyle(g[0]).columnGap : "",
  };
});
check("组间间距 24px", gaps.between === "24px", `gap=${gaps.between}`, "gapBetween");
check("组内间距 8px", gaps.inner === "8px", `gap=${gaps.inner}`, "gapInner");

const viewHasSwitch = await page.locator(".toolbar-group--view .view-switch").count();
const viewHasFilter = await page.locator(".toolbar-group--view .sort-control").count();
check("视图组含筛选/排序/视图切换", viewHasSwitch === 1 && viewHasFilter >= 2, `switch=${viewHasSwitch} filters=${viewHasFilter}`, "viewGroup");

const actionHasSelect = await page.locator(".toolbar-group--actions button", { hasText: "多选" }).count();
check("动作组含多选", actionHasSelect >= 1, `count=${actionHasSelect}`, "actionGroup");

// AI 工具下拉
const aiBtn = page.locator(".toolbar-group--actions .toolbar-menu button", { hasText: "AI 工具" }).first();
check("有「AI 工具」下拉", (await aiBtn.count()) >= 1, "", "aiToolsBtn");
await aiBtn.click();
await page.waitForTimeout(400);
const items = await page.locator(".toolbar-menu-panel [role=menuitem]").allInnerTexts();
check(
  "AI 工具含三项（翻译名称/汉化选中/汉化全部）",
  items.some((t) => t.includes("翻译列表名称")) &&
    items.some((t) => t.includes("汉化选中")) &&
    items.some((t) => t.includes("汉化全部")),
  `items=${items.join(" | ").slice(0, 60)}`,
  "aiToolsItems",
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// 宽屏：低频直显、没有「更多」
const wide = await page.evaluate(() => {
  const bar = document.querySelector(".library-toolbar");
  const lowFreq = [...bar.querySelectorAll(".is-low-frequency")];
  const overflow = bar.querySelector(".toolbar-overflow");
  return {
    height: bar.getBoundingClientRect().height,
    lowFreqVisible: lowFreq.filter((n) => getComputedStyle(n).display !== "none").length,
    overflowVisible: overflow ? getComputedStyle(overflow).display !== "none" : false,
  };
});
check("宽屏低频按钮直显", wide.lowFreqVisible >= 2 && !wide.overflowVisible, `visible=${wide.lowFreqVisible} overflow=${wide.overflowVisible}`, "wideLowFreq");

// 窄屏：收进「更多」，高度不变
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(700);
const narrow = await page.evaluate(() => {
  const bar = document.querySelector(".library-toolbar");
  const lowFreq = [...bar.querySelectorAll(".is-low-frequency")];
  const overflow = bar.querySelector(".toolbar-overflow");
  return {
    height: bar.getBoundingClientRect().height,
    lowFreqVisible: lowFreq.filter((n) => getComputedStyle(n).display !== "none").length,
    overflowVisible: overflow ? getComputedStyle(overflow).display !== "none" : false,
    overflowX: bar.scrollWidth - bar.clientWidth,
  };
});
check("窄屏低频按钮收起", narrow.lowFreqVisible === 0, `visible=${narrow.lowFreqVisible}`, "narrowLowFreq");
check("窄屏出现「更多」", narrow.overflowVisible, `overflow=${narrow.overflowVisible}`, "narrowOverflow");
check(
  "窄屏工具栏高度不变（不换行）",
  Math.abs(narrow.height - wide.height) < 2,
  `wide=${Math.round(wide.height)} narrow=${Math.round(narrow.height)}`,
  "noWrap",
);
check("窄屏无横向溢出", narrow.overflowX <= 1, `overflowX=${narrow.overflowX}`, "noOverflow");

// 「更多」里能点到低频动作
const moreBtn = page.locator(".toolbar-overflow > button").first();
await moreBtn.click();
await page.waitForTimeout(400);
const moreItems = await page.locator(".toolbar-overflow .toolbar-menu-panel [role=menuitem]").allInnerTexts();
check(
  "「更多」里含补全信息与导入",
  moreItems.some((t) => t.includes("补全")) && moreItems.some((t) => t.includes("导入")),
  `items=${moreItems.join(" | ").slice(0, 50)}`,
  "moreItems",
);

check("pageerrors=0", pageErrors.length === 0, pageErrors.slice(0, 2).join("；"), "pageErrors");

const failed = results.filter((r) => !r.ok).length;
console.log(`checks_failed=${failed}`);
await browser.close();
