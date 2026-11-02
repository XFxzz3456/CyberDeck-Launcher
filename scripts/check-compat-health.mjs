// 兼容性体检的界面断言（任务 b014cf）。
//
// 要钉住的三件事，都是"别再吓用户"：
//   ① 版本号显示社区叫法（2.5），内部四段号只进 title；
//   ② 前置齐全时只给一条绿色结论，页面上不存在"兼容性未知"这类列表；
//   ③ 前置明细固定 4 行，状态用颜色点区分，不随 Mod 数量增长。
//
// 浏览器预览里 `compat_scan` 走 apiSafety 的演示数据（healthy=true），
// 所以这里验的是"健康态"渲染路径；有风险的路径由 Rust 单测覆盖。
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

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// 设置 → 安全与维护
await page.getByRole("button", { name: /设置/ }).first().click();
await page.waitForTimeout(600);
await page.getByRole("tab", { name: /安全与维护/ }).first().click();
await page.waitForTimeout(600);

const card = page.locator(".safety-card").first();
await card.waitFor({ state: "visible", timeout: 8000 });

// 点「检查兼容性」
await card.getByRole("button", { name: /检查兼容性/ }).first().click();
await page.waitForTimeout(900);

const readout = await page.evaluate(() => {
  const root = document.querySelector(".safety-card");
  if (!root) return null;
  const target = root.querySelector(".compat-target");
  const ok = root.querySelector(".compat-ok");
  const okText = ok ? ok.textContent.replace(/\s+/g, " ").trim() : "";
  const chips = Array.from(root.querySelectorAll(".compat-frameworks li")).map((li) => ({
    text: li.textContent.replace(/\s+/g, " ").trim(),
    status: li.getAttribute("data-status"),
  }));
  const blockText = root.querySelector(".compat-result")?.textContent || "";
  return {
    targetText: target ? target.textContent.replace(/\s+/g, " ").trim() : "",
    targetTitle: target ? target.getAttribute("title") || "" : "",
    okVisible: Boolean(ok),
    okText,
    healthyTitle: ok ? ok.querySelector("strong")?.textContent?.trim() || "" : "",
    chips,
    riskItems: root.querySelectorAll(".compat-list li").length,
    warnBlock: root.querySelectorAll(".compat-warn-block").length,
    // 旧实现的措辞：体检结果区里一个字都不该再出现。
    // 只看 .compat-result —— 卡片头部的"低于 2.5"是给降级玩家的说明文案，
    // 与本次重构无关，不该被这条断言误伤。
    legacyWording: /兼容性未知|待适配/.test(blockText),
  };
});

let failed = 0;
const check = (name, ok, extra = "", key = null) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (key) console.log(`${key}=${ok ? 1 : 0}`);
  if (!ok) failed += 1;
};

check("体检结果已渲染", Boolean(readout), "", "rendered");
if (readout) {
  // 预览里 mock 的游戏版本是 2.31（为了演示更新熔断），体检结果必须跟着它走，
  // 否则同一张卡片上下两处版本号不一样。这里钉的是"显示社区叫法、不回显四段号"。
  check(
    "版本显示社区叫法",
    readout.targetText.includes("2.31") && !/3\.0\./.test(readout.targetText),
    readout.targetText,
  );
  console.log(`targetIsCommunity=${readout.targetText.includes("2.31") ? 1 : 0}`);
  check("版本行带识别结论", /已识别/.test(readout.targetText), readout.targetText);
  console.log(`targetHasVerdict=${/已识别/.test(readout.targetText) ? 1 : 0}`);

  check("健康结论为绿条", readout.okVisible, readout.healthyTitle);
  console.log(`healthyBanner=${readout.okVisible ? 1 : 0}`);
  check("无风险时不给列表", readout.riskItems === 0, `items=${readout.riskItems}`);
  console.log(`riskItems=${readout.riskItems}`);
  console.log(`warnBlock=${readout.warnBlock}`);

  check("前置明细固定 4 行", readout.chips.length === 4, JSON.stringify(readout.chips.map((c) => c.text)));
  console.log(`frameworkChips=${readout.chips.length}`);
  check(
    "四行都是 ok 状态",
    readout.chips.every((chip) => chip.status === "ok"),
    JSON.stringify(readout.chips.map((chip) => chip.status)),
  );

  check("旧措辞已消失", !readout.legacyWording, "");
  console.log(`legacyWording=${readout.legacyWording ? 1 : 0}`);
}

console.log(`pageerrors=${pageErrors.length}`);
if (pageErrors.length > 0) console.log(pageErrors.join("\n"));

await browser.close();
process.exit(failed === 0 && pageErrors.length === 0 ? 0 : 1);
