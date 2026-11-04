import { useEffect, useRef } from "react";

/**
 * 弹层 Esc 仲裁（P3 #3）。
 *
 * 以前每个浮层各自 `window.addEventListener("keydown")`：抽屉里再开一个编辑
 * 对话框时，按一次 Esc 两层的回调都会跑，整叠一起消失——用户本来只想关最上
 * 面那层。
 *
 * 这里维护一个「后打开的在上面」的栈，Esc 只交给栈顶那层，其余忽略。用栈而
 * 不是给每层打标记，是因为栈能自然反映打开顺序（父层先注册、子层后注册），
 * 不需要任何组件知道自己的层级。
 *
 * 注意：不拦 stopPropagation —— 输入框自己绑的 Esc（比如「取消重命名」）仍
 * 按原样工作，这里只决定哪些浮层该关。
 */

const stack: Array<symbol> = [];

export function useEscLayer(active: boolean, onClose: () => void) {
  // 回调每次渲染都可能换引用（父组件箭头函数），但注册必须稳定在 active 变化
  // 时才动——否则父层重渲染会把自己挪到栈顶，把真正的子层盖下去。
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const token = Symbol("esc-layer");
    stack.push(token);
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (stack[stack.length - 1] !== token) return;
      closeRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      const index = stack.lastIndexOf(token);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
}
