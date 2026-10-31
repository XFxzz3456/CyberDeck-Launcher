/**
 * EULA 协议门专项验证（r14）。
 *
 * 覆盖：
 *  1. 未同意时主界面**照常渲染**在底层（.app-shell 存在且 inert），不是白屏；
 *  2. 遮罩 backdrop-filter = blur(8px) brightness(0.6)，点击/键盘被拦截；
 *  3. 勾选前「同意继续」禁用；勾选后 Enter 可确认，遮罩淡出后卸载；
 *  4. Modern 浅色：卡片灰边 rgba(0,0,0,0.06)、图标走正文色、「阅读全文」带箭头且可展开。
 *
 * 用法：先 `npm run dev`（端口 1420），再 `node scripts/check-eula-gate.mjs`
 */
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;
const results = [];
const fail = [];

function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) fail.push(name);
}

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox"],
});

async function openPage({ theme, mode, accept = false }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text());
  });
  await page.addInitScript(
    ({ theme, mode, accept }) => {
      window.localStorage.clear();
      if (theme) {
        window.localStorage.setItem(
          "ncl.ui.theme.v2",
          JSON.stringify({ styleTheme: theme, colorMode: mode }),
        );
      }
      if (accept) window.localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
    },
    { theme, mode, accept },
  );
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  return { page, errs };
}

/* ---------------- 场景 A：首启（默认 NCPD 暗色） ---------------- */
{
  const { page, errs } = await openPage({ theme: null, mode: null });

  const portal = await page.locator(".eula-portal").count();
  check("遮罩存在", portal === 1);

  // 核心：主界面必须在底层渲染出来（不是 return <EulaModal/> 的白屏）。
  const shell = await page.locator(".app-shell").count();
  const cards = await page.locator(".mod-card").count();
  check("底层主界面已渲染", shell === 1 && cards > 0, `shell=${shell} cards=${cards}`);

  const inert = await page.locator(".app-shell").evaluate((el) => el.hasAttribute("inert"));
  check("底层主界面已 inert", inert === true);

  const blur = await page
    .locator(".eula-backdrop")
    .evaluate((el) => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter);
  check("遮罩是 blur(8px) brightness(0.6)", /blur\(8px\)/.test(blur) && /brightness\(0\.6\)/.test(blur), blur);

  // 遮罩必须自己吃事件：底层的 app-shell 是 inert，若遮罩 pointer-events:none 就等于放行。
  const pe = await page
    .locator(".eula-portal")
    .evaluate((el) => getComputedStyle(el).pointerEvents);
  check("遮罩 pointer-events:auto", pe === "auto", pe);

  const summaryLabel = await page.locator("text=三句话版本").count();
  check("已删掉「三句话版本」", summaryLabel === 0);

  const acceptDisabled = await page.locator(".eula-actions .btn-primary").isDisabled();
  check("未勾选时同意按钮禁用", acceptDisabled === true);

  const disabledBg = await page
    .locator(".eula-actions .btn-primary")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  check("禁用态是灰底（不是半透明主色）", disabledBg !== "rgba(0, 0, 0, 0)", disabledBg);

  // 点底层侧边栏的位置：应该落在遮罩上，路由不变。
  const beforeView = await page.locator(".nav-item.active, .nav-link.active, .side-nav .active").first().getAttribute("class").catch(() => null);
  await page.mouse.click(120, 300);
  await page.waitForTimeout(250);
  const portalAfterClick = await page.locator(".eula-portal").count();
  const afterView = await page.locator(".nav-item.active, .nav-link.active, .side-nav .active").first().getAttribute("class").catch(() => null);
  check("点遮罩不穿透底层", portalAfterClick === 1 && beforeView === afterView);

  // Ctrl+K 不应打开命令面板
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(250);
  const palette = await page.locator(".palette, .command-palette").count();
  check("Ctrl+K 被协议门挡住", palette === 0);

  await page.screenshot({ path: "shots/eula-gate-ncpd.png" });
  check("无运行时错误", errs.length === 0, errs.slice(0, 3).join(" | "));
  await page.close();
}

/* ---------------- 场景 B：勾选 + Enter 确认 + 淡出 ---------------- */
{
  const { page } = await openPage({ theme: null, mode: null });

  await page.locator(".eula-consent input").check();
  const enabled = await page.locator(".eula-actions .btn-primary").isEnabled();
  check("勾选后同意按钮可用", enabled === true);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  const closing = await page.locator(".eula-portal.is-closing").count();
  check("点了之后进入淡出态", closing === 1);

  await page.waitForTimeout(500);
  const gone = await page.locator(".eula-portal").count();
  check("淡出后遮罩已卸载", gone === 0);

  const stillInert = await page.locator(".app-shell").evaluate((el) => el.hasAttribute("inert"));
  check("同意后底层恢复可交互", stillInert === false);

  const flag = await page.evaluate(() => window.localStorage.getItem("ncl.ui.eulaAccepted.v1"));
  check("同意状态已持久化", flag === "true");
  await page.close();
}

/* ---------------- 场景 C：Modern 浅色视觉细节 ---------------- */
{
  const { page } = await openPage({ theme: "modern", mode: "light" });

  const dialogBorder = await page
    .locator(".eula-dialog")
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  check("浅色卡片边框 rgba(0,0,0,0.06)", dialogBorder === "rgba(0, 0, 0, 0.06)", dialogBorder);

  const markColor = await page
    .locator(".eula-head-mark")
    .evaluate((el) => getComputedStyle(el).color);
  check("浅色下图标用正文色（加深对比）", markColor === "rgb(17, 24, 39)", markColor);

  const expandHasSvg = await page.locator(".eula-expand svg").count();
  const expandUnderline = await page
    .locator(".eula-expand")
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
  check("阅读全文带箭头 + 下划线", expandHasSvg === 1 && expandUnderline === "underline", `${expandHasSvg} ${expandUnderline}`);

  await page.locator(".eula-expand").click();
  await page.waitForTimeout(300);
  const expanded = await page.locator(".eula-expand").getAttribute("aria-expanded");
  const fullVisible = await page.locator(".eula-full").isVisible();
  const arrowRot = await page
    .locator(".eula-expand svg")
    .evaluate((el) => getComputedStyle(el).transform);
  check("展开全文生效且箭头翻转", expanded === "true" && fullVisible && /matrix\(-1/.test(arrowRot), `${expanded} ${arrowRot}`);

  await page.locator(".eula-expand").click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "shots/eula-gate-modern-light.png" });
  await page.close();
}

await browser.close();

console.log(results.join("\n"));
console.log(`\n合计 ${results.length} 项，失败 ${fail.length} 项`);
if (fail.length) {
  console.log("失败项：" + fail.join(" / "));
  process.exit(1);
}
