import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  Car,
  Cpu,
  Crosshair,
  Eye,
  Gamepad2,
  ScrollText,
  Shirt,
  Volume2,
  Wrench,
} from "lucide-react";
import { t } from "../i18n";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function categoryIcon(category: string): LucideIcon {
  // category 的取值是持久化数据（B 类），不可翻译；显示映射见 categoryLabel()。
  switch (category) {
    case "框架": // i18n-ignore
      return Cpu;
    case "玩法": // i18n-ignore
      return Gamepad2;
    case "武器": // i18n-ignore
      return Crosshair;
    case "服装": // i18n-ignore
      return Shirt;
    case "车辆": // i18n-ignore
      return Car;
    case "视觉": // i18n-ignore
      return Eye;
    case "音频": // i18n-ignore
      return Volume2;
    case "任务": // i18n-ignore
      return ScrollText;
    case "工具": // i18n-ignore
      return Wrench;
    default:
      return Boxes;
  }
}

export function compactPath(path: string | null | undefined, max = 46): string {
  if (!path) return "—";
  if (path.length <= max) return path;
  const parts = path.split("\\");
  if (parts.length <= 2) return `…${path.slice(-(max - 1))}`;
  return `${parts[0]}\\…\\${parts.slice(-2).join("\\")}`;
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return t("time.never");
  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return "—";
  const diff = Date.now() - date;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { count: days });
  return formatDate(value);
}

export function hashCode(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}
