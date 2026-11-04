import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ScrollText, ShieldAlert } from "lucide-react";
import eulaSource from "../assets/eula.md?raw";
import { parseMarkdownLite, splitInlineBold, type MdBlock } from "../lib/markdownLite";
import { useEscLayer } from "../lib/escLayer";
import { t } from "../i18n";

export type EulaMode = "gate" | "viewer";

/**
 * 使用协议弹窗。两种形态共用一套排版：
 *
 * - `gate`：首启强制拦截。没有关闭按钮、点遮罩不关、Esc 不关，
 *   勾选复选框之前「同意并继续」是禁用的，唯一出口是同意或拒绝退出。
 *   注意：它是一层**盖在主界面之上的遮罩**（主界面照常渲染、被模糊压暗），
 *   不是替换主界面——否则首帧就是白屏。
 * - `viewer`：从「设置 → 关于」打开，只做展示，随时可关。
 *
 * 正文来自 `src/assets/eula.md`（构建时内联成字符串，不会运行时 404）。
 * 解析不出来就只显示三条摘要 + 一句说明，绝不留白屏。
 */
export function EulaDialog({
  mode,
  closing = false,
  onAccept,
  onDecline,
  onClose,
}: {
  mode: EulaMode;
  /** gate 模式下点同意后的淡出态：保持挂载、降透明度，淡完由上层卸载。 */
  closing?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onClose?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [consent, setConsent] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);

  const blocks = useMemo<MdBlock[] | null>(() => {
    try {
      const parsed = parseMarkdownLite(eulaSource ?? "");
      return parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }, []);

  // viewer 模式的 Esc 也走弹层栈：协议是从设置里打开的，别把设置一起关掉。
  useEscLayer(mode === "viewer", () => onClose?.());

  const isGate = mode === "gate";

  // gate：初始焦点落在弹窗本体上（读屏从头读，且回车有落点）。
  useEffect(() => {
    if (isGate) dialogRef.current?.focus();
  }, [isGate]);

  // gate：焦点锁。底层已 inert，这里再兜一层 Tab，键盘也翻不到背后去。
  useEffect(() => {
    if (!isGate) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, input, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hasAttribute("disabled") && node.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isGate]);

  // gate：勾选后回车即同意。按钮/协议正文里的回车有各自含义，不抢。
  useEffect(() => {
    if (!isGate || !consent) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, .eula-full")) return;
      event.preventDefault();
      onAccept?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isGate, consent, onAccept]);

  return (
    <div className={`eula-portal${closing ? " is-closing" : ""}`} role="presentation">
      {isGate ? (
        <div className="eula-backdrop" />
      ) : (
        <button
          className="eula-backdrop"
          aria-label={t("common.close")}
          onClick={() => onClose?.()}
        />
      )}
      <section
        ref={dialogRef}
        className="eula-dialog"
        role="dialog"
        aria-modal={isGate}
        aria-labelledby="eula-dialog-title"
        tabIndex={-1}
      >
        <header className="eula-head">
          <div className="eula-head-mark" aria-hidden="true">
            <ScrollText size={18} />
          </div>
          <div>
            <div className="eyebrow">// EULA</div>
            <h2 id="eula-dialog-title">{t("eula.title")}</h2>
            {blocks ? null : <p className="eula-updated">{t("eula.updated")}</p>}
          </div>
        </header>

        <div className="eula-body">
          <div className="eula-summary">
            <ul>
              <li>{t("eula.summaryBackup")}</li>
              <li>{t("eula.summaryAi")}</li>
              <li>{t("eula.summaryUnofficial")}</li>
            </ul>
          </div>

          <button
            type="button"
            className="eula-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{expanded ? t("eula.collapse") : t("eula.readFull")}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>

          {expanded ? (
            <div className="eula-full" role="region" aria-label={t("eula.title")} tabIndex={0}>
              {blocks ? (
                blocks.map((block, index) => renderBlock(block, index))
              ) : (
                <p className="eula-fallback">
                  <ShieldAlert size={14} /> {t("eula.fullFallback")}
                </p>
              )}
            </div>
          ) : null}
        </div>

        <footer className="eula-foot">
          {isGate ? (
            <>
              <label className="eula-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>{t("eula.consent")}</span>
              </label>
              <div className="eula-actions">
                <button className="btn btn-ghost" onClick={() => onDecline?.()}>
                  {t("eula.decline")}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!consent}
                  onClick={() => onAccept?.()}
                >
                  {t("eula.accept")}
                </button>
              </div>
            </>
          ) : (
            <div className="eula-actions">
              <button className="btn btn-primary" onClick={() => onClose?.()}>
                {t("eula.close")}
              </button>
            </div>
          )}
        </footer>
      </section>
    </div>
  );
}

/** 标题层级：弹窗标题已占 h2，协议正文从 h3 起，避免读屏跳级。 */
function renderBlock(block: MdBlock, index: number) {
  const inline = splitInlineBold(block.text).map((part, partIndex) =>
    part.bold ? <strong key={partIndex}>{part.text}</strong> : <span key={partIndex}>{part.text}</span>,
  );

  switch (block.kind) {
    case "h1":
      return (
        <h3 key={index} className="eula-h1">
          {inline}
        </h3>
      );
    case "h2":
      return (
        <h4 key={index} className="eula-h2">
          {inline}
        </h4>
      );
    case "h3":
      return (
        <h5 key={index} className="eula-h3">
          {inline}
        </h5>
      );
    case "li":
      return (
        <p key={index} className="eula-li">
          {inline}
        </p>
      );
    default:
      return <p key={index}>{inline}</p>;
  }
}
