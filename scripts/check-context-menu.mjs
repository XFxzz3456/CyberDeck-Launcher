// 验证卡片右键菜单：能弹出、置灰、关闭，且菜单左上角贴住鼠标落点（三档 UI 缩放）
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true"); // 跳过 EULA 门：未同意时 App 被 inert=true,脚本点不动任何按钮(r14 引入)
  // 只在没有偏好时写默认值：下面的「三档缩放」用例会改 scale 再 reload，
  // 每次 reload 都无条件重写的话，缩放永远被按回 100%，用例等于没跑。
  if (!localStorage.getItem("ncl.ui.preferences.v1")) {
    localStorage.setItem(
      "ncl.ui.preferences.v1",
      JSON.stringify({
        theme: "arasaka",
        useCustomAccent: false,
        accent: "#ff4058",
        scale: 1,
        sidebarCollapsed: false,
      }),
    );
  }
});
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

/**
 * 记下最后一次 mousedown 的 clientX/clientY。
 *
 * 这就是浏览器交给应用的「鼠标位置」——菜单左上角必须落在它上面。
 * 每次 reload 都要重新挂（window 被换掉了）。
 */
const trackDown = () =>
  page.evaluate(() => {
    window.__lastDown = null;
    window.addEventListener(
      "mousedown",
      (event) => {
        window.__lastDown = { x: event.clientX, y: event.clientY };
      },
      true,
    );
  });

// ── 基础用例：弹出 / 项数 / 置灰 / Esc 关闭 ──────────────────────────
await trackDown();
await page.locator(".mod-card").first().click({ button: "right" });
await page.waitForTimeout(400);
const visible = await page.locator(".mod-context-menu").count();
const items = await page.locator(".mod-context-item").count();
const disabled = await page.locator(".mod-context-item:disabled").count();
await page.screenshot({ path: "shots/audit/interaction-context-menu.png" });

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const afterEsc = await page.locator(".mod-context-menu").count();

console.log(`menu=${visible} items=${items} disabled=${disabled} afterEsc=${afterEsc}`);

// ── 三档 UI 缩放：菜单左上角必须贴住鼠标落点 ────────────────────────
// body 上有 zoom: var(--ui-scale)，fixed 的 left/top 会被再放大一次；不除以缩放时
// 125% 下菜单右飘上百像素、90% 下左飘几十像素——用户报的「右键菜单和右键的位置
// 不在一起」就是这个。三档都要 Δ=0（1px 容差留给亚像素取整）。
const readMenu = () =>
  page.evaluate(() => {
    const menu = document.querySelector(".mod-context-menu");
    const down = window.__lastDown;
    if (!menu || !down) return null;
    const rect = menu.getBoundingClientRect();
    return {
      dLeft: Math.round(rect.left - down.x),
      dTop: Math.round(rect.top - down.y),
      inViewport: rect.left >= -1 && rect.top >= -1,
      edge: Math.round(rect.right) - window.innerWidth,
      zoom: getComputedStyle(document.body).zoom,
    };
  });

const scales = [1.25, 1, 0.8];
let scaleMaxDelta = 0;
for (const scale of scales) {
  await page.evaluate((value) => {
    const raw = localStorage.getItem("ncl.ui.preferences.v1");
    const prefs = raw ? JSON.parse(raw) : {};
    prefs.scale = value;
    localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify(prefs));
  }, scale);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  await trackDown();
  const box = await page.locator(".mod-card").first().boundingBox();
  if (!box) throw new Error(`UI 缩放 ${scale} 下没有可右键的卡片`);
  // 打在卡片上部：这一带离窗口底部远，菜单不会触发「向上内翻」，
  // dTop 才有意义（内翻是正确行为，不该被当成错位）。
  const px = Math.round(box.x + box.width / 2);
  const py = Math.round(box.y + 8);
  await page.mouse.click(px, py, { button: "right" });
  await page.waitForTimeout(350);

  const measured = await readMenu();
  if (!measured) throw new Error(`UI 缩放 ${scale} 下卡片右键菜单没弹出`);
  scaleMaxDelta = Math.max(scaleMaxDelta, Math.abs(measured.dLeft), Math.abs(measured.dTop));
  console.log(
    `scale=${scale} zoom=${measured.zoom} dLeft=${measured.dLeft} dTop=${measured.dTop} inViewport=${measured.inViewport ? 1 : 0} edge=${measured.edge}`,
  );
  if (Math.abs(measured.dLeft) > 1 || Math.abs(measured.dTop) > 1) {
    throw new Error(
      `UI 缩放 ${scale} 下右键菜单没贴住鼠标落点：Δ=(${measured.dLeft}, ${measured.dTop})px`,
    );
  }
  if (!measured.inViewport) {
    throw new Error(`UI 缩放 ${scale} 下右键菜单左上角跑出窗口`);
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}
console.log(`scaleMaxDelta=${scaleMaxDelta} scaleCases=${scales.length}`);

await browser.close();
