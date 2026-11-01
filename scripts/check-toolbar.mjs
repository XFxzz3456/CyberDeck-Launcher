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
// 多选不能两边都有：tight 档下常驻按钮还在，「更多」里就不该再出现一次
//（用户 2026-11-01 反馈「多选重复了，常驻有个，更多里也有」）。
check(
  "「更多」里不重复列出常驻按钮（多选）",
  !moreItems.some((t) => t.includes("多选")),
  `items=${moreItems.join(" | ").slice(0, 60)}`,
  "noDupSelect",
);
await page.keyboard.press("Escape");

// mini 档（应用最小窗口 1000，内容区 607）多选按钮会收起，此时「更多」里必须补上
await page.setViewportSize({ width: 1000, height: 900 });


/* 回归：任意宽度下控件互不重叠（用户 2026-11-01 反馈「列表和补全按钮重叠」，175% 缩放触发）。
 *
 * 根因是 .toolbar-group 可收缩（flex:0 1 auto + min-width:0），容器一紧盒子就小于内容，
 * 里面的按钮溢出盒子压到另一组上。现在分组盒子与按钮都 flex:0 0 auto，
 * 只靠 data-density 降档腾空间，所以这里断言的是：
 *   ① 相邻控件矩形零重叠；② 每个分组盒子不小于自己的内容宽（没溢出）；③ 工具栏本身不溢出。
 * 覆盖 1000（应用最小窗口，内容区仅 607px）到 1440。 */
const layout = [];
for (const width of [1440, 1280, 1100, 1000]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(550);
  layout.push(
    await page.evaluate(() => {
      const bar = document.querySelector(".library-toolbar");
      const groups = [...bar.querySelectorAll(".toolbar-group")];
      const kids = [...bar.querySelectorAll(".toolbar-group > *")]
        .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0)
        .map((n) => n.getBoundingClientRect())
        .sort((a, b) => a.x - b.x);
      let overlaps = 0;
      for (let i = 1; i < kids.length; i += 1) {
        if (kids[i].x < kids[i - 1].x + kids[i - 1].width - 1) overlaps += 1;
      }
      return {
        width: bar.clientWidth,
        density: bar.dataset.density || "",
        overlaps,
        spill: groups.reduce((sum, g) => sum + Math.max(0, g.scrollWidth - g.clientWidth - 1), 0),
        overX: bar.scrollWidth - bar.clientWidth,
        height: Math.round(bar.getBoundingClientRect().height),
      };
    }),
  );
}
const overlapSum = layout.reduce((sum, item) => sum + item.overlaps, 0);
check(
  "四档宽度下控件零重叠",
  overlapSum === 0,
  layout.map((i) => `${i.width}:${i.overlaps}`).join(" "),
  "noOverlap",
);
check(
  "分组盒子不溢出内容（按钮不会压到隔壁组）",
  layout.every((i) => i.spill === 0),
  layout.map((i) => `${i.width}:${i.spill}`).join(" "),
  "noSpill",
);
check(
  "工具栏任何宽度都不横向溢出",
  layout.every((i) => i.overX <= 1),
  layout.map((i) => `${i.width}:${i.overX}`).join(" "),
  "noOverflowAny",
);
check(
  "密度档随宽度自动收紧",
  layout[0].density === "full" && layout[layout.length - 1].density !== "full",
  layout.map((i) => `${i.width}:${i.density}`).join(" "),
  "densityTiers",
);

// mini 档：多选按钮收起后，「更多」里必须出现同名入口，功能不能丢
const miniState = await page.evaluate(() => {
  const bar = document.querySelector(".library-toolbar");
  const selectBtn = [...bar.querySelectorAll(".is-mini-hide")][0];
  return {
    density: bar.dataset.density,
    selectHidden: !selectBtn || getComputedStyle(selectBtn).display === "none",
  };
});
const miniMoreBtn = page.locator(".toolbar-overflow > button").first();
if ((await miniMoreBtn.count()) > 0) {
  await miniMoreBtn.click();
  await page.waitForTimeout(400);
}
const miniItems = await page.locator(".toolbar-overflow .toolbar-menu-panel [role=menuitem]").allInnerTexts();
check(
  "mini 档多选按钮收起",
  miniState.density === "mini" && miniState.selectHidden,
  `density=${miniState.density} hidden=${miniState.selectHidden}`,
  "miniSelectHidden",
);
check(
  "mini 档「更多」里补上多选入口",
  miniItems.some((t) => t.includes("多选")),
  `items=${miniItems.join(" | ").slice(0, 60)}`,
  "miniMoreSelect",
);
await page.keyboard.press("Escape");

check("pageerrors=0", pageErrors.length === 0, pageErrors.slice(0, 2).join("；"), "pageErrors");

const failed = results.filter((r) => !r.ok).length;
console.log(`checks_failed=${failed}`);
await browser.close();
