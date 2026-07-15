import JSZip from "jszip";
import type { SoundItem } from "./soundPack";

// Audio extensions accepted by batch import. Mirrors the list used by the
// single-file uploader so folder / ZIP scans behave consistently.
export const AUDIO_EXTS = [
  "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac",
  "opus", "weba", "webm", "wma", "aiff", "aif", "amr", "mp4",
];

const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/opus",
  weba: "audio/webm", webm: "audio/webm", wma: "audio/x-ms-wma",
  aiff: "audio/aiff", aif: "audio/aiff", amr: "audio/amr", mp4: "audio/mp4",
};

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXTS.includes(extOf(name));
}

function baseName(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const file = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = file.lastIndexOf(".");
  return (dot > 0 ? file.slice(0, dot) : file).trim();
}

// Extract [category, subCategory] from a relative path.
// 3+ levels: "Root/Scene/Sub/file.mp3" → [Scene, Sub]
// 2 levels:  "Scene/file.mp3"          → [Scene, ""]
// 1 level:   "file.mp3"                → [fallback, ""]
function folderParts(relPath: string, fallback: string): [string, string] {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length >= 4) return [parts[parts.length - 3], parts[parts.length - 2]];
  if (parts.length === 3) return [parts[0], parts[1]];
  if (parts.length === 2) return [parts[0], ""];
  return [fallback, ""];
}

// Map a raw folder name to an app category name.
function smartMapCategory(folder: string): string {
  return folder;
}

// Detect whether a sound is likely background music based on folder names.
function isLikelyBgm(cat: string, sub: string): boolean {
  return /\bbgm\b|背景音乐|主旋律|背景BGM|音乐嗨|音乐_|_音乐|要礼物的BGM/i.test(cat + "|" + sub);
}

// Single-character shortcut pool, ordered to match a QWERTY keyboard so
// auto-assigned keys land in a natural place on the on-screen layout.
const SHORTCUT_POOL = "1234567890qwertyuiopasdfghjklzxcvbnm".split("");

export type PlayMode = "once" | "loop";

export interface DraftSound {
  /** Stable temp key for React lists / editing (not the final SoundItem id). */
  key: string;
  name: string;
  category: string;
  /** Optional sub-category (二级分类), derived from folder depth or left empty. */
  subCategory: string;
  shortcut: string;
  mode: PlayMode;
  volume: number;
  /** The raw audio file (or blob synthesized from a ZIP entry). */
  file: File;
  sizeBytes: number;
  /** Original file base name (sans extension) before any user edits. */
  sourceName: string;
  /** Original folder/category name before smartMapCategory normalization. */
  sourceFolder: string;
  /** Original sub-folder name before any user edits (rawSub from folderParts). */
  sourceSubFolder: string;
}

let draftSeq = 0;
function draftKey(): string {
  draftSeq += 1;
  return `d${Date.now().toString(36)}_${draftSeq}`;
}

export interface RawEntry {
  relPath: string;
  file: File;
}

/** Collect audio entries from a folder selection (input[webkitdirectory]). */
export function entriesFromFolder(fileList: FileList | File[]): RawEntry[] {
  const arr = Array.from(fileList);
  const out: RawEntry[] = [];
  for (const f of arr) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (isAudioName(f.name)) out.push({ relPath: rel, file: f });
  }
  return out;
}

/** Collect audio entries from a ZIP archive. */
export async function entriesFromZip(zipFile: File): Promise<RawEntry[]> {
  const zip = await JSZip.loadAsync(zipFile);
  const out: RawEntry[] = [];
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    const path = entry.name;
    if (!isAudioName(path)) continue;
    // Skip macOS resource-fork junk.
    if (path.split("/").some(p => p === "__MACOSX") || path.startsWith("._")) continue;
    const blob = await entry.async("blob");
    const ext = extOf(path);
    const fname = path.split("/").pop() || path;
    const file = new File([blob], fname, { type: MIME_BY_EXT[ext] || "audio/mpeg" });
    out.push({ relPath: path, file });
  }
  return out;
}

/**
 * Turn raw audio entries into editable drafts: folder name → category, file
 * name (sans extension) → name, plus an auto-assigned shortcut that avoids the
 * already-used keys. Entries are sorted by path so categories group together.
 */
export function buildDrafts(entries: RawEntry[], usedShortcuts: Set<string>): DraftSound[] {
  const sorted = [...entries].sort((a, b) => a.relPath.localeCompare(b.relPath, "zh-Hans-CN"));
  const taken = new Set<string>(Array.from(usedShortcuts, k => k.toLowerCase()));
  const drafts: DraftSound[] = [];
  for (const e of sorted) {
    const shortcut = nextFreeKey(taken);
    if (shortcut) taken.add(shortcut);
    const [rawCat, rawSub] = folderParts(e.relPath, "导入音效");
    const category = smartMapCategory(rawCat);
    const subCategory = rawSub;
    const bgm = isLikelyBgm(rawCat, rawSub);
    const srcName = baseName(e.relPath) || e.file.name;
    drafts.push({
      key: draftKey(),
      name: srcName,
      category,
      subCategory,
      shortcut,
      mode: bgm ? "loop" : "once",
      volume: 80,
      file: e.file,
      sizeBytes: e.file.size,
      sourceName: srcName,
      sourceFolder: rawCat,
      sourceSubFolder: rawSub,
    });
  }
  return drafts;
}

function nextFreeKey(taken: Set<string>): string {
  for (const k of SHORTCUT_POOL) {
    if (!taken.has(k)) return k;
  }
  return "";
}

/**
 * Keys (draft.key) that currently have a shortcut conflict — either two drafts
 * share a key, or a draft collides with an existing sound's shortcut. Empty
 * shortcuts never conflict.
 */
export function findConflicts(drafts: DraftSound[], existing: SoundItem[]): Set<string> {
  const existingKeys = new Set(
    existing.filter(s => s.shortcut).map(s => s.shortcut!.toLowerCase()),
  );
  const counts = new Map<string, number>();
  for (const d of drafts) {
    if (!d.shortcut) continue;
    const k = d.shortcut.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const bad = new Set<string>();
  for (const d of drafts) {
    if (!d.shortcut) continue;
    const k = d.shortcut.toLowerCase();
    if ((counts.get(k) ?? 0) > 1 || existingKeys.has(k)) bad.add(d.key);
  }
  return bad;
}

/**
 * Re-assign shortcuts for every conflicting draft to fresh, unused keys while
 * keeping non-conflicting drafts untouched. Drafts that can't get a unique key
 * (pool exhausted) are left without a shortcut.
 */
export function reassignConflicts(drafts: DraftSound[], existing: SoundItem[]): DraftSound[] {
  const conflicts = findConflicts(drafts, existing);
  if (conflicts.size === 0) return drafts;
  const taken = new Set<string>(
    existing.filter(s => s.shortcut).map(s => s.shortcut!.toLowerCase()),
  );
  // Reserve the keys held by drafts we are NOT reassigning.
  for (const d of drafts) {
    if (!conflicts.has(d.key) && d.shortcut) taken.add(d.shortcut.toLowerCase());
  }
  return drafts.map(d => {
    if (!conflicts.has(d.key)) return d;
    const k = nextFreeKey(taken);
    if (k) taken.add(k);
    return { ...d, shortcut: k };
  });
}
