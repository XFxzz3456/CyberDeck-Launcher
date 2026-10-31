/**
 * UI 深度自查量化脚本（对应用户任务书 deepseek_markdown_20261030_660e0b 四大类）。
 *
 * 为什么要写这个：那份任务书要求「地毯式自查 + 输出 P0/P1/P2 分级报告」，
 * 但靠肉眼看截图只能发现明显错位，抓不到「滚动条占位差 9px」「对比度 3.8:1」
 * 这类量化问题。这里把能测量的项全部转成数字，报告里直接引用实测值。
 *
 * 覆盖：
 *   一.1 超宽屏/小屏（2560/1920/1280/960 四档）
 *   一.2 Flex/Grid 溢出（长文本撑破容器）
 *   一.3 UI 缩放 80% / 150%
 *   二.4 hover / active 反馈规则存在性
 *   三.1 字号离群值
 *   三.2 表单左右对齐（label 左沿 / 控件右沿）
 *   三.3 对比度（modern 浅色 + 暗色两套）
 *   四.1 空状态覆盖（代码侧统计，见报告）
 *
 * 二.1/二.2/二.3/三.4/四.2 属代码侧可判定项，不在本脚本内，报告里给代码证据。
 *
 * 输出 key=value 供 gate.mjs 断言；JSON 明细写 shots/audit/ui-audit.json。
 */
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.GATE_PORT || "1420";
const BASE = `http://localhost:${PORT}/`;
const out = path.resolve("shots/audit");
fs.mkdirSync(out, { recursive: true });

const PREFS_KEY = "ncl.ui.preferences.v1";
const THEME_KEY = "ncl.ui.theme.v2";

const basePrefs = {
  theme: "ncpd",
  useCustomAccent: false,
  accent: "#fcee0a",
  scale: 1,
  sidebarCollapsed: false,
  animations: false,
  splash: false,
  libraryView: "grid",
};

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const result = { viewports: [], overflow: [], scale: [], contrast: [], fontOutliers: [], align: [], hoverRules: 0, pageErrors: [] };

async function newPage(viewport, prefs = {}, theme = null) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => result.pageErrors.push(String(e).slice(0, 160)));
  await page.addInitScript(
    ([prefsKey, themeKey, p, th]) => {
      localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
      localStorage.setItem(prefsKey, JSON.stringify(p));
      if (th) localStorage.setItem(themeKey, JSON.stringify(th));
    },
    [PREFS_KEY, THEME_KEY, { ...basePrefs, ...prefs }, theme]
  );
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  return page;
}

/** 在页面里注入的公共工具：对比度 + 有效背景。 */
const HELPERS = `
  window.__rgb = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  window.__lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  window.__contrast = (a, b) => {
    const l1 = window.__lum(a), l2 = window.__lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  window.__bgOf = (el) => {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const c = window.__rgb(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0.55) return c;
      cur = cur.parentElement;
    }
    return { r: 7, g: 9, b: 12, a: 1 };
  };
`;

// ── 一.1 四档分辨率 ────────────────────────────────────────────
const VIEWPORTS = [
  { name: "2560x1440", width: 2560, height: 1440 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "960x640", width: 960, height: 640 },
];

for (const vp of VIEWPORTS) {
  const page = await newPage({ width: vp.width, height: vp.height });
  await page.addScriptTag({ content: HELPERS });
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const pageEl = document.querySelector(".page");
    const inner = pageEl ? pageEl.getBoundingClientRect() : null;
    const cs = pageEl ? getComputedStyle(pageEl) : null;
    // 内容是否被限宽并居中：拿所有一级子元素的最右沿算实际内容宽度
    let contentW = 0;
    if (pageEl) {
      for (const child of pageEl.children) {
        const r = child.getBoundingClientRect();
        if (r.width > 0) contentW = Math.max(contentW, r.right);
      }
    }
    return {
      hScroll: doc.scrollWidth - doc.clientWidth,
      pageW: inner ? Math.round(inner.width) : 0,
      pageMaxWidth: cs ? cs.maxWidth : "",
      contentRight: Math.round(contentW),
      viewportW: doc.clientWidth,
      rightGap: inner ? Math.round(doc.clientWidth - inner.right) : 0,
      leftGap: inner ? Math.round(inner.left) : 0,
    };
  });
  result.viewports.push({ name: vp.name, ...m });
  await page.screenshot({ path: path.join(out, `audit-${vp.name}.png`) });
  await page.close();
}

// ── 一.2 溢出扫描（1280x800，遍历五个页面）────────────────────
{
  const page = await newPage({ width: 1280, height: 800 });
  for (const view of ["模组库", "加载顺序", "运行诊断", "存档管理", "设置"]) {
    const btn = page.locator(".sidebar .nav-item", { hasText: view }).first();
    if (!(await btn.count())) continue;
    await btn.click();
    await page.waitForTimeout(420);
    const bad = await page.evaluate(() => {
      const hits = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        // 只关心「有直接文本、且横向溢出了自己」的元素
        const hasText = [...el.childNodes].some(
          (n) => n.nodeType === 3 && n.textContent.trim().length > 2
        );
        if (!hasText) continue;
        if (el.scrollWidth <= el.clientWidth + 2) continue;
        // 已用省略号的容器是「有意截断」，不算撑破
        if (cs.textOverflow === "ellipsis" && cs.overflowX !== "visible") continue;
        // 祖先里已有 ellipsis 截断的，溢出被子元素继承，不算
        let cur = el.parentElement;
        let covered = false;
        while (cur && cur !== document.body) {
          const p = getComputedStyle(cur);
          if (p.textOverflow === "ellipsis" && p.overflowX !== "visible") {
            covered = true;
            break;
          }
          cur = cur.parentElement;
        }
        if (covered) continue;
        const cls = typeof el.className === "string" ? el.className : "";
        hits.push({
          view: "",
          cls: cls.split(" ").slice(0, 2).join("."),
          text: (el.textContent || "").trim().slice(0, 26),
          over: el.scrollWidth - el.clientWidth,
        });
      }
      return hits;
    });
    for (const h of bad) result.overflow.push({ ...h, view });
  }
  await page.close();
}

// ── 一.3 缩放 80% / 150% ─────────────────────────────────────
for (const scale of [0.8, 1.25, 1.5]) {
  const page = await newPage({ width: 1280, height: 800 }, { scale });
  await page.addScriptTag({ content: HELPERS });
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const sidebar = document.querySelector(".sidebar");
    const topbar = document.querySelector(".topbar");
    const cards = [...document.querySelectorAll(".mod-card, .library-card, .panel")].slice(0, 12);
    const widths = cards.map((c) => Math.round(c.getBoundingClientRect().width)).filter((w) => w > 0);
    const collapsedEls = [...document.querySelectorAll(".sidebar *, .topbar *")].filter((el) => {
      // <option> 是原生下拉项，本来就不生成布局盒，永远 0x0，不是缺陷。
      if (el.tagName === "OPTION") return false;
      // 关键：要判「自己或任一祖先被隐藏」。只判自身 display 会漏掉
      // [data-vh-tight] .sidebar-storage { display:none } 这类
      // 父子级让位规则——子元素自身 display 仍是 flex，但根本不会渲染，
      // 于是每次缩放都稳定报出一堆假塌陷。
      if (!el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      if (el.closest("[aria-hidden='true']")) return false;
      const r = el.getBoundingClientRect();
      return r.width <= 0 && r.height <= 0 && el.textContent.trim().length > 2;
    });
    return {
      scale: getComputedStyle(doc).getPropertyValue("--ui-scale").trim() || "(未用CSS变量)",
      hScroll: doc.scrollWidth - doc.clientWidth,
      sidebarW: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
      topbarH: topbar ? Math.round(topbar.getBoundingClientRect().height) : 0,
      cardCount: widths.length,
      cardWMin: widths.length ? Math.min(...widths) : 0,
      cardWMax: widths.length ? Math.max(...widths) : 0,
      // 负边距/塌陷判定：只统计「本该显示却尺寸为 0」的元素。
      // 旧版只判 rect 宽高 <=0，把 display:none / visibility:hidden / 折叠态
      // 里被 CSS 隐藏的文本元素全算了进去（它们宽高天然就是 0），
      // 于是每档缩放都稳定报出 2-11 个「塌陷」，全是假阳性。
      collapsed: collapsedEls.length,
      collapsedDetail: collapsedEls.slice(0, 6).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: (el.className || "").toString().slice(0, 48),
          text: el.textContent.trim().slice(0, 18),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }),
    };
  });
  result.scale.push({ requested: scale, ...m });
  await page.screenshot({ path: path.join(out, `audit-scale-${scale}.png`) });
  await page.close();
}

// ── 三.3 对比度（现代浅色 / 暗色两套）─────────────────────────
for (const [label, theme] of [
  ["modern-light", { styleTheme: "modern", colorMode: "light" }],
  ["modern-dark", { styleTheme: "modern", colorMode: "dark" }],
  ["ncpd-dark", { styleTheme: "ncpd", colorMode: "dark" }],
]) {
  const page = await newPage({ width: 1280, height: 800 }, {}, theme);
  await page.addScriptTag({ content: HELPERS });
  await page.waitForTimeout(400);
  const bad = await page.evaluate(() => {
    const hits = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.6) continue;
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!direct) continue;
      const fs = parseFloat(cs.fontSize);
      if (!Number.isFinite(fs) || fs < 10) continue;
      const fg = window.__rgb(cs.color);
      if (!fg || fg.a < 0.6) continue;
      const bg = window.__bgOf(el);
      const ratio = window.__contrast(fg, bg);
      const bold = parseInt(cs.fontWeight, 10) >= 600;
      const large = fs >= 18.66 || (fs >= 14 && bold);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        const key = `${cs.color}|${Math.round(ratio * 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          cls: (typeof el.className === "string" ? el.className : "").split(" ").slice(0, 2).join("."),
          text: (el.textContent || "").trim().slice(0, 20),
          fs: Math.round(fs),
          ratio: +ratio.toFixed(2),
          need,
          color: cs.color,
        });
      }
    }
    return hits;
  });
  result.contrast.push({ theme: label, fails: bad.length, detail: bad.slice(0, 12) });
  await page.screenshot({ path: path.join(out, `audit-contrast-${label}.png`) });
  await page.close();
}

// ── 三.1 字号离群 + 三.2 表单对齐（一次遍历）──────────────────
{
  const page = await newPage({ width: 1280, height: 800 });
  await page.addScriptTag({ content: HELPERS });
  const settingsBtn = page.locator(".sidebar .nav-item", { hasText: "设置" }).first();
  if (await settingsBtn.count()) {
    await settingsBtn.click();
    await page.waitForTimeout(500);
  }
  const fonts = await page.evaluate(() => {
    const sizes = new Map();
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!direct) continue;
      const fs = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      const cls = (typeof el.className === "string" ? el.className : "").split(" ")[0] || "(bare)";
      const key = `${fs}|${cls}`;
      sizes.set(key, { fs, cls, text: (el.textContent || "").trim().slice(0, 16) });
    }
    const all = [...sizes.values()];
    return {
      histogram: [...new Set(all.map((x) => x.fs))].sort((a, b) => a - b),
      tiny: all.filter((x) => x.fs < 10),
      huge: all.filter((x) => x.fs > 34),
    };
  });
  result.fontOutliers.push({ view: "设置", ...fonts });

  const align = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".settings-field-row")];
    const rowsMeasured = rows
      .map((row) => {
        const kids = [...row.children].filter((c) => c.getBoundingClientRect().width > 0);
        if (kids.length < 2) return null;
        const first = kids[0].getBoundingClientRect();
        const last = kids[kids.length - 1].getBoundingClientRect();
        return {
          left: Math.round(first.left),
          right: Math.round(last.right),
        };
      })
      .filter(Boolean);
    const lefts = [...new Set(rowsMeasured.map((r) => r.left))];
    const rights = [...new Set(rowsMeasured.map((r) => r.right))];
    return {
      rows: rowsMeasured.length,
      leftSpread: lefts.length > 1 ? Math.max(...lefts) - Math.min(...lefts) : 0,
      rightSpread: rights.length > 1 ? Math.max(...rights) - Math.min(...rights) : 0,
      lefts,
      rights,
    };
  });
  result.align.push(align);
  await page.screenshot({ path: path.join(out, "audit-settings.png") });

  // ── 二.4 hover/active 规则 ──────────────────────────────
  result.hoverRules = await page.evaluate(() => {
    const want = [".btn", ".nav-item", ".mod-card", ".settings-tab", ".nexus-tab"];
    const found = {};
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (!rule.selectorText) continue;
        for (const w of want) {
          if (!rule.selectorText.includes(w)) continue;
          if (rule.selectorText.includes(":hover")) found[`${w}:hover`] = true;
          if (rule.selectorText.includes(":active")) found[`${w}:active`] = true;
        }
      }
    }
    return Object.keys(found);
  });
  await page.close();
}

await browser.close();

// ── 汇总输出 ─────────────────────────────────────────────────
const hScrollMax = Math.max(0, ...result.viewports.map((v) => v.hScroll));
const narrow = result.viewports.find((v) => v.name === "960x640");
const ultra = result.viewports.find((v) => v.name === "2560x1440");
const overflowTotal = result.overflow.length;
const scaleBroken = result.scale.filter((s) => s.hScroll > 0 || s.collapsed > 0).length;
const contrastFails = result.contrast.reduce((n, c) => n + c.fails, 0);
const tinyFonts = result.fontOutliers.flatMap((f) => f.tiny).length;
const alignSpread = Math.max(0, ...result.align.map((a) => Math.max(a.leftSpread, a.rightSpread)));

fs.writeFileSync(path.join(out, "ui-audit.json"), JSON.stringify(result, null, 1));

console.log(`viewports=${result.viewports.length}`);
console.log(`hScrollMax=${hScrollMax}`);
console.log(`ultraContentW=${ultra ? ultra.pageW : 0}`);
console.log(`ultraRightGap=${ultra ? ultra.rightGap : 0}`);
console.log(`narrowHScroll=${narrow ? narrow.hScroll : -1}`);
console.log(`overflowTotal=${overflowTotal}`);
console.log(`scaleBroken=${scaleBroken}`);
console.log(`contrastFails=${contrastFails}`);
console.log(`contrastLight=${result.contrast.find((c) => c.theme === "modern-light")?.fails ?? -1}`);
console.log(`tinyFonts=${tinyFonts}`);
console.log(`alignSpread=${alignSpread}`);
console.log(`hoverRules=${result.hoverRules.length}`);
console.log(`pageErrors=${result.pageErrors.length}`);
for (const o of result.overflow.slice(0, 8)) {
  console.log(`overflow=${JSON.stringify(o)}`);
}
for (const c of result.contrast) {
  for (const d of c.detail.slice(0, 4)) {
    console.log(`contrast=${c.theme} ${JSON.stringify(d)}`);
  }
}
for (const f of result.fontOutliers.flatMap((x) => x.tiny).slice(0, 6)) {
  console.log(`tiny=${JSON.stringify(f)}`);
}
