// 临时验证脚本：设置页「游戏与路径 → 启动方式」直启状态卡
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// 侧栏「设置」
await page.locator(".nav-item").last().click();
await page.waitForTimeout(700);
await page.screenshot({ path: "shots/launch-step1-settings.png" });

const tab = page.locator("#settings-tab-game");
if (await tab.count()) {
  await tab.click();
  await page.waitForTimeout(900);
}

const status = page.locator(".launch-status");
await status.first().waitFor({ timeout: 8000 }).catch(() => {});
const statusText = (await status.count()) ? await status.first().innerText() : "MISSING";
const options = await page.locator(".launch-option").count();
await page.screenshot({ path: "shots/launch-bypass-settings.png" });

console.log(`options=${options}`);
console.log(`status=${statusText.replace(/\n/g, " | ")}`);
await browser.close();
