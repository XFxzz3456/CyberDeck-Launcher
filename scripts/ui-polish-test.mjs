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

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// Hover actions
const card = page.locator(".mod-card").first();
await card.hover();
await page.waitForTimeout(250);
check("hover action bar visible", (await card.locator(".card-actions").count()) === 1);
await page.screenshot({ path: path.join(shots, "card-hover.png") });

// Empty state uses the new signal panel, not a blank area.
await page.locator(".topbar-search input").fill("zzz-no-such-mod");
await page.waitForTimeout(300);
check("empty state code rendered", (await page.locator(".empty-code").count()) === 1);
await page.screenshot({ path: path.join(shots, "empty-state.png") });
await page.locator(".search-clear").click();
await page.waitForTimeout(200);

// Command palette
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
check("command palette opened", (await page.locator(".command-panel").count()) === 1);
await page.screenshot({ path: path.join(shots, "command-palette.png") });
await page.locator(".command-input-row input").fill("CET");
await page.waitForTimeout(250);
check("command palette finds mod", (await page.locator(".command-row").count()) >= 1);
await page.keyboard.press("Enter");
await page.waitForTimeout(350);
check("command palette opens detail", (await page.locator(".drawer").count()) === 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

// Multi-file import queue
await page.getByRole("button", { name: /导入压缩包/ }).first().click();
await page.waitForTimeout(250);
await page.locator('input[type="file"]').setInputFiles([
  { name: "queue-a.zip", mimeType: "application/zip", buffer: Buffer.from("a") },
  { name: "queue-b.zip", mimeType: "application/zip", buffer: Buffer.from("b") },
]);
await page.waitForTimeout(150);
await page.getByRole("button", { name: /导入 2 个文件/ }).click();
await page.waitForTimeout(220);
check("task center visible", (await page.locator(".task-center").count()) === 1);
check("task rows queued", (await page.locator(".task-row").count()) >= 2);
await page.screenshot({ path: path.join(shots, "task-center.png") });
await page.waitForTimeout(2400);
check("multi import results", (await page.locator(".import-review-row").count()) >= 1);
await page.screenshot({ path: path.join(shots, "task-results.png") });
await page.locator(".modal-foot .btn-ghost").last().click();
await page.waitForTimeout(300);

// Log extraction
await page.getByRole("button", { name: /运行诊断/ }).first().click();
await page.waitForTimeout(900);
await page.getByRole("button", { name: /查看日志/ }).click();
await page.waitForTimeout(700);
const errorFilter = page.getByRole("button", { name: /^错误/ });
await errorFilter.click();
await page.waitForTimeout(200);
check("error filter narrows log", (await page.locator(".log-line").count()) <= 1);
await page.getByRole("button", { name: /提取错误/ }).click();
await page.waitForTimeout(250);
check("log extract block rendered", (await page.locator(".log-extract-block").count()) >= 1);
check("log AI gated by consent", await page.getByRole("button", { name: /发给 AI/ }).isDisabled());
await page.screenshot({ path: path.join(shots, "log-extract.png") });
await page.locator(".modal-head .icon-btn").click();
await page.waitForTimeout(250);

// Danger hold modal
await page.locator(".nav-item").last().click();
await page.waitForTimeout(450);
// 「恢复原状」在「安全与维护」分区的备份卡片里，先切到该分区。
await page.locator("#settings-tab-security").click();
await page.waitForTimeout(250);
await page.getByRole("button", { name: /恢复原状/ }).click();
await page.waitForTimeout(250);
check("danger confirm opened", (await page.locator(".danger-hold").count()) === 1);
const hold = page.locator(".danger-hold");
const box = await hold.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450);
  check("danger hold in progress", (await hold.innerText()).includes("继续按住"));
  await page.mouse.up();
  await page.waitForTimeout(150);
  check("danger cancelled after release", (await page.locator(".danger-hold").count()) === 1);
}
await page.screenshot({ path: path.join(shots, "danger-hold.png") });
await page.getByRole("button", { name: "取消" }).click();
await page.waitForTimeout(200);

// Full hold actually executes.
await page.getByRole("button", { name: /恢复原状/ }).click();
await page.waitForTimeout(220);
const hold2 = page.locator(".danger-hold");
const box2 = await hold2.boundingBox();
if (box2) {
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1750);
  await page.mouse.up();
  await page.waitForTimeout(2400);
}
check("full hold executes danger action", (await page.locator(".danger-hold").count()) === 0);

// Missing prerequisites are inferred from the deployed file shape and the
// live framework scan. The mock supports ?frameworks=missing for this check.
const missingPage = await context.newPage();
await missingPage.goto(`http://localhost:${process.env.GATE_PORT || 1420}/?frameworks=missing`, { waitUntil: "networkidle" });
await missingPage.waitForTimeout(900);
check("missing prerequisite badge rendered", (await missingPage.locator(".cover-missing").count()) >= 1);
const cetCard = missingPage.locator(".mod-card").filter({ hasText: "Photo Mode Unlocker" }).first();
await cetCard.click();
await missingPage.waitForTimeout(350);
check("drawer shows missing prerequisite", (await missingPage.locator(".drawer-prereq").count()) === 1);
check("prerequisite has a get link", (await missingPage.getByRole("button", { name: /去获取/ }).count()) >= 1);
await missingPage.screenshot({ path: path.join(shots, "missing-prereq.png") });
await missingPage.close();

console.log("ERRORS", errors);
await browser.close();
if (errors.length > 0) process.exitCode = 1;
