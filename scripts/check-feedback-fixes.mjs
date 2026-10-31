// 2026-10-30 反馈四项验收：
// ① 框架探测（redscript 靠 r6/scripts、Mod Settings 靠 red4ext dll）
// ② 版本号不再重复 v
// ③ 账户占位头像居中 + 状态跨页同步
// ④ 诊断结论卡排版（大图标 / 两行文案 / 极简统计）
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
await page.waitForTimeout(1500);

// ── ② 版本号：CDL v0.9.0，不能是 CDL vv0.9.0 ──────────────────────
const buildText = (await page.locator(".titlebar-build").innerText()).trim();
check("顶栏版本号", /^CDL v\d+\.\d+\.\d+$/.test(buildText), buildText, "versionClean");

// ── ③ 头像：flex 居中 + 正方形（先打开设置页，卡片才挂载）──────────
const settingsButton = page.getByRole("button", { name: "设置", exact: true });
await settingsButton.click();
await page.waitForTimeout(500);
await page.getByRole("tab", { name: "工具组件", exact: true }).click();
await page.waitForTimeout(700);

const avatar = await page.evaluate(() => {
  const node = document.querySelector(".integration-avatar");
  if (!node) return null;
  const style = getComputedStyle(node);
  const box = node.getBoundingClientRect();
  return {
    display: style.display,
    alignItems: style.alignItems,
    justifyContent: style.justifyContent,
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
});
check("账户头像存在", avatar !== null, avatar ? "" : "未渲染", "avatarExists");
if (avatar) {
  check("头像用 flex 居中", avatar.display === "flex", avatar.display, "avatarFlex");
  check(
    "头像水平垂直都居中",
    avatar.alignItems === "center" && avatar.justifyContent === "center",
    `${avatar.alignItems}/${avatar.justifyContent}`,
    "avatarCenter",
  );
  check("头像方框是正方形", avatar.width === avatar.height, `${avatar.width}x${avatar.height}`, "avatarSquare");
}

// 状态同步：断开/连接发生在页面内部，侧栏「发现」的未连接角标必须跟着变，
// 否则就是用户说的「明明关联了却一直显示」。
const discoverNav = page.locator(".sidebar").getByRole("button", { name: /发现/ }).first();
const cardBefore = await page.locator(".integration-account").count();
check("设置页账户卡片已连接", cardBefore === 1, `count=${cardBefore}`, "settingsConnected");

if (cardBefore === 1) {
  await page.locator(".integration-account").getByRole("button", { name: "断开" }).click();
  await page.waitForTimeout(900);
  const cardAfter = await page.locator(".integration-account").count();
  const badgeAfter = await discoverNav.locator(".nav-alert").count();
  check("断开后设置卡片消失", cardAfter === 0, `count=${cardAfter}`, "disconnectSync");
  check("断开后侧栏发现角标出现", badgeAfter === 1, `badge=${badgeAfter}`, "sidebarBadge");

  await page.locator(".integration-connect input").fill("demo-key");
  await page.locator(".integration-connect").getByRole("button", { name: "连接", exact: true }).click();
  await page.waitForTimeout(1000);
  const badgeRestored = await discoverNav.locator(".nav-alert").count();
  const cardRestored = await page.locator(".integration-account").count();
  check("重新连接后角标消失", badgeRestored === 0, `badge=${badgeRestored}`, "badgeCleared");
  check("重新连接后卡片回来", cardRestored === 1, `count=${cardRestored}`, "cardRestored");
} else {
  console.log("SKIP 账户同步（演示数据未连接）");
  flags.settingsConnected = 0;
}

// ── ④ 诊断结论卡 ─────────────────────────────────────────────────
await page.locator(".sidebar").getByRole("button", { name: /运行诊断/ }).first().click();
await page.waitForTimeout(1200);

const card = await page.evaluate(() => {
  const node = document.querySelector(".diagnostic-summary");
  if (!node) return null;
  const style = getComputedStyle(node);
  const title = node.querySelector(".summary-copy h2");
  const sub = node.querySelector(".summary-copy p");
  const metrics = [...node.querySelectorAll(".summary-metrics > div")];
  return {
    radius: style.borderRadius,
    title: title ? title.textContent.trim() : "",
    titleWeight: title ? getComputedStyle(title).fontWeight : "",
    sub: sub ? sub.textContent.trim() : "",
    metricCount: metrics.length,
    numbers: metrics.map((item) => item.querySelector("strong")?.textContent.trim() ?? ""),
    numberSize: metrics[0] ? parseFloat(getComputedStyle(metrics[0].querySelector("strong")).fontSize) : 0,
    issueWarn: metrics.length > 0 ? metrics[metrics.length - 1].classList.contains("is-warning") : false,
    iconBox: (() => {
      const icon = node.querySelector(".summary-icon");
      if (!icon) return null;
      const rect = icon.getBoundingClientRect();
      const iconStyle = getComputedStyle(icon);
      return { width: Math.round(rect.width), display: iconStyle.display, radius: iconStyle.borderRadius };
    })(),
  };
});

check("结论卡渲染", card !== null, card ? "" : "未渲染", "verdictCard");
if (card) {
  check("结论卡是圆角", card.radius !== "0px" && card.radius !== "", card.radius, "verdictRadius");
  check(
    "主标题是结构化结论",
    /^(发现 \d+ 个(警告|问题)|一切正常，可以启动)$/.test(card.title),
    card.title,
    "verdictTitle",
  );
  check("主标题加粗", Number(card.titleWeight) >= 600, card.titleWeight, "verdictBold");
  check("副标题灰色小字存在", card.sub.length > 0, card.sub.slice(0, 28), "verdictSub");
  check("统计三格", card.metricCount === 3, String(card.metricCount), "metricCount");
  check("统计数字放大", card.numberSize >= 18, `${card.numberSize}px`, "metricSize");
  check("统计无表格线", card.issueWarn || card.numbers[2] === "0", `issues=${card.numbers[2]}`, "metricWarn");
  check(
    "警告大图标",
    card.iconBox !== null && card.iconBox.width >= 44 && card.iconBox.display === "flex",
    card.iconBox ? `${card.iconBox.width}px/${card.iconBox.display}` : "缺失",
    "verdictIcon",
  );
}

// ── ① 框架探测结果 ───────────────────────────────────────────────
const frameworkCards = await page.evaluate(() =>
  [...document.querySelectorAll(".framework-card")].map((card) => ({
    name: card.querySelector(".framework-head span")?.textContent?.trim() ?? "",
    state: card.querySelector(".framework-state")?.textContent?.trim() ?? "",
    detail: card.querySelector(".framework-version")?.textContent?.trim() ?? "",
  })),
);
const findCard = (label) => frameworkCards.find((card) => card.name === label) ?? null;
const redscriptCard = findCard("redscript");
const modSettingsCard = findCard("Mod Settings");
check("redscript 卡片探测为 OK", redscriptCard?.state === "OK", JSON.stringify(redscriptCard), "redscriptFound");
check(
  "Mod Settings 卡片探测为 OK",
  modSettingsCard?.state === "OK",
  JSON.stringify(modSettingsCard),
  "modSettingsFound",
);

// ── 窄屏自适应 ───────────────────────────────────────────────────
await page.setViewportSize({ width: 720, height: 900 });
await page.waitForTimeout(600);
const narrow = await page.evaluate(() => {
  const card = document.querySelector(".diagnostic-summary");
  const metrics = document.querySelector(".summary-metrics");
  if (!card || !metrics) return null;
  const cardBox = card.getBoundingClientRect();
  const metricsBox = metrics.getBoundingClientRect();
  return {
    stacked: metricsBox.top > cardBox.top + 20,
    overflow: metricsBox.right <= cardBox.right + 1,
  };
});
check("窄屏统计换行不溢出", narrow !== null && narrow.stacked && narrow.overflow, JSON.stringify(narrow), "narrowAdapt");

await page.close();
await browser.close();
for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`);
console.log(failed === 0 ? "ALL PASS" : `checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
