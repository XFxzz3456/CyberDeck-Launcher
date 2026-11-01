/**
 * 通知分类偏好（r12）。
 *
 * 四个用户可感知的通知类别 + 一个内部类别 system：
 * - system：用户操作触发的即时反馈（保存成功、报错原因等），不受开关控制，
 *   也不出现在设置页——它不是"通知"，是对刚才那次点击的回应。
 * - download / deploy / conflict / update：可以在设置里关掉的打扰型通知。
 *   conflict 按需求强制开启（误部署的代价远大于被打扰）。
 *
 * 门只拦 Toast。活动记录（铃铛面板）保留完整历史：打开面板即清零角标，
 * 不构成打扰；在这里静默会丢操作痕迹，得不偿失。
 */

export type NotificationCategory = "download" | "deploy" | "conflict" | "update";

/** toast() 的 category 参数取值：四个可关类别 + 始终放行的 system。 */
export type ToastCategory = NotificationCategory | "system";

export interface NotificationPrefs {
  download: boolean;
  deploy: boolean;
  conflict: boolean;
  update: boolean;
}

export const NOTIFICATION_PREFS_KEY = "ncl.ui.notifications.v1";

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  download: true,
  deploy: true,
  conflict: true,
  update: true,
};

/** 用户可见的类别顺序（设置页行序）。 */
export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  "download",
  "deploy",
  "conflict",
  "update",
];

export function loadNotificationPrefs(): NotificationPrefs {
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_PREFS_KEY);
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
    const value = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      download: value.download !== false,
      deploy: value.deploy !== false,
      // conflict 强制开启：就算存了 false 也拉回来。
      conflict: true,
      update: value.update !== false,
    };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    window.localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存不进去就退回默认，不阻塞界面。
  }
}

/** 通知门：system 永远放行，其余查偏好表。 */
export function canNotify(category: ToastCategory, prefs: NotificationPrefs): boolean {
  if (category === "system") return true;
  if (category === "conflict") return true; // 强制开启，双保险
  return prefs[category];
}

/* ── 2D 通知停留时长 ────────────────────────────────────────────
 * 存「秒」而不是毫秒：设置页的分段按钮与自定义输入都以秒为单位，
 * 存秒可以让 localStorage 里的值直接对人可读（5 = 5 秒）。
 * "never" 表示不自动隐藏，只能手动关。 */

export type NotificationDuration = number | "never";

export const NOTIFICATION_DURATION_KEY = "ncl.ui.notificationDuration.v1";
export const NOTIFICATION_DURATION_MIN = 1;
export const NOTIFICATION_DURATION_MAX = 60;
export const DEFAULT_NOTIFICATION_DURATION: NotificationDuration = 5;

/** 分段按钮的固定档位；自定义档不在其中。 */
export const NOTIFICATION_DURATION_PRESETS = [3, 5, 10] as const;

/** 越界自动修正到合法区间；非有限数按最小值处理。 */
export function clampNotificationSeconds(value: number): number {
  if (!Number.isFinite(value)) return NOTIFICATION_DURATION_MIN;
  return Math.min(NOTIFICATION_DURATION_MAX, Math.max(NOTIFICATION_DURATION_MIN, Math.round(value)));
}

/** 任何来路不明的值（旧数据 / 手改 localStorage）都收编成合法配置。 */
export function sanitizeNotificationDuration(raw: unknown): NotificationDuration {
  if (raw === "never") return "never";
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_NOTIFICATION_DURATION;
  return clampNotificationSeconds(parsed);
}

export function loadNotificationDuration(): NotificationDuration {
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_DURATION_KEY);
    if (raw === null) return DEFAULT_NOTIFICATION_DURATION;
    return sanitizeNotificationDuration(JSON.parse(raw));
  } catch {
    return DEFAULT_NOTIFICATION_DURATION;
  }
}

export function saveNotificationDuration(value: NotificationDuration): void {
  try {
    window.localStorage.setItem(NOTIFICATION_DURATION_KEY, JSON.stringify(value));
  } catch {
    // 存不进去就仅会话内生效，与通知开关同一策略。
  }
}

/**
 * 算一条 toast 的存活毫秒；返回 Infinity 表示常驻（只能手动关）。
 *
 * 优先级（2D 任务书第 5 点 + 2026-11-01 通知重构）：
 * 1. 调用方显式传的 ttl 最高——那是「这条消息就是要活这么久」的明确意图；
 * 2. 警告 / 错误不再永久常驻（用户反馈红色通知无限堆积）：停留 = 全局时长 × 2，
 *    配合悬停暂停倒计时与手动关闭，既看得清也不会堆满屏；
 * 3. 其余按全局时长配置；"never" 仍然常驻。
 */
export function toastTtl(
  duration: NotificationDuration,
  tone: "ok" | "error" | "info" | "warn",
  explicitTtl?: number,
): number {
  if (explicitTtl !== undefined) return explicitTtl;
  if (duration === "never") return Infinity;
  if (tone === "warn" || tone === "error") return clampNotificationSeconds(duration) * 2 * 1000;
  return duration * 1000;
}
