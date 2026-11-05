import type { ModEntry } from "../types";
import { categoryLabel } from "../i18n";

/**
 * 列表排序字段。
 *
 * `recent`（安装时间）没有对应列，只出现在工具栏下拉里；其余五个都能点列头。
 */
export type SortMode = "name" | "version" | "category" | "size" | "recent" | "status";

/** 排序方向。 */
export type SortDir = "asc" | "desc";

const SORT_MODES: readonly SortMode[] = [
  "name",
  "version",
  "category",
  "size",
  "recent",
  "status",
];

export function isSortMode(value: unknown): value is SortMode {
  return typeof value === "string" && (SORT_MODES as readonly string[]).includes(value);
}

export function isSortDir(value: unknown): value is SortDir {
  return value === "asc" || value === "desc";
}

/**
 * 每个字段「第一次选中」时用的方向。
 *
 * 按看表的直觉定：名称 A→Z、体积大到小、最近安装在前、版本号新的在前。
 * 列头第一次点击也走这套默认值，再点同一列才翻转。
 */
export const DEFAULT_SORT_DIR: Record<SortMode, SortDir> = {
  name: "asc",
  version: "desc",
  category: "asc",
  size: "desc",
  recent: "desc",
  status: "desc",
};

/** 展示名：有中文译名时用译名，否则回退原名。排序与卡片标题共用同一规则。 */
export function displayNameOf(mod: ModEntry): string {
  const translated = (mod.translatedName ?? "").trim();
  return translated.length > 0 ? translated : mod.name;
}

function byName(a: ModEntry, b: ModEntry): number {
  return displayNameOf(a).localeCompare(displayNameOf(b), "zh-CN");
}

/**
 * 版本号的自然序比较：`1.2.10` 要排在 `1.2.9` 之后。
 *
 * 纯字符串比较会把 "10" 判成小于 "9"，mod 版本号一过 9 就整个乱掉。
 * 按数字段 / 非数字段切开逐段比，`1.0-beta` 这类后缀退化成字符串比较。
 */
export function compareVersion(a: string, b: string): number {
  const left = a.split(/(\d+)/).filter((segment) => segment !== "");
  const right = b.split(/(\d+)/).filter((segment) => segment !== "");
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === r) continue;
    const ln = Number(l);
    const rn = Number(r);
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      // 两段都是数字（"007" 与 "7" 也会走到这里），差为 0 就继续比下一段。
      const diff = ln - rn;
      if (diff !== 0) return diff;
      continue;
    }
    return l < r ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * 排序比较器。
 *
 * 降序统一用「取反」表达，不再给每个分支各写一遍升降逻辑。
 * 并列时一律回落到名称升序：同一份数据两次排序必须给出完全相同的顺序，
 * 否则虚拟滚动的 key 会在重排时抖。
 */
export function compareMods(a: ModEntry, b: ModEntry, sort: SortMode, dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  switch (sort) {
    case "name":
      return sign * byName(a, b);
    case "recent":
      return sign * (a.installedAt ?? "").localeCompare(b.installedAt ?? "") || byName(a, b);
    case "size":
      return sign * (a.sizeBytes - b.sizeBytes) || byName(a, b);
    case "status":
      // 启用状态只有两档：desc = 已启用在前（默认），asc = 已禁用在前。
      return sign * (Number(a.enabled) - Number(b.enabled)) || byName(a, b);
    case "category":
      return (
        sign * categoryLabel(a.category).localeCompare(categoryLabel(b.category), "zh-CN") ||
        byName(a, b)
      );
    case "version": {
      const left = (a.version ?? "").trim();
      const right = (b.version ?? "").trim();
      // 没写版本号的沉底：无论升序降序，都不该有「无版本」的行插在中间。
      if (left === "" && right === "") return byName(a, b);
      if (left === "") return 1;
      if (right === "") return -1;
      return sign * compareVersion(left, right) || byName(a, b);
    }
    default:
      // 所有 SortMode 都已在上面分流；这里是状态文件被手改成脏值时的兜底，
      // 不是给新字段用的——新增字段必须补一条 case，否则排序会静默失效。
      return byName(a, b);
  }
}

/**
 * 点列头之后的新排序状态：同一列翻转方向，换列则用该列默认方向。
 *
 * 单独抽出来是为了让「列头点击」和「下拉切换」共用一套规则——
 * 下拉换字段时也走 DEFAULT_SORT_DIR，不会出现「切成体积但仍是升序」的怪状态。
 */
export function nextSort(
  current: SortMode,
  currentDir: SortDir,
  field: SortMode,
): { sort: SortMode; dir: SortDir } {
  if (current !== field) return { sort: field, dir: DEFAULT_SORT_DIR[field] };
  return { sort: field, dir: currentDir === "asc" ? "desc" : "asc" };
}
