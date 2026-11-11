// 验证整合包对话框：入口、两种包形态、页签切换、导出按钮的可用性边界、弹窗不溢出。
//
// 只跑浏览器预览（mock 数据）：真正的打包 / 解包由 `cargo test --lib pack_tests`
// 覆盖，这里管的是「用户点得进去、看得懂、点得到」。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
});
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const results = [];
const check = (label, ok) => results.push(`${label}=${ok ? 1 : 0}`);

// 1) 入口：模组库「更多」菜单里应该有「整合包」。
await page.getByRole("button", { name: "更多" }).first().click();
await page.waitForTimeout(200);
const menuItems = await page.locator(".toolbar-menu-panel [role=menuitem]").allTextContents();
check("entry", menuItems.some((text) => text.trim() === "整合包"));
await page.getByRole("menuitem", { name: "整合包", exact: true }).click();
await page.waitForTimeout(500);

// 2) 结构：两个页签 + 两种包形态。
check("tabs", (await page.locator(".pack-tab").count()) === 2);
check("kinds", (await page.locator(".pack-kind").count()) === 2);

// 3) 导出按钮的边界：名字清空后必须禁用，填回来再启用。
const exportButton = page.getByRole("button", { name: /开始导出/ });
const nameInput = page.locator(".pack-field input").first();
const filledDisabled = await exportButton.isDisabled();
await nameInput.fill("");
await page.waitForTimeout(150);
const emptyDisabled = await exportButton.isDisabled();
await nameInput.fill("验收整合包");
await page.waitForTimeout(150);
const restoredDisabled = await exportButton.isDisabled();
check("nameGuard", filledDisabled === false && emptyDisabled === true && restoredDisabled === false);

// 4) 完整包形态：选中后应出现「完整包会带上无编号条目」的说明，且不再有勾选框。
await page.locator(".pack-kind").nth(1).click();
await page.waitForTimeout(200);
check("fullSelected", (await page.locator(".pack-kind.is-active").count()) === 1);
check("fullNote", (await page.locator(".pack-check").count()) === 0);

// 5) 导入页签：空态 + 「选择整合包」入口；未选包时「应用」必须禁用。
await page.getByRole("tab", { name: "导入" }).click();
await page.waitForTimeout(300);
check("emptyState", await page.getByText("还没有选整合包").first().isVisible());
check("applyGuard", await page.getByRole("button", { name: /应用整合包/ }).isDisabled());

// 6) 弹窗不得溢出视口（125% 缩放下曾把所有弹窗顶出去，见 .modal 的 max-height 计算）。
const box = await page.locator(".modal").first().evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    right: Math.round(window.innerWidth - rect.right),
    bottom: Math.round(window.innerHeight - rect.bottom),
  };
});
check(
  "inViewport",
  box.top >= 0 && box.left >= 0 && box.right >= 0 && box.bottom >= 0,
);

await page.screenshot({ path: "shots/gate/modpack.png" }).catch(() => {});
console.log(results.join(" "));
await browser.close();
