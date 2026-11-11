/**
 * 全局编译期常量声明。
 *
 * - `__APP_VERSION__`：由 vite.config.ts 的 `define` 从 package.json 的 version 注入。
 *   仅供 src/lib/appVersion.ts 在「非 Tauri 环境」兜底使用；业务代码请用 `useAppVersion()`，
 *   不要直接读这个常量，也不要再硬编码版本号（见 docs/AGENTS.md 版本更新自动化规范）。
 */
declare const __APP_VERSION__: string;

/**
 * `import.meta.env` 的最小声明。
 *
 * 项目 tsconfig 只带 `types: ["node"]`，没有引入 `vite/client`（见 raw-import.d.ts
 * 的取舍说明），但 `import.meta.env.DEV` 是运行时的真实字段。这里只补用得到的
 * 两个布尔开关，避免把整套 vite/client 全局类型灌进来。
 */
interface ImportMeta {
  readonly env: {
    readonly DEV: boolean;
    readonly PROD: boolean;
  };
}
