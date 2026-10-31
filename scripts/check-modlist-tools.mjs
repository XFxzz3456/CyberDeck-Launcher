// modlist 导入导出 + 批量启用禁用验收（看板【mod 列表及切换功能】）。
//
// 浏览器（mock）模式：导出走 mock 返回路径字符串；导入对话框在浏览器里不可用
// （跳过点按，只验按钮在位与禁用态）；批量走 mock 的 setModsEnabled 真改演示库。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

let failed = 0;
const flags = {};
const check = (name, ok, extra = "", key = null) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (key) flags[key] = ok ? 1 : 0;
  if (!ok) failed += 1;
};

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
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// ── 1. 播放集导入/导出按钮在位 ───────────────────────────────────────
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole("tab", { name: "工具组件", exact: true }).click();
await page.waitForTimeout(500);

const importBtn = page.getByRole("button", { name: "导入", exact: true }).first();
check("播放集面板有导入按钮", (await importBtn.count()) >= 1);
const exportBtns = page.locator(".profile-row-actions button[title*='导出']");
check("每个播放集行有导出按钮", (await exportBtns.count()) >= 1, `rows=${await exportBtns.count()}`, "exportBtn");

// 导出（mock 返回路径字符串）→ note 回显
if ((await exportBtns.count()) > 0) {
  await exportBtns.first().click();
  await page.waitForTimeout(800);
  const note = await page.locator(".profile-note").first().innerText().catch(() => "");
  check("导出后回显落盘路径", note.includes(".json") || note.includes("已导出"), note.slice(0, 60), "exportNote");
}

// ── 2. 批量启用/禁用 ─────────────────────────────────────────────────
await page.getByRole("button", { name: "模组库", exact: true }).click();
await page.waitForTimeout(600);

// 开多选
const selectBtn = page.getByRole("button", { name: /^多选/ }).first();
check("工具栏有多选开关", (await selectBtn.count()) === 1, "", "selectBtn");
await selectBtn.click();
await page.waitForTimeout(400);

const checks = page.locator(".mod-card .card-check");
check("多选模式下卡片出复选框", (await checks.count()) >= 2, `cards=${await checks.count()}`, "checkboxes");
check("批量条出现", (await page.locator(".batch-bar").count()) === 1, "", "batchBar");

// 点前两张卡（多选模式下点卡 = 选中）
await page.locator(".mod-card").nth(0).click();
await page.locator(".mod-card").nth(1).click();
await page.waitForTimeout(200);
const countText = await page.locator(".batch-count").innerText().catch(() => "");
check("选中计数 = 2", countText.includes("2"), countText, "count2");

// 全选当前结果
await page.getByRole("button", { name: "全选当前结果" }).click();
await page.waitForTimeout(200);
const allCount = await page.locator(".batch-count").innerText().catch(() => "");
check("全选后计数增长", !allCount.includes("2"), allCount, "selectAll");

// 批量禁用 → 演示库状态真的变了
await page.getByRole("button", { name: "批量禁用" }).click();
await page.waitForTimeout(900);
check("批量操作后退出多选", (await page.locator(".batch-bar").count()) === 0, "", "autoExit");
const enabledInDb = await page.evaluate(() => {
  const db = JSON.parse(localStorage.getItem("cyberdeck-launcher-demo-state-v1") || "null");
  return (db?.state?.mods ?? []).filter((mod) => mod.enabled).length;
});
check("演示库中启用数归零", enabledInDb === 0, `enabled=${enabledInDb}`, "dbDisabled");

await page.close();
await browser.close();
for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`);
console.log(failed === 0 ? "ALL PASS" : `checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
