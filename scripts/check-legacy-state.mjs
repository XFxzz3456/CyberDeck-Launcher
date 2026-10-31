// 复现「老 localStorage 无 profiles」场景，确认不再白屏
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

// 先写一份「旧结构」状态：有 mods/settings，但没有 profiles / activeProfileId
await page.addInitScript(() => {
  const oldState = {
    schemaVersion: 1,
    gameDir: "D:\\Games\\Cyberpunk 2077",
    stagingDir: "C:\\Users\\mc236\\.cyberdeck.loader\\staging",
    mods: [
      {
        id: "old-mod-1",
        name: "Old Mod",
        version: "1.0.0",
        author: "tester",
        description: "旧记录",
        category: "玩法",
        enabled: true,
        deployedFiles: [],
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        layout: "gameRoot",
        plannedFiles: [],
        coverPath: null,
        nexus: null,
        stagingPath: "C:\\Users\\mc236\\.cyberdeck.loader\\staging\\old-mod-1",
        fileCount: 1,
        bytes: 1024,
        conflicts: [],
        translatedName: null,
        translatedAt: null,
        translatedBy: null,
        managed: true,
        origin: "cyberdeck",
        modpackId: null,
        nexusCoverUrl: null,
      },
    ],
    loadOrder: [],
    modpacks: [],
    settings: {},
    lastGameVersion: "2.31",
    lastLaunch: null,
    backup: null,
    // 故意不写 profiles / activeProfileId
  };
  localStorage.setItem(
    "ncl.ui.preferences.v1",
    JSON.stringify({ theme: "arasaka", useCustomAccent: false, accent: "#ff4058", scale: 1, sidebarCollapsed: false }),
  );
  localStorage.setItem(
    "cyberdeck-launcher-demo-state-v1",
    JSON.stringify({ state: oldState, gameDir: "D:\\Games\\Cyberpunk 2077" }),
  );
});

await page.goto(`http://localhost:${process.env.GATE_PORT || 1420}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const cards = await page.locator(".mod-card").count();
const picker = await page.locator(".profile-select option").count();
await page.screenshot({ path: "shots/audit/interaction-legacy-state.png" });

// 再进设置页看播放集面板
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(800);
const rows = await page.locator(".profile-row").count();
await page.screenshot({ path: "shots/audit/interaction-legacy-profiles.png" });

console.log(`cards=${cards} options=${picker} rows=${rows} errors=${errors.length}`);
if (errors.length) console.log(errors.slice(0, 3).join(" | "));
await browser.close();
