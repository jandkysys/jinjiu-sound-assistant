/**
 * Electron 专用 Vite 配置
 *
 * 与 Replit 开发环境的 vite.config.ts 的区别：
 *  - 无需 PORT / BASE_PATH 环境变量（Electron 不走 Replit 代理）
 *  - base: "./"  → 产物用相对路径（file:// 协议加载）
 *  - @workspace/api-client-react 通过 alias 直接指向 lib 源码
 *    （ZIP 解压后目录结构：xjt/artifacts/sound-assistant/ + xjt/lib/api-client-react/）
 *  - api-client-react 依赖的 @tanstack/react-query 通过 dedupe 强制从本项目
 *    node_modules 解析，避免 Rollup 跨目录找不到包的问题
 *  - 不包含任何 Replit 专用插件
 *  - VITE_API_URL 或 VITE_API_BASE_URL → 打包时注入 API 地址
 *    默认：https://crystal-clear-prompt.replit.app（生产服务器）
 *    打包时覆盖：VITE_API_URL=https://xxx.replit.app pnpm run build:electron
 *  - 输出到 dist/electron/（Electron main.js 从这里加载 index.html）
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const SA_ROOT = import.meta.dirname;
const NM = path.resolve(SA_ROOT, "node_modules");

// 支持 VITE_API_URL（新）和 VITE_API_BASE_URL（旧）两个环境变量名，新名优先
const apiBaseUrl =
  process.env.VITE_API_URL ||
  process.env.VITE_API_BASE_URL ||
  "https://crystal-clear-prompt.replit.app";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(SA_ROOT, "src"),
      "@workspace/api-client-react": path.resolve(
        SA_ROOT,
        "../../lib/api-client-react/src/index.ts",
      ),
      // 强制 @tanstack/react-query 始终从本项目 node_modules 解析
      "@tanstack/react-query": path.resolve(NM, "@tanstack/react-query"),
    },
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  root: SA_ROOT,
  build: {
    outDir: path.resolve(SA_ROOT, "dist/electron"),
    emptyOutDir: true,
  },
  define: {
    // 打包版 API 地址（不含尾部斜杠）
    // 优先级：VITE_API_URL > VITE_API_BASE_URL > 生产服务器
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify(apiBaseUrl),
  },
});
