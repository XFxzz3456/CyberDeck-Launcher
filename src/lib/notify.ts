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
