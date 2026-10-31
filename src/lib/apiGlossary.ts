import { invoke } from "@tauri-apps/api/core";

/** 词表状态（条数 / 来源分布 / 共享开关）。 */
export interface GlossaryStatus {
  entries: number;
  local: number;
  cloud: number;
  enabled: boolean;
  remoteUrl: string;
}

/** 合并结果：新增 / 跳过 / 冲突 / 合并后总数。 */
export interface GlossaryMerge {
  added: number;
  skipped: number;
  conflicts: number;
  total: number;
}

// 与 api.ts 保持一致的判定：Tauri 注入 __TAURI_INTERNALS__，浏览器预览里没有。
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 后端返回的字段是 snake_case，这里统一转成前端习惯的驼峰。 */
type RawStatus = {
  entries: number;
  local: number;
  cloud: number;
  enabled: boolean;
  remote_url: string;
};

export const glossaryApi = {
  async status(): Promise<GlossaryStatus> {
    if (!isTauri) {
      return { entries: 42, local: 40, cloud: 2, enabled: false, remoteUrl: "" };
    }
    const raw = await invoke<RawStatus>("glossary_status");
    return {
      entries: raw.entries,
      local: raw.local,
      cloud: raw.cloud,
      enabled: raw.enabled,
      remoteUrl: raw.remote_url,
    };
  },

  /** 导出到数据目录，返回落盘路径。 */
  async exportPack(): Promise<string> {
    if (!isTauri) return "D:\\demo\\cyberdeck-data\\exports\\glossary-demo.json";
    return invoke<string>("glossary_export");
  },

  async importPack(path: string): Promise<GlossaryMerge> {
    if (!isTauri) return { added: 6, skipped: 1, conflicts: 0, total: 48 };
    return invoke<GlossaryMerge>("glossary_import", { path });
  },

  async getConfig(): Promise<{ enabled: boolean; remoteUrl: string }> {
    if (!isTauri) return { enabled: false, remoteUrl: "" };
    const raw = await invoke<{ enabled: boolean; remote_url: string }>("glossary_config");
    return { enabled: raw.enabled, remoteUrl: raw.remote_url };
  },

  async setConfig(enabled: boolean, remoteUrl: string): Promise<void> {
    if (!isTauri) return;
    await invoke("glossary_set_config", { enabled, remoteUrl });
  },

  async syncRemote(): Promise<GlossaryMerge> {
    if (!isTauri) return { added: 3, skipped: 12, conflicts: 1, total: 51 };
    return invoke<GlossaryMerge>("glossary_sync");
  },
};
