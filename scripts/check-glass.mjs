// 主题 × 背景 的四象限验收（2026-11-01 定稿规则）。
//
// 规则：玻璃 = 有自定义背景图 **且** 主题不是赛博四套（ncpd/netrunner/arasaka/militech）。
// 赛博主题无论有没有背景图都不吃 backdrop-filter / 半透明 rgba —— 它们的质感来自
// tokens.css 里各自的调色板（NCPD 蓝灰、Arasaka 血褐、Netrunner 冷青、Militech 军绿）。
//
// 四个场景各验一遍：
//   A modern + 有图  → glass=on，L1/L2/L3 全部按令牌生效，设置页主容器不叠模糊
//   B ncpd   + 有图  → glass=off，卡片回 tokens 渐变，没有任何 backdrop-filter
//   C ncpd   + 无图  → glass=off，同上
//   D modern + 无图  → glass=off（定稿：Modern 也要有背景图才玻璃）

import { chromium } from "playwright-core";

const KEY = "cyberdeck-launcher-demo-state-v1";
const PREFS = "ncl.ui.preferences.v1";
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

await page.addInitScript(
  ({ prefsKey }) => {
    localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
    if (!localStorage.getItem(prefsKey)) {
      localStorage.setItem(
        prefsKey,
        JSON.stringify({
          theme: "modern",
          useCustomAccent: false,
          accent: "#ff4058",
          scale: 1,
          sidebarCollapsed: false,
          animations: false,
          splash: false,
        }),
      );
    }
  },
  { prefsKey: PREFS },
);

const alphaOf = (value) => Number((value.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1] ?? 1);

async function setTheme(theme) {
  await page.evaluate(
    ({ prefsKey, next }) => {
      const prefs = JSON.parse(localStorage.getItem(prefsKey) || "{}");
      prefs.theme = next;
      localStorage.setItem(prefsKey, JSON.stringify(prefs));
    },
    { prefsKey: PREFS, next: theme },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
}

async function setBackground(on) {
  await page.evaluate(
    ({ key, enabled }) => {
      const db = JSON.parse(localStorage.getItem(key) || "null");
      if (!db?.state?.settings) return;
      db.state.settings.backgroundImage = enabled ? "C:\\fake\\wallpaper.png" : "";
      db.state.settings.backgroundOpacity = 70;
      db.state.settings.backgroundBlur = 0;
      db.state.settings.backgroundDim = 45;
      localStorage.setItem(key, JSON.stringify(db));
    },
    { key: KEY, enabled: on },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
}

async function openSettings() {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForTimeout(800);
}

// ── A. modern + 有背景图 ⇒ 玻璃 ─────────────────────────────────────
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await setBackground(true);

const glassA = await page.locator(".app-shell").getAttribute("data-glass");
check("A modern+有图：glass=on", glassA === "on", `data-glass=${glassA}`, "A_glassOn");

const topbar = await page.locator(".topbar").evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter, border: cs.borderBottomColor };
});
check("A 顶栏 L1 半透明", alphaOf(topbar.bg) > 0 && alphaOf(topbar.bg) < 0.8, `bg=${topbar.bg}`, "A_topbarAlpha");
check("A 顶栏有毛玻璃（20/24px）", /blur\((20|24)px\)/.test(topbar.blur), `blur=${topbar.blur}`, "A_topbarBlur");
check(
  "A 顶栏底部极淡描边",
  /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.0[3-9]/.test(topbar.border),
  `border=${topbar.border}`,
  "A_topbarBorder",
);

const sidebar = await page.locator(".sidebar").evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter };
});
check("A 侧栏 L1 半透明", alphaOf(sidebar.bg) > 0.4 && alphaOf(sidebar.bg) < 0.75, `bg=${sidebar.bg}`, "A_sidebarAlpha");
check("A 侧栏有毛玻璃（20/24px）", /blur\((20|24)px\)/.test(sidebar.blur), `blur=${sidebar.blur}`, "A_sidebarBlur");

await openSettings();
const tabs = await page.locator(".settings-tabs").evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter };
});
check("A Tabs L1 半透明", alphaOf(tabs.bg) > 0 && alphaOf(tabs.bg) < 0.8, `bg=${tabs.bg}`, "A_tabsAlpha");
check("A Tabs blur(24)", /blur\(24px\)/.test(tabs.blur), `blur=${tabs.blur}`, "A_tabsBlur");

const cardA = await page.locator(".settings-tab-panel .panel").first().evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter, border: `${cs.borderTopWidth} ${cs.borderTopColor}` };
});
check("A 卡片 L2 实底 0.7–0.9", alphaOf(cardA.bg) > 0.7 && alphaOf(cardA.bg) <= 0.9, `bg=${cardA.bg}`, "A_cardAlpha");
check("A 卡片 blur(8)", /blur\(8px\)/.test(cardA.blur), `blur=${cardA.blur}`, "A_cardBlur");
check("A 卡片 1px 高光描边", /^1px/.test(cardA.border), `border=${cardA.border}`, "A_cardBorder");

const contentBlur = await page.locator(".content").first().evaluate((n) => getComputedStyle(n).backdropFilter);
check("A 设置页主容器不叠模糊（无嵌套）", contentBlur === "none", `content=${contentBlur}`, "A_noNested");

// L3：下拉菜单
await page.getByRole("button", { name: "模组库", exact: true }).first().click();
await page.waitForTimeout(700);
const menuTrigger = page.getByRole("button", { name: /^AI 汉化/ }).first();
if ((await menuTrigger.count()) > 0) {
  await menuTrigger.click();
  await page.waitForTimeout(400);
}
const menu = await page
  .locator(".import-menu")
  .first()
  .evaluate((n) => {
    const cs = getComputedStyle(n);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter, shadow: cs.boxShadow };
  })
  .catch(() => ({ bg: "", blur: "", shadow: "" }));
check("A 下拉 L3 半透明", alphaOf(menu.bg) > 0.5 && alphaOf(menu.bg) < 0.9, `bg=${menu.bg}`, "A_menuAlpha");
check("A 下拉 blur(32)", /blur\(32px\)/.test(menu.blur), `blur=${menu.blur}`, "A_menuBlur");
check("A 下拉大范围阴影", /40px/.test(menu.shadow), `shadow=${menu.shadow.slice(0, 40)}`, "A_menuShadow");
await page.keyboard.press("Escape");

// ── B. ncpd + 仍有背景图 ⇒ 赛博不吃玻璃 ────────────────────────────
await setTheme("ncpd");
const glassB = await page.locator(".app-shell").getAttribute("data-glass");
check("B ncpd+有图：glass=off（赛博永不玻璃）", glassB === "off", `data-glass=${glassB}`, "B_glassOff");

await openSettings();
const cardB = await page.locator(".settings-tab-panel .panel").first().evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bgImage: cs.backgroundImage, blur: cs.backdropFilter };
});
check("B 卡片无 backdrop-filter", cardB.blur === "none", `blur=${cardB.blur}`, "B_cardNoBlur");
check(
  "B 卡片回 tokens 渐变（不是单一 rgba）",
  /linear-gradient/.test(cardB.bgImage),
  `bgImage=${cardB.bgImage.slice(0, 48)}`,
  "B_cardTokenGradient",
);

const topbarB = await page.locator(".topbar").evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bg: cs.backgroundColor, blur: cs.backdropFilter };
});
check("B 顶栏无 backdrop-filter", topbarB.blur === "none", `blur=${topbarB.blur}`, "B_topbarNoBlur");
check("B 顶栏实色（NCPD #07090c 0.78）", /rgba\(7, 9, 12, 0\.78\)/.test(topbarB.bg), `bg=${topbarB.bg}`, "B_topbarTokenBg");

// 设置页卡片必须和普通卡片同底色（用户反馈「割裂严重」的回归断言）
const settingsCardBg = await page.locator(".settings-tab-panel .panel").first().evaluate((n) => getComputedStyle(n).backgroundImage);
await page.getByRole("button", { name: "运行诊断", exact: true }).first().click();
await page.waitForTimeout(900);
const normalCardBg = await page.locator(".content .panel").first().evaluate((n) => getComputedStyle(n).backgroundImage);
check(
  "设置卡片与普通卡片同底色",
  settingsCardBg === normalCardBg,
  `settings=${settingsCardBg.slice(0, 40)} | normal=${normalCardBg.slice(0, 40)}`,
  "cardColorConsistent",
);
await openSettings();

const shellB = await page.locator(".app-shell").evaluate((n) => getComputedStyle(n).backgroundImage);
check("B 主背景恢复原设计柔光（radial）", /radial-gradient/.test(shellB), `bg=${shellB.slice(0, 40)}`, "B_shellRadial");

// ── C. ncpd + 无背景图 ⇒ 与 B 一致 ─────────────────────────────────
await setBackground(false);
const glassC = await page.locator(".app-shell").getAttribute("data-glass");
check("C ncpd+无图：glass=off", glassC === "off", `data-glass=${glassC}`, "C_glassOff");
await openSettings();
const cardC = await page.locator(".settings-tab-panel .panel").first().evaluate((n) => {
  const cs = getComputedStyle(n);
  return { bgImage: cs.backgroundImage, blur: cs.backdropFilter };
});
check("C 卡片仍是 tokens 渐变", /linear-gradient/.test(cardC.bgImage), `bgImage=${cardC.bgImage.slice(0, 40)}`, "C_cardToken");
check("C 卡片无 blur", cardC.blur === "none", `blur=${cardC.blur}`, "C_cardNoBlur");

// ── D. modern + 无背景图 ⇒ 方案 A：仍然玻璃 ────────────────────────
await setTheme("modern");
const glassD = await page.locator(".app-shell").getAttribute("data-glass");
check("D modern+无图：glass=on（方案 A）", glassD === "on", `data-glass=${glassD}`, "D_glassOn");
const topbarD = await page.locator(".topbar").evaluate((n) => getComputedStyle(n).backdropFilter);
check("D 顶栏有玻璃层", /blur\((20|24)px\)/.test(topbarD), `blur=${topbarD}`, "D_topbarGlass");

check("pageerrors=0", pageErrors.length === 0, pageErrors.slice(0, 2).join("；"), "pageErrors");

const failed = results.filter((r) => !r.ok).length;
console.log(`checks_failed=${failed}`);
await browser.close();
