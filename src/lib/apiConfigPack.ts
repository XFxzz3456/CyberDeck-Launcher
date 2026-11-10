import { invoke } from "@tauri-apps/api/core";

/** 一项「会改变数据流向或执行对象」的设置（后端默认不写入，等用户确认）。 */
export interface SensitiveChange {
  /** camelCase 字段名，前端用它取本地化标签。 */
  key: string;
  from: string;
  to: string;
}

export interface ConfigImportReport {
  applied: string[];
  ignored: string[];
  needsGameReverify: boolean;
  profiles: number;
  /** 包里带、但需要用户确认的敏感项；非空时什么都没写。 */
  sensitive: SensitiveChange[];
}

// 与 api.ts 保持一致的判定：Tauri 注入 __TAURI_INTERNALS__，浏览器预览里没有。
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const configPackApi = {
  /** 导出到数据目录 exports/，返回落盘路径。 */
  async exportPack(): Promise<string> {
    if (!isTauri) return "D:\\demo\\cyberdeck-data\\exports\\cyberdeck-config-demo.json";
    return invoke<string>("config_export");
  },

  /**
   * 导入配置。
   *
   * `applySensitive` 默认 false：AI 地址 / 工具路径 / 启动参数这几项只回给界面确认，
   * 不落库。用户在确认框里点了「应用」才带 true 再导一次。
   */
  async importPack(path: string, applySensitive = false): Promise<ConfigImportReport> {
    if (!isTauri) {
      return {
        applied: applySensitive ? ["aiBaseUrl", "aiModel", "profiles"] : ["aiModel", "profiles"],
        ignored: ["未知字段 legacyTheme"], // i18n-ignore
        needsGameReverify: true,
        profiles: 2,
        sensitive: applySensitive
          ? []
          : [
              { key: "aiBaseUrl", from: "https://api.deepseek.com/v1", to: "http://evil.example/v1" },
              { key: "archiveToolPath", from: "", to: "C:\\Windows\\System32\\calc.exe" },
            ],
      };
    }
    const raw = await invoke<{
      applied: string[];
      ignored: string[];
      needs_game_reverify: boolean;
      profiles: number;
      sensitive: SensitiveChange[];
    }>("config_import", { path, applySensitive });
    return {
      applied: raw.applied,
      ignored: raw.ignored,
      needsGameReverify: raw.needs_game_reverify,
      profiles: raw.profiles,
      sensitive: raw.sensitive ?? [],
    };
  },
};
