// AI 预设目录的守卫（r22）。
//
// 预设从「一家一个模型」扩成「厂商 → 模型」两级、并按国外/国内/本地三分区展示
// 之后，容易复发的不是接口坏掉，而是：分区标题没了、选项只剩模型名没有 ID、
// 选了模型把用户已经填好的接口地址冲掉、本地部署的模型名被锁成只读。
// 这四件事都不会让编译失败，只会让「预设」变成负担。
//
// 断言六件事：
//   1. 服务商下拉框有且只有三个分区，且标题顺序为 国外厂商 / 国内厂商 / 本地部署；
//   2. 每个分区里都有条目，厂商总数 ≥ 14；
//   3. 「模型预设」选项同时给出显示名称与模型 ID（形如 `名称 · id`）；
//   4. 选厂商 → 模型名与接口地址一起填对；
//   5. 选模型 → 只改模型名，**不覆盖**已填的接口地址；
//   6. 本地部署分区：模型名输入框可自由编辑，并显示「填写你已下载的模型名称」提示。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const GROUPS = ["国外厂商", "国内厂商", "本地部署"];

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
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
await page.waitForTimeout(1400);
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(500);
await page.locator("#settings-tab-ai").click();
await page.waitForTimeout(600);

const card = page.locator("section.panel", { hasText: "AI 助手配置" }).first();
/** 服务商下拉框：第一个 select，带 aria-label。 */
const vendorSelect = card.locator('select[aria-label="选择 AI 服务商预设"]');
const modelSelect = card.locator('select[aria-label="选择该服务商下的模型预设"]');
const modelInput = card.locator(".settings-field", { hasText: "模型名称" }).locator("input").first();
const urlInput = card.locator(".settings-field", { hasText: "接口地址" }).locator("input").first();

// 1) 三个分区，顺序固定。
const groupLabels = (await vendorSelect.locator("optgroup").evaluateAll((nodes) =>
  nodes.map((node) => node.getAttribute("label") ?? ""),
)).map((text) => text.trim());
console.log("groups=" + groupLabels.length);
console.log("groupOrder=" + (JSON.stringify(groupLabels) === JSON.stringify(GROUPS) ? 1 : 0));

// 2) 每个分区都不是空壳，厂商总数够多。
const counts = [];
for (const label of GROUPS) {
  const n = await vendorSelect
    .locator(`optgroup[label="${label}"] option`)
    .count();
  counts.push(`${label}:${n}`);
  console.log(`group.${GROUPS.indexOf(label) + 1}=${n}`);
}
const vendorTotal = await vendorSelect.locator("optgroup option").count();
console.log("vendors=" + vendorTotal);
console.log("vendorSummary=" + counts.join(","));

// 3) 每个厂商的模型选项都要带 ID：`显示名称 · 模型ID`，且 ID 不含空格。
let sampleOk = 1;
let sampleCount = 0;
for (const label of GROUPS) {
  const vendors = vendorSelect.locator(`optgroup[label="${label}"] option`);
  const n = await vendors.count();
  for (let i = 0; i < n; i += 1) {
    const value = await vendors.nth(i).getAttribute("value");
    await vendorSelect.selectOption(value);
    await page.waitForTimeout(120);
    const options = await modelSelect.locator("option").allInnerTexts();
    // 第一项是「共 N 个预设模型」的占位，跳过。
    for (const text of options.slice(1)) {
      sampleCount += 1;
      if (!/ · \S/.test(text)) sampleOk = 0;
    }
  }
}
console.log("modelOptions=" + sampleCount);
console.log("modelOptionHasId=" + sampleOk);
await vendorSelect.selectOption("");
await page.waitForTimeout(200);

// 4) 选厂商 → 地址与模型一起填对（xAI 是单模型厂商，最不容易含糊）。
await vendorSelect.selectOption("xai");
await page.waitForTimeout(250);
console.log("vendorUrlFilled=" + ((await urlInput.inputValue()).includes("api.x.ai") ? 1 : 0));
console.log("vendorModelFilled=" + ((await modelInput.inputValue()) === "grok-4.7" ? 1 : 0));

// 5) 选模型只改模型名，不覆盖用户已填的地址。
await urlInput.fill("https://my-proxy.example.com/v1");
await vendorSelect.selectOption("anthropic");
await page.waitForTimeout(250);
await urlInput.fill("https://my-proxy.example.com/v1");
await modelSelect.selectOption("claude-haiku-5-5");
await page.waitForTimeout(250);
console.log("modelPicked=" + ((await modelInput.inputValue()) === "claude-haiku-5-5" ? 1 : 0));
console.log("urlKept=" + ((await urlInput.inputValue()) === "https://my-proxy.example.com/v1" ? 1 : 0));
console.log(
  "urlHintShown=" + ((await card.locator("small").allInnerTexts()).join(" ").includes("api.anthropic.com") ? 1 : 0),
);

// 6) 本地部署：手改模型名可行，且有「填写你已下载的模型名称」的提示。
await vendorSelect.selectOption("ollama");
await page.waitForTimeout(300);
await modelInput.fill("my-local-model:7b");
await page.waitForTimeout(150);
console.log("localEditable=" + ((await modelInput.isEditable()) ? 1 : 0));
console.log("localValueKept=" + ((await modelInput.inputValue()) === "my-local-model:7b" ? 1 : 0));
console.log(
  "localHintShown=" +
    ((await card.locator("small").allInnerTexts()).join(" ").includes("已下载的模型名称") ? 1 : 0),
);

await browser.close();
