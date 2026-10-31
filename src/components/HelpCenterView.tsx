import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, ChevronDown, Search } from "lucide-react";
import { HELP_FAQ, HELP_TUTORIALS } from "../lib/helpContent";
import { useMotionEnabled } from "../lib/preferences";
import { t } from "../i18n";
import "./HelpCenterView.css";

type Section = "all" | "tutorials" | "faq";

/**
 * 内置帮助中心（看板【11】）。
 *
 * 内容全部随包，断网可读——新手最需要帮助的时刻，往往正是网络出了问题的时候。
 * 折叠面板用 framer-motion 做高度动画，关动效时直接跳变。
 */
export function HelpCenterView({ embedded = false }: { embedded?: boolean } = {}) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>("all");
  const [openIds, setOpenIds] = useState<string[]>([]);
  const motionEnabled = useMotionEnabled();

  const keyword = query.trim().toLowerCase();
  const tutorials = useMemo(
    () =>
      HELP_TUTORIALS.filter((item) => {
        if (!keyword) return true;
        return (
          item.title.toLowerCase().includes(keyword) ||
          item.summary.toLowerCase().includes(keyword) ||
          item.steps.some((step) => step.text.toLowerCase().includes(keyword))
        );
      }),
    [keyword],
  );
  const faqs = useMemo(
    () =>
      HELP_FAQ.filter((item) => {
        if (!keyword) return true;
        return (
          item.question.toLowerCase().includes(keyword) ||
          item.answer.toLowerCase().includes(keyword)
        );
      }),
    [keyword],
  );

  const toggle = (id: string) => {
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const total = tutorials.length + faqs.length;
  const showTutorials = section !== "faq";
  const showFaq = section !== "tutorials";

  return (
    // embedded = 挂在「设置 → 帮助」里：不再画整页头部（设置页已经有标题和 Tab），
    // 其余结构（搜索 / 三段切换 / 折叠面板 / 空态）原样保留。
    <div className={embedded ? "help-page is-embedded" : "page help-page"}>
      {embedded ? (
        <p className="help-embedded-hint">
          <BookOpen size={13} aria-hidden="true" />
          <span>{t("helpCenter.embeddedHint")}</span>
        </p>
      ) : (
        <header className="page-head">
          <div>
            <div className="page-kicker">// HELP / OFFLINE</div>
            <h1>{t("helpCenter.title")}</h1>
          </div>
        </header>
      )}

      <div className="help-toolbar">
        <label className="help-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("helpCenter.searchPlaceholder")}
            spellCheck={false}
          />
        </label>
        <div className="help-segments" role="tablist" aria-label={t("helpCenter.sectionsAria")}>
          {(
            [
              ["all", t("helpCenter.sectionAll")],
              ["tutorials", t("helpCenter.sectionTutorials")],
              ["faq", t("helpCenter.sectionFaq")],
            ] as Array<[Section, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={section === id}
              className={`help-segment${section === id ? " is-active" : ""}`}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <div className="help-empty">
          <BookOpen size={26} />
          <p>{t("helpCenter.empty")}</p>
        </div>
      ) : null}

      {showTutorials && tutorials.length > 0 ? (
        <section className="help-block">
          <h2 className="help-block-title">
            {t("helpCenter.sectionTutorials")}
            <span className="help-count">{tutorials.length}</span>
          </h2>
          <div className="help-list">
            {tutorials.map((item) => {
              const open = openIds.includes(item.id);
              return (
                <article key={item.id} className={`help-item${open ? " is-open" : ""}`}>
                  <button
                    className="help-trigger"
                    aria-expanded={open}
                    onClick={() => toggle(item.id)}
                  >
                    <span className="help-trigger-text">
                      <strong>{item.title}</strong>
                      <small>{item.summary}</small>
                    </span>
                    <ChevronDown
                      size={16}
                      className="help-chevron"
                      style={{ transform: open ? "rotate(180deg)" : undefined }}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {open ? (
                      <motion.div
                        key="body"
                        initial={
                          motionEnabled ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }
                        }
                        animate={{ height: "auto", opacity: 1 }}
                        exit={motionEnabled ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }}
                        transition={{ duration: motionEnabled ? 0.22 : 0, ease: "easeOut" }}
                        style={{ overflow: "hidden" }}
                      >
                        <ol className="help-steps">
                          {item.steps.map((step, index) => (
                            <li key={`${item.id}-${index}`}>
                              <span className="help-step-no">{String(index + 1).padStart(2, "0")}</span>
                              <span className="help-step-body">
                                {step.text}
                                {step.where ? <em className="help-where">{step.where}</em> : null}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {showFaq && faqs.length > 0 ? (
        <section className="help-block">
          <h2 className="help-block-title">
            {t("helpCenter.sectionFaq")}
            <span className="help-count">{faqs.length}</span>
          </h2>
          <div className="help-list">
            {faqs.map((item) => {
              const open = openIds.includes(item.id);
              return (
                <article key={item.id} className={`help-item${open ? " is-open" : ""}`}>
                  <button
                    className="help-trigger"
                    aria-expanded={open}
                    onClick={() => toggle(item.id)}
                  >
                    <span className="help-trigger-text">
                      <strong>{item.question}</strong>
                    </span>
                    <ChevronDown
                      size={16}
                      className="help-chevron"
                      style={{ transform: open ? "rotate(180deg)" : undefined }}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {open ? (
                      <motion.div
                        key="body"
                        initial={
                          motionEnabled ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }
                        }
                        animate={{ height: "auto", opacity: 1 }}
                        exit={motionEnabled ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }}
                        transition={{ duration: motionEnabled ? 0.22 : 0, ease: "easeOut" }}
                        style={{ overflow: "hidden" }}
                      >
                        <p className="help-answer">{item.answer}</p>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <p className="help-foot">{t("helpCenter.foot")}</p>
    </div>
  );
}
