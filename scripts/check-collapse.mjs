// 临时验证脚本：诊断页折叠按钮是否真的收起
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem(
    "ncl.ui.preferences.v1",
    JSON.stringify({
      theme: "arasaka",
      useCustomAccent: false,
      accent: "#ff4058",
      scale: 1,
      sidebarCollapsed: false,
    }),
  );
});
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.getByText("运行诊断", { exact: false }).first().click();
await page.waitForTimeout(1500);
await page.locator(".panel-toggle").first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: "shots/audit/interaction-collapsed.png" });
console.log("toggles=" + (await page.locator(".panel-toggle").count()));
console.log("collapsed=" + (await page.locator(".panel.is-collapsed").count()));
await browser.close();
