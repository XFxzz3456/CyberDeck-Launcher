// 单点验收：NXM 协议接管（计划【3】）。
//
// 断言四件事：
//   1) 收到 nxm:// 链接后，右下角出现接收条，并带「下载导入」按钮（r10 文案整改由「下载并导入」改名为「下载导入」）；
//   2) 点「忽略」后这条从队列里消失；
//   3) 设置页「工具组件」里显示协议归属（演示数据里被 Vortex 占着）；
//   4) 点「接管」变成 us、按钮切成「交还协议」，再点「交还」能回到 other。
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
});

// ── 接收条 ────────────────────────────────────────────────────
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}/?nxm=1`, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);

const rows = await page.locator(".nxm-intake-row").count();
const idText = await page.locator(".nxm-intake-id").first().innerText().catch(() => "");
const installButtons = await page.getByRole("button", { name: /下载(并)?导入/ }).count();
await page.screenshot({ path: "shots/audit/interaction-nxm-intake.png" });

await page.getByRole("button", { name: "忽略这条下载请求" }).first().click();
await page.waitForTimeout(400);
const afterIgnore = await page.locator(".nxm-intake-row").count();

// ── 设置页协议归属 ────────────────────────────────────────────
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(800);
await page.locator("#settings-tab-tools").click();
await page.waitForTimeout(700);
await page.locator(".nxm-block").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

const handlerText = await page.locator(".nxm-handler").first().innerText().catch(() => "");
const handlerVortex = /vortex/i.test(handlerText) ? 1 : 0;
await page.screenshot({ path: "shots/audit/interaction-nxm-settings.png" });

await page.getByRole("button", { name: /接管 nxm/ }).click();
await page.waitForTimeout(700);
const afterTakeover = await page.getByRole("button", { name: /交还协议/ }).count();
const takenOverText = await page.locator(".nxm-block").innerText();

await page.getByRole("button", { name: /交还协议/ }).click();
await page.waitForTimeout(700);
const afterRelease = await page.getByRole("button", { name: /接管 nxm/ }).count();
await page.screenshot({ path: "shots/audit/interaction-nxm-release.png" });

console.log(`rows=${rows} installButtons=${installButtons} afterIgnore=${afterIgnore}`);
console.log(`handlerVortex=${handlerVortex} afterTakeover=${afterTakeover} afterRelease=${afterRelease}`);
console.log(`idText=${idText.replace(/\s+/g, " ")}`);
console.log(`takenOver=${takenOverText.includes("已接管") ? 1 : 0}`);

await browser.close();
