// deepseek 四模块验收：部署方式/启动高级选项/暂存区建议（模块一）、
// 下载设置限速 + NXM 修复 + 下载中心折线/拖拽区（模块二）、
// 外部工具卡片与侧栏固定（模块三）、界面显示管理（模块四）。
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
await page.waitForTimeout(1200);

async function openSettingsTab(name) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole("tab", { name, exact: true }).click();
  await page.waitForTimeout(500);
}

// ── 模块一：游戏与路径 ──────────────────────────────────────────────
await openSettingsTab("游戏与路径");

const deployGroup = page.getByRole("group", { name: "部署方式" });
check("部署方式选择组渲染", (await deployGroup.count()) === 1, "", "deployGroup");
await deployGroup.getByRole("button", { name: "直接复制" }).click();
await page.waitForTimeout(1200);
const storedDeploy = await page.evaluate(() => {
  const db = JSON.parse(localStorage.getItem("cyberdeck-launcher-demo-state-v1") || "null");
  return db?.state?.settings?.deployMode ?? null;
});
check("部署方式「直接复制」写入设置", storedDeploy === "copy", String(storedDeploy), "deployCopySaved");

const gpuGroup = page.locator(".platform-chips").filter({ hasText: "独立显卡" });
check("显卡偏好 chips 渲染", (await gpuGroup.count()) >= 1, "", "gpuChips");
const priorityGroup = page.locator(".platform-chips").filter({ hasText: "高" }).filter({ hasText: "常规" });
check("进程优先级 chips 渲染", (await priorityGroup.count()) >= 1, "", "priorityChips");
check("前置命令输入渲染", (await page.getByPlaceholder(/RestartRouter/).count()) === 1, "", "preCommandInput");

// 暂存区建议：mock 返回 3 个磁盘
await page.getByRole("button", { name: "建议" }).click();
await page.waitForTimeout(900);
check("暂存区建议列表出现", (await page.locator(".drive-suggest").count()) === 1, "", "suggestList");
check("磁盘候选 3 行", (await page.locator(".drive-suggest-row").count()) === 3, "", "suggestRows");

// ── 模块二：下载设置（工具组件 Tab） ────────────────────────────────
await openSettingsTab("工具组件");
const speedGroup = page.getByRole("group", { name: "速度限制" });
check("限速按钮组渲染", (await speedGroup.count()) === 1, "", "speedGroup");
await speedGroup.getByRole("button", { name: "10", exact: true }).click();
await page.waitForTimeout(400);
// mock 的队列设置只存内存，不落 localStorage；断言 UI 选中态即可。
check(
  "限速 10 MiB/s 选中",
  (await speedGroup.getByRole("button", { name: "10", exact: true }).getAttribute("aria-pressed")) === "true",
  "",
  "speedSaved",
);

check("NXM 修复按钮渲染", (await page.getByRole("button", { name: /修复（接管协议）/ }).count()) === 1, "", "nxmRepair");
check("外部工具卡片渲染", (await page.locator('[data-testid="external-tools-card"]').count()) === 1, "", "toolsCard");
await page.waitForTimeout(600);
check("演示工具 2 行", (await page.locator('[data-testid="external-tool-row"]').count()) === 2, "", "toolRows");
await page.locator('[data-testid="external-tools-card"]').getByRole("button", { name: /添加工具/ }).click();
await page.waitForTimeout(300);
check("添加工具表单展开", (await page.locator(".tool-add-form").count()) === 1, "", "toolAddForm");

// 侧栏固定工具（demo WolvenKit pinned=true）
check("侧栏固定工具区出现", (await page.locator(".tool-nav-item:not(.quick-nav-item)").count()) === 1, "", "sidebarTool");

// ── 模块二：下载中心折线 + 拖拽区 ───────────────────────────────────
await page.getByRole("button", { name: /下载中心/ }).click();
await page.waitForTimeout(800);
check("速度折线卡渲染", (await page.locator(".dl-spark-card").count()) === 1, "", "sparkCard");
check("拖拽接收区渲染", (await page.locator(".dl-dropzone").count()) === 1, "", "dropzone");

// ── 模块四：左侧导航栏（界面显示管理） ──────────────────────────────
await openSettingsTab("个性化");
// P0 个性化页拆 6 卡后，这块从「界面显示管理」改名成「左侧导航栏」卡片：
// 卡存在 = 标题（appearance.groupNav）+ 说明（appearance.hiddenViewsHint）同时出现。
// 旧的 hiddenViewsLabel 文案已无组件引用，继续按旧名断言会永远失败。
const navCardTitle = await page.getByText("左侧导航栏", { exact: false }).count();
const navCardHint = await page.getByText("隐藏不常用的侧边栏入口", { exact: false }).count();
check(
  "界面显示管理区渲染",
  navCardTitle >= 1 && navCardHint >= 1,
  `title=${navCardTitle} hint=${navCardHint}`,
  "hiddenViewsCard",
);
const discoverSwitch = page.getByRole("switch", { name: "发现（N 网检索）" });
check("「发现」开关渲染", (await discoverSwitch.count()) === 1, "", "discoverSwitch");
await discoverSwitch.click();
await page.waitForTimeout(400);
check("隐藏「发现」后侧栏无发现入口", (await page.locator(".sidebar").getByText("发现", { exact: true }).count()) === 0, "", "discoverHidden");
const persistedHidden = await page.evaluate(() => localStorage.getItem("ncl.ui.hiddenViews.v1"));
check("隐藏状态持久化", (persistedHidden ?? "").includes("discover"), persistedHidden ?? "null", "hiddenPersisted");
// 恢复
await discoverSwitch.click();
await page.waitForTimeout(300);
check("重新打开后入口恢复", (await page.locator(".sidebar").getByText("发现", { exact: true }).count()) === 1, "", "discoverRestored");

await page.close();
await browser.close();
for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`);
console.log(failed === 0 ? "ALL PASS" : `checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
