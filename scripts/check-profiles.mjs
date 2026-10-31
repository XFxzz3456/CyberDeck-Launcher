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

await openMenu();
const optionCount = await page.locator(".profile-menu-item").count();
const beforeValue = await currentLabel();
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

// 设置页播放集面板在「工具组件」分区里（不是游戏分区）；不切标签页就是 display:none。
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(900);
await page.locator("#settings-tab-tools").click();
await page.waitForTimeout(600);
await page.locator(".profile-panel").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
const rows = await page.locator(".profile-row").count();
await page.screenshot({ path: "shots/audit/interaction-profiles-panel.png" });

console.log(`options=${optionCount} before=${beforeValue} after=${afterValue} rows=${rows}`);
console.log(`dialog=${dialogVisible} toast=${toastText.replace(/\s+/g, " ").slice(0, 60)}`);
await browser.close();
