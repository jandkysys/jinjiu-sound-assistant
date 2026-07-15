/**
 * 全局音效快捷键桥接层
 *
 * 运行时自动检测环境并选择对应实现：
 *   Tauri 桌面端   → tauriBridge（需安装 @tauri-apps/plugin-global-shortcut）
 *   Electron 桌面端 → electronBridge（需 preload 暴露 window.electronGS）
 *   Web / 其他     → webStub（仅窗口聚焦时有效，通过 keydown 监听模拟）
 *
 * ─── Tauri 打包步骤 ───────────────────────────────────────────────────────────
 *
 *   1. 安装插件：
 *        pnpm add @tauri-apps/plugin-global-shortcut
 *        cargo add tauri-plugin-global-shortcut   (src-tauri/Cargo.toml)
 *
 *   2. 注册插件 (src-tauri/src/main.rs)：
 *        .plugin(tauri_plugin_global_shortcut::init())
 *
 *   3. 权限 (src-tauri/capabilities/default.json)：
 *        "permissions": ["global-shortcut:default"]
 *
 * ─── Electron 打包步骤 ────────────────────────────────────────────────────────
 *
 *   main process：
 *     ipcMain.handle("gs-register",      (_, key) =>
 *       globalShortcut.register(key, () => win.webContents.send("gs-fire", key)))
 *     ipcMain.handle("gs-unregister",    (_, key) => globalShortcut.unregister(key))
 *     ipcMain.handle("gs-unregister-all",()       => globalShortcut.unregisterAll())
 *     app.on("will-quit", () => globalShortcut.unregisterAll())
 *
 *   preload.js：
 *     contextBridge.exposeInMainWorld("electronGS", {
 *       register:      (key) => ipcRenderer.invoke("gs-register", key),
 *       unregister:    (key) => ipcRenderer.invoke("gs-unregister", key),
 *       unregisterAll: ()    => ipcRenderer.invoke("gs-unregister-all"),
 *       onFire:        (cb)  => ipcRenderer.on("gs-fire", (_, key) => cb(key)),
 *     })
 */

// ─── 类型声明 ─────────────────────────────────────────────────────────────────

export interface GlobalShortcutBridge {
  /** 注册全局快捷键。返回 true 表示成功，false 表示已被占用或注册失败。 */
  register(key: string, callback: () => void): Promise<boolean>;
  /** 注销指定全局快捷键。 */
  unregister(key: string): Promise<void>;
  /** 注销全部已注册的全局快捷键。 */
  unregisterAll(): Promise<void>;
  /** true 表示运行在支持真正全局监听的桌面环境（Tauri / Electron）。 */
  isNative: boolean;
}

declare global {
  interface Window {
    /** Tauri v1 / v2 存在时注入 */
    __TAURI__?: unknown;
    /** Tauri v2 内部桥接（比 __TAURI__ 更可靠的检测标志） */
    __TAURI_INTERNALS__?: unknown;
    /** Electron preload 通过 contextBridge 暴露的全局快捷键 API */
    electronGS?: {
      register:      (key: string) => Promise<boolean>;
      unregister:    (key: string) => Promise<void>;
      unregisterAll: ()            => Promise<void>;
      onFire:        (cb: (key: string) => void) => void;
    };
  }
}

// ─── Web 存根 ──────────────────────────────────────────────────────────────────

const webStub: GlobalShortcutBridge = {
  isNative: false,
  register:      async () => false,
  unregister:    async () => {},
  unregisterAll: async () => {},
};

// ─── Tauri 桥接 ───────────────────────────────────────────────────────────────

/**
 * 通过动态 import 加载 @tauri-apps/plugin-global-shortcut。
 * Web 构建中此包不存在，import 会 reject，catch 返回 null → 退回 webStub。
 * Tauri 打包时此包已安装，正常使用。
 */
/** 与 @tauri-apps/plugin-global-shortcut 导出形状匹配的本地接口，避免静态依赖。 */
interface TauriGlobalShortcutPlugin {
  register(shortcut: string, handler: () => void): Promise<void>;
  unregister(shortcut: string): Promise<void>;
  unregisterAll(): Promise<void>;
}

/**
 * 绕过 Vite / Rollup 静态 import-analysis 的动态加载辅助函数。
 * new Function 构造的函数不会被打包工具扫描，import 路径在运行时才解析。
 * Tauri 打包时包已安装 → 成功；Web 构建时包不存在 → Promise.reject → null。
 */
const _dynamicImport = new Function("m", "return import(m)") as
  (m: string) => Promise<unknown>;

function buildTauriBridge(): GlobalShortcutBridge {
  let pluginPromise: Promise<TauriGlobalShortcutPlugin | null> | null = null;

  function getPlugin() {
    if (!pluginPromise) {
      pluginPromise = _dynamicImport("@tauri-apps/plugin-global-shortcut")
        .then(m => m as TauriGlobalShortcutPlugin)
        .catch(() => null);
    }
    return pluginPromise;
  }

  return {
    isNative: true,

    register: async (key, cb) => {
      const p = await getPlugin();
      if (!p) return false;
      try {
        await p.register(key, cb);
        return true;
      } catch {
        return false;
      }
    },

    unregister: async (key) => {
      const p = await getPlugin();
      if (!p) return;
      try { await p.unregister(key); } catch {}
    },

    unregisterAll: async () => {
      const p = await getPlugin();
      if (!p) return;
      try { await p.unregisterAll(); } catch {}
    },
  };
}

// ─── Electron 桥接 ────────────────────────────────────────────────────────────

function buildElectronBridge(): GlobalShortcutBridge {
  const gs = window.electronGS!;

  // 单一回调表：key → cb（避免每次 register 都往 ipcRenderer 堆新监听器）
  const callbacks = new Map<string, () => void>();
  let listenerRegistered = false;

  function ensureFireListener() {
    if (listenerRegistered) return;
    listenerRegistered = true;
    gs.onFire((firedKey: string) => {
      const cb = callbacks.get(firedKey);
      if (cb) cb();
    });
  }

  return {
    isNative: true,

    register: async (key, cb) => {
      callbacks.set(key, cb);  // 覆盖同 key 的旧回调，不堆监听器
      ensureFireListener();
      return gs.register(key);
    },

    unregister: async (key) => {
      callbacks.delete(key);
      return gs.unregister(key);
    },

    unregisterAll: async () => {
      callbacks.clear();
      return gs.unregisterAll();
    },
  };
}

// ─── 环境自动检测 ─────────────────────────────────────────────────────────────

let _bridge: GlobalShortcutBridge | null = null;

/**
 * 获取当前环境对应的快捷键桥接实现（单例，首次调用时检测环境）。
 *
 * 优先级：Electron > Tauri > Web 存根
 */
export function getGlobalShortcutBridge(): GlobalShortcutBridge {
  if (_bridge) return _bridge;

  if (typeof window !== "undefined" && window.electronGS) {
    _bridge = buildElectronBridge();
    return _bridge;
  }

  if (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  ) {
    _bridge = buildTauriBridge();
    return _bridge;
  }

  _bridge = webStub;
  return _bridge;
}

// ─── 工具函数（与桥接实现无关，Web / 桌面通用） ──────────────────────────────

/**
 * 将 KeyboardEvent 规范化为全局快捷键绑定字符串。
 *
 * 支持格式：
 *   F1–F12、Ctrl+1–0、Alt+1–0、Ctrl+Alt+1、Ctrl+F1、Alt+Z …
 *
 * 返回 null 表示此按键不适合作为全局快捷键（裸字母键、普通符号键等）。
 */
export function parseGlobalShortcutFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");

  const modStr = mods.length ? mods.join("+") + "+" : "";

  if (/^F(1[0-2]|[1-9])$/.test(e.key)) return modStr + e.key;
  if (/^\d$/.test(e.key)) return modStr + e.key;
  if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) return modStr + e.key.toUpperCase();

  return null;
}

/**
 * 判断绑定字符串是否为"裸字母键"（无修饰键的单个大写字母）。
 * 绑定裸字母键时建议弹出警告。
 */
export function isBareLetter(binding: string): boolean {
  return /^[A-Z]$/.test(binding);
}

/**
 * 判断 KeyboardEvent 是否匹配给定绑定字符串。
 * 用于 Web 端 keydown 监听（有焦点时模拟全局行为）。
 */
export function matchesGlobalShortcut(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  const needsCtrl = parts.includes("Ctrl");
  const needsAlt = parts.includes("Alt");

  if (needsCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (needsAlt !== e.altKey) return false;

  if (/^F\d+$/.test(key)) return e.key === key;
  if (/^\d$/.test(key)) return e.key === key;
  return e.key.toUpperCase() === key || e.key === key;
}
