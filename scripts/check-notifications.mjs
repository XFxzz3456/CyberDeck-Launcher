/**
 * 通知停留时长验收（任务 2D）。
 *
 * 覆盖：分段控件 5 档 / 预设秒数落盘 / 自定义越界自动修正（200 → 60）/
 * 非法字符拦截 / 空输入回退 / 不自动隐藏 → toast 常驻 / 5 秒档普通 toast 自动消失。
 * warn/error 强制常驻的判定在 notify.ts::toastTtl（纯函数），此处不重复造错误场景。
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

// 1) 设置 → 通知
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(800);
await page.locator("#settings-tab-notifications").click();
await page.waitForTimeout(400);

const row = page.locator(".notif-duration-row");
check("duration row rendered", (await row.count()) === 1);
const segs = await row.locator(".scale-seg").count();
console.log(`segs=${segs}`);

const stored = () =>
  page.evaluate(() => (localStorage.getItem("ncl.ui.notificationDuration.v1") ?? "").replaceAll('""', "").replaceAll('"', ""));

// 2) 预设档：点 10 秒 → 落盘 10
await row.locator(".scale-seg", { hasText: "10 秒" }).click();
await page.waitForTimeout(200);
const preset10 = await stored();
console.log(`preset10=${preset10}`);
check("preset 10 stored", preset10 === "10");

// 3) 自定义档：200 越界 → 修正为 60
await row.locator(".scale-seg-custom").click();
await page.waitForTimeout(200);
const input = row.locator(".scale-seg-input input");
await input.fill("200");
await input.press("Enter");
await page.waitForTimeout(200);
const customClamped = await stored();
console.log(`customClamped=${customClamped}`);
check("custom 200 clamped to 60", customClamped === "60");

// 4) 非法字符拦截：fill "a8b" → 输入框里只剩 "8"
await row.locator(".scale-seg-custom").click();
await page.waitForTimeout(200);
await input.fill("a8b");
const digitsOnly = await input.inputValue();
console.log(`digitsOnly=${digitsOnly}`);
check("non digits stripped", digitsOnly === "8");
await input.press("Enter");
await page.waitForTimeout(200);

// 5) 空输入回退：安静回到当前生效值（上一轮已提交 8）
await row.locator(".scale-seg-custom").click();
await page.waitForTimeout(200);
await input.fill("");
await input.press("Enter");
await page.waitForTimeout(200);
const emptyRevert = await stored();
console.log(`emptyRevert=${emptyRevert}`);
check("empty input reverts", emptyRevert === "8");

// 6) 不自动隐藏 → 测试通知常驻（data-sticky=1），只能手动关
await row.locator(".scale-seg", { hasText: "不自动隐藏" }).click();
await page.waitForTimeout(200);
const never = await stored();
console.log(`never=${never}`);
check("never stored", never === "never");

await page.locator(".panel", { hasText: "通知" }).getByRole("button", { name: "发送测试通知" }).click();
await page.waitForTimeout(400);
const stickyToast = await page.locator(".toast[data-sticky='1']").count();
console.log(`stickyToast=${stickyToast}`);
check("never toast is sticky", stickyToast === 1);
await page.screenshot({ path: path.join(out, "notify-never-sticky.png") });
await page.locator(".toast .toast-close").first().click();
await page.waitForTimeout(300);

// 7) 回 5 秒档：普通 toast 会自动消失
await row.locator(".scale-seg", { hasText: "5 秒" }).click();
await page.waitForTimeout(200);
await page.locator(".panel", { hasText: "通知" }).getByRole("button", { name: "发送测试通知" }).click();
await page.waitForTimeout(400);
const normalToast = await page.locator(".toast[data-sticky='0']").count();
console.log(`normalToast=${normalToast}`);
check("5s toast is not sticky", normalToast === 1);
await page.waitForTimeout(5400);
const autoDismissed = (await page.locator(".toast").count()) === 0 ? 1 : 0;
console.log(`autoDismissed=${autoDismissed}`);
check("5s toast auto dismissed", autoDismissed === 1);

console.log(`pageErrors=${errors.length}`);
if (errors.length) {
  console.log(errors.slice(0, 3).join(" | "));
  process.exit(1);
}
await browser.close();
