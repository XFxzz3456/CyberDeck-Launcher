import { convertFileSrc } from "@tauri-apps/api/core";
import { hashCode } from "../lib/format";
import { isTauri } from "../lib/api";

const GLYPHS = ["NC", "V", "AR", "//", "NC", "2077", "VX", "///"];

interface CoverArtProps {
  id: string;
  name: string;
  category: string;
  coverPath?: string | null;
  className?: string;
}

function assetUrl(path: string): string {
  if (!path) return "";
  if (/^https?:/i.test(path) || path.startsWith("data:") || path.startsWith("blob:")) {
    return path;
  }
  return isTauri ? convertFileSrc(path) : path;
}

/**
 * Generated cover art for mods without a screenshot.
 *
 * The palette resolves from the active theme (--cover-a/--cover-b/--cover-c)
 * instead of a hardcoded neon list, so the cover grid follows a theme switch the
 * same way controls do. The seed still drives composition, so cards stay varied.
 */
export function CoverArt({ id, name, category, coverPath, className }: CoverArtProps) {
  if (coverPath) {
    return (
      <div className={`cover-art ${className ?? ""}`}>
        <img src={assetUrl(coverPath)} alt="" draggable={false} />
        <div className="cover-shade" />
      </div>
    );
  }

  const seed = hashCode(`${id}:${name}:${category}`);
  const glyph = GLYPHS[(seed >> 3) % GLYPHS.length];
  const variant = seed % 4;
  const angle = (seed % 55) - 20;

  const a = "var(--cover-a)";
  const b = "var(--cover-b)";
  const c = "var(--cover-c)";

  return (
    <div className={`cover-art ${className ?? ""}`} aria-hidden="true">
      <svg viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id={`bg-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--bg-2)" />
            <stop offset="100%" stopColor="var(--panel)" />
          </linearGradient>
          <linearGradient id={`neon-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={a} stopOpacity="0.95" />
            <stop offset="100%" stopColor={b} stopOpacity="0.55" />
          </linearGradient>
          <pattern id={`grid-${id}`} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#ffffff" strokeOpacity="0.05" strokeWidth="1" />
          </pattern>
          <filter id={`glow-${id}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>
        <rect width="400" height="225" fill={`url(#bg-${id})`} />
        <rect width="400" height="225" fill={`url(#grid-${id})`} />
        <g opacity="0.16" filter={`url(#glow-${id})`}>
          <circle cx={70 + (seed % 260)} cy={40 + (seed % 90)} r="72" fill={b} />
          <circle cx={300 - (seed % 140)} cy={180 - (seed % 70)} r="58" fill={c} />
        </g>
        {variant === 0 && (
          <>
            <path
              d={`M -20 ${160 + (seed % 20)} L 420 ${80 - (seed % 30)}`}
              stroke={`url(#neon-${id})`}
              strokeWidth="2"
              opacity="0.7"
            />
            <path
              d={`M -20 ${185 + (seed % 15)} L 420 ${105 - (seed % 20)}`}
              stroke={c}
              strokeWidth="1"
              opacity="0.35"
            />
            <circle cx="300" cy="72" r="38" fill="none" stroke={a} strokeWidth="2" opacity="0.75" />
            <circle cx="300" cy="72" r="47" fill="none" stroke={a} strokeWidth="0.8" opacity="0.35" />
            <path d="M300 18 L300 126 M246 72 L354 72" stroke={a} strokeWidth="0.7" opacity="0.5" />
          </>
        )}
        {variant === 1 && (
          <>
            <g transform={`rotate(${angle} 200 112)`}>
              {[0, 1, 2, 3, 4].map((bar) => (
                <rect
                  key={bar}
                  x={80 + bar * 46}
                  y={-40 + (bar % 2) * 22}
                  width="14"
                  height="340"
                  fill={bar % 2 === 0 ? a : b}
                  opacity={0.1 + bar * 0.1}
                />
              ))}
            </g>
            <path d="M0 185 L70 160 L115 172 L180 128 L238 150 L310 105 L400 132 L400 225 L0 225 Z" fill="var(--bg)" opacity="0.88" />
            <path d="M0 185 L70 160 L115 172 L180 128 L238 150 L310 105 L400 132" fill="none" stroke={b} strokeWidth="1.1" opacity="0.65" />
          </>
        )}
        {variant === 2 && (
          <>
            <g stroke={b} strokeWidth="1" opacity="0.38">
              {Array.from({ length: 9 }).map((_, index) => (
                <path key={index} d={`M ${24 + index * 44} 0 L ${24 + index * 44} 225`} />
              ))}
              {Array.from({ length: 5 }).map((_, index) => (
                <path key={index} d={`M 0 ${30 + index * 42} L 400 ${30 + index * 42}`} />
              ))}
            </g>
            <rect x="54" y="42" width="152" height="152" fill="none" stroke={a} strokeWidth="1.5" opacity="0.65" />
            <rect x="68" y="56" width="124" height="124" fill={c} opacity="0.12" />
            <path d="M230 166 L340 166 L340 56" fill="none" stroke={a} strokeWidth="2" />
            <circle cx="340" cy="56" r="5" fill={a} />
          </>
        )}
        {variant === 3 && (
          <>
            <circle cx="325" cy="48" r="90" fill="none" stroke={b} strokeWidth="1" opacity="0.28" />
            <circle cx="325" cy="48" r="112" fill="none" stroke={b} strokeWidth="0.7" opacity="0.18" />
            <path d="M0 168 Q 95 126 190 158 T 400 140 L400 225 L0 225 Z" fill={c} opacity="0.13" />
            <path d="M0 168 Q 95 126 190 158 T 400 140" fill="none" stroke={c} strokeWidth="1.2" opacity="0.55" />
            <path d="M54 52 L98 52 L112 66 L112 96 L54 96 Z" fill="none" stroke={a} strokeWidth="1.2" opacity="0.6" />
            <path d="M68 64 L98 64 M68 76 L98 76 M68 88 L86 88" stroke={a} strokeWidth="1" opacity="0.5" />
          </>
        )}
        <g transform="translate(26 172)">
          <text fill={a} fontFamily="Bahnschrift, Segoe UI, sans-serif" fontSize="34" fontWeight="700" letterSpacing="-1">
            {glyph}
          </text>
          <text x="2" y="18" fill="#ffffff" fillOpacity="0.38" fontFamily="Consolas, monospace" fontSize="7" letterSpacing="2">
            {category.toUpperCase()} / CYBERDECK
          </text>
        </g>
        <rect x="0" y="0" width="400" height="225" fill="none" stroke="#ffffff" strokeOpacity="0.06" />
      </svg>
      <div className="cover-shade" />
    </div>
  );
}
