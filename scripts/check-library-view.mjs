// 模组库视图切换验收（bf7889 反馈）：卡片视图 ⇄ 列表视图。
//
// 断言五件事，缺一项都说明「只是换了个 class」：
//   1) 工具栏右侧真的有「网格 / 列表」两个按钮，默认落在网格；
//   2) 切到列表后卡片全消失、行出现，且行数少于总数 —— 证明列表也走虚拟滚动；
//   3) 行高统一（虚拟滚动靠固定行高估算，行高飘了会滚出空白带）；
//   4) 切到列表滚到底，渲染集合不为空（虚拟化区间没算错）；
//   5) 重新加载后仍是列表（偏好已落盘），再切回网格能恢复卡片。

import { chromium } from "playwright-core";

const KEY = "cyberdeck-launcher-demo-state-v1";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  // 跳过 EULA 门：未同意时 App 是 inert，点不动任何按钮。
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  // 只在首次进入时写默认偏好：addInitScript 每次导航都会跑，
  // 无条件覆盖会把「切到列表」的落盘结果抹掉，持久化就永远验证不到了。
  if (localStorage.getItem("ncl.ui.preferences.v1")) return;
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

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// 演示库只有 16 条，一屏放得下，虚拟化不会裁剪 —— 复制到 ~80 条才有意义。
await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) ?? "null");
  if (!db?.state?.mods) return;
  const base = db.state.mods;
  const clones = [];
  for (let round = 0; round < 4; round += 1) {
    for (const mod of base) {
      clones.push({
        ...mod,
        id: `${mod.id}-v${round}`,
        name: `${mod.name} V${round + 1}`,
        translatedName: null,
        deployedFiles: [],
        enabled: false,
      });
    }
  }
  db.state.mods = [...base, ...clones];
  localStorage.setItem(key, JSON.stringify(db));
}, KEY);

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const total = await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) ?? "null");
  return db?.state?.mods?.length ?? 0;
}, KEY);

const switchBtn = page.locator(".view-switch .view-switch-btn");
const gridBtn = page.locator('.view-switch-btn[data-view="grid"]');
const listBtn = page.locator('.view-switch-btn[data-view="list"]');

check("视图切换按钮在位", (await switchBtn.count()) === 2);
check(
  "默认是卡片视图",
  (await gridBtn.getAttribute("aria-pressed")) === "true" &&
    (await listBtn.getAttribute("aria-pressed")) === "false",
);

const gridCards = await page.locator(".mod-card").count();
check("网格渲染出卡片", gridCards >= 1, `cards=${gridCards}`);
await page.screenshot({ path: "shots/audit/library-view-grid.png" });

// ── 切到列表 ──────────────────────────────────────────────────────
await listBtn.click();
await page.waitForTimeout(600);

const listCards = await page.locator(".mod-card").count();
const listRows = await page.locator(".mod-row").count();
check("切换后卡片全部卸载", listCards === 0, `cards=${listCards}`);
check("列表渲染出行", listRows >= 1, `rows=${listRows}`);
check("列表同样是虚拟滚动", listRows < total, `rows=${listRows} total=${total}`);
check("列表按钮进入选中态", (await listBtn.getAttribute("aria-pressed")) === "true");

const heights = await page.locator(".mod-row").evaluateAll((nodes) =>
  nodes.slice(0, 5).map((node) => Math.round(node.getBoundingClientRect().height)),
);
// 42px 是列对齐后的行高（版本/分类/大小各占一列，名称不再需要第二行）。
// 必须与 VirtualModGrid 的 LIST_ROW_HEIGHT - 6 间距严格一致，否则虚拟滚动错位。
check(
  "行高统一且为 42px",
  heights.length > 0 && heights.every((value) => value === 42),
  `heights=${heights.join("/")}`,
);
// 分组折叠：列表视图默认按分类分组，组头可点、点完该组收起。
// 虚拟滚动按 header/row 两种固定高度切片，折叠后总高度必须跟着变。
const groupCount = await page.locator(".mod-group-head").count();
check("列表按分类分组", groupCount >= 1, `groups=${groupCount}`);
if (groupCount > 0) {
  await page.locator(".grid-scroll").evaluate((node) => {
    node.scrollTop = 0;
  });
  const rowsBefore = await page.locator(".mod-row").count();
  await page.locator(".mod-group-head").first().click();
  await page.waitForTimeout(200);
  const collapsed = await page.locator(".mod-group-head").first().getAttribute("aria-expanded");
  const rowsAfter = await page.locator(".mod-row").count();
  check("点组头后进入折叠态", collapsed === "false", `aria-expanded=${collapsed}`);
  check(
    "折叠后该组的行被收起",
    rowsAfter < rowsBefore || rowsBefore === 0,
    `before=${rowsBefore} after=${rowsAfter}`,
  );
  // 复原，后面的「滚到底 / 切回网格」按未折叠状态跑。
  await page.locator(".mod-group-head").first().click();
  await page.waitForTimeout(200);
}

await page.screenshot({ path: "shots/audit/library-view-list.png" });

// 滚到底：虚拟化应换掉渲染集合，且不能出现「渲染 0 条」的空白。
await page.locator(".grid-scroll").evaluate((node) => {
  node.scrollTop = node.scrollHeight;
});
await page.waitForTimeout(700);
const rowsAfterScroll = await page.locator(".mod-row").count();
check("列表滚到底仍渲染行", rowsAfterScroll >= 1, `rows=${rowsAfterScroll}`);

// ── 持久化 ────────────────────────────────────────────────────────
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1400);
const rowsAfterReload = await page.locator(".mod-row").count();
check("刷新后保持列表视图", rowsAfterReload >= 1, `rows=${rowsAfterReload}`);

// 切回网格：卡片要回来，行要清空。
await gridBtn.click();
await page.waitForTimeout(700);
const backCards = await page.locator(".mod-card").count();
const backRows = await page.locator(".mod-row").count();
check("切回网格恢复卡片", backCards >= 1 && backRows === 0, `cards=${backCards} rows=${backRows}`);

const failed = results.filter((item) => !item.ok).length;
console.log(`checks_failed=${failed}`);

await browser.close();
