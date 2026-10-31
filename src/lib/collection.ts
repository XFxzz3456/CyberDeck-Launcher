/**
 * Nexus Collections 集合安装向导的类型定义。
 *
 * 集合清单（*.collection / *.json）本身由 Nexus 社区维护，启动器不解析它的
 * 私有格式细节——后端把清单读出来、和本地模组库比对之后，给出下面这份
 * 「安装计划」。前端只负责把它画成人能读懂的清单，并按预设顺序部署。
 */

import type { MessageKey } from "../i18n";

/** 集合的基本信息，对应清单里的 info 段。 */
export interface CollectionInfo {
  name: string;
  author: string;
  description: string;
  /** Nexus 上的游戏域，例如 cyberpunk2077。 */
  domainName: string;
  /** 清单声明适配的游戏版本。 */
  gameVersions: string[];
}

/**
 * 单个条目在本地库里的状态。
 * - installed：已安装且版本一致
 * - version_mismatch：已安装但版本对不上，需要更新
 * - missing：本地没有
 */
export type CollectionItemStatus = "installed" | "version_mismatch" | "missing";

/** 集合里的一个模组条目。 */
export interface CollectionItem {
  /** Nexus ModId。 */
  modId: number;
  /** Nexus 文件 id；清单只锁 ModId 时为 null。 */
  fileId: number | null;
  name: string;
  /** 清单要求的版本；清单未声明时为 null。 */
  version: string | null;
  /** 可选项：缺了也不影响部署。 */
  optional: boolean;
  status: CollectionItemStatus;
  /** 本地库中对应条目的 id（ModEntry.id）；本地没有时为 null。 */
  localId: string | null;
  /** 本地已装版本；本地没有时为 null。 */
  localVersion: string | null;
  /** N 网页面地址，用来开网页引导用户手动下载。 */
  pageUrl: string;
  /** 预设部署顺序（由 modRules 拓扑排序得出）。 */
  order: number;
}

/** 后端比对清单与本地库之后给出的安装计划。 */
export interface CollectionPlan {
  info: CollectionInfo;
  items: CollectionItem[];
  /** 已装且版本一致的条目数。 */
  installed: number;
  /** 缺失的必需条目数。 */
  missing: number;
  /** 缺失的可选条目数。 */
  optionalMissing: number;
  /** 必需条目是否全部就绪（决定「按预设顺序部署」能否点击）。 */
  readyToDeploy: boolean;
  /** 按 modRules 拓扑排序后的 modId 列表。 */
  deployOrder: number[];
  /** 后端给的计划摘要，直接展示给用户。 */
  message: string;
}

/**
 * 整批集合部署的结果。
 *
 * 刻意不复用单模组的 DeployReport：那东西带一个 modEntry，
 * 而集合部署一次要动几十个 Mod，前端只关心整体成了几个、挂了几个。
 */
export interface CollectionDeployReport {
  /** 成功部署的模组数。 */
  deployed: number;
  /** 部署失败的模组数。 */
  failed: number;
  /** 整批部署过程中收集到的警告。 */
  warnings: string[];
  /** 实际落盘的模组 id 顺序（本地 ModEntry.id，按部署顺序）。 */
  order: string[];
}


/** 各状态在清单里的说法（值只存 key，渲染层用 t() 取；status 本身是数据值，不动）。 */
export const COLLECTION_STATUS_LABEL: Record<CollectionItemStatus, MessageKey> = {
  installed: "collection.installed",
  version_mismatch: "collection.versionMismatch",
  missing: "collection.missing",
};

/** 是不是集合清单文件（后端只认这两种扩展名）。 */
export function isCollectionManifestPath(path: string): boolean {
  return /\.(collection|json)$/i.test(path);
}

/**
 * 参与部署的本地条目 id。
 *
 * 取「本地已经有」的条目（已装 + 版本不符），按清单给出的 order 升序排列。
 *
 * 为什么版本不符的也要算：后端的 ready_to_deploy 只看「必需条目在不在本地」，
 * 不看版本——版本不符的 Mod 已经在库里，可以先按集合顺序部署，要不要更新版本
 * 交给用户决定。反过来把它排除掉，后端重写 modlist.txt 时就少了它的位置，
 * normalized_order 只能把它挪到列表末尾，集合的 modRules 顺序就断了。
 *
 * 顺序与本地库里的 id 对应后端 apply_collection_order 的入参：
 * 后端会照这个顺序重写 modlist.txt 并部署。
 */
export function collectionDeployIds(plan: CollectionPlan): string[] {
  return plan.items
    .filter(
      (item): item is CollectionItem & { localId: string } => item.localId !== null,
    )
    .sort((a, b) => a.order - b.order)
    .map((item) => item.localId);
}

/**
 * 版本不符的条目数。
 *
 * 后端的 CollectionPlan 只给 installed / missing / optionalMissing 三个总数，
 * 「已装但版本对不上」这一类不落在任何一个桶里。后端为此专门加字段意义不大——
 * items 里每条都带 status，前端自己数一遍即可。
 */
export function collectionVersionMismatchCount(plan: CollectionPlan): number {
  return plan.items.filter((item) => item.status === "version_mismatch").length;
}

