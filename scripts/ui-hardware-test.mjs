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
  if (!sessionStorage.getItem("hardware-test-init")) {
    localStorage.clear();
    localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
    sessionStorage.setItem("hardware-test-init", "1");
  }
});
const page = await context.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("favicon")) errors.push(msg.text());
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

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

check(
  "mod card uses a polygon chamfer",
  (await page.locator(".mod-card").first().evaluate((el) => getComputedStyle(el).clipPath)).includes("polygon"),
);
check(
  "global grain layer is active",
  (await page.evaluate(() => getComputedStyle(document.body, "::before").backgroundImage)).includes(
    "noise.svg",
  ),
);

await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(450);
check(
  "panel uses a polygon chamfer",
  (await page.locator(".panel").first().evaluate((el) => getComputedStyle(el).clipPath)).includes("polygon"),
);
const selected = page.locator(".family-card.selected");
check(
  "theme cards use a polygon chamfer",
  (await selected.evaluate((el) => getComputedStyle(el).clipPath)).includes("polygon"),
);
check(
  "selected theme draws a corner trace",
  Number(await selected.evaluate((el) => getComputedStyle(el, "::before").opacity)) > 0.8,
);
await page.screenshot({ path: path.join(shots, "hardware-settings.png") });

// Remove the demo game root, reload, and verify the industrial warning strip.
await page.evaluate(() => {
  const key = "cyberdeck-launcher-demo-state-v1";
  const db = JSON.parse(localStorage.getItem(key));
  db.gameDir = null;
  db.state.gameDir = null;
  localStorage.setItem(key, JSON.stringify(db));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(700);
check("unlinked warning strip renders", (await page.locator(".setup-banner").count()) === 1);
check(
  "warning strip uses hazard stripes",
  (await page.locator(".setup-banner").evaluate((el) => getComputedStyle(el).backgroundImage)).includes(
    "repeating-linear-gradient",
  ),
);
check(
  "warning strip text is black",
  (await page.locator(".setup-banner-copy strong").evaluate((el) => getComputedStyle(el).color)) ===
    "rgb(7, 9, 12)",
);
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(400);
check(
  "unlinked game box uses a dashed receiver",
  (await page.locator(".game-dir-box").evaluate((el) => getComputedStyle(el).borderTopStyle)) ===
    "dashed",
);
await page.screenshot({ path: path.join(shots, "hardware-unlinked-settings.png") });

const bannerBox = await page.locator(".setup-banner").boundingBox();
check(
  "warning strip stays inside the 1440 viewport",
  Boolean(bannerBox && bannerBox.x + bannerBox.width <= 1440),
);

await page.setViewportSize({ width: 1120, height: 720 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => ({
  body: document.body.scrollWidth,
  viewport: window.innerWidth,
}));
check("no horizontal overflow with warning strip at 1120", overflow.body <= overflow.viewport);
check("unlinked action remains visible at 1120", await page.getByRole("button", { name: /选择目录/ }).isVisible());

check("no console errors", errors.length === 0);
if (errors.length) console.log("ERRORS", errors);
await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
