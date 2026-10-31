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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const metrics = await page.evaluate(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, scrollH: node.scrollHeight };
  };
  return {
    viewport: { w: innerWidth, h: innerHeight },
    content: box(".content"),
    page: box(".library-page"),
    layout: box(".library-layout"),
    grid: box(".grid-scroll"),
    row: box(".virtual-row"),
    card: box(".mod-card"),
    category: box(".category-rail"),
    count: document.querySelectorAll(".mod-card").length,
  };
});
console.log(JSON.stringify(metrics, null, 2));

await page.screenshot({ path: path.join(shots, "library-2.png") });

const views = [
  ["loadorder", "加载顺序"],
  ["diagnostics", "运行诊断"],
  ["settings", "设置"],
];
for (const [id, label] of views) {
  await page.getByRole("button", { name: new RegExp(label) }).first().click();
  await page.waitForTimeout(id === "diagnostics" ? 1100 : 500);
  await page.screenshot({ path: path.join(shots, `${id}.png`) });
  console.log(`shot ${id}`);
}

await page.getByRole("button", { name: /模组库/ }).first().click();
await page.waitForTimeout(300);
await page.locator(".mod-card").first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shots, "drawer.png") });

console.log("ERRORS", errors);
await browser.close();
