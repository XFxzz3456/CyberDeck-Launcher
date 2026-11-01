// 批量改分类验收（P6）：进入选择模式 → 选 2 个 → 「分类」下拉 → 选武器 → 断言写入。
//
// 断言五件事：
//   1) 未进选择模式时批量操作条不存在；
//   2) 进入后操作条出现「分类」下拉；
//   3) 未选任何模组时该下拉禁用；
//   4) 选 2 个后挑「武器」，出现「已更新 2 个模组的分类」回显；
//   5) 落盘：这两个模组的 category 变成武器且 categoryLocked 为 true。

import { chromium } from "playwright-core";

const KEY = "cyberdeck-launcher-demo-state-v1";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const results = [];
function check(name, ok, detail = "", key = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}${key ? ` ${key}=${ok ? 1 : 0}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((key) => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  if (!localStorage.getItem("ncl.ui.preferences.v1")) {
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
  }
}, KEY);

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

check("未进选择模式时没有批量条", (await page.locator(".batch-bar").count()) === 0, "", "noBarWhenIdle");

await page.getByRole("button", { name: /多选/ }).first().click();
await page.waitForTimeout(700);
check("进入选择模式后出现批量条", (await page.locator(".batch-bar").count()) === 1, "", "barVisible");

const catBtn = page.locator(".batch-bar").getByRole("button", { name: /^分类/ }).first();
check("批量条有「分类」下拉", (await catBtn.count()) === 1, "", "catBtn");
check("未选中时禁用", await catBtn.isDisabled(), "", "catDisabled");

// 勾两个卡片
const checks = page.locator(".mod-card .card-select, .mod-card input[type=checkbox]");
const total = await checks.count();
if (total >= 2) {
  await checks.nth(0).click({ force: true });
  await checks.nth(1).click({ force: true });
} else {
  await page.locator(".mod-card").nth(0).click({ modifiers: ["Control"] }).catch(() => {});
  await page.locator(".mod-card").nth(1).click({ modifiers: ["Control"] }).catch(() => {});
}
await page.waitForTimeout(500);
const countText = ((await page.locator(".batch-count").innerText()) ?? "").trim();
check("已选中 2 个", /2/.test(countText), `count=${countText}`, "selected2");

await catBtn.click();
await page.waitForTimeout(400);
const menuItems = await page.locator(".batch-bar .import-menu [role=menuitem]").allInnerTexts();
check("菜单列出分类项", menuItems.length >= 8, `items=${menuItems.length}`, "catMenuItems");

const weapon = page.locator(".batch-bar .import-menu [role=menuitem]", { hasText: "武器" }).first();
await weapon.click();
await page.waitForTimeout(1200);

const note = await page.locator(".batch-note").innerText().catch(() => "");
check("有保存回显", /2/.test(note), `note=${note}`, "catNote");

const stored = await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) || "null");
  const mods = db?.state?.mods ?? [];
  const locked = mods.filter((m) => m.category === "武器" && m.categoryLocked === true);
  return { locked: locked.length, total: mods.length };
}, KEY);
check("落盘并锁定", stored.locked >= 2, `locked=${stored.locked}/${stored.total}`, "catPersisted");

const failed = results.filter((r) => !r.ok).length;
console.log(`checks_failed=${failed}`);
await browser.close();
