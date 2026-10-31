// 视觉审计截图：遍历五套主题 × 主要页面，输出到 shots/audit/
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "shots", "audit");
fs.mkdirSync(out, { recursive: true });

const THEMES = [
  { id: "ncpd", accent: "#fcee0a" },
  { id: "netrunner", accent: "#31e6ff" },
  { id: "arasaka", accent: "#ff4058" },
  { id: "militech", accent: "#b7f04b" },
  { id: "mono", accent: "#f2f2f2" },
  { id: "daylight", accent: "#b23a0e" },
];

const VIEWS = [
  { id: "library", label: "模组库" },
  { id: "nexus", label: "发现" },
  { id: "loadorder", label: "加载顺序" },
  { id: "diagnostics", label: "运行诊断" },
  { id: "settings", label: "设置" },
];

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const errors = [];

for (const theme of THEMES) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((payload) => {
    localStorage.clear();
    localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify(payload));
  }, { theme: theme.id, useCustomAccent: false, accent: theme.accent, scale: 1, sidebarCollapsed: false });

  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${theme.id}: ${e.message}`));

  await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  for (const view of VIEWS) {
    if (view.id !== "library") {
      await page.locator(`button.nav-item[aria-label="${view.label}"]`).click();
      await page.waitForTimeout(600);
      // 诊断页要额外等环境体检面板出结果，否则截图会停在 loading。
      if (view.id === "diagnostics") {
        await page.locator(".env-level").first().waitFor({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(250);
      }
    }
    const file = path.join(out, `${theme.id}-${view.id}.png`);
    await page.screenshot({ path: file });
    console.log(`shot ${theme.id}/${view.id}`);
  }

  // 外观卡片特写
  await page.locator(".appearance-card").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `${theme.id}-appearance.png`) });
  console.log(`shot ${theme.id}/appearance`);

  // 设置页下半部分（启动方式 / 安全策略 / 存储 / 日志）
  await page.evaluate(() => {
    const scroller = document.querySelector(".page") ?? document.scrollingElement;
    scroller?.scrollTo({ top: scroller.scrollHeight });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${theme.id}-settings-bottom.png`) });
  console.log(`shot ${theme.id}/settings-bottom`);

  await context.close();
}

// 窄窗口（1024×768）：检查栅格与侧栏是否挤压
{
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await context.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify({ theme: "arasaka", useCustomAccent: false, accent: "#ff4058", scale: 1, sidebarCollapsed: false }));
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`narrow: ${e.message}`));
  await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "narrow-1024-library.png") });
  console.log("shot narrow-1024/library");
  await context.close();
}

// 侧栏收起状态
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify({ theme: "arasaka", useCustomAccent: false, accent: "#ff4058", scale: 1, sidebarCollapsed: true }));
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`collapsed: ${e.message}`));
  await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "arasaka-collapsed.png") });
  console.log("shot arasaka/collapsed");
  await context.close();
}

// 空状态：搜索一个不存在的词
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify({ theme: "arasaka", useCustomAccent: false, accent: "#ff4058", scale: 1, sidebarCollapsed: false }));
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
  await page.locator(".topbar-search input").fill("zzz-no-such-mod");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "arasaka-empty.png") });
  console.log("shot arasaka/empty");
  await context.close();
}

await browser.close();
console.log(errors.length ? `ERRORS: ${errors.join(" | ")}` : "no page errors");
