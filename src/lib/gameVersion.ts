/**
 * 游戏内部 exe 版本 → 社区通行叫法。
 *
 * 为什么需要这层映射：`Cyberpunk2077.exe` 的文件版本是 CDPR 内部的四段号
 * （实测 `3.0.88.46235`），而玩家、Mod 作者、Nexus 页面上说的都是「2.5」
 * 「2.4」这类市场版本号。界面直接显示四段号等于给用户一串看不懂的数字；
 * 只截前三段又得到 `3.0`，比原文更误导（看着像「3.0 版本的游戏」）。
 *
 * 维护方式：**这是数据不是逻辑**。新版本发布时按实测四段号往 `INTERNAL_FLOORS`
 * 补一行即可（从高到低，取第一个 `patch >= floor` 的桶）。阈值口径必须与
 * Rust 端 `src-tauri/src/gamever.rs` 的 `INTERNAL_FLOORS` 保持一致——两边
 * 查表结果不一致会让「侧栏说 2.5、诊断说别的」这种鬼故事重演。
 */
import { t } from "../i18n";

export interface GameVersionLabel {
  /** 界面上显示的社区叫法，例如 `2.5` / `旧版 (2.0 及以下)`。 */
  label: string;
  /** 是否命中映射表（false = 认不出来，label 是兜底值）。 */
  mapped: boolean;
  /** 悬停提示里展示的原始内部版本。 */
  raw: string;
  /** 是否是 CDPR 内部四段号（true 表示 label 来自映射表而非原样透传）。 */
  internal: boolean;
}

/** 完全认不出来时的标签（文案在词表 gameVersion.unknown）。 */
export const unknownVersionLabel = (): string => t("gameVersion.unknown");
/** 比所有桶都老时的标签（文案在词表 gameVersion.legacy）。 */
export const legacyVersionLabel = (): string => t("gameVersion.legacy");

const INTERNAL_FLOORS: Array<{ patch: number; label: string }> = [
  { patch: 80, label: "2.5" },
  { patch: 70, label: "2.4" },
  { patch: 60, label: "2.3" },
  { patch: 50, label: "2.2" },
  { patch: 40, label: "2.1" },
  { patch: 30, label: "2.0" },
];

/** `3.0.88.46235` → `[3, 0, 88, 46235]`；非数字段一律当 0。 */
function segments(raw: string): number[] {
  return raw
    .trim()
    .replace(/^[vV]/, "")
    .split(/[.\-_\s()]+/)
    .filter(Boolean)
    .map((part) => {
      const digits = /^\d+/.exec(part);
      return digits ? Number.parseInt(digits[0], 10) : 0;
    });
}

/** 解析成社区版本标签；空串返回 null，调用方回退显示「未知」。 */
export function gameVersionLabel(raw: string | null | undefined): GameVersionLabel | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const parts = segments(value);
  if (parts.length === 0) return null;

  // 1) CDPR 内部号：3.0.x.y —— 按第三段查表。
  if (parts[0] === 3 && (parts[1] ?? 0) === 0) {
    const patch = parts[2] ?? 0;
    const hit = INTERNAL_FLOORS.find((entry) => patch >= entry.patch);
    return {
      label: hit ? hit.label : legacyVersionLabel(),
      mapped: true,
      raw: value,
      internal: true,
    };
  }

  // 2) 市场号（2.21 / 2.5）原样透传前两段。
  if (parts[0] === 2) {
    return {
      label: parts.length > 1 ? `${parts[0]}.${parts[1]}` : String(parts[0]),
      mapped: true,
      raw: value,
      internal: false,
    };
  }

  // 3) 认不出来（未来的 4.x 内部号等）：明确说未知，不猜。
  return { label: unknownVersionLabel(), mapped: false, raw: value, internal: false };
}

/** 一行文案里的版本部分：`2.5`。 */
export function gameVersionText(raw: string | null | undefined): string | null {
  return gameVersionLabel(raw)?.label ?? null;
}

/** 带「版本」后缀的完整说法：`2.5 版本` / `未知版本`。 */
export function gameVersionWithSuffix(raw: string | null | undefined): string | null {
  const parsed = gameVersionLabel(raw);
  if (!parsed) return unknownVersionLabel();
  // 「旧版 (2.0 及以下)」「未知版本」本身就是完整说法，不再叠后缀。
  return parsed.internal && parsed.mapped
    ? t("gameVersion.suffix", { version: parsed.label })
    : parsed.label;
}

/**
 * 社区版本号是否达到某个门槛。
 *
 * 必须按数值比较：`2.21` 是 2.2 的第 21 个补丁，比 `2.5` 旧；如果按
 * 「主.次」两段解析成 (2, 21) vs (2, 5)，会得出 2.21 更新的错误结论。
 * 读不到版本号（或已判为未知）时返回 null——调用方据此走中性文案，而不是猜。
 */
export function versionAtLeast(
  raw: string | null | undefined,
  floor: string,
): boolean | null {
  const current = gameVersionLabel(raw);
  if (!current || !current.mapped) return null;
  const currentValue = Number.parseFloat(current.label);
  const floorValue = Number.parseFloat(floor);
  if (!Number.isFinite(currentValue) || !Number.isFinite(floorValue)) return null;
  return currentValue >= floorValue;
}
