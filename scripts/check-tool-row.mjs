// 检查设置页工具行在 1080 宽下是否溢出，并截图。
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

await page.locator(".nav-item").last().click(); // 设置
await page.waitForTimeout(500);
await page.locator("#settings-tab-security").click();
await page.waitForTimeout(500);

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".settings-field-row").forEach((row) => {
    const input = row.querySelector("input");
    if (!input) return;
    out.push({
      overflow: row.scrollWidth - row.clientWidth,
      rowWidth: row.clientWidth,
      inputWidth: input.clientWidth,
      buttons: Array.from(row.querySelectorAll("button")).map((b) => b.textContent?.trim()),
    });
  });
  return out;
});
console.log("工具行:", JSON.stringify(rows));

const pageOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - window.innerWidth,
);
console.log("整页横向溢出:", pageOverflow);

await page.screenshot({ path: "shots/settings-tools.png" });
await browser.close();
