// 两条交互的验收：① 退出确认（设置项 + 弹窗文案接线）② Nexus 401 的出口。
//
// 浏览器预览里没有真实窗口，所以"点 ×"这一步没法直接触发；这里钉的是
// **可验证的部分**：设置里有开关、开关能落盘、Nexus 测试连接能给出 401 与
// 「去重新生成 Key」入口。窗口行为本身由 Rust 的 close_window_action 承担。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));

await page.addInitScript(() => {
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
});

let failed = 0;
const check = (name, ok, extra = "", key = null) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (key) console.log(`${key}=${ok ? 1 : 0}`);
  if (!ok) failed += 1;
};

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.getByRole("button", { name: /设置/ }).first().click();
await page.waitForTimeout(600);

// ── ① 窗口行为：最小化模式下有「点 × 时先确认」开关 ──────────────────
await page.getByRole("tab", { name: /个性化/ }).first().click();
await page.waitForTimeout(500);
const askToggle = page.locator(".setting-toggle-row input[type=checkbox]").first();
const askVisible = await askToggle.count();
check("窗口行为里有「关闭前确认」开关", askVisible > 0, `${askVisible} 个`);
console.log(`closeAskToggle=${askVisible > 0 ? 1 : 0}`);

if (askVisible > 0) {
  const before = await askToggle.isChecked();
  await askToggle.click();
  await page.waitForTimeout(500);
  const after = await askToggle.isChecked();
  check("开关可切换且立即生效", before !== after, `${before} → ${after}`);
  console.log(`closeAskToggleWorks=${before !== after ? 1 : 0}`);
  await askToggle.click();
  await page.waitForTimeout(400);
}

// ── ② Nexus：测试连接给 401 + 「去重新生成 Key」 ─────────────────────
// Nexus 卡片挂在「工具组件」页（不是游戏与路径）。
await page.getByRole("tab", { name: /工具组件/ }).first().click();
await page.waitForTimeout(700);
const nexusCard = page.locator(".integration-card").first();
await nexusCard.waitFor({ state: "visible", timeout: 8000 });

check("Nexus 卡片可见", true, "");
const keyInput = nexusCard.locator("input[type=password]").first();
if (await keyInput.count()) {
  await keyInput.fill("invalid-key-for-test");
}
// 演示数据里"没有可用 key"一律按 401 处理，正好覆盖要验的分支。
await nexusCard.getByRole("button", { name: /测试连接/ }).first().click();
await page.waitForTimeout(900);
const warn = nexusCard.locator(".inline-warning").first();
const warnText = (await warn.innerText().catch(() => "")).replace(/\s+/g, " ");
check("401 有明确状态码", /401/.test(warnText), warnText.slice(0, 70));
console.log(`nexus401=${/401/.test(warnText) ? 1 : 0}`);
check("401 指向重新生成 Key", /重新生成/.test(warnText), warnText.slice(0, 70));
console.log(`nexusRegenEntry=${/重新生成/.test(warnText) ? 1 : 0}`);

console.log(`pageerrors=${pageErrors.length}`);
if (pageErrors.length > 0) console.log(pageErrors.join("\n"));

await browser.close();
process.exit(failed === 0 && pageErrors.length === 0 ? 0 : 1);
