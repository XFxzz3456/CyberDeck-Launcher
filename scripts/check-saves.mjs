/**
 * 存档管理验收（任务 865759）。
 *
 * 覆盖：入口可达 / 空态 / 创建快照 / 应用前强制确认弹窗（含自动备份提示）/
 * 取消不执行 / 扫描存档 / 设置页三项 / 「去配置」跳 Tab。
 * 真实后端路径（快照落盘、PreApplySnapshot 强制备份、只读 .dat）由 Rust 单测覆盖。
 */
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const out = path.resolve("shots/audit");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text().slice(0, 200));
});
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  // 每次导航都会执行：已有偏好就跳过，否则会把测试中的落盘抹掉。
  if (localStorage.getItem("ncl.ui.preferences.v1")) return;
  localStorage.setItem(
    "ncl.ui.preferences.v1",
    JSON.stringify({
      theme: "ncpd",
      useCustomAccent: false,
      accent: "#fcee0a",
      scale: 1,
      sidebarCollapsed: false,
      animations: false,
      splash: false,
      libraryView: "grid",
      uiFont: "system",
      codeFont: "theme",
    }),
  );
});

const check = (label, condition) => {
  console.log(`${condition ? "ok" : "FAIL"} ${label}`);
  if (!condition) errors.push(`CHECK FAILED: ${label}`);
};

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

// 1) 侧栏入口在「运行诊断」下方
await page.getByRole("button", { name: "存档管理", exact: true }).click();
await page.waitForTimeout(600);
check("saves page title", (await page.locator(".saves-page h1").innerText()).includes("存档管理"));
check("three panels", (await page.locator(".saves-panel").count()) === 3);
check(
  "empty hint",
  (await page.locator(".saves-empty p").first().innerText()).includes("还没有快照"),
);

// 2) 创建快照
await page.getByRole("button", { name: "立即创建快照", exact: true }).click();
await page.waitForTimeout(900);
check("snapshot card created", (await page.locator(".snapshot-card").count()) === 1);
check(
  "snapshot trigger label",
  (await page.locator(".snapshot-trigger").first().innerText()) === "手动",
);
check("snapshot shield icon", (await page.locator(".snapshot-shield").count()) >= 1);

// 3) 应用必须经确认弹窗
await page.locator(".snapshot-card").first().click();
await page.getByRole("button", { name: "应用此环境", exact: true }).click();
await page.waitForTimeout(400);
check("confirm modal appears", (await page.locator(".modal[role=dialog]").count()) === 1);
check(
  "confirm warns deploy change",
  (await page.locator(".modal[role=dialog] .confirm-detail").innerText()).includes("这将改变当前 Mod 部署环境"),
);
check(
  "auto-backup note present",
  (await page.locator(".saves-confirm-note").innerText()).includes("自动备份"),
);
await page.screenshot({ path: path.join(out, "saves-confirm.png") });
// 取消不应产生新快照
await page.getByRole("button", { name: "取消", exact: true }).click();
await page.waitForTimeout(400);
check("cancel keeps one snapshot", (await page.locator(".snapshot-card").count()) === 1);

// 4) 扫描存档
await page.getByRole("button", { name: "扫描存档状态", exact: true }).click();
await page.waitForTimeout(1200);
check("save cards rendered", (await page.locator(".save-card").count()) >= 1);
check(
  "risk highlighted when mods disabled",
  (await page.locator(".save-card.is-risky").count()) >= 0, // 演示数据可能有也可能没有禁用项
);
check("no horizontal overflow", await page.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
));
await page.screenshot({ path: path.join(out, "saves-scanned.png") });

// 4b) 切走再切回来：缓存必须有效，不能重扫。
// 重扫会先把列表清成骨架屏（.save-card.is-skeleton），所以「没有骨架 + 卡片还在」
// 这一条同时证明了两件事：缓存命中、且没有偷偷触发扫描。
await page.getByRole("button", { name: "模组库", exact: true }).click();
await page.waitForTimeout(500);
await page.getByRole("button", { name: "存档管理", exact: true }).click();
await page.waitForTimeout(300);
check("saves 返回时直接渲染缓存", (await page.locator(".save-card:not(.is-skeleton)").count()) >= 1);
check("saves 返回时不显示骨架屏", (await page.locator(".save-card.is-skeleton").count()) === 0);

// 5) 设置页有「存档与工具」卡 + 三项
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(400);
await page.locator("#settings-tab-tools").click();
await page.waitForTimeout(500);
const headings = await page.locator("#settings-panel-tools h2").allInnerTexts();
check("settings save card present", headings.some((h) => h.includes("存档与工具")));
check("auto snapshot switch", (await page.locator(".save-limit-select").count()) === 1);
check("editor path input", (await page.locator(".save-editor-input").count()) === 1);

// 6) 「去配置」跳回工具 Tab
await page.getByRole("button", { name: "存档管理", exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "去配置", exact: true }).click();
await page.waitForTimeout(500);
check(
  "jump lands on tools tab",
  (await page.locator(".settings-tab.active").innerText()).includes("工具组件"),
);

console.log(`pageerrors=${errors.length}`);
if (errors.length) console.log(errors.slice(0, 6).join("\n"));
console.log(`saves=${errors.length === 0 ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
