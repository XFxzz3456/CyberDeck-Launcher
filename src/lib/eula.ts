/**
 * 使用协议的同意状态。
 *
 * 键名沿用项目的 `ncl.ui.*` 前缀（与 `ncl.ui.preferences.v1`、`ncl.ui.bellSeenAt.v1` 一致）。
 * 这是一个一次性标记，和偏好设置分开放：偏好随时会重写，标记只写一次，
 * 混在一个对象里会让"重置外观设置"顺手把协议同意状态也清掉。
 */
const EULA_ACCEPTED_KEY = "ncl.ui.eulaAccepted.v1";

export function readEulaAccepted(): boolean {
  try {
    return window.localStorage.getItem(EULA_ACCEPTED_KEY) === "true";
  } catch {
    // localStorage 被禁用时按"未同意"处理：宁可多问一次，也不能替用户表态。
    return false;
  }
}

export function markEulaAccepted(): void {
  try {
    window.localStorage.setItem(EULA_ACCEPTED_KEY, "true");
  } catch {
    // 写不进去不该把人挡在门外：本次会话的内存状态已经放行，下次启动再问一次。
  }
}
