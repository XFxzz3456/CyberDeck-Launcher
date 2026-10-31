// 验证浮层栈在抽屉打开时确实让位：检查 has-drawer 类 + 计算样式 + 矩形不相交。
import { chromium } from "playwright-core";

const BASE = `http://localhost:${process.env.GATE_PORT || 1420}`;
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const shellBefore = await page.evaluate(() => document.querySelector(".app-shell")?.className ?? "");
const stackBefore = await page.evaluate(() => {
  const el = document.querySelector(".floating-stack");
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { right: cs.right, left: cs.left, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
});

// 点开第一个模组卡片，打开详情抽屉
const card = page.locator('[class*="mod-card"]').first();
await card.click({ timeout: 8000 }).catch(() => {});
await page.waitForTimeout(700);

const shellAfter = await page.evaluate(() => document.querySelector(".app-shell")?.className ?? "");
const drawer = await page.evaluate(() => {
  const el = document.querySelector(".drawer");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const stackAfter = await page.evaluate(() => {
  const el = document.querySelector(".floating-stack");
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { right: cs.right, left: cs.left, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
});

function overlap(a, b) {
  if (!a || !b) return null;
  const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  return hit;
}

console.log("shell 无抽屉:", shellBefore.includes("has-drawer") ? "有(异常)" : "无(正常)");
console.log("shell 抽屉打开:", shellAfter.includes("has-drawer") ? "有(正确)" : "无(异常)");
console.log("栈 before:", JSON.stringify(stackBefore));
console.log("drawer:", JSON.stringify(drawer));
console.log("栈 after :", JSON.stringify(stackAfter));
if (drawer && stackAfter) {
  const hit = overlap(stackAfter.rect, drawer);
  console.log("栈与抽屉矩形相交:", hit ? "是（异常）" : "否（正确）");
  console.log("栈左边界", stackAfter.rect.x, "| 抽屉左边界", drawer.x);
}
await page.screenshot({ path: "shots/drawer-floating.png" }).catch(() => {});
await browser.close();
