/**
 * 浅色主题文字对比度专项验证（r15）。
 *
 * 复现的 bug：玩家自选亮黄强调色 `#fcee0a` 后切到 Modern 浅色，所有拿强调色当
 * 文字色的地方（面包屑 `// CET / MOD SETTINGS / USER.INI`、标题句点、侧栏选中项）
 * 都是「亮黄字配白底」，对比度 1.2:1，等于看不见。
 *
 * 修法：强调色拆成两个令牌——`--accent` 当填充（按钮底、边框），`--accent-text`
 * 当文字，浅色模式下自动压深到同色相的深色（自定义强调色还会按 WCAG 逐档混合）。
 *
 * 断言方式：直接取 computed color 与最近的实色祖先背景，算 WCAG 对比度。
 *
 * 用法：先 `npm run dev`（端口 1420），再 `node scripts/check-contrast.mjs`
 */
import { chromium } from "playwright-core";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;
const results = [];
const fail = [];

function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) fail.push(name);
}

/** 页内计算：相对亮度、对比度、最近实色背景（含 opacity 折算）。 */
const MEASURE = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const parse = (value) => {
    const match = value.match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((piece) => Number.parseFloat(piece));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  };
  const solidBackground = (node) => {
    let current = node;
    while (current) {
      const parsed = parse(getComputedStyle(current).backgroundColor);
      if (parsed && parsed.alpha > 0.9) return parsed.rgb;
      current = current.parentElement;
    }
    return [255, 255, 255];
  };
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const blended = (rgb, alpha, background) =>
    rgb.map((value, index) => value * alpha + background[index] * (1 - alpha));

  const style = getComputedStyle(el);
  let color = parse(style.color);
  if (!color) return null;
  let alpha = color.alpha * (Number.parseFloat(style.opacity || "1") || 1);
  let current = el;
  while (current && alpha === 1) {
    const parsed = parse(getComputedStyle(current).opacity ? "rgba(0,0,0," + getComputedStyle(current).opacity + ")" : "");
    if (parsed && parsed.alpha < 1) alpha *= parsed.alpha;
    current = current.parentElement;
  }
  const background = solidBackground(el);
  const rgb = blended(color.rgb, Math.max(0.05, alpha), background);
  const lighter = Math.max(luminance(rgb), luminance(background));
  const darker = Math.min(luminance(rgb), luminance(background));
  return {
    color: style.color,
    background: "rgb(" + background.join(", ") + ")",
    ratio: Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100,
  };
}`;

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox"],
});

async function openPage({ theme, mode, accent, view }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (error) => errs.push(String(error)));
  await page.addInitScript(
    ({ theme, mode, accent, view }) => {
      window.localStorage.clear();
      window.localStorage.setItem("ncl.ui.eulaAccepted.v1", "true");
      window.localStorage.setItem(
        "ncl.ui.theme.v2",
        JSON.stringify({ styleTheme: theme, colorMode: mode }),
      );
      if (accent) {
        window.localStorage.setItem(
          "ncl.ui.preferences.v1",
          JSON.stringify({ useCustomAccent: true, accent, scale: 1, sidebarCollapsed: false }),
        );
      }
    },
    { theme, mode, accent, view },
  );
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  return { page, errs };
}

/** 一组选择器 + 各自的最低对比度要求。 */
const TARGETS = [
  { selector: ".page-head h1", min: 7, label: "主标题" },
  { selector: ".h1-accent", min: 7, label: "标题句点" },
  { selector: ".eyebrow", min: 7, label: "面包屑" },
  { selector: ".nav-item.active .nav-label", min: 7, label: "侧栏选中项文字" },
  { selector: ".nav-item.active .nav-en", min: 4.5, label: "侧栏选中项副标题" },
  { selector: ".page-sub", min: 4.5, label: "页面说明" },
];

async function measureAll(page, tag) {
  return page.evaluate(({ measureSource, targets }) => {
    // eslint-disable-next-line no-new-func
    const measure = new Function("return " + measureSource)();
    return targets.map((target) => ({ ...target, result: measure(target.selector) }));
  }, { measureSource: MEASURE, targets: TARGETS }).then((rows) =>
    rows.map((row) => ({ ...row, tag })),
  );
}

/* ---------------- 场景 A：Modern 浅色，默认蓝色强调色 ---------------- */
{
  const { page, errs } = await openPage({ theme: "modern", mode: "light", view: "library" });
  check("A 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue("--accent").trim(),
      accentText: style.getPropertyValue("--accent-text").trim(),
      mode: document.documentElement.dataset.mode,
      styleTheme: document.documentElement.dataset.style,
    };
  });
  check("A 主题落地为 modern + light", tokens.styleTheme === "modern" && tokens.mode === "light", JSON.stringify(tokens));
  check("A 文字强调色比填充色更深", tokens.accentText !== tokens.accent, `${tokens.accent} → ${tokens.accentText}`);

  for (const row of await measureAll(page, "A")) {
    if (!row.result) {
      check(`A ${row.label} 可测量`, false, row.selector);
      continue;
    }
    check(
      `A ${row.label} 对比度 ≥ ${row.min}`,
      row.result.ratio >= row.min,
      `${row.result.ratio}:1 (${row.result.color} on ${row.result.background})`,
    );
  }
  await page.screenshot({ path: "shots/contrast-modern-light.png" });
  await page.close();
}

/* ---------------- 场景 B：Modern 浅色 + 自定义亮黄强调色（原 bug） ---------------- */
{
  const { page, errs } = await openPage({
    theme: "modern",
    mode: "light",
    accent: "#fcee0a",
    view: "library",
  });
  check("B 页面无脚本错误", errs.length === 0, errs[0] ?? "");

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue("--accent").trim(),
      accentText: style.getPropertyValue("--accent-text").trim(),
    };
  });
  check(
    "B 填充色仍是玩家选的亮黄",
    tokens.accent.toLowerCase() === "#fcee0a",
    tokens.accent,
  );
  check(
    "B 文字色已被压深（不再是亮黄）",
    tokens.accentText.toLowerCase() !== "#fcee0a",
    tokens.accentText,
  );

  for (const row of await measureAll(page, "B")) {
    if (!row.result) {
      check(`B ${row.label} 可测量`, false, row.selector);
      continue;
    }
    check(
      `B ${row.label} 对比度 ≥ ${row.min}`,
      row.result.ratio >= row.min,
      `${row.result.ratio}:1 (${row.result.color} on ${row.result.background})`,
    );
  }

  // 亮黄做按钮底时，按钮文字必须是深色（不能深色底配深色字）
  const button = await page.evaluate(() => {
    const el = document.querySelector(".btn-primary");
    if (!el) return null;
    const style = getComputedStyle(el);
    return { color: style.color, background: style.backgroundColor };
  });
  check(
    "B 亮黄按钮的文字是深色",
    Boolean(button) && /rgb\(\s*(1[0-9]|[0-9])\s*,/.test(button.color),
    JSON.stringify(button),
  );
  await page.screenshot({ path: "shots/contrast-modern-light-yellow.png" });
  await page.close();
}

/* ---------------- 场景 C：赛博暗色不应被误伤（黄字仍是高对比） ---------------- */
{
  const { page } = await openPage({ theme: "ncpd", mode: "dark", view: "library" });
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue("--accent").trim(),
      accentText: style.getPropertyValue("--accent-text").trim(),
    };
  });
  check("C 暗色下文字色与填充色同值（不被改动）", tokens.accentText === tokens.accent, `${tokens.accent}`);

  for (const row of await measureAll(page, "C")) {
    if (!row.result) continue;
    check(
      `C ${row.label} 对比度 ≥ ${row.min}`,
      row.result.ratio >= row.min,
      `${row.result.ratio}:1`,
    );
  }
  await page.screenshot({ path: "shots/contrast-ncpd-dark.png" });
  await page.close();
}

await browser.close();

console.log("\n" + results.join("\n"));
console.log(`\n合计 ${results.length - fail.length}/${results.length} 通过`);
if (fail.length > 0) {
  console.log("失败项：" + fail.join(" / "));
  process.exit(1);
}
