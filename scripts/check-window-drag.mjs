// 顶部窗口拖动通路回归（r41 重构后）。
//
// 契约变了：拖动**只**由 Tauri 注入的 drag.js 驱动（data-tauri-drag-region），
// 应用侧不允许再有任何 startDragging() 的 JS 调用——两套通路并存时，同一次
// mousedown 会各调一次 plugin:window|start_dragging，第二次落进第一次已开启的
// 系统模态拖动循环，窗口位移叠加成跟着鼠标跑的花白残影。
//
// 所以这里断言三件事：
//   1) 静态：windowDrag.ts 已删除，标题栏/搜索栏源码里没有 startDragging 字样；
//   2) 运行期：页面代码点下拖动区不产生任何 start_dragging invoke（浏览器里没注入
//      drag.js，因此计数必须为 0，非 0 就说明 JS 通路又长回来了）；
//   3) 语义：按 tauri 2.12.5 drag.js 的 isDragRegion 算法复算判定矩阵——
//      文字/空白区可拖，按钮/输入框/下拉框不可拖。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = fileURLToPath(new URL("../", import.meta.url));
let failed = 0;
const flags = {};
const check = (name, ok, extra = "", key = null) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (key) flags[key] = ok ? 1 : 0;
  if (!ok) failed += 1;
};

// ── 1) 静态：JS 拖拽通路必须彻底消失 ────────────────────────────────
const legacyModule = `${root}src/lib/windowDrag.ts`;
check("旧的 windowDrag.ts 已删除", !existsSync(legacyModule), legacyModule, "legacyModuleGone");

const sourceOf = (file) => readFileSync(`${root}src/components/${file}`, "utf8");
// 注释里会解释「这里以前调过 startDragging」，所以必须先剥注释再判代码，
// 否则检查退化成「不许在注释里提这件事」。
const codeOf = (file) =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const titlebarCode = codeOf("TitleBar.tsx");
const topbarCode = codeOf("TopBar.tsx");
const noJsDrag = [titlebarCode, topbarCode].every(
  (text) => !/startDragging\s*\(/.test(text) && !/onPointerDown\s*=/.test(text) && !/beginWindowDrag/.test(text),
);
check("标题栏/搜索栏源码无 startDragging 调用", noJsDrag, "", "noJsDragSource");

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

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

  // ── 2) 属性契约 ────────────────────────────────────────────────
  const attrs = await page.evaluate(() => {
    const read = (selector) => {
      const node = document.querySelector(selector);
      return node ? node.getAttribute("data-tauri-drag-region") : "__missing__";
    };
    return {
      titlebar: read(".titlebar"),
      topbar: read(".topbar"),
      controls: read(".titlebar-controls"),
      search: read(".topbar-search"),
      profile: read(".profile-picker"),
      actions: read(".topbar-actions"),
    };
  });
  check("标题栏为深拖动区（deep）", attrs.titlebar === "deep", `attr=${attrs.titlebar}`, "titlebarDeep");
  check("搜索栏为深拖动区（deep）", attrs.topbar === "deep", `attr=${attrs.topbar}`, "topbarDeep");
  check(
    "按钮组/搜索框/档案选择器显式禁拖（false）",
    [attrs.controls, attrs.search, attrs.profile, attrs.actions].every((value) => value === "false"),
    `controls=${attrs.controls} search=${attrs.search} profile=${attrs.profile} actions=${attrs.actions}`,
    "falseRegions",
  );

  // ── 3) 运行期：页面代码不得自己发起拖动 ──────────────────────────
  const dragCalls = () => page.evaluate(() =>
    window.__dragTestCalls.filter((cmd) => cmd === "plugin:window|start_dragging").length);

  await page.locator(".brand-name").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, button: 0, detail: 1,
      clientX: rect.left + 4, clientY: rect.top + rect.height / 2,
    }));
  });
  await page.locator(".topbar").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, button: 0, detail: 1,
      clientX: rect.left + 6, clientY: rect.top + rect.height / 2,
    }));
  });
  await page.waitForTimeout(150);
  check("点下拖动区不再由页面代码发起拖动", (await dragCalls()) === 0, `calls=${await dragCalls()}`, "noJsInvoke");

  // ── 4) 判定矩阵：复算 drag.js 的 isDragRegion ────────────────────
  const matrix = await page.evaluate(() => {
    const CLICKABLE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
    const ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);
    const isClickable = (node) =>
      CLICKABLE.has(node.tagName)
      || (node.hasAttribute("contenteditable") && node.getAttribute("contenteditable") !== "false")
      || (node.hasAttribute("tabindex") && node.getAttribute("tabindex") !== "-1")
      || ROLES.has(node.getAttribute("role"));

    // 与 tauri-2.12.5/src/window/scripts/drag.js 的 isDragRegion 同构。
    const wouldDrag = (target) => {
      const path = [];
      for (let node = target; node; node = node.parentElement) path.push(node);
      for (const node of path) {
        const attr = node.getAttribute("data-tauri-drag-region");
        if (isClickable(node) && attr === null) return false;
        if (attr === null) continue;
        if (attr === "false") return false;
        if (attr === "deep") return true;
        if (attr === "" || attr === "true") return node === path[0];
      }
      return false;
    };

    const probe = (selector) => {
      const node = document.querySelector(selector);
      return node ? wouldDrag(node) : "__missing__";
    };
    return {
      brandText: probe(".brand-name"),
      buildText: probe(".titlebar-build"),
      titlebarBare: probe(".titlebar"),
      topbarBare: probe(".topbar"),
      searchInput: probe(".topbar-search input"),
      searchBox: probe(".topbar-search"),
      profileSelect: probe(".profile-select"),
      minimize: probe(".window-btn"),
      bell: probe(".btn-bell"),
    };
  });
  check(
    "标题栏文字区可拖（deep 覆盖子树）",
    matrix.brandText === true && matrix.buildText === true && matrix.titlebarBare === true,
    `brand=${matrix.brandText} build=${matrix.buildText} bar=${matrix.titlebarBare}`,
    "titlebarDraggable",
  );
  check("搜索栏空白区可拖", matrix.topbarBare === true, `topbar=${matrix.topbarBare}`, "topbarDraggable");
  check(
    "输入框/下拉框/按钮均不触发拖动",
    matrix.searchInput === false
      && matrix.searchBox === false
      && matrix.profileSelect === false
      && matrix.minimize === false
      && matrix.bell === false,
    `input=${matrix.searchInput} box=${matrix.searchBox} select=${matrix.profileSelect} min=${matrix.minimize} bell=${matrix.bell}`,
    "interactiveBlocked",
  );

  // ── 5) 拖动时不得画文字选区（白斑残影的第二个来源）──────────────
  const style = await page.evaluate(() => {
    const read = (selector, prop) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node)[prop] : "__missing__";
    };
    return {
      titlebarSelect: read(".titlebar", "userSelect"),
      topbarSelect: read(".topbar", "userSelect"),
      inputSelect: read(".topbar-search input", "userSelect"),
      touchAction: [read(".titlebar", "touchAction"), read(".topbar", "touchAction")],
    };
  });
  check(
    "两条顶部栏禁止文字选区",
    style.titlebarSelect === "none" && style.topbarSelect === "none",
    `${style.titlebarSelect}/${style.topbarSelect}`,
    "noSelection",
  );
  check("搜索输入框仍可选词", style.inputSelect === "text", `input=${style.inputSelect}`, "inputSelectable");
  check(
    "两条顶部栏禁止触摸滚动接管",
    style.touchAction.every((value) => value === "none"),
    style.touchAction.join("/"),
    "touchAction",
  );

  await page.close();
} finally {
  await browser.close();
}
for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`);
// 成功时也要显式报 0：门禁按 key=value 断言，只打印 "ALL PASS" 会被判成缺失。
console.log(`checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
