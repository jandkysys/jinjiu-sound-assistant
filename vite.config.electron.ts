/**
 * Vite 配置 — Electron 本地打包专用
 *
 * 用途：Windows 本地执行 npm run build 时使用此配置
 *   - base: "./" 适配 Electron file:// 协议
 *   - 不依赖 PORT / BASE_PATH 环境变量
 *   - 不加载 Replit 特有插件
 *   - 输出到 dist/（electron/main.js 会加载 dist/index.html）
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: __dirname,
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  define: {
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify(
      process.env.VITE_API_BASE_URL ?? "https://crystal-clear-prompt.replit.app"
    ),
  },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    strictPort: false,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
