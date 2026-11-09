import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * 浮层栈（UI/UX 一期：反馈体系 + 浮层治理）。
 *
 * 与 lib/escLayer.ts 的分工：escLayer 是「单个弹窗自己用」的轻量 Esc 仲裁；
 * 这里是「全局」的一层：把当前所有顶层浮层登记进一个栈，供全局快捷键判断
 * 「现在有没有浮层开着」（hasOverlay）以及「关掉最上面那层」（closeTop）。
 * 思路沿用 escLayer（后打开在上、Esc 只交栈顶）与 focusTrap（焦点进出），
 * 但不修改这两个文件的导出，老组件照常使用。
 *
 * 约定：希望被本体系主动捕获焦点的浮层，根元素请带 `data-overlay-layer="<id>"`
 * 与 `tabIndex={-1}`（id 与 useOverlayLayer 的第一个参数一致）。没带也不影响
 * 栈 / Esc / hasOverlay，只是不会把焦点自动移入浮层；Tab 循环仍由浮层自身
 * （例如 Modal 内的 useFocusTrap）负责，避免两套 trap 绑在同一元素上互相打架。
 */

interface Layer {
  id: string;
  close: () => void;
}

type StackRef = { current: Layer[] };

interface OverlayContextValue {
  stackRef: StackRef;
  setActiveId: (id: string | null) => void;
  activeId: string | null;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function findLayerRoot(id: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>("[data-overlay-layer]")).find(
      (node) => node.getAttribute("data-overlay-layer") === id,
    ) ?? null
  );
}

/** 全局浮层上下文。放在应用最外层，包住所有浮层与全局快捷键的宿主。 */
export function OverlayProvider(props: { children: ReactNode }): ReactElement {
  const stackRef = useRef<Layer[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // stackRef / setActiveId 引用稳定：放进 value 也不会让 useOverlayLayer 的
  // effect 因 activeId 变化而重跑。activeId 换新对象只让 useOverlay() 消费者重渲染。
  const value = useMemo<OverlayContextValue>(
    () => ({ stackRef, setActiveId, activeId }),
    [activeId],
  );

  return <OverlayContext.Provider value={value}>{props.children}</OverlayContext.Provider>;
}

/**
 * 登记一个顶层浮层。active 为 true 时压栈，变 false / 卸载时出栈。
 * - Esc：只关栈顶那一层，并 stopPropagation（同一监听链上不会一次 Esc 连关两层）；
 * - 焦点：记录触发元素，active 时把焦点移入浮层，卸载时归还给触发元素。
 */
export function useOverlayLayer(id: string, active: boolean, onClose: () => void): void {
  const ctx = useContext(OverlayContext);
  const stackRef = ctx?.stackRef;
  const setActiveId = ctx?.setActiveId;
  // 父组件常传箭头函数，onClose 每次渲染都换引用；用 ref 固定，避免注册被反复重建。
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active || !stackRef || !setActiveId) return;
    const stack = stackRef.current;
    const layer: Layer = { id, close: () => closeRef.current() };
    stack.push(layer);
    setActiveId(id);

    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = findLayerRoot(id);
    if (root && !root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 只有栈顶响应：抽屉里再开对话框时，一次 Esc 只关最上面那层。
      if (stack[stack.length - 1] !== layer) return;
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const index = stack.lastIndexOf(layer);
      if (index >= 0) stack.splice(index, 1);
      setActiveId(stack.length > 0 ? stack[stack.length - 1].id : null);
      // 归还焦点：触发按钮可能已被卸载（点列表项顺手删掉了它），用 isConnected 兜底。
      if (trigger?.isConnected) trigger.focus();
    };
  }, [active, id, stackRef, setActiveId]);
}

/** 全局快捷键用：判断有没有浮层、关掉最上面那层、读当前栈顶 id。 */
export function useOverlay(): {
  hasOverlay: () => boolean;
  closeTop: () => void;
  activeId: string | null;
} {
  const ctx = useContext(OverlayContext);
  const stackRef = ctx?.stackRef;
  const activeId = ctx?.activeId ?? null;

  const hasOverlay = useCallback(() => (stackRef?.current.length ?? 0) > 0, [stackRef]);
  const closeTop = useCallback(() => {
    const stack = stackRef?.current;
    if (!stack || stack.length === 0) return;
    stack[stack.length - 1].close();
  }, [stackRef]);

  return useMemo(
    () => ({ hasOverlay, closeTop, activeId }),
    [hasOverlay, closeTop, activeId],
  );
}
