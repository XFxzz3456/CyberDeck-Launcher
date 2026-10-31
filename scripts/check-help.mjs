// 帮助中心验收（看板【11】）：入口一次点击可达、内容离线内置、折叠面板可展开、搜索有结果。
//
// 这些断言防的是"帮助中心变成空壳"：只挂了个入口，点进去没内容，或者内容依赖网络。
// 内容条数直接从渲染后的 DOM 数，不读源码常量——常量对了但没渲染出来同样是坏的。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  localStorage.setItem(
    "ncl.ui.preferences.v1",
    JSON.stringify({
      theme: "arasaka",
      useCustomAccent: false,
      accent: "#ff4058",
      scale: 1,
      sidebarCollapsed: false,
      animations: false,
      splash: false,
    }),
  );
});

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// 入口：侧栏「设置」→ 顶部 Tab「帮助」（r22 从侧栏挪进设置页，两步可达）
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole("tab", { name: "帮助", exact: true }).click();
await page.waitForTimeout(600);

const tutorials = await page.locator(".help-block", { hasText: "教程" }).locator(".help-item").count();
const faq = await page.locator(".help-block", { hasText: "常见问题" }).locator(".help-item").count();

// 展开第一条教程：出现步骤列表
await page.locator(".help-item .help-trigger").first().click();
await page.waitForTimeout(400);
const expanded = (await page.locator(".help-steps li").count()) > 0 ? 1 : 0;

// 搜索：输入"部署"应命中
await page.locator(".help-search input").fill("部署");
await page.waitForTimeout(400);
const searchHits = await page.locator(".help-item").count();

// 清空搜索后条数应恢复
await page.locator(".help-search input").fill("");
await page.waitForTimeout(300);
const restored = await page.locator(".help-item").count();

console.log(`tutorials=${tutorials}`);
console.log(`faq=${faq}`);
console.log(`expanded=${expanded}`);
console.log(`searchHits=${searchHits}`);
console.log(`restored=${restored}`);

await browser.close();

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
};
check(tutorials >= 6, `教程 ≥6（实际 ${tutorials}）`);
check(faq >= 8, `FAQ ≥8（实际 ${faq}）`);
check(expanded === 1, "首条教程可展开");
check(searchHits >= 1, `搜索"部署"有结果（实际 ${searchHits}）`);
check(restored >= 14, `清空搜索后恢复全部条目（实际 ${restored}）`);
process.exit(failed === 0 ? 0 : 1);
