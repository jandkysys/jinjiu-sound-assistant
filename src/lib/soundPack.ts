import {
  putAudioBlob,
  deleteAudioBlobs,
  getAudioBlob,
  base64ToBlob,
  blobToBase64,
  estimateAudioStoreBytes,
} from "./audioStore";
import { setPersisted } from "./persist";

export interface SoundItem {
  id: string;
  name: string;
  type: "short" | "bgm" | "pk" | "theme";
  /** First-level category (一级分类), e.g. 短音效 / PK音乐 / 背景音乐. */
  category: string;
  /** Optional second-level sub-category (二级分类) under `category`. */
  subCategory?: string;
  /** Legacy first-class scene axis. Kept optional so old data / packs parse. */
  sceneCategory?: string;
  volume: number;
  loop: boolean;
  shortcut?: string;
  /**
   * 全局快捷键绑定（复合键格式，如 "F1" / "Ctrl+1" / "Alt+2"）。
   * 与 `shortcut`（单字符字母键）独立存在；这组快捷键同时支持修饰键，
   * 适合在窗口处于前台时用 F 键 / Ctrl+N / Alt+N 触发音效，
   * 并预留给 Electron 版本的 globalShortcut 后台监听功能。
   */
  globalShortcut?: string;
  /** True when an audio blob for this id is stored in IndexedDB. */
  hasAudio?: boolean;
  /**
   * 收藏状态：被收藏的音效从原来的主播音效/背景音乐列表中隐藏，
   * 仅显示在收藏页面。取消收藏后恢复到原分类。
   */
  /** Original pool of a favorited sound (used to restore on unfavorite). */
  favoritePool?: "main" | "bg" | "mine";
  /** Original first-level category when favorited. */
  favoriteCategory?: string;
  /** Original sub-category when favorited. */
  favoriteSubCategory?: string;
  /** Timestamp (ms) when this sound was favorited. */
  favoriteAt?: number;
  /**
   * Legacy field. Older versions stored a `blob:` URL here; those are invalid
   * after a refresh anyway. New code should rely on `hasAudio` + IndexedDB.
   * Kept optional so existing JSON in localStorage still parses.
   */
  url?: string;
  playing?: boolean;
  favorite?: boolean;
  /**
   * True when this sound belongs to the personal「我的」board — a third pool,
   * orthogonal to `type`, that can hold either short effects or looping BGM.
   */
  mine?: boolean;
  /**
   * Manual ordering position among favorited sounds (lower = earlier in the
   * teleprompter sound bar). Only meaningful when `favorite === true`. When
   * absent, falls back to the legacy "shortcut first" ordering.
   */
  favoriteOrder?: number;
  /**
   * Timestamp (ms since epoch) of the last time this sound was triggered.
   * Powers the virtual "最近使用" category. Absent until first played.
   */
  lastPlayedAt?: number;
  /**
   * Cumulative number of times this sound has been triggered (playback count).
   * Powers the "频率" sort order in the favorites tab.
   */
  playCount?: number;
  /** Optional custom background color for the bound keyboard key. */
  color?: string;
  /** Clip start in seconds (inclusive). When set, playback seeks here. */
  clipStart?: number;
  /** Clip end in seconds (exclusive). When set, playback stops at this offset. */
  clipEnd?: number;
  /** Fade-in duration in seconds (0 = hard cut). Applied from clipStart. */
  fadeIn?: number;
  /** Fade-out duration in seconds (0 = hard cut). Applied before clipEnd. */
  fadeOut?: number;
  /**
   * Numeric ID of the corresponding row in the cloud_sounds DB table.
   * Present only on sounds imported from the cloud library.
   */
  cloudId?: number;
  /**
   * Origin marker. "cloud" means this sound was imported from the cloud library.
   */
  source?: "cloud";
  /**
   * Persistent CDN URL for cloud-sourced sounds. Fallback when hasAudio is false.
   */
  cloudUrl?: string;
  /** SHA-256 hash of the cloud audio file. Used to detect stale local caches. */
  cloudHash?: string;
  /** File size in bytes from the cloud manifest. */
  cloudFileSize?: number;
  /** Duration in seconds from the cloud manifest. */
  cloudDuration?: number;
  /** True when the cloud admin has disabled this sound (hide from UI). */
  isCloudDisabled?: boolean;
}

export interface ExportedSound {
  id: string;
  name: string;
  type: SoundItem["type"];
  category: string;
  subCategory?: string;
  sceneCategory?: string;
  volume: number;
  loop: boolean;
  shortcut?: string;
  globalShortcut?: string;
  favorite?: boolean;
  favoriteOrder?: number;
  favoritePool?: "main" | "bg" | "mine";
  favoriteCategory?: string;
  favoriteSubCategory?: string;
  favoriteAt?: number;
  mine?: boolean;
  color?: string;
  clipStart?: number;
  clipEnd?: number;
  fadeIn?: number;
  fadeOut?: number;
  audioBase64?: string;
  audioMime?: string;
}

export interface SoundPack {
  format: "jincibao-sound-pack";
  version: 1;
  exportedAt: string;
  sounds: ExportedSound[];
}

export type ConflictStrategy = "replace" | "skip" | "keepboth";

function uid() { return Math.random().toString(36).slice(2); }

/**
 * Resolve the second-level sub-category for an incoming (possibly legacy) sound.
 * The old "场景分类" axis (`sceneCategory`) is gone; carry its value over to the
 * new optional `subCategory` when it adds information (differs from `category`).
 */
function subCatFromLegacy(inc: Pick<ExportedSound, "subCategory" | "sceneCategory" | "category">): string | undefined {
  if (inc.subCategory != null) return inc.subCategory;
  const sc = inc.sceneCategory;
  return sc && sc !== inc.category ? sc : undefined;
}

export interface BuildResult {
  pack: SoundPack;
  failedAudio: { id: string; name: string }[];
}

export interface BuildProgress {
  /** How many sounds have been processed (including metadata-only ones). */
  done: number;
  /** Total sounds to process. */
  total: number;
}

/**
 * Thrown by `buildSoundPack` when the supplied `AbortSignal` is aborted mid-way.
 * Callers can detect it (via `isBuildAborted`) to silently discard the partial
 * result instead of surfacing an error toast.
 */
export class BuildAbortedError extends Error {
  constructor() {
    super("导出已取消");
    this.name = "BuildAbortedError";
  }
}

export function isBuildAborted(e: unknown): boolean {
  return e instanceof BuildAbortedError;
}

/**
 * Thrown by `commitMergePlan` when the supplied `AbortSignal` is aborted mid
 * import. The blob loop stops at the next item boundary, so some audio may have
 * already been written to IndexedDB. Callers MUST detect this (via
 * `isImportAborted`) and roll back: restore the pre-import metadata and prune
 * the partially-written blobs so audio storage stays consistent.
 */
export class ImportAbortedError extends Error {
  constructor() {
    super("导入已取消");
    this.name = "ImportAbortedError";
  }
}

export function isImportAborted(e: unknown): boolean {
  return e instanceof ImportAbortedError;
}

/**
 * Build an exportable sound pack from in-memory sounds. Each sound's audio is
 * read from IndexedDB and base64-encoded one at a time; after each item the
 * loop yields back to the event loop so the UI stays responsive even for large
 * libraries (tens of MB). `onProgress` fires after each sound (and once up-front)
 * so callers can render a progress bar.
 *
 * Pass an `AbortSignal` to allow mid-export cancellation: when it aborts, the
 * loop stops at the next item boundary and throws `BuildAbortedError`, so the
 * already-encoded intermediate audio is discarded and no file is produced.
 */
export async function buildSoundPack(
  sounds: SoundItem[],
  onProgress?: (p: BuildProgress) => void,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const out: ExportedSound[] = [];
  const failedAudio: { id: string; name: string }[] = [];
  const total = sounds.length;
  let done = 0;
  if (signal?.aborted) throw new BuildAbortedError();
  onProgress?.({ done, total });
  for (const s of sounds) {
    if (signal?.aborted) throw new BuildAbortedError();
    const exp: ExportedSound = {
      id: s.id,
      name: s.name,
      type: s.type,
      category: s.category,
      subCategory: s.subCategory,
      sceneCategory: s.sceneCategory,
      volume: s.volume,
      loop: s.loop,
      shortcut: s.shortcut,
      globalShortcut: s.globalShortcut,
      favorite: s.favorite,
      favoriteOrder: s.favoriteOrder,
      mine: s.mine,
      color: s.color,
      clipStart: s.clipStart,
      clipEnd: s.clipEnd,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
    };
    if (s.hasAudio) {
      const blob = await getAudioBlob(s.id);
      if (blob) {
        const enc = await blobToBase64(blob);
        exp.audioBase64 = enc.base64;
        exp.audioMime = enc.mime;
      } else {
        failedAudio.push({ id: s.id, name: s.name });
      }
    } else if (s.url) {
      // Legacy: only a transient `blob:` URL was ever stored, with no IndexedDB
      // backup. These are guaranteed dead after a refresh and the export would
      // be metadata-only too — flag them so the UI can offer skip/include.
      failedAudio.push({ id: s.id, name: s.name });
    }
    out.push(exp);
    done++;
    onProgress?.({ done, total });
    // Yield to the event loop so a large library doesn't freeze the UI.
    await Promise.resolve();
  }
  return {
    pack: {
      format: "jincibao-sound-pack",
      version: 1,
      exportedAt: new Date().toISOString(),
      sounds: out,
    },
    failedAudio,
  };
}

/**
 * Legacy one-shot exporter kept for callers (e.g. Settings page) that just
 * want a "download everything, prompt on failure" flow. Newer code should
 * prefer `buildSoundPack` + `downloadSoundPack` so it can render its own UI.
 */
export async function exportSoundPack(
  sounds: SoundItem[],
  onProgress?: (p: BuildProgress) => void,
): Promise<{ failedAudio: { name: string }[] }> {
  const { pack, failedAudio } = await buildSoundPack(sounds, onProgress);
  if (failedAudio.length > 0) {
    const names = failedAudio.slice(0, 5).map(f => f.name).join("、");
    const more = failedAudio.length > 5 ? `…等 ${failedAudio.length} 条` : "";
    const ok = confirm(
      `以下 ${failedAudio.length} 条音效的音频文件无法读取（可能是旧版本残留的失效引用），将以「仅元数据」方式导出：\n\n${names}${more}\n\n确定继续导出吗？`
    );
    if (!ok) return { failedAudio };
  }
  downloadSoundPack(pack);
  return { failedAudio };
}

export function downloadSoundPack(pack: SoundPack): void {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `jincibao_sounds_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Return a new pack with all sounds whose ids appear in `dropIds` removed. */
export function packWithoutSounds(pack: SoundPack, dropIds: Set<string>): SoundPack {
  return { ...pack, sounds: pack.sounds.filter(s => !dropIds.has(s.id)) };
}

export interface ImportResult {
  added: number;
  replaced: number;
  skipped: number;
  total: number;
}

// 音效元数据现已随话术/题词器一起搬到 IndexedDB（见 persist.ts），不再受
// 浏览器 localStorage ~5 MB 配额限制。此处仅保留尺寸估算用于「占用」展示。

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function byteLengthOfString(s: string): number {
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  } catch {}
  try { return new Blob([s]).size; } catch {}
  return s.length;
}

/** Strip transient fields (blob URLs, playing flag) before persisting. */
function sanitizeForPersist(sounds: SoundItem[]): SoundItem[] {
  return sounds.map(s => {
    const { url, playing, ...rest } = s;
    void url; void playing;
    return rest as SoundItem;
  });
}

export function estimateSoundsStorageBytes(sounds: SoundItem[]): number {
  try {
    return byteLengthOfString(JSON.stringify(sanitizeForPersist(sounds)));
  } catch {
    return 0;
  }
}

export function estimatePackPayloadBytes(pack: SoundPack): number {
  let total = 0;
  for (const s of pack.sounds) {
    if (s.audioBase64) {
      total += Math.floor((s.audioBase64.length * 3) / 4);
    }
  }
  return total;
}

export { estimateAudioStoreBytes };

export type SafeSaveResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: "quota" | "unknown"; error: unknown; bytes: number };

/**
 * BroadcastChannel for cross-window sound sync.
 * When sounds are saved in one window (e.g. mainWindow), other windows
 * (e.g. the hidden audioWindow) receive the updated array and re-register
 * global shortcuts without needing a page reload.
 */
const _soundsBc: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("jt_sounds_bc")
    : null;

export function safeSaveSounds(sounds: SoundItem[]): SafeSaveResult {
  const sanitized = sanitizeForPersist(sounds);
  let payload = "";
  try { payload = JSON.stringify(sanitized); } catch (e) {
    return { ok: false, reason: "unknown", error: e, bytes: 0 };
  }
  const bytes = byteLengthOfString(payload);
  try {
    // Persisted to IndexedDB (synchronous cache update + debounced async write),
    // so we no longer hit the localStorage ~5 MB quota.
    setPersisted("jt_sounds", payload);
    // Notify other windows (e.g. hidden audioWindow) so they pick up the
    // latest globalShortcut assignments without needing to reload.
    _soundsBc?.postMessage({ type: "sounds", sounds: sanitized });
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, reason: "unknown", error: e, bytes };
  }
}

export async function readSoundPackFile(file: File): Promise<SoundPack> {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || data.format !== "jincibao-sound-pack" || !Array.isArray(data.sounds)) {
    throw new Error("文件格式不正确，不是有效的音效包");
  }
  return data as SoundPack;
}

export function detectConflicts(existing: SoundItem[], pack: SoundPack) {
  const byName = new Map(existing.map(s => [s.name, s]));
  const byShortcut = new Map(existing.filter(s => s.shortcut).map(s => [s.shortcut!.toLowerCase(), s]));
  const conflicts: { incoming: ExportedSound; nameHit?: SoundItem; shortcutHit?: SoundItem }[] = [];
  for (const inc of pack.sounds) {
    const nameHit = byName.get(inc.name);
    const shortcutHit = inc.shortcut ? byShortcut.get(inc.shortcut.toLowerCase()) : undefined;
    if (nameHit || shortcutHit) conflicts.push({ incoming: inc, nameHit, shortcutHit });
  }
  return conflicts;
}

export interface PendingBlob {
  id: string;
  base64: string;
  mime: string;
}

export interface MergePlan {
  sounds: SoundItem[];
  result: ImportResult;
  affectedIds: string[];
  /**
   * Pending blob writes. The caller MUST execute these via `commitMergePlan`
   * (or equivalent) AFTER the metadata save (`safeSaveSounds`) succeeds.
   * Mergers themselves do not touch IndexedDB so a cancelled/failed import
   * leaves audio storage untouched.
   *
   * The audio is kept as the original base64 string here and only decoded to a
   * Blob at commit time, one item at a time. This keeps `mergeSoundPack` cheap
   * even for large packs (no up-front decode of every file) so the UI does not
   * freeze, and lets `commitMergePlan` report per-item progress.
   */
  pendingBlobs: PendingBlob[];
}

/** Approximate decoded byte size of all pending audio in a merge plan. */
export function mergePlanPayloadBytes(plan: MergePlan): number {
  let total = 0;
  for (const w of plan.pendingBlobs) {
    total += Math.floor((w.base64.length * 3) / 4);
  }
  return total;
}

/**
 * Build a merge plan for importing `pack` into `existing`. PURE: does not
 * touch IndexedDB and does NOT decode audio binaries. The incoming base64 is
 * carried through in `pendingBlobs`; the caller commits (and decodes) them via
 * `commitMergePlan` only after a successful metadata save (`safeSaveSounds`).
 */
export function mergeSoundPack(
  existing: SoundItem[],
  pack: SoundPack,
  strategy: ConflictStrategy
): MergePlan {
  let added = 0, replaced = 0, skipped = 0;
  let next = [...existing];
  const affectedIds: string[] = [];
  const blobWrites: PendingBlob[] = [];

  for (const inc of pack.sounds) {
    const hasIncAudio = !!inc.audioBase64;
    const incMime = inc.audioMime || "audio/mpeg";
    const incShortcut = inc.shortcut?.toLowerCase();
    const nameHit = next.find(s => s.name === inc.name);
    const shortcutHit = incShortcut ? next.find(s => s.shortcut?.toLowerCase() === incShortcut) : undefined;
    const hasConflict = !!nameHit || !!shortcutHit;

    if (hasConflict && strategy === "skip") {
      skipped++;
      continue;
    }

    if (hasConflict && strategy === "replace") {
      const target = nameHit ?? shortcutHit!;
      affectedIds.push(target.id);
      next = next.map(s => {
        if (s.id !== target.id) {
          if (incShortcut && s.shortcut?.toLowerCase() === incShortcut) {
            return { ...s, shortcut: undefined };
          }
          return s;
        }
        return {
          ...s,
          name: inc.name,
          type: inc.type,
          category: inc.category,
          subCategory: subCatFromLegacy(inc),
          sceneCategory: inc.sceneCategory,
          volume: inc.volume,
          loop: inc.loop,
          shortcut: incShortcut,
          globalShortcut: inc.globalShortcut ?? s.globalShortcut,
          favorite: inc.favorite ?? s.favorite,
          favoriteOrder: inc.favoriteOrder ?? s.favoriteOrder,
          mine: inc.mine ?? s.mine,
          hasAudio: hasIncAudio ? true : s.hasAudio,
          url: undefined,
          clipStart: inc.clipStart ?? s.clipStart,
          clipEnd: inc.clipEnd ?? s.clipEnd,
          fadeIn: inc.fadeIn ?? s.fadeIn,
          fadeOut: inc.fadeOut ?? s.fadeOut,
        };
      });
      if (hasIncAudio) blobWrites.push({ id: target.id, base64: inc.audioBase64!, mime: incMime });
      replaced++;
      continue;
    }

    // keepboth OR no conflict
    let finalName = inc.name;
    let finalShortcut = incShortcut;
    if (hasConflict && strategy === "keepboth") {
      if (nameHit) {
        let n = 2;
        while (next.some(s => s.name === `${inc.name} (${n})`)) n++;
        finalName = `${inc.name} (${n})`;
      }
      if (shortcutHit) finalShortcut = undefined;
    } else if (incShortcut && next.some(s => s.shortcut?.toLowerCase() === incShortcut)) {
      next = next.map(s => (s.shortcut?.toLowerCase() === incShortcut ? { ...s, shortcut: undefined } : s));
    }

    const newId = uid();
    next.push({
      id: newId,
      name: finalName,
      type: inc.type,
      category: inc.category,
      subCategory: subCatFromLegacy(inc),
      sceneCategory: inc.sceneCategory,
      volume: inc.volume,
      loop: inc.loop,
      shortcut: finalShortcut,
      globalShortcut: inc.globalShortcut,
      favorite: inc.favorite,
      favoriteOrder: inc.favoriteOrder,
      mine: inc.mine,
      hasAudio: hasIncAudio,
      clipStart: inc.clipStart,
      clipEnd: inc.clipEnd,
      fadeIn: inc.fadeIn,
      fadeOut: inc.fadeOut,
    });
    if (hasIncAudio) blobWrites.push({ id: newId, base64: inc.audioBase64!, mime: incMime });
    added++;
  }

  return {
    sounds: next,
    result: { added, replaced, skipped, total: pack.sounds.length },
    affectedIds,
    pendingBlobs: blobWrites,
  };
}

export interface CommitProgress {
  /** How many audio files have been written (including failures). */
  done: number;
  /** Total audio files to write. */
  total: number;
}

/**
 * Commit the pending blob writes from a `MergePlan` into IndexedDB. Call this
 * only AFTER metadata has been successfully persisted. Failures are non-fatal —
 * the metadata stays merged, only playback would be unavailable for those ids.
 *
 * Audio is decoded one file at a time and written sequentially; each IndexedDB
 * transaction yields back to the event loop, so the UI stays responsive even
 * for large packs. `onProgress` fires after each file (and once up-front) so
 * callers can render a progress bar.
 *
 * Pass an `AbortSignal` to allow mid-import cancellation: when it aborts, the
 * loop stops at the next item boundary and throws `ImportAbortedError`. Some
 * blobs may already be written, so the caller MUST roll back (restore the
 * pre-import metadata + prune the partial blobs) on `isImportAborted`.
 */
export async function commitMergePlan(
  plan: MergePlan,
  onProgress?: (p: CommitProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = plan.pendingBlobs.length;
  let done = 0;
  if (signal?.aborted) throw new ImportAbortedError();
  onProgress?.({ done, total });
  for (const w of plan.pendingBlobs) {
    if (signal?.aborted) throw new ImportAbortedError();
    try {
      const blob = base64ToBlob(w.base64, w.mime);
      await putAudioBlob(w.id, blob);
    } catch {}
    done++;
    onProgress?.({ done, total });
  }
}

/** Remove audio blobs for sounds that are no longer present in `next`. */
export async function pruneAudioBlobsForRemoved(
  prev: SoundItem[],
  next: SoundItem[],
): Promise<void> {
  const nextIds = new Set(next.map(s => s.id));
  const dropped: string[] = [];
  for (const s of prev) {
    if (s.hasAudio && !nextIds.has(s.id)) dropped.push(s.id);
  }
  if (dropped.length > 0) {
    try { await deleteAudioBlobs(dropped); } catch {}
  }
}
