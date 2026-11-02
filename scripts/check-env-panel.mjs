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

// 2026-11-02「体检误报」批次：演示数据只有时间戳变化，面板必须显示灰色「提示」
// 而不是黄色 WARNING，并且列表下面带那行"可忽略"的小灰字。
const readout = await page.evaluate(() => {
  const badge = document.querySelector(".env-level");
  const hint = document.querySelector(".env-tolerance-hint");
  const fix = Array.from(document.querySelectorAll(".panel-head .btn-primary")).find((node) =>
    node.textContent.includes("修复"),
  );
  return {
    badgeText: badge ? badge.textContent.trim() : "",
    badgeClass: badge ? badge.className : "",
    hintText: hint ? hint.textContent.replace(/\s+/g, " ").trim() : "",
    fixDisabled: fix ? fix.disabled : null,
    summary: (document.querySelector(".env-summary") || {}).textContent || "",
  };
});
await page.screenshot({ path: "shots/audit/interaction-env-check.png" });

console.log(`level=${level} metrics=${metrics} issues=${issues}`);
console.log(`badgeInfo=${readout.badgeText === "提示" && /env-info/.test(readout.badgeClass) ? 1 : 0}`);
console.log(`toleranceHint=${/杀毒软件|外部工具/.test(readout.hintText) ? 1 : 0}`);
console.log(`fixDisabledParked=${readout.fixDisabled === true ? 1 : 0}`);
console.log(`summaryCalm=${/可正常运行|全部正常/.test(readout.summary) ? 1 : 0}`);
console.log(`alarmWording=${/异常|被改写/.test(readout.summary + readout.hintText) ? 1 : 0}`);
await browser.close();
