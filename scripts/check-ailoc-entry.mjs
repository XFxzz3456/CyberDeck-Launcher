// AI 汉化入口暴露验收（T5 从右键菜单提升到详情页 / 卡片 / 工具栏）。
//
// 断言五件事：
//   1) 打开详情抽屉，能看到 AI 汉化块与按钮（不需要先右键）；
//   2) 未汉化时按钮是主按钮样式，点了会打开汉化弹窗（loc 模式）；
//   3) 工具栏「AI 工具 ▾」下拉里含「翻译名称 / 汉化选中 / 汉化全部」三项；
//   4) 未选中任何模组时「汉化选中（0）」是禁用态（不能空跑）；
//   5) 已生成覆盖层的模组，卡片徽标是「中·AI」而不是普通「中」。

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

// ── 1. 详情抽屉里的入口 ────────────────────────────────────────────
await page.locator(".mod-card").first().click();
await page.waitForTimeout(900);

const drawerAi = page.locator(".drawer-ai");
check("详情抽屉有 AI 汉化块", (await drawerAi.count()) === 1, `count=${await drawerAi.count()}`, "drawerAi");

const aiBtn = drawerAi.getByRole("button");
const aiBtnText = ((await aiBtn.innerText()) ?? "").replace(/\s+/g, "");
check("按钮文案是「AI汉化…」", aiBtnText.includes("AI汉化"), `text=${aiBtnText}`, "aiBtnText");
check("未汉化时按钮可用（mock 已配置接口）", !(await aiBtn.isDisabled()), "", "aiBtnEnabled");

const located = await drawerAi.getAttribute("data-located");
check("未汉化时状态标记为 false", located === "false", `data-located=${located}`, "aiLocatedFlag");

// 点开弹窗：出现 loc 模式的内容（扫描计划标题）
await aiBtn.click();
await page.waitForTimeout(1500);
const dialogText = await page.locator(".modal, [role=dialog]").first().innerText().catch(() => "");
check("点击后打开汉化弹窗", /汉化|本地化|覆盖层/.test(dialogText), `modal=${dialogText.slice(0, 40)}`, "aiDialog");
// 关闭 AI 弹窗与详情抽屉。Esc 是「只关最上面那层」（见 lib/escLayer），
// 所以这里必须按两次：第一次关弹窗、第二次关抽屉。以前两层共用一个
// window keydown，按一次会一起消失，脚本因此写成了「按一次再赌一次点关闭」。
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
// 兜底：焦点可能在某个输入框里、Esc 被组件自己吃掉。此时点抽屉右上角真正的
// 关闭按钮（.icon-btn.on-dark），直到 .drawer-portal 真的从 DOM 里消失。
for (let attempt = 0; attempt < 3; attempt += 1) {
  if ((await page.locator(".drawer-portal").count()) === 0) break;
  await page.locator(".drawer .icon-btn.on-dark").first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(300);
}
await page.locator(".drawer-portal").first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
check("抽屉已关闭", (await page.locator(".drawer-portal").count()) === 0);

// ── 2. 工具栏下拉 ──────────────────────────────────────────────────
// 2026-11-01 工具栏重构后，「AI 汉化 ▾」与「翻译名称」合并成了一个「AI 工具 ▾」，
// 三个菜单项共用同一个面板（类名也从 .import-menu 换成 .toolbar-menu-panel）。
const aiMenuBtn = page.getByRole("button", { name: /^AI 工具/ }).first();
check("工具栏有 AI 工具下拉", (await aiMenuBtn.count()) >= 1, "", "aiMenuBtn");

await aiMenuBtn.click();
await page.waitForTimeout(400);
const menuItems = await page.locator(".toolbar-menu-panel [role=menuitem]").allInnerTexts();
const hasSelected = menuItems.some((item) => item.includes("汉化选中"));
const hasAll = menuItems.some((item) => item.includes("汉化全部"));
const hasRename = menuItems.some((item) => item.includes("翻译列表名称"));
check("下拉含「汉化选中」", hasSelected, `items=${menuItems.join(" | ")}`, "aiMenuSelected");
check("下拉含「汉化全部」", hasAll, "", "aiMenuAll");
check("下拉含「翻译列表名称」（已从工具栏并入此菜单）", hasRename, "", "aiMenuRename");

const selectedDisabled = await page
  .locator(".toolbar-menu-panel [role=menuitem]", { hasText: "汉化选中" })
  .first()
  .isDisabled()
  .catch(() => false);
check("未选中时「汉化选中（0）」禁用", selectedDisabled, "", "aiMenuDisabled");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// ── 3. 已汉化的徽标 ────────────────────────────────────────────────
await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) || "null");
  const mod = db?.state?.mods?.[0];
  if (mod) {
    mod.aiLoc = { stagingDir: "C:\\\\fake\\\\ai-loc", deployed: [] };
  }
  localStorage.setItem(key, JSON.stringify(db));
}, KEY);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1400);

const aiBadge = await page.locator(".cover-lang-ai").count();
check("已汉化模组卡片显示「中·AI」徽标", aiBadge >= 1, `count=${aiBadge}`, "aiBadge");
const badgeText = aiBadge > 0 ? ((await page.locator(".cover-lang-ai").first().innerText()) ?? "").trim() : "";
check("徽标文案是「中·AI」", badgeText.replace(/\s+/g, "") === "中·AI", `text=${badgeText}`, "aiBadgeText");

await page.screenshot({ path: "shots/audit/ai-loc-entry.png" });

const failed = results.filter((r) => !r.ok).length;
console.log(`checks_failed=${failed}`);
await browser.close();
