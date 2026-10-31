// 生成「现代通用（modern）」主题的预览图（暗/亮各一张）。
//
// 做法与其余五套一致：截真实界面 → 取模组库首屏 → 缩到 176×104（卡片 88×52 的 2 倍）。
// 与旧脚本的三点差别：
//   1. 用 3× 采样再降采样，缩略图边缘更干净（2× 源在 5.7 倍降采样后会起摩尔纹）；
//   2. 取景以「标题整块 + 工具条 + 两行卡片」为准，不再从标题中间切一刀；
//   3. 明暗两套各出一张，界面按当前明暗自动选用。
//
// 用法：先 `npx vite preview --port 1420 --strictPort`，再 `node scripts/make-modern-thumb.mjs`
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = path.resolve(import.meta.dirname, "..");
const shotDir = path.join(root, "shots", "audit");
const outDir = path.join(root, "public", "theme-thumbs");
fs.mkdirSync(shotDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const URL = `http://localhost:${process.env.GATE_PORT || 1420}`;
// 取景：左缘在标题左侧留 16px，右缘落在第二列与第三列之间的间隙上，
// 上缘贴着大标题之上、下缘切在第二行卡片刚露头的位置。
// 坐标来自真实 DOM 测量（1440×900、侧栏 224、标题 x=248/y=137、卡片 x=416/749/1083 宽 319）。
const CLIP = { x: 232, y: 132, width: 844, height: 498 };
const OUT_W = 176;
const OUT_H = 104;

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

async function capture(mode) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 3, // 3× 采样，给降采样留余量
  });
  await context.addInitScript((mode) => {
    localStorage.clear();
    localStorage.setItem(
      "ncl.ui.theme.v2",
      JSON.stringify({ styleTheme: "modern", colorMode: mode }),
    );
  }, mode);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator(".mod-card").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(900); // 封面是异步绘制的
  const file = path.join(shotDir, `modern-library-${mode}.png`);
  await page.screenshot({ path: file, clip: CLIP });
  await context.close();
  if (errors.length) throw new Error(`${mode} 页面报错：${errors[0]}`);
  return file;
}

/** 交给浏览器降采样：高质量、无额外依赖，且能复用同一套 CSS 圆角/描边。 */
async function compose(srcFile, mode) {
  const dataUrl = `data:image/png;base64,${fs.readFileSync(srcFile).toString("base64")}`;
  const ctx = await browser.newContext({
    viewport: { width: 88, height: 52 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 88px; height: 52px; overflow: hidden; background: #1e1e1e; }
      .shot {
        width: 88px; height: 52px; display: block;
        object-fit: cover; object-position: left top;
      }
    </style><img class="shot" src="${dataUrl}">`,
    { waitUntil: "load" },
  );
  await page.waitForTimeout(150);
  const out = path.join(outDir, `modern-${mode}.png`);
  // 视口 88×52 CSS、DPR 2 → 整页截图正好是 176×104 物理像素
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 88, height: 52 } });

  // 评审图：8× 最近邻放大，检查边缘是否有条带/摩尔纹
  const zoom = await ctx.newPage();
  await zoom.setViewportSize({ width: 704, height: 416 });
  await zoom.setContent(
    `<!doctype html><meta charset="utf-8"><style>*{margin:0}
      html,body{width:704px;height:416px;overflow:hidden;background:#0a0a0b}
      img{width:704px;height:416px;display:block;image-rendering:pixelated}</style>
      <img src="data:image/png;base64,${fs.readFileSync(out).toString("base64")}">`,
  );
  await zoom.screenshot({ path: path.join(shotDir, `modern-${mode}-8x.png`) });
  await ctx.close();
  return out;
}

const darkSrc = await capture("dark");
const lightSrc = await capture("light");
const dark = await compose(darkSrc, "dark");
const light = await compose(lightSrc, "light");
fs.copyFileSync(dark, path.join(outDir, "modern.png"));

// 旧主题 daylight 已并入 modern（light），清掉遗留资源
const stale = path.join(outDir, "daylight.png");
if (fs.existsSync(stale)) fs.unlinkSync(stale);

await browser.close();
console.log("dark=" + dark);
console.log("light=" + light);
console.log("fallback=modern.png  daylight removed=" + !fs.existsSync(stale));
console.log("size=" + fs.statSync(dark).size + "/" + fs.statSync(light).size);
