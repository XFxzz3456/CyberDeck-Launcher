#!/usr/bin/env node
// 语义化版本自动递增（SemVer）。
//
// 为什么需要它：以前发版靠人判断"这次算 patch 还是 minor"，还要手工同步
// package.json / Cargo.toml / tauri.conf.json 三处——漏一处就会出现
// 「关于页显示 1.0.0、安装器显示 1.0.1」这类灵异现象。
//
// 设计取舍（都是踩过坑才这么定的）：
//   1. **默认 dry-run**：只打印判定依据与将要改的内容，加 --apply 才落盘。
//      「自动改版本号」一旦误判，代价是一串错版产物，必须留一道人工确认。
//   2. **判定基于证据而不是措辞**：commit message 只是辅助信号，真正的权重在
//      「有没有新增 Tauri 命令 / 新增模块 / 动 schema / 出现 BREAKING」这些
//      可机械验证的事实上。
//   3. **绝不碰 git tag**：tag 是已发布的事实，改它就是篡改历史（任务里也
//      明确禁止）。脚本只在末尾提示"该打什么 tag"，不代打。
//   4. **CHANGELOG 只增不改**：在「版本演进史」之后、最新条目之前插入一节，
//      历史段落一个字都不动。
//
// 用法：
//   node scripts/bump-version.mjs                     # 预演，自动判定
//   node scripts/bump-version.mjs --apply             # 落盘（改三处 + 插 CHANGELOG）
//   node scripts/bump-version.mjs --level minor --apply   # 强制指定级别
//   node scripts/bump-version.mjs --since v1.0.0      # 指定比对基点（默认上一个 tag）

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const CARGO = join(ROOT, "src-tauri", "Cargo.toml");
const TAURI = join(ROOT, "src-tauri", "tauri.conf.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const APPLY = flag("apply");
const FORCED = value("level"); // patch | minor | major，缺省自动判定

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
const trySh = (cmd) => {
  try {
    return sh(cmd);
  } catch {
    return "";
  }
};

// ── 读当前版本（以 package.json 为准，另两处只是被同步的对象）──────────────
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const current = pkg.version;

function readVersionFrom(file, pattern) {
  const text = readFileSync(file, "utf8");
  const match = text.match(pattern);
  if (!match) throw new Error(`读不到版本号：${file}`);
  return match[1];
}

const versions = {
  "package.json": current,
  "Cargo.toml": readVersionFrom(CARGO, /^version\s*=\s*"([^"]+)"/m),
  "tauri.conf.json": JSON.parse(readFileSync(TAURI, "utf8")).version,
};

// ── 变更来源：上一个 tag（或 --since）到工作区 ─────────────────────────────
const lastTag = value("since") || trySh("git describe --tags --abbrev=0") || "";
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const changedFiles = trySh(`git diff --name-status ${range}`)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split(/\s+/);
    return { status, path: rest.join(" ") };
  });
// 未提交的改动也算"本次发布的一部分"——很多人是改完直接发。
const dirty = trySh("git status --porcelain")
  .split("\n")
  .filter(Boolean)
  .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));

const allFiles = [...changedFiles, ...dirty];
const commits = trySh(`git log --pretty=%s ${range}`).split("\n").filter(Boolean);

// ── 证据收集 ───────────────────────────────────────────────────────────────
const diff = (file) => trySh(`git diff ${range} -- ${file}`);
const changed = (re) => allFiles.some((item) => re.test(item.path));

/** 新增的 Tauri 命令：从 generate_handler! 列表里做差集。 */
function addedCommands() {
  const pick = (text) =>
    new Set(
      (text.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !s.includes(" ")),
    );
  const before = pick(trySh(`git show ${lastTag || "HEAD~1"}:src-tauri/src/lib.rs`));
  const after = pick(readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8"));
  return [...after].filter((name) => !before.has(name));
}

/** 删除的 Tauri 命令：对老用户来说是破坏性变更。 */
function removedCommands() {
  const pick = (text) =>
    new Set(
      (text.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !s.includes(" ")),
    );
  const before = pick(trySh(`git show ${lastTag || "HEAD~1"}:src-tauri/src/lib.rs`));
  const after = pick(readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8"));
  return [...before].filter((name) => !after.has(name));
}

const newCommands = addedCommands();
const goneCommands = removedCommands();
const newModules = allFiles
  .filter((item) => /^src-tauri\/src\/[a-z_]+\.rs$/.test(item.path) && item.status.includes("A"))
  .map((item) => item.path);
const newComponents = allFiles
  .filter((item) => /^src\/components\/[A-Za-z]+\.tsx$/.test(item.path) && item.status.includes("A"))
  .map((item) => item.path);

// 破坏性信号：显式声明、动 schema、数据迁移、改 identifier。
const breakingSignals = [];
if (commits.some((line) => /BREAKING[ -]CHANGE|^[a-z]+!:/.test(line))) {
  breakingSignals.push("提交里出现 BREAKING CHANGE / `<type>!:`");
}
if (/^[+-]\s*pub (struct AppStateData|struct Settings|struct ModEntry)/m.test(diff("src-tauri/src/schema.rs"))) {
  breakingSignals.push("schema.rs 里的持久化结构发生了增删字段");
}
if (/migrat|迁移/i.test(diff("src-tauri/src/store.rs"))) {
  breakingSignals.push("store.rs 出现数据迁移逻辑");
}
if (/identifier/.test(diff("src-tauri/tauri.conf.json"))) {
  breakingSignals.push("改了 tauri identifier（数据目录会变）");
}

// ── 判定 ───────────────────────────────────────────────────────────────────
const reasons = [];
let level = "patch";

if (breakingSignals.length > 0 || goneCommands.length > 0) {
  level = "major";
  for (const reason of breakingSignals) reasons.push(`major · ${reason}`);
  if (goneCommands.length) reasons.push(`major · 删除了 Tauri 命令：${goneCommands.join(", ")}`);
} else if (newCommands.length > 0 || newModules.length > 0 || newComponents.length > 0) {
  level = "minor";
  if (newCommands.length) reasons.push(`minor · 新增 Tauri 命令 ${newCommands.length} 个：${newCommands.join(", ")}`);
  if (newModules.length) reasons.push(`minor · 新增 Rust 模块：${newModules.join(", ")}`);
  if (newComponents.length) reasons.push(`minor · 新增前端组件：${newComponents.join(", ")}`);
} else {
  level = "patch";
  const css = changed(/\.css$/);
  const i18n = changed(/i18n\//);
  const fixes = commits.filter((line) => /^fix/.test(line)).length;
  reasons.push(
    `patch · 只改动既有文件（CSS ${css ? "有" : "无"}、文案 ${i18n ? "有" : "无"}、fix 提交 ${fixes} 条）`,
  );
}

if (FORCED) {
  if (!["patch", "minor", "major"].includes(FORCED)) {
    console.error(`--level 只能是 patch / minor / major，收到：${FORCED}`);
    process.exit(1);
  }
  reasons.push(`人工指定级别：${FORCED}`);
  level = FORCED;
}

const [maj, min, pat] = current.split(".").map((n) => Number.parseInt(n, 10));
const next =
  level === "major"
    ? `${maj + 1}.0.0`
    : level === "minor"
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;

// ── CHANGELOG 摘要（按提交前缀聚类，缺口用"其他"兜底）───────────────────────
const bucket = { feat: [], fix: [], chore: [], docs: [], other: [] };
for (const line of commits) {
  const kind = /^feat/.test(line) ? "feat" : /^fix/.test(line) ? "fix" : /^(chore|refactor|perf)/.test(line) ? "chore" : /^docs/.test(line) ? "docs" : "other";
  bucket[kind].push(line.replace(/^\w+(\([^)]*\))?:\s*/, ""));
}
const today = new Date().toISOString().slice(0, 10);
const bullets = (items) => items.map((item) => `- ${item}`).join("\n");
const summarySection = `## [${next}] - ${today}${value("note") ? ` ${value("note")}` : ""}

${bucket.feat.length ? `### 新增\n\n${bullets(bucket.feat)}\n` : ""}${bucket.fix.length ? `\n### 修复\n\n${bullets(bucket.fix)}\n` : ""}${
  bucket.chore.length ? `\n### 变更\n\n${bullets(bucket.chore)}\n` : ""
}${bucket.docs.length ? `\n### 文档\n\n${bullets(bucket.docs)}\n` : ""}${
  bucket.other.length ? `\n### 其他\n\n${bullets(bucket.other)}\n` : ""
}`;

// ── 输出判定 ───────────────────────────────────────────────────────────────
console.log(`当前版本：${current}（package.json / Cargo.toml / tauri.conf.json）`);
console.log(`比对范围：${range}${dirty.length ? ` + ${dirty.length} 个未提交改动` : ""}，提交 ${commits.length} 条`);
console.log("判定依据：");
for (const reason of reasons) console.log(`  · ${reason}`);
console.log(`增量级别：${level}  →  新版本 ${next}`);

const drift = Object.entries(versions).filter(([, v]) => v !== current);
if (drift.length) {
  console.log("⚠️ 三处版本号当前并不一致：");
  for (const [file, v] of drift) console.log(`   ${file} = ${v}`);
}

if (!APPLY) {
  console.log("\n（预演模式，未改动任何文件。确认无误后加 --apply 落盘。）");
  console.log(`建议 tag：v${next}（脚本不会替你打 tag）`);
  process.exit(0);
}

// ── 落盘：三处版本号 + CHANGELOG ───────────────────────────────────────────
const backup = new Map([
  [PKG, readFileSync(PKG, "utf8")],
  [CARGO, readFileSync(CARGO, "utf8")],
  [TAURI, readFileSync(TAURI, "utf8")],
  [CHANGELOG, readFileSync(CHANGELOG, "utf8")],
]);

try {
  writeFileSync(PKG, JSON.stringify({ ...pkg, version: next }, null, 2) + "\n");
  writeFileSync(
    CARGO,
    backup.get(CARGO).replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`),
  );
  const tauriConf = JSON.parse(backup.get(TAURI));
  writeFileSync(TAURI, JSON.stringify({ ...tauriConf, version: next }, null, 2) + "\n");

  // CHANGELOG 锚点：插在**第一个版本条目**之前（`## [x.y.z]`），
  // 而不是第一个 `## `——顶部还有「版本演进史」这类索引章节，插在它前面会把
  // 总览顶到下面去。找不到版本条目就不动文件，避免把摘要塞进奇怪的位置。
  const log = backup.get(CHANGELOG).replace(/\r\n/g, "\n");
  const anchor = log.search(/\n## \[\d+\.\d+\.\d+\]/);
  if (anchor < 0) throw new Error("CHANGELOG 里找不到 `## [x.y.z]` 版本条目，拒绝改写");
  const nextLog = `${log.slice(0, anchor + 1)}${summarySection}\n${log.slice(anchor + 1)}`;
  writeFileSync(CHANGELOG, nextLog);

  // 自检：三处必须一致，否则整体回滚。
  const check = [
    JSON.parse(readFileSync(PKG, "utf8")).version,
    readVersionFrom(CARGO, /^version\s*=\s*"([^"]+)"/m),
    JSON.parse(readFileSync(TAURI, "utf8")).version,
  ];
  if (new Set(check).size !== 1) throw new Error(`三处版本号仍然不一致：${check.join(" / ")}`);

  console.log(`\n✅ 已升级到 ${next}：package.json / Cargo.toml / tauri.conf.json，CHANGELOG 已插入摘要`);
  console.log(`   CHANGELOG 摘要包含 ${Object.values(bucket).flat().length} 条提交`);
  console.log(`   下一步：git add -A && git commit -m "chore(release): ${next}" && git tag v${next}`);
} catch (error) {
  for (const [file, text] of backup) writeFileSync(file, text);
  console.error(`\n❌ 失败，已回滚四个文件：${error.message}`);
  process.exit(1);
}
