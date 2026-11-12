import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

/**
 * 设置页「顶部水平 Tabs + 独立滚动内容区」回归脚本。
 *
 * 覆盖：分区数量/标签、面板互斥显示、内容区内部滚动、页面本身不滚、
 * 切分区不重挂载（保留未保存输入）、滚动位置归零、每个分区的内容归属、
 * 三套主题（赛博 / Modern / Mono）的激活态样式、键盘导航与 ARIA 关联。
 *
 * 用法：先起 dev server（默认 1420），再 node scripts/verify-settings-tabs.mjs
 */

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const origin = process.env.VERIFY_ORIGIN ?? "http://127.0.0.1:1420";
const root = path.resolve(import.meta.dirname, "..");
const shots = path.join(root, "shots");
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.clear());
const page = await context.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("favicon")) errors.push(msg.text());
});
page.on("pageerror", (error) => errors.push(error.message));

const check = (label, condition) => {
  if (!condition) {
    errors.push(`CHECK FAILED: ${label}`);
    console.log(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

await page.goto(origin, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.locator('.nav-item').last().click();
await page.waitForSelector('.settings-tabs', { timeout: 10000 });
await page.waitForTimeout(600);

// ── 1. 分区数量与标签 ──────────────────────────────────────────
const tabLabels = (await page.locator('.settings-tab').allInnerTexts()).map((t) => t.trim());
console.log('tabs:', JSON.stringify(tabLabels));
check('eight tabs rendered', tabLabels.length === 8);
check(
  'tab labels match spec',
  JSON.stringify(tabLabels) ===
    JSON.stringify(['个性化', '通知', '游戏与路径', '下载', 'AI 配置', '工具组件', '安全与维护', '帮助与关于']),
);
check('exactly one visible panel', (await page.locator('.settings-tab-panel:visible').count()) === 1);

// ── 2. 内容区独立滚动，页面本身不滚 ────────────────────────────
const scrollInfo = await page.evaluate(() => {
  const box = document.querySelector('.settings-content');
  const pageEl = document.querySelector('.settings-page');
  const sidebar = document.querySelector('.sidebar');
  return {
    overflowY: box ? getComputedStyle(box).overflowY : null,
    flexGrow: box ? getComputedStyle(box).flexGrow : null,
    minHeight: box ? getComputedStyle(box).minHeight : null,
    pageOverflow: pageEl ? getComputedStyle(pageEl).overflowY : null,
    sidebarScrollTop: sidebar ? sidebar.scrollTop : null,
  };
});
console.log('scroll layout:', JSON.stringify(scrollInfo));
check('content area scrolls internally (overflow-y auto)', scrollInfo.overflowY === 'auto');
check('content area flexes to fill (flex-grow 1)', scrollInfo.flexGrow === '1');
check('content area min-height 0 (overflow can take effect)', scrollInfo.minHeight === '0px');
check('settings page itself does not scroll', scrollInfo.pageOverflow === 'hidden');
check('global sidebar untouched', scrollInfo.sidebarScrollTop === 0);

// ── 3. 激活态样式（赛博主题）───────────────────────────────────
const cyber = await page.evaluate(() => {
  const el = document.querySelector('.settings-tab.active');
  const cs = getComputedStyle(el);
  const after = getComputedStyle(el, '::after');
  return {
    color: cs.color,
    textShadow: cs.textShadow,
    underlineHeight: after.height,
    underlineBackground: after.backgroundColor,
    underlineBoxShadow: after.boxShadow,
  };
});
console.log('cyber active tab:', JSON.stringify(cyber));
check('cyber: accent color', cyber.color === 'rgb(252, 238, 10)');
check('cyber: glow text-shadow', cyber.textShadow !== 'none');
check('cyber: accent underline', cyber.underlineBackground === 'rgb(252, 238, 10)' && parseFloat(cyber.underlineHeight) > 0);
check('cyber: underline glow', cyber.underlineBoxShadow !== 'none');

// ── 4. 切分区不重挂载（未保存输入不丢）─────────────────────────
const remount = await page.evaluate(async () => {
  const panel = document.querySelector('#settings-panel-appearance');
  if (!panel) return { sameNode: false, stillThere: false };
  const marker = document.createElement('span');
  marker.id = 'probe-marker';
  panel.appendChild(marker);
  document.querySelector('#settings-tab-ai').click();
  await new Promise((r) => setTimeout(r, 300));
  return {
    sameNode: document.querySelector('#settings-panel-appearance') === panel,
    stillThere: !!document.querySelector('#probe-marker'),
  };
});
console.log('remount probe:', JSON.stringify(remount));
check('panel DOM node not recreated on tab switch', remount.sameNode === true);
check('unsaved DOM state survives tab switch', remount.stillThere === true);

// ── 5. 切换分区后滚动位置归零 ──────────────────────────────────
await page.setViewportSize({ width: 1100, height: 420 });
await page.waitForTimeout(400);
const scrollReset = await page.evaluate(async () => {
  const box = document.querySelector('.settings-content');
  document.querySelector('#settings-tab-tools').click();
  await new Promise((r) => setTimeout(r, 350));
  const overflows = box.scrollHeight > box.clientHeight;
  box.scrollTop = 400;
  await new Promise((r) => setTimeout(r, 120));
  const before = box.scrollTop;
  document.querySelector('#settings-tab-help').click();
  await new Promise((r) => setTimeout(r, 350));
  const after = box.scrollTop;
  document.querySelector('#settings-tab-tools').click();
  await new Promise((r) => setTimeout(r, 350));
  return { overflows, before, after, back: box.scrollTop };
});
console.log('scroll reset:', JSON.stringify(scrollReset));
check('tall panel really overflows (test is meaningful)', scrollReset.overflows === true);
check('scroll was actually moved before switching', scrollReset.before > 0);
check('scroll resets to top on tab switch', scrollReset.after === 0);
check('scroll stays at top when returning to a tab', scrollReset.back === 0);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);

// ── 6. 每个分区的内容归属 ──────────────────────────────────────
const panelContent = await page.evaluate(async () => {
  const out = {};
  for (const id of ['appearance', 'game', 'downloads', 'ai', 'tools', 'security', 'help']) {
    document.querySelector(`#settings-tab-${id}`).click();
    await new Promise((r) => setTimeout(r, 250));
    const panel = document.querySelector(`#settings-panel-${id}`);
    out[id] = panel ? panel.innerText.replace(/\s+/g, ' ') : null;
  }
  return out;
});
for (const [id, text] of Object.entries(panelContent)) console.log(`panel ${id}:`, text.slice(0, 110));
check('appearance panel keeps AppearanceSettings', /外观与主题/.test(panelContent.appearance ?? ''));
check('game panel has game directory', /游戏目录/.test(panelContent.game ?? ''));
check('game panel has launch method', /启动方式/.test(panelContent.game ?? ''));
check('ai panel has AI card', /AI 助手配置/.test(panelContent.ai ?? ''));
check('tools panel has profile list', /播放集/.test(panelContent.tools ?? ''));
check('tools panel has Nexus integration', /账号与发现/.test(panelContent.tools ?? ''));
check('security panel has safety policy', /安全策略/.test(panelContent.security ?? ''));
check('security panel has backup card', /备份与回滚/.test(panelContent.security ?? ''));
check('downloads panel has download settings', /下载设置/.test(panelContent.downloads ?? ''));
check('downloads panel has route choice', /下载链路/.test(panelContent.downloads ?? ''));
check('help panel has guide', /帮助中心/.test(panelContent.help ?? ''));
check('help panel has about card', /关于 CyberDeck Launcher/.test(panelContent.help ?? ''));

// ── 7. 键盘导航与 ARIA ─────────────────────────────────────────
await page.evaluate(() => document.querySelector('#settings-tab-appearance').click());
await page.waitForTimeout(200);
await page.locator('.settings-tab.active').focus();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(250);
check('ArrowRight moves to next tab', (await page.locator('.settings-tab.active').innerText()).trim() === '游戏与路径');
check('focus follows selection', (await page.evaluate(() => document.activeElement?.id)) === 'settings-tab-game');
await page.keyboard.press('End');
await page.waitForTimeout(250);
check('End jumps to last tab', (await page.locator('.settings-tab.active').innerText()).trim() === '关于');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(250);
check('ArrowRight wraps to first tab', (await page.locator('.settings-tab.active').innerText()).trim() === '外观与主题');
await page.keyboard.press('Home');
await page.waitForTimeout(250);
check('Home jumps to first tab', (await page.locator('.settings-tab.active').innerText()).trim() === '外观与主题');

const aria = await page.evaluate(() => {
  const tab = document.querySelector('.settings-tab.active');
  const panel = document.querySelector('.settings-tab-panel:not([hidden])');
  return {
    role: tab.getAttribute('role'),
    selected: tab.getAttribute('aria-selected'),
    controls: tab.getAttribute('aria-controls'),
    panelId: panel?.id,
    labelledBy: panel?.getAttribute('aria-labelledby'),
    tablist: document.querySelector('.settings-tabs').getAttribute('role'),
  };
});
console.log('aria:', JSON.stringify(aria));
check('tab role + aria-selected wired', aria.role === 'tab' && aria.selected === 'true');
check('aria-controls points at live panel', aria.controls === aria.panelId);
check('panel aria-labelledby points back at tab', aria.labelledBy === 'settings-tab-appearance');
check('tablist role present', aria.tablist === 'tablist');

// ── 8. 主题适配：Modern 扁平灰 / Mono 去发光 ──────────────────
const readActiveTab = () =>
  page.evaluate(() => {
    const el = document.querySelector('.settings-tab.active');
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    return {
      color: cs.color,
      background: cs.backgroundColor,
      textShadow: cs.textShadow,
      afterHeight: after.height,
      afterBackground: after.backgroundColor,
      afterBoxShadow: after.boxShadow,
    };
  });

await page.evaluate(() => document.documentElement.setAttribute('data-style', 'modern'));
await page.waitForTimeout(250);
const modern = await readActiveTab();
console.log('modern active tab:', JSON.stringify(modern));
check('modern: no glow text-shadow', modern.textShadow === 'none');
check('modern: flat grey background highlight', modern.background !== 'rgba(0, 0, 0, 0)');
check('modern: underline present but flat', parseFloat(modern.afterHeight) > 0 && modern.afterBoxShadow === 'none');
check('modern: underline neutral (not accent yellow)', modern.afterBackground !== 'rgb(252, 238, 10)');
await page.screenshot({ path: path.join(shots, 'settings-tab-modern.png') });
await page.evaluate(() => document.documentElement.removeAttribute('data-style'));

await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'mono'));
await page.waitForTimeout(250);
const mono = await readActiveTab();
console.log('mono active tab:', JSON.stringify(mono));
check('mono: no glow text-shadow', mono.textShadow === 'none');
check('mono: underline has no glow', mono.afterBoxShadow === 'none');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'ncpd'));
await page.waitForTimeout(250);

// ── 9. 截图 ────────────────────────────────────────────────────
for (const id of ['appearance', 'game', 'ai', 'tools', 'security', 'about']) {
  await page.evaluate((tabId) => document.querySelector(`#settings-tab-${tabId}`).click(), id);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `settings-tab-${id}.png`) });
}

console.log('\nconsole/page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
