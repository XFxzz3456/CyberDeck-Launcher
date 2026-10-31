/**
 * 应用版本号的**唯一取数入口**。
 *
 * 背景：`src/i18n/zh-CN.ts` 里的 `app.version` 曾经直接写死成 `"v0.7.0"`，
 * 版本升到 0.8.0 后关于页仍显示旧号。按项目《版本更新自动化规范》，
 * 前端**严禁**硬编码版本，统一走这里。
 *
 * 取数优先级：
 * 1. Tauri runtime 的 `app.getVersion()`（读的是 tauri.conf.json 的 version，打包后即真实版本）
 * 2. `__APP_VERSION__`（vite 构建时从 package.json 注入，用于浏览器预览 / UI 测试）
 * 3. `"DEV"`（两者都拿不到时的显式标记，绝不显示一个看起来真实的号）
 */

import { useEffect, useState } from "react";

const FALLBACK = "DEV";

let cached: string | null = null;

function format(raw: string): string {
  const v = raw.trim();
  if (!v) return FALLBACK;
  return v.startsWith("v") ? v : `v${v}`;
}

/** 浏览器预览环境下由 vite `define` 注入；tsc 侧由 src/global.d.ts 声明。 */
function buildTimeVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
  } catch {
    return null;
  }
}

/**
 * 解析当前应用版本号，形如 `v0.8.0`。
 * 结果在进程内缓存，重复调用不会重复触发 IPC。
 */
export async function resolveAppVersion(): Promise<string> {
  if (cached) return cached;

  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    if (v && v.trim()) {
      cached = format(v);
      return cached;
    }
  } catch {
    // 非 Tauri 环境（浏览器预览）或 IPC 不可用，走构建期注入值
  }

  const fromBuild = buildTimeVersion();
  cached = fromBuild ? format(fromBuild) : FALLBACK;
  return cached;
}

/**
 * React 侧取版本的唯一入口。
 * 首帧先返回已缓存值（或 `DEV`），IPC 回来后再刷新，不会阻塞渲染。
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState<string>(cached ?? FALLBACK);

  useEffect(() => {
    let alive = true;
    void resolveAppVersion().then((v) => {
      if (alive) setVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  return version;
}
