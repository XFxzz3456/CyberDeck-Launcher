// 通知降噪验收（看板【通知/任务/活动三层】P1）。
//
// 为什么要有这个脚本：通知降噪改完如果只靠肉眼确认「好像没弹了」，下次手滑加回
// 一个 toast 没人会发现。这里把「连续开关 5 个模组」之后应该出现的结果钉死：
//   - 单次开关：完全静默（0 条 toast）——结果在卡片角标上看得见；
//   - 连串开关：2 秒合并窗口结束只留 **1 条** 汇总（走 deploy 类别，可被设置页关掉）；
//   - 任务中心：轻操作不再占一行任务（taskRows=0）；
//   - 活动流：逐条记，一条不少（铃铛面板内 activityRows>=5）；
//   - 卡片角标：5 张卡都得真的翻过来（badgesOk=1）。
//
// 浏览器（mock）模式：演示库里 Model 的开关走 mockApi.setModEnabled，
// 不碰真实游戏目录。演示库每个 Playwright 上下文都是新的，无需清理。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;
// 必须大于 lib/feedback.ts 里的合并窗口（2000ms），否则结算还没发生就断言了。
const SETTLE_MS = 2800;

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

const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  // 关掉动效与开机动画：动画会让「卡片还在过渡」和「角标没翻」看着一样。
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

// ── 0. 进入模组库 ───────────────────────────────────────────────────
await page.getByRole("button", { name: "模组库", exact: true }).click();
await page.waitForTimeout(700);
await page.waitForSelector(".mod-card", { timeout: 15_000 });

/** 读当前所有卡片：开关的名字（去掉「启用/禁用」前缀）与开关状态。 */
const readCards = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".mod-card")].map((card) => {
      const sw = card.querySelector('[role="switch"]');
      const label = sw?.getAttribute("aria-label") ?? "";
      return {
        name: label.replace(/^(启用|禁用)\s*/, ""),
        checked: sw?.getAttribute("aria-checked") === "true",
        // 缺前置的卡片点下去会弹「仍然启用」拦截弹窗，会挡住后续点击 —— 避开它们。
        missing: Boolean(card.querySelector(".cover-missing")),
      };
    }),
  );

/** 等所有卡片都忙完（busyId 期间该卡片的开关会 disabled）。 */
const settle = async () => {
  await page
    .waitForFunction(() => document.querySelectorAll(".mod-card.is-busy").length === 0, null, {
      timeout: 20_000,
    })
    .catch(() => {});
  await page.waitForTimeout(300);
};

/**
 * 按名字点一张卡片的开关：列表可能重排，所以每次都现场找下标。
 *
 * mode = "pointer"：走真实指针（第 1 步用它，顺便验证控件真的点得到）。
 *   某些断点下卡片底部操作条是「hover 才显形」的浮层（opacity 0 + pointer-events: none），
 *   不先 hover 会被 sibling 拦住，所以这里先移指针再点。
 * mode = "fast"：直接派发 click（第 2 步用它）——绕开命中测试与 actionability 等待，
 *   保证 5 次操作都落在同一个 2 秒合并窗口里；走的仍是 Toggle 的 onClick → onChange 真实链路。
 */
async function clickToggle(name, mode = "pointer") {
  const index = await page.evaluate((target) => {
    const cards = [...document.querySelectorAll(".mod-card")];
    return cards.findIndex((card) => {
      const label = card.querySelector('[role="switch"]')?.getAttribute("aria-label") ?? "";
      return label.replace(/^(启用|禁用)\s*/, "") === target;
    });
  }, name);
  if (index < 0) return false;
  const sw = page.locator(".mod-card").nth(index).locator('[role="switch"]');
  if (mode === "fast") {
    await sw.evaluate((el) => el.click());
    return true;
  }
  await page.locator(".mod-card").nth(index).hover().catch(() => {});
  await page.waitForTimeout(120);
  try {
    await sw.click({ timeout: 4000 });
  } catch {
    await sw.evaluate((el) => el.click());
  }
  return true;
}

const toastCount = () => page.locator(".toast-host .toast").count();
const taskRows = () => page.locator(".task-row").count();
// 活动流只在顶栏铃铛里渲染（2026-11-13 起任务中心不再重复一份），所以要先把面板打开。
const activityRows = async () => {
  const bell = page.locator(".btn-bell");
  if ((await bell.getAttribute("aria-expanded")) !== "true") {
    await bell.click();
    await page.waitForTimeout(300);
  }
  return page.locator(".bell-panel .activity-row").count();
};

const initial = await readCards();
const targets = initial.filter((card) => card.name && !card.missing).slice(0, 5);
check("演示库里有 5 张可操作的卡片", targets.length === 5, `cards=${targets.length}`, "targetsReady");
console.log(`  参与用例的卡片：${targets.map((card) => card.name).join(" / ")}`);

// ── 1. 单次开关：静默 ──────────────────────────────────────────────
await clickToggle(targets[0].name);
await settle();
await page.waitForTimeout(SETTLE_MS);
const afterSingleToasts = await toastCount();
check("单次开关不弹任何 toast", afterSingleToasts === 0, `toasts=${afterSingleToasts}`, "singleSilent");

// ── 2. 连续开关 5 个：只有一条汇总 ─────────────────────────────────
for (const target of targets) {
  await clickToggle(target.name, "fast");
}
await settle();
await page.waitForTimeout(SETTLE_MS);
const burstToasts = await toastCount();
check("连续开关 5 个模组：toast ≤ 1", burstToasts <= 1, `toasts=${burstToasts}`, "burstQuiet");

const batchText = burstToasts === 1 ? await page.locator(".toast-host .toast").first().innerText() : "";
check(
  "留下的是汇总 toast（含「已切换」与模组数）",
  burstToasts === 1 && batchText.includes("已切换"),
  batchText.replace(/\s+/g, " ").slice(0, 60),
  "batchToast",
);
check(
  "汇总 toast 不是常驻提醒（可自动消失）",
  burstToasts === 0 || (await page.locator(".toast-host .toast[data-sticky='1']").count()) === 0,
  "",
  "batchNotSticky",
);

// ── 3. 任务队列：轻操作不再占一行任务 ──────────────────────────────
const rows = await taskRows();
check("任务中心没有任何任务行", rows === 0, `taskRows=${rows}`, "taskRows");

// ── 4. 活动流：逐条记录，一条不少 ──────────────────────────────────
const activities = await activityRows();
check("活动流记录 ≥ 5 条（逐条记，不合并）", activities >= 5, `activityRows=${activities}`, "activityLogged");
console.log(
  `  活动流：${await page.evaluate(() =>
    [...document.querySelectorAll(".activity-row .activity-copy strong")].map((node) => node.textContent).join(" | "),
  )}`,
);

// ── 5. 卡片角标：5 张卡全部翻转 ────────────────────────────────────
const after = await readCards();
let flipped = 0;
const unflipped = [];
for (const target of targets) {
  const now = after.find((card) => card.name === target.name);
  // 连开关两次的那张（第 1 步 + 第 2 步）会回到初始状态，按「点了几次」算预期。
  const clicks = target.name === targets[0].name ? 2 : 1;
  const expected = clicks % 2 === 1 ? !target.checked : target.checked;
  if (now && now.checked === expected) flipped += 1;
  else unflipped.push(`${target.name}(期望 ${expected ? "开" : "关"})`);
}
check(
  "5 张卡片的角标与开关状态全部正确",
  flipped === targets.length,
  `${flipped}/${targets.length} ${unflipped.join("、")}`,
  "badgesOk",
);

await page.close();
await browser.close();
for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`);
// checks_failed 无论成败都要打：门禁拿它当「零失败」的硬判据，缺了就按失败算。
console.log(`checks_failed=${failed}`);
console.log(failed === 0 ? "ALL PASS" : `FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
