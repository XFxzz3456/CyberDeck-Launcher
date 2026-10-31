// 临时验收脚本：把已确认版本改成旧值，逼出「游戏更新熔断」横幅并截图。
import { chromium } from "playwright-core";

const KEY = "cyberdeck-launcher-demo-state-v1";
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

// 第一趟：让演示库初始化落盘。
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// 把「上次确认版本」改成比演示版本（2.31）更旧的值，getGame 会算出 gameUpdated=true。
await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) ?? "null");
  if (db && db.state) {
    db.state.lastGameVersion = "2.21";
    localStorage.setItem(key, JSON.stringify(db));
  }
}, KEY);

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/audit/interaction-update-lock.png" });
console.log("banners=" + (await page.locator(".update-lock-banner").count()));

if ((await page.locator(".update-lock-banner").count()) > 0) {
  await page.locator(".update-lock-action").click();
  await page.waitForTimeout(1200);
  console.log("after_click=" + (await page.locator(".update-lock-banner").count()));
  await page.screenshot({ path: "shots/audit/interaction-update-lock-cleared.png" });
}

await browser.close();
