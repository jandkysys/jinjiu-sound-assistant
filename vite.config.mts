import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";

const isBuild = process.argv.includes("build");
const isElectronBuild = process.env.ELECTRON_BUILD === "1";

const rawPort = process.env.PORT;
if (!isBuild && !rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}
const port = Number(rawPort ?? "3000");
if (!isBuild && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = isElectronBuild ? "./" : (process.env.BASE_PATH ?? "/sound-assistant/");
if (!isBuild && !isElectronBuild && !process.env.BASE_PATH) {
  throw new Error("BASE_PATH environment variable is required but was not provided.");
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
    ...(!isElectronBuild
      ? [
          VitePWA({
            registerType: "autoUpdate",
            injectRegister: "auto",
            workbox: {
              globPatterns: ["**/*.{js,css,html,svg,ico,webmanifest}"],
              navigateFallback: "index.html",
              navigateFallbackDenylist: [/^\/api/, /^\/sound-assistant\/api/],
              cleanupOutdatedCaches: true,
            },
            devOptions: {
              enabled: false,
            },
            manifest: {
              name: "金玖音效助手",
              short_name: "金玖音效",
              description:
                "专业直播音效管理系统 — 音效快速触发、场景切换、批量导入",
              start_url: "./",
              scope: "./",
              display: "standalone",
              background_color: "#1a1206",
              theme_color: "#E6B66E",
              orientation: "portrait-primary",
              lang: "zh-CN",
              categories: ["productivity", "utilities"],
              icons: [
                { src: "./icons/icon-192.png",  sizes: "192x192",   type: "image/png",     purpose: "any"      },
                { src: "./icons/icon-512.png",  sizes: "512x512",   type: "image/png",     purpose: "any"      },
                { src: "./icons/icon-512.png",  sizes: "512x512",   type: "image/png",     purpose: "maskable" },
                { src: "./icons/icon-1024.png", sizes: "1024x1024", type: "image/png",     purpose: "any"      },
                { src: "./favicon.svg",         sizes: "any",       type: "image/svg+xml", purpose: "any"      },
              ],
            },
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(
      import.meta.dirname,
      isElectronBuild ? "dist/electron" : "dist/public",
    ),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
