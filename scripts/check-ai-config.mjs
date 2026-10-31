// AI 配置页的「协议中立」守卫。
//
// 接入方式从「只支持 DeepSeek」改成「任何兼容 OpenAI 协议的服务」之后，最容易
// 复发的问题不是功能坏了，而是文案/徽标又悄悄长回某一家服务商：徽标写着某家
// 模型名、抬头写着某家品牌、预设下拉框永远停在「手动配置…」。这些都不会让
// 测试失败，只会让用户以为「这个启动器只支持那一家」。
//
// 断言五件事：
//   1. 卡片的「框架级文案」（徽标/标题/说明）里不出现任何一家服务商的品牌名；
//   2. 徽标说的是协议（OPENAI 兼容），不是某家模型；
//   3. 已保存的地址 + 模型名能被反查成预设，下拉框不会退化成「手动配置…」；
//   4. 「接口协议」下拉框存在，默认 OpenAI 兼容，两个选项齐全（r21）；
//   5. 切到 Anthropic 原生后，Base URL 提示切到官方地址口径（r21）。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const VENDORS = ["deepseek", "moonshot", "kimi", "ollama", "通义", "qwen"];

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
await page.waitForTimeout(1400);
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(500);
await page.locator("#settings-tab-ai").click();
await page.waitForTimeout(600);

const card = page.locator("section.panel", { hasText: "AI 助手配置" }).first();

// 徽标必须是协议口径。
const badge = (await card.locator(".panel-head .badge").allInnerTexts()).join(" ");
console.log("protocol=" + (/OPENAI/i.test(badge) ? 1 : 0));

// 框架级文案（不含预设下拉里的选项文本与用户自己的地址/模型输入）不得出现品牌名。
const chrome = [
  (await card.locator(".panel-eyebrow").allInnerTexts()).join(" "),
  (await card.locator(".panel-head h2").allInnerTexts()).join(" "),
  (await card.locator("small").allInnerTexts()).join(" "),
  (await card.locator(".panel-note").allInnerTexts()).join(" "),
  (await card.locator(".settings-field > span").allInnerTexts()).join(" "),
]
  .join(" ")
  .toLowerCase();
console.log("chromeVendor=" + (VENDORS.some((name) => chrome.includes(name)) ? 1 : 0));

// 已保存配置必须能被反查成预设，否则下拉框会和输入框互相矛盾。
const presetLabel = await card.locator("select").first().locator("option:checked").innerText();
console.log("preset=" + presetLabel.trim());
console.log("presetMatched=" + (presetLabel.trim() === "手动配置…" ? 0 : 1));

// r21：「接口协议」下拉框——默认 OpenAI 兼容，两个选项齐全。
// r22：预设扩成「厂商 → 模型」两级后，多出一个「模型预设」下拉框，
// 按下标取控件会错位。改用 aria-label 定位，新增字段不再影响它。
const protocolSelect = card.locator('select[aria-label="接口协议"]');
const protocolOptions = (await protocolSelect.locator("option").allInnerTexts()).map((s) => s.trim());
console.log("protocolField=" +
  (protocolOptions.includes("OpenAI 兼容") && protocolOptions.includes("Anthropic 原生") ? 1 : 0));
console.log("protocolDefault=" +
  ((await protocolSelect.locator("option:checked").innerText()).trim() === "OpenAI 兼容" ? 1 : 0));

// r21：切到 Anthropic 原生后，Base URL 提示要换成官方地址口径。
await protocolSelect.selectOption("anthropic");
await page.waitForTimeout(300);
const anthropicHint = (await card.locator(".settings-field small").allInnerTexts()).join(" ");
console.log("anthropicHint=" + (/api\.anthropic\.com\/v1/.test(anthropicHint) ? 1 : 0));
console.log("anthropicProxyNote=" + (anthropicHint.includes("中转站") ? 1 : 0));
await protocolSelect.selectOption("openai");
await page.waitForTimeout(300);

// 诊断面板：徽标同样是协议口径，模型名改在正文里如实显示。
await page.getByRole("button", { name: "运行诊断", exact: true }).click();
await page.waitForTimeout(1500);
const panel = page.locator("section.ai-panel");
const diagBadges = (await panel.locator(".panel-head .badge").allInnerTexts()).join(" ");
console.log("diagProtocol=" + (/OPENAI/i.test(diagBadges) ? 1 : 0));
console.log("diagVendorBadge=" +
  (VENDORS.some((name) => diagBadges.toLowerCase().includes(name)) ? 1 : 0));
const sendNote = (await panel.locator(".ai-send-note").innerText()).replace(/\s+/g, " ");
console.log("diagModelShown=" + (/当前模型\s*\S+/.test(sendNote) ? 1 : 0));

await browser.close();
