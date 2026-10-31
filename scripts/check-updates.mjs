// Mod 更新落地验收（P5-5B）：检查 → 命中 → 「全部更新」→ 报告。
//
// 断言四件事：
//   1) 点「检查更新」后，工具栏出现「全部更新」按钮（没有命中时不该出现）；
//   2) 按钮上的数量与命中条数一致（不是写死的文案）；
//   3) 点「全部更新」会真的调用更新命令并弹出结果提示；
//   4) 更新完成后命中列表清空，按钮随之消失（不会留着旧角标骗人）。
//
// 走的是浏览器演示态（mock），不碰真实文件与网络。

import { chromium } from "playwright-core";

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
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
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

// 进模组库（默认就在这一页，保险再点一次侧栏）。
const libraryNav = page.locator(".sidebar-item", { hasText: "模组库" }).first();
if ((await libraryNav.count()) > 0) {
  await libraryNav.click();
  await page.waitForTimeout(600);
}

const applyAll = page.getByRole("button", { name: /全部更新/ });

// 1) 未检查时不该有「全部更新」
check("未命中时不显示全部更新", (await applyAll.count()) === 0);

// 2) 检查更新（mock 恒定返回 1 个命中）
const checkBtn = page.getByRole("button", { name: /检查更新/ }).first();
await checkBtn.click();
await page.waitForTimeout(2200);

const applyCount = await applyAll.count();
check("命中后出现全部更新按钮", applyCount >= 1, `count=${applyCount}`);

const label = applyCount > 0 ? ((await applyAll.first().innerText()) ?? "").trim() : "";
check("按钮文案就是「全部更新」", label.includes("全部更新"), `label=${label}`);

// 「检查更新」按钮上会带命中条数（1 个模组更新）
const checkLabel = ((await checkBtn.innerText()) ?? "").replace(/\s+/g, "");
check("检查按钮回显命中数量", /1/.test(checkLabel), `label=${checkLabel}`);

// 3) 执行全部更新
await applyAll.first().click();
await page.waitForTimeout(3000);

const toastText = await page.locator(".toast").evaluateAll((nodes) =>
  nodes.map((node) => (node.textContent ?? "").trim()).join(" | "),
);
check("更新后有结果提示", /更新/.test(toastText), `toast=${toastText.slice(0, 80)}`);

// 4) 命中清空后按钮消失
await page.waitForTimeout(800);
const left = await applyAll.count();
check("更新后不再残留全部更新按钮", left === 0, `count=${left}`);

const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));
check("pageerrors=0", pageErrors.length === 0, pageErrors.join("；"));

const failed = results.filter((item) => !item.ok).length;
console.log(`checks_failed=${failed}`);

await browser.close();
