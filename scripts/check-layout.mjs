/**
 * 布局骨架专项验证：任意窗口尺寸下侧栏底部不消失、不重叠，页面不横向溢出。
 *
 * 用法：先 `npm run dev`（端口 1420），再 `node scripts/check-layout.mjs`
 */
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;

/** [宽, 高, 期望最少卡片列数] —— 最窄一档必须已经收成单列。 */
const SIZES = [
  [1440, 900, 3],
  [1280, 800, 2],
  [1100, 720, 2],
  [960, 640, 2],
  [900, 600, 2],
  [820, 560, 1],
];

const results = [];
const fail = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) fail.push(name);
}

const browser = await chromium.launch({ executablePath: edge, headless: true, args: ["--no-sandbox"] });

for (const [width, height, minCols] of SIZES) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errs = [];
  page.on("pageerror", (error) => errs.push(String(error)));
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
    window.localStorage.setItem(
      "ncl.ui.preferences.v1",
      JSON.stringify({ useCustomAccent: false, accent: "#fcee0a", scale: 1, sidebarCollapsed: false, animations: false }),
    );
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    // r25 起矮窗口按「窗口高 ÷ 缩放」分档逐级让位（data-vh-compact/tight/mini），
    // STAGING / 版本号行会被有意隐藏——断言要按档位判断「该不该可见」，而不是一刀切。
    const root = document.documentElement;
    const tier = root.dataset.vhTier ?? "full";
    return {
      tier,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sidebar: rect(".sidebar"),
      game: rect(".sidebar-game"),
      storage: rect(".sidebar-storage"),
      collapse: rect(".sidebar-collapse"),
      footer: rect(".sidebar-footer"),
      contentOverflowX: (() => {
        const el = document.querySelector(".content-shell");
        return el ? el.scrollWidth - el.clientWidth : 0;
      })(),
      cardsPerRow: (() => {
        const row = document.querySelector(".virtual-row");
        return row ? row.children.length : 0;
      })(),
      toolbarOverflow: (() => {
        const el = document.querySelector(".library-toolbar");
        return el ? el.scrollWidth - el.clientWidth : 0;
      })(),
    };
  });

  const tag = `${width}x${height}`;
  // 档位语义（viewportTier.ts）：compact 只压矮 STAGING（标题行仍在）、
  // tight 隐掉 STAGING、mini 再隐掉版本号行。
  const storageExpected = m.tier === "full" || m.tier === "compact";
  const footerExpected = m.tier !== "mini";
  check(`${tag} 页面无脚本错误`, errs.length === 0, errs[0] ?? "");
  check(`${tag} 无全窗横向溢出`, m.docOverflowX <= 0, `${m.docOverflowX}px`);
  check(`${tag} 内容区无横向溢出`, m.contentOverflowX <= 0, `${m.contentOverflowX}px`);
  check(`${tag} 工具条不裁切按钮`, m.toolbarOverflow <= 0, `${m.toolbarOverflow}px`);
  check(`${tag} 游戏路径卡可见`, m.game !== null && m.game.height > 60, m.game ? `${Math.round(m.game.height)}px` : "missing");
  check(
    `${tag} STAGING 区 ${storageExpected ? "可见" : "按档位隐藏"}（tier=${m.tier}）`,
    storageExpected ? m.storage !== null && m.storage.height > 10 : m.storage === null || m.storage.height === 0,
    m.storage ? `${Math.round(m.storage.height)}px` : "hidden",
  );
  check(
    `${tag} 版本号行 ${footerExpected ? "可见" : "按档位隐藏"}（tier=${m.tier}）`,
    footerExpected ? m.footer !== null && m.footer.height > 10 : m.footer === null || m.footer.height === 0,
    m.footer ? `${Math.round(m.footer.height)}px` : "hidden",
  );
  check(
    `${tag} 底部可见区块沉在侧栏内不重叠`,
    m.game && m.collapse && m.sidebar &&
      m.game.bottom <= m.sidebar.bottom + 1 &&
      m.collapse.bottom <= m.sidebar.bottom + 1 &&
      (!m.storage || m.storage.height === 0 || m.game.bottom <= m.storage.top + 1) &&
      (!m.footer || m.footer.height === 0 || (!m.storage || m.storage.height === 0 || m.storage.bottom <= m.collapse.top + 1)),
  );
  check(`${tag} 卡片列数 ≥ ${minCols}`, m.cardsPerRow >= minCols, `${m.cardsPerRow} 列`);
  await page.close();
}

await browser.close();
console.log("\n" + results.join("\n"));
console.log(`\n合计 ${results.length - fail.length}/${results.length} 通过`);
if (fail.length > 0) {
  console.log("失败项：" + fail.join(" / "));
  process.exit(1);
}
