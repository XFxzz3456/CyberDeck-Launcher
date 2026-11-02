// AI 诊断「可执行修复」验收（任务：AI 只能提动作，动文件必须由人点确认）。
//
// 钉住四件事：
//   ① 文字报告仍在（fixSteps 列表不因为加了动作而消失）；
//   ② 动作按钮真的渲染出来，且点击后**先弹二次确认**，不确认绝不执行；
//   ③ 确认后才调后端，并把「已创建快照」如实告诉用户；
//   ④ 全程无页面异常。
//
// 浏览器预览走 mock：aiDiagnose 会返回两条演示动作，aiApplyAction 只改内存不落盘。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));

await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
  if (!localStorage.getItem("ncl.ui.preferences.v1")) {
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
  }
});

let failed = 0;
const check = (name, ok, extra = "", key = null) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (key) console.log(`${key}=${ok ? 1 : 0}`);
  if (!ok) failed += 1;
};

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// 侧栏「运行诊断」→ 诊断页（AI 面板就在这一页）
await page.getByRole("button", { name: "运行诊断", exact: true }).click();
await page.waitForTimeout(800);

// 勾选同意 → 开始分析（预览里 mock 1.2s 返回）
await page.locator(".ai-consent input[type=checkbox]").first().check();
await page.getByRole("button", { name: /开始分析|重新分析/ }).first().click();
await page.locator(".ai-action-btn").first().waitFor({ timeout: 12000 });

const readout = await page.evaluate(() => {
  const steps = document.querySelectorAll(".ai-block ol li").length;
  const buttons = Array.from(document.querySelectorAll(".ai-action-btn")).map((node) =>
    node.textContent.replace(/\s+/g, " ").trim(),
  );
  const hint = document.querySelector(".ai-action-hint");
  return {
    steps,
    buttons,
    hintText: hint ? hint.textContent.trim() : "",
    afterActionNote: document.querySelector(".ai-action-note")?.textContent ?? "",
  };
});

check("文字报告仍在", readout.steps >= 1, `${readout.steps} 条步骤`);
console.log(`reportSteps=${readout.steps >= 1 ? 1 : 0}`);

check("动作按钮已渲染", readout.buttons.length >= 1, readout.buttons.join(" | "));
console.log(`actionButtons=${readout.buttons.length}`);

check("按钮下方有执行说明", /快照/.test(readout.hintText), readout.hintText.slice(0, 40));
console.log(`actionHint=${/快照/.test(readout.hintText) ? 1 : 0}`);

// 点第一条动作：必须弹确认，且此时还没产生任何执行结果
await page.locator(".ai-action-btn").first().click();
const modal = page.locator(".modal, [role=dialog]").first();
await modal.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
const confirmText = await page.evaluate(() => {
  const dialog = document.querySelector(".modal, [role=dialog]");
  return dialog ? dialog.textContent.replace(/\s+/g, " ") : "";
});
check("点击后先弹二次确认", /执行这条修复/.test(confirmText), confirmText.slice(0, 60));
console.log(`confirmShown=${/执行这条修复/.test(confirmText) ? 1 : 0}`);
check("确认框写明会建快照", /快照/.test(confirmText), "");
console.log(`confirmMentionsSnapshot=${/快照/.test(confirmText) ? 1 : 0}`);

// 取消：不该执行
await page.getByRole("button", { name: "取消", exact: true }).first().click();
await page.waitForTimeout(400);
const noteAfterCancel = await page.evaluate(
  () => document.querySelector(".ai-action-note")?.textContent ?? "",
);
check("取消后不执行", noteAfterCancel.trim().length === 0, noteAfterCancel);
console.log(`cancelNoop=${noteAfterCancel.trim().length === 0 ? 1 : 0}`);

// 再来一次并确认执行
await page.locator(".ai-action-btn").first().click();
await page.getByRole("button", { name: "确认执行", exact: true }).first().click();
await page.locator(".ai-action-note").first().waitFor({ timeout: 8000 });
const doneNote = await page.locator(".ai-action-note").first().innerText();
check("执行后给出结果与快照号", /已执行/.test(doneNote) && /快照/.test(doneNote), doneNote);
console.log(`actionApplied=${/已执行/.test(doneNote) ? 1 : 0}`);
console.log(`snapshotReported=${/快照/.test(doneNote) ? 1 : 0}`);

console.log(`pageerrors=${pageErrors.length}`);
if (pageErrors.length > 0) console.log(pageErrors.join("\n"));

await browser.close();
process.exit(failed === 0 && pageErrors.length === 0 ? 0 : 1);
