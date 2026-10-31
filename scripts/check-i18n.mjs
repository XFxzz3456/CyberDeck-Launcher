#!/usr/bin/env node
/**
 * i18n 守卫：扫描前端源码里「漏网的硬编码中文」。
 *
 * 用法：
 *   node scripts/check-i18n.mjs           # 进度看板：列出每个文件剩余条数，退出码 0
 *   node scripts/check-i18n.mjs --fail    # 门禁模式：只要还有硬编码就退出码 1（全量迁移后接进 CI）
 *   node scripts/check-i18n.mjs --list    # 逐条打印 file:line 与片段
 *   node scripts/check-i18n.mjs --unused  # 反向检查：词表里有、但源码从未引用的 key（防多建死条目）
 *
 * 词表文件 src/i18n/zh-CN.ts 是唯一允许出现中文的地方，已排除。
 * 豁免有两种写法（用于品牌词、正则、检索关键词、测试数据等真正不该翻译的文本）：
 *   - 行内：`// i18n-ignore`
 *   - 区块：`// i18n-ignore-start` … `// i18n-ignore-end`（用于整张数据表）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const HAN = /\p{Script=Han}/u;

const args = new Set(process.argv.slice(2));
const FAIL = args.has("--fail");
const LIST = args.has("--list");
const UNUSED = args.has("--unused");

/** 词表本身、以及明确不参与翻译的路径。 */
const SKIP_DIRS = new Set(["i18n"]);
const SKIP_FILES = new Set([
  "vite-env.d.ts",
  // 开发期假数据（模组名/描述是模拟 Nexus 内容，不是产品文案）
  "mock.ts",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
      continue;
    }
    if (!/\.(tsx?|jsx?)$/.test(name)) continue;
    if (SKIP_FILES.has(name)) continue;
    out.push(full);
  }
  return out;
}

/** 去掉块注释与行注释，避免把说明性中文误判成界面文案。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx === -1) return line;
      // 保护 `https://`、`file://` 之类的协议分隔符
      if (idx > 0 && line[idx - 1] === ":") return line;
      return line.slice(0, idx);
    })
    .join("\n");
}

const findings = [];
for (const file of walk(SRC)) {
  const raw = readFileSync(file, "utf8");
  if (!HAN.test(raw)) continue;
  const rawLines = raw.split("\n");
  const lines = stripComments(raw).split("\n");
  let blockIgnored = false;
  lines.forEach((line, i) => {
    const rawLine = rawLines[i] ?? "";
    if (rawLine.includes("i18n-ignore-start")) {
      blockIgnored = true;
      return;
    }
    if (blockIgnored) {
      if (rawLine.includes("i18n-ignore-end")) blockIgnored = false;
      return;
    }
    if (!HAN.test(line)) return;
    if (rawLine.includes("i18n-ignore")) return;
    findings.push({ file: relative(ROOT, file), line: i + 1, text: line.trim() });
  });
}

const byFile = new Map();
for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);

if (LIST) {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  ${f.text.slice(0, 140)}`);
  }
  console.log("");
}

const rows = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
if (rows.length) {
  console.log("剩余硬编码中文（按条数排序）：");
  for (const [file, count] of rows) console.log(`  ${String(count).padStart(4)}  ${file}`);
}
console.log(
  `\n合计 ${findings.length} 处，涉及 ${rows.length} 个文件。词表：src/i18n/zh-CN.ts`,
);

if (findings.length === 0) {
  console.log("✅ 全站文案已收敛到词表。");
} else if (FAIL) {
  console.error("❌ 仍存在硬编码文案，见上方清单。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// --unused：反向检查。词表里定义了、但源码从未引用过的 key。
// 用途是防止并行迁移时各代理"顺手多建"词条，久了变成没人用的死数据。
// ---------------------------------------------------------------------------
if (UNUSED) {
  const tableFile = join(SRC, "i18n", "zh-CN.ts");
  const tableSource = readFileSync(tableFile, "utf8");
  const startIdx = tableSource.indexOf("{", tableSource.indexOf("export const zhCN"));
  const endIdx = tableSource.lastIndexOf("} as const");
  const tree = new Function(`return (${tableSource.slice(startIdx, endIdx + 1)});`)();

  const flatten = (node, prefix = "", out = []) => {
    for (const [key, child] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === "string") out.push(path);
      else flatten(child, path, out);
    }
    return out;
  };
  const allKeys = flatten(tree);

  // 收集源码里出现过的、形如 `ns.key` 的字符串字面量；模板串只取其静态前缀。
  //
  // 这里**不能**用「成对引号」的正则（/[^"]+/）：一行里有多个字符串（尤其 `: ""` 这种空串）时
  // 引号配对会错位，把 t("palette.modDeployed") 误判成没被引用。改用自定界的 token 匹配。
  const used = new Set();
  const prefixes = [];
  const KEY_TOKEN = /[`"']([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)[`"']/g;
  const PREFIX_TOKEN = /`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)\$\{/g;
  const walkAll = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walkAll(full, out);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(name)) continue;
      if (name === "zh-CN.ts" || SKIP_FILES.has(name)) continue;
      out.push(full);
    }
    return out;
  };
  for (const file of walkAll(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(KEY_TOKEN)) used.add(match[1]);
    for (const match of text.matchAll(PREFIX_TOKEN)) prefixes.push(match[1]);
  }

  const orphans = allKeys.filter(
    (key) => !used.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)),
  );
  console.log(`\n词表共 ${allKeys.length} 条，未被引用的 ${orphans.length} 条：`);
  for (const key of orphans) console.log(`  ? ${key}`);
  if (orphans.length === 0) console.log("✅ 没有死条目。");
}
