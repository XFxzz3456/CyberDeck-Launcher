import type { ModEntry } from "../types";

/**
 * 汉化包 → 原版 Mod 的模糊匹配。
 *
 * 汉化包命名几乎都是「原版名 + 语言标记」：`Cool Outfit CHS`、`酷衣服-汉化`、
 * `Cool Outfit 简体中文补丁`。所以先去掉语言标记，再比剩余名字的相似度，
 * 比直接拿全名比要准得多——语言标记本身就是噪音。
 */

/** 语言相关标记，匹配前先剔除。长词在前，避免 `中文` 先被 `文本` 之类截断。 */
// i18n-ignore-start  （这是匹配用关键词表，不是界面文案）
const LANGUAGE_MARKERS = [
  "简体中文",
  "繁体中文",
  "中文本地化",
  "中文补丁",
  "汉化包",
  "汉化",
  "中文",
  "翻译",
  "translation",
  "translate",
  "localization",
  "localisation",
  "chinese",
  "simplified",
  "traditional",
  "zh-cn",
  "zh_cn",
  "zhcn",
  "zhtw",
  "chs",
  "cht",
  "cn",
];
// i18n-ignore-end

/** 去掉语言标记与常见分隔符，只留「主体名」。 */
export function coreModName(name: string): string {
  let out = name.toLowerCase();
  for (const marker of LANGUAGE_MARKERS) {
    out = out.split(marker).join(" ");
  }
  return out
    .replace(/[()[\]{}<>《》【】「」\-_+/\\|,，.。:：;；!！?？'"“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(name: string): string[] {
  return coreModName(name)
    .split(" ")
    .filter((token) => token.length > 1);
}

/** 相似度 0~1：词集合的 Jaccard 系数，完全一致时给 1。 */
export function nameSimilarity(left: string, right: string): number {
  const a = coreModName(left);
  const b = coreModName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    // 名字都是短词（如 `CET`）时退回前缀比较，避免 Jaccard 恒为 0。
    return a.startsWith(b) || b.startsWith(a) ? 0.6 : 0;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / (leftTokens.size + rightTokens.size - shared);
}

export interface ParentCandidate {
  mod: ModEntry;
  score: number;
  /** 命中原因，直接展示给用户，避免「为什么它排第一」的困惑。 */
  reason: "sameCoreName" | "sharedTokens" | "sameArchive";
}

/**
 * 给汉化包找出候选父级，按相似度降序。
 *
 * 排除项：
 * - 自己；
 * - 已经是别人的汉化子包（避免链式挂载）；
 * - 其它汉化包（汉化包不能当父级，否则级联禁用会变得不可预测）。
 */
export function parentCandidates(child: ModEntry, mods: ModEntry[], limit = 6): ParentCandidate[] {
  const childCore = coreModName(child.name);
  const childArchives = new Set(
    child.plannedFiles
      .filter((path) => path.toLowerCase().endsWith(".archive"))
      .map((path) => path.split("/").pop()?.toLowerCase() ?? ""),
  );

  const scored: ParentCandidate[] = [];
  for (const mod of mods) {
    if (mod.id === child.id) continue;
    if (mod.parentModId) continue;
    if (mod.isTranslation) continue;

    const modCore = coreModName(mod.name);
    let score = nameSimilarity(child.name, mod.name);
    let reason: ParentCandidate["reason"] = "sharedTokens";
    if (childCore && modCore && childCore === modCore) {
      score = 1;
      reason = "sameCoreName";
    }
    if (score < 0.45) {
      // 名字对不上时再试一次「同名 archive」：汉化包经常直接覆盖原包的
      // archive，文件名一样就说明它们改的是同一份资源。
      const hit = mod.plannedFiles.some((path) => {
        const name = path.split("/").pop()?.toLowerCase() ?? "";
        return name.length > 0 && childArchives.has(name);
      });
      if (hit) {
        score = Math.max(score, 0.5);
        reason = "sameArchive";
      }
    }
    if (score > 0) scored.push({ mod, score, reason });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 某个父级的直属汉化子包。 */
export function translationChildren(parentId: string, mods: ModEntry[]): ModEntry[] {
  return mods.filter((mod) => mod.parentModId === parentId);
}

/** 主网格要排除的条目：已绑定父级的汉化子包不单独占位。 */
export function isBoundTranslation(mod: ModEntry): boolean {
  return mod.parentModId !== null;
}
