/**
 * Cloud sound library sync — manifest-based lazy-load architecture.
 *
 * Two-level category support:
 *   manifest.primaryCategoryName → SoundItem.category  (一级分类)
 *   manifest.subCategoryName     → SoundItem.subCategory (二级分类)
 *
 * After each sync, local category lists (jt_sound_main_cats, jt_sound_bg_cats,
 * jt_sound_sub_cats) are automatically updated to include any new cloud categories.
 */
import { getPersisted, setPersisted } from "./persist";
import { putAudioBlob, deleteAudioBlobs, estimateAudioStoreBytes } from "./audioStore";
import { safeSaveSounds } from "./soundPack";
import type { SoundItem } from "./soundPack";

import { getApiBase } from "./apiConfig";

/**
 * Electron 环境：通过主进程 IPC 代理 GET 请求（绕过 file:// CORS + 使用运行时配置的服务器地址）
 * Web 环境：直接 fetch。
 */
async function cloudApiFetch(path: string): Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}> {
  const electronAPI =
    typeof window !== "undefined" ? window.electronAPI : undefined;
  if (electronAPI?.apiFetch) {
    // Electron 环境：通过主进程 IPC 代理，由 net.request 发出（绕过 file:// CORS）
    const result = await electronAPI.apiFetch(path, { method: "GET", headers: {}, body: null });
    const data = result.data;
    // 提取 IPC 层错误信息（如 "网络连接失败：xxx"）
    const ipcError = !result.ok
      ? ((data as { error?: string })?.error ?? `HTTP ${result.status}`)
      : null;
    if (!result.ok) {
      console.warn("[cloudSync] IPC 请求失败", path, "→", ipcError, "status:", result.status);
    }
    return {
      ok: result.ok,
      status: result.status,
      json: async () => data as unknown,
      text: async () => ipcError ?? (typeof data === "string" ? data : JSON.stringify(data)),
    };
  }
  // Web 环境：直接 fetch，API base 由 initApiConfig / setRuntimeApiBase 决定
  const base = getApiBase();
  const fullUrl = base ? `${base}${path}` : path;
  console.log("[cloudSync] web fetch →", fullUrl);
  return fetch(fullUrl);
}

/** 上次 checkCloudVersion 失败时的错误详情（供 UI 展示诊断） */
let _lastCloudError: string | null = null;
export function getLastCloudError(): string | null { return _lastCloudError; }

/** 上次 checkCloudVersion 的接口返回状态码（0 = 未请求或网络层异常） */
let _lastCloudStatus: number = 0;
export function getLastCloudStatus(): number { return _lastCloudStatus; }

/**
 * 下载单个音频文件为 Blob。
 *
 * Electron 环境：URL 可能是相对路径（/api/storage/objects/...），
 * 渲染进程的 fetch 在 file:// 上下文无法正确解析相对路径，且跨域 fetch 受 CORS 限制。
 * 因此走 apiFetchBuffer IPC 通道，由主进程用 net.request 发出请求，
 * 以 base64 字符串返回二进制数据后在渲染进程还原为 Blob。
 *
 * Web 环境：直接 fetch，同源不存在 CORS 问题。
 */
async function fetchAudioBlob(url: string): Promise<Blob | null> {
  const electronAPI =
    typeof window !== "undefined" ? window.electronAPI : undefined;
  if (electronAPI?.apiFetchBuffer) {
    const result = await electronAPI.apiFetchBuffer(url, {});
    if (!result.ok || !result.base64) return null;
    const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
    const mime = result.contentType?.split(";")[0].trim() || "audio/mpeg";
    return new Blob([bytes], { type: mime });
  }
  // Web 路径：同源 fetch，相对 URL 可正常解析
  const resp = await fetch(url);
  return resp.ok ? resp.blob() : null;
}

export const CLOUD_VERSION_KEY  = "jt_cloud_version";
export const CLOUD_SYNC_TIME_KEY = "jt_cloud_sync_time";
export const CLOUD_PRE_SYNC_KEY  = "jt_pre_sync_snapshot";
export const CLOUD_APP = "sound_assistant" as const;

const CATS_MAIN_KEY = "jt_sound_main_cats";
const CATS_BG_KEY   = "jt_sound_bg_cats";
const CATS_SUB_KEY  = "jt_sound_sub_cats";

// ─── Public types ──────────────────────────────────────────────────────────────

export interface CloudVersionInfo {
  version: number;
  publishedAt: string | null;
  storedVersion: number;
  hasUpdate: boolean;
}

export type SyncScope =
  | { type: "all" }
  | { type: "primaryCat"; name: string }
  | { type: "subCat"; primaryName: string; subName: string };

export type SyncMode =
  | "merge"
  | "addOnly"
  | "overwrite"
  | "skip";

export interface SubCategory {
  id: number | null;
  name: string;
  soundCount: number;
}

export interface PrimaryCategory {
  id: number | null;
  name: string;
  directSoundCount: number;
  totalSoundCount: number;
  subcategories: SubCategory[];
}

export interface CategoryTree {
  primaryCategories: PrimaryCategory[];
}

export type SyncStrategy = "cloud_only" | "mixed" | "local_only";

export interface SyncProgress {
  phase: "fetching" | "downloading" | "merging" | "done";
  done: number;
  total: number;
  currentName?: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  disabled: number;
  skipped: number;
  version: number;
  localVersion: number;
  cacheBytes: number;
  newPrimaryCats: string[];
  newSubCats: Array<{ primary: string; sub: string }>;
}

// ─── Internal types ────────────────────────────────────────────────────────────

/**
 * New manifest format: categories are a flat list with parentId/level.
 * level 1 = primary (一级分类), level 2 = sub (二级分类, parentId → level-1 id).
 */
interface ManifestCategory {
  id: number;
  name: string;
  parentId: number | null;
  level: number;
  platform: string;
  appScope: string;
  sortOrder: number;
  isEnabled: boolean;
  isSystem?: boolean;
}

/**
 * New manifest sound: references category via categoryId, no inline name fields.
 * volume field replaces old defaultVolume.
 */
interface ManifestSound {
  id: number;
  name: string;
  categoryId: number | null;
  cdnUrl: string;
  hash: string | null;
  fileSize: number | null;
  duration: number | null;
  volume: number;
  loop: boolean;
  shortcut: string | null;
  platform: string;
  appScope: string;
  isEnabled: boolean;
  updatedAt: string;
}

interface Manifest {
  version: number;
  publishedAt: string | null;
  app: string;
  generatedAt: string;
  categories: ManifestCategory[];
  sounds: ManifestSound[];
}

/**
 * Resolved sound — ManifestSound enriched with de-normalised category names
 * so the rest of the sync logic can remain unchanged.
 */
interface ResolvedManifestSound extends ManifestSound {
  primaryCategoryName: string;
  subCategoryName: string | null;
}

// ─── Version helpers ───────────────────────────────────────────────────────────

export async function checkCloudVersion(): Promise<CloudVersionInfo | null> {
  _lastCloudError = null;
  _lastCloudStatus = 0;
  // 用轻量版本接口做连通性检查（避免拉取完整 manifest 影响速度）
  const endpoint = `/api/cloud/library-version?app=${CLOUD_APP}`;
  try {
    const resp = await cloudApiFetch(endpoint);
    _lastCloudStatus = resp.status;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      _lastCloudError = `连接失败 (${resp.status})：${errText}`;
      console.warn("[cloudSync] checkCloudVersion 失败", endpoint, "→", _lastCloudError);
      return null;
    }
    const info = (await resp.json()) as { version: number; publishedAt: string | null };
    const storedVersion = getStoredCloudVersion();
    console.log("[cloudSync] 云端版本 v" + (info.version ?? 0) + "，本地 v" + storedVersion);
    return {
      version:     info.version ?? 0,
      publishedAt: info.publishedAt ?? null,
      storedVersion,
      hasUpdate:   (info.version ?? 0) > storedVersion,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    _lastCloudError = `网络错误：${msg}`;
    console.warn("[cloudSync] checkCloudVersion 异常", endpoint, "→", _lastCloudError);
    return null;
  }
}

export function getStoredCloudVersion(): number {
  const raw = getPersisted(CLOUD_VERSION_KEY);
  return raw ? parseInt(raw, 10) : 0;
}

export function saveCloudVersion(version: number): void {
  setPersisted(CLOUD_VERSION_KEY, String(version));
}

export function resetCloudVersion(): void {
  saveCloudVersion(0);
  setPersisted(CLOUD_SYNC_TIME_KEY, "");
}

export function getLastSyncTime(): string | null {
  return getPersisted(CLOUD_SYNC_TIME_KEY) || null;
}

export function saveLastSyncTime(): void {
  setPersisted(CLOUD_SYNC_TIME_KEY, new Date().toISOString());
}

// ─── Snapshot helpers ──────────────────────────────────────────────────────────

export function snapshotPreSync(sounds: SoundItem[]): void {
  try { setPersisted(CLOUD_PRE_SYNC_KEY, JSON.stringify(sounds)); } catch {}
}

export function getPreSyncSnapshot(): SoundItem[] | null {
  try {
    const raw = getPersisted(CLOUD_PRE_SYNC_KEY);
    return raw ? (JSON.parse(raw) as SoundItem[]) : null;
  } catch { return null; }
}

export function clearPreSyncSnapshot(): void {
  setPersisted(CLOUD_PRE_SYNC_KEY, "");
}

// ─── Cache helpers ─────────────────────────────────────────────────────────────

export async function clearCloudAudioCache(sounds: SoundItem[]): Promise<SoundItem[]> {
  const ids = sounds.filter(s => s.source === "cloud").map(s => s.id);
  if (ids.length > 0) await deleteAudioBlobs(ids);
  return sounds.map(s => s.source === "cloud" ? { ...s, hasAudio: false } : s);
}

export async function getCacheStats(): Promise<{ bytes: number; count: number }> {
  return estimateAudioStoreBytes();
}

export async function forceCloudRefresh(sounds: SoundItem[]): Promise<SoundItem[]> {
  const cleared = await clearCloudAudioCache(sounds);
  safeSaveSounds(cleared);
  resetCloudVersion();
  return cleared;
}

// ─── Category tree ─────────────────────────────────────────────────────────────

export async function fetchManifestCategories(): Promise<CategoryTree | null> {
  try {
    const resp = await cloudApiFetch(`/api/cloud/category-tree?app=${CLOUD_APP}`);
    if (!resp.ok) return null;
    return (await resp.json()) as CategoryTree;
  } catch { return null; }
}

// ─── Local category list updater ───────────────────────────────────────────────

function updateLocalCategoryLists(
  newCloudItems: SoundItem[],
): { newPrimaryCats: string[]; newSubCats: Array<{ primary: string; sub: string }> } {
  const newPrimaryCats: string[] = [];
  const newSubCats: Array<{ primary: string; sub: string }> = [];

  try {
    const existingMain: string[] = JSON.parse(getPersisted(CATS_MAIN_KEY) ?? "[]");
    const existingBg:   string[] = JSON.parse(getPersisted(CATS_BG_KEY)   ?? "[]");
    const existingSub: Record<string, string[]> =
      JSON.parse(getPersisted(CATS_SUB_KEY) ?? "{}");

    let mainChanged = false, bgChanged = false, subChanged = false;

    for (const s of newCloudItems) {
      if (s.isCloudDisabled) continue;
      const isBg = s.type === "bgm" || s.loop;
      const primary = s.category;
      const sub = s.subCategory;

      if (isBg) {
        if (primary && !existingBg.includes(primary)) {
          existingBg.push(primary);
          newPrimaryCats.push(primary);
          bgChanged = true;
        }
      } else {
        if (primary && !existingMain.includes(primary)) {
          existingMain.push(primary);
          newPrimaryCats.push(primary);
          mainChanged = true;
        }
      }

      if (sub && primary) {
        const subs = existingSub[primary] ?? [];
        if (!subs.includes(sub)) {
          existingSub[primary] = [...subs, sub];
          newSubCats.push({ primary, sub });
          subChanged = true;
        }
      }
    }

    if (mainChanged) setPersisted(CATS_MAIN_KEY, JSON.stringify(existingMain));
    if (bgChanged)   setPersisted(CATS_BG_KEY,   JSON.stringify(existingBg));
    if (subChanged)  setPersisted(CATS_SUB_KEY,  JSON.stringify(existingSub));
  } catch {}

  return { newPrimaryCats, newSubCats };
}

// ─── Scope helpers ─────────────────────────────────────────────────────────────

function soundMatchesScope(s: SoundItem, scope: SyncScope): boolean {
  if (scope.type === "all") return true;
  if (scope.type === "primaryCat") return s.category === scope.name;
  return s.category === scope.primaryName && s.subCategory === scope.subName;
}

function manifestSoundMatchesScope(ms: ResolvedManifestSound, scope: SyncScope): boolean {
  if (scope.type === "all") return true;
  if (scope.type === "primaryCat") return ms.primaryCategoryName === scope.name;
  return ms.primaryCategoryName === scope.primaryName && ms.subCategoryName === scope.subName;
}

/**
 * Build a categoryId → ResolvedManifestSound resolver from the flat categories list.
 * level 1 → primaryCategoryName; level 2 → subCategoryName (parent is level 1).
 */
function buildCategoryResolver(
  categories: ManifestCategory[],
): (sound: ManifestSound) => ResolvedManifestSound {
  const byId = new Map<number, ManifestCategory>(categories.map(c => [c.id, c]));

  return (sound: ManifestSound): ResolvedManifestSound => {
    if (sound.categoryId == null) {
      return { ...sound, primaryCategoryName: "未分类", subCategoryName: null };
    }
    const cat = byId.get(sound.categoryId);
    if (!cat) {
      return { ...sound, primaryCategoryName: "未分类", subCategoryName: null };
    }
    if (cat.level === 1) {
      return { ...sound, primaryCategoryName: cat.name, subCategoryName: null };
    }
    // level 2: parent is the primary category
    const parent = cat.parentId != null ? byId.get(cat.parentId) : undefined;
    return {
      ...sound,
      primaryCategoryName: parent?.name ?? "未分类",
      subCategoryName: cat.name,
    };
  };
}

function uid(): string {
  return "cloud_" + Math.random().toString(36).slice(2);
}

// ─── Main sync function ────────────────────────────────────────────────────────

export interface SyncOptions {
  strategy?: SyncStrategy;
  syncScope?: SyncScope;
  syncMode?: SyncMode;
  forceRefreshAudio?: boolean;
}

export async function syncCloudLibrary(
  existingSounds: SoundItem[],
  onProgress: (p: SyncProgress) => void,
  options: SyncOptions = {},
): Promise<{ sounds: SoundItem[]; result: SyncResult; version: number }> {
  const {
    strategy       = "cloud_only",
    syncScope      = { type: "all" },
    syncMode       = "merge",
    forceRefreshAudio = false,
  } = options;

  const localVersion = getStoredCloudVersion();

  if (syncMode === "skip") {
    const cache = await estimateAudioStoreBytes();
    onProgress({ phase: "done", done: 0, total: 0 });
    return {
      sounds: existingSounds,
      result: {
        added: 0, updated: 0, removed: 0, disabled: 0, skipped: 0,
        version: localVersion, localVersion, cacheBytes: cache.bytes,
        newPrimaryCats: [], newSubCats: [],
      },
      version: localVersion,
    };
  }

  onProgress({ phase: "fetching", done: 0, total: 0 });

  const resp = await cloudApiFetch(`/api/cloud/manifest?app=${CLOUD_APP}`);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Manifest fetch failed: ${resp.status}${body ? ` — ${body}` : ""}`);
  }
  const manifest = (await resp.json()) as Manifest;
  const version = manifest.version ?? 0;

  // Build category lookup: id → resolved primary/sub names
  const resolveSound = buildCategoryResolver(manifest.categories ?? []);

  // Resolve all manifest sounds to enriched form with primaryCategoryName/subCategoryName
  const allResolvedSounds: ResolvedManifestSound[] = (manifest.sounds ?? []).map(resolveSound);

  if (forceRefreshAudio) {
    const cloudIds = existingSounds.filter(s => s.source === "cloud").map(s => s.id);
    if (cloudIds.length > 0) await deleteAudioBlobs(cloudIds);
  }

  const scopedManifestSounds = allResolvedSounds.filter(ms =>
    manifestSoundMatchesScope(ms, syncScope),
  );
  const scopedManifestIds = new Set(scopedManifestSounds.map(ms => ms.id));
  const allManifestIds = new Set(allResolvedSounds.map(ms => ms.id));

  onProgress({ phase: "merging", done: 0, total: scopedManifestSounds.length });

  const localCloudById = new Map<number, SoundItem>(
    existingSounds.filter(s => s.cloudId != null).map(s => [s.cloudId!, s]),
  );

  let added = 0, updated = 0, removed = 0, disabled = 0, skipped = 0;
  const newCloudItems: SoundItem[] = [];
  const blobsToDelete: string[] = [];

  for (const s of existingSounds) {
    if (s.source === "cloud" && s.cloudId != null && !allManifestIds.has(s.cloudId)) removed++;
  }

  if (syncMode === "overwrite" && scopedManifestSounds.length > 0) {
    for (const s of existingSounds) {
      if (s.source === "cloud" && s.cloudId != null
        && soundMatchesScope(s, syncScope)
        && !scopedManifestIds.has(s.cloudId)) removed++;
    }
  }

  for (let i = 0; i < scopedManifestSounds.length; i++) {
    const ms = scopedManifestSounds[i];
    onProgress({ phase: "merging", done: i, total: scopedManifestSounds.length, currentName: ms.name });

    const existing = localCloudById.get(ms.id);

    if (syncMode === "addOnly" && existing) {
      skipped++;
      newCloudItems.push(existing);
      continue;
    }

    const id = existing?.id ?? uid();
    const hashChanged = ms.hash != null && existing?.cloudHash != null && ms.hash !== existing.cloudHash;
    let hasAudio = existing?.hasAudio ?? false;
    if (forceRefreshAudio || hashChanged) {
      if (hasAudio) { blobsToDelete.push(id); hasAudio = false; }
    }

    const isCloudDisabled = !ms.isEnabled;
    if (isCloudDisabled && existing && !existing.isCloudDisabled) disabled++;

    const item: SoundItem = {
      id,
      cloudId:       ms.id,
      source:        "cloud",
      name:          ms.name,
      type:          ms.loop ? "bgm" : "short",
      category:      ms.primaryCategoryName,
      subCategory:   ms.subCategoryName ?? undefined,
      volume:        ms.volume,
      loop:          ms.loop,
      shortcut:      ms.shortcut ?? undefined,
      hasAudio,
      cloudUrl:      ms.cdnUrl,
      cloudHash:     ms.hash     ?? undefined,
      cloudFileSize: ms.fileSize ?? undefined,
      cloudDuration: ms.duration ?? undefined,
      isCloudDisabled,
      ...(existing && {
        favorite:      existing.favorite,
        favoriteOrder: existing.favoriteOrder,
        color:         existing.color,
        lastPlayedAt:  existing.lastPlayedAt,
        playCount:     existing.playCount,
      }),
    };

    newCloudItems.push(item);
    if (existing && !isCloudDisabled) updated++;
    else if (!existing && !isCloudDisabled) added++;
  }

  if (blobsToDelete.length > 0) await deleteAudioBlobs(blobsToDelete);
  onProgress({ phase: "merging", done: scopedManifestSounds.length, total: scopedManifestSounds.length });

  const localOnly = existingSounds.filter(s => s.source !== "cloud");
  const outOfScopeCloud = existingSounds.filter(s =>
    s.source === "cloud" && !soundMatchesScope(s, syncScope),
  );
  const orphanedCloud = existingSounds.filter(s =>
    s.source === "cloud" && s.cloudId != null &&
    !allManifestIds.has(s.cloudId) && soundMatchesScope(s, syncScope),
  );

  const nextSounds = strategy === "mixed"
    ? [...localOnly, ...outOfScopeCloud, ...orphanedCloud, ...newCloudItems]
    : [...localOnly, ...outOfScopeCloud, ...newCloudItems];

  const { newPrimaryCats, newSubCats } = updateLocalCategoryLists(newCloudItems);

  const cache = await estimateAudioStoreBytes();
  onProgress({ phase: "done", done: scopedManifestSounds.length, total: scopedManifestSounds.length });

  return {
    sounds: nextSounds,
    result: {
      added, updated, removed, disabled, skipped,
      version, localVersion, cacheBytes: cache.bytes,
      newPrimaryCats, newSubCats,
    },
    version,
  };
}

// ─── Pre-download ──────────────────────────────────────────────────────────────

export async function preDownloadSounds(
  sounds: SoundItem[],
  filter: "all" | "favorites",
  onProgress: (done: number, total: number, name: string, failed: number) => void,
): Promise<{ sounds: SoundItem[]; done: number; failed: number }> {
  const candidates = sounds.filter(s => {
    if (s.source !== "cloud" || s.isCloudDisabled || !s.cloudUrl) return false;
    if (s.hasAudio) return false;
    if (filter === "favorites") return !!s.favorite;
    return true;
  });

  const total = candidates.length;
  let done = 0, failed = 0;
  const updatedMap = new Map<string, boolean>();

  for (const s of candidates) {
    onProgress(done, total, s.name, failed);
    try {
      const blob = await fetchAudioBlob(s.cloudUrl!);
      if (blob) {
        await putAudioBlob(s.id, blob);
        updatedMap.set(s.id, true);
        done++;
      } else { failed++; }
    } catch { failed++; }
    onProgress(done, total, s.name, failed);
  }

  return {
    sounds: sounds.map(s => updatedMap.has(s.id) ? { ...s, hasAudio: true } : s),
    done,
    failed,
  };
}

export function markSoundCached(sounds: SoundItem[], id: string): SoundItem[] {
  return sounds.map(s => s.id === id ? { ...s, hasAudio: true } : s);
}
