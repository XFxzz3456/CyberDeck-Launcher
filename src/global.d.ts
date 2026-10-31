/**
 * 全局编译期常量声明。
 *
 * - `__APP_VERSION__`：由 vite.config.ts 的 `define` 从 package.json 的 version 注入。
 *   仅供 src/lib/appVersion.ts 在「非 Tauri 环境」兜底使用；业务代码请用 `useAppVersion()`，
 *   不要直接读这个常量，也不要再硬编码版本号（见 docs/AGENTS.md 版本更新自动化规范）。
 */
declare const __APP_VERSION__: string;
