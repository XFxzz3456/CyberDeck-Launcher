/**
 * Nexus 账户状态的跨组件广播。
 *
 * 背景：设置页的 `NexusSettingsCard` 与 Nexus 页的 `NexusView` 各自持有一份
 * `nexusStatus`，也各拉各的。在其中一个页面连接 / 断开 API Key 后，另一份不会变，
 * 于是出现「明明已经关联了，另一个页面还显示未关联」的错觉（2026-10-30 反馈）。
 *
 * 做法：谁改了状态谁广播，另一边收到就重拉一次。发事件的组件自己跳过——
 * 它已经用返回值就地更新过状态，而 `nexus_status` 是要联网校验 API Key 的，
 * 没必要为一次点击白跑两遍。
 *
 * 用 window 事件而不是状态库：全项目只有这两个消费点，不值得为它加一层 context。
 */
const EVENT = "cdl:nexus-status-changed";

export function notifyNexusStatusChanged(source: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { source } }));
}

export function onNexusStatusChanged(source: string, handler: () => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ source?: string } | undefined>).detail;
    if (detail?.source === source) return;
    handler();
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
