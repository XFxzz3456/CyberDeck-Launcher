// 自定义背景图验收（看板【皮肤 UI 优化】P0 子项）：
// 控制块渲染、无图时滑杆禁用、有图时背景层出现且滑杆实时改样式、恢复默认后背景层消失。
//
// 浏览器（mock）模式下 read_background_image 回一张内置 SVG，选图对话框不可用，
// 所以「有图」状态通过改 mock db 的 settings.backgroundImage + 刷新模拟。
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

async function openApp() {
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
  await page.waitForTimeout(1200);
  return page;
}

async function gotoAppearance(page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole("tab", { name: "外观", exact: true }).or(page.getByRole("tab", { name: "个性化", exact: true })).first().click();
  await page.waitForTimeout(500);
}

// ── 1. 无图基线 ──────────────────────────────────────────────────────
const page = await openApp();
await gotoAppearance(page);

const block = page.locator(".bg-block");
check("个性化页出现自定义背景控制块", (await block.count()) === 1, "", "block");
check(
  "无图时滑杆禁用",
  await page.locator('.bg-slider input[type="range"]').first().isDisabled(),
  "",
  "sliderDisabled",
);
check(
  "无图时恢复默认禁用",
  await page.getByRole("button", { name: "恢复默认" }).isDisabled(),
  "",
  "clearDisabled",
);
check("无图时背景层不存在", (await page.locator(".app-backdrop").count()) === 0, "", "noBackdrop");

// ── 2. 有图状态：改 mock db 后刷新 ───────────────────────────────────
await page.evaluate(() => {
  const key = "cyberdeck-launcher-demo-state-v1";
  const db = JSON.parse(localStorage.getItem(key) || "null");
  if (db?.state?.settings) {
    db.state.settings.backgroundImage = "C:\\fake\\wallpaper.png";
    db.state.settings.backgroundOpacity = 60;
    db.state.settings.backgroundBlur = 6;
    localStorage.setItem(key, JSON.stringify(db));
  }
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const backdrop = page.locator(".app-backdrop");
check("有图时背景层渲染", (await backdrop.count()) === 1, "", "backdropRendered");
const style = await backdrop.evaluate((node) => ({
  opacity: node.style.opacity,
  filter: node.style.filter,
  hasImage: (node.style.backgroundImage || "").includes("data:image/svg+xml"),
}));
check("初始不透明度 60% 落到样式上", style.opacity === "0.6", style.opacity, "opacityApplied");
check("初始模糊 6px 落到样式上", style.filter === "blur(6px)", style.filter, "blurApplied");
check("背景层用的是 data URL（SVG mock）", style.hasImage, "", "dataUrl");

await gotoAppearance(page);
check(
  "有图时滑杆启用",
  !(await page.locator('.bg-slider input[type="range"]').first().isDisabled()),
  "",
  "sliderEnabled",
);

// ── 3. 滑杆实时预览：拖动即改背景层样式（乐观更新，不等写盘） ────────
const opacitySlider = page.locator('.bg-slider input[type="range"]').first();
await opacitySlider.fill("20");
await page.waitForTimeout(150);
const opacityAfter = await page
  .locator(".app-backdrop")
  .evaluate((node) => node.style.opacity);
check("拖不透明度滑块 → 背景层立即变 20%", opacityAfter === "0.2", opacityAfter, "opacityPreview");

const blurSlider = page.locator('.bg-slider input[type="range"]').nth(1);
await blurSlider.fill("0");
await page.waitForTimeout(150);
const filterAfter = await page
  .locator(".app-backdrop")
  .evaluate((node) => node.style.filter);
check("模糊归 0 → filter 移除", filterAfter === "" || filterAfter === "none", filterAfter, "blurPreview");

// ── 4. 恢复默认：背景层消失、路径清空 ────────────────────────────────
await page.getByRole("button", { name: "恢复默认" }).click();
await page.waitForFunction(() => {
  const db = JSON.parse(localStorage.getItem("cyberdeck-launcher-demo-state-v1") || "null");
  return db?.state?.settings?.backgroundImage === "";
}, null, { timeout: 8000 });
check("恢复默认后背景层消失", (await page.locator(".app-backdrop").count()) === 0, "", "clearWorks");
const stored = await page.evaluate(() => {
  const db = JSON.parse(
    localStorage.getItem("cyberdeck-launcher-demo-state-v1") || "null",
  );
  return db?.state?.settings ?? null;
});
check(
  "恢复默认写回设置（backgroundImage 为空）",
  stored?.backgroundImage === "",
  JSON.stringify({
    image: stored?.backgroundImage,
    opacity: stored?.backgroundOpacity,
  }),
  "clearPersisted",
);

await page.close();
await browser.close();
for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`);
console.log(failed === 0 ? "ALL PASS" : `checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
