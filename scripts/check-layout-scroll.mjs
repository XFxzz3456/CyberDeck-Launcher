/**
 * 页面布局回归：可滚页面必须真能滚 + 文本行高不许压到字号以下。
 *
 * 由来（2026-10-31）：新增「存档管理」页时，滚动是靠 `.page` 上的
 * `overflow-y: auto` 逐个登记的，漏了 `.saves-page`，整页被 `.content`
 * 的 `overflow: hidden` 直接裁掉，滚轮和触控板都没反应。这类问题从代码
 * 里看不出来，只能真的把页面渲染出来滚一下。
 *
 * 同时把「行盒比字号还矮」的文本一起卡住：中文满格字形在 line-height
 * 小于字号时上下沿会被裁，换字体（T8）后更明显，观感就是「文字在飘」。
 *
 * 输出均为 key=value，供 gate.mjs 断言。
 */
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.GATE_PORT || "1420";
const BASE = `http://localhost:${PORT}/`;
const out = path.resolve("shots/audit");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
// 1280x800 是这台机器最小可用窗口，最容易暴露「一屏放不下又不给滚」。
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
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
    })
  );
});
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const VISITS = ["模组库", "加载顺序", "运行诊断", "存档管理", "设置"];

const rows = [];
for (const visit of VISITS) {
  const btn = page.locator(".sidebar .nav-item", { hasText: visit }).first();
  if (!(await btn.count())) {
    rows.push({ label: visit, missing: 1 });
    continue;
  }
  const target = btn;
  await target.click();
  await page.waitForTimeout(550);

  const metrics = await page.evaluate(() => {
    const el = document.querySelector(".page");
    if (!el) return null;
    const style = getComputedStyle(el);
    // 内部已有可滚后代（模组库的 .grid-scroll 这类）时，页面层不需要自己滚。
    const hasInnerScroller = [...el.querySelectorAll("*")].some((child) => {
      const cs = getComputedStyle(child);
      return (
        (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
        child.scrollHeight > child.clientHeight + 2
      );
    });
    const before = el.scrollTop;
    el.scrollTop = 240;
    const after = el.scrollTop;
    el.scrollTop = before;
    return {
      cls: el.className,
      overflowY: style.overflowY,
      gutter: style.scrollbarGutter,
      overflows: el.scrollHeight > el.clientHeight + 2,
      canScroll: after > 0,
      hasInnerScroller,
      clientWidth: el.clientWidth,
    };
  });

  rows.push({ label: visit, ...(metrics ?? {}) });
  await page.screenshot({ path: path.join(out, `layout-${visit}.png`) });
}

// 「内容一屏放不下却滚不动」= 直接阻断，这是用户实际遇到的形态。
const stuck = rows.filter(
  (r) => r.overflows && !r.canScroll && !r.hasInnerScroller && r.overflowY !== "auto"
).length;

// 横向：滚动条占位必须稳定，否则切页时内容宽度变化，观感上是「文字横跳」。
const widths = [...new Set(rows.map((r) => r.clientWidth).filter((w) => typeof w === "number"))];
const widthSpread = widths.length > 1 ? Math.max(...widths) - Math.min(...widths) : 0;

// 行高：所有直接承载文本的元素，行高不得小于字号的 1.1 倍。
const tight = await page.evaluate(() => {
  // 图标字、纯装饰字形（单字母徽标）不适合这条规则，按类名白名单放行。
  const ALLOW = ["logo-glyph", "nav-count", "nav-alert", "avatar", "badge"];
  const bad = [];
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (style.lineHeight === "normal") continue;
    const direct = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 1
    );
    if (!direct) continue;
    const cls = typeof el.className === "string" ? el.className : "";
    if (ALLOW.some((token) => cls.includes(token))) continue;
    const fs = parseFloat(style.fontSize);
    const lh = parseFloat(style.lineHeight);
    if (!Number.isFinite(fs) || !Number.isFinite(lh) || fs < 9) continue;
    if (lh < fs * 1.1) {
      bad.push({
        cls: cls.split(" ").slice(0, 2).join("."),
        text: (el.textContent || "").trim().slice(0, 18),
        fs,
        lh: +lh.toFixed(2),
      });
    }
  }
  return bad;
});

const label = (key) => rows.map((r) => `${r.label}:${r[key]}`).join(" ");

console.log(`pages=${rows.filter((r) => !r.missing).length}`);
console.log(`stuck=${stuck}`);
console.log(`widthSpread=${widthSpread}`);
console.log(`tightText=${tight.length}`);
console.log(
  `savesCanScroll=${rows.find((r) => r.label === "存档管理")?.canScroll ? 1 : 0}`
);
console.log(`pageErrors=${errors.length}`);
console.log(`detail=${label("overflowY")}`);
for (const item of tight.slice(0, 12)) {
  console.log(`tight=${JSON.stringify(item)}`);
}

await browser.close();
process.exit(stuck === 0 && tight.length === 0 ? 0 : 1);
