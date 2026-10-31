import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertOctagon, ShieldAlert } from "lucide-react";
import { Modal, Spinner } from "./ui";
import { t } from "../i18n";

/**
 * Destructive actions use a press-and-hold gate instead of a normal click.
 * A single accidental click can never trigger it; the pointer has to stay on
 * the button for the full duration and the fill makes that state visible.
 */
export function DangerConfirmModal({
  open,
  title,
  detail,
  confirmLabel = t("danger.confirmLabel"),
  busy = false,
  holdMs = 1500,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  detail: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  holdMs?: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const startRef = useRef(0);
  const frameRef = useRef(0);
  const doneRef = useRef(false);
  /** 按住时长的展示形态（一位小数），aria 与正文共用，避免两处格式漂移。 */
  const holdSeconds = (holdMs / 1000).toFixed(1);

  const cancel = () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    startRef.current = 0;
    doneRef.current = false;
    setHolding(false);
    setProgress(0);
  };

  useEffect(() => {
    if (!open) cancel();
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onBlur = () => cancel();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tick = () => {
    const elapsed = performance.now() - startRef.current;
    const next = Math.min(1, elapsed / holdMs);
    setProgress(next);
    if (next >= 1) {
      doneRef.current = true;
      frameRef.current = 0;
      setHolding(false);
      onConfirm();
      return;
    }
    frameRef.current = requestAnimationFrame(tick);
  };

  const begin = () => {
    if (busy || doneRef.current) return;
    cancel();
    doneRef.current = false;
    startRef.current = performance.now();
    setHolding(true);
    setProgress(0);
    frameRef.current = requestAnimationFrame(tick);
  };

  const release = () => {
    if (doneRef.current) return;
    cancel();
  };

  return (
    <Modal
      open={open}
      title={title}
      eyebrow={t("danger.eyebrow")}
      onClose={() => {
        if (!busy) onClose();
      }}
      width={500}
      footer={
        <>
          <button
            className="btn btn-ghost"
            onClick={() => {
              cancel();
              onClose();
            }}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={`btn btn-danger danger-hold ${holding ? "is-holding" : ""}`}
            disabled={busy}
            aria-label={t("danger.holdAria", { seconds: holdSeconds, label: confirmLabel })}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              begin();
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onPointerLeave={release}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                event.preventDefault();
                begin();
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                release();
              }
            }}
            onBlur={release}
          >
            <span className="danger-hold-fill" style={{ width: `${progress * 100}%` }} />
            <span className="danger-hold-label">
              {busy ? <Spinner size={14} /> : <ShieldAlert size={14} />}
              {busy ? t("danger.executing") : holding ? t("danger.keepHolding") : confirmLabel}
            </span>
          </button>
        </>
      }
    >
      <div className="danger-confirm">
        <div className="danger-confirm-mark">
          <AlertOctagon size={22} />
          <div>
            <strong>{t("danger.clickTitle")}</strong>
            <span>{t("danger.clickDetail", { seconds: holdSeconds })}</span>
          </div>
        </div>
        <div className="danger-confirm-detail">{detail}</div>
        <div className="danger-confirm-meter" aria-hidden="true">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    </Modal>
  );
}
