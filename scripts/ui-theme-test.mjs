import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = path.resolve(import.meta.dirname, "..");
const shots = path.join(root, "shots");
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  if (!sessionStorage.getItem("theme-test-init")) {
    localStorage.clear();
    localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
    sessionStorage.setItem("theme-test-init", "1");
  }
});
const page = await context.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("favicon")) errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

const check = (label, condition) => {
  if (!condition) {
    errors.push(`CHECK FAILED: ${label}`);
    console.log(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

const viewportFits = async () =>
  page.evaluate(() => {
    const body = document.body;
    return (
      document.documentElement.scrollWidth <= window.innerWidth + 1 &&
      body.scrollWidth <= Math.ceil(window.innerWidth / Number(getComputedStyle(body).zoom || 1)) + 1
    );
  });

const openSettings = async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForTimeout(300);
};

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

check("default theme is NCPD", (await page.evaluate(() => document.documentElement.dataset.theme)) === "ncpd");
check("cards use the larger title size", (await page.locator(".mod-card h3").first().evaluate((el) => getComputedStyle(el).fontSize)) === "15px");
check("body uses Inter", (await page.evaluate(() => getComputedStyle(document.body).fontFamily)).includes("Inter"));
await page.screenshot({ path: path.join(shots, "ui-060-library.png") });

await openSettings();
check("appearance panel rendered", await page.locator(".appearance-card").first().isVisible());
check("two style families rendered", (await page.locator(".family-card").count()) === 2);
check("four cyber presets rendered", (await page.locator(".preset-chip").count()) === 4);

// 大类切换：现代风收起赛博预设，切回来要回到上次用的那套，而不是重置成 NCPD。
await page.getByRole("button", { name: /现代风/ }).click();
await page.waitForTimeout(280);
check(
  "modern family applies",
  (await page.evaluate(() => document.documentElement.dataset.theme)) === "modern",
);
check("modern hides cyber presets", (await page.locator(".preset-chip").count()) === 0);
await page.getByRole("button", { name: /赛博风/ }).click();
await page.waitForTimeout(280);
check(
  "cyber family restores the last preset",
  (await page.evaluate(() => document.documentElement.dataset.theme)) === "ncpd",
);
check("cyber presets come back", (await page.locator(".preset-chip").count()) === 4);
await page.screenshot({ path: path.join(shots, "ui-060-settings.png") });

await page.locator('[data-preset="netrunner"]').click();
await page.waitForTimeout(250);
check(
  "Netrunner palette applies",
  (await page.evaluate(() => document.documentElement.dataset.theme)) === "netrunner",
);
check(
  "accent token follows the palette",
  (await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  )) === "#3df2ff",
);
await page.screenshot({ path: path.join(shots, "ui-060-netrunner-settings.png") });

await page.locator('.palette-field[data-slot="accent"] input').evaluate((element) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(element, "#ff2e88");
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(300);
check(
  "custom accent applies to the root token",
  (await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  )) === "#ff2e88",
);
check("custom accent is marked as custom", await page.locator(".appearance-badge").innerText().then((text) => text.includes("CUSTOM")));
await page.screenshot({ path: path.join(shots, "ui-060-custom-accent.png") });

await page.getByRole("button", { name: "还原强调色" }).click();
await page.waitForTimeout(200);
check(
  "theme accent can be restored",
  (await page.evaluate(() => document.documentElement.dataset.theme)) === "netrunner" &&
    (await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    )) === "#3df2ff",
);

// ── 自定义调色（背景 / 卡片 / 文字）──────────────────────────────────
// 三个槽位必须实时写进根变量、并且刷新后仍在（localStorage ncl.ui.palette.v1）。
const setSlotColor = async (slot, hex) => {
  await page.locator(`.palette-field[data-slot="${slot}"] input`).evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, hex);
  await page.waitForTimeout(240);
};
const rootToken = (name) =>
  page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name);

await setSlotColor("background", "#101820");
check("custom background reaches --bg", (await rootToken("--bg")) === "#101820");
await setSlotColor("surface", "#18222c");
check("custom surface reaches --panel-2", (await rootToken("--panel-2")) === "#18222c");
await setSlotColor("text", "#f2f4f6");
check("custom text reaches --text", (await rootToken("--text")) === "#f2f4f6");
check("custom palette has no contrast warning", !(await page.locator(".appearance-hint.is-warn").isVisible()));
await page.screenshot({ path: path.join(shots, "ui-060-custom-palette.png") });

// 白字白底：必须给出对比度告警，而不是默默让用户读不清。
await setSlotColor("text", "#141a21");
await page.waitForTimeout(750);
check("low contrast raises a warning", await page.locator(".appearance-hint.is-warn").isVisible());

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(650);
check("custom palette survives reload", (await rootToken("--bg")) === "#101820" && (await rootToken("--text")) === "#141a21");

await openSettings();
await page.getByRole("button", { name: "全部还原" }).click();
await page.waitForTimeout(250);
check("reset clears every override", (await rootToken("--bg")) !== "#101820" && (await rootToken("--text")) !== "#141a21");

// 2026-10-31：缩放从滑块改成分段按钮组（90/100/110/120 + 自定义），这里点 110%。
await page.getByRole("button", { name: "110%", exact: true }).click();
await page.waitForTimeout(400);
check("UI scale reaches 110%", (await page.evaluate(() => getComputedStyle(document.body).zoom)) === "1.1");
check("app shell fills the viewport at 110%", await page.evaluate(() => {
  const shell = document.querySelector(".app-shell").getBoundingClientRect();
  return Math.abs(shell.height - window.innerHeight) <= 1;
}));
check("no horizontal overflow at 110%", await viewportFits());
await page.screenshot({ path: path.join(shots, "ui-060-scale110-settings.png") });

await page.getByRole("button", { name: "收起侧边栏" }).click();
await page.waitForTimeout(350);
check("sidebar collapses to icons", await page.locator(".sidebar").evaluate((element) => element.classList.contains("is-collapsed")));
check("collapsed sidebar is narrow", (await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().width)) < 90);
await page.screenshot({ path: path.join(shots, "ui-060-collapsed.png") });

await page.getByRole("button", { name: "模组库", exact: true }).click();
await page.waitForTimeout(450);
check("library has no horizontal overflow", await viewportFits());
check("conflict counter remains visible", await page.locator(".conflict-stat").isVisible());
check("launch button remains in viewport", await page.getByRole("button", { name: /开始游戏/ }).isVisible());
await page.screenshot({ path: path.join(shots, "ui-060-scale110-library.png") });

// Persist theme, scale and sidebar across a full reload.
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
check(
  "Netrunner survives reload",
  (await page.evaluate(() => document.documentElement.dataset.theme)) === "netrunner",
);
check("110% survives reload", (await page.evaluate(() => getComputedStyle(document.body).zoom)) === "1.1");
check(
  "collapsed sidebar survives reload",
  await page.locator(".sidebar").evaluate((element) => element.classList.contains("is-collapsed")),
);
check("no horizontal overflow after reload", await viewportFits());

// 90% is the small-screen mode, including the native 1120 CSS-width window.
await openSettings();
await page.getByRole("button", { name: "90%", exact: true }).click();
await page.waitForTimeout(350);
check("UI scale reaches 90%", (await page.evaluate(() => getComputedStyle(document.body).zoom)) === "0.9");
check("app shell fills the viewport at 90%", await page.evaluate(() => {
  const shell = document.querySelector(".app-shell").getBoundingClientRect();
  return Math.abs(shell.height - window.innerHeight) <= 1;
}));

await page.setViewportSize({ width: 1120, height: 720 });
await page.waitForTimeout(450);
check("no horizontal overflow at 1120 / 90%", await viewportFits());
check("settings remains reachable at 1120 / 90%", await page.locator(".appearance-card").first().isVisible());
await page.screenshot({ path: path.join(shots, "ui-060-1120-scale90.png") });

check("no console errors", errors.length === 0);
if (errors.length) console.log("ERRORS", errors);
await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
