import type { ModEntry } from "../types";
import { CATEGORIES } from "../types";
import { categoryLabel, t } from "../i18n";

/** 列表视图的状态筛选。与左侧分类筛选是两条独立维度，可以叠加。 */
export type StatusFilter = "all" | "enabled" | "disabled" | "missing";

const STATUS_FILTERS: readonly StatusFilter[] = ["all", "enabled", "disabled", "missing"];

export function isStatusFilter(value: unknown): value is StatusFilter {
  return typeof value === "string" && (STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * 分组维度。
 *
 * 只有「分类」是初始化就有的；其余是 2026-11-04 照 Vortex 的 Mods 表格补的：
 * 一个大库按分类看腻了之后，最常见的两个问题就是「哪些还没启用」和「这个作者的东西在哪」。
 */
export type GroupBy = "category" | "status" | "author" | "installed";

const GROUP_BYS: readonly GroupBy[] = ["category", "status", "author", "installed"];

export function isGroupBy(value: unknown): value is GroupBy {
  return typeof value === "string" && (GROUP_BYS as readonly string[]).includes(value);
}

/** 列表视图的一行：分组标题，或一条模组。 */
export type LibraryListItem =
  | {
      type: "header";
      /**
       * 折叠状态的记忆键。其余三个维度都带前缀（status: / author: / installed:），
       * 分类维度保留原始分类值——旧版本就是用分类值当键存进 localStorage 的，
       * 加前缀会让所有人升级后已折叠的分组全部弹开。
       */
      key: string;
      /** 组头显示的文字。分类走 categoryLabel()，其余维度已经是成品文案。 */
      label: string;
      count: number;
      collapsed: boolean;
    }
  | { type: "mod"; mod: ModEntry };

/** 兜底组（未知作者 / 未知时间 / 未登记分类）统一沉到最后一档。 */
const LAST_ORDER = 10_000;

/** 分类的固定组序：框架 → 玩法 → …… → 其他。 */
const CATEGORY_ORDER = new Map<string, number>(
  CATEGORIES.filter((item) => item !== "全部" && item !== "已启用").map((item, index) => [item, index]), // i18n-ignore（B 类持久化值）
);

interface GroupDraft {
  key: string;
  label: string;
  order: number;
}

/** 一条模组落在哪个组。 */
function groupOf(mod: ModEntry, by: GroupBy): GroupDraft {
  switch (by) {
    case "status":
      return mod.enabled
        ? { key: "status:on", label: t("library.groupEnabled"), order: 0 }
        : { key: "status:off", label: t("library.groupDisabled"), order: 1 };
    case "author": {
      const author = (mod.author ?? "").trim();
      // 作者名是用户数据，原样做组名、不翻译；空作者单独一组，别混进字母序里。
      return author
        ? { key: `author:${author.toLowerCase()}`, label: author, order: 0 }
        : { key: "author:", label: t("library.groupUnknownAuthor"), order: LAST_ORDER };
    }
    case "installed": {
      const month = (mod.installedAt ?? "").slice(0, 7);
      const matched = /^(\d{4})-(\d{2})$/.exec(month);
      if (!matched) {
        return { key: "installed:", label: t("library.groupUnknownDate"), order: LAST_ORDER };
      }
      const year = Number(matched[1]);
      const index = Number(matched[2]);
      // 最新装的排最前：把「年 × 12 + 月」取负，升序排出来就是倒序。
      return {
        key: `installed:${month}`,
        label: t("library.groupMonth", { year, month: index }),
        order: -(year * 12 + index),
      };
    }
    case "category":
    default: {
      const category = mod.category || "其他"; // i18n-ignore（B 类持久化值，不是文案）
      return {
        key: category,
        label: categoryLabel(category),
        order: CATEGORY_ORDER.get(category) ?? LAST_ORDER,
      };
    }
  }
}

/**
 * 把（已筛选、已排序的）模组摊成「组头 + 行」的扁平数组。
 *
 * 为什么在调用方算完再交给虚拟滚动，而不是让虚拟列表自己分组：折叠状态一变，
 * 数组长度就变，虚拟器只要重新 measure 一次即可；如果把分组藏进渲染层，
 * 每帧都要重算分组，还得自己维护「第几行属于哪组」的偏移。
 *
 * 组顺序由 groupOf() 给出的 order 决定，不按数量排：玩家找「框架」时习惯去
 * 最上面找，按数量排会让它在不同库之间跳来跳去。同一 order 的组（例如作者
 * 分组里所有作者）按组名排。
 */
export function buildLibraryList(
  mods: ModEntry[],
  collapsed: Set<string>,
  grouped: boolean,
  groupBy: GroupBy = "category",
): LibraryListItem[] {
  if (!grouped) {
    return mods.map((mod) => ({ type: "mod" as const, mod }));
  }

  const buckets = new Map<string, { label: string; order: number; mods: ModEntry[] }>();
  for (const mod of mods) {
    const draft = groupOf(mod, groupBy);
    const bucket = buckets.get(draft.key);
    if (bucket) bucket.mods.push(mod);
    else buckets.set(draft.key, { label: draft.label, order: draft.order, mods: [mod] });
  }

  const ordered = [...buckets.entries()].sort(
    ([, a], [, b]) => a.order - b.order || a.label.localeCompare(b.label, "zh-CN"),
  );

  const items: LibraryListItem[] = [];
  for (const [key, bucket] of ordered) {
    const isCollapsed = collapsed.has(key);
    items.push({
      type: "header",
      key,
      label: bucket.label,
      count: bucket.mods.length,
      collapsed: isCollapsed,
    });
    if (isCollapsed) continue;
    for (const mod of bucket.mods) {
      items.push({ type: "mod", mod });
    }
  }
  return items;
}
