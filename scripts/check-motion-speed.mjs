/**
 * 「动画速度」滑块专项（574438）。
 *
 * 只断言可稳定观测的事实，不做物理采样（弹簧过冲那类阈值留给 check-motion.mjs，
 * 它依赖帧采样，边际只有 0.1px，不适合进合入门禁）：
 *   1. 个性化页底部有折叠的「// ADVANCED / 高级设置」，默认收起；
 *   2. 展开后能拖到 150% → --motion-scale=1.5 且落盘；
 *   3. 拖到 0% → data-motion=off（等同关掉动效）+ CSS 过渡归零 + framer 下划线不挂载；
 *   4. 刷新后配置保留。
 *
 * 用法：先起 1420（dev 或 preview），再 node scripts/check-motion-speed.mjs
 */
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}/`;
const results = [];
const fail = [];

/** 只输出 key=value：gate.mjs 按这个格式解析断言，人眼也能直接读。 */
function report(key, value) {
  results.push(`${key}=${value}`);
}
function check(name, ok, detail) {
  if (!ok) fail.push(`${name}${detail ? `（${detail}）` : ""}`);
}

const browser = await chromium.launch({ executablePath: edge, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("pageerror", (error) => errs.push(String(error)));

await page.addInitScript(() => {
  // ⚠️ 只在首次导航时初始化：init script 每次 reload 都会重跑，
  // 无条件 clear 会把上一步刚存进去的 motionSpeed 一起冲掉（曾让"刷新保留"断言假红）。
  if (window.localStorage.getItem("ncl.ui.eulaAccepted.v1") === "true") return;
  window.localStorage.clear();
  // 跳过 EULA 门：未同意时整棵 App 是 inert，点不动任何按钮。
  window.localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  window.localStorage.setItem(
    "ncl.ui.preferences.v1",
    JSON.stringify({ useCustomAccent: false, accent: "#fcee0a", scale: 1, sidebarCollapsed: false, animations: true }),
  );
});
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

/** 进设置页 → 个性化解 → 滚到底部，返回「高级设置」标题按钮 locator。 */
async function openAdvanced() {
  await page.getByRole("button", { name: /设置/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator("#settings-tab-appearance").click();
  await page.waitForTimeout(400);
  const head = page.locator(".advanced-head");
  await head.scrollIntoViewIfNeeded();
  return head;
}

const head = await openAdvanced();
const headCount = await head.count();
report("advanced", headCount);
check("高级设置面板存在", headCount === 1);

// 默认收起：body 不存在，aria-expanded=false
const collapsed = await page.evaluate(() => {
  const button = document.querySelector(".advanced-head");
  return {
    expanded: button?.getAttribute("aria-expanded"),
    body: document.querySelectorAll("#appearance-advanced-body").length,
    label: button?.querySelector("h2")?.textContent?.trim() ?? "",
  };
});
report("collapsed", collapsed.expanded === "false" && collapsed.body === 0 ? 1 : 0);
report("title", collapsed.label);
check("默认收起且标题为「高级设置」", collapsed.expanded === "false" && collapsed.body === 0);

await head.click();
await page.waitForTimeout(300);
const slider = page.locator("#appearance-advanced-body input[type=range]");
report("slider", await slider.count());
check("展开后出现动画速度滑块", (await slider.count()) === 1);

/** 把滑块推到指定百分比（range 输入用 fill 会触发 input+change）。 */
async function setSpeed(value) {
  await slider.fill(String(value));
  await page.waitForTimeout(250);
}

// 150%：时长倍率 1.5，动效仍开
await setSpeed(150);
const at150 = await page.evaluate(() => ({
  scale: document.documentElement.style.getPropertyValue("--motion-scale"),
  motion: document.documentElement.dataset.motion,
  stored: JSON.parse(window.localStorage.getItem("ncl.ui.preferences.v1") || "{}").motionSpeed,
  readout: document.querySelector("#appearance-advanced-body .bg-pos-readout")?.textContent?.trim() ?? "",
}));
report("scale150", at150.scale);
report("stored150", at150.stored);
report("motion150", at150.motion ?? "");
check(
  "150% → --motion-scale=1.5 且落盘",
  at150.scale === "1.5" && at150.stored === 150 && at150.motion === "on",
  `scale=${at150.scale} stored=${at150.stored} motion=${at150.motion}`,
);

// 0%：等同关掉动效
await setSpeed(0);
const at0 = await page.evaluate(() => ({
  scale: document.documentElement.style.getPropertyValue("--motion-scale"),
  motion: document.documentElement.dataset.motion,
  transition: getComputedStyle(document.querySelector(".settings-tab")).transitionDuration,
  underline: document.querySelectorAll(".settings-tab-underline").length,
  stored: JSON.parse(window.localStorage.getItem("ncl.ui.preferences.v1") || "{}").motionSpeed,
}));
report("scale0", at0.scale);
report("motion0", at0.motion ?? "");
report("underline0", at0.underline);
report("transition0", /^0s/.test(at0.transition) ? 1 : 0);
check("0% → 动效关闭（data-motion=off）", at0.motion === "off" && at0.scale === "0", `motion=${at0.motion}`);
check("0% → CSS 过渡归零", /^0s/.test(at0.transition), at0.transition);
check("0% → framer 下划线退位", at0.underline === 0, `count=${at0.underline}`);
check("0% → 已落盘", at0.stored === 0, String(at0.stored));

// 恢复 100% 按钮
await page.locator("#appearance-advanced-body .btn", { hasText: "恢复 100%" }).click();
await page.waitForTimeout(250);
const restored = await page.evaluate(() => ({
  scale: document.documentElement.style.getPropertyValue("--motion-scale"),
  motion: document.documentElement.dataset.motion,
}));
report("resetOk", restored.scale === "1" && restored.motion === "on" ? 1 : 0);
check("「恢复 100%」把倍率还原", restored.scale === "1" && restored.motion === "on", `scale=${restored.scale}`);

// 重新推到 130% 后刷新：配置必须保留
await setSpeed(130);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const afterReload = await page.evaluate(() => ({
  scale: document.documentElement.style.getPropertyValue("--motion-scale"),
  motion: document.documentElement.dataset.motion,
}));
report("scaleReload", afterReload.scale);
report("motionReload", afterReload.motion ?? "");
check("刷新后 130% 保留", afterReload.scale === "1.3" && afterReload.motion === "on", `scale=${afterReload.scale}`);

report("errors", errs.length);
check("无脚本错误", errs.length === 0, errs[0] ?? "");

await browser.close();

console.log(results.join("\n"));
if (fail.length > 0) {
  console.log("失败项：" + fail.join(" / "));
  process.exit(1);
}
