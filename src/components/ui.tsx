import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, type Variants } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, LoaderCircle, Pin, X } from "lucide-react";
import { t } from "../i18n";
import { makeBackdropVariants, makeModalVariants, useMotionFactor, useMotionSprings } from "../lib/motion";
import { useMotionEnabled } from "../lib/preferences";

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? t("common.toggle")}
      className={`toggle ${checked ? "is-on" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      disabled={disabled}
    >
      <span className="toggle-track">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  /** 行尾附加动作（如「测试」按钮），渲染在开关左侧；不传则只有开关。 */
  action,
}: {
  title: string;
  /** 3E-1：可不传——删掉重复副标题后，单行标题的行不再需要描述。 */
  description?: string;
  checked: boolean;
  /** 强制开启的行（如冲突通知）不传 onChange，开关本身也 disabled。 */
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="switch-row">
      <div>
        <div className="switch-title">{title}</div>
        {description ? <div className="switch-desc">{description}</div> : null}
      </div>
      <div className="switch-row-end">
        {action}
        <Toggle checked={checked} onChange={onChange ?? (() => {})} disabled={disabled} label={title} />
      </div>
    </div>
  );
}

export function Badge({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "yellow" | "cyan" | "red" | "green";
  className?: string;
}) {
  return <span className={`badge badge-${tone} ${className ?? ""}`}>{children}</span>;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-label={t("common.loadingAria")} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/**
 * 弹窗的视觉外壳。单独拆出来只为了一件事：`useIsPresent()` 必须在
 * AnimatePresence 的直接子组件里调用，才能读到"正在退场"这个状态。
 * 退场那 130ms 里如果不屏蔽指针事件，整屏会变成一块透明挡板。
 */
function ModalShell({
  width,
  title,
  eyebrow,
  children,
  footer,
  onClose,
  modalVariants,
  backdropVariants,
}: {
  width: number;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  modalVariants: Variants;
  backdropVariants: Variants;
}) {
  const isPresent = useIsPresent();
  return (
    <div
      className="modal-portal"
      role="presentation"
      style={isPresent ? undefined : { pointerEvents: "none" }}
    >
      <motion.button
        className="modal-backdrop"
        aria-label={t("common.close")}
        onClick={onClose}
        variants={backdropVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      />
      <motion.section
        className="modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        variants={modalVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <header className="modal-head">
          <div>
            {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
            <h2>{title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <X size={17} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </motion.section>
    </div>
  );
}

export function Modal({
  open,
  title,
  eyebrow,
  children,
  footer,
  onClose,
  width = 560,
}: {
  open: boolean;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const motionEnabled = useMotionEnabled();
  const springs = useMotionSprings();
  const motionFactor = useMotionFactor();
  const modalVariants = useMemo(
    () => makeModalVariants(springs.overlay, motionEnabled, motionFactor || 1),
    [springs, motionEnabled, motionFactor],
  );
  const backdropVariants = useMemo(
    () => makeBackdropVariants(motionEnabled, motionFactor || 1),
    [motionEnabled, motionFactor],
  );

  // 注意：不能在这里 `if (!open) return null`——AnimatePresence 需要子树
  // 在 open 变 false 之后仍然存在一帧，才能播完退出动画。
  return (
    <AnimatePresence>
      {open ? (
        <ModalShell
          width={width}
          title={title}
          eyebrow={eyebrow}
          footer={footer}
          onClose={onClose}
          modalVariants={modalVariants}
          backdropVariants={backdropVariants}
        >
          {children}
        </ModalShell>
      ) : null}
    </AnimatePresence>
  );
}

export function ConfirmDialog({
  open,
  title,
  detail,
  confirmLabel = t("common.confirm"),
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  detail: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      eyebrow={t("common.confirmEyebrow")}
      onClose={onClose}
      width={470}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-detail">{detail}</div>
    </Modal>
  );
}

export interface ToastItem {
  id: number;
  tone: "ok" | "error" | "info" | "warn";
  title: string;
  message?: string;
  /** 常驻：需要用户处理（冲突、权限不足、跨盘失败、缺前置），不自动消失，只能手动关。 */
  sticky?: boolean;
  /** 自动消失的毫秒数；sticky / Infinity 时不走倒计时。由 App 的 toast() 算好带进来。 */
  ttl?: number;
  /**
   * 同类合并的「代数」：相同 tone+title 的通知再次触发时不新开一条，
   * 而是更新旧条目并把这个值 +1——Toast 的倒计时 effect 依赖它重置计时器。
   */
  nonce?: number;
  /** 同类合并计数：>1 时标题后追加「（已发生 N 次）」。 */
  count?: number;
}

/** 单条 Toast：倒计时放在组件里做，悬停暂停、移出续跑（2026-11-01 通知重构）。 */
function ToastEntry({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const icons = {
    ok: <CheckCircle2 size={17} />,
    error: <AlertTriangle size={17} />,
    info: <Info size={17} />,
    warn: <AlertTriangle size={17} />,
  };
  const auto = !toast.sticky && toast.ttl !== undefined && Number.isFinite(toast.ttl);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.ttl ?? 0);
  const startRef = useRef(0);

  useEffect(() => {
    if (!auto) return;
    // nonce 变了 = 同类通知又触发了一次，剩余时间重置为完整 ttl。
    remainingRef.current = toast.ttl ?? 0;
  }, [auto, toast.nonce, toast.ttl]);

  useEffect(() => {
    if (!auto || paused) return;
    startRef.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remainingRef.current);
    return () => {
      // 悬停暂停 / 卸载时把没走完的时间记回来，移出鼠标后从断点续跑。
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startRef.current));
      window.clearTimeout(timer);
    };
  }, [auto, paused, toast.nonce, toast.id, onDismiss]);

  const suffix = (toast.count ?? 1) > 1 ? t("common.toastRepeatSuffix", { count: toast.count ?? 1 }) : "";

  return (
    <div
      className={`toast toast-${toast.tone}${toast.sticky ? " toast-sticky" : ""}`}
      data-sticky={toast.sticky ? "1" : "0"}
      onMouseEnter={() => auto && setPaused(true)}
      onMouseLeave={() => auto && setPaused(false)}
    >
      <span className="toast-icon">{icons[toast.tone]}</span>
      <div className="toast-copy">
        <div className="toast-title">
          {toast.title}
          {suffix}
        </div>
        {toast.message ? <div className="toast-message">{toast.message}</div> : null}
      </div>
      {toast.sticky ? (
        <span className="toast-pin" title={t("common.stickyToast")} aria-label={t("common.stickyToast")}>
          <Pin size={13} />
        </span>
      ) : null}
      <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label={t("common.dismissToast")}>
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <ToastEntry key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  detail,
  action,
  code,
  kicker,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
  code?: string;
  kicker?: string;
}) {
  return (
    <div className="empty-state">
      {code ? (
        <div className="empty-code" aria-hidden="true">
          <pre>{code}</pre>
          <span className="empty-scanline" />
        </div>
      ) : (
        <div className="empty-icon">{icon}</div>
      )}
      {kicker ? <div className="empty-kicker">{kicker}</div> : null}
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}
