import type { ModEntry } from "../types";
import { CATEGORIES } from "../types";

/** 列表视图的一行：分组标题，或一条模组。 */
export type LibraryListItem =
  | { type: "header"; category: string; count: number; collapsed: boolean }
  | { type: "mod"; mod: ModEntry };

/**
 * 把（已筛选、已排序的）模组摊成「组头 + 行」的扁平数组。
 *
 * 为什么在调用方算完再交给虚拟滚动，而不是让虚拟列表自己分组：折叠状态一变，
 * 数组长度就变，虚拟器只要重新 measure 一次即可；如果把分组藏进渲染层，
 * 每帧都要重算分组，还得自己维护「第几行属于哪组」的偏移。
 *
 * 组顺序沿用 `CATEGORIES`（框架 → 玩法 → …… → 其他），不按数量排：玩家找
 * 「框架」时习惯去最上面找，按数量排会让它在不同库之间跳来跳去。
 */
export function buildLibraryList(
  mods: ModEntry[],
  collapsed: Set<string>,
  grouped: boolean,
): LibraryListItem[] {
  if (!grouped) {
    return mods.map((mod) => ({ type: "mod" as const, mod }));
  }

  const buckets = new Map<string, ModEntry[]>();
  for (const mod of mods) {
    const key = mod.category || "其他"; // i18n-ignore（B 类持久化值，不是文案）
    const bucket = buckets.get(key);
    if (bucket) bucket.push(mod);
    else buckets.set(key, [mod]);
  }

  // CATEGORIES 里没有的取值（第三方写坏的 category）排在最后，别丢数据。
  const known = CATEGORIES.filter((item) => item !== "全部" && item !== "已启用") as readonly string[]; // i18n-ignore（同上）
  const order = [
    ...known.filter((item) => buckets.has(item)),
    ...[...buckets.keys()].filter((item) => !known.includes(item)).sort(),
  ];

  const items: LibraryListItem[] = [];
  for (const category of order) {
    const bucket = buckets.get(category) ?? [];
    const isCollapsed = collapsed.has(category);
    items.push({ type: "header", category, count: bucket.length, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (const mod of bucket) {
      items.push({ type: "mod", mod });
    }
  }
  return items;
}
