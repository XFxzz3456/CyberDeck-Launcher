// 排版层级（字重）回归（r42 重构后）。
//
// 背景：全局原有 74 处 font-weight，取值散落在 400/500/600/650/700/800/900。
// --font 栈首的 "Microsoft YaHei UI" 只有 Regular(400) 与 Bold(700) 两个字面，
// Chromium 按 CSS Fonts 的匹配算法把 600/650 吸附到 700 真字面、把 500 吸附到
// 400 —— 于是「区块小标题」和「页面大标题」一样粗、和正文一样细，层级整层塌掉。
//
// 所以这里锁死三条契约：
//   1) 静态：styles.css 里不许再出现字面数字字重（除刻意保留的 12 处 400），
//      一律引用 --fw-* 令牌；也不许出现 600/650/800/900 这些本机无字面的档位；
//   2) 运行期：页面上任何元素的计算字重只允许 400 / 500 / 700 三档；
//   3) 语义：页面大标题 700、区块标题 500、设置项标题 12px/500/主文字色、
//      说明 11px/400、辅助小字 10.5px/400/次级灰、等宽样张 400/次级文字色，
//      开关为无边框药丸型。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = fileURLToPath(new URL("../", import.meta.url));
let failed = 0;
const check = (name, ok, extra = "", key = null) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (key) console.log(`${key}=${ok ? 1 : 0}`);
  if (!ok) failed += 1;
};

// 样式不止 styles.css 一份：还有 4 个组件级 CSS（Help / Safety / Splash /
// GlossaryShare）。2026-10-31 第一次跑这个脚本时就栽在这——只扫了主样式表，
// 于是 .help-trigger-text strong 的 600 从侧门溜过去，页面上仍有一处比正文重
// 两档的元素。这里必须全量扫。
const collectCss = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      collectCss(full, acc);
    } else if (name.endsWith(".css")) {
      acc.push(full);
    }
  }
  return acc;
};
const CSS_FILES = collectCss(path.join(root, "src"));
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(`${root}src/styles.css`, "utf8"));
const allCss = CSS_FILES.map((f) => ({ file: path.relative(root, f), text: strip(readFileSync(f, "utf8")) }));
// 令牌定义只在主样式表里查一次（--fw-* 只该在 styles.css 定义），
// 但「有没有被引用」必须全量 CSS 一起看：组件级 CSS（Splash / Help / Safety /
// GlossaryShare）里引用令牌完全合法。2026-11-03 就踩了这个坑——--fw-logo 被
// 移到 SplashScreen.css 后，只在 styles.css 里数引用会误判成 0 次的孤儿令牌。
const cssAllText = allCss.map((f) => f.text).join("\n");

// ── 1) 静态：字重全部令牌化（全量 CSS）────────────────────────────
// 刻意保留 400 的 12 处（行内数值/统计，历史误用已修，不许抬回去）。
const literalHits = [];
for (const { file, text } of allCss) {
  for (const m of text.matchAll(/font-weight:\s*(\d+)\s*;/g)) literalHits.push({ file, value: m[1] });
}
const literal = literalHits.map((h) => h.value);
const nonBodyLiteral = literalHits.filter((h) => h.value !== "400");
check(
  "全部 CSS 无字面数字字重（400 除外）",
  nonBodyLiteral.length === 0,
  `files=${CSS_FILES.length} literal=${literal.length} 非400=${nonBodyLiteral.map((h) => `${h.file}:${h.value}`).join(",") || "无"}`,
  "noLiteralWeight",
);
check("保留的 400 声明共 12 处", literal.length === 12, `got=${literal.length}`, "keep400Count");

// 本机字族没有 600/650/800/900 字面，写出来只会被吸附或退化，纯误导。
const phantom = literal.filter((v) => ["600", "650", "800", "900"].includes(v));
check("无 600/650/800/900 幽灵档位", phantom.length === 0, `got=${phantom.join(",") || "无"}`, "noPhantomWeight");

// ── 2) 静态：令牌定义齐备且各一次 ────────────────────────────────
const TOKENS = ["display", "title", "label", "body", "hint", "mono", "badge", "logo"];
const tokenState = TOKENS.map((name) => {
  const defs = [...css.matchAll(new RegExp(`--fw-${name}:\\s*(\\d+)`, "g"))];
  const uses = [...cssAllText.matchAll(new RegExp(`var\\(--fw-${name}\\)`, "g"))].length;
  return { name, defs: defs.length, value: defs[0]?.[1] ?? null, uses };
});
check(
  "8 个字重令牌各定义一次且被引用",
  tokenState.every((t) => t.defs === 1 && t.uses > 0),
  tokenState.map((t) => `${t.name}=${t.value}/${t.uses}次`).join(" "),
  "tokensDefined",
);
check(
  "令牌取值符合三档规范（仅 400/500/700）",
  tokenState.every((t) => ["400", "500", "700"].includes(t.value)),
  tokenState.map((t) => `${t.name}:${t.value}`).join(" "),
  "tokenValues",
);

// 禁止浏览器合成粗体：缺字面时回退真字面，而不是糊一层假粗体。
check("声明 font-synthesis-weight: none", /font-synthesis-weight:\s*none/.test(css), "", "noSynthWeight");
check(
  "body 启用灰度抗锯齿",
  /-moz-osx-font-smoothing:\s*grayscale/.test(css) && /-webkit-font-smoothing:\s*antialiased/.test(css),
  "",
  "fontSmoothing",
);

// ── 3) 运行期 ────────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => {
    localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
    localStorage.setItem(
      "ncl.ui.preferences.v1",
      JSON.stringify({
        theme: "ncpd",
        useCustomAccent: false,
        accent: "#fcee0a",
        scale: 1,
        sidebarCollapsed: false,
        animations: false,
        splash: false,
      }),
    );
    localStorage.setItem("ncl.ui.theme.v2", JSON.stringify({ styleTheme: "modern", colorMode: "dark" }));
  });
  await page.goto(`http://localhost:${process.env.GATE_PORT || "1420"}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  // 进设置页 → 个性化 tab（无需真实后端，桌面端命令失败不影响样式渲染）
  const nav = page.locator(".sidebar .nav-item", { hasText: "设置" }).first();
  if (await nav.count()) {
    await nav.click();
    await page.waitForTimeout(2200);
  }
  const tab = page.locator("#settings-tab-appearance");
  if (await tab.count()) {
    await tab.click();
    await page.waitForTimeout(600);
  }

  const probe = await page.evaluate(() => {
    const varColor = (name) => {
      const el = document.createElement("span");
      el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
      el.style.color = `var(${name})`;
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        weight: cs.fontWeight,
        size: Math.round(parseFloat(cs.fontSize) * 100) / 100,
        color: cs.color,
        radius: cs.borderTopLeftRadius,
        borderWidth: cs.borderTopWidth,
        bg: cs.backgroundColor,
      };
    };

    // 全页字重扫描：只允许 400 / 500 / 700
    const offenders = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const w = cs.fontWeight;
      if (["400", "500", "700", "normal", "bold"].includes(w)) continue;
      const key = `${w}|${(typeof el.className === "string" ? el.className : "").split(" ")[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offenders.push({ bad: `${w}|${key.split("|")[1]}`, text: (el.textContent || "").trim().slice(0, 18) });
    }

    const onTrack = document.querySelector(".toggle.is-on .toggle-track");
    const offTrack = document.querySelector(".toggle:not(.is-on) .toggle-track");

    return {
      vars: { text: varColor("--text"), text2: varColor("--text-2"), muted2: varColor("--muted-2") },
      h1: pick(".page-head h1"),
      panelHead: pick(".panel-head h2"),
      switchTitle: pick(".switch-title"),
      switchDesc: pick(".switch-desc"),
      bgHint: pick(".bg-hint"),
      cardHint: pick(".appearance-card-hint"),
      codePreview: pick(".font-preview-code"),
      toggleTrack: pick(".toggle-track"),
      onBg: onTrack ? getComputedStyle(onTrack).backgroundColor : null,
      offBg: offTrack ? getComputedStyle(offTrack).backgroundColor : null,
      offenders,
    };
  });

  check("页面上无 600/650/800/900 计算字重", probe.offenders.length === 0, JSON.stringify(probe.offenders.slice(0, 5)), "noPhantomComputed");

  const eq = (sel, got, want) => {
    const ok = got !== null && String(got) === String(want);
    check(`${sel} = ${want}`, ok, `got=${got}`, null);
    return ok;
  };

  if (!probe.h1) {
    check("设置页渲染出 .page-head h1", false, "选择器未命中，页面可能没进设置页");
  } else {
    eq(".page-head h1 字重", probe.h1.weight, 700);
    eq(".panel-head h2 字重", probe.panelHead?.weight, 500);
    eq(".switch-title 字重", probe.switchTitle?.weight, 500);
    eq(".switch-title 字号", probe.switchTitle?.size, 12);
    eq(".switch-title 用主文字色", probe.switchTitle?.color, probe.vars.text);
    eq(".switch-desc 字重", probe.switchDesc?.weight, 400);
    eq(".switch-desc 字号", probe.switchDesc?.size, 11);
    eq(".bg-hint 字重", probe.bgHint?.weight, 400);
    eq(".bg-hint 字号", probe.bgHint?.size, 10.5);
    eq(".bg-hint 用次级灰", probe.bgHint?.color, probe.vars.muted2);
    eq(".appearance-card-hint 字重", probe.cardHint?.weight, 400);
    eq(".font-preview-code 字重", probe.codePreview?.weight, 400);
    eq(".font-preview-code 用次级文字色", probe.codePreview?.color, probe.vars.text2);
    eq(".toggle-track 无边框", probe.toggleTrack?.borderWidth, "0px");
    eq(".toggle-track 药丸圆角", probe.toggleTrack?.radius, "999px");
    check(
      "开关开/关态靠轨道背景色区分",
      Boolean(probe.onBg) && Boolean(probe.offBg) && probe.onBg !== probe.offBg,
      `on=${probe.onBg} off=${probe.offBg}`,
      "toggleStateColor",
    );
  }

  const errors = await page.evaluate(() => window.__pageErrors || 0);
  check("无页面异常", !errors, "", "pageErrors");
} finally {
  await browser.close();
}

console.log(`checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
