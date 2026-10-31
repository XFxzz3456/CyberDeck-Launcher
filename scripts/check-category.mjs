// 分类引擎验收（r22 重写）：内容证据优先、不再被 description 污染、手动改分类可持久化。
//
// 背景：旧引擎把 description 拼进关键词海，而「收编」模组的描述是同一句模板
// 「由外部工具（如 Vortex）部署…」，一跑智能归类就把 168 个模组打成「工具」。
// 所以这里既要验代码里不再传 description，也要验玩家手动纠正的路径真的通。

import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 一、静态守卫：分类输入里不许出现 description ──────────────────
const installer = readFileSync("src-tauri/src/installer.rs", "utf8");
const category = readFileSync("src-tauri/src/category.rs", "utf8");

// 找出所有 `category::Signals { ... }` 块，块内不许出现 description
const signalBlocks = [...installer.matchAll(/category::Signals \{[\s\S]{0,300}?\}\)/g)].map((m) => m[0]);
check("installer 里至少一处 Signals 调用", signalBlocks.length >= 2, `blocks=${signalBlocks.length}`);
check(
  "Signals 不含 description（168 个工具的真因）",
  signalBlocks.every((block) => !block.includes("description")),
  signalBlocks.find((block) => block.includes("description"))?.slice(0, 80) ?? "",
);
check(
  "旧 infer_category 已删除（不再有 description 参数）",
  !installer.includes("fn infer_category"),
);
// 只在 infer 函数体里比先后：NAME_RULES 常量定义在文件前部，全局 indexOf 会比错
const inferBody = category.slice(category.indexOf("pub fn infer("), category.indexOf("pub fn infer_entry("));
check(
  "内容证据在名称之前投票",
  inferBody.indexOf("by_content(signals.paths)") >= 0 &&
    inferBody.indexOf("by_content(signals.paths)") < inferBody.indexOf("NAME_RULES"),
);
check("手动锁定字段参与重算过滤", installer.includes("!entry.category_locked"));
check("写法上不重复发明版本比较", !category.includes("major * 100"));

// ── 二、交互：右键 → 修改分类 → 立即生效 ──────────────────────────
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

const card = page.locator(".mod-card").first();
const before = (await card.locator(".cover-category").innerText()).trim();
await card.click({ button: "right" });
await page.waitForTimeout(300);
const menuItem = await page.locator(".mod-context-item", { hasText: "修改分类" }).count();
check("右键菜单有「修改分类」", menuItem === 1, `count=${menuItem}`);

await page.locator(".mod-context-item", { hasText: "修改分类" }).click();
await page.waitForTimeout(400);
const chips = await page.locator(".category-chip").count();
// 10 个真实分类（排除「全部」「已启用」两个伪分类）
check("分类面板列出 10 个目标分类", chips === 10, `count=${chips}`);
const currentMarked = await page.locator(".category-chip.is-current").count();
check("当前分类有高亮标记", currentMarked === 1, `count=${currentMarked}`);

// 选一个跟当前不同的分类
const target = before === "武器" ? "服装" : "武器";
await page.locator(".category-chip", { hasText: target }).click();
await page.waitForTimeout(700);
const after = (await page.locator(".mod-card").first().locator(".cover-category").innerText()).trim();
check("改分类后卡片立即更新", after === target, `${before} → ${after}`);

// 持久化：刷新后仍是新分类（demo 版写在 localStorage，Tauri 版写在 launcher-state.json）
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const afterReload = (await page.locator(".mod-card").first().locator(".cover-category").innerText()).trim();
check("刷新后分类仍保留", afterReload === target, `${afterReload}`);

// 锁定标记：再次右键应显示「手动指定」提示
await page.locator(".mod-card").first().click({ button: "right" });
await page.waitForTimeout(300);
const lockedHint = await page.locator(".mod-context-item", { hasText: "手动指定" }).count();
check("手动改过的分类带锁定提示", lockedHint === 1, `count=${lockedHint}`);
await page.keyboard.press("Escape");

const errors = await page.evaluate(() => window.__uiErrors ?? []);
check("页面无脚本错误", !errors.length, JSON.stringify(errors));

await browser.close();
const failed = results.filter((item) => !item.ok);
console.log(`checks_failed=${failed.length}`);
process.exit(failed.length ? 1 : 0);
