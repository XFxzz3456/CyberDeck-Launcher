// 验证播放集：顶栏下拉、切换确认、部署数量变化、设置页管理面板
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");  // 跳过 EULA 门：未同意时 App 被 inert=true,脚本点不动任何按钮(r14 引入)
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

// 播放集选择器已换成自绘浮层（原生 <select> 在 Windows 下配色与边界都不可控）。
const trigger = page.locator(".profile-trigger");
const openMenu = async () => {
  await trigger.click();
  await page.waitForTimeout(250);
};
const currentLabel = async () => (await trigger.innerText()).trim();

/** 量一次「浮层左边界 − 胶囊左边界」（视觉像素，与 UI 缩放无关）。 */
const measureAlign = () =>
  page.evaluate(() => {
    const picker = document.querySelector(".profile-picker")?.getBoundingClientRect();
    const menu = document.querySelector(".profile-menu")?.getBoundingClientRect();
    if (!picker || !menu) return null;
    return {
      dLeft: Math.round(menu.left - picker.left),
      dTop: Math.round(menu.top - picker.bottom),
      inViewport: menu.left >= 0 && menu.right <= window.innerWidth,
      zoom: getComputedStyle(document.body).zoom,
    };
  });

// ── 三档 UI 缩放都要对齐 ────────────────────────────────────────────
// body 上有 zoom: var(--ui-scale)（90 / 100 / 110%）。浮层挂在 body 里、用 fixed 坐标，
// 坐标是在 zoom 之后的坐标系里解释的，而 getBoundingClientRect() 给的是视觉坐标——
// 不除以 zoom 就是「缩放算两遍」：110% 右飘 80px、90% 左飘 66px。用户报的
// 「播放集下拉歪了」正是这个（只改锚点只能修好 100% 那一档）。
let scaleMaxDelta = 0;
for (const scale of [1.1, 0.9, 1]) {
  await page.evaluate((value) => {
    const raw = localStorage.getItem("ncl.ui.preferences.v1");
    const prefs = raw ? JSON.parse(raw) : {};
    prefs.scale = value;
    localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify(prefs));
  }, scale);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await openMenu();
  const measured = await measureAlign();
  if (!measured) throw new Error(`UI 缩放 ${scale} 下播放集浮层没渲染出来`);
  scaleMaxDelta = Math.max(scaleMaxDelta, Math.abs(measured.dLeft));
  console.log(
    `scale=${scale} zoom=${measured.zoom} dLeft=${measured.dLeft} dTop=${measured.dTop} inViewport=${measured.inViewport ? 1 : 0}`,
  );
  if (Math.abs(measured.dLeft) > 1) {
    throw new Error(`UI 缩放 ${scale} 下浮层未与胶囊对齐：Δleft=${measured.dLeft}px`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}
console.log(`scaleMaxDelta=${scaleMaxDelta} scaleCases=3`);

await openMenu();
const optionCount = await page.locator(".profile-menu-item").count();
const beforeValue = await currentLabel();

// 浮层左边界必须与外层胶囊（.profile-picker）左边界对齐。
// 曾经拿内层 .profile-trigger 当锚点：那个按钮从图标右侧才开始（图标 14px + 7px 间距），
// 菜单整体右飘约 11px；锚点换成外层胶囊后 Δ=0。
const align = await measureAlign();
if (!align) throw new Error("播放集浮层没渲染出来，无法校验对齐");
console.log(`alignLeft=${align.dLeft} alignInViewport=${align.inViewport ? 1 : 0}`);
if (Math.abs(align.dLeft) > 1) throw new Error(`播放集浮层左边界未与胶囊对齐：Δleft=${align.dLeft}px`);
if (!align.inViewport) throw new Error("播放集浮层超出窗口边界");

await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const beforeDeployed = await page.locator(".mod-card .badge, .mod-card .status-badge").count();

// 切到「纯净模式」
await openMenu();
await page.locator(".profile-menu-item", { hasText: "纯净模式" }).first().click();
await page.waitForTimeout(500);

const dialogVisible = await page.locator(".confirm-card, .modal-card, [role='dialog']").count();
await page.screenshot({ path: "shots/audit/interaction-profile-confirm.png" });

// 播放集切换走的是普通 ConfirmDialog（不是危险操作那种按住式），确认按钮文案是「开始切换」。
// 这里不能用 locator.click()：弹窗上有常驻动画（扫描线），Playwright 会一直等
// 「元素两帧位置一致」而永远等不到，最后报 element is not visible。
// 改成「取包围盒 + 真实鼠标点击坐标」，触发路径和用户点一下完全一样。
const confirmBox = await page.getByRole("button", { name: "开始切换" }).boundingBox();
if (!confirmBox) throw new Error("确认弹窗里找不到「开始切换」按钮");
await page.mouse.click(confirmBox.x + confirmBox.width / 2, confirmBox.y + confirmBox.height / 2);
await page.waitForTimeout(1800);

const afterValue = await currentLabel();
const toastText = await page.locator(".toast, .toast-item").first().innerText().catch(() => "");
await page.screenshot({ path: "shots/audit/interaction-profile-switched.png" });

// 设置页播放集面板在「游戏与路径」分区里（2026-11-13 从工具组件搬来）；不切标签页就是 display:none。
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(900);
await page.locator("#settings-tab-game").click();
await page.waitForTimeout(600);
await page.locator(".profile-panel").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
const rows = await page.locator(".profile-row").count();
await page.screenshot({ path: "shots/audit/interaction-profiles-panel.png" });

console.log(`options=${optionCount} before=${beforeValue} after=${afterValue} rows=${rows}`);
console.log(`dialog=${dialogVisible} toast=${toastText.replace(/\s+/g, " ").slice(0, 60)}`);
await browser.close();
