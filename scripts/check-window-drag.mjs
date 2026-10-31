// 顶部窗口拖动通路回归：鼠标不重复触发；触屏/手写笔走 Pointer Events；
// 搜索框与窗口按钮不得被当作拖动把手。invoke 仅测试替身，不代表真实窗口位移。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
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

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
    localStorage.setItem("ncl.ui.preferences.v1", JSON.stringify({
      theme: "arasaka", useCustomAccent: false, accent: "#ff4058",
      scale: 1, sidebarCollapsed: false, animations: false, splash: false,
    }));
    const calls = [];
    window.__dragTestCalls = calls;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command) => {
        calls.push(command);
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:event|unlisten") return null;
        return null;
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
    };
  });
  await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".titlebar");
  await page.waitForTimeout(500);

  const touchAction = await page.evaluate(() =>
    [".titlebar", ".topbar"].map((selector) => getComputedStyle(document.querySelector(selector)).touchAction),
  );
  check("两条顶部栏禁止触摸滚动接管", touchAction.every((value) => value === "none"), touchAction.join("/"), "touchAction");

  const dragCount = () => page.evaluate(() => window.__dragTestCalls.filter((cmd) => cmd === "plugin:window|start_dragging").length);
  const firePointer = (selector, pointerType, pointerId) => page.locator(selector).evaluate((node, options) => {
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      pointerType: options.pointerType, pointerId: options.pointerId,
      clientX: rect.left + Math.min(30, rect.width / 2), clientY: rect.top + rect.height / 2,
    }));
  }, { pointerType, pointerId });

  await firePointer(".titlebar-brand", "touch", 11);
  await page.waitForFunction(() => window.__dragTestCalls.includes("plugin:window|start_dragging"));
  check("触屏按下标题栏发起拖动", await dragCount() === 1, `calls=${await dragCount()}`, "touchDrag");

  await page.evaluate(() => {
    // Chromium 构造事件时不可直接指定 sourceCapabilities，这里只补真实兼容事件的标识。
    const event = new MouseEvent("mousedown", { bubbles: true, button: 0 });
    Object.defineProperty(event, "sourceCapabilities", { value: { firesTouchEvents: true } });
    document.querySelector(".titlebar-brand").dispatchEvent(event);
  });
  check("触摸后的兼容鼠标事件不重复拖动", await dragCount() === 1, `calls=${await dragCount()}`, "noDuplicateMouse");

  await firePointer(".titlebar-brand", "pen", 12);
  await page.waitForFunction(() => window.__dragTestCalls.filter((cmd) => cmd === "plugin:window|start_dragging").length === 2);
  check("手写笔按下标题栏发起拖动", await dragCount() === 2, `calls=${await dragCount()}`, "penDrag");

  await page.locator(".topbar-search input").evaluate((node) => node.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, button: 0, pointerType: "touch", pointerId: 13,
  })));
  await page.getByRole("button", { name: "最小化", exact: true }).evaluate((node) => node.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, button: 0, pointerType: "pen", pointerId: 14,
  })));
  check("触摸搜索框不触发拖动", await dragCount() === 2, `calls=${await dragCount()}`, "searchNotDrag");
  check("手写笔点窗口按钮不触发拖动", await dragCount() === 2, `calls=${await dragCount()}`, "buttonNotDrag");

  await page.locator(".titlebar-brand").click({ position: { x: 20, y: 10 } });
  await page.waitForFunction(() => window.__dragTestCalls.filter((cmd) => cmd === "plugin:window|start_dragging").length === 3);
  check("真实鼠标路径仍只触发一次", await dragCount() === 3, `calls=${await dragCount()}`, "mouseSingle");

  await firePointer(".topbar", "touch", 15);
  await page.waitForFunction(() => window.__dragTestCalls.filter((cmd) => cmd === "plugin:window|start_dragging").length === 4);
  check("触屏按下搜索栏空白区发起拖动", await dragCount() === 4, `calls=${await dragCount()}`, "topbarTouch");
  await page.close();
} finally {
  await browser.close();
}
for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`);
// 成功时也要显式报 0：门禁按 key=value 断言，只打印 "ALL PASS" 会被判成缺失。
console.log(`checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
