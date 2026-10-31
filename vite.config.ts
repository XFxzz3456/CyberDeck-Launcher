import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as pkg from "./package.json";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 版本号唯一来源：package.json。浏览器预览（无 Tauri runtime）用它兜底，
  // 正式运行时优先用 Tauri `app.getVersion()`，见 src/lib/appVersion.ts。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome105",
    minify: "oxc",
    sourcemap: false,
  },
});
