import { useEffect, useRef, useState } from "react";
import { LogoMark } from "./LogoMark";
import "./SplashScreen.css";

/**
 * 首帧 splash（看板【9】）。
 *
 * 三条硬约束：
 * 1. 总时长 ≤800ms——Tauri/WebView2 冷启动本来就有延迟，动画再长就变成"启动更慢"。
 * 2. 任意点击/按键立即跳过，不等计时器。
 * 3. 只做视觉层，不参与初始化：到点就卸载，绝不阻塞真实加载。
 */
export function SplashScreen({
  enabled,
  onDone,
}: {
  enabled: boolean;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const finished = useRef(false);

  useEffect(() => {
    if (!enabled) {
      onDone();
      return;
    }
    const skip = () => {
      if (finished.current) return;
      finished.current = true;
      setLeaving(true);
      // 200ms 淡出后再卸载，与 .splash.is-leaving 的过渡时长一致。
      window.setTimeout(onDone, 200);
    };
    const timer = window.setTimeout(skip, 620);
    window.addEventListener("pointerdown", skip, { once: true });
    window.addEventListener("keydown", skip, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, [enabled, onDone]);

  if (!enabled) return null;

  return (
    <div className={`splash${leaving ? " is-leaving" : ""}`} role="presentation">
      <div className="splash-mark">
        {/* 2026-11-03：字面「CD」换成图形徽章。这里底板是实心 accent 色块，
            所以图形走 .splash-mark 的 color（= --accent-ink）反色显示。 */}
        <LogoMark size={44} />
        <span className="splash-scan" />
      </div>
      <div className="splash-text">LOADING // CYBERDECK</div>
    </div>
  );
}
