import { detectAudioFormat } from "./audioUploadPolicy";

// ─── Electron 文件系统类型声明 ─────────────────────────────────────────────────

declare global {
  interface Window {
    electronFS?: {
      saveAudioFile: (
        id: string,
        buffer: ArrayBuffer,
        ext: string
      ) => Promise<{ ok: boolean; url?: string; error?: string }>;
      getAudioUrl: (id: string, ext: string) => Promise<string | null>;
      deleteAudioFiles: (ids: Array<{ id: string; ext: string }>) => Promise<void>;
      hasAudioFile: (id: string, ext: string) => Promise<boolean>;
      listAudioFiles: () => Promise<Array<{ id: string; ext: string; size: number }>>;
      readAudioFile: (id: string, ext: string) => Promise<ArrayBuffer | null>;
    };
  }
}

// ─── MIME / 扩展名映射 ─────────────────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  webm: "audio/webm",
  weba: "audio/webm",
  wma: "audio/x-ms-wma",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  aifc: "audio/aiff",
  amr: "audio/amr",
  mp4: "video/mp4",
  bin: "application/octet-stream",
};

// ─── Electron 扩展名本地缓存（localStorage） ───────────────────────────────────

const EXT_KEY_PREFIX = "jt_audio_ext_";

function getStoredExt(id: string): string {
  try { return localStorage.getItem(EXT_KEY_PREFIX + id) ?? "mp3"; }
  catch { return "mp3"; }
}

function setStoredExt(id: string, ext: string): void {
  try { localStorage.setItem(EXT_KEY_PREFIX + id, ext); } catch {}
}

function removeStoredExt(id: string): void {
  try { localStorage.removeItem(EXT_KEY_PREFIX + id); } catch {}
}

// ─── 环境检测 ─────────────────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronFS;
}

// ─── IndexedDB 设置（Web 路径） ───────────────────────────────────────────────

const DB_NAME = "jt_audio";
const DB_VERSION = 1;
const STORE = "blobs";

interface StoredAudio {
  blob: Blob;
  mime: string;
  size: number;
  updatedAt: number;
}

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

// ─── URL 缓存 ─────────────────────────────────────────────────────────────────

// Electron 下缓存 file:// URL；Web 下缓存 blob: URL
const urlCache: Map<string, string> = new Map();

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 保存音频 Blob。
 * - Electron：写入 userData/jt_sounds/{id}.{ext}
 * - Web：写入 IndexedDB
 */
export async function putAudioBlob(id: string, blob: Blob, mime?: string, sourceName = ""): Promise<void> {
  const sourceBlob = mime && mime !== blob.type ? blob.slice(0, blob.size, mime) : blob;
  const format = await detectAudioFormat(sourceBlob, sourceName);
  const storedBlob = blob.slice(0, blob.size, format.mime);

  if (isElectron()) {
    const ext = format.ext || "bin";
    setStoredExt(id, ext);
    const buffer = await storedBlob.arrayBuffer();
    const result = await window.electronFS!.saveAudioFile(id, buffer, ext);
    if (!result.ok) throw new Error(result.error ?? "保存音频文件失败");
    urlCache.delete(id);
    return;
  }

  const db = await openDb();
  const value: StoredAudio = {
    blob: storedBlob,
    mime: format.mime,
    size: storedBlob.size,
    updatedAt: Date.now(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const cached = urlCache.get(id);
  if (cached) {
    try { URL.revokeObjectURL(cached); } catch {}
    urlCache.delete(id);
  }
}

/**
 * 读取音频 Blob（供导出/打包使用）。
 * - Electron：从本地文件读取并重建 Blob
 * - Web：从 IndexedDB 读取
 */
export async function getAudioBlob(id: string): Promise<Blob | null> {
  if (isElectron()) {
    const ext = getStoredExt(id);
    const buffer = await window.electronFS!.readAudioFile(id, ext);
    if (!buffer) return null;
    const mime = EXT_TO_MIME[ext] ?? "application/octet-stream";
    return new Blob([buffer], { type: mime });
  }

  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const v = await awaitRequest<StoredAudio | undefined>(tx.objectStore(STORE).get(id));
    return v ? v.blob : null;
  } catch {
    return null;
  }
}

/**
 * 获取音频播放 URL。
 * - Electron：返回 file:// URL（stable，不需要 revoke）
 * - Web：返回 blob: URL（缓存，避免重复 createObjectURL）
 */
export async function getAudioObjectUrl(id: string): Promise<string | null> {
  if (isElectron()) {
    const cached = urlCache.get(id);
    if (cached) return cached;
    const ext = getStoredExt(id);
    const url = await window.electronFS!.getAudioUrl(id, ext);
    if (url) urlCache.set(id, url);
    return url;
  }

  const cached = urlCache.get(id);
  if (cached) return cached;
  const blob = await getAudioBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

/**
 * 释放 blob: URL（仅 Web 有效；Electron file:// URL 不需要释放）
 */
export function revokeAudioObjectUrl(id: string): void {
  const cached = urlCache.get(id);
  if (cached) {
    if (!cached.startsWith("file://")) {
      try { URL.revokeObjectURL(cached); } catch {}
    }
    urlCache.delete(id);
  }
}

export async function deleteAudioBlob(id: string): Promise<void> {
  return deleteAudioBlobs([id]);
}

export async function deleteAudioBlobs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  if (isElectron()) {
    const toDelete = ids.map(id => ({ id, ext: getStoredExt(id) }));
    await window.electronFS!.deleteAudioFiles(toDelete);
    for (const id of ids) {
      urlCache.delete(id);
      removeStoredExt(id);
    }
    return;
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {}
  for (const id of ids) revokeAudioObjectUrl(id);
}

export async function listAudioIds(): Promise<string[]> {
  if (isElectron()) {
    const files = await window.electronFS!.listAudioFiles();
    return files.map(f => f.id);
  }

  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const keys = await awaitRequest<IDBValidKey[]>(tx.objectStore(STORE).getAllKeys());
    return keys.map(k => String(k));
  } catch {
    return [];
  }
}

export async function hasAudioBlob(id: string): Promise<boolean> {
  if (isElectron()) {
    const ext = getStoredExt(id);
    return window.electronFS!.hasAudioFile(id, ext);
  }

  const blob = await getAudioBlob(id);
  return !!blob;
}

export async function estimateAudioStoreBytes(): Promise<{ bytes: number; count: number }> {
  if (isElectron()) {
    const files = await window.electronFS!.listAudioFiles();
    const bytes = files.reduce((s, f) => s + (f.size ?? 0), 0);
    return { bytes, count: files.length };
  }

  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const all = await awaitRequest<StoredAudio[]>(tx.objectStore(STORE).getAll());
    let bytes = 0;
    for (const v of all) bytes += v?.size ?? v?.blob?.size ?? 0;
    return { bytes, count: all.length };
  } catch {
    return { bytes: 0, count: 0 };
  }
}

// ─── 工具函数（与环境无关）───────────────────────────────────────────────────

export function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

export async function blobToBase64(blob: Blob): Promise<{ base64: string; mime: string }> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return { base64: btoa(bin), mime: blob.type || "application/octet-stream" };
}
