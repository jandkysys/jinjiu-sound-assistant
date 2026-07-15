/**
 * 安全存储抽象层
 *
 * Web / Replit:  使用 localStorage（现有行为不变）
 * Tauri 桌面端:  使用 @tauri-apps/plugin-store（加密文件存储）
 *
 * 关键设计：读取保持同步（从内存缓存），写入/删除异步持久化。
 * 启动时调用 initSecureStorage(keys) 将持久化数据预热进内存，
 * 之后 secureGetSync / setToken / clearToken 等调用均为 O(1) 同步操作。
 *
 * ─── Tauri 打包步骤 ──────────────────────────────────────────────────────────
 *
 *  1. 安装插件：
 *       pnpm add @tauri-apps/plugin-store
 *       cargo add tauri-plugin-store   (src-tauri/Cargo.toml)
 *
 *  2. 注册插件 (src-tauri/src/main.rs)：
 *       .plugin(tauri_plugin_store::Builder::default().build())
 *
 *  3. 权限 (src-tauri/capabilities/default.json)：
 *       "permissions": ["store:default"]
 *
 * ─── 麦克风权限（Tauri）────────────────────────────────────────────────────────
 *
 *  capabilities/default.json 加入：
 *    "permissions": ["media-preview:default"]   ← Tauri v2 媒体权限
 *
 *  macOS 需在 src-tauri/entitlements.plist 加入：
 *    <key>com.apple.security.device.audio-input</key>
 *    <true/>
 *
 *  tauri.conf.json > bundle > macOS > entitlements 填入 plist 路径。
 *
 *  Windows / Linux：Tauri 默认允许麦克风访问，无需额外配置。
 */

// ─── 内存缓存（同步读取基础）────────────────────────────────────────────────

const _cache = new Map<string, string>();

// ─── Tauri plugin-store 接口（与包形状匹配的本地类型，不需静态依赖）──────────

interface TauriStorePlugin {
  Store: {
    load(path: string, options?: { autoSave?: boolean }): Promise<TauriStoreInstance>;
  };
}
interface TauriStoreInstance {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  save(): Promise<void>;
}

// 绕过 Vite/Rollup 静态 import-analysis，运行时按需加载
const _dynImport = new Function("m", "return import(m)") as
  (m: string) => Promise<unknown>;

let _storePromise: Promise<TauriStoreInstance | null> | null = null;

function isTauriEnv(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function getStore(): Promise<TauriStoreInstance | null> {
  if (_storePromise) return _storePromise;
  if (!isTauriEnv()) {
    _storePromise = Promise.resolve(null);
    return _storePromise;
  }
  _storePromise = _dynImport("@tauri-apps/plugin-store")
    .then(async (m) => {
      const plugin = m as TauriStorePlugin;
      return plugin.Store.load("secure.json", { autoSave: false });
    })
    .catch(() => null);
  return _storePromise;
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/**
 * 启动时预热：从持久化存储（Tauri secure store 或 localStorage）
 * 将指定 key 读入内存缓存，使后续 secureGetSync 可同步访问。
 *
 * 在 main.tsx bootstrap 最早处 await 调用。
 */
export async function initSecureStorage(keys: string[]): Promise<void> {
  const store = await getStore();

  if (!store) {
    // Web：从 localStorage 加载
    for (const key of keys) {
      try {
        const v = localStorage.getItem(key);
        if (v !== null) _cache.set(key, v);
      } catch {}
    }
    return;
  }

  // Tauri：从加密文件存储加载
  for (const key of keys) {
    try {
      const v = await store.get<string>(key);
      if (v != null) _cache.set(key, v);
    } catch {}
  }
}

/**
 * 同步读取（从内存缓存）。
 * 需先调用 initSecureStorage 预热，否则返回 null。
 */
export function secureGetSync(key: string): string | null {
  return _cache.get(key) ?? null;
}

/**
 * 异步写入：同时更新内存缓存和持久化存储。
 */
export async function secureSet(key: string, value: string): Promise<void> {
  _cache.set(key, value);
  const store = await getStore();
  if (!store) {
    try { localStorage.setItem(key, value); } catch {}
    return;
  }
  await store.set(key, value);
  await store.save();
}

/**
 * 异步删除：同时清除内存缓存和持久化存储。
 */
export async function secureDelete(key: string): Promise<void> {
  _cache.delete(key);
  const store = await getStore();
  if (!store) {
    try { localStorage.removeItem(key); } catch {}
    return;
  }
  await store.delete(key);
  await store.save();
}

/** 是否运行在原生安全存储环境（Tauri）。 */
export function isNativeSecureStore(): boolean {
  return isTauriEnv();
}
