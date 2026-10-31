/**
 * 反馈节流：把「短时间内连续发生的同型操作」攒成一次反馈。
 *
 * 为什么要它：部署 / 撤销是轻操作——结果在卡片角标上一眼可见，
 * 每成功一次就弹一条 toast 等于把有用信息推进噪声里（连续开关 5 个模组
 * 会刷 5~9 条）。这里的取舍是：
 *   - 窗口内总共只有 1 次操作：静默，只在活动流留痕；
 *   - 窗口内 ≥ 2 次操作：窗口结束时**一条**汇总 toast（走 deploy 类别，受设置页开关约束），
 *     数字按所有分组加总，和「这条 toast 到底替几条操作发声」对得上。
 *
 * ⚠️ 窗口从**最后一次合入**起算（不是从第一次）：连续点击时每次都把窗口往后推，
 * 保证一整串操作必然落在同一个批次里。代价是「不停地点」会让汇总一直延后，
 * 停下才弹——这正是想要的：安静时给结论，忙碌时不打扰。
 *
 * 这个模块不依赖 React：`t` / `toast` 由调用方（App.tsx）传进去，
 * 方便单独单测，也避免把定时器状态藏进组件。
 */

export interface CoalesceGroup {
  /** 分组键，例如 "deploy" / "disable"。 */
  key: string;
  /** 该键在本窗口内的累计次数。 */
  count: number;
  /** 参与本次合并的条目名称（按发生顺序），供汇总文案引用。 */
  titles: string[];
}

export interface Coalescer {
  /** 合入一条；title 可选，只用于汇总文案里点名。 */
  push(key: string, title?: string): void;
  /** 立刻结算当前窗口（窗口内只有 1 次操作时不产生反馈）。 */
  flush(): void;
  /** 组件卸载 / 页面关闭前调用：清定时器并结算，别把已完成的批次吞掉。 */
  dispose(): void;
}

/**
 * @param windowMs 静默窗口毫秒数（项目约定 2000）。
 * @param onBatch   结算回调：窗口内累计 ≥2 次时才回调一次，收到的是全部分组。
 */
export function createCoalescer(
  windowMs: number,
  onBatch: (groups: CoalesceGroup[]) => void,
): Coalescer {
  const buckets = new Map<string, { count: number; titles: string[] }>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buckets.size === 0) return;
    const batch: CoalesceGroup[] = [];
    for (const [key, value] of buckets) {
      batch.push({ key, count: value.count, titles: value.titles });
    }
    buckets.clear();
    const total = batch.reduce((sum, group) => sum + group.count, 0);
    // 一次操作：静默。多次：整批（含只出现一次的分组）一次性交给调用方汇总，
    // 否则汇总里的数字会少算「单独一次」的那些，跟活动流对不上。
    if (total > 1) onBatch(batch);
  };

  return {
    push(key, title) {
      const bucket = buckets.get(key) ?? { count: 0, titles: [] };
      bucket.count += 1;
      if (title) bucket.titles.push(title);
      buckets.set(key, bucket);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, windowMs);
    },
    flush,
    dispose: flush,
  };
}
