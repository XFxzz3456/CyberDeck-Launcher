/**
 * 动效专项验证。
 *
 * r15：设置页 Tabs 下划线 + ModCard 悬停 + 开关行为。
 * r19：抽屉滑入/退场、弹窗弹入、路由切换、关闭动效后的瞬移。
 *
 * 用法：先 `npm run dev`（端口 1420），再 `node scripts/check-motion.mjs`
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

const browser = await chromium.launch({ executablePath: edge, headless: true, args: ["--no-sandbox"] });

async function openPage({ animations = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (error) => errs.push(String(error)));
  await page.addInitScript(
    ({ animations }) => {
      window.localStorage.clear();
      window.localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
      window.localStorage.setItem(
        "ncl.ui.preferences.v1",
        JSON.stringify({ useCustomAccent: false, accent: "#fcee0a", scale: 1, sidebarCollapsed: false, animations }),
      );
    },
    { animations },
  );
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  return { page, errs };
}

/* ---------------- 场景 A：动效开 —— 下划线随选中项移动 ---------------- */
{
  const { page, errs } = await openPage();
  check("A 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  await page.getByRole("button", { name: /设置/ }).first().click();
  await page.waitForTimeout(700);

  const underlineInActiveTab = await page.evaluate(() => {
    const active = document.querySelector(".settings-tab.active");
    return Boolean(active?.querySelector(".settings-tab-underline"));
  });
  check("A 下划线挂在选中 Tab 内", underlineInActiveTab);

  // 切到第二个标签：下划线（layoutId）应该移动到新选中项里
  const secondTab = page.locator(".settings-tab").nth(1);
  await secondTab.click();
  await page.waitForTimeout(450);
  const moved = await page.evaluate(() => {
    const active = document.querySelector(".settings-tab.active");
    const underline = document.querySelector(".settings-tab-underline");
    return Boolean(active && underline && active.contains(underline));
  });
  check("A 切换标签后下划线跟随", moved);

  // framer 接管期间 CSS ::after 必须退位，不能出现两条线
  const pseudoHidden = await page.evaluate(() => {
    const active = document.querySelector(".settings-tab.active");
    return getComputedStyle(active, "::after").display === "none";
  });
  check("A CSS ::after 已退位", pseudoHidden);

  // ModCard 悬停：弹簧动画应该真的发生（采样期间出现非零位移）
  await page.getByRole("button", { name: /模组库/ }).first().click();
  await page.waitForTimeout(600);
  const card = page.locator(".mod-card").first();
  await card.hover();
  const movedSamples = [];
  for (let i = 0; i < 8; i += 1) {
    movedSamples.push(
      await page.evaluate(() => {
        const matrix = getComputedStyle(document.querySelector(".mod-card")).transform;
        const match = matrix.match(/matrix\(([^)]+)\)/);
        return match ? Number.parseFloat(match[1].split(",").pop()) : 0;
      }),
    );
    await page.waitForTimeout(70);
  }
  const lifted = movedSamples.some((value) => value < -1);
  check(
    "A 悬停时卡片有 framer 弹簧位移",
    lifted,
    `samples=${movedSamples.map((value) => value.toFixed(1)).join(" → ")}`,
  );
  await page.close();
}

/* ---------------- 场景 B：动效关 —— 一切瞬移 ---------------- */
{
  const { page, errs } = await openPage({ animations: false });
  check("B 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  const dataset = await page.evaluate(() => document.documentElement.dataset.motion);
  check("B data-motion=off 落到 DOM", dataset === "off", dataset);

  await page.getByRole("button", { name: /设置/ }).first().click();
  await page.waitForTimeout(600);
  const framerUnderline = await page.evaluate(() => document.querySelectorAll(".settings-tab-underline").length);
  check("B framer 下划线未挂载", framerUnderline === 0);

  const pseudoVisible = await page.evaluate(() => {
    const active = document.querySelector(".settings-tab.active");
    const style = getComputedStyle(active, "::after");
    return style.display !== "none" && style.height === "2px";
  });
  check("B 下划线退回 CSS ::after", pseudoVisible);

  // 过渡时长被压成 0
  const zeroTransition = await page.evaluate(() => {
    const el = document.querySelector(".settings-tab");
    return getComputedStyle(el).transitionDuration;
  });
  check("B CSS 过渡时长归零", /^0s/.test(zeroTransition), zeroTransition);

  // 开关本身能从设置里切回来
  await page.locator("#settings-tab-appearance").click();
  await page.waitForTimeout(500);
  const switchRow = page.locator(".switch-row", { hasText: "界面动效" });
  check("B 外观页有「界面动效」开关", (await switchRow.count()) === 1);
  await switchRow.locator("button[role=switch], .toggle").first().click();
  await page.waitForTimeout(400);
  const datasetAfter = await page.evaluate(() => document.documentElement.dataset.motion);
  check("B 点开关后 data-motion=on", datasetAfter === "on", datasetAfter);
  await page.screenshot({ path: "shots/motion-toggle.png" });
  await page.close();
}

/* ---------------- 场景 C：主题差异化 —— 赛博家族「咔哒」，modern 柔和 -------- */
/**
 * 用悬停采样反推弹簧阻尼：赛博族 400/20（阻尼比≈0.53）会越过 -3px 一点，
 * modern 族 520/30/mass0.6（阻尼比≈0.85）几乎不过冲。曲线本身可观测，
 * 所以这里断言的是「过冲量」，不是内部参数。
 */
async function sampleHoverMin(styleTheme) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (error) => errs.push(String(error)));
  await page.addInitScript(
    ({ styleTheme }) => {
      window.localStorage.clear();
      window.localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
      window.localStorage.setItem(
        "ncl.ui.preferences.v1",
        JSON.stringify({ useCustomAccent: false, accent: "#fcee0a", scale: 1, sidebarCollapsed: false, animations: true }),
      );
      window.localStorage.setItem(
        "ncl.ui.theme.v2",
        JSON.stringify({ styleTheme, colorMode: "dark" }),
      );
    },
    { styleTheme },
  );
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /模组库/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator(".mod-card").first().hover();
  const samples = [];
  for (let i = 0; i < 14; i += 1) {
    samples.push(
      await page.evaluate(() => {
        const matrix = getComputedStyle(document.querySelector(".mod-card")).transform;
        const match = matrix.match(/matrix\(([^)]+)\)/);
        return match ? Number.parseFloat(match[1].split(",").pop()) : 0;
      }),
    );
    await page.waitForTimeout(50);
  }
  await page.close();
  return { min: Math.min(...samples), errs };
}

{
  const cyber = await sampleHoverMin("ncpd");
  const soft = await sampleHoverMin("modern");
  check("C 两套主题页面均无脚本错误", cyber.errs.length === 0 && soft.errs.length === 0, cyber.errs[0] ?? soft.errs[0] ?? "");
  // 赛博族：过冲越过 -3，min 应明显小于 -3
  check("C 赛博主题未达 -3 即过冲（机械感）", cyber.min < -3.2, `min=${cyber.min.toFixed(2)}`);
  // modern：几乎不过冲，min 贴近 -3 但不越过 -3.2
  check("C modern 主题不过冲（柔和）", soft.min > -3.2, `min=${soft.min.toFixed(2)}`);
  check("C 两套弹簧曲线确实不同", Math.abs(cyber.min - soft.min) > 0.15, `cyber=${cyber.min.toFixed(2)} soft=${soft.min.toFixed(2)}`);
}

/* ---------------- 场景 D：抽屉滑入 + 退场保挂载 ---------------- */
{
  const { page, errs } = await openPage();
  check("D 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  await page.getByRole("button", { name: /模组库/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator(".mod-card").first().click();

  const frames = [];
  for (let i = 0; i < 10; i += 1) {
    frames.push(
      await page.evaluate(() => {
        const el = document.querySelector(".drawer");
        if (!el) return null;
        const cs = getComputedStyle(el);
        const m = cs.transform.match(/matrix\(([^)]+)\)/);
        const backdrop = document.querySelector(".drawer-backdrop");
        return {
          x: m ? Number.parseFloat(m[1].split(",")[4]) : 0,
          opacity: Number.parseFloat(cs.opacity),
          backdrop: backdrop ? Number.parseFloat(getComputedStyle(backdrop).opacity) : null,
        };
      }),
    );
    await page.waitForTimeout(45);
  }
  const seen = frames.filter(Boolean);
  const maxX = seen.length ? Math.max(...seen.map((f) => f.x)) : 0;
  const last = seen[seen.length - 1] ?? { x: 999, backdrop: null };
  check("D 抽屉从右侧滑入（采样到横向位移）", maxX > 40, `maxX=${maxX.toFixed(1)}px`);
  check("D 抽屉终态精确归位", Math.abs(last.x) < 1.5, `lastX=${last.x.toFixed(2)}px`);
  check(
    "D 遮罩随入场淡入",
    seen.some((f) => f.backdrop !== null && f.backdrop < 0.9),
    `min=${Math.min(...seen.map((f) => f.backdrop ?? 1)).toFixed(2)}`,
  );

  // 关闭：退场动画期间必须仍挂载，但不能再挡住点击
  await page.locator(".drawer-backdrop").click({ position: { x: 24, y: 24 } });
  const exiting = await page.evaluate(() => ({
    count: document.querySelectorAll(".drawer").length,
    pe: getComputedStyle(document.querySelector(".drawer-portal")).pointerEvents,
  }));
  check("D 退场期间抽屉仍挂载（退出动画真实存在）", exiting.count === 1, `count=${exiting.count}`);
  check("D 退场期间不挡点击", exiting.pe === "none", exiting.pe);
  await page.waitForTimeout(520);
  const gone = await page.evaluate(() => document.querySelectorAll(".drawer").length);
  check("D 退场结束后彻底卸载", gone === 0, `count=${gone}`);
  await page.close();
}

/* ---------------- 场景 E：弹窗弹入 ---------------- */
{
  const { page, errs } = await openPage();
  check("E 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  await page.getByRole("button", { name: "导入模组", exact: true }).first().click();
  const scales = [];
  for (let i = 0; i < 8; i += 1) {
    scales.push(
      await page.evaluate(() => {
        const el = document.querySelector(".modal");
        if (!el) return null;
        const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
        return m ? Number.parseFloat(m[1].split(",")[0]) : 1;
      }),
    );
    await page.waitForTimeout(40);
  }
  const known = scales.filter((value) => value !== null);
  const minScale = known.length ? Math.min(...known) : 1;
  const finalScale = known[known.length - 1] ?? 0;
  check("E 弹窗从缩放态弹入", minScale < 0.999, `min=${minScale.toFixed(3)}`);
  check("E 弹窗收尾精确 1（文字不发虚）", Math.abs(finalScale - 1) < 0.002, `last=${finalScale.toFixed(4)}`);

  await page.locator(".modal-head .icon-btn").click();
  const exiting = await page.evaluate(() => ({
    count: document.querySelectorAll(".modal").length,
    pe: getComputedStyle(document.querySelector(".modal-portal")).pointerEvents,
  }));
  check("E 退场期间弹窗仍挂载", exiting.count === 1, `count=${exiting.count}`);
  check("E 退场期间不挡点击", exiting.pe === "none", exiting.pe);
  await page.waitForTimeout(320);
  const gone = await page.evaluate(() => document.querySelectorAll(".modal").length);
  check("E 退场结束后彻底卸载", gone === 0, `count=${gone}`);
  await page.close();
}

/* ---------------- 场景 F：路由切换（mode="wait"） ---------------- */
{
  const { page, errs } = await openPage();
  check("F 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  await page.getByRole("button", { name: /模组库/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /设置/ }).first().click();

  const frames = [];
  for (let i = 0; i < 10; i += 1) {
    frames.push(
      await page.evaluate(() => {
        const stages = [...document.querySelectorAll(".view-stage")];
        const cs = stages[0] ? getComputedStyle(stages[0]) : null;
        const m = cs ? cs.transform.match(/matrix\(([^)]+)\)/) : null;
        return {
          count: stages.length,
          opacity: cs ? Number.parseFloat(cs.opacity) : null,
          x: m ? Number.parseFloat(m[1].split(",")[4]) : 0,
        };
      }),
    );
    await page.waitForTimeout(35);
  }
  check("F 换页期间不叠加两个视图", frames.every((f) => f.count <= 1), `max=${Math.max(...frames.map((f) => f.count))}`);
  check(
    "F 换页真的有过渡帧",
    frames.some((f) => (f.opacity !== null && f.opacity < 0.95) || Math.abs(f.x) > 1.5),
    `minOpacity=${Math.min(...frames.map((f) => f.opacity ?? 1)).toFixed(2)} maxX=${Math.max(...frames.map((f) => Math.abs(f.x))).toFixed(1)}`,
  );
  await page.waitForTimeout(700);
  const landed = await page.evaluate(() => {
    const stage = document.querySelector(".view-stage");
    return {
      settings: Boolean(stage?.querySelector(".settings-page")),
      count: document.querySelectorAll(".view-stage").length,
      opacity: stage ? Number.parseFloat(getComputedStyle(stage).opacity) : null,
    };
  });
  check("F 换页最终落在设置页", landed.settings);
  check("F 稳定后仅剩一个视图舞台", landed.count === 1, `count=${landed.count}`);
  check("F 稳定后完全不透明", landed.opacity === 1, `opacity=${landed.opacity}`);
  await page.close();
}

/* ---------------- 场景 G：关闭动效后抽屉瞬现瞬退 ---------------- */
{
  const { page, errs } = await openPage({ animations: false });
  check("G 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  await page.getByRole("button", { name: /模组库/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator(".mod-card").first().click();
  await page.waitForTimeout(40);
  const state = await page.evaluate(() => {
    const el = document.querySelector(".drawer");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const m = cs.transform.match(/matrix\(([^)]+)\)/);
    return {
      opacity: Number.parseFloat(cs.opacity),
      x: m ? Number.parseFloat(m[1].split(",")[4]) : 0,
    };
  });
  check(
    "G 关闭动效后抽屉瞬现（无位移、全不透明）",
    state !== null && state.opacity === 1 && Math.abs(state.x) < 1,
    JSON.stringify(state),
  );

  await page.locator(".drawer-hero .icon-btn").last().click();
  await page.waitForTimeout(120);
  const gone = await page.evaluate(() => document.querySelectorAll(".drawer").length);
  check("G 关闭动效后抽屉瞬退", gone === 0, `count=${gone}`);
  await page.close();
}

await browser.close();

console.log("\n" + results.join("\n"));
console.log(`\n合计 ${results.length - fail.length}/${results.length} 通过`);
if (fail.length > 0) {
  console.log("失败项：" + fail.join(" / "));
  process.exit(1);
}
