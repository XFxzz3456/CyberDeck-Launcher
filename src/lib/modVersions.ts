import type { ModEntry } from "../types";

/**
 * 同一个 mod 的多版本聚合。
 *
 * ## 为什么需要
 *
 * 库里的条目是按「一次安装」登记的：Vortex 每换一个版本就多一个 mod 目录，
 * 收编时一个目录一条记录，于是同一个 mod 在库里出现 2～4 张卡（Lizzie's
 * Braindances 就是 4 张：2.03 / 2.29 / 3.20 / 3.22）。玩家看到的不是
 * 「四个版本」，而是「这个 mod 怎么重复了」。
 *
 * Vortex 的做法是「同一个 mod 只允许一个版本启用」。这里把这套语义搬到界面上：
 * **一张卡代表一个 mod**，卡上带版本下拉，切哪个就部署哪个、其余自动撤下
 * （切换动作走 `switch_mod_version`，分组只在前端做展示层聚合，不动库里的数据）。
 *
 * ## 分组口径必须与 Rust 侧一致
 *
 * `switch_mod_version` 自己会按同样的规则找兄弟版本（见 lib.rs 的
 * `version_identity`）。两边口径一旦不同，就会出现「界面切了但旧版本没撤」
 * 或「撤了不该撤的」，所以这里的键必须和它逐字对应：
 * Nexus modId 优先，没有就退回同名（去空白、忽略大小写）。
 */
export function versionGroupKey(mod: ModEntry): string {
  const modId = mod.nexus?.modId ?? 0;
  if (modId > 0) return `nexus:${modId}`;
  return `name:${mod.name.trim().toLowerCase()}`;
}

/** 版本号是否可比较：纯数字段按数值比，其余按字典序（`1.10` > `1.9`）。 */
function compareVersionText(left: string | null, right: string | null): number {
  const a = (left ?? "").trim();
  const b = (right ?? "").trim();
  if (!a || !b) return a === b ? 0 : a ? -1 : 1;
  const chunk = (value: string) => value.split(/[^0-9a-zA-Z]+/).filter(Boolean);
  const leftParts = chunk(a);
  const rightParts = chunk(b);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const one = leftParts[index];
    const two = rightParts[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const oneNumber = /^\d+$/.test(one);
    const twoNumber = /^\d+$/.test(two);
    if (oneNumber && twoNumber) {
      const diff = Number(one) - Number(two);
      if (diff !== 0) return diff;
      continue;
    }
    const diff = one.localeCompare(two, "en");
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 版本从新到旧。用于下拉里的顺序与「默认选哪个」。 */
export function compareVersionsDesc(left: string | null, right: string | null): number {
  return -compareVersionText(left, right);
}

export interface VersionGrouping {
  /** 交给列表渲染的条目：每个 mod 只有一个代表（被启用的那个，或最新版本）。 */
  display: ModEntry[];
  /** 代表 id → 该 mod 的全部版本（新→旧）。只有多版本才会出现在这张表里。 */
  groups: Map<string, ModEntry[]>;
}

/**
 * 把（已筛选、已排序的）模组按「同一个 mod」聚合。
 *
 * 代表的选择顺序：**正在启用的那个**优先（界面必须如实反映游戏目录里现在装的是
 * 哪个版本），否则取版本号最大的。汉化子包（`parentModId` / `isTranslation`）
 * 不参与聚合——它们本来就该挂在父级卡片上。
 */
export function groupVersions(mods: ModEntry[]): VersionGrouping {
  const buckets = new Map<string, ModEntry[]>();
  const order: string[] = [];
  for (const mod of mods) {
    const key =
      mod.parentModId || mod.isTranslation ? `single:${mod.id}` : versionGroupKey(mod);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(mod);
    else {
      buckets.set(key, [mod]);
      order.push(key);
    }
  }

  const display: ModEntry[] = [];
  const groups = new Map<string, ModEntry[]>();
  for (const key of order) {
    const members = buckets.get(key) ?? [];
    if (members.length <= 1) {
      if (members[0]) display.push(members[0]);
      continue;
    }
    const sorted = [...members].sort((left, right) =>
      compareVersionsDesc(left.version, right.version),
    );
    const active = sorted.find((item) => item.enabled) ?? sorted[0];
    display.push(active);
    groups.set(active.id, sorted);
  }
  return { display, groups };
}

/** 多版本的 mod 有多少个（「共 N 个 mod 有多个版本」提示用）。 */
export function countMultiVersionMods(mods: ModEntry[]): number {
  const seen = new Map<string, number>();
  for (const mod of mods) {
    if (mod.parentModId || mod.isTranslation) continue;
    const key = versionGroupKey(mod);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const count of seen.values()) if (count > 1) total += 1;
  return total;
}
