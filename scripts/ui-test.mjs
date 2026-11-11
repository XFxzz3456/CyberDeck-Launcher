import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = path.resolve(import.meta.dirname, "..");
const shots = path.join(root, "shots");
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
});
const page = await context.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("favicon")) errors.push(msg.text());
});
page.on("pageerror", (error) => errors.push(error.message));

const check = (label, condition) => {
  if (!condition) {
    errors.push(`CHECK FAILED: ${label}`);
    console.log(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

// 首启门单独用一个干净上下文验证。主流程会另开一页（设置页的窄视口检查），
// 而 context 级 init script 每页都会跑一次；若一直清 localStorage，
// 第二页会把同意标记一起清掉，于是又弹出一次门。
const gateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await gateContext.addInitScript(() => localStorage.clear());
const gatePage = await gateContext.newPage();
await gatePage.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await gatePage.waitForTimeout(700);
await gatePage.waitForSelector(".eula-dialog", { timeout: 8000 });
// r14 起协议门不再短路渲染：主界面照常渲染在底层，被毛玻璃遮罩盖住并切成 inert。
check(
  "eula gate overlays the app (shell rendered but inert)",
  (await gatePage.locator(".head-stat").count()) > 0 &&
    (await gatePage.locator(".app-shell").getAttribute("inert")) !== null,
);
check("accept disabled before consent", await gatePage.locator(".eula-foot .btn-primary").isDisabled());
check("summary lists three points", (await gatePage.locator(".eula-summary li").count()) === 3);
await gatePage.locator(".eula-expand").click();
await gatePage.waitForTimeout(250);
check("full text rendered", (await gatePage.locator(".eula-full .eula-h2").count()) >= 6);
await gatePage.screenshot({ path: path.join(shots, "eula-gate.png") });
await gatePage.locator(".eula-consent input").check();
await gatePage.locator(".eula-foot .btn-primary").click();
await gatePage.waitForTimeout(800);
check("gate dismissed after accept", (await gatePage.locator(".eula-dialog").count()) === 0);
await gateContext.close();

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

const stat = await page.locator(".head-stat").first().innerText();
console.log("initial stat:", stat.replace(/\n/g, " "));
await page.screenshot({ path: path.join(shots, "library-040.png") });

// Toggle the first visible card.
const firstCard = page.locator(".mod-card").first();
const firstName = await firstCard.locator("h3").innerText();
await firstCard.hover();
await page.waitForTimeout(180);
await firstCard.locator(".toggle").click();
await page.waitForTimeout(700);
console.log("toggled:", firstName, "toast:", await page.locator(".toast").first().innerText());
await firstCard.screenshot({ path: path.join(shots, "card-toggled.png") });

// Search filters the library.
await page.locator(".topbar-search input").fill("CET");
await page.waitForTimeout(350);
console.log("search CET count:", await page.locator(".result-count").innerText());
await page.locator(".search-clear").click();
await page.waitForTimeout(250);

// Import a mock archive through the modal (zip/7z/rar share the same UI path).
await page.getByRole("button", { name: "导入模组", exact: true }).first().click();
await page.waitForTimeout(250);
// 现在有多个隐藏的 file input（导入模组 / 导入集合清单），必须指定具体那个
await page.locator('input[type="file"]').first().setInputFiles({
  name: "demo-import.7z",
  mimeType: "application/x-7z-compressed",
  buffer: Buffer.from("demo"),
});
await page.waitForTimeout(200);
check("7z selected in import dialog", (await page.locator(".selected-row").count()) === 1);
await page.getByRole("button", { name: /导入 1 个文件/ }).click();
await page.waitForTimeout(900);
console.log("import result:", (await page.locator(".import-result-summary").innerText()).replace(/\n/g, " "));
check("import review row rendered", (await page.locator(".import-review-row").count()) === 1);
check("filename fallback is called out", (await page.locator(".import-review-warning").count()) === 1);
await page.locator(".import-category select").first().selectOption("武器");
await page.screenshot({ path: path.join(shots, "import-review.png") });
await page.getByRole("button", { name: /保存分类/ }).click();
await page.waitForTimeout(600);

// Conflict center is reachable from the header counter, not only after a failed deploy.
const conflictStat = page.locator(".head-stat.conflict-stat");
check("conflict counter is clickable", await conflictStat.isEnabled());
await conflictStat.click();
await page.waitForTimeout(450);
check("conflict center opened", (await page.locator(".conflict-center-list .conflict-group").count()) >= 1);
check("conflict center shows AI advisor", (await page.locator(".conflict-ai").count()) === 1);
const conflictRun = page.getByRole("button", { name: /分析冲突/ });
check("conflict AI needs consent", await conflictRun.isDisabled());
await page.locator(".conflict-ai input[type=checkbox]").check();
await page.waitForTimeout(100);
check("conflict AI enabled after consent", await conflictRun.isEnabled());
await conflictRun.click();
await page.waitForTimeout(1600);
check("conflict AI result rendered", (await page.locator(".conflict-ai-result").count()) === 1);
await page.screenshot({ path: path.join(shots, "conflict-center.png") });
await page.locator(".modal-foot .btn-primary").last().click();
await page.waitForTimeout(300);

// Load order view and keyboard reorder.
await page.getByRole("button", { name: /加载顺序/ }).first().click();
await page.waitForTimeout(500);
const rows = page.locator(".order-row");
const before = await rows.nth(0).locator(".order-filename").innerText();
await rows.nth(0).getByRole("button", { name: "下移" }).click();
await page.waitForTimeout(500);
const after = await rows.nth(1).locator(".order-filename").innerText();
console.log("order moved:", before.split("\n")[0], "->", after.split("\n")[0]);

// Pointer drag: the ghost follows the cursor and the row order is committed on
// pointerup. This is the path users actually take, not the arrow buttons.
const dragBefore = await rows.nth(0).locator(".order-filename").innerText();
const sourceBox = await rows.nth(0).locator(".drag-handle").boundingBox();
const targetBox = await rows.nth(2).boundingBox();
if (sourceBox && targetBox) {
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 4, targetBox.y + targetBox.height - 4, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(650);
}
const dragAfter = await rows.nth(0).locator(".order-filename").innerText();
check("pointer drag reorders archives", dragBefore !== dragAfter);
await page.screenshot({ path: path.join(shots, "loadorder-2.png") });

// 专属配置：点开带配置的模组，在抽屉里改一项、保存，再确认空状态。
await page.getByRole("button", { name: /模组库/ }).first().click();
await page.waitForTimeout(500);
await page.getByText(/Better Vehicle Handling|更顺手的车辆操控/).first().click();
await page.waitForTimeout(900);
check("detail drawer opened", (await page.locator(".drawer").count()) === 1);
check("mod config panel rendered", (await page.locator(".mod-config").count()) === 1);
check("mod config fields rendered", (await page.locator(".mod-config .setting-row").count()) >= 3);
const numberInput = page.locator(".mod-config .setting-number").first();
await numberInput.fill("1.75");
await page.waitForTimeout(150);
check("mod config marks unsaved", (await page.locator(".mod-config .setting-row.is-dirty").count()) >= 1);
await page.locator(".mod-config-actions .btn-primary").click();
await page.waitForTimeout(750);
check("mod config saved toast", (await page.locator(".toast").count()) >= 1);
check(
  "mod config keeps saved value",
  (await page.locator(".mod-config .setting-number").first().inputValue()) === "1.75",
);
check("mod config back to synced", (await page.locator(".mod-config .setting-row.is-dirty").count()) === 0);
await page.screenshot({ path: path.join(shots, "mod-config.png") });

// 没有配置的模组要平静地显示空状态，而不是空白或警告。
await page.locator(".drawer-hero .icon-btn").last().click();
await page.waitForTimeout(400);
await page.getByText(/^ArchiveXL$/).first().click();
await page.waitForTimeout(800);
check("mod config empty state", (await page.locator(".mod-config-state").count()) >= 1);
await page.locator(".drawer-hero .icon-btn").last().click();
await page.waitForTimeout(300);

// Log viewer reads the tail and highlights error lines.
await page.getByRole("button", { name: /运行诊断/ }).first().click();
await page.waitForTimeout(900);
await page.getByRole("button", { name: /查看日志/ }).click();
await page.waitForTimeout(650);
check("log viewer files rendered", (await page.locator(".log-file-row").count()) >= 3);
check("log viewer error highlighted", (await page.locator(".log-line-error").count()) >= 1);
await page.screenshot({ path: path.join(shots, "log-viewer.png") });
await page.locator(".modal-head .icon-btn").click();
await page.waitForTimeout(250);

// Nexus discovery (browser mock).
await page.getByRole("button", { name: /发现/ }).first().click();
await page.waitForTimeout(1200);
check("nexus cards rendered", (await page.locator(".nexus-card").count()) >= 3);
check("nexus user shown", (await page.locator(".nexus-account").count()) === 1);
await page.locator(".nexus-card").first().click();
await page.waitForTimeout(800);
check("nexus file picker opened", (await page.locator(".nexus-file-row").count()) >= 1);
check("free account download gated", (await page.getByRole("button", { name: /需要 Premium/ }).count()) >= 1);
await page.screenshot({ path: path.join(shots, "nexus-detail.png") });
await page.locator(".modal-head .icon-btn").click();
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, "nexus-discovery.png") });

// Diagnostics + AI panel.
await page.getByRole("button", { name: /运行诊断/ }).first().click();
await page.waitForTimeout(1100);
console.log("diagnostics:", (await page.locator(".summary-copy h2").innerText()).trim());
check("AI panel present", (await page.locator(".ai-panel").count()) === 1);
const runButton = page.getByRole("button", { name: /开始分析/ });
check("AI run needs consent", await runButton.isDisabled());
await page.locator(".ai-consent input").first().check();
await page.waitForTimeout(150);
check("AI run enabled after consent", await runButton.isEnabled());
await runButton.click();
await page.waitForTimeout(1800);
check("AI result rendered", (await page.locator(".ai-result").count()) === 1);
await page.screenshot({ path: path.join(shots, "ai-diagnostics.png") });

// Settings. Use the last nav item: "Mod 设置" also contains "设置".
await page.locator(".nav-item").last().click();
await page.waitForTimeout(450);
console.log("settings path:", await page.locator(".dir-copy code").innerText());
check("Nexus settings card present", (await page.locator(".integration-card").count()) === 1);
await page.screenshot({ path: path.join(shots, "settings-2.png") });

// Nexus setup at the native 1152-CSS-width viewport. The stacked key row must
// keep both buttons inside the panel instead of clipping them off-screen.
const setupPage = await context.newPage();
await setupPage.setViewportSize({ width: 1152, height: 880 });
await setupPage.goto(`http://localhost:${process.env.GATE_PORT || 1420}/?nexus=off`, { waitUntil: "networkidle" });
await setupPage.waitForTimeout(700);
await setupPage.getByRole("button", { name: /发现/ }).first().click();
await setupPage.waitForTimeout(900);
const connectBox = await setupPage.getByRole("button", { name: "连接" }).boundingBox();
check("Nexus setup connect visible", Boolean(connectBox && connectBox.width > 0));
check(
  "Nexus setup connect inside viewport",
  Boolean(connectBox && connectBox.x + connectBox.width <= 1152),
);
await setupPage.screenshot({ path: path.join(shots, "nexus-setup-1152.png") });
await setupPage.close();

// Minimum supported window.
await page.setViewportSize({ width: 1120, height: 720 });
await page.waitForTimeout(400);
await page.getByRole("button", { name: /模组库/ }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, "library-1120.png") });

// 专属配置收进抽屉后，用「打开抽屉 + 展开配置」替代原独立页做最小窗口检查。
await page.getByRole("button", { name: /模组库/ }).first().click();
await page.waitForTimeout(400);
await page.getByText(/Better Vehicle Handling|更顺手的车辆操控/).first().click();
await page.waitForTimeout(800);
const settingsOverflow = await page.evaluate(() => ({
  body: document.body.scrollWidth,
  viewport: window.innerWidth,
}));
check("drawer config no horizontal overflow at 1120", settingsOverflow.body <= settingsOverflow.viewport);
await page.screenshot({ path: path.join(shots, "mod-config-1120.png") });
await page.locator(".drawer-hero .icon-btn").last().click();
await page.waitForTimeout(350);
const conflictBox = await page.locator(".head-stat.conflict-stat").boundingBox();
check("conflict stat visible at 1120", Boolean(conflictBox && conflictBox.width > 0));
check(
  "conflict stat inside 1120 viewport",
  Boolean(conflictBox && conflictBox.x + conflictBox.width <= 1120),
);
const launchBox = await page.locator(".btn-launch").boundingBox();
check("launch button visible at 1120", Boolean(launchBox && launchBox.width > 0));
check(
  "launch button inside 1120 viewport",
  Boolean(launchBox && launchBox.x + launchBox.width <= 1120),
);
const overflow = await page.evaluate(() => ({
  body: document.body.scrollWidth,
  viewport: window.innerWidth,
  content: document.querySelector(".content")?.scrollWidth,
}));
console.log("overflow check:", JSON.stringify(overflow));
check("no horizontal overflow", overflow.body <= overflow.viewport);

console.log("ERRORS", errors);
await browser.close();
if (errors.length > 0) process.exitCode = 1;
