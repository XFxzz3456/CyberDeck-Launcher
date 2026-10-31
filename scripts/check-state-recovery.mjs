// 状态文件恢复提示：坏文件被改名保留时，界面必须说清"模组没被删"。
//
// 背景：这条恢复支路以前只写 eprintln!，而打包后的 exe 没有控制台，
// 用户看到的就是"195 个模组被删了"。断言的正是"用户能不能知道"。
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const recoveredPath =
  "D:\\\\cyberdeck-data\\\\launcher-state.broken-20261026-155013.json";

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

// 第一趟：正常状态，不该出现这条红条。
await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
console.log("bannerClean=" + (await page.locator(".state-recovery-banner").count()));

// 第二趟：把 recovered 路径塞进快照（mock 用查询参数模拟），红条必须出现且带上路径。
await page.goto(
  `http://localhost:${process.env.GATE_PORT || 1420}/?recovered=${encodeURIComponent(recoveredPath)}`,
  { waitUntil: "networkidle" },
);
await page.waitForTimeout(1400);
const banner = page.locator(".state-recovery-banner", { hasText: "STATE RECOVERY" });
console.log("bannerRecovered=" + (await banner.count()));
const text = (await banner.count()) > 0 ? await banner.first().innerText() : "";
console.log("mentionsPath=" + (text.includes("launcher-state.broken-20261026-155013.json") ? 1 : 0));
console.log("mentionsDeleted=" + (text.includes("没有被删除") ? 1 : 0));
await page.screenshot({ path: "shots/audit/state-recovery-banner.png" });

await browser.close();
