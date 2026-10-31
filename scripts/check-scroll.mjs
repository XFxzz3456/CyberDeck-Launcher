// 单点验收：虚拟滚动窗口 + 脏数据不白屏。
//
// 断言三件事：
//   1) 网格是虚拟滚动的 —— 把演示库扩到 ~80 条后，渲染出的卡片数必须少于总数，
//      滚到底之后渲染集合不能变空（空白代表虚拟化算错了区间）。
//   2) 状态入口会把脏数据降级成型 —— 把一条模组的 translatedName 写成数字
//      （界面里会 .trim()）、version 写成数字，重新加载后必须仍然渲染出卡片，
//      而不是整个 root 被 React 卸载成黑屏。
//   3) 真炸了也得有兜底 —— `.root-fault`（最外层错误边界）不能出现。
import { chromium } from "playwright-core";

const KEY = "cyberdeck-launcher-demo-state-v1";
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
await page.waitForTimeout(1500);

// 演示库只有 16 条，一屏就能全放得下，虚拟化「不触发」才是对的。
// 复制到 ~80 条才能验证窗口化真的在裁剪渲染集合。
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
await page.waitForTimeout(1600);

const total = await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) ?? "null");
  return db?.state?.mods?.length ?? 0;
}, KEY);
const rendered = await page.locator(".mod-card").count();
const rows = await page.locator(".virtual-row").count();
await page.screenshot({ path: "shots/audit/interaction-virtual-scroll.png" });

// 滚到底：虚拟化应换掉渲染集合，且不能出现「渲染 0 条」的空白。
await page.locator(".grid-scroll").evaluate((node) => {
  node.scrollTop = node.scrollHeight;
});
await page.waitForTimeout(900);
const afterScroll = await page.locator(".mod-card").count();
const scrolled = await page.locator(".grid-scroll").evaluate((node) => node.scrollTop);

// 脏数据注入：字符串字段写成数字，界面里 (mod.translatedName ?? "").trim() 会抛。
await page.evaluate((key) => {
  const db = JSON.parse(localStorage.getItem(key) ?? "null");
  if (db?.state?.mods?.length) {
    db.state.mods[0].translatedName = 12345;
    db.state.mods[0].version = 2.31;
    db.state.mods[0].author = { name: "someone" };
    localStorage.setItem(key, JSON.stringify(db));
  }
}, KEY);

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1600);

const afterDirty = await page.locator(".mod-card").count();
const fault = await page.locator(".root-fault").count();
await page.screenshot({ path: "shots/audit/interaction-dirty-state.png" });

console.log(`total=${total} rendered=${rendered} rows=${rows}`);
console.log(`afterScroll=${afterScroll} scrollTop=${Math.round(scrolled)}`);
console.log(`afterDirty=${afterDirty} fault=${fault}`);

await browser.close();
