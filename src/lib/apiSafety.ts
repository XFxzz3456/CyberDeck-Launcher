import { invoke } from "@tauri-apps/api/core";

export interface SafeModeState {
  active: boolean;
  snapshotAt: string | null;
  disabledCount: number;
}

export interface SafeModeReport {
  undeployedFiles: number;
  disabledMods: number;
  failedMods: number;
  snapshotPath: string;
  errors: string[];
}

export interface CompatFramework {
  id: string;
  name: string;
  /** ok | missing | broken */
  status: "ok" | "missing" | "broken";
  version: string | null;
  path: string;
  note: string;
}

export interface CompatRisk {
  id: string;
  name: string;
  /** risk（红，缺前置）| warn（黄，装得不完整） */
  severity: "risk" | "warn";
  reason: string;
  detail: string;
}

/**
 * 兼容性体检报告（只查核心前置，不再逐 Mod 找元数据）。
 *
 * 旧字段 stale/warn 是有意删除的：它们承载的「N 个兼容性未知」列表正是本轮
 * 要消灭的焦虑源。界面现在只认 `healthy` / `risks`。
 */
export interface CompatReport {
  /** 游戏内部版本原文（3.0.88.46235）。 */
  targetVersion: string;
  /** 社区叫法（2.5 / 旧版 (2.0 及以下) / 未知版本）。 */
  targetLabel: string;
  /** 版本号是否命中已知映射。 */
  targetMatched: boolean;
  /** 是否读到了游戏目录；false 时只提示绑定目录，不报风险。 */
  gameFound: boolean;
  checkedAt: string;
  scanned: number;
  frameworks: CompatFramework[];
  risks: CompatRisk[];
  healthy: boolean;
}

// 与 api.ts 保持一致的判定：Tauri 注入 __TAURI_INTERNALS__，浏览器预览里没有。
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function normalizeReport(raw: {
  undeployed_files: number;
  disabled_mods: number;
  failed_mods: number;
  snapshot_path: string;
  errors: string[];
}): SafeModeReport {
  return {
    undeployedFiles: raw.undeployed_files,
    disabledMods: raw.disabled_mods,
    failedMods: raw.failed_mods,
    snapshotPath: raw.snapshot_path,
    errors: raw.errors,
  };
}

export const safetyApi = {
  async state(): Promise<SafeModeState> {
    if (!isTauri) return { active: false, snapshotAt: null, disabledCount: 0 };
    const raw = await invoke<{ active: boolean; snapshot_at: string | null; disabled_count: number }>(
      "safemode_state",
    );
    return { active: raw.active, snapshotAt: raw.snapshot_at, disabledCount: raw.disabled_count };
  },

  async enter(): Promise<SafeModeReport> {
    if (!isTauri) {
      return {
        undeployedFiles: 128,
        disabledMods: 64,
        failedMods: 0,
        snapshotPath: "D:\\demo\\cyberdeck-data\\safemode-snapshot.json",
        errors: [],
      };
    }
    return normalizeReport(await invoke("safemode_enter"));
  },

  async exit(): Promise<SafeModeReport> {
    if (!isTauri) {
      return {
        undeployedFiles: 128,
        disabledMods: 64,
        failedMods: 0,
        snapshotPath: "",
        errors: [],
      };
    }
    return normalizeReport(await invoke("safemode_exit"));
  },

  async scanCompat(target?: string): Promise<CompatReport> {
    if (!isTauri) {
      // 预览里的演示数据：跟 mock 的游戏版本（2.31）保持一致，否则同一张卡片
      // 上面写 2.31、下面写别的版本号，看起来像 bug。
      const demoVersion = target ?? "2.31";
      return {
        targetVersion: demoVersion,
        targetLabel: demoVersion,
        targetMatched: true,
        gameFound: true,
        checkedAt: new Date().toISOString(),
        scanned: 4,
        frameworks: [
          { id: "red4ext", name: "RED4ext", status: "ok", version: "1.27.0", path: "red4ext/RED4ext.dll", note: "所有原生插件框架的运行基础" }, // i18n-ignore
          { id: "archivexl", name: "ArchiveXL", status: "ok", version: "1.24.0", path: "red4ext/plugins/ArchiveXL/ArchiveXL.dll", note: "扩展 archive 加载能力" }, // i18n-ignore
          { id: "tweakxl", name: "TweakXL", status: "ok", version: "1.11.0", path: "red4ext/plugins/TweakXL/TweakXL.dll", note: "TweakDB 修改支持" }, // i18n-ignore
          { id: "codeware", name: "Codeware", status: "ok", version: "1.16.0", path: "red4ext/plugins/Codeware/Codeware.dll", note: "脚本库" }, // i18n-ignore
        ],
        risks: [],
        healthy: true,
      };
    }
    return invoke<CompatReport>("compat_scan", { target: target ?? null });
  },
};
