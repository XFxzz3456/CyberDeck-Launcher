/**
 * 把 .i18n-parts/*.json（扁平点路径 → 中文值）合并进 src/i18n/zh-CN.ts。
 *
 * 为什么需要脚本：并行迁移时多个子代理各产一份片段，由主 Agent 统一合并，
 * 避免并发写同一个词表文件。合并是幂等的——重复执行结果不变。
 *
 * 用法：
 *   node scripts/merge-i18n-parts.mjs            # 合并所有片段
 *   node scripts/merge-i18n-parts.mjs --check    # 只报告，不写文件
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath 才能正确还原中文路径（pathname 是百分号编码的）。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "src", "i18n", "zh-CN.ts");
const PARTS_DIR = join(ROOT, ".i18n-parts");
const CHECK_ONLY = process.argv.includes("--check");

const source = readFileSync(TARGET, "utf8");
const start = source.indexOf("{", source.indexOf("export const zhCN"));
const end = source.lastIndexOf("} as const");
if (start < 0 || end < 0) {
  console.error("无法定位 zh-CN.ts 中的词表对象");
  process.exit(1);
}

/** 词表是纯对象字面量（字符串叶子 + 注释），可以直接交给 JS 求值。 */
const current = new Function(`return (${source.slice(start, end + 1)});`)();

/** `a.b.c` → { a: { b: { c } } } */
function setPath(target, flatKey, value) {
  const segments = flatKey.split(".");
  let node = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (typeof node[segment] === "string") {
      throw new Error(`key 冲突：${flatKey} 的上级 ${segments.slice(0, i + 1).join(".")} 已是字符串`);
    }
    if (!node[segment]) node[segment] = {};
    node = node[segment];
  }
  const leaf = segments[segments.length - 1];
  if (node[leaf] !== undefined && node[leaf] !== value) {
    throw new Error(`key 重复且值不同：${flatKey}\n  现有 ${JSON.stringify(node[leaf])}\n  片段 ${JSON.stringify(value)}`);
  }
  node[leaf] = value;
}

const added = [];
const skipped = [];
if (existsSync(PARTS_DIR)) {
  for (const file of readdirSync(PARTS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const part = JSON.parse(readFileSync(join(PARTS_DIR, file), "utf8"));
    for (const [key, value] of Object.entries(part)) {
      if (typeof value !== "string") throw new Error(`${file}: ${key} 的值不是字符串`);
      const existed = hasPath(current, key);
      setPath(current, key, value);
      if (existed) skipped.push(`${key} (${file})`);
      else added.push(`${key} (${file})`);
    }
  }
}

function hasPath(root, flatKey) {
  let node = root;
  for (const segment of flatKey.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = node[segment];
  }
  return typeof node === "string";
}

/** 稳定排序输出，让 diff 只反映真实变更。 */
function render(value, depth) {
  const pad = "  ".repeat(depth + 1);
  return Object.keys(value)
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((key) => {
      const child = value[key];
      if (typeof child === "string") {
        return `${pad}${key}: ${JSON.stringify(child)},`;
      }
      return `${pad}${key}: {\n${render(child, depth + 1)}\n${pad}},`;
    })
    .join("\n");
}

const header = `/**
 * 唯一文案来源（zh-CN）。
 *
 * 规则（详见 docs/I18N.md）：
 * 1. 界面上能看到的文本一律从这里取，组件里禁止出现中文字面量；
 * 2. key 是点分命名空间（\`<命名空间>.<语义名>\`），由 \`src/i18n/index.ts\` 递归推导成字面量联合，
 *    写错 key 会在 \`tsc --noEmit\` 报错，不会静默变空；
 * 3. 插值写成 \`{name}\`，调用侧 \`t("ns.key", { name })\`；
 * 4. 标注 \`-- NO TRANSLATE\` 的段是数据值型中文（持久化标识、筛选比较值），
 *    不可翻译，只在渲染层做显示映射（见 \`categoryLabel\` / \`layoutLabel\` 等辅助函数）。
 *
 * 本文件由 \`scripts/merge-i18n-parts.mjs\` 合并生成过，手改后仍可继续合并（幂等）。
 */
export const zhCN = {`;

const body = render(current, 0);
const next = `${header}\n${body}\n} as const;\n`;

if (added.length) {
  console.log(`新增 ${added.length} 条：`);
  for (const key of added) console.log(`  + ${key}`);
}
if (skipped.length) {
  console.log(`已存在且值相同 ${skipped.length} 条（跳过）`);
}
if (CHECK_ONLY) {
  console.log("--check 模式，未写入文件");
  process.exit(0);
}
writeFileSync(TARGET, next, "utf8");
console.log(`已写入 ${TARGET}`);
