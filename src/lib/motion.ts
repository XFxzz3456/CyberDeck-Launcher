/**
 * 全局动效参数中心（framer-motion）。
 *
 * 三条原则，写组件前先读：
 * 1. 只动画 transform / opacity——width、height、top、left 都会触发重排，
 *    在模组库这种几百张卡片的地方是灾难；
 * 2. 过渡参数一律从这里拿，不允许组件里随手写 duration——手感要全局一致；
 * 3. 动效必须可关：用户在「个性化 → 界面动效」关掉，或系统声明了
 *    prefers-reduced-motion 时，一切动画退化为瞬移（MotionConfig reducedMotion）。
 *
 * 覆盖范围：
 * - r15 试点：设置页 Tabs 下划线（layoutId）+ ModCard 悬停/点击；
 * - r19 推广：抽屉滑入、弹窗弹入、路由切换（AnimatePresence）。
 */
import type { Transition, Variants } from "framer-motion";
import { useTheme } from "./theme";

/**
 * 弹簧族。统一「快而不躁」：stiffness 高、damping 足，不过冲——
 * 过冲在工具类 UI 里显得轻浮，赛博朋克的主题氛围靠的是利落，不是 Q 弹。
 */
export const springSnappy: Transition = {
  type: "spring",
  stiffness: 480,
  damping: 38,
  mass: 0.9,
};

/** 抽屉 / 弹层：比 snappy 柔一点，允许极轻微的跟随感。 */
export const springOverlay: Transition = {
  type: "spring",
  stiffness: 360,
  damping: 34,
  mass: 0.95,
};

/** 悬停抬升与按压缩放的过渡。 */
export const springHover: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 30,
  mass: 0.6,
};

/* ── 主题差异化：机械感 vs 柔和 ──────────────────────────────────────── */

/**
 * 「干净」的两套风格用柔和族；赛博家族（ncpd / netrunner / arasaka /
 * militech / cyberpunk）用机械族——stiffness 400 + damping 20，阻尼比约 0.53，
 * 收尾有极轻微过冲（3px 抬升上不到 0.5px），读起来是「咔哒一下到位」，
 * 而不是橡皮筋。modern / mono 保持柔和，它们的排版语言本来就没有机械感。
 */
const MECHANICAL_STYLES = new Set(["cyberpunk", "ncpd", "netrunner", "arasaka", "militech"]);

const mechanicalSpring: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 20,
  mass: 0.9,
};

export interface SpringFamily {
  snappy: Transition;
  overlay: Transition;
  hover: Transition;
}

const SOFT_FAMILY: SpringFamily = {
  snappy: springSnappy,
  overlay: springOverlay,
  hover: springHover,
};

const MECHANICAL_FAMILY: SpringFamily = {
  snappy: mechanicalSpring,
  overlay: mechanicalSpring,
  hover: mechanicalSpring,
};

/** 按当前视觉风格取弹簧参数。组件里一律用它，别直接 import 常量。 */
export function useMotionSprings(): SpringFamily {
  const { styleTheme } = useTheme();
  return MECHANICAL_STYLES.has(styleTheme) ? MECHANICAL_FAMILY : SOFT_FAMILY;
}

/** ModCard 悬停：上浮 3px。CSS 侧在 data-motion="on" 时退位，避免两套 transform 打架。 */
export const modCardHover = { y: -3 } as const;

/** ModCard 按下：轻微收缩，给「点到了」的物理反馈。 */
export const modCardTap = { scale: 0.984 } as const;

/**
 * 下划线 / 指示器的共享布局动画。
 *
 * 用法：给每个候选元素外层套 `<motion.xxx layoutId="...">`，framer 会在它们之间
 * 自动补间位置——Tabs 下划线、分段控件的选中框都是这个模式。
 */
export const indicatorLayoutId = {
  settingsTab: "settings-tab-underline",
} as const;

/* ── 三套场景变体（工厂函数：参数来自主题弹簧族） ─────────────────────── */

/**
 * `animated=false`（用户在「界面动效」里关掉）时返回的"瞬移"三态。
 * 为什么不靠 `MotionConfig reducedMotion` 兜底：它只跳过 transform，
 * opacity 仍会走默认时长，用户会看到「明明关了动效，弹窗还在淡出」。
 */
const instantTriplet = (): Variants => ({
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0 } },
  exit: { opacity: 0, transition: { duration: 0 } },
});

/**
 * 抽屉：从右侧整幅滑入（`x: 100%` → 0），退场比入场快一档。
 *
 * 入场走弹簧（有质量感），退场走贝塞尔——退场时用户已经"决定关掉"了，
 * 任何回弹都只是拖延。
 */
export function makeDrawerVariants(spring: Transition, animated = true): Variants {
  if (!animated) return instantTriplet();
  return {
    hidden: { x: "100%", opacity: 0.65 },
    visible: { x: 0, opacity: 1, transition: spring },
    exit: { x: "100%", opacity: 0.4, transition: { duration: 0.19, ease: [0.4, 0, 1, 1] } },
  };
}

/**
 * 遮罩：只动 opacity。
 * opacity 归零时 backdrop-filter 的模糊也一并消失，所以不必动画 backdrop-filter
 * （那是整屏重绘，弱机上必掉帧）——淡入淡出本身就把毛玻璃一起带进来了。
 */
export function makeBackdropVariants(animated = true): Variants {
  if (!animated) return instantTriplet();
  return {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.18, ease: "easeOut" } },
    exit: { opacity: 0, transition: { duration: 0.15, ease: "easeIn" } },
  };
}

/**
 * 弹窗：轻微放大 + 淡入。
 *
 * 起始值取 0.94 而非 0.9——560px 宽的弹窗从 0.9 起跳要瞬间缩掉 56px，
 * 位移感过强、像"从远处飞来"；0.94 是"落定"的手感。
 * 终点必须是精确的 `scale: 1`：停在 0.99x 上文字会一直发虚。
 */
export function makeModalVariants(spring: Transition, animated = true): Variants {
  if (!animated) return instantTriplet();
  return {
    hidden: { opacity: 0, scale: 0.94 },
    visible: { opacity: 1, scale: 1, transition: spring },
    exit: { opacity: 0, scale: 0.97, transition: { duration: 0.13, ease: [0.4, 0, 1, 1] } },
  };
}

/**
 * 路由切换：旧页淡出偏左，新页从右侧 10px 轻滑入。
 *
 * 方向语义：往右走 = 前进，往左退 = 退回，和浏览器的心理模型一致。
 * 位移只有 10px——整屏横向滑动在桌面端会让人晕。
 */
export function makeRouteVariants(animated = true): Variants {
  if (!animated) return instantTriplet();
  return {
    hidden: { opacity: 0, x: 10 },
    visible: {
      opacity: 1,
      x: 0,
      transition: { duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94], opacity: { duration: 0.16 } },
    },
    exit: { opacity: 0, x: -6, transition: { duration: 0.1, ease: "easeIn" } },
  };
}
