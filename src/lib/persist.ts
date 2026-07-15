// Unified, IndexedDB-backed persistence for the large/growing payloads that
// would otherwise risk hitting the browser's ~5MB localStorage quota
// (话术 jt_scripts、题词器三屏布局 jt_screens_v2).
//
// Design goals:
// - Synchronous reads (`getPersisted`) so existing useState initializers keep
//   working unchanged. This is satisfied by hydrating an in-memory cache from
//   IndexedDB once, before the app renders (see `bootstrapPersist`).
// - Async, debounced writes to IndexedDB so we shed the localStorage size cap.
// - Transparent migration: existing localStorage data is copied into IndexedDB
//   on first boot, then removed from localStorage to reclaim quota. Old users
//   keep their data without noticing.

const DB_NAME = "jt_kv";
const DB_VERSION = 1;
const STORE = "kv";

// Keys this layer owns. Two groups:
// - Large/growing content payloads that most need IndexedDB's larger quota
//   (话术、题词器布局、音效库等).
// - Small but important sound-engine playback params that previously lived in
//   raw localStorage and were lost on cache-clear / device change (总音量、闪避
//   开关/压低系数/恢复时长、输出设备).
export const PERSIST_KEYS = [
  "jt_scripts",
  "jt_full_scripts",
  "jt_screens_v2",
  "jt_prompt_texts",
  "jt_prompt_scroll",
  "jt_bg_swatches",
  "jt_font_swatches",
  "jt_sounds",
  "jt_master_vol",
  "jt_duck_enabled",
  "jt_duck_factor",
  "jt_duck_fade",
  "jt_audio_sink",
  // Small but durable preferences that previously lived in raw localStorage:
  // 控制中心设置 (legacy)、音效助手偏好、音效一级分类列表（主播/背景/旧合并）.
  "jt_settings",
  "jt_sound_settings",
  "jt_sound_cats",
  "jt_sound_main_cats",
  "jt_sound_bg_cats",
  "jt_sound_mine_cats",
  // 功能快捷键绑定：{ actionId: 组合键字符串 }，如 { sfxStop: "ctrl+1" }.
  "jt_sound_func_shortcuts",
  // 音效空子分类注册表（右键「添加分类」在场景分类下新建的空子文件夹）：{ 父分类名: 子分类名[] }.
  "jt_sound_sub_cats",
  // 语音识别（ASR）偏好：识别语言等，题词器实时读取.
  "jt_asr",
  // 互动话术分组标签注册表（右键菜单「移动到分组」）.
  "jt_script_groups",
  // 背景音乐播放模式（单曲/列表/随机循环）.
  "jt_bgm_mode",
  // 主播音效「循环播放」开关.
  "jt_host_loop",
  // 分类快捷键映射（按键随机播放该分类音效）.
  "jt_cat_shortcuts",
  // 互动话术：每项「收起/打开快捷栏」折叠状态（场景/分类/话术 id 集合）.
  "jt_script_collapsed",
  // 互动话术：从题词屏隐藏的项 id 集合（取消题词屏快捷显示）.
  "jt_hidden_scripts",
  // 题词屏「整」按钮锚点：最近从整场台词面板导入到主屏的整场话术原文（单击始终回到它）.
  "jt_full_anchor_main",
  // 题词屏「整」按钮记忆点：整场话术上次读到/停下的位置（readPos + 主屏滚动量）.
  "jt_full_anchor_pos_main",
  // 题词屏「念完续接」：当前主屏整场台词段的 id，用于刷新后定位下一段.
  "jt_full_anchor_id_main",
  // 题词屏「整场去重」：本场已通过快捷键显示过的话术内容集合，刷新/切页后仍生效.
  "jt_qk_shown",
  // 题词屏快捷键出词目标屏："auto"=跟随当前模式 / "main"/"bottom"/"float"=指定屏.
  "jt_qk_target",
  // 题词屏快捷键出词方式："replace"=覆盖 / "append"=追加到屏末尾.
  "jt_qk_insert",
  // 音效快捷键模式："register"=注册（覆盖按键默认功能，preventDefault）/"listen"=监听（不覆盖）.
  "jt_shortcut_mode",
] as const;
export type PersistKey = (typeof PERSIST_KEYS)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB 不可用"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
  });
  return dbPromise;
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<string | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return awaitRequest<string | undefined>(tx.objectStore(STORE).get(key));
}

async function idbSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const cache = new Map<string, string>();
let ready = false;

export function isPersistReady(): boolean {
  return ready;
}

// Hydrate the in-memory cache from IndexedDB before the app renders, migrating
// any pre-existing localStorage values into IndexedDB on the way. Safe to call
// multiple times; only the first call does work.
export async function bootstrapPersist(
  keys: readonly string[] = PERSIST_KEYS,
): Promise<void> {
  if (ready) return;
  try {
    for (const key of keys) {
      let val: string | undefined;
      try {
        val = await idbGet(key);
      } catch {
        val = undefined;
      }
      if (val != null) {
        cache.set(key, val);
        continue;
      }
      // Nothing in IndexedDB yet — migrate from localStorage if present.
      let legacy: string | null = null;
      try {
        legacy = localStorage.getItem(key);
      } catch {}
      if (legacy != null) {
        cache.set(key, legacy);
        try {
          await idbSet(key, legacy);
          // Only reclaim the localStorage slot once the IDB write succeeded.
          try {
            localStorage.removeItem(key);
          } catch {}
        } catch {
          // Leave the localStorage copy in place as a fallback.
        }
      }
    }
  } catch {}
  ready = true;
}

// Synchronous read. Returns the cached value (post-bootstrap), falling back to
// localStorage when the cache hasn't been hydrated or the key wasn't migrated.
export function getPersisted(key: string): string | null {
  if (cache.has(key)) return cache.get(key)!;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Synchronous cache update + debounced async IndexedDB write.
export function setPersisted(key: string, value: string): void {
  cache.set(key, value);
  const existing = writeTimers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    writeTimers.delete(key);
    idbSet(key, value).catch(() => {
      // Last-resort fallback so edits aren't lost if IndexedDB is unavailable.
      try {
        localStorage.setItem(key, value);
      } catch {}
    });
  }, 150);
  writeTimers.set(key, t);
}

export function removePersisted(key: string): void {
  cache.delete(key);
  const existing = writeTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    writeTimers.delete(key);
  }
  idbDelete(key).catch(() => {});
  try {
    localStorage.removeItem(key);
  } catch {}
}

// Flush any pending debounced writes immediately. Used on page-hide so a quick
// close after an edit doesn't drop the last change.
//
// Strategy: fire the async IDB write AND also write synchronously to
// localStorage. The IDB write may not complete if the browser kills the page
// immediately (especially on iOS Safari), but localStorage.setItem is
// synchronous and always succeeds before the function returns. On the next
// boot, bootstrapPersist reads IDB first; if IDB is empty (write was cut off),
// it falls back to the localStorage copy and migrates it back to IDB.
export function flushPersist(): void {
  for (const [key, timer] of writeTimers) {
    clearTimeout(timer);
    const value = cache.get(key);
    if (value != null) {
      // Async IDB write (best-effort).
      idbSet(key, value).catch(() => {});
      // Synchronous localStorage backup — survives instant page termination.
      try { localStorage.setItem(key, value); } catch {}
    }
  }
  writeTimers.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
  window.addEventListener("pagehide", () => flushPersist());
}
