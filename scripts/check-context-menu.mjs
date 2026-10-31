// 临时验证脚本：卡片右键菜单能否弹出、置灰、关闭
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");  // 跳过 EULA 门：未同意时 App 被 inert=true,脚本点不动任何按钮(r14 引入)
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
await page.waitForTimeout(900);

// 对第一张卡片点右键
await page.locator(".mod-card").first().click({ button: "right" });
await page.waitForTimeout(400);
const visible = await page.locator(".mod-context-menu").count();
const items = await page.locator(".mod-context-item").count();
const disabled = await page.locator(".mod-context-item:disabled").count();
await page.screenshot({ path: "shots/audit/interaction-context-menu.png" });

// Esc 关闭
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const afterEsc = await page.locator(".mod-context-menu").count();

console.log(`menu=${visible} items=${items} disabled=${disabled} afterEsc=${afterEsc}`);
await browser.close();
