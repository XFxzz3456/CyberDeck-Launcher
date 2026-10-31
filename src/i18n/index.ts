import { zhCN } from "./zh-CN";

/**
 * 文案占位层（i18n seam）。
 *
 * 当前只有 zh-CN 一份词表，`t` 就是查表 + 插值，没有语言切换、没有库依赖。
 * 未来要真正国际化时，**只改这个文件**：让 `t` 走 i18next / FormatJS 即可，
 * 调用方（几十个组件里的 `t("ns.key")`）一行都不用动。
 *
 * 不使用 React Context 是刻意的：`t` 必须在模块级常量、事件回调、纯函数里都能调用。
 * 真正的语言切换需要重渲染时，再在外层加一个读 locale 的 Provider 并让 `t` 从
 * 模块级改读取当前 locale（键结构不变，迁移成本仍是零）。
 */

/** 把嵌套词表拍平成 `"nav.library"` 形式的字面量联合，作为 key 的编译期约束。 */
type LeafPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** 所有合法文案 key。写错 key 会在 `tsc --noEmit` 阶段直接报错。 */
export type MessageKey = LeafPaths<typeof zhCN>;

/** 插值变量：`{name}` 会被替换。 */
export type MessageVars = Record<string, string | number>;

/** 原始词表，仅供类型推导与开发期断言使用，组件不要直接 import。 */
export const messages = zhCN;

function raw(key: string): string | undefined {
  let node: unknown = zhCN;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * 取文案。找不到时**原样返回 key**（并在 dev 下告警），
 * 这样界面上会直接看到 `settings.tabs.about` 这种明显的错位，而不是静默空白。
 */
export function t(key: MessageKey, vars?: MessageVars): string {
  const value = raw(key);
  if (value === undefined) {
    // 开发期告警；生产环境下这条分支只可能在 key 写错时命中，代价可忽略。
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      console.warn(`[i18n] 缺少文案: ${key}`);
    }
    return key;
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * 动态 key 逃生口（如 `tDyn(`settings.tabs.${id}`)`）。
 * 类型无法校验，仅用于 key 由联合类型拼装的场景；能用 `t` 就不要用它。
 */
export function tDyn(key: string, vars?: MessageVars): string {
  return t(key as MessageKey, vars);
}

/**
 * 模组分类的「数据值 → 显示文案」映射。
 *
 * 分类取值本身是持久化数据（写进 launcher-state.json 的 mods[].category，
 * 也用作筛选比较值），见 types.ts 的 CATEGORIES——那张表一个字都不能改。
 * 这里用显式对照表把数据值翻成文案：没有对应 key 时**原样返回 value**，
 * 绝不把 `category.xxx` 这种裸 key 漏到界面上。
 */
const CATEGORY_LABEL: Record<string, MessageKey> = {
  "全部": "category.all",
  "已启用": "category.enabled",
  "框架": "category.framework",
  "玩法": "category.gameplay",
  "武器": "category.weapon",
  "服装": "category.clothing",
  "车辆": "category.vehicle",
  "视觉": "category.visual",
  "音频": "category.audio",
  "任务": "category.quest",
  "工具": "category.tool",
  "其他": "category.other",
};

export function categoryLabel(value: string): string {
  const key = CATEGORY_LABEL[value];
  return key ? t(key) : value;
}
