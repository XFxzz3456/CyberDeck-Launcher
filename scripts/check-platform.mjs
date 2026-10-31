// 临时验收脚本：确认设置页「游戏平台」选择器可用。
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
await page.waitForTimeout(2000);

// 侧栏按钮的 aria-label 就是中文名，用精确名避免匹配到「Mod 设置」。
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(900);

// 设置页已经改成六个分区：平台选择器在「游戏与路径」里。
// 不切标签页的话 chip 是 display:none（rect 全 0），点不动也看不见——
// 这正是 2026-10-26 门禁报「after_click 缺失」的原因。
await page.locator("#settings-tab-game").click();
await page.waitForTimeout(700);

const chips = await page.locator(".platform-chip").count();
console.log("chips=" + chips);
if (chips > 0) {
  // r30 起启动卡片里有三组 platform-chip（平台 / 显卡偏好 / 进程优先级），
  // 断言必须限定在「游戏平台」这一组，否则 strict mode 直接炸。
  const platformRow = page.locator(".platform-row", { hasText: "游戏平台" });
  console.log("selected=" + (await platformRow.locator(".platform-chip.selected").innerText()));
  await platformRow.locator(".platform-chips").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await platformRow.locator(".platform-chip", { hasText: "GOG" }).click();
  await page.waitForTimeout(600);
  console.log("after_click=" + (await platformRow.locator(".platform-chip.selected").innerText()));
  await page.screenshot({ path: "shots/audit/interaction-platform.png" });
}

await browser.close();
