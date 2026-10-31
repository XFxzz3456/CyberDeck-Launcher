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

export interface CompatIssue {
  modId: string;
  name: string;
  declared: string | null;
  reason: string;
}

export interface CompatReport {
  targetVersion: string;
  scanned: number;
  stale: CompatIssue[];
  warn: CompatIssue[];
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
      return {
        targetVersion: target ?? "2.5",
        scanned: 64,
        stale: [
          // 演示数据，不进词表
          { modId: "demo-1", name: "Demo Old Mod", declared: "2.21", reason: "声明适配 2.21，低于 2.5" }, // i18n-ignore
        ],
        // 演示数据，不进词表
        warn: [{ modId: "demo-2", name: "Demo Unknown Mod", declared: null, reason: "没有找到兼容性声明" }], // i18n-ignore
      };
    }
    return invoke<CompatReport>("compat_scan", { target: target ?? null });
  },
};
