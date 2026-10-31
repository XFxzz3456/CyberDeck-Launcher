/**
 * 游戏内部 exe 版本 → 社区通行叫法。
 *
 * 为什么需要这层映射：`Cyberpunk2077.exe` 的文件版本是 CDPR 内部的四段号
 * （如 `3.0.80.51928`），而玩家、Mod 作者、Nexus 页面上说的都是「2.5」
 * 「2.3」这类市场版本号。界面直接显示四段号等于给用户一串看不懂的数字，
 * 排查兼容性问题时也没法跟作者沟通。
 *
 * 维护方式：这张表是**数据不是逻辑**，新版本发布时按 CDPR 公告补一行即可。
 * 匹配按前缀、从长到短，所以 `3.0.80` 会先于 `3.0` 命中。
 * 表里没有的版本原样显示解析出的主.次号，并在 tooltip 里保留内部号——
 * 宁可显示一个不完美但真实的版本号，也不要猜错。
 */
export interface GameVersionLabel {
  /** 界面上显示的社区叫法，例如 `2.5`。 */
  label: string;
  /** 是否命中映射表（false = 表里没有，label 是兜底值）。 */
  mapped: boolean;
  /** 悬停提示里展示的原始内部版本。 */
  raw: string;
}

const VERSION_MAP: Array<{ prefix: string; label: string }> = [
  // 2026-10-30 实测截图：exe 文件版本 3.0.80.51928 对应社区叫法 2.5。
  { prefix: "3.0.80", label: "2.5" },
  { prefix: "3.0.7", label: "2.4" },
  { prefix: "3.0.6", label: "2.3" },
  { prefix: "3.0.5", label: "2.2" },
  { prefix: "3.0.4", label: "2.1" },
  { prefix: "3.0.3", label: "2.0" },
  // 1.x / 2.x 时代部分安装包直接写市场号，保持原样即可。
  { prefix: "2.3", label: "2.3" },
  { prefix: "2.2", label: "2.2" },
  { prefix: "2.1", label: "2.1" },
  { prefix: "2.0", label: "2.0" },
];

/** 解析成 社区版本标签；无法解析时返回 null，调用方回退显示「未知」。 */
export function gameVersionLabel(raw: string | null | undefined): GameVersionLabel | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  for (const entry of VERSION_MAP) {
    if (value.startsWith(entry.prefix)) {
      return { label: entry.label, mapped: true, raw: value };
    }
  }
  // 兜底：只取前两段，至少让玩家看到一个像版本号的东西。
  const parts = value.replace(/^v/i, "").split(/[.\-]/).filter(Boolean);
  const label = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0] ?? value;
  return { label, mapped: false, raw: value };
}

/** 一行文案：`游戏版本 2.5`。 */
export function gameVersionText(raw: string | null | undefined): string | null {
  const parsed = gameVersionLabel(raw);
  return parsed ? parsed.label : null;
}
