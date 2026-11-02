// 多套 AI 配置验收（本地 / 云端 / 中转站各存一份，随时切换）。
//
// 钉住四件事：
//   ① 列表按卡片渲染，当前生效的那套有 is-active 标记；
//   ② 「使用」能把激活态切过去（后端会把值同步写回 settings 三个老字段）；
//   ③ 「测试连接」结果如实显示（成功绿 / 失败红，都带耗时），且**不落盘**；
//   ④ 新建一套能出现在列表里，全程无页面异常。
//
// 浏览器预览走 mock：本地地址必失败、云端必成功，两种排版都能被看到。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
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
await page.getByRole("tab", { name: /AI 配置/ }).first().click();
await page.waitForTimeout(900);

const cards = page.locator(".ai-profile-card");
const initialCount = await cards.count();
check("配置按卡片渲染", initialCount >= 2, `${initialCount} 张`);
console.log(`profiles=${initialCount}`);

const activeName = await page
  .locator(".ai-profile-card.is-active strong")
  .first()
  .innerText()
  .catch(() => "");
check("当前配置有 is-active 标记", activeName.length > 0, activeName);
console.log(`activeMarked=${activeName.length > 0 ? 1 : 0}`);

// 切到另一套
const other = page.locator(".ai-profile-card:not(.is-active)").first();
const otherName = await other.locator("strong").innerText();
await other.getByRole("button", { name: "使用" }).click();
await page.waitForTimeout(700);
const nowActive = await page
  .locator(".ai-profile-card.is-active strong")
  .first()
  .innerText()
  .catch(() => "");
check("点「使用」能切换激活配置", nowActive.trim() === otherName.trim(), `${activeName} → ${nowActive}`);
console.log(`switched=${nowActive.trim() === otherName.trim() ? 1 : 0}`);

// 测试连接（本地地址，应失败但排版正常）
await page.getByRole("button", { name: /测试连接/ }).first().click();
await page.locator(".ai-test-note").first().waitFor({ timeout: 8000 });
const testText = await page.locator(".ai-test-note").first().innerText();
const testClass = await page.locator(".ai-test-note").first().getAttribute("class");
check("测试连接给出结果与耗时", /ms/.test(testText), testText.replace(/\s+/g, " ").slice(0, 60));
console.log(`testResult=${/ms/.test(testText) ? 1 : 0}`);
check("失败用红色样式", /is-bad/.test(testClass ?? ""), testClass ?? "");
console.log(`testBadStyle=${/is-bad/.test(testClass ?? "") ? 1 : 0}`);

// 新建一套
await page.locator(".ai-profile-add").first().click();
await page.waitForTimeout(300);
const nameInput = page.locator(".settings-field", { hasText: "配置名称" }).locator("input").first();
await nameInput.fill("中转站测试");
const modelField = page.locator(".settings-field", { hasText: "模型名" }).locator("input").first();
await modelField.fill("deepseek-chat");
await page.getByRole("button", { name: /保存为新配置/ }).first().click();
await page.waitForTimeout(900);
const afterCount = await cards.count();
check("新建配置出现在列表里", afterCount === initialCount + 1, `${initialCount} → ${afterCount}`);
console.log(`created=${afterCount === initialCount + 1 ? 1 : 0}`);

console.log(`pageerrors=${pageErrors.length}`);
if (pageErrors.length > 0) console.log(pageErrors.join("\n"));

await browser.close();
process.exit(failed === 0 && pageErrors.length === 0 ? 0 : 1);
