/**
 * Vite 的 `?raw` 导入声明。
 *
 * 项目 tsconfig 只带 `types: ["node"]`，没有引入 `vite/client`，
 * 所以 `import text from "./x.md?raw"` 会被 tsc 判成找不到模块。
 * 这里只补我们需要的那一条，避免把整套 vite/client 全局类型灌进来。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
