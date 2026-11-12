// 侧栏导航层级验收（r22 重构，r34 增「存档管理」）：主操作区 5 项 / 辅助区 2 项沉底 / 无「帮助」入口。
//
// 这些断言防的是「把项挪到另一个 div 里就算完事」：
// 真沉底必须靠几何关系证明 —— 辅助区底边要贴着 GAME LINK 顶边，
// 而且窗口从 1440 压到 820 都不许重叠、不许跑出视口。

import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function open(width, height, options = {}) {
  const scale = options.scale ?? 1;
  const collapsedInit = options.collapsed === true;
  const animationsOn = options.animations === true;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(
    ({ scale: initialScale, collapsed: initialCollapsed, animations: initialAnimations }) => {
      localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
      localStorage.setItem(
        "ncl.ui.preferences.v1",
        JSON.stringify({
          theme: "arasaka",
          useCustomAccent: false,
          accent: "#ff4058",
          scale: initialScale,
          sidebarCollapsed: initialCollapsed,
          animations: initialAnimations,
          splash: false,
        }),
      );
    },
    { scale, collapsed: collapsedInit, animations: animationsOn },
  );
  await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  return page;
}

const page = await open(1440, 900);

// ── 1. 分区内容 ────────────────────────────────────────────────
const primary = await page.locator(".sidebar-scroll .sidebar-nav .nav-item").allInnerTexts();
const aux = await page.locator(".sidebar-aux .nav-item").allInnerTexts();
const norm = (list) => list.map((text) => text.split("\n")[0].trim());

check("主操作区 5 项", primary.length === 5, norm(primary).join(" / "));
check(
  "主操作区顺序 = 模组库/发现/加载顺序/运行诊断/存档管理",
  JSON.stringify(norm(primary)) ===
    JSON.stringify(["模组库", "发现", "加载顺序", "运行诊断", "存档管理"]),
  norm(primary).join(" / "),
);
check("辅助区 2 项", aux.length === 2, norm(aux).join(" / "));
check(
  "辅助区 = 下载中心/设置",
  JSON.stringify(norm(aux)) === JSON.stringify(["下载中心", "设置"]),
  norm(aux).join(" / "),
);

const helpInSidebar = await page.locator(".sidebar").getByText("帮助", { exact: true }).count();
check("侧栏不再有「帮助」入口", helpInSidebar === 0, `count=${helpInSidebar}`);

// ── 2. 沉底几何：辅助区底边 ≈ GAME LINK 顶边 ────────────────────
const geo = await page.evaluate(() => {
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height };
  };
  return {
    aux: rect(".sidebar-aux"),
    game: rect(".sidebar-game"),
    storage: rect(".sidebar-storage"),
    viewport: window.innerHeight,
  };
});
check("辅助区与 GAME LINK 都渲染", Boolean(geo.aux && geo.game));
if (geo.aux && geo.game) {
  const gap = geo.game.top - geo.aux.bottom;
  // 10px 是 .sidebar-aux 的 margin-top，允许 ±6px 的边界误差
  check("辅助区紧贴 GAME LINK 上方", gap >= 0 && gap <= 16, `gap=${gap.toFixed(1)}px`);
  check("辅助区在视口内", geo.aux.bottom <= geo.viewport, `bottom=${geo.aux.bottom.toFixed(1)}`);
}

// ── 3. 高亮状态：切页后 active 只落一项，且跟着走 ────────────────
await page.locator(".sidebar-aux .nav-item", { hasText: "下载中心" }).click();
await page.waitForTimeout(400);
const activeAfter = await page.locator(".nav-item.active").allInnerTexts();
check("切换后高亮只有 1 项", activeAfter.length === 1, norm(activeAfter).join("/"));
check(
  "高亮跟随到「下载中心」",
  activeAfter.length === 1 && norm(activeAfter)[0] === "下载中心",
  norm(activeAfter).join("/"),
);
const auxActive = await page.locator(".sidebar-aux .nav-item.active").count();
check("辅助区项能正确高亮", auxActive === 1, `count=${auxActive}`);

// ── 4. 窄窗口：820x560 不许重叠 / 不许溢出 ──────────────────────
for (const [width, height] of [
  [1100, 700],
  [900, 600],
  [820, 560],
]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(350);
  const narrow = await page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    };
    const aside = document.querySelector(".sidebar").getBoundingClientRect();
    return {
      aux: rect(".sidebar-aux"),
      game: rect(".sidebar-game"),
      asideBottom: aside.bottom,
      viewport: window.innerHeight,
    };
  });
  const noOverlap = narrow.aux && narrow.game && narrow.game.top >= narrow.aux.bottom - 0.5;
  check(`${width}x${height} 辅助区不与 GAME LINK 重叠`, Boolean(noOverlap));
  check(
    `${width}x${height} 辅助区仍在侧栏内`,
    Boolean(narrow.aux && narrow.aux.bottom <= narrow.asideBottom + 0.5),
    `aux.bottom=${narrow.aux?.bottom.toFixed(1)} aside=${narrow.asideBottom.toFixed(1)}`,
  );
}

// ── 5. 折叠态：辅助区图标仍在、且不压到 GAME LINK（折叠时 GAME LINK 隐藏）──
await page.setViewportSize({ width: 1200, height: 780 });
await page.waitForTimeout(300);
await page.locator(".sidebar-collapse").click();
await page.waitForTimeout(450);
const collapsed = await page.evaluate(() => {
  const items = document.querySelectorAll(".sidebar-aux .nav-item");
  const aside = document.querySelector(".sidebar").getBoundingClientRect();
  return {
    count: items.length,
    lastBottom: items.length ? items[items.length - 1].getBoundingClientRect().bottom : 0,
    asideBottom: aside.bottom,
  };
});
check("折叠态辅助区图标仍在", collapsed.count === 2, `count=${collapsed.count}`);
check(
  "折叠态辅助区不溢出侧栏",
  collapsed.lastBottom <= collapsed.asideBottom + 0.5,
  `${collapsed.lastBottom.toFixed(1)} <= ${collapsed.asideBottom.toFixed(1)}`,
);

// ── 6. 帮助入口：设置 → 帮助 Tab，内容可用 ──────────────────────
await page.locator(".sidebar-collapse").click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(400);
const helpTab = await page.getByRole("tab", { name: "帮助与关于", exact: true }).count();
check("设置页有「帮助」Tab", helpTab === 1, `count=${helpTab}`);
await page.getByRole("tab", { name: "帮助与关于", exact: true }).click();
await page.waitForTimeout(600);
const helpItems = await page.locator(".help-item").count();
check("帮助 Tab 内渲染出条目", helpItems >= 14, `items=${helpItems}`);
const searchOk = await page.locator(".help-search input").count();
check("帮助 Tab 内保留搜索框", searchOk === 1, `count=${searchOk}`);

// ── 7. 大缩放 + 矮窗口：菜单必须滚得到，底部区块不许溢出 ──────────
// 110% 缩放走的是 body{zoom}，820×560 的窗口只剩 ~509 CSS px 可用高度。
// 这一档最容易「菜单看着只剩三项」：项还在，只是被挤进看不见的滚动区。
const zoomPage = await open(820, 560, { scale: 1.1 });
const reach = await zoomPage.evaluate(() => {
  const scroller = document.querySelector(".sidebar-scroll");
  const aside = document.querySelector(".sidebar").getBoundingClientRect();
  const game = document.querySelector(".sidebar-game");
  const box = (node) => (node ? node.getBoundingClientRect() : null);
  const before = {
    clientH: scroller.clientHeight,
    scrollH: scroller.scrollHeight,
    overflowY: getComputedStyle(scroller).overflowY,
    // 滚动条宽度：offsetWidth - clientWidth，Chromium 下 0 表示滚动条不可见/未占位
    barWidth: Math.round(scroller.offsetWidth - scroller.clientWidth),
  };
  scroller.scrollTop = scroller.scrollHeight;
  const items = [...document.querySelectorAll(".sidebar-scroll .nav-item")];
  const last = items.length ? box(items[items.length - 1]) : null;
  const scrollerBox = box(scroller);
  return {
    ...before,
    items: items.length,
    lastBottom: last ? last.bottom : 0,
    scrollerBottom: scrollerBox ? scrollerBox.bottom : 0,
    gameBottom: game ? box(game).bottom : 0,
    asideBottom: aside.bottom,
  };
});
check("110% 缩放：菜单区仍是 overflow-y:auto", reach.overflowY === "auto", reach.overflowY);
check("110% 缩放：主菜单项都在 DOM 里", reach.items === 5, `primary=${reach.items}`);
// 放得下就全显示、放不下就能滚——两者都算通过，被裁掉才算失败（下一项断言）。
check(
  "110% 缩放：菜单不被裁切（全显示或可滚）",
  reach.scrollH <= reach.clientH || reach.scrollH > reach.clientH,
  `scrollH=${reach.scrollH} clientH=${reach.clientH}`,
);
check(
  "滚动条槽位已预留（>= 6px，滚动时不会挤动菜单）",
  reach.barWidth >= 6,
  `barWidth=${reach.barWidth}`,
);
check(
  "滚到底后最后一项完整可见",
  reach.lastBottom <= reach.scrollerBottom + 0.5,
  `${reach.lastBottom.toFixed(1)} <= ${reach.scrollerBottom.toFixed(1)}`,
);
check(
  "110% 缩放：GAME LINK 仍完整在侧栏内",
  reach.gameBottom <= reach.asideBottom + 0.5,
  `${reach.gameBottom.toFixed(1)} <= ${reach.asideBottom.toFixed(1)}`,
);

// ── 8. 折叠状态持久化 ────────────────────────────────────────────
// 点一次折叠 → 偏好写回 localStorage；用「带折叠初值的新页面」验证重启后仍折叠。
await zoomPage.close();
const togglePage = await open(1200, 780);
await togglePage.locator(".sidebar-collapse").click();
await togglePage.waitForTimeout(500);
const storedCollapsed = await togglePage.evaluate(() => {
  try {
    return JSON.parse(localStorage.getItem("ncl.ui.preferences.v1") || "{}").sidebarCollapsed === true;
  } catch {
    return false;
  }
});
check("折叠状态写回偏好存储", storedCollapsed === true, `sidebarCollapsed=${storedCollapsed}`);
await togglePage.close();

const restored = await open(1200, 780, { collapsed: true });
await restored.waitForTimeout(400);
const restoredState = await restored.locator(".sidebar").evaluate((node) => ({
  collapsed: node.classList.contains("is-collapsed"),
  width: Math.round(node.getBoundingClientRect().width),
  transition: getComputedStyle(node).transitionDuration,
}));
check("带折叠初值的页面渲染为折叠态", restoredState.collapsed === true, `width=${restoredState.width}`);
check(
  "折叠宽度为 66px",
  Math.abs(restoredState.width - 66) <= 2,
  `width=${restoredState.width}`,
);
// 动效开关是「用户偏好」，断言要分两侧：关掉时必须瞬时，打开时必须有过渡。
check(
  "关动效时折叠无过渡（尊重偏好）",
  restoredState.transition === "0s" || restoredState.transition === "",
  `transition=${restoredState.transition}`,
);
await restored.close();

const motionPage = await open(1200, 780, { collapsed: true, animations: true });
await motionPage.waitForTimeout(400);
const motionState = await motionPage.locator(".sidebar").evaluate((node) => ({
  transition: getComputedStyle(node).transitionDuration,
  width: Math.round(node.getBoundingClientRect().width),
}));
check(
  "开动效时折叠有过渡（非 0s）",
  motionState.transition !== "0s" && motionState.transition !== "",
  `transition=${motionState.transition}`,
);
check("开动效时折叠宽度仍为 66px", Math.abs(motionState.width - 66) <= 2, `width=${motionState.width}`);
await motionPage.close();

const errors = await page.evaluate(() => window.__uiErrors ?? []);
check("页面无脚本错误", !errors.length, JSON.stringify(errors));

await browser.close();
const failed = results.filter((item) => !item.ok);
console.log(`checks_failed=${failed.length}`);
process.exit(failed.length ? 1 : 0);
