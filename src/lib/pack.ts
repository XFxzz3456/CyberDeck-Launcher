/**
 * 整合包（Modpack）的前端类型。
 *
 * 与后端 `src-tauri/src/pack.rs` 的 serde 结构一一对应。字段名维持 camelCase，
 * 与其它模块保持一致。
 */

export type PackKind = "list" | "full";

export interface PackExportInput {
  kind: PackKind;
  name: string;
  author?: string;
  /** 是否把没有 Nexus 编号的条目一起收进来（完整包默认收）。 */
  includeUnlisted?: boolean;
  /** 指定输出路径；不传由后端放到数据目录 exports/ 下。 */
  outPath?: string;
}

export interface PackExportReport {
  path: string;
  sizeBytes: number;
  mods: number;
  enabled: number;
  configs: number;
  unresolved: number;
  warnings: string[];
}

export type PackItemStatus = "installed" | "version_mismatch" | "missing" | "local_only";

export interface PackPreviewItem {
  key: string;
  name: string;
  version: string | null;
  modId: number | null;
  fileId: number | null;
  enabled: boolean;
  status: PackItemStatus;
  matchedEntryId: string | null;
  matchedVersion: string | null;
  sizeBytes: number;
  hasFiles: boolean;
  pageUrl: string | null;
}

export interface PackPreview {
  path: string;
  name: string;
  author: string;
  mode: "list" | "full";
  createdAt: string;
  appVersion: string;
  gameVersion: string | null;
  total: number;
  installed: number;
  missing: number;
  versionMismatch: number;
  localOnly: number;
  enabled: number;
  configs: number;
  totalSize: number;
  items: PackPreviewItem[];
  warnings: string[];
}

export interface PackInstallReport {
  installed: number;
  failed: number;
  warnings: string[];
}

export interface PackManualItem {
  modId: number;
  fileId: number | null;
  name: string;
  url: string;
}

export interface PackQueueReport {
  queued: number;
  skipped: number;
  manual: PackManualItem[];
  warnings: string[];
}

export interface PackApplyReport {
  deployed: number;
  undeployed: number;
  missing: number;
  configsWritten: number;
  configsFailed: number;
  orderApplied: number;
  warnings: string[];
}

export interface BackfillProposal {
  entryId: string;
  entryName: string;
  modId: number;
  fileId: number | null;
  matchedName: string;
  matchedVersion: string | null;
  source: "vortex" | "filename" | "search" | string;
  confidence: "exact" | "contains" | "search" | string;
}

export interface BackfillReport {
  scanned: number;
  proposals: BackfillProposal[];
  unmatched: string[];
  vortexStatus: "ok" | "missing" | "locked" | string;
  vortexMessage: string;
  remoteMessage: string | null;
}

/** 这个路径是不是整合包（拖放路由用）。 */
export function isPackPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".cdlist") || lower.endsWith(".cdpack");
}

/** 拖放时判断清单类型，给对话框一个初始模式。 */
export function packKindOf(path: string): PackKind {
  return path.toLowerCase().endsWith(".cdpack") ? "full" : "list";
}
