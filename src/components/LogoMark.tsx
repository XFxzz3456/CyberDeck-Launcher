/**
 * Logo 图形徽章（2026-11-03 重设计，替代 r20 的纯文字「CD」）。
 *
 * 三条硬约束（来自任务书）：
 * 1. **纯 SVG**，不引任何外部图片 / 字体图标；
 * 2. 主色一律走 `currentColor`——颜色由 `.logo-mark` 的 `color` 提供
 *    （= 主题强调色），赛博主题下是赛博黄，现代主题下是纯黑 / 纯白；
 * 3. 不碰 `.logo-mark` 的 43×43 占位，也不碰右侧「CYBERDECK」文字排版。
 *
 * 三个方案并存，切换只改下面这一行 `LOGO_VARIANT`。三张图的 viewBox 统一
 * 为 `0 0 40 40`、主体落在 3~37 的安全区里，皮肤（hollow / solid）由 CSS
 * 的 `.logo-mark` 决定，与图形本身解耦。
 */

import type { ReactElement } from "react";

export type LogoVariant = "A" | "B" | "C";

/**
 * 当前启用方案：A = C/D 几何融合，B = 数据芯片，C = 六边形扫描徽章。
 * 2026-11-03 用户拍板定稿 **B**（数据芯片 + D 形内嵌插槽）——30px 真实尺寸下
 * 引脚与插槽都清晰，一眼是「芯片」不像光驱；A 的 D 横臂偏细、C 的三条扫描线
 * 易被读成菜单图标。A / C 保留在文件里，后续想换只改这一行即可。
 */
export const LOGO_VARIANT: LogoVariant = "B";

interface MarkProps {
  size?: number;
  className?: string;
}

/** 方案 A：字母 C 与 D 的几何融合。C 用切角方环，D 的竖脊被一道断线切开。 */
function MarkA({ size = 27, className }: MarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.4}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {/* C：切角方环，右侧开口 */}
      <path d="M23 8 H13 L8 13 V27 L13 32 H23" />
      {/* D：上、下两段横臂各接一条斜边，中间留出故障断口 */}
      <path d="M28 8 H30.5 L36 13.5" />
      <path d="M36 26.5 L30.5 32 H28" />
      {/* D 的竖脊刻意不连续——断线故障，也是「数据流被打断」的暗示 */}
      <path d="M28 8 V17.5" />
      <path d="M28 22.5 V32" />
    </svg>
  );
}

/** 方案 B：数据芯片 / 控制台插槽。左右各三根引脚，中心是 D 形插槽。 */
function MarkB({ size = 27, className }: MarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {/* 芯片体：右上切角，与容器徽章的切角语言一致 */}
      <path d="M8 7.5 H26 L32.5 14 V32.5 H8 Z" />
      {/* 引脚：左右各三根，长度对齐芯片体的上下边距 */}
      <path d="M3 13 H8 M3 20 H8 M3 27 H8" strokeWidth={2.4} />
      <path d="M32.5 17 H37.5 M32.5 24 H37.5 M32.5 30 H37.5" strokeWidth={2.4} />
      {/* 插槽：D 形开口，指向右侧的「装入」方向 */}
      <path d="M13.5 14.5 H20.5 L25.5 20 L20.5 25.5 H13.5 Z" strokeWidth={2.6} />
    </svg>
  );
}

/** 方案 C：六边形徽章，横向扫描线被中心节点截断。 */
function MarkC({ size = 27, className }: MarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 4.5 L33 11.75 V27.25 L20 35.5 L7 27.25 V11.75 Z" />
      {/* 扫描线：上下两条通长，中间一条被节点断开 */}
      <path
        d="M12.5 14.5 H27.5 M12.5 20 H17.4 M22.6 20 H27.5 M12.5 25.5 H27.5"
        strokeWidth={2.3}
        opacity={0.85}
      />
      {/* 电路节点 */}
      <circle cx="20" cy="20" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

const MARKS: Record<LogoVariant, (props: MarkProps) => ReactElement> = {
  A: MarkA,
  B: MarkB,
  C: MarkC,
};

export function LogoMark({
  variant = LOGO_VARIANT,
  size = 27,
  className,
}: MarkProps & { variant?: LogoVariant }) {
  const Mark = MARKS[variant];
  return <Mark size={size} className={className} />;
}
