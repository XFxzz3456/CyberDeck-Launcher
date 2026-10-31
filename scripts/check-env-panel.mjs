// 临时验证脚本：环境体检面板能否加载出健康度与问题清单
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
await page.getByRole("button", { name: "运行诊断", exact: true }).click();
await page.waitForTimeout(1200);

await page.locator(".env-level").first().waitFor({ timeout: 8000 }).catch(() => {});
const level = await page.locator(".env-level").count();
const metrics = await page.locator(".env-metrics > div").count();
const issues = await page.locator(".env-issue").count();
await page.screenshot({ path: "shots/audit/interaction-env-check.png" });

console.log(`level=${level} metrics=${metrics} issues=${issues}`);
await browser.close();
