// 毛玻璃补齐验收（用户反馈：顶栏 / Tabs / 设置卡片像实心黑块）。
//
// 只测「开了自定义背景图」这一支：读计算样式，确认
//   1) 顶栏是半透明 + 有 blur + 底部有极淡边框；
//   2) Tabs 条半透明 + blur；
//   3) 设置卡片半透明 + blur + 高光描边；
//   4) 设置页主容器不再叠一层 blur（避免嵌套毛玻璃）；
//   5) 关掉背景图后这些毛玻璃一律消失（默认态保持实心，不乱）。

import { chromium } from "playwright-core";

const KEY = "cyberdeck-launcher-demo-state-v1";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const results = [];
function check(name, ok, detail = "", key = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}${key ? ` ${key}=${ok ? 1 : 0}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((key) => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  if (!localStorage.getItem("ncl.ui.preferences.v1")) {
    localStorage.setItem(
      "ncl.ui.preferences.v1",
      JSON.stringify({
        theme: "arasaka",
        useCustomAccent: false,
        accent: "#ff4058",
        scale: 1,
        sidebarCollapsed: false,
        animations: false,
        splash: false,
      }),
    );
  }
}, KEY);

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// 打开背景图（mock 的 settings.backgroundImage 非空即进 [data-backdrop="on"]）
await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) || "null");
  if (db?.state?.settings) {
    db.state.settings.backgroundImage = "C:\\fake\\wallpaper.png";
    db.state.settings.backgroundOpacity = 70;
    db.state.settings.backgroundBlur = 0;
    db.state.settings.backgroundDim = 45;
    localStorage.setItem(key, JSON.stringify(db));
  }
}, KEY);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const shellBackdrop = await page.locator(".app-shell").getAttribute("data-backdrop");
check("进入有背景图状态", shellBackdrop === "on", `data-backdrop=${shellBackdrop}`, "backdropOn");

// ── 1. 顶栏 ────────────────────────────────────────────────────────
const topbar = await page.locator(".topbar").evaluate((node) => {
  const cs = getComputedStyle(node);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter, border: cs.borderBottomColor };
});
const topbarAlpha = Number((topbar.bg.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);
check("顶栏半透明", topbarAlpha > 0 && topbarAlpha < 0.8, `bg=${topbar.bg}`, "topbarAlpha");
check("顶栏有毛玻璃", /blur\((1[2-9]|2\d)px\)/.test(topbar.blur), `blur=${topbar.blur}`, "topbarBlur");
check(
  "顶栏底部有极淡描边",
  /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.0[3-9]/.test(topbar.border),
  `border=${topbar.border}`,
  "topbarBorder",
);

// ── 1b. 侧边栏与主内容区（L1）────────────────────────────────────
const sidebar = await page.locator(".sidebar").evaluate((node) => {
  const cs = getComputedStyle(node);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter };
});
const sidebarAlpha = Number((sidebar.bg.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);
check("侧边栏走 L1 半透明", sidebarAlpha > 0.4 && sidebarAlpha < 0.75, `bg=${sidebar.bg}`, "sidebarAlpha");
check("侧边栏 blur(24)", /blur\(24px\)/.test(sidebar.blur), `blur=${sidebar.blur}`, "sidebarBlur");

// ── 2. 设置页 Tabs ─────────────────────────────────────────────────
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(900);

const tabs = await page.locator(".settings-tabs").evaluate((node) => {
  const cs = getComputedStyle(node);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter };
});
const tabsAlpha = Number((tabs.bg.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);
check("Tabs 条半透明", tabsAlpha > 0 && tabsAlpha < 0.8, `bg=${tabs.bg}`, "tabsAlpha");
check("Tabs 条有毛玻璃", /blur\((1[0-9]|2\d)px\)/.test(tabs.blur), `blur=${tabs.blur}`, "tabsBlur");

const activeTabBg = await page.locator(".settings-tab.active").first().evaluate((n) => getComputedStyle(n).backgroundColor);
const activeAlpha = Number((activeTabBg.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);
check("选中项底色带透明度", activeAlpha > 0 && activeAlpha < 0.5, `bg=${activeTabBg}`, "tabActiveAlpha");

// ── 3. 设置卡片 ────────────────────────────────────────────────────
const card = await page.locator(".settings-tab-panel .panel").first().evaluate((node) => {
  const cs = getComputedStyle(node);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter, border: `${cs.borderTopWidth} ${cs.borderTopColor}` };
});
const cardAlpha = Number((card.bg.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);
// L2 规范：底色要「够实」（0.85），模糊只留极轻的 8px
check("卡片走 L2 实底（0.7–0.9）", cardAlpha > 0.7 && cardAlpha <= 0.9, `bg=${card.bg}`, "cardAlpha");
check("卡片 blur(8) 极轻", /blur\(([4-9]|1[0-5])px\)/.test(card.blur), `blur=${card.blur}`, "cardBlur");
check("卡片有 1px 高光描边", /^1px/.test(card.border), `border=${card.border}`, "cardBorder");

// ── 3b. L3 悬浮层：下拉菜单 ─────────────────────────────────────────
// 悬浮层在「模组库」页更容易触发（工具栏有导入/AI 汉化两个下拉）。
const libraryBtn = page.getByRole("button", { name: "模组库", exact: true }).first();
if ((await libraryBtn.count()) > 0) {
  await libraryBtn.click();
  await page.waitForTimeout(700);
}
// 用「AI 汉化」下拉触发：它在模组库页常驻，菜单结构与其它下拉一致。
const menuTrigger = page.getByRole("button", { name: /^AI 汉化/ }).first();
if ((await menuTrigger.count()) > 0) {
  await menuTrigger.click();
  await page.waitForTimeout(400);
}
const menu = await page.locator(".import-menu").first().evaluate((node) => {
  const cs = getComputedStyle(node);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter, shadow: cs.boxShadow };
}).catch(() => ({ bg: "", blur: "", shadow: "" }));
const menuAlpha = Number((menu.bg.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);
check("下拉菜单走 L3 半透明", menuAlpha > 0.5 && menuAlpha < 0.9, `bg=${menu.bg}`, "menuAlpha");
check("下拉菜单 blur(32)", /blur\(32px\)/.test(menu.blur), `blur=${menu.blur}`, "menuBlur");
check("下拉菜单有大范围阴影", menu.shadow !== "none" && /40px/.test(menu.shadow), `shadow=${menu.shadow.slice(0, 40)}`, "menuShadow");
await page.keyboard.press("Escape");
// 回到设置页，后面的「主容器不叠 blur」断言要在设置页上量。
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(800);

// ── 4. 不叠嵌套毛玻璃 ──────────────────────────────────────────────
const contentBlur = await page.locator(".content").first().evaluate((n) => getComputedStyle(n).backdropFilter);
check("设置页主容器不再叠 blur", contentBlur === "none", `content.blur=${contentBlur}`, "noNestedBlur");
const pageAttr = await page.locator(".app-shell").getAttribute("data-page");
check("设置页有 data-page 标记", pageAttr === "settings", `data-page=${pageAttr}`, "pageAttr");

// ── 5. 关掉背景图后回落实心 ────────────────────────────────────────
await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) || "null");
  if (db?.state?.settings) {
    db.state.settings.backgroundImage = "";
    localStorage.setItem(key, JSON.stringify(db));
  }
}, KEY);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(800);

const offTopbar = await page.locator(".topbar").evaluate((n) => getComputedStyle(n).backgroundColor);
const offCard = await page.locator(".settings-tab-panel .panel").first().evaluate((n) => getComputedStyle(n).backgroundColor);
const offAlpha = Number((offTopbar.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);
check("无背景时顶栏回到不透明档", offAlpha >= 0.7, `bg=${offTopbar}`, "offTopbarSolid");
// 无背景图 + 赛博主题 ⇒ data-glass 必须是 off，且退回纯黑实体
const glassAttr = await page.locator(".app-shell").getAttribute("data-glass");
check("赛博主题无背景时 glass 关闭", glassAttr === "off", `data-glass=${glassAttr}`, "glassOff");

const offCardFull = await page.locator(".settings-tab-panel .panel").first().evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter };
});
const opaque = /^rgb\(/.test(offCardFull.bg) || /rgba\([^)]*,\s*1\)$/.test(offCardFull.bg);
check("卡片完全不透明（非 rgba 半透）", opaque, `bg=${offCardFull.bg}`, "offCardOpaque");
check("卡片无任何 backdrop-filter", offCardFull.blur === "none", `blur=${offCardFull.blur}`, "offCardNoBlur");

const shell = await page.locator(".app-shell").evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bg: cs.backgroundImage + " | " + cs.backgroundColor };
});
check("主背景没有径向光晕（幽灵灰圈已除）", !/radial-gradient/.test(shell.bg), `bg=${shell.bg.slice(0, 60)}`, "noGhostGlow");

// ── 6. 现代主题：没有背景图也要有玻璃（条件 A）────────────────────
await page.evaluate(() => {
  const key = "ncl.ui.preferences.v1";
  const prefs = JSON.parse(localStorage.getItem(key) || "{}");
  prefs.theme = "modern";
  localStorage.setItem(key, JSON.stringify(prefs));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const modernGlass = await page.locator(".app-shell").getAttribute("data-glass");
check("现代主题无背景时 glass 开启", modernGlass === "on", `data-glass=${modernGlass}`, "modernGlassOn");
const modernTopbar = await page.locator(".topbar").evaluate((n) => getComputedStyle(n).backdropFilter);
check("现代主题顶栏有毛玻璃", /blur\((20|24)px\)/.test(modernTopbar), `blur=${modernTopbar}`, "modernTopbarBlur");

await page.screenshot({ path: "shots/audit/glass-no-background.png" });

const failed = results.filter((r) => !r.ok).length;
console.log(`checks_failed=${failed}`);
await browser.close();
