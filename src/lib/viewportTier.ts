import { useEffect } from "react";

/**
 * 侧栏纵向档位（viewport tier）。
 *
 * 为什么不用 `@media (max-height: ...)`：缩放是靠 `body { zoom: var(--ui-scale) }`
 * 实现的，而 **媒体查询量的是真实窗口高度，zoom 不会改变它**。1280×800 在 110%
 * 缩放下，内容按 1.1 倍占位，可用高度其实只剩 ≈727 CSS px，媒体查询却仍报 800，
 * 于是阈值永远差一档——表现就是「菜单明明放得下却冒出滚动条」或反过来「挤成一条缝」。
 *
 * 所以按 **有效高度 = innerHeight ÷ scale** 分档，把结果写在 :root 的
 * `data-vh-tier` 上，由 CSS 按档位决定压缩哪一段：
 *   full    > 780  什么都没减
 *   compact 641–780 紧凑间距；STAGING 只留标题行
 *   tight   561–640 隐去 STAGING / logo 副标题 / 游戏路径
 *   mini    ≤ 560   再隐去版本号行，只留可点的东西
 */
export type ViewportTier = "full" | "compact" | "tight" | "mini";

function tierOf(effectiveHeight: number): ViewportTier {
  if (effectiveHeight <= 560) return "mini";
  if (effectiveHeight <= 640) return "tight";
  if (effectiveHeight <= 780) return "compact";
  return "full";
}

export function useViewportTier(scale: number): void {
  useEffect(() => {
    const safeScale = scale > 0 ? scale : 1;
    const apply = () => {
      const tier = tierOf(window.innerHeight / safeScale);
      const root = document.documentElement;
      if (root.dataset.vhTier === tier) return;
      root.dataset.vhTier = tier;
      // 档位是累积的：mini 同时具备 tight 与 compact 的全部让位。
      // 用布尔属性而不是让 CSS 写三组 :is() 选择器，读起来更直白。
      const flags = {
        vhCompact: tier !== "full",
        vhTight: tier === "tight" || tier === "mini",
        vhMini: tier === "mini",
      };
      for (const [key, on] of Object.entries(flags)) {
        if (on) root.dataset[key] = "";
        else delete root.dataset[key];
      }
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [scale]);
}
