import { invoke } from "@tauri-apps/api/core";

export interface ConfigImportReport {
  applied: string[];
  ignored: string[];
  needsGameReverify: boolean;
  profiles: number;
}

// 与 api.ts 保持一致的判定：Tauri 注入 __TAURI_INTERNALS__，浏览器预览里没有。
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const configPackApi = {
  /** 导出到数据目录 exports/，返回落盘路径。 */
  async exportPack(): Promise<string> {
    if (!isTauri) return "D:\\demo\\cyberdeck-data\\exports\\cyberdeck-config-demo.json";
    return invoke<string>("config_export");
  },

  async importPack(path: string): Promise<ConfigImportReport> {
    if (!isTauri) {
      return {
        applied: ["aiBaseUrl", "aiModel", "profiles"],
        ignored: ["未知字段 legacyTheme"], // i18n-ignore
        needsGameReverify: true,
        profiles: 2,
      };
    }
    const raw = await invoke<{
      applied: string[];
      ignored: string[];
      needs_game_reverify: boolean;
      profiles: number;
    }>("config_import", { path });
    return {
      applied: raw.applied,
      ignored: raw.ignored,
      needsGameReverify: raw.needs_game_reverify,
      profiles: raw.profiles,
    };
  },
};
