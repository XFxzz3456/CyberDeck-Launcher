import { useMemo, useState } from "react";
import { Check, Languages, Search, SkipForward } from "lucide-react";
import type { ModEntry } from "../types";
import { formatBytes } from "../lib/format";
import { parentCandidates, type ParentCandidate } from "../lib/translationMatch";
import { t } from "../i18n";
import { Modal } from "./ui";

/**
 * 导入疑似汉化包后的「请选择它对应的原版 Mod」弹窗。
 *
 * 设计取舍：
 * - **默认不绑定**。识别只靠名字关键词，误判率不低（`Contact Names` 之类
 *   看起来很像）。所以默认选中「作为独立 Mod 安装」，用户确认后才建立父子关系。
 * - 候选按相似度排序并给出命中原因，避免用户在一堆陌生名字里瞎猜。
 * - 允许一次选择后「记住这次选择」以外的批量入口不做：真实场景里汉化包
 *   一次通常只装一个，做成批量反而容易绑错。
 */
export function TranslationBindDialog({
  mod,
  mods,
  onBind,
  onSkip,
  busy = false,
}: {
  /** 待绑定的汉化包；null 时不渲染内容。 */
  mod: ModEntry | null;
  /** 全库模组，用于计算候选父级。 */
  mods: ModEntry[];
  onBind: (parentId: string) => void;
  /** 作为独立 Mod 安装（不改任何关系）。 */
  onSkip: () => void;
  busy?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const candidates = useMemo(() => {
    if (!mod) return [] as ParentCandidate[];
    const list = parentCandidates(mod, mods, 40);
    const needle = query.trim().toLowerCase();
    return (needle
      ? list.filter((item) => item.mod.name.toLowerCase().includes(needle))
      : list
    ).slice(0, 12);
  }, [mod, mods, query]);

  if (!mod) return null;
  const reasonLabel: Record<ParentCandidate["reason"], string> = {
    sameCoreName: t("translationBind.reasonSameName"),
    sharedTokens: t("translationBind.reasonSimilar"),
    sameArchive: t("translationBind.reasonSameArchive"),
  };

  return (
    <Modal
      open
      title={t("translationBind.title")}
      eyebrow="// TRANSLATION CHILD"
      width={560}
      onClose={onSkip}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onSkip} disabled={busy}>
            <SkipForward size={13} /> {t("translationBind.standalone")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || selected === null}
            onClick={() => selected && onBind(selected)}
          >
            <Check size={13} /> {t("translationBind.confirm")}
          </button>
        </>
      }
    >
      <div className="bind-dialog">
        <div className="bind-hero">
          <span className="bind-icon">
            <Languages size={18} />
          </span>
          <div>
            <strong>{mod.name}</strong>
            <p>{t("translationBind.intro", { size: formatBytes(mod.sizeBytes) })}</p>
          </div>
        </div>

        <label className="bind-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("translationBind.searchPlaceholder")}
          />
        </label>

        <div className="bind-list" role="listbox" aria-label={t("translationBind.listAria")}>
          {candidates.length === 0 ? (
            <p className="bind-empty">{t("translationBind.empty")}</p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.mod.id}
                type="button"
                role="option"
                aria-selected={selected === candidate.mod.id}
                className={`bind-row ${selected === candidate.mod.id ? "is-selected" : ""}`}
                onClick={() => setSelected(candidate.mod.id)}
              >
                <span className="bind-row-main">
                  <b>{candidate.mod.name}</b>
                  <em>
                    {reasonLabel[candidate.reason]}
                    {candidate.mod.version ? ` · ${candidate.mod.version}` : ""}
                    {candidate.mod.category ? ` · ${candidate.mod.category}` : ""}
                  </em>
                </span>
                <span className="bind-score">{Math.round(candidate.score * 100)}%</span>
              </button>
            ))
          )}
        </div>

        <p className="bind-note">{t("translationBind.note")}</p>
      </div>
    </Modal>
  );
}
