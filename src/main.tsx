import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";
import { bootstrapPersist } from "./lib/persist";
import { rehydrateSoundsFromPersist } from "./lib/useSoundEngine";
import { initApiConfig } from "./lib/apiConfig";
import { initSecureStorage } from "./lib/secureStorage";
import { TOKEN_KEY, DEVICE_KEY } from "./lib/auth";

// 最先初始化：API 地址 + 鉴权 token getter
initApiConfig();

// 请求持久化存储权限 — 告知浏览器不要在存储压力下自动清除本站 IndexedDB/localStorage。
// iOS Safari 对未请求 persist 的站点数据最多保留 7 天；
// 桌面 Chrome/Firefox 只在用户明确清理时删除，但 granted 后更安全。
if (typeof navigator !== "undefined" && navigator.storage?.persist) {
  void navigator.storage.persist().then(granted => {
    if (!granted) console.warn("[金玖] 浏览器拒绝持久化存储，数据可能被自动清除");
  });
}

const queryClient = new QueryClient();

const BOOTSTRAP_TIMEOUT = 2500;
const bootstrapTimeout = new Promise<void>(resolve =>
  setTimeout(resolve, BOOTSTRAP_TIMEOUT),
);

// 安全存储预热（token/deviceId 从持久化读入内存缓存）与 persist 并行跑，
// 统一受 2.5s 超时保护，超时后继续渲染（token 丢失时 AuthGate 会跳登录页）。
Promise.race([
  Promise.all([bootstrapPersist(), initSecureStorage([TOKEN_KEY, DEVICE_KEY])]),
  bootstrapTimeout,
]).finally(() => {
  rehydrateSoundsFromPersist();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>
  );
});
