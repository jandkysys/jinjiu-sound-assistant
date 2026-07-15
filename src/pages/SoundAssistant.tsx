import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { parseGlobalShortcutFromEvent, getGlobalShortcutBridge, matchesGlobalShortcut } from "../lib/globalShortcutBridge";
import { findFunctionConflict, removeFunctionShortcut } from "../lib/shortcutConflictPolicy";
import { directShortcutFromEvent, directShortcutLabel, directShortcutToAccelerator, keyboardTokenToShortcut } from "../lib/directShortcutKey";
import { rememberScopedTrack, visibleScopedTrack, type PlayerScope, type ScopedTracks } from "../lib/scopedPlayer";
import { shouldTriggerDirectShortcut } from "../lib/shortcutInteraction";
import { useElectronHotkeySync } from "../lib/electronHotkeySync";
import { createTriggerDeduper } from "../lib/triggerDeduper";
import { CountdownToast } from "../components/CountdownToast";
import {
  type SoundItem,
  type SoundPack,
  type ExportedSound,
  type ConflictStrategy,
  type ImportResult,
  buildSoundPack,
  isBuildAborted,
  downloadSoundPack,
  packWithoutSounds,
  readSoundPackFile,
  detectConflicts,
  mergeSoundPack,
  commitMergePlan,
  pruneAudioBlobsForRemoved,
  safeSaveSounds,
  estimatePackPayloadBytes,
  formatBytes,
  mergePlanPayloadBytes,
  isImportAborted,
} from "../lib/soundPack";
import { putAudioBlob, getAudioBlob, deleteAudioBlobs, hasAudioBlob, listAudioIds } from "../lib/audioStore";
import { dispatchSoundsChange, useSoundEngine, invalidateAudioCache, DUCK_FACTOR_MIN, DUCK_FACTOR_MAX, DUCK_FADE_MS_MIN, DUCK_FADE_MS_MAX, type BgmMode } from "../lib/useSoundEngine";
import { getPersisted, setPersisted, removePersisted } from "../lib/persist";
import BatchImportModal from "../components/BatchImportModal";
import SoundTrimModal from "../components/SoundTrimModal";
import { type DraftSound, type RawEntry, entriesFromFolder, entriesFromZip, buildDrafts } from "../lib/batchImport";
import { useIsMobile } from "../hooks/use-mobile";
import { useLocation } from "wouter";
import { clearToken } from "@/lib/auth";
import { usePersistState } from "../hooks/use-persist-state";
import { pinyinMatches, pinyinSpans } from "../lib/pinyin";
import { renderMatchName } from "../lib/matchHighlight";
import CloudSyncPanel from "../components/CloudSyncPanel";
import CloudManageTab from "../components/CloudManageTab";
import SyncModal from "../components/SyncModal";
import { checkCloudVersion, getLastCloudError, getStoredCloudVersion, type CloudVersionInfo } from "../lib/cloudSync";
import {
  FUNC_SHORTCUTS_KEY, type FuncActionId, FUNC_ACTIONS,
  comboFromEvent, comboLabel, loadFuncShortcuts, useFuncShortcutListener,
  useFuncGlobalShortcut,
} from "../lib/funcShortcuts";
import MidiSettingsModal from "../components/MidiSettingsModal";
import { useMemberStatus, formatExpiry } from "@/lib/memberStatus";

const EXPORT_LARGE_PACK_BYTES = 50 * 1024 * 1024;

// "Real" (deletable) first-level sound categories (一级分类). "收藏" is a virtual
// filter appended at render time and cannot be removed. Second-level categories
// (二级分类) are emergent — derived from each sound's optional `subCategory`,
// not a managed list. 主播音效 (main) and 背景音乐 (bg) keep fully independent
// first-level category lists: a sound belongs to exactly one tab (by `type`),
// and adding/removing categories only affects the active tab.
const DEFAULT_SOUND_CATS = ["短音效", "PK音乐", "背景音乐"];
const DEFAULT_MAIN_CATS = ["短音效"];
const DEFAULT_BG_CATS = ["PK音乐", "背景音乐"];
const DEFAULT_MINE_CATS = ["我的音效"];
const UNCAT = "未分类" as const;
const VIRTUAL_SOUND_CATS = ["收藏", UNCAT] as const;
const ALL_SUB = "全部";
const SOUND_CATS_KEY = "jt_sound_cats";
const SOUND_MAIN_CATS_KEY = "jt_sound_main_cats";
const SOUND_BG_CATS_KEY = "jt_sound_bg_cats";
const SOUND_MINE_CATS_KEY = "jt_sound_mine_cats";
const SOUND_MINE_BG_CATS_KEY = "jt_sound_mine_bg_cats";
const CAT_SHORTCUTS_KEY = "jt_cat_shortcuts";
const HOST_LOOP_KEY = "jt_host_loop";
const FAV_SORT_KEY = "jt_fav_sort";
type FavSort = "order" | "name" | "freq";
type SoundPool = "main" | "bg" | "mine";
type SoundTab = "main" | "bg" | "kbd" | "mine";
function isBgSound(s: SoundItem): boolean { return s.type === "bgm" || s.type === "pk"; }
// 音效所属的板块（池）：「我的」板块独立，其余按类型分主播/背景。
function soundPool(s: SoundItem): SoundPool { return s.mine ? "mine" : isBgSound(s) ? "bg" : "main"; }
// 当前标签页对应的音效池（分类快捷键按池区分，避免同名分类跨池误触发）。
function poolOfTab(tab: SoundTab): SoundPool { return tab === "bg" ? "bg" : tab === "mine" ? "mine" : "main"; }
// 分类快捷键 map 的复合键：`<池>\u0001<分类名>`。一级场景分类在主播/背景标签共享同名，
// 仅按分类名存储会让同名分类把快捷键路由到错误的标签；用复合键带上目标池消除歧义。
const CAT_SKEY_SEP = "\u0001";
function catSKey(pool: SoundPool, cat: string): string { return `${pool}${CAT_SKEY_SEP}${cat}`; }
function parseCatSKey(k: string): { pool: SoundPool; cat: string } | null {
  const i = k.indexOf(CAT_SKEY_SEP);
  if (i < 0) return null;
  return { pool: k.slice(0, i) as SoundPool, cat: k.slice(i + 1) };
}
function loadCats(key: string, fallback: string[]): string[] {
  try {
    const r = getPersisted(key);
    if (r) {
      const arr = JSON.parse(r);
      if (Array.isArray(arr) && arr.every(x => typeof x === "string") && arr.length > 0) return arr;
    }
  } catch {}
  return fallback;
}

const defaultSounds: SoundItem[] = [
  { id: "d1", name: "欢迎进场", type: "short", category: "短音效", subCategory: "开场", volume: 80, loop: false, shortcut: "q", color: "#ff8fa0" },
  { id: "d2", name: "掌声雷动", type: "short", category: "短音效", subCategory: "开场", volume: 85, loop: false, shortcut: "w", color: "#ff8fa0" },
  { id: "d3", name: "开场号角", type: "short", category: "短音效", subCategory: "开场", volume: 78, loop: false, shortcut: "1", color: "#ff8fa0" },
  { id: "d4", name: "PK主题曲", type: "pk", category: "PK音乐", volume: 70, loop: true, shortcut: "e", color: "#7ec4f5" },
  { id: "d5", name: "战斗号角", type: "short", category: "短音效", subCategory: "PK", volume: 82, loop: false, shortcut: "2", color: "#7ec4f5" },
  { id: "d6", name: "胜利欢呼", type: "short", category: "短音效", subCategory: "PK", volume: 88, loop: false, shortcut: "3", color: "#7ec4f5" },
  { id: "d7", name: "搞笑音效", type: "short", category: "短音效", subCategory: "搞笑", volume: 90, loop: false, shortcut: "r", color: "#ffd93d" },
  { id: "d8", name: "滑稽笑声", type: "short", category: "短音效", subCategory: "搞笑", volume: 85, loop: false, shortcut: "f", color: "#ffd93d" },
  { id: "d9", name: "倒地音效", type: "short", category: "短音效", subCategory: "搞笑", volume: 80, loop: false, shortcut: "g", color: "#ffd93d" },
  { id: "d10", name: "感谢关注", type: "short", category: "短音效", subCategory: "感谢", volume: 75, loop: false, shortcut: "t", color: "#9bd989" },
  { id: "d11", name: "感谢礼物", type: "short", category: "短音效", subCategory: "感谢", volume: 78, loop: false, shortcut: "h", color: "#9bd989" },
  { id: "d12", name: "鞠躬感谢", type: "short", category: "短音效", subCategory: "感谢", volume: 76, loop: false, shortcut: "j", color: "#9bd989" },
  { id: "d13", name: "场景切换", type: "short", category: "短音效", subCategory: "转场", volume: 72, loop: false, shortcut: "v", color: "#b794f6" },
  { id: "d14", name: "魔法转场", type: "short", category: "短音效", subCategory: "转场", volume: 70, loop: false, shortcut: "b", color: "#b794f6" },
  { id: "d15", name: "倒计时", type: "short", category: "短音效", subCategory: "惩罚", volume: 80, loop: false, shortcut: "n", color: "#ff6b6b" },
  { id: "d16", name: "失败提示", type: "short", category: "短音效", subCategory: "惩罚", volume: 75, loop: false, shortcut: "m", color: "#ff6b6b" },
  { id: "d17", name: "背景轻音乐", type: "bgm", category: "背景音乐", volume: 50, loop: true, shortcut: "y", color: "#4ecdc4" },
  { id: "d18", name: "钢琴民谣", type: "bgm", category: "背景音乐", volume: 45, loop: true, shortcut: "u", color: "#4ecdc4" },
  { id: "d19", name: "电子舞曲", type: "bgm", category: "背景音乐", volume: 55, loop: true, shortcut: "i", color: "#4ecdc4" },
  { id: "d20", name: "古风纯音", type: "bgm", category: "背景音乐", volume: 48, loop: true, shortcut: "o", color: "#4ecdc4" },
];

// Rows are left-aligned (justifyContent flex-start). "SP<n>" tokens are
// fixed-width spacers used to anchor the nav cluster (x≈630) and the numpad
// (x≈800) to the same column across every row, so the numpad forms a clean
// 4-column grid (cols at 800/841/882/923).
const KB_LAYOUT = [
  { rows: [
    ["Esc","|","F1","F2","F3","F4","|","F5","F6","F7","F8","|","F9","F10","F11","F12","SP53","PrtSc","ScrLk","Pause","SP18","NumLk","Num/","Num*","Num-"],
  ]},
  { rows: [
    ["`","1","2","3","4","5","6","7","8","9","0","-","=","Bksp","SP17","Ins","Home","PgUp","SP18","Num7","Num8","Num9","Num+"],
    ["Tab","q","w","e","r","t","y","u","i","o","p","[","]","\\","SP29","Del","End","PgDn","SP18","Num4","Num5","Num6","Num+"],
    ["Caps","a","s","d","f","g","h","j","k","l",";","'","Enter","SP196","Num1","Num2","Num3","NumEnt"],
    ["Shift","z","x","c","v","b","n","m",",",".","/","Shift↑","SP78","↑","SP67","Num0","Num.","NumEnt"],
    ["Ctrl","Win","Alt","Space","Alt","Win","Menu","Ctrl","SP15","←","↓","→"],
  ]},
];

// 系统功能键：用户设置时给予警告（不强制阻止，可选仍要绑定）
const SYSTEM_SHORTCUT_KEYS: Record<string, string> = {
  "enter": "Enter（播放/停止音效）",
  " ":     "Space（全部停止/恢复）",
  "f3":    "F3（快捷键启用开关）",
  "pageup":   "PageUp（BGM上一首）",
  "pagedown":  "PageDown（BGM下一首）",
  "home":  "Home（BGM首曲）",
  "end":   "End（BGM末曲）",
  "escape":"Escape（关闭弹窗）",
};

// BASE_KEY = 40px: 普通键宽高均为 40×40，使键位比例接近真实键盘
const BASE_KEY = 40;
function keyWidth(k: string) {
  if (k === "Bksp")  return 82;          // ×2.05
  if (k === "Tab")   return 60;          // ×1.5
  if (k === "Caps")  return 72;          // ×1.8
  if (k === "Enter") return 88;          // ×2.2
  if (k === "Shift") return 90;          // ×2.25 左Shift
  if (k === "Shift↑") return 110;        // ×2.75 右Shift 更宽
  if (k === "Space") return 240;         // ×6
  if (k === "Ctrl" || k === "Alt" || k === "Win" || k === "Menu") return 52;
  if (k === "PrtSc" || k === "ScrLk" || k === "Pause" ||
      k === "Ins" || k === "Home" || k === "PgUp" || k === "Del" || k === "End" || k === "PgDn") return 44;
  if (k === "↑" || k === "↓" || k === "←" || k === "→") return BASE_KEY;
  if (k === "Num0") return BASE_KEY * 2 + 5; // 双宽 + gap
  if (k === "NumLk") return 44;
  if (k.startsWith("SP")) return parseInt(k.slice(2), 10) || 0;
  if (k.startsWith("|")) return k.length * 10; // F区分组间距
  return BASE_KEY; // 普通键
}

function isSpacer(k: string) {
  return /^\|+$/.test(k) || /^SP\d+$/.test(k);
}

function uid() { return Math.random().toString(36).slice(2); }
function hexToRgba(hex: string, a: number): string {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map(c => c + c).join("") : m;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(255,255,255,${a})`;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

// Whether a selected file looks like an audio file. Some valid audio files
// report an empty or non-standard MIME type (especially on Windows), so we
// fall back to checking the file extension before rejecting.
const AUDIO_EXTS = ["mp3","wav","ogg","oga","m4a","aac","flac","opus","weba","webm","wma","aiff","aif","amr","mp4"];
function isAudioFile(file: File): boolean {
  if (file.type.startsWith("audio/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return !!ext && AUDIO_EXTS.includes(ext);
}

function isZipFile(file: File): boolean {
  if (/zip/i.test(file.type)) return true;
  return file.name.toLowerCase().endsWith(".zip");
}

// Whether a drag operation carries files (as opposed to text/links). Used to
// avoid triggering the rebind overlay on accidental text/element drags.
function dragHasFiles(e: React.DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes("Files");
}

// Recursively collect File objects from a drop's DataTransfer. Supports dropped
// folders via the non-standard webkitGetAsEntry API (entries must be grabbed
// synchronously before the handler returns, which we do below). Falls back to
// the flat dt.files list when the entry API is unavailable or yields nothing.
async function collectEntriesFromDataTransfer(dt: DataTransfer): Promise<RawEntry[]> {
  const flatFiles = Array.from(dt.files);
  const flatAsEntries = (): RawEntry[] =>
    flatFiles.map(f => ({
      relPath: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      file: f,
    }));
  const items = dt.items;
  const entries: FileSystemEntry[] = [];
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const getEntry = (it as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry;
      if (typeof getEntry === "function") {
        const entry = getEntry.call(it);
        if (entry) entries.push(entry);
      }
    }
  }
  if (entries.length === 0) return flatAsEntries();
  const out: RawEntry[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      // fullPath looks like "/folder/sub/file.mp3"; strip the leading slash so the
      // folder structure survives into buildDrafts' category mapping.
      const relPath = entry.fullPath ? entry.fullPath.replace(/^\//, "") : file.name;
      out.push({ relPath, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = (): Promise<FileSystemEntry[]> =>
        new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      // readEntries returns at most 100 entries per call, so loop until empty.
      let batch = await readBatch();
      while (batch.length > 0) {
        for (const e of batch) await walk(e);
        batch = await readBatch();
      }
    }
  }
  for (const entry of entries) {
    try { await walk(entry); } catch { /* skip unreadable entries */ }
  }
  return out.length > 0 ? out : flatAsEntries();
}

async function collectFilesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  return (await collectEntriesFromDataTransfer(dt)).map(e => e.file);
}

function loadSounds(): SoundItem[] {
  try {
    const r = getPersisted("jt_sounds");
    if (r) {
      const arr = JSON.parse(r) as SoundItem[];
      if (Array.isArray(arr)) {
        // Migration: the old "场景分类" axis (sceneCategory) is gone. Carry the
        // old scene value over to the new optional second-level `subCategory`
        // when it adds information (i.e. differs from the first-level category).
        return arr.map(s => {
          if (s.subCategory != null || s.sceneCategory == null) return s;
          const sc = s.sceneCategory;
          const { sceneCategory: _drop, ...rest } = s;
          return sc && sc !== s.category ? { ...rest, subCategory: sc } : rest;
        });
      }
    }
  } catch {}
  return defaultSounds;
}

// Load the per-tab first-level category list. If a tab-specific list was already
// persisted, use it. Otherwise migrate from the legacy single `jt_sound_cats`
// list + existing sounds, splitting categories by which tab their sounds live in.
function loadTabCats(key: string, pool: SoundPool): string[] {
  const stored = loadCats(key, []);
  if (stored.length > 0) return stored;
  const sounds = loadSounds();
  const used: string[] = [];
  for (const s of sounds) {
    if (soundPool(s) === pool && s.category && !used.includes(s.category)) used.push(s.category);
  }
  if (pool === "bg") return used.length ? used : DEFAULT_BG_CATS;
  if (pool === "mine") return used.length ? used : DEFAULT_MINE_CATS;
  // main: also preserve legacy custom categories not used by the other pools.
  const otherUsed = new Set(sounds.filter(s => soundPool(s) !== "main").map(s => s.category).filter(Boolean));
  const result = used.slice();
  for (const c of loadCats(SOUND_CATS_KEY, DEFAULT_SOUND_CATS)) {
    if (!otherUsed.has(c) && !result.includes(c)) result.push(c);
  }
  return result.length ? result : DEFAULT_MAIN_CATS;
}

export default function SoundAssistant() {
  const isMobile = useIsMobile();
  const memberStatus = useMemberStatus();
  const [, navigate] = useLocation();
  const [savedFlash, setSavedFlash] = useState(false);
  const [sounds, setSounds] = useState<SoundItem[]>(loadSounds);
  const [mainCats, setMainCats] = useState<string[]>(() => loadTabCats(SOUND_MAIN_CATS_KEY, "main"));
  const [bgCats, setBgCats] = useState<string[]>(() => loadTabCats(SOUND_BG_CATS_KEY, "bg"));
  // 「我的」板块的一级分类列表：独立持久化，不与主播/背景共享、不含固定的 PK场景。
  // 主播音效（短音效）和背景音乐各自独立列表，互不影响。
  const [mineCats, setMineCats] = useState<string[]>(() => loadTabCats(SOUND_MINE_CATS_KEY, "mine"));
  const [mineBgCats, setMineBgCats] = useState<string[]>(() => {
    try {
      const raw = getPersisted(SOUND_MINE_BG_CATS_KEY);
      if (raw) { const parsed = JSON.parse(raw) as string[]; if (Array.isArray(parsed) && parsed.length > 0) return parsed; }
    } catch {}
    return ["我的背景音乐"];
  });
  useEffect(() => { try { setPersisted(SOUND_MAIN_CATS_KEY, JSON.stringify(mainCats)); } catch {} }, [mainCats]);
  useEffect(() => { try { setPersisted(SOUND_BG_CATS_KEY, JSON.stringify(bgCats)); } catch {} }, [bgCats]);
  useEffect(() => { try { setPersisted(SOUND_MINE_CATS_KEY, JSON.stringify(mineCats)); } catch {} }, [mineCats]);
  useEffect(() => { try { setPersisted(SOUND_MINE_BG_CATS_KEY, JSON.stringify(mineBgCats)); } catch {} }, [mineBgCats]);
  // 空子分类注册表：{ 父分类名: 子分类名[] }。让在场景分类下右键「添加分类」新建的空子文件夹
  // 在没有音效时也能持久显示（普通子分类是从音效的 subCategory 派生的，空的不会出现）。
  const [subCatReg, setSubCatReg] = useState<Record<string, string[]>>(() => {
    try { const raw = getPersisted("jt_sound_sub_cats"); if (raw) return JSON.parse(raw) as Record<string, string[]>; } catch {}
    return {};
  });
  useEffect(() => { try { setPersisted("jt_sound_sub_cats", JSON.stringify(subCatReg)); } catch {} }, [subCatReg]);
  // 历史数据自愈：从主播/背景分类列表中清除遗留的「PK场景」固定栏目（已废弃）。
  useEffect(() => {
    setMainCats(prev => { const n = prev.filter(c => c !== "PK场景"); return n.length === prev.length ? prev : n; });
    setBgCats(prev => { const n = prev.filter(c => c !== "PK场景"); return n.length === prev.length ? prev : n; });
  }, []);
  // 会话级记忆：选中的一级分类（跨页面导航/刷新保留，关闭软件后清空）。
  // 恢复时校验该分类仍存在（主播/背景/我的 列表或虚拟「收藏」），否则回退默认。
  const [selCat, setSelCat] = usePersistState<string>(
    "sa_selCat",
    () => loadTabCats(SOUND_MAIN_CATS_KEY, "main")[0] ?? "短音效",
    (v) => typeof v === "string" && (
      v === "收藏" || mainCats.includes(v) || bgCats.includes(v) || mineCats.includes(v) || mineBgCats.includes(v)
    ),
  );
  // Selected second-level sub-category (二级分类). ALL_SUB means "show every
  // sound in the first-level category regardless of sub-category". 会话级记忆：
  // 恢复时校验该子分类在当前一级分类下仍存在（音效派生 ∪ subCatReg 注册表），
  // 否则回退「全部」，避免落在已删除/改名的子分类导致空列表。
  const [selSub, setSelSub] = usePersistState<string>(
    "sa_selSub",
    ALL_SUB,
    (v) => {
      if (v === ALL_SUB) return true;
      if (typeof v !== "string") return false;
      const subs = new Set<string>();
      for (const s of sounds) if (s.category === selCat && s.subCategory) subs.add(s.subCategory);
      for (const sub of subCatReg[selCat] ?? []) subs.add(sub);
      return subs.has(v);
    },
  );
  const [favSort, setFavSort] = usePersistState<FavSort>(FAV_SORT_KEY, "order");
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  // Tick every second so the session-cumulative BGM playtime display refreshes.
  const [, setSessionTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setSessionTick(n => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const { playing, paused, currentTrackId, masterVol, setMasterVol, duckEnabled, setDuckEnabled, duckFactor, setDuckFactor, duckFadeMs, setDuckFadeMs, audioSinkId, setAudioSinkId, triggerSound, setSoundVolume, stopAll, pauseResume, stopSound, seekSound, getAudioElement, bgmMode, setBgmMode, setBgmPlaylist, playBgm, bgmCurrentId, bgmNext, bgmPrev } =
    useSoundEngine({ enableGlobalShortcuts: false });

  // ---- Audio output device adaptation ---------------------------------------
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const refreshAudioOutputs = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setAudioOutputs(all.filter(d => d.kind === "audiooutput"));
    } catch {}
  }, []);
  useEffect(() => {
    void refreshAudioOutputs();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
    const onChange = () => { void refreshAudioOutputs(); };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshAudioOutputs]);
  const ensureDeviceLabels = useCallback(async () => {
    if (audioOutputs.some(d => d.label)) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      await refreshAudioOutputs();
    } catch {}
  }, [audioOutputs, refreshAudioOutputs]);
  const sinkSupported = typeof window !== "undefined"
    && typeof (HTMLAudioElement.prototype as { setSinkId?: unknown }).setSinkId === "function";

  // ---- Category mutation helpers --------------------------------------------
  function deleteSoundCat(name: string) {
    if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(name)) return;
    // 「我的」板块独立处理：按 mineFrom 区分主播/背景，只在对应列表内删除。
    if (activeTab === "mine") {
      const mineIsInBg = mineFrom === "bg";
      const curCats = mineIsInBg ? mineBgCats : mineCats;
      const setCats = mineIsInBg ? setMineBgCats : setMineCats;
      const inPoolMine = (s: SoundItem) => s.mine && (mineIsInBg ? isBgSound(s) : !isBgSound(s));
      if (!curCats.includes(name)) return;
      if (curCats.length <= 1) { alert("「我的」至少保留一个分类"); return; }
      const fb = curCats.find(c => c !== name);
      const inUse = sounds.filter(s => inPoolMine(s) && s.category === name).length;
      const msg = inUse > 0
        ? `删除分类「${name}」？\n该分类下的 ${inUse} 条音效会归入其它分类。`
        : `删除分类「${name}」？`;
      if (!confirm(msg)) return;
      setCats(prev => prev.filter(c => c !== name));
      // 清理迁移音效的 subCategory：被删分类的子分类已不属于兜底分类，保留会产生游离子分类。
      if (inUse > 0) setSounds(prev => prev.map(s => (inPoolMine(s) && s.category === name && fb) ? { ...s, category: fb, subCategory: undefined } : s));
      setSubCatReg(prev => { if (!(name in prev)) return prev; const next = { ...prev }; delete next[name]; return next; });
      setCatShortcuts(prev => { const k = catSKey("mine", name); if (!(k in prev)) return prev; const next = { ...prev }; delete next[k]; return next; });
      if (selCat === name) setSelCat(fb ?? "收藏");
      return;
    }
    // 主播音效 / 背景音乐 各自独立：删除只影响当前板块及其类型的音效。
    if (activeTab === "bg") {
      if (!bgCats.includes(name)) return;
      if (bgCats.length <= 1) { alert("「背景音乐」至少保留一个分类"); return; }
      const fb = bgCats.find(c => c !== name);
      const inUse = sounds.filter(s => soundPool(s) === "bg" && s.category === name).length;
      const msg = inUse > 0
        ? `删除分类「${name}」？\n该分类下的 ${inUse} 条背景音乐会归入其它分类。`
        : `删除分类「${name}」？`;
      if (!confirm(msg)) return;
      setBgCats(prev => prev.filter(c => c !== name));
      // 清理迁移音效的 subCategory：被删分类的子分类已不属于兜底分类，保留会产生游离子分类。
      if (inUse > 0) setSounds(prev => prev.map(s => soundPool(s) === "bg" && s.category === name && fb ? { ...s, category: fb, subCategory: undefined } : s));
      setSubCatReg(prev => { if (!(name in prev)) return prev; const next = { ...prev }; delete next[name]; return next; });
      setCatShortcuts(prev => { const k = catSKey("bg", name); if (!(k in prev)) return prev; const next = { ...prev }; delete next[k]; return next; });
      if (selCat === name) setSelCat(fb ?? "收藏");
    } else {
      if (!mainCats.includes(name)) return;
      if (mainCats.length <= 1) { alert("「主播音效」至少保留一个分类"); return; }
      const fb = mainCats.find(c => c !== name);
      const inUse = sounds.filter(s => soundPool(s) === "main" && s.category === name).length;
      const msg = inUse > 0
        ? `删除分类「${name}」？\n该分类下的 ${inUse} 条音效会归入其它分类。`
        : `删除分类「${name}」？`;
      if (!confirm(msg)) return;
      setMainCats(prev => prev.filter(c => c !== name));
      // 清理迁移音效的 subCategory：被删分类的子分类已不属于兜底分类，保留会产生游离子分类。
      if (inUse > 0) setSounds(prev => prev.map(s => soundPool(s) === "main" && s.category === name && fb ? { ...s, category: fb, subCategory: undefined } : s));
      setSubCatReg(prev => { if (!(name in prev)) return prev; const next = { ...prev }; delete next[name]; return next; });
      setCatShortcuts(prev => { const k = catSKey("main", name); if (!(k in prev)) return prev; const next = { ...prev }; delete next[k]; return next; });
      if (selCat === name) setSelCat(fb ?? "收藏");
    }
  }
  function addCategory() {
    setInlineEdit({ kind: "newCat" });
    setInlineVal("");
  }
  // 在指定场景分类（parent）下新建一个空的子分类（子文件夹），并注册到 subCatReg 持久保存。
  function addSubUnder(parent: string) {
    if (!parent) return;
    setSelCat(parent);
    setSelSub(ALL_SUB);
    setInlineEdit({ kind: "newSub", parent });
    setInlineVal("");
  }
  // 重命名一个二级（子）分类：更新 subCatReg 和所有相关音效的 subCategory 字段。
  function renameSubCat(oldName: string) {
    if (!oldName || oldName === ALL_SUB) return;
    setInlineEdit({ kind: "renameSub", name: oldName });
    setInlineVal(oldName);
  }

  // 删除二级分类（音效移到父分类根下，不删除音效）。
  function deleteSubCat(subName: string) {
    if (!subName || subName === ALL_SUB) return;
    const parent = selCat;
    const inPool = (s: SoundItem) => soundPool(s) === (activeTab === "bg" ? "bg" : activeTab === "mine" ? "mine" : "main");
    const cnt = sounds.filter(s => inPool(s) && s.category === parent && (s.subCategory ?? "") === subName).length;
    const msg = cnt > 0
      ? `删除子分类「${subName}」？\n该分类下 ${cnt} 条音效会保留在「${parent}」根目录下（音效不会被删除）。`
      : `删除空子分类「${subName}」？`;
    if (!confirm(msg)) return;
    setSounds(prev => prev.map(s =>
      inPool(s) && s.category === parent && (s.subCategory ?? "") === subName
        ? { ...s, subCategory: "" }
        : s
    ));
    setSubCatReg(prev => {
      if (!prev[parent]?.includes(subName)) return prev;
      const next = { ...prev, [parent]: prev[parent].filter(x => x !== subName) };
      if (next[parent].length === 0) delete next[parent];
      return next;
    });
    if (selSub === subName) setSelSub(ALL_SUB);
  }

  // 清空二级分类（删除该分类下的所有音效，保留分类本身）。
  function clearSubCat(subName: string) {
    if (!subName || subName === ALL_SUB) return;
    const parent = selCat;
    const inPool = (s: SoundItem) => soundPool(s) === (activeTab === "bg" ? "bg" : activeTab === "mine" ? "mine" : "main");
    const toDelete = sounds.filter(s => inPool(s) && s.category === parent && (s.subCategory ?? "") === subName);
    if (toDelete.length === 0) { alert("该分类下没有音效"); return; }
    if (!confirm(`清空子分类「${subName}」？将删除其中 ${toDelete.length} 条音效，操作不可撤销。`)) return;
    const ids = new Set(toDelete.map(s => s.id));
    setSounds(prev => prev.filter(s => !ids.has(s.id)));
    deleteAudioBlobs(toDelete.map(s => s.id)).catch(() => {});
  }

  // 把二级分类移到另一个一级分类下（音效随之迁移）。
  function moveSubToParent(subName: string, newParent: string) {
    const oldParent = selCat;
    if (!subName || !newParent || newParent === oldParent) return;
    const inPool = (s: SoundItem) => soundPool(s) === (activeTab === "bg" ? "bg" : activeTab === "mine" ? "mine" : "main");
    const cnt = sounds.filter(s => inPool(s) && s.category === oldParent && (s.subCategory ?? "") === subName).length;
    if (!confirm(`将子分类「${subName}」从「${oldParent}」移到「${newParent}」下？该分类下 ${cnt} 条音效会一起移动。`)) return;
    setSounds(prev => prev.map(s =>
      inPool(s) && s.category === oldParent && (s.subCategory ?? "") === subName
        ? { ...s, category: newParent, subCategory: subName }
        : s
    ));
    // 如果是空子分类注册表里的条目，迁移到新父分类的注册表
    setSubCatReg(prev => {
      const next = { ...prev };
      if (next[oldParent]?.includes(subName)) {
        next[oldParent] = next[oldParent].filter(x => x !== subName);
        if (next[oldParent].length === 0) delete next[oldParent];
        next[newParent] = [...(next[newParent] ?? []), subName];
      }
      return next;
    });
    setSelCat(newParent);
    setSelSub(subName);
  }

  // 把当前一级分类下的某个二级（子）分类，移为独立的一级分类。
  function promoteSubCat(subName: string) {
    if (!subName || subName === ALL_SUB) return;
    if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(subName)) { alert("此名称为保留分类，无法移为一级分类"); return; }
    const cats = activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats;
    const setCats = activeTab === "bg" ? setBgCats : activeTab === "mine" ? setCurMineCats : setMainCats;
    const parent = selCat;
    const inPool = (s: SoundItem) => activeTab === "bg" ? soundPool(s) === "bg" : activeTab === "mine" ? (s.mine && (mineFrom === "bg" ? isBgSound(s) : !isBgSound(s))) : soundPool(s) === "main";
    const mergeInto = cats.includes(subName);
    const msg = mergeInto
      ? `将子分类「${subName}」移至上级分类？\n该子分类下的音效会移出「${parent}」，并入已存在的一级分类「${subName}」。`
      : `将子分类「${subName}」移至上级分类？\n该子分类下的音效会移出「${parent}」，成为独立的一级分类「${subName}」（如左上「短音效」那样）。`;
    if (!confirm(msg)) return;
    if (!mergeInto) setCats([...cats, subName]);
    setSounds(prev => prev.map(s =>
      inPool(s) && s.category === parent && (s.subCategory ?? "") === subName
        ? { ...s, category: subName, subCategory: "" }
        : s
    ));
    // 该子分类已升为一级分类，从父分类的空子分类注册表移除（避免残留重复）。
    setSubCatReg(prev => {
      if (!prev[parent]?.includes(subName)) return prev;
      const next = { ...prev, [parent]: prev[parent].filter(x => x !== subName) };
      if (next[parent].length === 0) delete next[parent];
      return next;
    });
    setSelCat(subName);
    setSelSub(ALL_SUB);
  }
  // Rename a category and re-tag every sound that referenced it.
  function renameSoundCat(oldName: string) {
    if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(oldName)) return;
    setInlineEdit({ kind: "renameCat", name: oldName });
    setInlineVal(oldName);
  }
  // 「栏目分类」：把当前一级分类（栏目）移到另一个栏目下面，成为其二级（子）分类。
  // 与 promoteSubCat（子→栏目）相反。
  function moveCatUnder(child: string, parent: string) {
    if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(child)) return;
    if (!child || !parent || child === parent) return;
    const cats = activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats;
    const setCats = activeTab === "bg" ? setBgCats : activeTab === "mine" ? setCurMineCats : setMainCats;
    if (!cats.includes(parent)) { alert("目标栏目不存在"); return; }
    const inPool = (s: SoundItem) => activeTab === "bg" ? soundPool(s) === "bg" : activeTab === "mine" ? (s.mine && (mineFrom === "bg" ? isBgSound(s) : !isBgSound(s))) : soundPool(s) === "main";
    const own = sounds.filter(s => inPool(s) && s.category === child);
    const cnt = own.length;
    // 若该栏目已有自己的子分类（文件夹），移动后会被压平为单一子分类「child」。
    const hadSubs = new Set(own.map(s => s.subCategory ?? "").filter(Boolean));
    let msg = `将栏目「${child}」移到「${parent}」下面？\n该栏目的 ${cnt} 条音效会变为「${parent}」的子分类「${child}」。`;
    if (hadSubs.size > 0) msg += `\n\n注意：该栏目原有的 ${hadSubs.size} 个子分类（${[...hadSubs].join("、")}）将被合并为单一子分类「${child}」。`;
    if (!confirm(msg)) return;
    setSounds(prev => prev.map(s =>
      inPool(s) && s.category === child
        ? { ...s, category: parent, subCategory: child }
        : s
    ));
    setCats(cats.filter(c => c !== child));
    // 降为子分类后不再拥有栏目快捷键（按复合键清除当前池下的绑定）
    setCatShortcuts(prev => { const k = catSKey(poolOfTab(activeTab), child); if (!(k in prev)) return prev; const next = { ...prev }; delete next[k]; return next; });
    // 该栏目被压平为单一子分类，其名下注册的空子分类一并清除。
    setSubCatReg(prev => { if (!(child in prev)) return prev; const next = { ...prev }; delete next[child]; return next; });
    setSelCat(parent);
    setSelSub(child);
  }
  // Persist a reordered category list for the active tab.
  function applyCatOrder(order: string[]) {
    if (activeTab === "mine") {
      // 「我的」板块没有固定的 PK场景，直接按拖动结果保存（按 mineFrom 路由）。
      setCurMineCats(order);
      return;
    }
    const setCats = activeTab === "bg" ? setBgCats : setMainCats;
    setCats(order);
  }
  // Assign / clear a random-play shortcut for a category in a specific pool/tab.
  // 用复合键（池+分类名）存储，避免主播/背景标签下的同名分类把快捷键路由到错误的池。
  function assignCatShortcut(pool: SoundPool, cat: string, key: string | null) {
    const skey = catSKey(pool, cat);
    setCatShortcuts(prev => {
      const next = { ...prev };
      // A key can only map to one category at a time.
      if (key) for (const k of Object.keys(next)) if (next[k] === key) delete next[k];
      if (key) next[skey] = key; else delete next[skey];
      return next;
    });
  }
  // Open the upload modal pre-filled for the active tab so a new sound lands in
  // the right pool: 主播音效 → short (main), 背景音乐 → bgm (bg).
  function openUpload() {
    const cats = activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats;
    const cat = selCat && cats.includes(selCat) ? selCat : (cats[0] ?? "");
    // 「我的」板块：按 mineFrom 决定类型（主播→short，背景→bgm）。主播/背景按各自池固定。
    const isBg = activeTab === "bg" || (activeTab === "mine" && mineFrom === "bg");
    setUploadForm({ volume: 80, loop: isBg, type: isBg ? "bgm" : "short", category: cat, subCategory: "" });
    setUploadFile(null);
    setShowUpload(true);
  }

  // ── 手机端快速导入：直接写入当前二级分类（管理员专用）────────────────────
  async function handleMobileImportFiles(files: File[]) {
    if (files.length === 0) return;
    const audioFiles = files.filter(f =>
      /\.(mp3|wav|m4a|ogg|flac|aac|opus|webm|wma|aiff|amr)$/i.test(f.name) || f.type.startsWith("audio/")
    );
    if (audioFiles.length === 0) { alert("未找到音频文件，支持 mp3/wav/flac/m4a 等格式"); return; }
    const isBg = activeTab === "bg";
    const type: SoundItem["type"] = isBg ? "bgm" : "short";
    const loop = isBg;
    const category = (selCat && selCat !== "收藏") ? selCat : (isBg ? bgCats[0] : mainCats[0]) ?? "短音效";
    const subCategory = (selSub && selSub !== ALL_SUB) ? selSub : UNCAT;
    setMobileImportProgress({ total: audioFiles.length, done: 0, failed: 0, status: "running" });
    const newItems: SoundItem[] = [];
    let failCount = 0;
    for (let i = 0; i < audioFiles.length; i++) {
      const file = audioFiles[i]!;
      const newId = uid();
      try {
        await putAudioBlob(newId, file, undefined, file.name);
        newItems.push({
          id: newId,
          name: file.name.replace(/\.[^.]+$/, "") || "未命名",
          type,
          category,
          subCategory: subCategory || undefined,
          volume: 80,
          loop,
          hasAudio: true,
        });
      } catch {
        failCount++;
      }
      setMobileImportProgress({ total: audioFiles.length, done: i + 1, failed: failCount, status: "running" });
    }
    if (newItems.length > 0) {
      setSounds(prev => [...prev, ...newItems]);
      if (subCategory && category !== UNCAT) {
        setSubCatReg(prev => {
          const ex = prev[category] ?? [];
          if (ex.includes(subCategory)) return prev;
          return { ...prev, [category]: [...ex, subCategory] };
        });
      }
    }
    setMobileImportProgress({ total: audioFiles.length, done: audioFiles.length, failed: failCount, status: "done" });
    setTimeout(() => setMobileImportProgress(null), 3000);
  }
  const [missingIds, setMissingIds] = useState<Set<string>>(new Set());
  const [missingToast, setMissingToast] = useState<{ text: string; key: number } | null>(null);
  // Drag-and-drop folder/files onto the page to batch-rebind missing sounds.
  const [rebindDragOver, setRebindDragOver] = useState(false);
  const rebindDragDepth = useRef(0);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState<Partial<SoundItem>>({ volume: 80, loop: false, type: "short", category: "短音效", subCategory: "" });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  // 上传弹窗里的分类选择器 state
  const [uploadPickQuery, setUploadPickQuery] = useState("");
  // ── 快速导入（管理员专用，直接写入当前分类）── 移动端 + 桌面端共用 handler ──
  const mobileImportInputRef = useRef<HTMLInputElement>(null);
  const desktopImportInputRef = useRef<HTMLInputElement>(null);
  // ── 蓝牙键盘模式（手机端）──────────────────────────────────────────────────
  const btKeyboardInputRef = useRef<HTMLInputElement>(null);
  const [btKeyboardMode, setBtKeyboardMode] = useState(false);
  const btRefocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function enableBtKeyboard() {
    setBtKeyboardMode(true);
    setTimeout(() => btKeyboardInputRef.current?.focus(), 80);
  }
  function disableBtKeyboard() {
    setBtKeyboardMode(false);
    if (btRefocusTimer.current) clearTimeout(btRefocusTimer.current);
    btKeyboardInputRef.current?.blur();
  }
  function toggleBtKeyboard() {
    if (btKeyboardMode) disableBtKeyboard(); else enableBtKeyboard();
  }
  const [mobileImportProgress, setMobileImportProgress] = useState<{
    total: number; done: number; failed: number; status: "idle" | "running" | "done";
  } | null>(null);
  const [uploadPickCat, setUploadPickCat] = useState<string | null>(null);
  const [uploadPickSub, setUploadPickSub] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const mobileTapRef = useRef<{ id: string; t: number } | null>(null);
  const [mobileSelectMode, setMobileSelectMode] = useState(false);
  const mobileLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shortcutCapture, setShortcutCapture] = useState(false);
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null);
  const [pendingConflictName, setPendingConflictName] = useState<string | null>(null);
  const [pendingFunctionConflictId, setPendingFunctionConflictId] = useState<string | null>(null);
  const [pendingSystemKeyName, setPendingSystemKeyName] = useState<string | null>(null);
  const [globalShortcutCapture, setGlobalShortcutCapture] = useState(false);
  const [gsConflictMsg, setGsConflictMsg] = useState<string | null>(null);
  const [pendingGlobalShortcut, setPendingGlobalShortcut] = useState<string | null>(null);
  const [pendingGsConflictName, setPendingGsConflictName] = useState<string | null>(null);
  const [gsDirectCapture, setGsDirectCapture] = useState<string | null>(null);
  const [gsDirectCandidate, setGsDirectCandidate] = useState<string | null>(null);
  const [gsDirectConflict, setGsDirectConflict] = useState<{ kind: "sound-global" | "sound-direct" | "function"; id: string; name: string } | null>(null);
  const [importPack, setImportPack] = useState<SoundPack | null>(null);
  const [importToast, setImportToast] = useState<{ result: ImportResult; key: number } | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; title: string; onCancel?: () => void; cancelLabel?: string } | null>(null);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  // ---- Batch import (folder / ZIP) ------------------------------------------
  const [batchDrafts, setBatchDrafts] = useState<DraftSound[] | null>(null);
  const [batchSource, setBatchSource] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [showBatchMenu, setShowBatchMenu] = useState(false);
  const [batchCancelToast, setBatchCancelToast] = useState<{ key: number } | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);
  const [rebindConfirm, setRebindConfirm] = useState<{ id: string; file: File; url: string; currentUrl: string | null } | null>(null);
  const [batchRebind, setBatchRebind] = useState<{
    files: File[];
    items: { id: string; name: string }[];
    assign: Record<string, number>;
    kind: Record<string, "exact" | "fuzzy">;
    scores: Record<string, number>;
    done: boolean;
  } | null>(null);
  // 批量重绑面板里的「试听」：为当前条目绑定的 File 现造一个 object URL 播放，
  // 切换条目 / 关闭面板时释放，避免内存泄漏。
  const [rebindPreview, setRebindPreview] = useState<{ id: string; url: string } | null>(null);
  const [rebindLibOpen, setRebindLibOpen] = useState(false);
  const [rebindLibSearch, setRebindLibSearch] = useState("");
  const [rebindLibSelected, setRebindLibSelected] = useState<{ id: string; name: string; url: string } | null>(null);
  const [rebindSyncName, setRebindSyncName] = useState(true);
  const [exportPrompt, setExportPrompt] = useState<{ pack: SoundPack; failed: { id: string; name: string }[]; bytes: number } | null>(null);
  // 导出大体积音效包时，base64 编码每条音频是耗时步骤；展示「已处理 X / Y」进度并可取消。
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number; onCancel: () => void } | null>(null);
  const [keyCtxMenu, setKeyCtxMenu] = useState<{ x: number; y: number; soundId: string } | null>(null);
  // Right-click context menu for a category pill. pool 记录该分类所属的标签页池，
  // 用于设置/取消随机播放快捷键时落到正确的池（同名分类不串台）。
  const [catCtxMenu, setCatCtxMenu] = useState<{ x: number; y: number; cat: string; pool: SoundPool } | null>(null);
  // 二级（子）分类右键菜单
  const [subCtxMenu, setSubCtxMenu] = useState<{ x: number; y: number; sub: string } | null>(null);
  // 「栏目分类」目标选择菜单：把某个一级分类移到选定栏目下面
  const [catMoveMenu, setCatMoveMenu] = useState<{ x: number; y: number; cat: string } | null>(null);
  // 「子分类移动」目标选择菜单：把某个二级分类移到其他一级分类下面
  const [subMoveMenu, setSubMoveMenu] = useState<{ x: number; y: number; sub: string } | null>(null);
  // 音效右键「移到场景分类」子菜单：把音效归类到上级场景分类（设为该分类、清空子分类）.
  const [soundMoveMenu, setSoundMoveMenu] = useState<{ x: number; y: number; soundId: string } | null>(null);
  const [soundVolModal, setSoundVolModal] = useState<{ soundId: string } | null>(null);
  const [soundVolDraft, setSoundVolDraft] = useState(100);
  // 多选批量「移动到…」目标选择菜单：把所有选中的音效一次性移到某个场景分类/子分类.
  const [batchMoveMenu, setBatchMoveMenu] = useState<{ x: number; y: number } | null>(null);
  // 单音效「移动到场景分类」modal 的搜索词.
  const [soundMoveQuery, setSoundMoveQuery] = useState("");
  // 批量移动 modal 的搜索词.
  const [batchMoveQuery, setBatchMoveQuery] = useState("");
  // 移动成功 toast.
  const [moveCatToast, setMoveCatToast] = useState<{ text: string; key: number } | null>(null);
  // 批量音量滑块的当前显示值（仅用于工具条上的数字反馈，松手时才真正写入所有选中音效）.
  const [batchVolPreview, setBatchVolPreview] = useState(80);
  // 批量颜色选择器弹窗是否打开.
  const [batchColorOpen, setBatchColorOpen] = useState(false);
  // 「添加分类」目标选择菜单：先选在哪个场景分类下，再命名新建空子分类（子文件夹）.
  const [addSubMenu, setAddSubMenu] = useState<{ x: number; y: number } | null>(null);
  // ＋ 按钮弹出的小菜单（选添加一级还是二级分类）.
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  // 「添加二级分类」弹窗状态.
  const [addSubModal, setAddSubModal] = useState<{ parentCat: string; name: string } | null>(null);
  // Category → keyboard-shortcut map; pressing the key plays a random sound
  // from that category. Persisted across sessions.
  const [catShortcuts, setCatShortcuts] = useState<Record<string, string>>(() => {
    try {
      const r = getPersisted(CAT_SHORTCUTS_KEY);
      if (r) {
        const raw = JSON.parse(r) as Record<string, string>;
        // 旧数据按「分类名」存储；迁移为复合键「池\u0001分类名」。沿用旧解析优先级
        // （我的→背景→主播）确定原本会播放的池，保证已保存的快捷键继续指向同一音效。
        const migrated: Record<string, string> = {};
        for (const [kk, key] of Object.entries(raw)) {
          if (kk.includes(CAT_SKEY_SEP)) { migrated[kk] = key; continue; }
          const pool: SoundPool = (mineCats.includes(kk) || mineBgCats.includes(kk)) ? "mine" : bgCats.includes(kk) ? "bg" : "main";
          migrated[catSKey(pool, kk)] = key;
        }
        return migrated;
      }
    } catch {}
    return {};
  });
  useEffect(() => { try { setPersisted(CAT_SHORTCUTS_KEY, JSON.stringify(catShortcuts)); } catch {} }, [catShortcuts]);
  // 主播音效「循环播放」toggle: when on, triggering a host sound loops it.
  const [hostLoop, setHostLoop] = useState<boolean>(() => {
    try { return getPersisted(HOST_LOOP_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => { try { setPersisted(HOST_LOOP_KEY, hostLoop ? "1" : "0"); } catch {} }, [hostLoop]);
  const [cloudVersionInfo, setCloudVersionInfo] = useState<CloudVersionInfo | null>(null);
  const [showCloudPanel, setShowCloudPanel] = useState(false);
  const [showCloudManage, setShowCloudManage] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);

  useEffect(() => { void checkCloudVersion().then(info => { if (info) setCloudVersionInfo(info); }); }, []);
  // Modal for reordering the active tab's categories (调整顺序).
  const [reorderCats, setReorderCats] = useState<string[] | null>(null);
  // Capture-a-key overlay state for assigning a category shortcut（带池，区分同名分类）。
  const [catKeyCapture, setCatKeyCapture] = useState<{ pool: SoundPool; cat: string } | null>(null);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const [clipFor, setClipFor] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  // 长按拖动：一级分类 ↔ 二级分类 变级别
  const [dragItem, setDragItem] = useState<{ kind: 'cat' | 'sub'; name: string } | null>(null);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ kind: 'cat' | 'sub'; name: string; target: string } | null>(null);
  const catBarRef = useRef<HTMLDivElement>(null);
  const subBarRef = useRef<HTMLDivElement>(null);
  const dragLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragItemRef = useRef<{ kind: 'cat' | 'sub'; name: string } | null>(null);
  const dragOverTargetRef = useRef<string | null>(null);
  const selCatRef = useRef(selCat);
  // 会话级记忆：快捷键布局面板的子标签（编辑/颜色/默认）。
  const [panelTab, setPanelTab] = usePersistState<"edit" | "color" | "default">(
    "sa_panelTab",
    "default",
    (v) => v === "edit" || v === "color" || v === "default",
  );
  const [panelCurrentId, setPanelCurrentId] = useState<string | null>(null);
  // 就地编辑（分类名称）：替代 prompt 弹窗
  type InlineEditState =
    | { kind: "newCat" }
    | { kind: "renameCat"; name: string }
    | { kind: "newSub"; parent: string }
    | { kind: "renameSub"; name: string };
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [inlineVal, setInlineVal] = useState("");
  const inlineInputRef = useRef<HTMLInputElement>(null);
  // 用 ref 同步当前编辑状态，避免 onBlur 读到过时的闭包值（Escape 后仍触发 commit）
  const inlineEditRef = useRef<InlineEditState | null>(null);
  // 会话级记忆：当前主标签（主播音效/背景音乐/快捷键布局/录音/我的音效）。
  const [activeTab, setActiveTab] = usePersistState<SoundTab>(
    "sa_activeTab",
    "main",
    (v) => v === "main" || v === "bg" || v === "kbd" || v === "mine",
  );
  // 进入「我的」前所处的标签（主播/背景），用于「我的」视图区分主播我的/背景我的。
  const [mineFrom, setMineFrom] = useState<"main" | "bg">("main");
  const [scopedTrackIds, setScopedTrackIds] = useState<ScopedTracks>({});
  const playerScope: PlayerScope = activeTab === "kbd" ? "kbd" : activeTab === "bg" || (activeTab === "mine" && mineFrom === "bg") ? "bg" : "main";
  // 「我的」板块当前激活的分类列表：主播我的用 mineCats，背景我的用 mineBgCats。
  const curMineCats = mineFrom === "bg" ? mineBgCats : mineCats;
  const setCurMineCats = mineFrom === "bg" ? setMineBgCats : setMineCats;
  // Reset the second-level filter whenever the first-level category changes.
  // 首次挂载跳过：避免抹掉会话级记忆恢复出来的 selSub。
  const selSubResetMounted = useRef(false);
  useEffect(() => {
    if (!selSubResetMounted.current) { selSubResetMounted.current = true; return; }
    setSelSub(ALL_SUB);
  }, [selCat]);
  useEffect(() => { selCatRef.current = selCat; }, [selCat]);
  useEffect(() => {
    inlineEditRef.current = inlineEdit;
    if (inlineEdit) {
      requestAnimationFrame(() => {
        inlineInputRef.current?.focus();
        inlineInputRef.current?.select();
      });
    }
  }, [inlineEdit]);

  function commitInlineEdit(raw: string) {
    const name = raw.trim();
    const ie = inlineEditRef.current;
    if (!ie) return;
    inlineEditRef.current = null;
    setInlineEdit(null);
    setInlineVal("");
    if (ie.kind === "newCat") {
      if (!name) return;
      if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(name)) { alert("此名称为保留分类"); return; }
      const curCats = activeTab === "mine" ? curMineCats : activeTab === "bg" ? bgCats : mainCats;
      if (curCats.includes(name)) { alert("该名称已在本板块占用，请换一个"); return; }
      for (const s of sounds) { if (s.subCategory === name) { alert("该名称已被某个子分类占用，请换一个"); return; } }
      const takenKeys = new Set<string>();
      for (const s of sounds) { if (s.shortcut) takenKeys.add(s.shortcut.toLowerCase()); }
      for (const k of Object.values(catShortcuts)) { if (k) takenKeys.add(k.toLowerCase()); }
      if (takenKeys.has(name.toLowerCase())) { alert("该名称与现有音效键冲突，请换一个"); return; }
      if (activeTab === "mine") setCurMineCats(prev => prev.includes(name) ? prev : [...prev, name]);
      else if (activeTab === "bg") setBgCats(prev => prev.includes(name) ? prev : [...prev, name]);
      else setMainCats(prev => prev.includes(name) ? prev : [...prev, name]);
      setSelCat(name);
      setSelSub(ALL_SUB);
    } else if (ie.kind === "renameCat") {
      const oldName = ie.name;
      if (!name || name === oldName) return;
      if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(name)) { alert("此名称为保留分类"); return; }
      const curCats = activeTab === "mine" ? curMineCats : activeTab === "bg" ? bgCats : mainCats;
      if (!curCats.includes(oldName)) return;
      if (curCats.includes(name)) { alert("该名称在本板块已存在"); return; }
      if (activeTab === "mine") {
        const inPoolMine = (s: SoundItem) => s.mine && (mineFrom === "bg" ? isBgSound(s) : !isBgSound(s));
        setCurMineCats(prev => prev.map(c => c === oldName ? name : c));
        setSounds(prev => prev.map(s => inPoolMine(s) && s.category === oldName ? { ...s, category: name } : s));
      } else if (activeTab === "bg") {
        setBgCats(prev => prev.map(c => c === oldName ? name : c));
        setSounds(prev => prev.map(s => soundPool(s) === "bg" && s.category === oldName ? { ...s, category: name } : s));
      } else {
        setMainCats(prev => prev.map(c => c === oldName ? name : c));
        setSounds(prev => prev.map(s => soundPool(s) === "main" && s.category === oldName ? { ...s, category: name } : s));
      }
      if (selCat === oldName) setSelCat(name);
      setCatShortcuts(prev => {
        const oldKey = catSKey(poolOfTab(activeTab), oldName);
        if (!(oldKey in prev)) return prev;
        const next = { ...prev }; next[catSKey(poolOfTab(activeTab), name)] = next[oldKey]; delete next[oldKey]; return next;
      });
      setSubCatReg(prev => {
        if (!(oldName in prev)) return prev;
        const next = { ...prev }; next[name] = next[oldName]; delete next[oldName]; return next;
      });
    } else if (ie.kind === "newSub") {
      const parent = ie.parent;
      if (!name) return;
      if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(name)) { alert("此名称为保留分类"); return; }
      const takenCats = new Set<string>([...mainCats, ...bgCats, ...mineCats, ...mineBgCats]);
      for (const s of sounds) { if (s.subCategory) takenCats.add(s.subCategory); }
      for (const subs of Object.values(subCatReg)) for (const sub of subs) takenCats.add(sub);
      if (takenCats.has(name)) { alert("该名称已被其他音效分类占用，请换一个"); return; }
      const takenKeys = new Set<string>();
      for (const s of sounds) { if (s.shortcut) takenKeys.add(s.shortcut.toLowerCase()); }
      for (const k of Object.values(catShortcuts)) { if (k) takenKeys.add(k.toLowerCase()); }
      if (takenKeys.has(name.toLowerCase())) { alert("该名称与现有音效键冲突，请换一个"); return; }
      setSubCatReg(prev => {
        const cur = prev[parent] ?? [];
        if (cur.includes(name)) return prev;
        return { ...prev, [parent]: [...cur, name] };
      });
      setSelCat(parent);
      setSelSub(name);
    } else if (ie.kind === "renameSub") {
      const oldName = ie.name;
      if (!name || name === oldName) return;
      if ((VIRTUAL_SOUND_CATS as readonly string[]).includes(name)) { alert("此名称为保留分类"); return; }
      const takenCats = new Set<string>([...mainCats, ...bgCats, ...mineCats, ...mineBgCats]);
      for (const s of sounds) { if (s.subCategory && s.subCategory !== oldName) takenCats.add(s.subCategory); }
      for (const subs of Object.values(subCatReg)) for (const sub of subs) if (sub !== oldName) takenCats.add(sub);
      if (takenCats.has(name)) { alert("该名称已被其他分类占用，请换一个"); return; }
      const inPool = (s: SoundItem) => activeTab === "bg" ? soundPool(s) === "bg" : activeTab === "mine" ? (s.mine && (mineFrom === "bg" ? isBgSound(s) : !isBgSound(s))) : soundPool(s) === "main";
      setSounds(prev => prev.map(s =>
        inPool(s) && (s.subCategory ?? "") === oldName ? { ...s, subCategory: name } : s
      ));
      setSubCatReg(prev => {
        const next: Record<string, string[]> = {};
        for (const [k, arr] of Object.entries(prev)) {
          next[k] = arr.map(x => x === oldName ? name : x);
        }
        return next;
      });
      if (selSub === oldName) setSelSub(name);
    }
  }
  function cancelInlineEdit() { inlineEditRef.current = null; setInlineEdit(null); setInlineVal(""); }

  function startDragLongPress(e: React.PointerEvent, kind: 'cat' | 'sub', name: string) {
    if (kind === 'cat' && (VIRTUAL_SOUND_CATS as readonly string[]).includes(name)) return;
    const startX = e.clientX; const startY = e.clientY;
    dragLongPressRef.current = setTimeout(() => {
      dragItemRef.current = { kind, name };
      setDragItem({ kind, name });
      setDragPos({ x: startX, y: startY });
    }, 500);
  }
  function cancelDragLongPress() {
    if (dragLongPressRef.current) { clearTimeout(dragLongPressRef.current); dragLongPressRef.current = null; }
  }

  useEffect(() => {
    if (!dragItem) return;
    function onPointerMove(e: PointerEvent) {
      setDragPos({ x: e.clientX, y: e.clientY });
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (dragItemRef.current?.kind === 'cat') {
        const pillEl = el?.closest('[data-cat-pill]');
        const pillName = pillEl?.getAttribute('data-cat-pill') ?? null;
        if (pillName && pillName !== dragItemRef.current.name) {
          dragOverTargetRef.current = pillName;
          setDragOverTarget(pillName);
          return;
        }
        const subEl = subBarRef.current;
        const overSub = !!(subEl && el && (subEl === el || subEl.contains(el)));
        const t = overSub ? 'subbar' : null;
        dragOverTargetRef.current = t;
        setDragOverTarget(t);
      } else {
        const catEl = catBarRef.current;
        const overCat = !!(catEl && el && (catEl === el || catEl.contains(el)));
        if (overCat) {
          dragOverTargetRef.current = 'catbar';
          setDragOverTarget('catbar');
          return;
        }
        // sub→sub 拖拽排序检测
        const subPillEl = el?.closest('[data-sub-pill]');
        const subPillName = subPillEl?.getAttribute('data-sub-pill') ?? null;
        if (subPillName && subPillName !== dragItemRef.current?.name) {
          dragOverTargetRef.current = subPillName;
          setDragOverTarget(subPillName);
          return;
        }
        dragOverTargetRef.current = null;
        setDragOverTarget(null);
      }
    }
    function onPointerUp() {
      const di = dragItemRef.current;
      const target = dragOverTargetRef.current;
      dragItemRef.current = null;
      dragOverTargetRef.current = null;
      setDragItem(null);
      setDragOverTarget(null);
      if (di && target) setPendingDrop({ kind: di.kind, name: di.name, target });
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [dragItem]);

  useEffect(() => {
    if (!pendingDrop) return;
    const { kind, name, target } = pendingDrop;
    setPendingDrop(null);
    if (kind === 'cat') {
      if (target === 'subbar') {
        // 拖到二级栏 → 降级为子分类
        const sc = selCatRef.current;
        if (sc && !(VIRTUAL_SOUND_CATS as readonly string[]).includes(sc) && sc !== name) moveCatUnder(name, sc);
      } else {
        // 拖到另一个一级分类 → 调整排序（插入到目标位置）
        const cats = activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats;
        const fromIdx = cats.indexOf(name);
        const toIdx = cats.indexOf(target);
        if (fromIdx >= 0 && toIdx >= 0) {
          const reordered = [...cats];
          reordered.splice(fromIdx, 1);
          reordered.splice(toIdx, 0, name);
          applyCatOrder(reordered);
        }
      }
    } else {
      if (target === 'catbar') {
        // 拖到一级栏 → 升级为一级分类
        promoteSubCat(name);
      } else {
        // 拖到另一个二级分类 → 调整排序
        const sc = selCatRef.current;
        if (!sc) return;
        const reg = subCatReg[sc] ?? [];
        const seen: string[] = [...reg];
        for (const s of tabSounds) {
          if (s.category === sc && s.subCategory && !seen.includes(s.subCategory)) seen.push(s.subCategory);
        }
        const fromIdx = seen.indexOf(name);
        const toIdx = seen.indexOf(target);
        if (fromIdx >= 0 && toIdx >= 0) {
          const reordered = [...seen];
          reordered.splice(fromIdx, 1);
          reordered.splice(toIdx, 0, name);
          setSubCatReg(prev => ({ ...prev, [sc]: reordered.filter(s => s !== UNCAT) }));
        }
      }
    }
  }, [pendingDrop]);
  // On tab switch, if the current first-level category has no sounds in the new
  // tab, jump to the first category that does so the list isn't empty.
  useEffect(() => {
    if (activeTab !== "main" && activeTab !== "bg" && activeTab !== "mine") return;
    if (selCat === "收藏") return;
    const cats = activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats;
    if (cats.includes(selCat)) return;
    if (cats.length > 0) setSelCat(cats[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  const [kbdAssignKey, setKbdAssignKey] = useState<string | null>(null);
  // 快捷键冲突确认弹窗状态：待绑定的目标音效 id + 当前占用者名称
  const [keyConflictDialog, setKeyConflictDialog] = useState<{ soundId: string; takenByName: string; functionId?: string } | null>(null);
  // 捕获键位并进入「待绑定」状态（供 kbd tab 点击和模拟键盘共用）。
  const captureKey = (rawKey: string) => {
    const k = keyboardTokenToShortcut(rawKey);
    if (!k) return;
    setKbdAssignKey(k);
  };
  // 实际执行绑定（冲突确认后调用）。
  const doAssign = (soundId: string, key: string) => {
    setSounds(prev => prev.map(s => {
      if (s.id === soundId) return { ...s, shortcut: key };
      if (s.shortcut === key) return { ...s, shortcut: undefined };
      return s;
    }));
    setKbdAssignKey(null);
    setKeyConflictDialog(null);
  };
  // 完成绑定入口：若键已被占用则先弹确认，否则直接绑定。
  const confirmAssign = (soundId: string) => {
    if (!kbdAssignKey) return;
    const takenBy = sounds.find(s => s.shortcut === kbdAssignKey && s.id !== soundId);
    if (takenBy) {
      setKeyConflictDialog({ soundId, takenByName: takenBy.name });
      return;
    }
    const functionConflict = findFunctionConflict(funcShortcuts, kbdAssignKey);
    if (functionConflict) {
      setKeyConflictDialog({
        soundId,
        takenByName: `功能快捷键：${functionConflict.label}`,
        functionId: functionConflict.id,
      });
      return;
    }
    doAssign(soundId, kbdAssignKey);
  };
  // 清空全部音效的快捷键绑定。
  function clearAllShortcuts() {
    if (!window.confirm("确定要清空所有音效的快捷键绑定吗？此操作不可撤销。")) return;
    setSounds(prev => prev.map(s => ({ ...s, shortcut: undefined })));
  }
  const [showSimKb, setShowSimKb] = useState(false);
  const simKbWrapRef = useRef<HTMLDivElement>(null);
  const simKbInnerRef = useRef<HTMLDivElement>(null);
  const [simKb, setSimKb] = useState<{ scale: number; h: number }>({ scale: 1, h: 0 });
  useEffect(() => {
    if (!showSimKb) return;
    const wrap = simKbWrapRef.current;
    const inner = simKbInnerRef.current;
    if (!wrap || !inner) return;
    const measure = () => {
      const avail = wrap.clientWidth;
      const natW = inner.scrollWidth;
      const natH = inner.scrollHeight;
      if (natW > 0 && avail > 0) {
        const scale = Math.max(0.4, Math.min(2.2, avail / natW * 0.9));
        const h = Math.round(natH * scale) + 8;
        setSimKb(prev => (Math.abs(prev.scale - scale) < 0.002 && prev.h === h) ? prev : { scale, h });
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, [showSimKb, sounds]);
  // Esc 关闭模拟键盘浮层，同时清除待绑定状态。
  useEffect(() => {
    if (!showSimKb) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setShowSimKb(false); setKbdAssignKey(null); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showSimKb]);
  const [showAbout, setShowAbout] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [appSettings, setAppSettings] = useState<{
    windowPinned: boolean;
    shiftShortcuts: boolean;
    volumeStep: number;
    fadePlay: boolean;
    fadeMs: number;
    cardFontPct: number;
    showShortcutBelowName: boolean;
    layoutMode: "default" | "compact" | "wide";
    tapNoStop: boolean;
    shortcutsEnabled: boolean;
    shortcutMode: "register" | "listen";
  }>(() => {
    // shortcutsEnabled 跟随 FloatSoundPanel 的独立开关（jt_float_shortcuts_enabled）。
    // 默认关闭（仅当明确存为 "1" 时才开），与 FloatSoundPanel/main.js 三端保持一致。
    const floatShortcutsOn = window.electronAPI?.isElectron ? false : (() => {
      try { return localStorage.getItem("jt_float_shortcuts_enabled") === "1"; } catch { return false; }
    })();
    const defaults = { windowPinned: false, shiftShortcuts: true, volumeStep: 10, fadePlay: false, fadeMs: 200, cardFontPct: 100, showShortcutBelowName: true, layoutMode: "default" as const, tapNoStop: false, shortcutsEnabled: floatShortcutsOn, shortcutMode: "register" as const };
    try {
      const raw = getPersisted("jt_sound_settings");
      if (raw) {
        // 以 FloatSoundPanel 的持久化值为准（覆盖 jt_sound_settings 里的旧值）
        return { ...defaults, ...(JSON.parse(raw) as Partial<typeof defaults>), shortcutsEnabled: floatShortcutsOn };
      }
    } catch {}
    return defaults;
  });
  useEffect(() => {
    try { setPersisted("jt_sound_settings", JSON.stringify(appSettings)); } catch {}
  }, [appSettings]);
  // 把快捷键模式镜像到独立 key，供音效引擎（题词器全局监听）同步读取。
  useEffect(() => {
    try { setPersisted("jt_shortcut_mode", appSettings.shortcutMode); } catch {}
  }, [appSettings.shortcutMode]);
  const setSet = <K extends keyof typeof appSettings>(k: K, v: (typeof appSettings)[K]) => setAppSettings(prev => ({ ...prev, [k]: v }));

  // Electron 桌面版：悬浮快捷键开关双向同步（非 Electron 环境静默忽略）
  useElectronHotkeySync(appSettings.shortcutsEnabled, (v) => {
    setSet("shortcutsEnabled", v);
    try { localStorage.setItem("jt_float_shortcuts_enabled", v ? "1" : "0"); } catch {}
  });

  // FloatSoundPanel 快捷键开关联动：接收 FloatSoundPanel 的状态变化并同步到本页面
  useEffect(() => {
    const handler = (e: Event) => {
      const { enabled } = (e as CustomEvent<{ enabled: boolean }>).detail;
      setSet("shortcutsEnabled", enabled);
    };
    window.addEventListener("jt-float-shortcuts-change", handler);
    return () => window.removeEventListener("jt-float-shortcuts-change", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Electron 全局快捷键注册 -----------------------------------------------
  // 每当 sounds 的 globalShortcut 字段发生变化，就重新向主进程注册一遍。
  // 主进程的 _gsHandlers 会缓存这份注册；hotkeyEnabled 状态决定是否激活 OS 层。
  const _gsKey = useMemo(
    () => `${appSettings.shortcutMode}|${sounds.map(s => `${s.id}:${s.shortcut ?? ""}:${s.globalShortcut ?? ""}`).join("|")}`,
    [sounds, appSettings.shortcutMode]
  );
  const _soundsGsRef = useRef(sounds);
  _soundsGsRef.current = sounds;
  const _triggerSoundGsRef = useRef(triggerSound);
  _triggerSoundGsRef.current = triggerSound;
  // 全局快捷键用 tryTrigger ref（在 tryTrigger 定义之后赋值，见下方），让 BGM 类型走正确的 playBgm 路径。
  const _tryTriggerGsRef = useRef<(id: string, replay?: boolean, scope?: PlayerScope) => void>(() => {});
  useEffect(() => {
    if (typeof window === "undefined" || !("electronGS" in window)) return;
    if (window.electronAPI?.isAudioWorker) return;
    const bridge = getGlobalShortcutBridge();
    let alive = true;
    void (async () => {
      await bridge.unregisterAll();
      if (!alive) return;
      const registered = new Set<string>();
      for (const s of _soundsGsRef.current) {
        for (const binding of [appSettings.shortcutMode === "register" && s.shortcut ? directShortcutToAccelerator(s.shortcut) : undefined, s.globalShortcut]) {
          if (!alive || !binding || registered.has(binding)) continue;
          registered.add(binding);
          const sid = s.id;
          await bridge.register(binding, () => {
            _tryTriggerGsRef.current(sid, false, "kbd");
          });
        }
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_gsKey]);

  // ---- 功能快捷键（全局功能动作 → 单键/组合键绑定）---------------------------
  const [funcShortcuts, setFuncShortcuts] = useState<Record<string, string>>(loadFuncShortcuts);
  useEffect(() => { try { setPersisted(FUNC_SHORTCUTS_KEY, JSON.stringify(funcShortcuts)); } catch {} }, [funcShortcuts]);
  // 始终指向最新的 funcShortcuts 状态，供 keydown 捕获阶段安全读取（无需加入 useEffect 依赖）
  const funcShortcutsRef = useRef(funcShortcuts);
  funcShortcutsRef.current = funcShortcuts;
  // ---- MIDI 时间码设置 -------------------------------------------------------
  const [showMidi, setShowMidi] = useState(false);
  const [showFuncPanel, setShowFuncPanel] = useState(false);
  const [selectedFuncId, setSelectedFuncId] = useState<FuncActionId>(FUNC_ACTIONS[0].id);
  const [funcCapture, setFuncCapture] = useState<FuncActionId | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const batchRebindFileRef = useRef<HTMLInputElement>(null);
  const batchFolderRef = useRef<HTMLInputElement>(null);
  const batchZipRef = useRef<HTMLInputElement>(null);
  const lastPersistedRef = useRef<SoundItem[]>(sounds);
  const soundsRef = useRef<SoundItem[]>(sounds);
  soundsRef.current = sounds;
  const isRollingBackRef = useRef(false);

  // 启动兜底清扫：浏览器关闭/刷新时 beforeunload 里的异步 IndexedDB 删除不保证执行完，
  // 可能留下无任何音效引用的「孤儿」blob。挂载时做一次扫描，删除所有不被当前音效列表
  // 引用的音频 blob 以回收空间。只在加载时跑一次，且只删确实没有引用的 blob，
  // 不碰正在使用或处于撤销窗口的音频，因此不会影响撤销/恢复流程。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await listAudioIds();
        if (cancelled || stored.length === 0) return;
        const referenced = new Set(
          soundsRef.current.filter(s => s.hasAudio).map(s => s.id)
        );
        const orphans = stored.filter(id => !referenced.has(id));
        if (orphans.length > 0) await deleteAudioBlobs(orphans);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- Batch import handlers ------------------------------------------------
  const handleFolderPicked = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const entries = entriesFromFolder(files);
    const root = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] || "文件夹";
    const used = new Set(soundsRef.current.filter(s => s.shortcut).map(s => s.shortcut!));
    const drafts = buildDrafts(entries, used);
    if (drafts.length === 0) { alert("文件夹中未找到可导入的音频文件"); return; }
    setBatchSource(`文件夹：${root}（${drafts.length} 个音效）`);
    setBatchDrafts(drafts);
  }, []);

  const handleZipPicked = useCallback(async (file: File | null) => {
    if (!file) return;
    try {
      const entries = await entriesFromZip(file);
      const used = new Set(soundsRef.current.filter(s => s.shortcut).map(s => s.shortcut!));
      const drafts = buildDrafts(entries, used);
      if (drafts.length === 0) { alert("ZIP 包中未找到可导入的音频文件"); return; }
      setBatchSource(`ZIP 包：${file.name}（${drafts.length} 个音效）`);
      setBatchDrafts(drafts);
    } catch (e) {
      alert("解析 ZIP 失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }, []);

  const confirmBatchImport = useCallback(async () => {
    if (!batchDrafts || batchDrafts.length === 0) return;
    setBatchBusy(true);
    const ac = new AbortController();
    batchAbortRef.current = ac;
    const draftsSnapshot = batchDrafts;
    setBatchDrafts(null);
    setBatchSource("");
    const total = draftsSnapshot.length;
    setImportProgress({ done: 0, total, title: "正在写入音频…", cancelLabel: "取消导入", onCancel: () => ac.abort() });
    const writtenIds: string[] = [];
    try {
      const newItems: SoundItem[] = [];
      const newMainCats = new Set<string>();
      const newBgCats = new Set<string>();
      const newSubCatReg: Record<string, string[]> = {};
      let done = 0;
      for (const d of draftsSnapshot) {
        if (ac.signal.aborted) {
          if (writtenIds.length) { try { await deleteAudioBlobs(writtenIds); } catch {} }
          setBatchCancelToast({ key: Date.now() });
          return;
        }
        const newId = uid();
        try { await putAudioBlob(newId, d.file, undefined, d.file.name); writtenIds.push(newId); }
        catch (e) {
          // Roll back any blobs already written so we don't leave orphans in IndexedDB.
          if (writtenIds.length) { try { await deleteAudioBlobs(writtenIds); } catch {} }
          alert(`保存「${d.name}」音频失败：` + (e instanceof Error ? e.message : String(e)));
          return;
        }
        done++;
        setImportProgress({ done, total, title: "正在写入音频…", cancelLabel: "取消导入", onCancel: () => ac.abort() });
        const isLoop = d.mode === "loop";
        const cat = d.category.trim() || (isLoop ? "背景音乐" : "短音效");
        const sub = d.subCategory?.trim() || UNCAT;
        newItems.push({
          id: newId,
          name: d.name.trim() || d.file.name,
          type: isLoop ? "bgm" : "short",
          category: cat,
          subCategory: sub,
          volume: d.volume,
          loop: isLoop,
          shortcut: d.shortcut || undefined,
          hasAudio: true,
        });
        (isLoop ? newBgCats : newMainCats).add(cat);
        if (sub) {
          if (!newSubCatReg[cat]) newSubCatReg[cat] = [];
          if (!newSubCatReg[cat].includes(sub)) newSubCatReg[cat].push(sub);
        }
      }
      setMainCats(prev => [...prev, ...Array.from(newMainCats).filter(c => !prev.includes(c))]);
      setBgCats(prev => [...prev, ...Array.from(newBgCats).filter(c => !prev.includes(c))]);
      setSubCatReg(prev => {
        const merged = { ...prev };
        for (const [cat, subs] of Object.entries(newSubCatReg)) {
          const existing = merged[cat] ?? [];
          merged[cat] = [...existing, ...subs.filter(s => !existing.includes(s))];
        }
        return merged;
      });
      setSounds(prev => [...prev, ...newItems]);
      setImportToast({ result: { added: newItems.length, replaced: 0, skipped: 0, total: newItems.length }, key: Date.now() });
    } finally {
      setBatchBusy(false);
      setImportProgress(null);
      batchAbortRef.current = null;
    }
  }, [batchDrafts]);

  // ---- Undo-last-delete -----------------------------------------------------
  // 删除音效后给一个短暂的撤销窗口（与话术管理一致）。只保留最近一次删除，新的
  // 删除会让上一条撤销失效。撤销窗口内对应音频文件不会被 IndexedDB 清理，撤销时
  // 直接复原元数据即可；窗口结束（或被新删除取代）后才真正删除残留音频。
  const UNDO_TIMEOUT_MS = 7000;
  type PendingSoundUndo = { items: { sound: SoundItem; index: number }[]; label: string; expiresAt: number };
  const [pendingSoundUndo, setPendingSoundUndo] = useState<PendingSoundUndo | null>(null);
  const pendingUndoRef = useRef<PendingSoundUndo | null>(null);
  // 多选：选中的音效 id 集合 + 区间选锚点（最近一次单击/Ctrl 点击的卡片）。
  const [selectedSoundIds, setSelectedSoundIds] = useState<Set<string>>(new Set());
  const selectAnchorRef = useRef<string | null>(null);
  // 拖拽框选（橡皮筋）状态：marqueeRect 为正在绘制的选择框（视口坐标，position:fixed 渲染），
  // marqueeDragRef 记录起点/追加基准集合/是否已越过移动阈值。
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const marqueeDragRef = useRef<{ x0: number; y0: number; base: Set<string>; active: boolean } | null>(null);
  // 处于撤销窗口、暂不允许被裁剪的音频条目（id -> 删除前的快照），用于在持久化
  // 副作用里把它们排除出"已移除"集合，从而保住 IndexedDB 里的 blob。
  const protectedItemsRef = useRef<Map<string, SoundItem>>(new Map());

  // 集中清理已确认删除的音效所留下的孤儿记录。
  // 当前唯一的"按音效 id 独立持久化"的数据是 jt_audio IndexedDB 里的音频 blob；
  // 其余设置（颜色、音量、快捷键、收藏顺序、剪辑点等）均内联在 SoundItem 对象内，
  // 随音效从 jt_sounds 数组删除而自动消失，无需单独清理。
  // 如将来新增按音效 id 存储的独立记录（如每音效音量覆盖 map 等），在此统一处理。
  function purgeSoundOrphans(ids: string[], snapshot: SoundItem[]) {
    // 音频 blob：只删"确实已不在列表里"的条目，避免误删仍被引用的 blob。
    const present = new Set(soundsRef.current.map(s => s.id));
    const audioIds = ids.filter(id => {
      const s = snapshot.find(x => x.id === id);
      return !!s?.hasAudio && !present.has(id);
    });
    if (audioIds.length) void deleteAudioBlobs(audioIds);
  }

  function finalizePendingUndo(u: PendingSoundUndo) {
    const ids: string[] = [];
    for (const it of u.items) {
      protectedItemsRef.current.delete(it.sound.id);
      ids.push(it.sound.id);
    }
    purgeSoundOrphans(ids, u.items.map(it => it.sound));
  }

  function deleteSoundWithUndo(id: string) {
    deleteSoundsWithUndo([id]);
  }

  function handleDeduplicateSounds() {
    setShowMenu(false);
    const byName = new Map<string, SoundItem[]>();
    for (const s of sounds) {
      const key = s.name.trim();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(s);
    }
    const toDelete: SoundItem[] = [];
    for (const [, group] of byName) {
      if (group.length <= 1) continue;
      // 优先保留有音频的，同等则保留列表靠前的
      const sorted = [...group].sort((a, b) => (b.hasAudio ? 1 : 0) - (a.hasAudio ? 1 : 0));
      toDelete.push(...sorted.slice(1));
    }
    if (toDelete.length === 0) {
      alert("未发现同名重复音效，无需清理");
      return;
    }
    const preview = toDelete.slice(0, 8).map(s => `· ${s.name}`).join("\n");
    const more = toDelete.length > 8 ? `\n…等共 ${toDelete.length} 条` : "";
    const ok = confirm(
      `发现 ${toDelete.length} 个同名重复音效（每组保留一条，优先保留有音频的）。\n\n将删除：\n${preview}${more}\n\n删除后可在 7 秒内撤销。确认清理？`
    );
    if (!ok) return;
    deleteSoundsWithUndo(toDelete.map(s => s.id));
  }

  // 一次性删除多条音效并给一次整体撤销（复用 pendingSoundUndo 的 items 数组）。
  function deleteSoundsWithUndo(ids: string[]) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const items = sounds
      .map((sound, index) => ({ sound, index }))
      .filter(it => idSet.has(it.sound.id));
    if (items.length === 0) return;
    // 新删除取代上一条待撤销项：先把它的残留音频真正清掉。
    const prev = pendingUndoRef.current;
    if (prev) finalizePendingUndo(prev);
    for (const it of items) {
      if (it.sound.hasAudio) protectedItemsRef.current.set(it.sound.id, it.sound);
    }
    setSounds(p => p.filter(x => !idSet.has(x.id)));
    // 删掉的若包含当前多选项，顺手把它们移出选中集合。
    if (selectedSoundIds.size > 0) {
      setSelectedSoundIds(prevSel => {
        if (![...idSet].some(id => prevSel.has(id))) return prevSel;
        const next = new Set(prevSel);
        for (const id of idSet) next.delete(id);
        return next;
      });
    }
    const label = items.length === 1 ? items[0].sound.name : `${items.length} 个音效`;
    const u: PendingSoundUndo = { items, label, expiresAt: Date.now() + UNDO_TIMEOUT_MS };
    pendingUndoRef.current = u;
    setPendingSoundUndo(u);
  }

  const handleSoundUndo = () => {
    const u = pendingUndoRef.current;
    if (!u) return;
    pendingUndoRef.current = null;
    setPendingSoundUndo(null);
    const restoreIds: string[] = [];
    for (const it of u.items) {
      protectedItemsRef.current.delete(it.sound.id);
      if (it.sound.hasAudio) restoreIds.push(it.sound.id);
    }
    setSounds(prev => {
      const next = [...prev];
      const sorted = [...u.items].sort((a, b) => a.index - b.index);
      for (const it of sorted) {
        const at = Math.max(0, Math.min(it.index, next.length));
        next.splice(at, 0, it.sound);
      }
      return next;
    });
    if (restoreIds.length) invalidateAudioCache(restoreIds);
  };

  // 卡片点选：Ctrl/⌘ 点切换单条、Shift 在当前列表内区间选。返回 true 表示已处理选择，
  // 卡片此时不应再触发播放。普通点击返回 false（仍按原逻辑播放音效）。
  function handleCardSelect(e: React.MouseEvent, id: string, list: SoundItem[]): boolean {
    if (e.shiftKey && selectAnchorRef.current) {
      const a = list.findIndex(x => x.id === selectAnchorRef.current);
      const b = list.findIndex(x => x.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const next = new Set(selectedSoundIds);
        for (let k = lo; k <= hi; k++) next.add(list[k].id);
        setSelectedSoundIds(next);
        selectAnchorRef.current = id;
        return true;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedSoundIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedSoundIds(next);
      selectAnchorRef.current = id;
      return true;
    }
    return false;
  }

  // 拖拽框选（橡皮筋）：在卡片网格空白处按下并拖动出现选择框，框内的音效卡片并入
  // selectedSoundIds（与 Ctrl/⌘ 点选、Shift 区间选共用多选集合）。按住 Shift/Ctrl/⌘
  // 起拖为追加模式（保留已选），否则替换。命中检测用各卡片 [data-sound-id] 的视口矩形。
  function handleMarqueeMove(e: MouseEvent) {
    const d = marqueeDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.active && Math.abs(dx) < 5 && Math.abs(dy) < 5) return; // 移动阈值，避免误触
    d.active = true;
    e.preventDefault();
    const left = Math.min(e.clientX, d.x0), top = Math.min(e.clientY, d.y0);
    const right = Math.max(e.clientX, d.x0), bottom = Math.max(e.clientY, d.y0);
    setMarqueeRect({ left, top, width: right - left, height: bottom - top });
    const next = new Set(d.base);
    const container = scrollAreaRef.current;
    if (container) {
      container.querySelectorAll<HTMLElement>("[data-sound-id]").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
          const id = el.getAttribute("data-sound-id");
          if (id) next.add(id);
        }
      });
    }
    setSelectedSoundIds(next);
  }
  function handleMarqueeUp() {
    const d = marqueeDragRef.current;
    marqueeDragRef.current = null;
    setMarqueeRect(null);
    window.removeEventListener("mousemove", handleMarqueeMove);
    window.removeEventListener("mouseup", handleMarqueeUp);
    if (d?.active) selectAnchorRef.current = null;
  }
  function handleMarqueeMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    // 落在卡片上（或其内部按钮）时交给卡片自身处理，不启动框选。
    if ((e.target as HTMLElement).closest("[data-sound-id]")) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    marqueeDragRef.current = { x0: e.clientX, y0: e.clientY, base: additive ? new Set(selectedSoundIds) : new Set(), active: false };
    window.addEventListener("mousemove", handleMarqueeMove);
    window.addEventListener("mouseup", handleMarqueeUp);
  }
  // Ctrl/⌘+Z 在撤销窗口内等价于点击撤销按钮；焦点在输入框/textarea/contenteditable
  // 时让浏览器/字段自己处理撤销，没有待撤销项时不拦截默认行为。
  const handleUndoShortcutRef = useRef<() => void>(() => {});
  handleUndoShortcutRef.current = handleSoundUndo;
  // 倒计时与进度条由 CountdownToast 负责（悬停暂停 / 移开恢复）；到时回调里
  // 收尾残留音频并清空待撤销项。
  const expirePendingUndo = useCallback(() => {
    const u = pendingUndoRef.current;
    if (u) finalizePendingUndo(u);
    pendingUndoRef.current = null;
    setPendingSoundUndo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 撤销窗口未结束就离开页面时（组件卸载 / 关闭或刷新页面），对仍处于撤销窗口、
  // 未被恢复的条目执行一次最终清理，避免残留"孤儿"音频长期占用 IndexedDB。
  useEffect(() => {
    const finalize = () => {
      const u = pendingUndoRef.current;
      if (u) finalizePendingUndo(u);
      pendingUndoRef.current = null;
    };
    window.addEventListener("beforeunload", finalize);
    return () => {
      window.removeEventListener("beforeunload", finalize);
      finalize();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    function isEditable(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "z" && e.key !== "Z") return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (!pendingSoundUndo) return;
      if (isEditable(e.target)) return;
      e.preventDefault();
      handleUndoShortcutRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingSoundUndo]);

  useEffect(() => {
    if (isRollingBackRef.current) {
      isRollingBackRef.current = false;
      return;
    }
    const r = safeSaveSounds(sounds);
    if (r.ok) {
      const prev = lastPersistedRef.current;
      lastPersistedRef.current = sounds;
      // Clean up IndexedDB blobs for sounds that were removed in this update.
      // 处于撤销窗口的条目临时并入 next，避免它们的音频在撤销前被裁剪掉。
      const guarded = protectedItemsRef.current.size > 0
        ? sounds.concat([...protectedItemsRef.current.values()])
        : sounds;
      void pruneAudioBlobsForRemoved(prev, guarded);
      dispatchSoundsChange(sounds);
    } else {
      const prev = lastPersistedRef.current;
      const msg = `保存音效失败：${r.error instanceof Error ? r.error.message : String(r.error)}\n\n本次修改未保存，已恢复到上次状态。`;
      alert(msg);
      // 保存失败回滚：被删条目已被复原，撤销窗口失去意义且其音频不能再被清理。
      if (pendingUndoRef.current) {
        pendingUndoRef.current = null;
        protectedItemsRef.current.clear();
        setPendingSoundUndo(null);
      }
      isRollingBackRef.current = true;
      setSounds(prev);
    }
  }, [sounds]);

  // Verify on every sounds-change whether every "claims to have audio" item
  // actually has a blob in IndexedDB. Items whose only audio reference is a
  // legacy `blob:` URL are always dead after a refresh; flag them too.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = new Set<string>();
      for (const s of sounds) {
        if (s.hasAudio) {
          const ok = await hasAudioBlob(s.id);
          if (!ok) next.add(s.id);
        } else if (s.url) {
          // Legacy blob URL with no IndexedDB backup — guaranteed dead after refresh.
          next.add(s.id);
        }
      }
      if (cancelled) return;
      setMissingIds(prev => {
        if (prev.size === next.size && [...next].every(id => prev.has(id))) return prev;
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [sounds]);

  const showMissingToast = useCallback((name: string) => {
    setMissingToast({ text: `音频「${name}」已丢失，请重新拖入文件或在编辑面板重新绑定`, key: Date.now() });
  }, []);

  const triggerDeduperRef = useRef(createTriggerDeduper(80));
  const tryTrigger = useCallback((id: string, replay = false, scope: PlayerScope = playerScope) => {
    if (!triggerDeduperRef.current.shouldRun(id)) return;
    const s = sounds.find(x => x.id === id);
    if (!s) return;
    if (missingIds.has(id)) {
      showMissingToast(s.name);
      return;
    }
    setScopedTrackIds(prev => rememberScopedTrack(prev, scope, id));
    // 「再次单击不关闭音效」开启时，单击/快捷键改用 replay 语义：每次都（重新）播放，
    // 再次单击不会停止（复用与分类随机播放相同的 replay 旁路）。分类随机播放本就传 replay=true。
    const eff = true;
    // Background music plays on the exclusive BGM stream (with playlist modes);
    // host sound effects play directly, looping when the host-loop toggle is on.
    if (isBgSound(s)) {
      // BGM 单例：由 playBgmGlobal 负责停掉其他正在播放的 BGM，再次单击同一音效则暂停/恢复。
      const list = sounds.filter(x => isBgSound(x) && x.category === s.category && !!x.mine === !!s.mine).map(x => x.id);
      setBgmPlaylist(list);
      playBgm(id, eff);
    } else {
      triggerSound(id, hostLoop, eff);
    }
    // 每次触发都累计播放次数（收藏频率排序的数据来源）。
    setSounds(prev => prev.map(x => x.id === id ? { ...x, playCount: (x.playCount ?? 0) + 1, lastPlayedAt: Date.now() } : x));
  }, [sounds, missingIds, triggerSound, playBgm, setBgmPlaylist, hostLoop, showMissingToast, appSettings.tapNoStop, playerScope]);
  // 全局快捷键 ref 更新：每次 tryTrigger 更新后同步，确保快捷键触发 BGM 走正确路径。
  _tryTriggerGsRef.current = tryTrigger;

  const editing = editId ? sounds.find(s => s.id === editId) ?? null : null;
  const editFileInputRef = useRef<HTMLInputElement>(null);

  function requestRebind(id: string, file: File) {
    if (!isAudioFile(file)) { alert("仅支持音频文件"); return; }
    const url = URL.createObjectURL(file);
    setRebindConfirm(prev => {
      if (prev) { URL.revokeObjectURL(prev.url); if (prev.currentUrl) URL.revokeObjectURL(prev.currentUrl); }
      return { id, file, url, currentUrl: null };
    });
    // Load the currently bound audio (if any) so the user can A/B compare
    // before overwriting. Use a fresh object URL we own (not the shared cache)
    // so revoking it on close never breaks the playback engine.
    const target = soundsRef.current.find(s => s.id === id);
    if (target?.hasAudio) {
      void getAudioBlob(id).then(blob => {
        if (!blob) return;
        const curUrl = URL.createObjectURL(blob);
        setRebindConfirm(prev => {
          if (!prev || prev.id !== id || prev.url !== url) { URL.revokeObjectURL(curUrl); return prev; }
          if (prev.currentUrl) URL.revokeObjectURL(prev.currentUrl);
          return { ...prev, currentUrl: curUrl };
        });
      }).catch(() => {});
    }
  }

  function closeRebindConfirm() {
    setRebindConfirm(prev => {
      if (prev) { URL.revokeObjectURL(prev.url); if (prev.currentUrl) URL.revokeObjectURL(prev.currentUrl); }
      return null;
    });
    setRebindLibSelected(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; });
    setRebindLibOpen(false);
    setRebindLibSearch("");
    setRebindSyncName(true);
  }

  // 切换 / 清空试听条目时释放上一个 object URL（含组件卸载）。
  useEffect(() => {
    return () => { if (rebindPreview) URL.revokeObjectURL(rebindPreview.url); };
  }, [rebindPreview]);

  // 关闭批量重绑面板时一并停止并清掉试听。
  useEffect(() => {
    if (!batchRebind) setRebindPreview(null);
  }, [batchRebind]);

  // 试听批量重绑面板里某条目当前绑定的文件；再次点击同一条停止。
  // 旧 object URL 由上面的 effect 在 rebindPreview 变化时统一释放。
  function toggleRebindPreview(id: string, file: File) {
    if (rebindPreview?.id === id) { setRebindPreview(null); return; }
    setRebindPreview({ id, url: URL.createObjectURL(file) });
  }

  async function confirmRebind() {
    if (!rebindConfirm) return;
    const { id, file, url, currentUrl } = rebindConfirm;
    try { await putAudioBlob(id, file, undefined, file.name); }
    catch (e) { alert("保存音频失败：" + (e instanceof Error ? e.message : String(e))); return; }
    invalidateAudioCache([id]);
    setSounds(prev => prev.map(s => s.id === id ? { ...s, hasAudio: true, url: undefined } : s));
    URL.revokeObjectURL(url);
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    if (rebindLibSelected) { URL.revokeObjectURL(rebindLibSelected.url); setRebindLibSelected(null); }
    setRebindLibOpen(false);
    setRebindLibSearch("");
    setRebindConfirm(null);
  }

  async function confirmRebindFromLib() {
    if (!rebindConfirm || !rebindLibSelected) return;
    const { id, url, currentUrl } = rebindConfirm;
    try {
      const blob = await getAudioBlob(rebindLibSelected.id);
      if (!blob) { alert("无法读取所选音效的音频数据"); return; }
      await putAudioBlob(id, blob);
    } catch (e) {
      alert("保存音频失败：" + (e instanceof Error ? e.message : String(e)));
      return;
    }
    invalidateAudioCache([id]);
    const libName = rebindLibSelected.name;
    setSounds(prev => prev.map(s => {
      if (s.id !== id) return s;
      return { ...s, hasAudio: true, url: undefined, ...(rebindSyncName ? { name: libName } : {}) };
    }));
    URL.revokeObjectURL(url);
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    URL.revokeObjectURL(rebindLibSelected.url);
    setRebindLibSelected(null);
    setRebindLibOpen(false);
    setRebindLibSearch("");
    setRebindSyncName(true);
    setRebindConfirm(null);
  }

  async function selectRebindLibSound(s: SoundItem) {
    if (rebindLibSelected?.id === s.id) {
      URL.revokeObjectURL(rebindLibSelected.url);
      setRebindLibSelected(null);
      return;
    }
    try {
      const blob = await getAudioBlob(s.id);
      if (!blob) { alert("该音效没有绑定的音频数据"); return; }
      const newUrl = URL.createObjectURL(blob);
      setRebindLibSelected(prev => { if (prev) URL.revokeObjectURL(prev.url); return { id: s.id, name: s.name, url: newUrl }; });
    } catch (e) {
      alert("读取音频失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  function updateSound(id: string, patch: Partial<SoundItem>) {
    setSounds(prev => {
      let next = prev;
      if (patch.shortcut !== undefined) {
        const k = patch.shortcut ? patch.shortcut.toLowerCase() : undefined;
        if (k) {
          next = next.map(s => (s.id !== id && s.shortcut?.toLowerCase() === k ? { ...s, shortcut: undefined } : s));
        }
        patch = { ...patch, shortcut: k };
      }
      return next.map(s => (s.id === id ? { ...s, ...patch } : s));
    });
  }

  // 多选批量改属性：把同一个 patch 应用到所有选中的音效（音量/循环等），保持 localStorage 持久化.
  function batchUpdateSelected(patch: Partial<SoundItem>) {
    if (selectedSoundIds.size === 0) return;
    setSounds(prev => prev.map(s => selectedSoundIds.has(s.id) ? { ...s, ...patch } : s));
  }

  // 多选批量移动：把所有选中的音效一次性移到目标分类（可带子分类，留空=直接归到一级分类下）.
  function batchMoveSelected(category: string, subCategory: string) {
    if (selectedSoundIds.size === 0) return;
    setSounds(prev => prev.map(s => selectedSoundIds.has(s.id) ? { ...s, category, subCategory } : s));
    if (subCategory && category !== UNCAT) {
      setSubCatReg(prev => { const ex = prev[category] ?? []; if (ex.includes(subCategory)) return prev; return { ...prev, [category]: [...ex, subCategory] }; });
    }
    setBatchMoveMenu(null);
  }

  /**
   * Move a favorited sound up or down within the global favorite ordering.
   * Reassigns `favoriteOrder` for ALL favorites so the order is dense and
   * stable. Non-favorites are left untouched.
   */
  function moveFavorite(id: string, dir: -1 | 1) {
    setSounds(prev => {
      const favs = prev.filter(s => s.favorite);
      if (favs.length < 2) return prev;
      // Resolve current order: explicit favoriteOrder first, then legacy
      // "shortcut first" rule, then original array index for stability.
      const indexOf = new Map(prev.map((s, i) => [s.id, i]));
      const ordered = [...favs].sort((a, b) => {
        const ao = a.favoriteOrder, bo = b.favoriteOrder;
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        const ak = a.shortcut ? 0 : 1;
        const bk = b.shortcut ? 0 : 1;
        if (ak !== bk) return ak - bk;
        return (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0);
      });
      const i = ordered.findIndex(s => s.id === id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= ordered.length) return prev;
      const swapped = [...ordered];
      [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
      const rank = new Map(swapped.map((s, idx) => [s.id, idx]));
      return prev.map(s => (rank.has(s.id) ? { ...s, favoriteOrder: rank.get(s.id)! } : s));
    });
  }

  /**
   * 加入/取消收藏（单条）。
   * 加入时记录原来的 pool/category/subCategory；取消时恢复原分类（如已删则归未分类）。
   */
  function toggleFavorite(id: string) {
    setSounds(prev => prev.map(s => {
      if (s.id !== id) return s;
      if (s.favorite) {
        // 取消收藏：恢复原分类
        const pool = s.favoritePool;
        const cat = s.favoriteCategory ?? s.category;
        const catList = pool === "bg" ? bgCats : pool === "mine" ? [...mineCats, ...mineBgCats] : mainCats;
        const catExists = catList.includes(cat) || cat === UNCAT;
        return {
          ...s,
          favorite: false,
          favoritePool: undefined,
          favoriteCategory: undefined,
          favoriteSubCategory: undefined,
          favoriteAt: undefined,
          category: catExists ? cat : UNCAT,
          subCategory: catExists ? (s.favoriteSubCategory ?? s.subCategory) : undefined,
        };
      } else {
        // 加入收藏：记录当前 pool/分类
        return {
          ...s,
          favorite: true,
          favoriteAt: Date.now(),
          favoritePool: soundPool(s),
          favoriteCategory: s.category,
          favoriteSubCategory: s.subCategory,
        };
      }
    }));
  }

  /** 批量加入/取消收藏。setFav=true→全部加入收藏，false→全部取消收藏。 */
  function batchToggleFavorite(ids: string[], setFav: boolean) {
    setSounds(prev => prev.map(s => {
      if (!ids.includes(s.id)) return s;
      if (setFav && !s.favorite) {
        return { ...s, favorite: true, favoriteAt: Date.now(), favoritePool: soundPool(s), favoriteCategory: s.category, favoriteSubCategory: s.subCategory };
      } else if (!setFav && s.favorite) {
        const pool = s.favoritePool;
        const cat = s.favoriteCategory ?? s.category;
        const catList = pool === "bg" ? bgCats : pool === "mine" ? [...mineCats, ...mineBgCats] : mainCats;
        const catExists = catList.includes(cat) || cat === UNCAT;
        return { ...s, favorite: false, favoritePool: undefined, favoriteCategory: undefined, favoriteSubCategory: undefined, favoriteAt: undefined, category: catExists ? cat : UNCAT, subCategory: catExists ? (s.favoriteSubCategory ?? s.subCategory) : undefined };
      }
      return s;
    }));
  }

  // Precompute current favorite ordering so cards know whether ↑/↓ are enabled.
  const favoriteOrderInfo = (() => {
    const favs = sounds.filter(s => s.favorite);
    const indexOf = new Map(sounds.map((s, i) => [s.id, i]));
    const ordered = [...favs].sort((a, b) => {
      const ao = a.favoriteOrder, bo = b.favoriteOrder;
      if (ao != null && bo != null) return ao - bo;
      if (ao != null) return -1;
      if (bo != null) return 1;
      const ak = a.shortcut ? 0 : 1;
      const bk = b.shortcut ? 0 : 1;
      if (ak !== bk) return ak - bk;
      return (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0);
    });
    const pos = new Map(ordered.map((s, i) => [s.id, i]));
    return { count: ordered.length, pos };
  })();

  useEffect(() => {
    if (!editing || !shortcutCapture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setShortcutCapture(false); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        updateSound(editing.id, { shortcut: undefined });
        setShortcutCapture(false);
        setPendingShortcut(null); setPendingConflictName(null); setPendingSystemKeyName(null);
        return;
      }
      const k = directShortcutFromEvent(e) ?? "";
      if (!k) return;
      setShortcutCapture(false);
      // 检测占用
      const takenBy = soundsRef.current.find(s => s.shortcut?.toLowerCase() === k && s.id !== editing.id);
      const functionConflict = findFunctionConflict(funcShortcutsRef.current, k);
      // 检测系统键
      const sysName = SYSTEM_SHORTCUT_KEYS[k] ?? null;
      setPendingShortcut(k);
      setPendingConflictName(takenBy?.name ?? (functionConflict ? `功能快捷键：${functionConflict.label}` : null));
      setPendingFunctionConflictId(functionConflict?.id ?? null);
      setPendingSystemKeyName(sysName);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, shortcutCapture]);

  // 全局快捷键捕获（F1-F12 / Ctrl+N / Alt+N 等复合键）
  useEffect(() => {
    if (!editing || !globalShortcutCapture) return;
    setGsConflictMsg(null);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setGlobalShortcutCapture(false); setGsConflictMsg(null); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        updateSound(editing.id, { globalShortcut: undefined });
        setGlobalShortcutCapture(false); setGsConflictMsg(null);
        setPendingGlobalShortcut(null); setPendingGsConflictName(null);
        return;
      }
      const gs = parseGlobalShortcutFromEvent(e);
      if (!gs) {
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
          setGsConflictMsg("普通字母键容易误触，建议使用 F1–F12 或 Ctrl/Alt 组合键");
        }
        return;
      }
      setGlobalShortcutCapture(false);
      setGsConflictMsg(null);
      // 检测冲突：记录 pending 状态，由用户主动确认
      const conflict = soundsRef.current.find(s => s.id !== editing.id && s.globalShortcut === gs);
      setPendingGlobalShortcut(gs);
      setPendingGsConflictName(conflict?.name ?? null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, globalShortcutCapture, sounds]);

  // 右键菜单内联全局快捷键捕获（不打开编辑弹窗）
  useEffect(() => {
    if (!gsDirectCapture) return;
    const sid = gsDirectCapture;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setGsDirectCapture(null); setGsDirectCandidate(null); setGsDirectConflict(null); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        setGsDirectCandidate(""); setGsDirectConflict(null); return;
      }
      const gs = parseGlobalShortcutFromEvent(e);
      if (!gs) return;
      setGsDirectCandidate(gs);
      const globalOwner = sounds.find(s => s.id !== sid && s.globalShortcut === gs);
      if (globalOwner) {
        setGsDirectConflict({ kind: "sound-global", id: globalOwner.id, name: globalOwner.name });
        return;
      }
      const directOwner = sounds.find(s => s.id !== sid && s.shortcut && directShortcutToAccelerator(s.shortcut).toLowerCase() === gs.toLowerCase());
      if (directOwner) {
        setGsDirectConflict({ kind: "sound-direct", id: directOwner.id, name: directOwner.name });
        return;
      }
      const functionOwner = Object.entries(funcShortcutsRef.current).find(([, key]) => directShortcutToAccelerator(key).toLowerCase() === gs.toLowerCase() || key.toLowerCase() === gs.toLowerCase());
      if (functionOwner) {
        const action = FUNC_ACTIONS.find(x => x.id === functionOwner[0]);
        setGsDirectConflict({ kind: "function", id: functionOwner[0], name: `功能快捷键：${action?.label ?? functionOwner[0]}` });
        return;
      }
      setGsDirectConflict(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [gsDirectCapture, sounds]);

  const keyMap = Object.fromEntries(sounds.filter(s => s.shortcut).map(s => [s.shortcut!.toLowerCase(), s.id]));

  // 快捷键捕获/录制状态的实时 ref，避免将其加入依赖导致监听器频繁重建。
  const captureModeRef = useRef(false);
  captureModeRef.current = kbdAssignKey !== null || shortcutCapture || globalShortcutCapture || funcCapture !== null || gsDirectCapture !== null;

  useEffect(() => {
    const reg = appSettings.shortcutMode === "register";
    // 注册模式 + 快捷键启用 → 捕获阶段（优先于其他任何监听器），
    // 包括题词器滚屏键、文本输入框，确保音效快捷键始终生效。
    const useCapture = appSettings.shortcutsEnabled && reg;

    const down = (e: KeyboardEvent) => {
      if (!appSettings.shortcutsEnabled) return;
      // 快捷键录制/绑定期间退让，让专用录制监听器处理。
      if (captureModeRef.current) return;
      // IME 防护：Windows 中文输入法合字过程中 e.key 可能为 "Process"，跳过避免误触发。
      if (e.isComposing || e.key === "Process") return;
      // ── 全局快捷键（复合键）web 端监听 ─────────────────────────────────────────
      // Ctrl/Alt/Meta 修饰键或 F 键：优先检查 globalShortcut 绑定，匹配则触发并返回。
      // Windows 网页版无系统级快捷键桥，用 keydown 窗口聚焦模拟，效果与 Mac 网页版一致。
      if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) {
        const gsHit = _soundsGsRef.current.find(s => s.globalShortcut && matchesGlobalShortcut(e, s.globalShortcut));
        if (gsHit) {
          e.preventDefault();
          // 全局快捷键用切换语义（再次按 = 停止，不同于字母键 replay 语义）。
          _tryTriggerGsRef.current(gsHit.id, false, "kbd");
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
      }
      if (!shouldTriggerDirectShortcut(appSettings.shortcutMode, e.target)) return;
      const k = directShortcutFromEvent(e);
      if (!k) return;
      // 功能快捷键优先：若当前按键已被绑定为功能快捷键，退让给 useFuncShortcutListener 处理。
      // 注册模式（capture=true）下 down 先于 useFuncShortcutListener 触发，必须在此显式退出，
      // 否则 stopImmediatePropagation 会彻底屏蔽功能快捷键监听器。
      const pressedCombo = k === " " ? "space" : k;
      // 使用 ref 而非 loadFuncShortcuts()：避免 IndexedDB 未就绪时读到空快照，
      // 导致 stopImmediatePropagation 误屏蔽 useFuncShortcutListener。
      const funcSnap = funcShortcutsRef.current;
      if (Object.values(funcSnap).includes(pressedCombo)) return;
      setActiveKeys(prev => new Set([...prev, k]));
      const sid = keyMap[k];
      // 音效快捷键：replay 语义（再次触发不停止，而是重播）。
      // 注册模式下全面拦截：preventDefault + stopImmediatePropagation，
      // 确保文本框输入、题词器等不会同时收到该按键。
      if (sid) {
        if (reg && k !== " ") {
          e.preventDefault();
          if (useCapture) e.stopImmediatePropagation();
        }
        tryTrigger(sid, true, "kbd");
        return;
      }
      // 分类快捷键：
      // - 注册模式下同样全面拦截，不区分目标元素类型；
      // - 监听模式下保持原有行为，文本框内不拦截。
      if (!reg) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
      }
      const skeyForKey = Object.keys(catShortcuts).find(c => catShortcuts[c] === k);
      const parsed = skeyForKey ? parseCatSKey(skeyForKey) : null;
      if (parsed) {
        if (reg && k !== " ") {
          e.preventDefault();
          if (useCapture) e.stopImmediatePropagation();
        }
        const pool = sounds.filter(x => x.category === parsed.cat
          && soundPool(x) === parsed.pool && !missingIds.has(x.id));
        if (pool.length) tryTrigger(pool[Math.floor(Math.random() * pool.length)].id, true, "kbd");
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = directShortcutFromEvent(e);
      if (!k) return;
      setActiveKeys(prev => { const n = new Set(prev); n.delete(k); return n; });
    };
    window.addEventListener("keydown", down, useCapture);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down, useCapture);
      window.removeEventListener("keyup", up);
    };
  }, [sounds, playing, catShortcuts, bgCats, mineCats, mineBgCats, missingIds, tryTrigger, keyMap, appSettings.shortcutsEnabled, appSettings.shortcutMode]);

  // 执行某个功能动作（功能快捷键触发或面板内调试）。用 ref 让全局监听始终拿到最新闭包。
  const runFuncAction = useCallback((id: string) => {
    const step = appSettings.volumeStep;
    switch (id) {
      case "sfxStop": stopAll(); break;
      case "sfxPause": {
        const nonBgmPlaying = [...playing].filter(x => x !== bgmCurrentId);
        if (nonBgmPlaying.length) nonBgmPlaying.forEach(x => pauseResume(x));
        else [...paused].filter(x => x !== bgmCurrentId).forEach(x => pauseResume(x));
        break;
      }
      case "sfxVolUp": setMasterVol(Math.min(100, masterVol + step)); break;
      case "sfxVolDown": setMasterVol(Math.max(0, masterVol - step)); break;
      case "toggleLoop": setHostLoop(!hostLoop); break;
      case "duck": setDuckEnabled(!duckEnabled); break;
      case "bgmPlayPause": if (bgmCurrentId) pauseResume(bgmCurrentId); break;
      case "bgmPrev": bgmPrev(); break;
      case "bgmNext": bgmNext(); break;
      case "bgmVolUp": case "bgmVolDown": {
        if (bgmCurrentId) {
          const s = sounds.find(x => x.id === bgmCurrentId);
          if (s) setSoundVolume(bgmCurrentId, Math.max(0, Math.min(100, s.volume + (id === "bgmVolUp" ? step : -step))));
        }
        break;
      }
      case "toggleShortcuts": setSet("shortcutsEnabled", !appSettings.shortcutsEnabled); break;
      case "toggleWindow": alert("「打开 / 缩小窗口」为桌面版（Tauri/Electron）功能，Web 预览版暂不可用。"); break;
    }
  }, [appSettings.volumeStep, appSettings.shortcutsEnabled, stopAll, playing, paused, bgmCurrentId, pauseResume, masterVol, setMasterVol, hostLoop, duckEnabled, setDuckEnabled, bgmPrev, bgmNext, sounds, setSoundVolume]);
  const funcActionRef = useRef(runFuncAction);
  funcActionRef.current = runFuncAction;

  // 全局功能快捷键监听：捕获阶段优先，匹配即拦截（阻止冒泡到音效字母键监听）。
  // funcCapture 录制期间暂停，避免被录制监听器重复处理。
  useFuncShortcutListener(useCallback((id) => funcActionRef.current(id), []), !funcCapture);
  // Electron 全局：软件隐藏后功能快捷键仍然生效
  useFuncGlobalShortcut(funcShortcuts, useCallback((id) => funcActionRef.current(id), []), !funcCapture);

  // 录制单个功能动作的快捷键：Esc 取消、Backspace/Delete 清除，组合键全局唯一。
  useEffect(() => {
    if (!funcCapture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setFuncCapture(null); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        setFuncShortcuts(prev => { const n = { ...prev }; delete n[funcCapture]; return n; });
        setFuncCapture(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const soundConflict = soundsRef.current.find(s => s.shortcut === combo);
      if (soundConflict) {
        const replace = window.confirm(
          `快捷键 ${comboLabel(combo)} 已被音效「${soundConflict.name}」占用。是否清除该音效绑定并设置为功能快捷键？`,
        );
        if (!replace) return;
        setSounds(prev => prev.map(s => s.id === soundConflict.id ? { ...s, shortcut: undefined } : s));
      }
      setFuncShortcuts(prev => {
        const n: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) if (v !== combo) n[k] = v;
        n[funcCapture] = combo;
        return n;
      });
      setFuncCapture(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [funcCapture]);

  async function bindFileToKey(file: File, keyChar: string) {
    if (!isAudioFile(file)) {
      alert("仅支持音频文件");
      return;
    }
    const name = file.name.replace(/\.[^.]+$/, "");
    const kl = keyChar.toLowerCase();
    const existingId = keyMap[kl];
    if (existingId) {
      try { await putAudioBlob(existingId, file, undefined, file.name); }
      catch (e) { alert("保存音频失败：" + (e instanceof Error ? e.message : String(e))); return; }
      invalidateAudioCache([existingId]);
      setSounds(prev => prev.map(s => {
        if (s.id !== existingId) return s;
        return { ...s, hasAudio: true, url: undefined, name };
      }));
    } else {
      const newId = uid();
      try { await putAudioBlob(newId, file, undefined, file.name); }
      catch (e) { alert("保存音频失败：" + (e instanceof Error ? e.message : String(e))); return; }
      const newItem: SoundItem = {
        id: newId,
        name,
        type: "short",
        category: "短音效",
        volume: 80,
        loop: false,
        shortcut: kl,
        hasAudio: true,
      };
      setSounds(prev => [...prev, newItem]);
    }
  }

  async function handleExport() {
    if (sounds.length === 0) { alert("当前没有音效可导出"); return; }
    try {
      // base64 编码每条音频是耗时步骤；条目较多时显示进度并允许取消，避免界面无反馈卡死。
      const big = sounds.length >= 8;
      let result;
      if (big) {
        const ctrl = new AbortController();
        const cancel = () => ctrl.abort();
        setExportProgress({ done: 0, total: sounds.length, onCancel: cancel });
        try {
          result = await buildSoundPack(
            sounds,
            p => setExportProgress({ done: p.done, total: p.total, onCancel: cancel }),
            ctrl.signal,
          );
        } finally {
          setExportProgress(null);
        }
      } else {
        result = await buildSoundPack(sounds);
      }
      const bytes = estimatePackPayloadBytes(result.pack);
      setExportPrompt({ pack: result.pack, failed: result.failedAudio, bytes });
    } catch (e) {
      if (isBuildAborted(e)) return;
      alert("导出失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  function cleanupMissingSounds() {
    if (missingIds.size === 0) return;
    setSounds(prev => prev.filter(s => !missingIds.has(s.id)));
    setShowCleanupConfirm(false);
  }

  // ---- Batch rebind missing sounds ------------------------------------------
  // 一次选中多个音频文件，按文件名（去后缀）与「音频丢失」条目名称做匹配，
  // 匹配成功的自动落位，剩余条目交给用户手动指认。
  function baseName(filename: string): string {
    const dot = filename.lastIndexOf(".");
    return (dot > 0 ? filename.slice(0, dot) : filename).trim().toLowerCase();
  }

  // 归一化：去掉分隔符、括号、数字与常见标点，便于忽略前缀/编号/空格做模糊匹配。
  function normKey(s: string): string {
    return s
      .toLowerCase()
      .replace(/[()（）[\]【】{}<>]/g, "")
      .replace(/[\s_\-—–·.,，。、!！?？:：;；'"`~]+/g, "")
      .replace(/\d+/g, "")
      .trim();
  }

  function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let cur = new Array<number>(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  // 在未占用的文件里，为某个丢失条目找最佳模糊匹配。score 越小越好；超阈值不返回。
  function bestFuzzyMatch(itemName: string, files: File[], used: Set<number>): { idx: number; score: number } | null {
    const target = normKey(itemName);
    if (!target) return null;
    let best: { idx: number; score: number } | null = null;
    for (let i = 0; i < files.length; i++) {
      if (used.has(i)) continue;
      const cand = normKey(baseName(files[i].name));
      if (!cand) continue;
      let score: number;
      if (cand === target) {
        score = 0;
      } else if (cand.includes(target) || target.includes(cand)) {
        // 子串包含：越接近等长越优
        score = 0.4 + Math.abs(cand.length - target.length) / Math.max(cand.length, target.length) * 0.4;
      } else {
        const dist = levenshtein(target, cand);
        const norm = dist / Math.max(target.length, cand.length);
        if (norm > 0.34) continue; // 差异过大，不推荐
        score = 1 + norm;
      }
      if (best === null || score < best.score) best = { idx: i, score };
    }
    return best;
  }

  // 根据 fuzzy score 分档：score 越小越相似
  // 子串命中：score 0–0.8；编辑距离命中：score 1.0–1.34
  function getMatchTier(score: number): { label: string; color: string; bg: string; priority: number } {
    if (score <= 0.5) return { label: "很可能", color: "rgba(70,140,80,0.95)",  bg: "rgba(70,180,80,0.10)",   priority: 0 };
    if (score <= 0.8) return { label: "可能",   color: "rgba(180,130,30,0.95)", bg: "rgba(230,182,110,0.15)", priority: 1 };
    return              { label: "存疑",   color: "rgba(190,60,50,0.95)",  bg: "rgba(220,80,60,0.10)",  priority: 2 };
  }

  // 将 fuzzy score 线性映射到可读百分比：很可能 90-100%，可能 70-89%，存疑 50-69%
  function scoreToPercent(score: number): number {
    if (score <= 0.5) return Math.round(100 - (score / 0.5) * 10);          // 0→100%, 0.5→90%
    if (score <= 0.8) return Math.round(89 - ((score - 0.5) / 0.3) * 19);  // 0.5→89%, 0.8→70%
    return Math.max(50, Math.round(69 - ((score - 0.8) / 0.54) * 19));      // 0.8→69%, 1.34→50%
  }

  function openBatchRebind(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter(f => isAudioFile(f));
    if (files.length === 0) { alert("未选择任何音频文件"); return; }
    const missing = sounds.filter(s => missingIds.has(s.id));
    if (missing.length === 0) return;
    const assign: Record<string, number> = {};
    const kind: Record<string, "exact" | "fuzzy"> = {};
    const scores: Record<string, number> = {};
    const used = new Set<number>();
    // 第一轮：文件名完全相等（去后缀、忽略大小写）→ 精确匹配
    for (const item of missing) {
      const target = item.name.trim().toLowerCase();
      const idx = files.findIndex((f, i) => !used.has(i) && baseName(f.name) === target);
      if (idx >= 0) { assign[item.id] = idx; kind[item.id] = "exact"; used.add(idx); }
    }
    // 第二轮：对剩余条目做模糊匹配（忽略前后缀/编号/空格、子串包含、编辑距离）→ 推荐匹配
    for (const item of missing) {
      if (assign[item.id] !== undefined) continue;
      const m = bestFuzzyMatch(item.name, files, used);
      if (m) { assign[item.id] = m.idx; kind[item.id] = "fuzzy"; scores[item.id] = m.score; used.add(m.idx); }
    }
    setBatchRebind({ files, items: missing.map(s => ({ id: s.id, name: s.name })), assign, kind, scores, done: false });
  }

  async function applyBatchRebind() {
    if (!batchRebind || batchRebind.done) return;
    const okIds: string[] = [];
    const failed: string[] = [];
    for (const [id, fileIdx] of Object.entries(batchRebind.assign)) {
      // 只写入已明确确认的条目（exact）；fuzzy（包括存疑）跳过，保持待核对
      if (batchRebind.kind[id] !== "exact") continue;
      const file = batchRebind.files[fileIdx];
      if (!file) continue;
      try { await putAudioBlob(id, file, undefined, file.name); okIds.push(id); }
      catch { failed.push(id); }
    }
    if (okIds.length) {
      invalidateAudioCache(okIds);
      setSounds(prev => prev.map(s => okIds.includes(s.id) ? { ...s, hasAudio: true, url: undefined } : s));
    }
    if (failed.length) {
      alert(`有 ${failed.length} 条音频保存失败，请重试。`);
    }
    setBatchRebind(null);
  }

  // Build editable batch-import drafts from dropped audio entries (folder name →
  // category, file name → sound), then open the same preview panel that the
  // 「批量导入 ▾」folder picker uses. Shared parsing via buildDrafts.
  function importFromRawEntries(entries: RawEntry[], rootLabel: string) {
    const audioEntries = entries.filter(en => isAudioFile(en.file));
    if (audioEntries.length === 0) { alert("拖入的内容里没有找到音频文件"); return; }
    const used = new Set(soundsRef.current.filter(s => s.shortcut).map(s => s.shortcut!));
    const drafts = buildDrafts(audioEntries, used);
    if (drafts.length === 0) { alert("拖入的内容里没有找到音频文件"); return; }
    setBatchSource(`${rootLabel}（${drafts.length} 个音效）`);
    setBatchDrafts(drafts);
  }

  // Drop a folder, ZIP package, or multiple audio files anywhere on the page.
  // When sounds are missing it opens the batch-rebind panel (matched by file
  // name); otherwise it opens the batch-import preview to add the dropped pack.
  function handleFileDrop(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    rebindDragDepth.current = 0;
    setRebindDragOver(false);
    const dt = e.dataTransfer;
    const rebinding = missingIds.size > 0;
    void (async () => {
      const entries = await collectEntriesFromDataTransfer(dt);
      // A dropped ZIP archive always routes through the ZIP import path.
      const zip = entries.find(en => isZipFile(en.file));
      if (zip) { await handleZipPicked(zip.file); return; }
      if (rebinding) {
        const audio = entries.map(en => en.file).filter(isAudioFile);
        if (audio.length === 0) { alert("拖入的内容里没有找到音频文件"); return; }
        openBatchRebind(audio);
        return;
      }
      // No missing sounds → treat the drop as a fresh batch import. Derive a
      // friendly source label from the dropped folder's top-level name.
      const firstRel = entries[0]?.relPath ?? "";
      const top = firstRel.includes("/") ? firstRel.split("/")[0] : "";
      importFromRawEntries(entries, top ? `文件夹：${top}` : "拖入音效");
    })();
  }

  async function handleImportFile(file: File) {
    try {
      const pack = await readSoundPackFile(file);
      setImportPack(pack);
    } catch (e) {
      alert("导入失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function confirmImport(scopedPack: SoundPack, strategy: ConflictStrategy) {
    const plan = mergeSoundPack(sounds, scopedPack, strategy);
    const total = plan.pendingBlobs.length;
    const big = total >= 8 || mergePlanPayloadBytes(plan) >= 2 * 1024 * 1024;

    if (!big) {
      await commitMergePlan(plan);
      invalidateAudioCache(plan.affectedIds);
      setSounds(plan.sounds);
      setImportPack(null);
      setImportToast({ result: plan.result, key: Date.now() });
      return;
    }

    const ctrl = new AbortController();
    const cancel = () => ctrl.abort();
    setImportProgress({ done: 0, total, title: "正在写入音效…", onCancel: cancel, cancelLabel: "取消导入" });
    try {
      await commitMergePlan(
        plan,
        p => setImportProgress({ done: p.done, total: p.total, title: "正在写入音效…", onCancel: cancel, cancelLabel: "取消导入" }),
        ctrl.signal,
      );
      invalidateAudioCache(plan.affectedIds);
      setSounds(plan.sounds);
      setImportPack(null);
      setImportToast({ result: plan.result, key: Date.now() });
    } catch (e) {
      if (isImportAborted(e)) {
        // Cancelled mid-import: metadata was never saved, state unchanged.
        // Orphaned partial blobs are benign and will be pruned on next full save.
      } else {
        throw e;
      }
    } finally {
      setImportProgress(null);
    }
  }

  const tabSounds = activeTab === "mine"
    ? sounds.filter(s => !!s.mine && !s.favorite && (mineFrom === "bg" ? isBgSound(s) : !isBgSound(s)))
    : activeTab === "bg"
    ? sounds.filter(s => isBgSound(s) && !s.mine && !s.favorite)
    : sounds.filter(s => !isBgSound(s) && !s.mine && !s.favorite);
  // Distinct second-level sub-categories present under the selected first-level
  // category, in first-seen order. Drives the 二级分类 sub-pill row.
  // 音效 subCategory 字段 ∪ subCatReg 注册表（含空文件夹），保持原始顺序。
  // 规则：一级分类下若有没有 subCategory 的音效，自动追加虚拟「未分类」二级。
  const subCats = (() => {
    // 收藏/未分类(L1虚拟) 不走两级结构
    if (selCat === "收藏" || selCat === UNCAT) return [];
    // subCatReg 作为顺序权威（拖拽排序后写入全量顺序）；先从注册表取序，再追加音效中未收录的
    const seen: string[] = [...(subCatReg[selCat] ?? [])];
    for (const s of tabSounds) {
      if (s.category === selCat && s.subCategory && !seen.includes(s.subCategory)) seen.push(s.subCategory);
    }
    // Rule 3: 有直挂一级分类的「孤儿」音效 → 自动产生虚拟「未分类」二级
    const hasOrphan = tabSounds.some(s => s.category === selCat && !s.subCategory);
    if (hasOrphan && !seen.includes(UNCAT)) seen.push(UNCAT);
    return seen;
  })();
  // 目录模式：L1 已选、未选具体子分类 → 不显示音效，只显示二级分类列表
  // 规则：一级分类绝不直接展示音效；收藏/未分类(L1虚拟) 除外。
  const showSubPicker = !!(selCat && selCat !== "收藏" && selCat !== UNCAT && selSub === ALL_SUB);
  // 二级分类为空时的提示（showSubPicker 已覆盖此情况，保留供外部引用）
  const showAddSubPrompt = !!(selCat && selCat !== "收藏" && selCat !== UNCAT && subCats.length === 0 && selSub === ALL_SUB);
  const filteredByCat = selCat === "收藏"
    ? sounds.filter(s => s.favorite === true)
    : selCat === UNCAT
    ? tabSounds.filter(s => !s.category || s.category === UNCAT)
    // L1 层级（ALL_SUB）：绝不显示音效，只显示二级分类列表（showSubPicker 负责渲染提示）
    : selSub === ALL_SUB
    ? []
    // 选中「未分类」二级 → 孤儿音效(subCategory 空) + 显式 subCategory="未分类" 的音效
    : selSub === UNCAT
    ? tabSounds.filter(s => s.category === selCat && (!s.subCategory || s.subCategory === "" || s.subCategory === UNCAT))
    // 普通二级分类
    : tabSounds.filter(s => s.category === selCat && (s.subCategory ?? "") === selSub);

  // 移动端底部固定区高度：Tab 栏(60) + 操作栏(76) + 背景模式行(可选) + 当前播放条(可选) + 批量工具条(可选)
  const MOBILE_TAB_BAR_H = 60;
  const mobileNowPlaying = currentTrackId !== null && (playing.has(currentTrackId) || paused.has(currentTrackId)) && sounds.some(s => s.id === currentTrackId);
  const mobileBatchBarH = isMobile && selectedSoundIds.size > 0 ? 88 : 0;
  const mobileBottomPad = 76 + (mobileNowPlaying ? 52 : 0) + mobileBatchBarH;

  return (<>
    <div
      style={isMobile
        ? { position: "relative", minHeight: "100%", display: "flex", flexDirection: "column", padding: "12px 14px", gap: 12 }
        : { position: "relative", display: "flex", flexDirection: "row", padding: "8px 10px", gap: 8, overflow: "hidden", minWidth: 0, minHeight: 560, height: "100%" }}
      onDragEnter={e => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        rebindDragDepth.current += 1;
        setRebindDragOver(true);
      }}
      onDragOver={e => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={e => {
        if (!dragHasFiles(e)) return;
        rebindDragDepth.current -= 1;
        if (rebindDragDepth.current <= 0) { rebindDragDepth.current = 0; setRebindDragOver(false); }
      }}
      onDrop={handleFileDrop}
    >
      {/* 更多设置：仅桌面端弹出菜单（移动端改在新顶部栏处理） */}
      {!isMobile && (
        <button
          className="btn"
          onClick={() => setShowMenu(true)}
          title="更多设置"
          style={{ position: "absolute", top: 8, right: 10, zIndex: 60, padding: "3px 7px", fontSize: 12, lineHeight: 1, background: "#fff", color: "#333", borderColor: "rgba(60,50,45,0.14)" }}
        >☰</button>
      )}
      {rebindDragOver && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(2px)", border: "2px dashed rgba(230,182,110,0.6)", pointerEvents: "none" }}>
          <div className="glass-strong" style={{ padding: "22px 30px", borderRadius: 14, color: "#2c2622", fontSize: 17, fontWeight: "bold", textAlign: "center", lineHeight: 1.7 }}>
            {missingIds.size > 0 ? (
              <>
                📁 松开即可批量重绑 {missingIds.size} 条丢失音效
                <div style={{ fontSize: 13, fontWeight: "normal", color: "rgba(50,42,36,0.85)", marginTop: 4 }}>支持整个文件夹或多个音频文件，按文件名自动匹配</div>
              </>
            ) : (
              <>
                📁 松开即可批量导入新音效
                <div style={{ fontSize: 13, fontWeight: "normal", color: "rgba(50,42,36,0.85)", marginTop: 4 }}>支持整个文件夹、ZIP 包或多个音频文件，导入前可预览编辑</div>
              </>
            )}
          </div>
        </div>
      )}
      {/* Left vertical tab nav */}
      {!isMobile && (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", flexShrink: 0, width: 72, borderRight: "1px solid var(--border-soft)", paddingTop: 16, paddingRight: 8, gap: 6 }}>
        {([
          ["main", "主播音效", "🎤"],
          ["bg",   "背景音乐", "🎵"],
          ["kbd",  "音效快捷键","⌨"],
        ] as const).map(([k, lab, ico]) => (
          <button
            key={k}
            className="btn"
            onClick={() => { setActiveTab(k); if (k !== "kbd") { setSelCat((k === "bg" ? bgCats : mainCats)[0] ?? ""); setSelSub(ALL_SUB); } setSelectedSoundIds(new Set()); selectAnchorRef.current = null; }}
            style={{
              padding: "6px 4px",
              fontSize: 11,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
              lineHeight: 1.2,
              fontWeight: activeTab === k ? "bold" : "normal",
              ...(activeTab === k
                ? { color: "var(--blue-deep)", borderColor: "rgba(168,85,247,0.50)", background: "rgba(168,85,247,0.12)" }
                : { color: "var(--text-sub)" }),
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{ico}</span>
            <span style={{ fontSize: 10, whiteSpace: "pre-wrap", textAlign: "center" }}>{lab}</span>
          </button>
        ))}
        <button
          className="btn"
          onClick={() => { if (activeTab !== "main" && activeTab !== "bg" && activeTab !== "mine") { setActiveTab("main"); } setSelCat("收藏"); setSelSub(ALL_SUB); }}
          title="收藏夹"
          style={{
            padding: "6px 4px", fontSize: 11,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 2, lineHeight: 1.2,
            ...((selCat === "收藏" && (activeTab === "main" || activeTab === "bg" || activeTab === "mine"))
              ? { color: "var(--gold)", borderColor: "rgba(230,182,110,0.6)", background: "rgba(230,182,110,0.12)", fontWeight: "bold" }
              : { color: "var(--text-sub)" }),
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>⭐</span>
          <span style={{ fontSize: 10 }}>收藏</span>
        </button>
        {/* ── 全选 / 批量删除（仅 main/bg/mine 标签显示） ── */}
        {(activeTab === "main" || activeTab === "bg" || activeTab === "mine") && (
          <>
            <div style={{ height: 1, background: "var(--border-soft)", margin: "2px 0" }} />
            <button
              className="btn"
              title={selectedSoundIds.size > 0 ? "取消全选" : "全选当前视图所有音效"}
              onClick={() => {
                const allIds = new Set(filteredByCat.map(s => s.id));
                const isAll = allIds.size > 0 && [...allIds].every(id => selectedSoundIds.has(id));
                setSelectedSoundIds(isAll ? new Set() : allIds);
                selectAnchorRef.current = null;
              }}
              style={{
                padding: "6px 4px", fontSize: 10, display: "flex", flexDirection: "column",
                alignItems: "center", gap: 2, lineHeight: 1.2,
                ...(selectedSoundIds.size > 0
                  ? { color: "var(--gold)", borderColor: "rgba(230,182,110,0.5)", background: "rgba(230,182,110,0.10)", fontWeight: "bold" }
                  : { color: "var(--text-sub)" }),
              }}
            >
              <span style={{ fontSize: 15, lineHeight: 1 }}>☑</span>
              <span style={{ fontSize: 10, textAlign: "center", lineHeight: 1.2 }}>
                {selectedSoundIds.size > 0 ? `已选${selectedSoundIds.size}` : "全选"}
              </span>
            </button>
            {selectedSoundIds.size > 0 && (
              <button
                className="btn"
                title="删除所有选中的音效（可撤销）"
                onClick={() => deleteSoundsWithUndo([...selectedSoundIds])}
                style={{
                  padding: "6px 4px", fontSize: 10, display: "flex", flexDirection: "column",
                  alignItems: "center", gap: 2, lineHeight: 1.2,
                  color: "#c0392b", borderColor: "rgba(255,120,120,0.45)", background: "rgba(255,80,80,0.06)",
                }}
              >
                <span style={{ fontSize: 15, lineHeight: 1 }}>🗑</span>
                <span style={{ fontSize: 10 }}>删除选中</span>
              </button>
            )}
          </>
        )}
        {/* ── 云端按钮：固定在左侧栏底部（管理员不显示，由云端管理弹层代替） ── */}
        {!memberStatus?.isAdmin && <div style={{ marginTop: "auto", flexShrink: 0, paddingTop: 6 }}>
          <div style={{ height: 1, background: "var(--border-soft)", marginBottom: 6 }} />
          <button
            className="btn"
            onClick={() => {
              if (!cloudVersionInfo) {
                void checkCloudVersion().then(info => { setCloudVersionInfo(info); });
              }
              setShowCloudPanel(true);
            }}
            title={cloudVersionInfo ? "云端音效库同步" : "云端未连接，点击重试"}
            style={{
              width: "100%", padding: "6px 4px", fontSize: 10,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2, lineHeight: 1.2,
              ...(cloudVersionInfo?.hasUpdate
                ? { color: "#2e7d32", borderColor: "rgba(76,175,80,0.45)", background: "rgba(76,175,80,0.08)" }
                : cloudVersionInfo
                  ? { color: "var(--text-sub)" }
                  : { color: "#c62828", borderColor: "rgba(198,40,40,0.35)", background: "rgba(198,40,40,0.06)" }),
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{cloudVersionInfo ? "☁️" : "⚠️"}</span>
            <span style={{ fontSize: 10, whiteSpace: "nowrap" }}>
              {cloudVersionInfo?.hasUpdate
                ? `v${cloudVersionInfo.version} 新`
                : cloudVersionInfo
                  ? `v${getStoredCloudVersion() || cloudVersionInfo.version}`
                  : "未连接"}
            </span>
          </button>
          {/* 云端连接失败时显示具体错误（截断到2行） */}
          {!cloudVersionInfo && getLastCloudError() && (
            <div style={{
              marginTop: 4, padding: "3px 4px", borderRadius: 4, fontSize: 9,
              color: "#c62828", background: "rgba(198,40,40,0.08)",
              lineHeight: 1.3, wordBreak: "break-all",
              display: "-webkit-box", WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical", overflow: "hidden",
            }} title={getLastCloudError() ?? ""}>
              {getLastCloudError()}
            </div>
          )}
        </div>}
      </div>
      )}

      {/* Right content column */}
      <div style={isMobile
        ? { flex: 1, minWidth: 0 }
        : { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
      {isMobile && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-main, #EEE8FF)" }}>
          {/* ── 蓝牙键盘隐藏 input（inputMode=none 不弹软键盘，仅接收物理键盘事件） ── */}
          <input
            ref={btKeyboardInputRef}
            readOnly
            inputMode="none"
            aria-hidden="true"
            tabIndex={-1}
            style={{
              position: "fixed", left: -9999, top: -9999,
              width: 1, height: 1, opacity: 0, pointerEvents: "none",
            }}
            onBlur={() => {
              if (btKeyboardMode) {
                btRefocusTimer.current = setTimeout(() => {
                  btKeyboardInputRef.current?.focus();
                }, 120);
              }
            }}
          />
          {/* ── 顶部操作栏 ── */}
          <div style={{ flexShrink: 0, height: 50, display: "flex", alignItems: "center", padding: "0 8px 0 14px", gap: 5, background: "var(--mob-header-bg)", borderBottom: "1px solid var(--border-soft)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}>
            <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: "var(--text-main)", letterSpacing: 0.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>金玖音效助手</div>
            {/* 蓝牙键盘模式切换 */}
            <button
              className={`btn${btKeyboardMode ? " gold-btn" : ""}`}
              style={{ padding: "4px 7px", fontSize: 11, flexShrink: 0 }}
              onClick={toggleBtKeyboard}
              title={btKeyboardMode ? "关闭蓝牙键盘模式" : "开启蓝牙键盘模式（连接蓝牙键盘后点击）"}
            >
              {btKeyboardMode ? "⌨️ 已连接" : "⌨️ BT键盘"}
            </button>
            <button
              className={`btn${mobileSelectMode ? " gold-btn" : ""}`}
              style={{ padding: "4px 7px", fontSize: 11, flexShrink: 0 }}
              onClick={() => {
                if (mobileSelectMode) { setMobileSelectMode(false); setSelectedSoundIds(new Set()); selectAnchorRef.current = null; }
                else setMobileSelectMode(true);
              }}
            >{mobileSelectMode ? "完成" : "选择"}</button>
            <button className="btn" style={{ padding: "4px 7px", fontSize: 11, flexShrink: 0 }} onClick={() => stopAll()}>停止</button>
            <button className="btn" style={{ padding: "4px 7px", fontSize: 11, flexShrink: 0 }} onClick={() => navigate("/manage")}>管理</button>
          </div>
          {/* BT 键盘模式提示条 */}
          {btKeyboardMode && (
            <div style={{
              flexShrink: 0, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(230,182,110,0.18)", borderBottom: "1px solid rgba(230,182,110,0.35)",
              fontSize: 11, color: "var(--gold)", gap: 6,
            }}>
              <span>⌨️</span>
              <span>蓝牙键盘已就绪 · 按键直接触发音效 · 再次点击「⌨️ 已连接」关闭</span>
            </div>
          )}
          {/* ── 三列主体 ── */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {/* 左列：一级分类 */}
            <div style={{ width: 72, flexShrink: 0, display: "flex", flexDirection: "column", overflowY: "auto", background: "var(--mob-sidebar1-bg)", borderRight: "1px solid var(--border-soft)", paddingTop: 4 }}>
              {(activeTab === "bg" ? bgCats : mainCats).map(c => (
                <button
                  key={c}
                  onClick={() => { setSelCat(c); setSelSub(ALL_SUB); }}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center",
                    padding: "10px 6px", gap: 2, border: "none", outline: "none", cursor: "pointer",
                    background: selCat === c ? "rgba(230,182,110,0.15)" : "transparent",
                    borderLeft: `3px solid ${selCat === c ? "var(--gold)" : "transparent"}`,
                    fontSize: 13, fontWeight: selCat === c ? 700 : 500,
                    color: selCat === c ? "var(--gold)" : "rgba(60,50,42,0.85)",
                    letterSpacing: 0.3, textAlign: "center", lineHeight: 1.3,
                    wordBreak: "break-all",
                  }}
                >{c}</button>
              ))}
            </div>
            {/* 中列：二级分类（规则：非虚拟一级分类时始终显示，即使为空） */}
            {selCat && !(VIRTUAL_SOUND_CATS as readonly string[]).includes(selCat) && (
              <div style={{ width: 78, flexShrink: 0, display: "flex", flexDirection: "column", overflowY: "auto", background: "var(--mob-sidebar2-bg)", borderRight: "1px solid var(--border-soft)", paddingTop: 4 }}>
                {subCats.length === 0 ? (
                  <div style={{ color: "rgba(92,82,74,0.45)", fontSize: 12, textAlign: "center", padding: "14px 4px", lineHeight: 1.8 }}>
                    暂无<br />二级<br />分类
                  </div>
                ) : (
                  subCats.map(sc => (
                    <button key={sc} onClick={() => setSelSub(sc)} style={{ padding: "10px 7px", border: "none", outline: "none", cursor: "pointer", background: selSub === sc ? "rgba(230,182,110,0.14)" : "transparent", fontSize: 13, fontWeight: selSub === sc ? 700 : 500, color: selSub === sc ? "var(--gold)" : "rgba(60,50,42,0.82)", textAlign: "center", lineHeight: 1.35, wordBreak: "break-all" }}>{sc}</button>
                  ))
                )}
              </div>
            )}
            {/* 右列：音效网格 */}
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px 8px" }}>
              {filteredByCat.length === 0 ? (
                <div style={{ color: "rgba(92,82,74,0.40)", fontSize: 13, padding: "40px 8px", textAlign: "center" }}>
                  {selSub === ALL_SUB && !(VIRTUAL_SOUND_CATS as readonly string[]).includes(selCat)
                    ? "请选择左侧二级分类"
                    : selCat === "收藏" ? "暂无收藏音效" : `暂无 ${selCat || ""} 音效`}
                </div>
              ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {/* 隐藏文件选择器（本地导入音效） */}
              {(
                <input
                  ref={mobileImportInputRef}
                  type="file"
                  accept=".mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,.webm,.wma,.aiff,.amr,audio/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={e => {
                    const files = e.target.files ? Array.from(e.target.files) : [];
                    e.target.value = "";
                    void handleMobileImportFiles(files);
                  }}
                />
              )}
              {filteredByCat.map(s => {
                const isP = playing.has(s.id);
                const miss = missingIds.has(s.id);
                const isSel = selectedSoundIds.has(s.id);
                return (
                  <button
                    key={s.id}
                    data-sound-id={s.id}
                    className="glass"
                    onTouchStart={() => {
                      if (mobileSelectMode) return;
                      mobileLongPressRef.current = setTimeout(() => {
                        mobileLongPressRef.current = null;
                        setMobileSelectMode(true);
                        setSelectedSoundIds(new Set([s.id]));
                        selectAnchorRef.current = s.id;
                      }, 500);
                    }}
                    onTouchEnd={() => {
                      if (mobileLongPressRef.current) {
                        clearTimeout(mobileLongPressRef.current);
                        mobileLongPressRef.current = null;
                      }
                    }}
                    onTouchMove={() => {
                      if (mobileLongPressRef.current) {
                        clearTimeout(mobileLongPressRef.current);
                        mobileLongPressRef.current = null;
                      }
                    }}
                    onClick={() => {
                      if (mobileSelectMode) {
                        const next = new Set(selectedSoundIds);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        setSelectedSoundIds(next);
                        selectAnchorRef.current = s.id;
                        return;
                      }
                      const now = Date.now();
                      const last = mobileTapRef.current;
                      if (last && last.id === s.id && now - last.t < 300) {
                        mobileTapRef.current = null;
                        setEditId(s.id);
                        return;
                      }
                      mobileTapRef.current = { id: s.id, t: now };
                      tryTrigger(s.id);
                    }}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center",
                      justifyContent: "center", gap: 2,
                      padding: "9px 8px", borderRadius: 12, cursor: "pointer",
                      overflow: "hidden", outline: "none",
                      border: isSel ? "2px solid var(--gold)"
                            : isP ? "2px solid var(--gold)"
                            : s.color ? `1px solid ${hexToRgba(s.color, 0.6)}`
                            : undefined,
                      background: isSel ? "rgba(230,182,110,0.22)"
                                : isP ? "rgba(230,182,110,0.16)"
                                : s.color ? hexToRgba(s.color, 0.12) : undefined,
                      color: miss ? "#c0392b" : undefined,
                    }}
                  >
                    {mobileSelectMode && (
                      <span style={{ fontSize: 14, lineHeight: 1, color: isSel ? "var(--gold)" : "rgba(60,52,46,0.28)", fontFamily: "sans-serif", fontWeight: "bold" }}>{isSel ? "✓" : "○"}</span>
                    )}
                    {!mobileSelectMode && miss && (
                      <span style={{ fontSize: 13, lineHeight: 1, color: "#c0392b" }}>⚠</span>
                    )}
                    <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25, textAlign: "center", wordBreak: "break-all", color: miss ? "#c0392b" : "rgba(40,30,22,0.92)" }}>{s.name}</span>
                    {!mobileSelectMode && s.shortcut && <span style={{ fontSize: 12, color: "var(--gold)", fontFamily: "sans-serif", fontWeight: 700 }}>{s.shortcut === " " ? "␣" : s.shortcut.toUpperCase()}</span>}
                  </button>
                );
              })}
              {/* ＋导入音效按钮（排在最后一格） */}
              {!mobileSelectMode && selCat !== "收藏" && (
                <button
                  className="glass"
                  onClick={() => mobileImportInputRef.current?.click()}
                  disabled={mobileImportProgress?.status === "running"}
                  style={{
                    display: "flex", flexDirection: "row", alignItems: "center",
                    gap: 5, padding: "9px 8px", borderRadius: 12, cursor: "pointer",
                    overflow: "hidden",
                    border: "1.5px dashed rgba(230,182,110,0.55)",
                    background: mobileImportProgress?.status === "running"
                      ? "rgba(230,182,110,0.08)"
                      : "rgba(230,182,110,0.06)",
                    color: "var(--gold)", outline: "none",
                    opacity: mobileImportProgress?.status === "running" ? 0.7 : 1,
                  }}
                >
                  {mobileImportProgress?.status === "running" ? (
                    <>
                      <span style={{ fontSize: 12, lineHeight: 1, flexShrink: 0 }}>⏳</span>
                      <span style={{ fontSize: 11, lineHeight: 1.2, flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
                        {mobileImportProgress.done}/{mobileImportProgress.total}
                      </span>
                    </>
                  ) : mobileImportProgress?.status === "done" ? (
                    <>
                      <span style={{ fontSize: 12, lineHeight: 1, flexShrink: 0 }}>✅</span>
                      <span style={{ fontSize: 11, lineHeight: 1.2, flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
                        {mobileImportProgress.failed > 0
                          ? `成功${mobileImportProgress.done - mobileImportProgress.failed}`
                          : `已导入${mobileImportProgress.done}个`}
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }}>＋</span>
                      <span style={{ fontSize: 13, lineHeight: 1.2, flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>导入音效</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
            </div>
          </div>
          {/* ── 底部区域 ── */}
          <div style={{ flexShrink: 0 }}>
            {/* 当前播放条 */}
            {(() => {
              const t = currentTrackId ? sounds.find(s => s.id === currentTrackId) : undefined;
              const active = !!t && currentTrackId !== null && (playing.has(currentTrackId) || paused.has(currentTrackId));
              if (!active) return null;
              const cur = currentTrackId;
              return (
                <div className="glass-strong" style={{ padding: "8px 12px", borderTop: "1px solid rgba(60,50,45,0.12)" }}>
                  <NowPlayingBar
                    inline mobile
                    track={t ?? null}
                    isPaused={!!cur && paused.has(cur)}
                    getAudioElement={getAudioElement}
                    onPauseResume={() => { if (cur) pauseResume(cur); }}
                    onStop={() => { if (cur) stopSound(cur); }}
                    onSeek={(sec) => { if (cur) seekSound(cur, sec); }}
                    bgmMode={bgmMode}
                    onBgmModeChange={setBgmMode}
                    onPrev={bgmPrev}
                    onNext={bgmNext}
                  />
                </div>
              );
            })()}
            {/* 多选批量工具条 */}
            {selectedSoundIds.size > 0 && (
              <div className="glass-strong" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 14px", borderTop: "1px solid rgba(60,50,45,0.12)" }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ color: "var(--gold)", fontSize: 13, fontWeight: "bold", flexShrink: 0 }}>已选 {selectedSoundIds.size} 个</span>
                  <button className="btn" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => setBatchMoveMenu({ x: 14, y: window.innerHeight - 260 })}>移动到 ▾</button>
                  <button className="btn" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => setBatchColorOpen(true)}>颜色 🎨</button>
                  <button className="btn" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => batchUpdateSelected({ color: undefined })}>清除颜色 ✕</button>
                  {(() => {
                    const allFav = selectedSoundIds.size > 0 && [...selectedSoundIds].every(id => sounds.find(s => s.id === id)?.favorite);
                    return <button className="btn" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => batchToggleFavorite([...selectedSoundIds], !allFav)}>{allFav ? "取消收藏 ☆" : "加入收藏 ★"}</button>;
                  })()}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "rgba(92,82,74,0.8)" }}>
                    循环
                    <button className="btn" style={{ padding: "3px 8px", fontSize: 12 }} onClick={() => batchUpdateSelected({ loop: true })}>开</button>
                    <button className="btn" style={{ padding: "3px 8px", fontSize: 12 }} onClick={() => batchUpdateSelected({ loop: false })}>关</button>
                  </span>
                  <button className="btn" style={{ padding: "5px 10px", fontSize: 13, color: "#c0392b", borderColor: "rgba(255,120,120,0.4)" }} onClick={() => { deleteSoundsWithUndo([...selectedSoundIds]); setMobileSelectMode(false); }}>删除</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "rgba(92,82,74,0.8)", flexShrink: 0 }}>音量</span>
                  <input type="range" min={0} max={100} defaultValue={80}
                    onChange={e => setBatchVolPreview(Number(e.target.value))}
                    onMouseUp={e => batchUpdateSelected({ volume: Number((e.target as HTMLInputElement).value) })}
                    onTouchEnd={e => batchUpdateSelected({ volume: Number((e.target as HTMLInputElement).value) })}
                    style={{ flex: 1 }} />
                  <span style={{ width: 26, textAlign: "right", color: "var(--gold)", fontWeight: "bold", fontSize: 13 }}>{batchVolPreview}</span>
                </div>
              </div>
            )}
            {/* 四栏底部导航 */}
            <div style={{ display: "flex", background: "var(--mob-tabbar-bg)", backdropFilter: "blur(16px)", borderTop: "1px solid rgba(230,182,110,0.25)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
              {([
                { key: "main",     label: "主播音效", icon: "🎤" },
                { key: "bg",       label: "背景音乐", icon: "🎵" },
                { key: "fav",      label: "收藏",     icon: "⭐" },
                { key: "settings", label: "设置",     icon: "⚙️" },
              ] as const).map(tab => {
                const isActive =
                  tab.key === "settings" ? false :
                  tab.key === "fav" ? selCat === "收藏" :
                  activeTab === tab.key && selCat !== "收藏";
                return (
                  <button key={tab.key} className="tab-btn" style={{ flex: 1, ...(isActive ? { color: "var(--gold)" } : {}) }}
                    onClick={() => {
                      if (tab.key === "settings") { navigate("/settings"); return; }
                      if (tab.key === "fav") { setSelCat("收藏"); setSelSub(ALL_SUB); return; }
                      setActiveTab(tab.key);
                      setSelCat((tab.key === "bg" ? bgCats : mainCats)[0] ?? "");
                      setSelSub(ALL_SUB);
                      setMobileSelectMode(false); selectAnchorRef.current = null;
                    }}
                  >
                    <span className="tab-icon">{tab.icon}</span>
                    <span className="tab-label" style={isActive ? { color: "var(--gold)", fontWeight: "bold" } : {}}>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {/* Hamburger menu */}
      {showMenu && (() => {
        const items: { label: string; right?: string; onClick?: () => void; danger?: boolean; node?: React.ReactNode }[] = [
          { label: "_member_status", node: (() => {
            const expiry = memberStatus
              ? formatExpiry(memberStatus.membershipExpiresAt)
              : null;
            const statusColor =
              !expiry ? "rgba(120,100,160,0.5)" :
              expiry.status === "permanent" ? "#2E9E5B" :
              expiry.status === "ok"        ? "#2E9E5B" :
              expiry.status === "warning"   ? "#D97706" :
              "#DC2626";
            const statusBg =
              !expiry ? "rgba(168,85,247,0.06)" :
              expiry.status === "permanent" ? "rgba(46,158,91,0.08)" :
              expiry.status === "ok"        ? "rgba(46,158,91,0.08)" :
              expiry.status === "warning"   ? "rgba(217,119,6,0.10)" :
              "rgba(220,38,38,0.08)";
            return (
              <div style={{
                margin: "4px 0 2px",
                padding: "10px 14px",
                borderRadius: 9,
                background: statusBg,
                border: `1px solid ${statusColor}30`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: expiry?.subText ? 3 : 0 }}>
                  <span style={{ fontSize: 14 }}>
                    {!expiry ? "👑" :
                      expiry.status === "permanent" ? "♾️" :
                      expiry.status === "ok"        ? "✅" :
                      expiry.status === "warning"   ? "⚠️" : "❌"}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: statusColor }}>
                    {memberStatus?.username
                      ? `${memberStatus.username} · `
                      : ""}
                    {expiry ? expiry.text : "加载中…"}
                  </span>
                </div>
                {expiry?.subText && (
                  <div style={{ fontSize: 11, color: statusColor, opacity: 0.8, paddingLeft: 21 }}>
                    {expiry.subText}
                  </div>
                )}
              </div>
            );
          })() },
          { label: "⚙️ 设置 / 连接诊断", right: "▶", onClick: () => { setShowMenu(false); navigate("/settings"); } },
          { label: "☁️ 同步云端音效到本机", right: "▶", onClick: () => { setShowMenu(false); setShowCloudPanel(true); } },
          { label: "窗口置顶", right: appSettings.windowPinned ? "开" : "关", onClick: () => { setSet("windowPinned", !appSettings.windowPinned); alert("窗口置顶仅在桌面版（Tauri/Electron）生效，已记录偏好。"); } },
          { label: "功能快捷键设置", right: "▶", onClick: () => setShowFuncPanel(true) },
          { label: "快捷键模式", node: (
              // 直接内联展开两种模式（不再用 hover 弹出层）：触屏/桌面都能点选。
              <div style={{ padding: "2px 0" }}>
                <div style={{ padding: "9px 12px 2px", fontSize: 13, color: "#333" }}>快捷键模式</div>
                {([["listen", "监听模式", "不会覆盖按键默认功能"], ["register", "注册模式", "会覆盖按键默认功能"]] as const).map(([m, t, d]) => (
                  <div
                    key={m}
                    onClick={() => { setSet("shortcutMode", m); setShowMenu(false); }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    style={{ padding: "8px 12px 8px 16px", borderRadius: 7, cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 8 }}
                  >
                    <span style={{ width: 14, flexShrink: 0, color: "#E6B66E", fontFamily: "sans-serif" }}>{appSettings.shortcutMode === m ? "✓" : ""}</span>
                    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 13 }}>{t}</span>
                      <span style={{ fontSize: 11, color: "#999" }}>（{d}）</span>
                    </span>
                  </div>
                ))}
              </div>
            ) },
          { label: "Shift 键快捷键开关", right: appSettings.shiftShortcuts ? "开" : "关", onClick: () => setSet("shiftShortcuts", !appSettings.shiftShortcuts) },
          { label: "再次单击不关闭音效", right: appSettings.tapNoStop ? "开" : "关", onClick: () => setSet("tapNoStop", !appSettings.tapNoStop) },
          { label: "快捷键控制音量变化大小", node: (
              <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: "#333" }}>快捷键控制音量变化大小</span>
                  <span style={{ fontSize: 11, color: "#E6B66E", fontFamily: "sans-serif", whiteSpace: "nowrap" }}>{appSettings.volumeStep}%</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={appSettings.volumeStep}
                  onChange={e => setSet("volumeStep", Math.max(1, Math.min(50, +e.target.value)))}
                  style={{ width: "100%" }}
                  title="每次按快捷键调整音量的百分比步进（越大变化越快）"
                />
              </div>
            ) },
          { label: "闪避 / 压音", right: duckEnabled ? "开" : "关", onClick: () => setDuckEnabled(!duckEnabled) },
          { label: "闪避压低到", node: (
              <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: "#333" }}>闪避压低到</span>
                  <span style={{ fontSize: 11, color: "#E6B66E", fontFamily: "sans-serif", whiteSpace: "nowrap" }}>{duckFactor}%</span>
                </div>
                <input
                  type="range"
                  min={DUCK_FACTOR_MIN}
                  max={DUCK_FACTOR_MAX}
                  value={duckFactor}
                  onChange={e => setDuckFactor(+e.target.value)}
                  style={{ width: "100%" }}
                  title="压低到原音量的百分比（越小压得越狠）"
                />
              </div>
            ) },
          { label: "闪避恢复时长", node: (
              <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: "#333" }}>闪避恢复时长</span>
                  <span style={{ fontSize: 11, color: "#E6B66E", fontFamily: "sans-serif", whiteSpace: "nowrap" }}>{duckFadeMs}ms</span>
                </div>
                <input
                  type="range"
                  min={DUCK_FADE_MS_MIN}
                  max={DUCK_FADE_MS_MAX}
                  step={50}
                  value={duckFadeMs}
                  onChange={e => setDuckFadeMs(+e.target.value)}
                  style={{ width: "100%" }}
                  title="压低 / 恢复的渐变时长毫秒（越大越柔和）"
                />
              </div>
            ) },
          { label: "设置淡入 / 淡出播放", node: (
              <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: "#333" }}>设置淡入 / 淡出播放</span>
                  <span style={{ fontSize: 11, color: "#E6B66E", fontFamily: "sans-serif", whiteSpace: "nowrap" }}>{appSettings.fadePlay && appSettings.fadeMs > 0 ? `${appSettings.fadeMs}ms` : "关"}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2000}
                  step={50}
                  value={appSettings.fadePlay ? appSettings.fadeMs : 0}
                  onChange={e => {
                    const n = Math.max(0, Math.min(2000, +e.target.value));
                    if (n === 0) setSet("fadePlay", false);
                    else { setSet("fadePlay", true); setSet("fadeMs", n); }
                  }}
                  style={{ width: "100%" }}
                  title="淡入 / 淡出毫秒（0 关闭，最大 2000，越大越柔和）"
                />
              </div>
            ) },
          { label: "设置字体大小", node: (
              <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 13, color: "#333" }}>设置字体大小</span>
                  <span style={{ fontSize: 11, color: "#E6B66E", fontFamily: "sans-serif", whiteSpace: "nowrap" }}>{appSettings.cardFontPct}%</span>
                </div>
                <input
                  type="range"
                  min={60}
                  max={200}
                  step={5}
                  value={appSettings.cardFontPct}
                  onChange={e => setSet("cardFontPct", Math.max(60, Math.min(200, +e.target.value)))}
                  style={{ width: "100%" }}
                  title="音效卡片字体大小百分比"
                />
              </div>
            ) },
          { label: "音效名下方显示快捷键", right: appSettings.showShortcutBelowName ? "开" : "关", onClick: () => setSet("showShortcutBelowName", !appSettings.showShortcutBelowName) },
          { label: "页面布局", right: appSettings.layoutMode === "compact" ? "紧凑" : appSettings.layoutMode === "wide" ? "宽松" : "默认", onClick: () => {
              const next = appSettings.layoutMode === "default" ? "compact" : appSettings.layoutMode === "compact" ? "wide" : "default";
              setSet("layoutMode", next);
            } },
          { label: "MIDI 时间码设置", right: "▶", onClick: () => { setShowMidi(true); setShowMenu(false); } },
          { label: "音频剪辑器", right: "✂", onClick: () => alert("音频剪辑\n\n每张音效卡片右上角有 ✂ 按钮（点击直接打开剪辑面板）；也可右键音效卡片 → 剪辑音轨。\n\n在剪辑面板中拖动播放头，点「设为起点」/「设为终点」即可裁剪播放区间。") },
          { label: "一键清理重复音效", right: "🧹", onClick: handleDeduplicateSounds, danger: false },
          { label: "恢复 / 重置所有设置", right: "▶", onClick: () => setShowResetConfirm(true), danger: true },
          { label: "更改存储位置", right: "浏览器", onClick: () => alert("当前为 Web 预览版，所有数据存于浏览器 localStorage / IndexedDB。\n桌面版可改为本地文件夹（D:\\xddyx 等）。") },
          { label: "退出登录", right: "→", onClick: () => { clearToken(); navigate("/login"); }, danger: true },
        ];
        return (
          <>
            <div onClick={() => setShowMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 1199 }} />
            <div
              style={{
                position: "fixed",
                top: 60,
                right: 18,
                zIndex: 1200,
                borderRadius: 12,
                padding: 6,
                width: 280,
                maxHeight: "calc(100vh - 80px)",
                overflowY: "auto",
                background: "#fff",
                color: "#333",
                border: "1px solid rgba(60,50,45,0.14)",
                boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
              }}
            >
              {items.map((it, i) => (
                it.node ? (
                  <div key={i}>{it.node}</div>
                ) : (
                <div
                  key={i}
                  onClick={() => { it.onClick?.(); if (!it.danger) setShowMenu(false); }}
                  style={{
                    padding: "9px 12px",
                    borderRadius: 7,
                    fontSize: 13,
                    color: it.danger ? "#c0392b" : "#333",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span>{it.label}</span>
                  <span style={{ fontSize: 11, color: it.danger ? "#c0392b" : "#E6B66E", fontFamily: "sans-serif", whiteSpace: "nowrap" }}>{it.right}</span>
                </div>
                )
              ))}
            </div>
          </>
        );
      })()}

      {/* Batch import preview modal */}
      {batchDrafts && (
        <BatchImportModal
          drafts={batchDrafts}
          existing={sounds}
          sourceLabel={batchSource}
          busy={batchBusy}
          onChange={setBatchDrafts}
          onCancel={() => { if (!batchBusy) { setBatchDrafts(null); setBatchSource(""); } }}
          onConfirm={confirmBatchImport}
        />
      )}

      {/* About modal */}
      {showAbout && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1201, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }} onClick={() => setShowAbout(false)}>
          <div className="glass-strong" style={{ borderRadius: 16, padding: 28, width: 420 }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "var(--gold)", fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>关于 金玖音效助手</div>
            <div style={{ color: "rgba(50,42,36,0.85)", fontSize: 13, lineHeight: 1.7 }}>
              金玖 · 直播提词与音效一体化系统<br />
              当前模式：Web 预览版（数据存浏览器 localStorage / IndexedDB）<br />
              桌面打包目标：Tauri / Electron + 本地文件存储<br />
              主色：#E6B66E · 字体：楷体 · 风格：深空灰玻璃拟态
            </div>
            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
              <button className="btn gold-btn" onClick={() => setShowAbout(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset all settings confirm */}
      {showResetConfirm && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1201, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }} onClick={() => setShowResetConfirm(false)}>
          <div className="glass-strong" style={{ borderRadius: 16, padding: 28, width: 420 }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "#c0392b", fontSize: 17, fontWeight: "bold", marginBottom: 8 }}>恢复 / 重置所有设置</div>
            <div style={{ color: "rgba(50,42,36,0.85)", fontSize: 13, marginBottom: 18, lineHeight: 1.7 }}>
              将清空音效助手的偏好设置（菜单选项、字体大小、布局、闪避等）。<br />
              <b style={{ color: "#E6B66E" }}>音效本体、快捷键绑定、收藏不会被删除。</b>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setShowResetConfirm(false)}>取消</button>
              <button className="btn" style={{ color: "#c0392b", borderColor: "rgba(255,90,90,0.45)" }} onClick={() => {
                try { removePersisted("jt_sound_settings"); } catch {}
                setAppSettings({ windowPinned: false, shiftShortcuts: true, volumeStep: 10, fadePlay: false, fadeMs: 200, cardFontPct: 100, showShortcutBelowName: true, layoutMode: "default", tapNoStop: false, shortcutsEnabled: true, shortcutMode: "register" });
                setDuckFactor(30);
                setDuckFadeMs(450);
                setShowResetConfirm(false);
                setShowMenu(false);
              }}>确认重置</button>
            </div>
          </div>
        </div>
      )}

      {/* 功能快捷键设置面板 */}
      {showFuncPanel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1201, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }} onClick={() => { setShowFuncPanel(false); setFuncCapture(null); }}>
          <div style={{ borderRadius: 14, width: 640, maxWidth: "94vw", maxHeight: "86vh", background: "#fff", color: "#333", boxShadow: "0 18px 50px rgba(120,110,120,0.22)", overflow: "hidden", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            {/* 标题栏 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid rgba(60,50,45,0.12)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: "bold" }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#e74c3c", display: "inline-block" }} />
                功能快捷键设置
              </div>
              <div onClick={() => { setShowFuncPanel(false); setFuncCapture(null); }} style={{ cursor: "pointer", fontSize: 18, color: "#888", lineHeight: 1, padding: "0 4px" }}>×</div>
            </div>
            {/* 主体：左列动作列表 + 右列设置区 */}
            <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
              <div style={{ width: 300, borderRight: "1px solid rgba(60,50,45,0.12)", overflowY: "auto", padding: "6px 0" }}>
                {FUNC_ACTIONS.map(a => {
                  const sel = a.id === selectedFuncId;
                  const combo = funcShortcuts[a.id];
                  return (
                    <div
                      key={a.id}
                      onClick={() => { setSelectedFuncId(a.id); setFuncCapture(null); }}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                        padding: "9px 16px", cursor: "pointer", fontSize: 13,
                        background: sel ? "rgba(230,182,110,0.22)" : "transparent",
                        borderLeft: sel ? "3px solid #E6B66E" : "3px solid transparent",
                        color: sel ? "#E6B66E" : "#333",
                        fontWeight: sel ? "bold" : "normal",
                      }}
                      onMouseEnter={e => { if (!sel) e.currentTarget.style.background = "rgba(230,182,110,0.1)"; }}
                      onMouseLeave={e => { if (!sel) e.currentTarget.style.background = "transparent"; }}
                    >
                      <span>{a.label}</span>
                      <span style={{ fontSize: 11, fontFamily: "sans-serif", color: combo ? "#E6B66E" : "#bbb", whiteSpace: "nowrap" }}>
                        {combo ? comboLabel(combo) : "未设置"}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div style={{ flex: 1, padding: 18, display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    className="btn"
                    onClick={() => setFuncCapture(funcCapture === selectedFuncId ? null : selectedFuncId)}
                    style={{ background: funcCapture === selectedFuncId ? "rgba(231,76,60,0.16)" : "rgba(230,182,110,0.16)", color: funcCapture === selectedFuncId ? "#c0392b" : "#E6B66E", borderColor: funcCapture === selectedFuncId ? "rgba(231,76,60,0.4)" : "rgba(230,182,110,0.5)" }}
                  >{funcCapture === selectedFuncId ? "请按键…（Esc 取消）" : "设置快捷键"}</button>
                  <button
                    className="btn"
                    disabled={!funcShortcuts[selectedFuncId]}
                    onClick={() => { setFuncShortcuts(prev => { const n = { ...prev }; delete n[selectedFuncId]; return n; }); setFuncCapture(null); }}
                    style={{ opacity: funcShortcuts[selectedFuncId] ? 1 : 0.4 }}
                  >清除</button>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.9, color: "#555" }}>
                  当前动作：<b style={{ color: "#E6B66E" }}>{FUNC_ACTIONS.find(a => a.id === selectedFuncId)?.label}</b><br />
                  当前快捷键：<b style={{ color: funcShortcuts[selectedFuncId] ? "#E6B66E" : "#bbb", fontFamily: "sans-serif" }}>{funcShortcuts[selectedFuncId] ? comboLabel(funcShortcuts[selectedFuncId]) : "未设置"}</b>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.9, color: "#888", borderTop: "1px dashed rgba(60,50,45,0.14)", paddingTop: 12 }}>
                  快捷键可设置为单个按键，如 <b>A</b>、<b>1</b>、<b>F1</b><br />
                  也可设置为组合键，如 <b>Ctrl+1</b>、<b>Alt+A</b>、<b>Ctrl+Alt+D</b><br />
                  <span style={{ color: "#E6B66E" }}>⚡ 组合键（含 Ctrl/Alt）在软件最小化时仍全局生效<br />
                  单个按键仅在软件窗口处于前台时有效</span><br />
                  录制时按 <b>Esc</b> 取消，<b>Backspace / Delete</b> 清除当前绑定
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {missingToast && (
        <CountdownToast
          toastKey={missingToast.key}
          durationMs={3500}
          onExpire={() => setMissingToast(null)}
          progressColor="rgba(255,90,90,0.7)"
          style={{ top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1200, padding: "10px 18px 12px 18px", borderRadius: 10, background: "rgba(255,235,235,0.96)", border: "1px solid rgba(255,90,90,0.5)", color: "rgba(170,60,60,0.95)", fontSize: 13, maxWidth: 480 }}
        >
          ⚠ {missingToast.text}
        </CountdownToast>
      )}

      {importToast && (
        <CountdownToast
          toastKey={importToast.key}
          durationMs={4000}
          onExpire={() => setImportToast(null)}
          progressColor="rgba(100,200,120,0.7)"
          style={{ top: 20, right: 20, zIndex: 1100, padding: "10px 16px 12px 16px", borderRadius: 10, background: "rgba(235,250,240,0.96)", border: "1px solid rgba(100,200,120,0.4)", color: "rgba(50,120,75,0.95)", fontSize: 13 }}
        >
          导入完成 · 新增 {importToast.result.added} / 覆盖 {importToast.result.replaced} / 跳过 {importToast.result.skipped}
        </CountdownToast>
      )}

      {moveCatToast && (
        <CountdownToast
          toastKey={moveCatToast.key}
          durationMs={2500}
          onExpire={() => setMoveCatToast(null)}
          progressColor="rgba(109,175,196,0.7)"
          style={{ top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1500, padding: "10px 18px 12px 18px", borderRadius: 10, background: "rgba(235,248,255,0.96)", border: "1px solid rgba(109,175,196,0.45)", color: "rgba(30,80,110,0.95)", fontSize: 13, whiteSpace: "nowrap" }}
        >
          ✓ {moveCatToast.text}
        </CountdownToast>
      )}

      {batchCancelToast && (
        <CountdownToast
          toastKey={batchCancelToast.key}
          durationMs={3500}
          onExpire={() => setBatchCancelToast(null)}
          progressColor="rgba(200,160,80,0.7)"
          style={{ top: 20, right: 20, zIndex: 1100, padding: "10px 16px 12px 16px", borderRadius: 10, background: "rgba(255,250,235,0.96)", border: "1px solid rgba(200,160,80,0.4)", color: "rgba(120,90,30,0.95)", fontSize: 13 }}
        >
          批量导入已取消，中间写入的音频已清理
        </CountdownToast>
      )}

      {pendingSoundUndo && (
        <CountdownToast
          toastKey={pendingSoundUndo.expiresAt}
          durationMs={UNDO_TIMEOUT_MS}
          onExpire={expirePendingUndo}
          style={{ bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 1300, display: "flex", alignItems: "center", gap: 14, padding: "10px 16px 12px 18px", borderRadius: 12, background: "rgba(255,255,255,0.95)", border: "1px solid rgba(230,182,110,0.4)", color: "#2c2622", fontSize: 14, boxShadow: "0 8px 28px rgba(120,110,120,0.20)" }}
        >
          {({ remainingSec, hovered }) => (
            <>
              <span>{pendingSoundUndo.items.length > 1 ? `已删除 ${pendingSoundUndo.items.length} 个音效` : `已删除「${pendingSoundUndo.label}」`}</span>
              {hovered && (
                <span style={{ fontSize: 12, color: "rgba(230,182,110,0.85)", fontVariantNumeric: "tabular-nums" }}>还剩 {remainingSec} 秒</span>
              )}
              <button
                className="btn"
                style={{ color: "var(--gold)", padding: "4px 14px" }}
                onClick={() => handleSoundUndo()}
                title="撤销删除（Ctrl/⌘+Z）"
              >撤销</button>
              <span style={{ color: "rgba(92,82,74,0.40)", fontSize: 12 }}>Ctrl/⌘+Z</span>
            </>
          )}
        </CountdownToast>
      )}

      {showCleanupConfirm && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
          onClick={() => setShowCleanupConfirm(false)}>
          <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 460 }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "var(--gold)", fontSize: 17, fontWeight: "bold", marginBottom: 4 }}>清理失效音效</div>
            <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13, marginBottom: 14 }}>
              以下 <b style={{ color: "#c0392b" }}>{missingIds.size}</b> 条音效只剩元数据，音频文件已找不到。删除后将从列表和键盘绑定中移除（IndexedDB 残留也会一并清理）。
            </div>
            <div className="scroll-area" style={{ maxHeight: 220, border: "1px solid rgba(60,50,45,0.12)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, background: "rgba(255,255,255,0.5)" }}>
              {sounds.filter(s => missingIds.has(s.id)).map(s => (
                <div key={s.id} style={{ color: "rgba(170,60,60,0.9)", fontSize: 13, padding: "3px 0", display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                  {s.shortcut && (
                    <span style={{ color: "rgba(92,82,74,0.40)", fontSize: 11, fontFamily: "sans-serif" }}>
                      {s.shortcut === " " ? "Space" : s.shortcut.toUpperCase()}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setShowCleanupConfirm(false)}>取消</button>
              <button className="btn" style={{ color: "#c0392b", borderColor: "rgba(255,90,90,0.45)" }} onClick={cleanupMissingSounds}>确认清理</button>
            </div>
          </div>
        </div>
      )}

      {/* 快捷键冲突确认弹窗 */}
      {keyConflictDialog && kbdAssignKey && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
          onClick={() => setKeyConflictDialog(null)}
        >
          <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 400, maxWidth: "90vw" }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "#c0392b", fontSize: 17, fontWeight: "bold", marginBottom: 10 }}>⚠ 快捷键已被占用</div>
            <div style={{ color: "rgba(60,50,40,0.85)", fontSize: 14, lineHeight: 1.8, marginBottom: 20 }}>
              快捷键 <b style={{ color: "var(--gold)", fontFamily: "monospace", fontSize: 15 }}>
                {directShortcutLabel(kbdAssignKey)}
              </b> 已被【<b style={{ color: "rgba(60,50,40,0.95)" }}>{keyConflictDialog.takenByName}</b>】占用，请更换其他按键，或替换原绑定。
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() => setKeyConflictDialog(null)}
              >
                取消
              </button>
              <button
                className="btn"
                style={{ color: "var(--gold)", borderColor: "rgba(230,182,110,0.55)", fontWeight: "bold" }}
                onClick={() => {
                  if (keyConflictDialog.functionId) {
                    setFuncShortcuts(prev => removeFunctionShortcut(prev, keyConflictDialog.functionId!));
                  }
                  doAssign(keyConflictDialog.soundId, kbdAssignKey);
                }}
              >
                替换原绑定
              </button>
            </div>
          </div>
        </div>
      )}

      {rebindConfirm && (() => {
        const target = sounds.find(s => s.id === rebindConfirm.id);
        const libCandidates = sounds.filter(s => s.hasAudio && s.id !== rebindConfirm.id);
        const libSearchLow = rebindLibSearch.trim().toLowerCase();
        const libFiltered = libSearchLow
          ? libCandidates.filter(s => s.name.toLowerCase().includes(libSearchLow) || (s.category || "").toLowerCase().includes(libSearchLow))
          : libCandidates;
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 1001, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
            onClick={closeRebindConfirm}>
            <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 460, maxHeight: "90vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
              <div style={{ color: "var(--gold)", fontSize: 17, fontWeight: "bold", marginBottom: 4 }}>确认重新绑定</div>
              <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13, marginBottom: 14 }}>
                {rebindConfirm.currentUrl
                  ? (target ? <>正在替换音效「<b style={{ color: "rgba(50,42,36,0.85)" }}>{target.name}</b>」已绑定的音频。先分别试听对比，确认替换的是对的文件再保存。</> : "正在替换已绑定的音频，先分别试听对比再保存。")
                  : (target ? <>把音效「<b style={{ color: "rgba(50,42,36,0.85)" }}>{target.name}</b>」绑定为下面这个文件。先试听确认是对的文件再保存。</> : "先试听确认是对的文件再保存。")}
              </div>
              {rebindConfirm.currentUrl && (
                <div style={{ border: "1px solid rgba(60,50,45,0.12)", borderRadius: 10, padding: "12px 14px", marginBottom: 10, background: "rgba(245,240,232,0.6)" }}>
                  <div style={{ color: "rgba(92,82,74,0.85)", fontSize: 13, marginBottom: 10 }}>
                    🔊 当前已绑定的音频
                  </div>
                  <audio src={rebindConfirm.currentUrl} controls style={{ width: "100%" }} />
                </div>
              )}
              <div style={{ border: "1px solid rgba(230,182,110,0.5)", borderRadius: 10, padding: "12px 14px", marginBottom: 12, background: "rgba(255,250,242,0.7)" }}>
                <div style={{ color: "#2c2622", fontSize: 13, marginBottom: 10, wordBreak: "break-all" }}>
                  {rebindConfirm.currentUrl ? "🆕 " : "📄 "}{rebindConfirm.currentUrl && <span style={{ color: "var(--gold)" }}>新文件：</span>}{rebindConfirm.file.name}
                  <span style={{ color: "rgba(92,82,74,0.40)", fontSize: 11, marginLeft: 8 }}>{(rebindConfirm.file.size / 1024).toFixed(0)} KB</span>
                </div>
                <audio src={rebindConfirm.url} controls autoPlay style={{ width: "100%" }} />
              </div>

              {/* 从音效库挑选对比 */}
              <div style={{ marginBottom: 16 }}>
                <button
                  className="btn"
                  style={{ fontSize: 13, padding: "5px 12px", color: "rgba(60,50,40,0.75)", borderColor: "rgba(60,50,45,0.2)", background: rebindLibOpen ? "rgba(230,182,110,0.12)" : undefined, width: "100%", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between" }}
                  onClick={() => { setRebindLibOpen(v => !v); if (rebindLibOpen) { setRebindLibSearch(""); setRebindLibSelected(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; }); } }}
                >
                  <span>🎵 从已有音效库挑选对比</span>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{rebindLibOpen ? "▲ 收起" : "▼ 展开"}</span>
                </button>

                {rebindLibOpen && (
                  <div style={{ border: "1px solid rgba(60,50,45,0.12)", borderRadius: 10, padding: "12px 14px", marginTop: 8, background: "rgba(248,244,238,0.7)" }}>
                    <input
                      className="search-input"
                      style={{ width: "100%", marginBottom: 8, fontSize: 13, padding: "5px 10px", borderRadius: 7, border: "1px solid rgba(60,50,45,0.18)", background: "rgba(255,252,248,0.85)", boxSizing: "border-box" }}
                      placeholder="搜索音效名称或分类…"
                      value={rebindLibSearch}
                      onChange={e => setRebindLibSearch(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      autoFocus
                    />
                    <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                      {libFiltered.length === 0 && (
                        <div style={{ color: "rgba(92,82,74,0.5)", fontSize: 13, textAlign: "center", padding: "12px 0" }}>没有找到匹配的音效</div>
                      )}
                      {libFiltered.map(s => {
                        const isSelected = rebindLibSelected?.id === s.id;
                        return (
                          <div
                            key={s.id}
                            onClick={e => { e.stopPropagation(); void selectRebindLibSound(s); }}
                            style={{
                              display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, cursor: "pointer",
                              background: isSelected ? "rgba(230,182,110,0.18)" : "rgba(255,252,248,0.6)",
                              border: isSelected ? "1px solid rgba(230,182,110,0.55)" : "1px solid transparent",
                              transition: "background 0.15s",
                            }}
                          >
                            <span style={{ fontSize: 15 }}>{isSelected ? "🔊" : "🎵"}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, color: isSelected ? "var(--gold)" : "rgba(50,42,36,0.88)", fontWeight: isSelected ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                              {s.category && <div style={{ fontSize: 11, color: "rgba(92,82,74,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.category}{s.subCategory ? ` · ${s.subCategory}` : ""}</div>}
                            </div>
                            {s.shortcut && <span style={{ fontSize: 11, color: "rgba(92,82,74,0.45)", fontFamily: "monospace" }}>[{s.shortcut.toUpperCase()}]</span>}
                          </div>
                        );
                      })}
                    </div>

                    {rebindLibSelected && (
                      <div style={{ marginTop: 10, borderTop: "1px solid rgba(60,50,45,0.10)", paddingTop: 10 }}>
                        <div style={{ fontSize: 13, color: "rgba(50,42,36,0.8)", marginBottom: 6 }}>
                          已选：<b style={{ color: "var(--gold)" }}>{rebindLibSelected.name}</b>
                        </div>
                        <audio src={rebindLibSelected.url} controls autoPlay style={{ width: "100%", height: 32 }} />
                        <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8, cursor: "pointer", fontSize: 13, color: "rgba(50,42,36,0.75)", userSelect: "none" }}>
                          <input
                            type="checkbox"
                            checked={rebindSyncName}
                            onChange={e => setRebindSyncName(e.target.checked)}
                            style={{ accentColor: "var(--gold)", width: 15, height: 15, cursor: "pointer" }}
                          />
                          同时把名称改为「{rebindLibSelected.name}」
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button className="btn" onClick={closeRebindConfirm}>取消</button>
                <button className="btn" style={{ color: "var(--gold)", borderColor: "rgba(230,182,110,0.5)" }} onClick={() => void confirmRebind()}>绑定新文件</button>
                {rebindLibSelected && (
                  <button className="btn" style={{ color: "#fff", background: "var(--gold)", borderColor: "var(--gold)" }} onClick={() => void confirmRebindFromLib()}>
                    改绑为「{rebindLibSelected.name}」
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {batchRebind && (() => {
        const matchedCount = Object.keys(batchRebind.assign).length;
        const confirmedCount = Object.keys(batchRebind.assign).filter(id => batchRebind.kind[id] === "exact").length;
        const exactCount = Object.values(batchRebind.kind).filter(k => k === "exact").length;
        const fuzzyCount = Object.values(batchRebind.kind).filter(k => k === "fuzzy").length;
        const unmatchedItems = batchRebind.items.filter(it => batchRebind.assign[it.id] === undefined);
        const usedIdx = new Set(Object.values(batchRebind.assign));
        const leftoverFiles = batchRebind.files
          .map((f, i) => ({ f, i }))
          .filter(({ i }) => !usedIdx.has(i));
        // 只确认 priority 0/1（很可能/可能），存疑留着手动核对
        const confirmAllFuzzy = () => setBatchRebind(prev => {
          if (!prev) return prev;
          const kind = { ...prev.kind };
          for (const k of Object.keys(kind)) {
            if (kind[k] === "fuzzy" && getMatchTier(prev.scores[k] ?? 0).priority < 2) kind[k] = "exact";
          }
          return { ...prev, kind };
        });
        // 一键确认所有存疑（需用户主动点击）
        const confirmAllDoubt = () => setBatchRebind(prev => {
          if (!prev) return prev;
          const kind = { ...prev.kind };
          for (const k of Object.keys(kind)) {
            if (kind[k] === "fuzzy" && getMatchTier(prev.scores[k] ?? 0).priority === 2) kind[k] = "exact";
          }
          return { ...prev, kind };
        });
        // 排序：存疑(priority=2)最先 > 可能(1) > 很可能(0) > 精确 > 未匹配
        const sortedItems = [...batchRebind.items].sort((a, b) => {
          const kindA = batchRebind.kind[a.id];
          const kindB = batchRebind.kind[b.id];
          const scoreA = batchRebind.scores[a.id];
          const scoreB = batchRebind.scores[b.id];
          const assignedA = batchRebind.assign[a.id] !== undefined;
          const assignedB = batchRebind.assign[b.id] !== undefined;
          if (!assignedA && !assignedB) return 0;
          if (!assignedA) return 1;
          if (!assignedB) return -1;
          const priA = kindA === "fuzzy" ? getMatchTier(scoreA ?? 0).priority : -1;
          const priB = kindB === "fuzzy" ? getMatchTier(scoreB ?? 0).priority : -1;
          if (priB !== priA) return priB - priA;
          if (kindA === "fuzzy" && kindB === "fuzzy") return (scoreB ?? 0) - (scoreA ?? 0);
          return 0;
        });
        const doubtCount = batchRebind.items.filter(it =>
          batchRebind.kind[it.id] === "fuzzy" && getMatchTier(batchRebind.scores[it.id] ?? 0).priority === 2
        ).length;
        // 还未确认的高把握推荐（很可能/可能）
        const highConfUnconfirmed = batchRebind.items.filter(it =>
          batchRebind.kind[it.id] === "fuzzy" && getMatchTier(batchRebind.scores[it.id] ?? 0).priority < 2
        ).length;
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
            onClick={() => setBatchRebind(null)}>
            <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 540, maxHeight: "90vh", overflowY: "auto", WebkitOverflowScrolling: "touch" }} onClick={e => e.stopPropagation()}>
              <div style={{ color: "var(--gold)", fontSize: 17, fontWeight: "bold", marginBottom: 4 }}>批量重绑音效</div>
              <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
                已选中 <b style={{ color: "rgba(70,120,190,0.95)" }}>{batchRebind.files.length}</b> 个音频文件，
                精确匹配 <b style={{ color: "rgba(70,140,80,0.95)" }}>{exactCount}</b> 条
                {fuzzyCount > 0 && <>，智能推荐 <b style={{ color: "#E6B66E" }}>{fuzzyCount}</b> 条（请核对）</>}
                {doubtCount > 0 && <> · <b style={{ color: "rgba(190,60,50,0.95)" }}>{doubtCount}</b> 条「存疑」优先核对</>}。
                未匹配的条目可在下方手动指认。
              </div>
              {fuzzyCount > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, flexWrap: "wrap" }}>
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(70,180,80,0.10)", color: "rgba(70,140,80,0.95)", fontWeight: 600 }}>很可能</span>
                    <span style={{ color: "rgba(60,50,40,0.5)" }}>子串吻合</span>
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(230,182,110,0.15)", color: "rgba(180,130,30,0.95)", fontWeight: 600 }}>可能</span>
                    <span style={{ color: "rgba(60,50,40,0.5)" }}>近似匹配</span>
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(220,80,60,0.10)", color: "rgba(190,60,50,0.95)", fontWeight: 600 }}>存疑</span>
                    <span style={{ color: "rgba(60,50,40,0.5)" }}>差异较大，需逐条核对</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {highConfUnconfirmed > 0 && (
                      <button className="btn" style={{ fontSize: 12, padding: "3px 10px", color: "#E6B66E", borderColor: "rgba(255,200,120,0.4)" }} onClick={confirmAllFuzzy}>
                        确认全部推荐（{highConfUnconfirmed} 条很可能/可能）
                      </button>
                    )}
                    {doubtCount > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: highConfUnconfirmed > 0 ? 0 : "auto" }}>
                        <span style={{ fontSize: 12, color: "rgba(190,60,50,0.85)", fontWeight: 500 }}>
                          还有 {doubtCount} 条「存疑」待核对
                        </span>
                        <button className="btn" style={{ fontSize: 12, padding: "3px 10px", color: "rgba(190,60,50,0.9)", borderColor: "rgba(220,80,60,0.3)" }} onClick={confirmAllDoubt}>
                          一键确认存疑
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="scroll-area" style={{ maxHeight: 320, border: "1px solid rgba(60,50,45,0.12)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, background: "rgba(255,255,255,0.5)" }}>
                {sortedItems.map(it => {
                  const cur = batchRebind.assign[it.id];
                  const matched = cur !== undefined;
                  const isFuzzy = matched && batchRebind.kind[it.id] === "fuzzy";
                  const tier = isFuzzy ? getMatchTier(batchRebind.scores[it.id] ?? 0) : null;
                  const marker = matched ? (isFuzzy ? "≈ " : "✓ ") : "⚠ ";
                  const nameColor = isFuzzy ? (tier?.color ?? "#E6B66E") : matched ? "rgba(70,140,80,0.95)" : "rgba(170,60,60,0.9)";
                  const previewing = rebindPreview?.id === it.id;
                  const fuzzyFile = isFuzzy && cur !== undefined ? batchRebind.files[cur] : undefined;
                  const fuzzyBase = fuzzyFile ? baseName(fuzzyFile.name) : "";
                  const exactFile = !isFuzzy && matched && cur !== undefined ? batchRebind.files[cur] : undefined;
                  const exactBase = exactFile ? baseName(exactFile.name) : "";
                  const showExactCompare = !!exactFile && exactBase.toLowerCase() !== it.name.toLowerCase();
                  return (
                    <div key={it.id} style={{ padding: "5px 0", borderBottom: "1px solid rgba(60,50,45,0.10)", borderRadius: tier?.priority === 2 ? 6 : 0, background: tier ? tier.bg : "transparent", paddingLeft: tier ? 6 : 0, paddingRight: tier ? 4 : 0, marginBottom: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ flex: "0 0 34%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: nameColor, fontSize: 13 }}>
                        {marker}{it.name}
                      </span>
                      {tier && (
                        <span style={{ flex: "0 0 auto", padding: "1px 5px", borderRadius: 4, fontSize: 11, fontWeight: 700, color: tier.color, background: tier.bg, border: `1px solid ${tier.color}33`, whiteSpace: "nowrap" }}>
                          {tier.label} <span style={{ fontWeight: 400, opacity: 0.85 }}>{scoreToPercent(batchRebind.scores[it.id] ?? 0)}%</span>
                        </span>
                      )}
                      <select
                        value={cur ?? -1}
                        onChange={e => {
                          const v = Number(e.target.value);
                          setBatchRebind(prev => {
                            if (!prev) return prev;
                            const assign = { ...prev.assign };
                            const kind = { ...prev.kind };
                            const scores = { ...prev.scores };
                            if (v < 0) {
                              delete assign[it.id];
                              delete kind[it.id];
                              delete scores[it.id];
                            } else {
                              // 一个文件只能绑给一个条目：清掉占用同一文件的其它条目
                              for (const k of Object.keys(assign)) {
                                if (assign[k] === v) { delete assign[k]; delete kind[k]; delete scores[k]; }
                              }
                              assign[it.id] = v;
                              kind[it.id] = "exact"; // 用户手动选择视为已确认
                              delete scores[it.id];
                            }
                            return { ...prev, assign, kind, scores };
                          });
                        }}
                        style={{ flex: 1, fontSize: 12.5, padding: "4px 6px", borderRadius: 6, background: "rgba(255,255,255,0.55)", color: "#2c2622", border: isFuzzy ? `1px solid ${tier?.color ?? "#E6B66E"}44` : "1px solid rgba(60,50,45,0.12)" }}
                      >
                        <option value={-1}>（未绑定）</option>
                        {batchRebind.files.map((f, i) => (
                          <option key={i} value={i}>{f.name}</option>
                        ))}
                      </select>
                      {matched && (
                        <button
                          className="btn"
                          title="试听该条目当前绑定的文件"
                          style={{ fontSize: 11.5, padding: "3px 8px", color: previewing ? "rgba(170,60,60,0.9)" : "rgba(70,120,190,0.95)", borderColor: previewing ? "rgba(170,60,60,0.35)" : "rgba(70,120,190,0.35)", flex: "0 0 auto" }}
                          onClick={() => { const f = batchRebind.files[cur]; if (f) toggleRebindPreview(it.id, f); }}
                        >{previewing ? "⏸ 停止" : "▶ 试听"}</button>
                      )}
                      {isFuzzy && (
                        <button
                          className="btn"
                          style={{ fontSize: 11.5, padding: "3px 8px", color: tier?.color ?? "#E6B66E", borderColor: `${tier?.color ?? "#E6B66E"}55`, flex: "0 0 auto" }}
                          onClick={() => setBatchRebind(prev => prev ? { ...prev, kind: { ...prev.kind, [it.id]: "exact" }, scores: { ...prev.scores, [it.id]: -1 } } : prev)}
                        >确认✓</button>
                      )}
                    </div>
                    {isFuzzy && fuzzyFile && (
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap", marginTop: 3, marginLeft: 2, fontSize: 11.5, color: "rgba(60,50,40,0.62)" }}>
                        <span style={{ flex: "0 0 auto", opacity: 0.85 }}>推荐自</span>
                        <span style={{ minWidth: 0, wordBreak: "break-all" }} title={fuzzyFile.name}>
                          {renderMatchName(fuzzyBase, it.name)}
                        </span>
                        <span style={{ flex: "0 0 auto", color: tier?.color ?? "#E6B66E" }}>≈</span>
                        <span style={{ minWidth: 0, wordBreak: "break-all" }} title={it.name}>
                          {renderMatchName(it.name, fuzzyBase)}
                        </span>
                      </div>
                    )}
                    {showExactCompare && exactFile && (
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap", marginTop: 3, marginLeft: 2, fontSize: 11.5, color: "rgba(60,50,40,0.62)" }}>
                        <span style={{ flex: "0 0 auto", opacity: 0.85 }}>已指认</span>
                        <span style={{ minWidth: 0, wordBreak: "break-all" }} title={exactFile.name}>
                          {renderMatchName(exactBase, it.name)}
                        </span>
                        <span style={{ flex: "0 0 auto", color: "rgba(70,140,80,0.7)" }}>↔</span>
                        <span style={{ minWidth: 0, wordBreak: "break-all" }} title={it.name}>
                          {renderMatchName(it.name, exactBase)}
                        </span>
                      </div>
                    )}
                    {previewing && rebindPreview && (
                      <audio src={rebindPreview.url} controls autoPlay style={{ width: "100%", marginTop: 6, height: 32 }} />
                    )}
                    </div>
                  );
                })}
              </div>
              {(unmatchedItems.length > 0 || leftoverFiles.length > 0) && (
                <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 12, marginBottom: 14, lineHeight: 1.6 }}>
                  {unmatchedItems.length > 0 && <>仍有 <b style={{ color: "#E6B66E" }}>{unmatchedItems.length}</b> 条未指认。</>}
                  {leftoverFiles.length > 0 && <> 有 <b style={{ color: "#E6B66E" }}>{leftoverFiles.length}</b> 个文件未被使用。</>}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setBatchRebind(null)}>取消</button>
                <button
                  className="btn gold-btn"
                  disabled={confirmedCount === 0}
                  style={confirmedCount === 0 ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                  onClick={applyBatchRebind}
                >
                  重绑 {confirmedCount} 条
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {exportProgress && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}>
          <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 360 }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "var(--gold)", fontSize: 17, fontWeight: "bold", marginBottom: 4 }}>正在导出音效…</div>
            <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13, marginBottom: 14 }}>
              已处理 {exportProgress.done} / {exportProgress.total} 个音频文件
            </div>
            <div style={{ height: 8, borderRadius: 6, background: "rgba(60,50,45,0.10)", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${exportProgress.total > 0 ? (exportProgress.done / exportProgress.total) * 100 : 0}%`,
                background: "var(--gold)",
                transition: "width 0.15s",
              }} />
            </div>
            <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 12, marginTop: 8 }}>
              {exportProgress.total > 0 ? Math.round((exportProgress.done / exportProgress.total) * 100) : 0}% · 大文件较多时请稍候
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn" onClick={() => exportProgress.onCancel()}>取消</button>
            </div>
          </div>
        </div>
      )}

      {exportPrompt && (
        <ExportDialog
          pack={exportPrompt.pack}
          failed={exportPrompt.failed}
          onClose={() => setExportPrompt(null)}
        />
      )}

      {importPack && (
        <ImportDialog
          pack={importPack}
          existing={sounds}
          onCancel={() => setImportPack(null)}
          onConfirm={confirmImport}
        />
      )}

      {importProgress && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.45)", backdropFilter: "blur(8px)" }}>
          <div className="glass-strong" style={{ borderRadius: 16, padding: "26px 30px", width: 380, textAlign: "center" }}>
            <div style={{ color: "var(--gold)", fontSize: 16, fontWeight: "bold", marginBottom: 6 }}>
              {importProgress.title}
            </div>
            <div style={{ color: "var(--text-desc)", fontSize: 13, marginBottom: 16 }}>
              已写入 {importProgress.done} / {importProgress.total} 个音频
            </div>
            <div style={{ height: 8, borderRadius: 4, background: "rgba(60,50,45,0.10)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${importProgress.total > 0 ? (importProgress.done / importProgress.total) * 100 : 0}%`,
                  background: "var(--gold)",
                  transition: "width 0.15s linear",
                }}
              />
            </div>
            <div style={{ color: "var(--text-desc)", fontSize: 12, marginTop: 10 }}>
              {importProgress.total > 0 ? Math.round((importProgress.done / importProgress.total) * 100) : 0}% · 大文件较多时请稍候
            </div>
            {importProgress.onCancel && (
              <button
                className="btn"
                style={{ marginTop: 18 }}
                onClick={() => importProgress.onCancel?.()}
              >
                {importProgress.cancelLabel ?? "取消"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 快捷键 — 键盘占用图 + 音效管理（合并为一个板块） */}
      {!isMobile && activeTab === "kbd" && (() => {
        const PRESET_COLORS = ["#E6B66E", "#ff8fa0", "#7ec4f5", "#9bd989", "#e0a060", "#b794f6", "#ff6b6b", "#4ecdc4", "#ffd93d", "#6c5ce7", "#f78fb3", "#3dc1d3"];
        const colorRank = (c?: string) => {
          if (!c) return PRESET_COLORS.length;
          const i = PRESET_COLORS.indexOf(c);
          return i < 0 ? PRESET_COLORS.length : i;
        };
        const list = panelTab === "color"
          ? [...sounds].filter(s => !!s.shortcut).sort((a, b) => colorRank(a.color) - colorRank(b.color))
          : sounds.filter(s => !!s.shortcut);
        const boundCount = sounds.filter(s => !!s.shortcut).length;
        return (
          <div className="scroll-area" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, gap: 8, padding: "10px 6px 8px" }}>
            {/* 标题 */}
            <div style={{ textAlign: "center", color: "var(--gold)", fontSize: 18, fontWeight: "bold" }}>快捷键占用状态</div>
            <div style={{ textAlign: "center", color: "rgba(60,50,40,0.68)", fontSize: 13, lineHeight: 1.5 }}>
              {kbdAssignKey
                ? <span>正在绑定 <b style={{ color: "var(--gold)", fontFamily: "monospace" }}>{directShortcutLabel(kbdAssignKey)}</b> 键，请在下方音效列表中选择音效</span>
                : "点击音效卡片播放 · 右键设置快捷键 · 呼出模拟键盘辅助绑定"
              }
            </div>

            {/* 功能按钮行 */}
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", margin: "2px 0 4px" }}>
              <button className="btn" onClick={() => setShowSimKb(true)}
                style={{ padding: "7px 20px", fontSize: 14, color: "var(--gold)", borderColor: "rgba(230,182,110,0.6)", background: "rgba(230,182,110,0.10)", fontWeight: 600 }}>
                🎹 呼出模拟键盘
              </button>
              <button className="btn" onClick={clearAllShortcuts}
                style={{ padding: "7px 16px", fontSize: 14 }}
                title="清空所有音效的快捷键绑定（不可撤销）">
                🧹 清空快捷键
              </button>
              <button className="btn"
                title={"快捷键说明：\n• 直接单键（a-z、0-9、空格、标点等）→ 音效快捷键\n• F1-F12 → 系统功能键（题词控制等）\n• 不同分类的音效快捷键互不影响\n• 所有绑定均自动本地保存，刷新不丢失\n\n绑定方式：呼出模拟键盘 → 点击空白键位 → 选择音效"}
                style={{ padding: "7px 14px", fontSize: 14 }}>
                ❓ 快捷键说明
              </button>
            </div>

            {/* 图例 */}
            <div style={{ display: "flex", gap: 14, justifyContent: "center", fontSize: 12, color: "rgba(50,42,36,0.82)", flexWrap: "wrap" }}>
              <span><span style={{ display: "inline-block", width: 12, height: 12, background: "#E6B66E", borderRadius: 3, verticalAlign: "middle", marginRight: 4 }} />直接按键</span>
              <span style={{ opacity: 0.7 }}><span style={{ display: "inline-block", width: 12, height: 12, background: "#7ec4f5", borderRadius: 3, verticalAlign: "middle", marginRight: 4 }} />Ctrl 组合</span>
              <span style={{ opacity: 0.7 }}><span style={{ display: "inline-block", width: 12, height: 12, background: "#ffd93d", borderRadius: 3, verticalAlign: "middle", marginRight: 4 }} />Alt 组合</span>
              <span style={{ opacity: 0.7 }}><span style={{ display: "inline-block", width: 12, height: 12, background: "#e0a060", borderRadius: 3, verticalAlign: "middle", marginRight: 4 }} />Shift 组合</span>
              <span style={{ opacity: 0.7 }}><span style={{ display: "inline-block", width: 12, height: 12, background: "#9bd989", borderRadius: 3, verticalAlign: "middle", marginRight: 4 }} />多键组合</span>
            </div>

            {/* 统计分割线 */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 2px" }}>
              <div style={{ flex: 1, height: 1, background: "rgba(60,50,45,0.12)" }} />
              <span style={{ fontSize: 12, color: "rgba(60,50,40,0.50)", whiteSpace: "nowrap" }}>
                已绑定 {boundCount} 个音效
              </span>
              <div style={{ flex: 1, height: 1, background: "rgba(60,50,45,0.12)" }} />
            </div>

            {/* 音效管理子标签栏 */}
            <div style={{ display: "flex", gap: 4, paddingBottom: 4 }}>
              {([
                ["edit", "编辑 ✎"],
                ["color", "颜色排序"],
                ["default", "默认"],
              ] as const).map(([k, lab]) => (
                <button key={k} className="btn" onClick={() => setPanelTab(k)}
                  style={{
                    padding: "5px 14px", fontSize: 13,
                    ...(panelTab === k ? { color: "var(--gold)", borderColor: "rgba(230,182,110,0.6)", background: "rgba(230,182,110,0.12)" } : null)
                  }}
                >{lab}</button>
              ))}
              <div style={{ marginLeft: "auto", color: "rgba(60,50,40,0.65)", fontSize: 12, alignSelf: "center" }}>
                右键音效卡片可设置 / 修改快捷键
              </div>
            </div>

            {/* 音效网格 */}
            <div style={{ padding: 2 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 6 }}>
                {list.map(s => {
                  const isCur = panelCurrentId === s.id;
                  const isPlaying = playing.has(s.id);
                  const isMissing = missingIds.has(s.id);
                  return (
                    <div
                      key={s.id}
                      onClick={() => { setPanelCurrentId(s.id); tryTrigger(s.id, false, "kbd"); }}
                      onContextMenu={e => { e.preventDefault(); setKeyCtxMenu({ x: e.clientX, y: e.clientY, soundId: s.id }); }}
                      title={`${s.name}${s.shortcut ? ` · ${s.shortcut === " " ? "Space" : s.shortcut.toUpperCase()}` : ""} · 右键设置`}
                      style={{
                        position: "relative",
                        padding: "8px 6px 18px",
                        borderRadius: 10,
                        cursor: "pointer",
                        background: s.color
                          ? `linear-gradient(155deg, ${hexToRgba(s.color, 0.92)} 0%, ${hexToRgba(s.color, 0.62)} 48%, ${hexToRgba(s.color, 0.82)} 100%)`
                          : "linear-gradient(155deg, rgba(255,224,234,0.86) 0%, rgba(255,198,214,0.58) 48%, rgba(255,214,226,0.78) 100%)",
                        border: isCur ? "2px solid #fff" : isPlaying ? "2px solid var(--gold)" : s.color ? `1px solid ${hexToRgba(s.color, 0.6)}` : "1px solid rgba(255,208,222,0.30)",
                        backdropFilter: "blur(7px)",
                        WebkitBackdropFilter: "blur(7px)",
                        color: "#2c2622",
                        textShadow: "0 1px 2px rgba(255,255,255,0.5)",
                        fontWeight: 600,
                        textAlign: "center",
                        minHeight: 56,
                        boxShadow: isPlaying
                          ? "inset 0 1px 1px rgba(255,255,255,0.5), 0 0 0 1.5px rgba(230,182,110,0.6), 0 4px 10px rgba(120,110,120,0.18)"
                          : "inset 0 1px 1px rgba(255,255,255,0.45), inset 0 -3px 7px rgba(115,100,85,0.12), 0 3px 7px rgba(120,110,120,0.16)",
                        opacity: isMissing ? 0.55 : 1,
                      }}
                    >
                      {panelTab === "edit" && (
                        <button
                          onClick={e => { e.stopPropagation(); deleteSoundWithUndo(s.id); }}
                          title="删除"
                          style={{ position: "absolute", top: 2, right: 4, background: "rgba(255,255,255,0.7)", border: "none", borderRadius: 3, fontSize: 10, lineHeight: 1, padding: "1px 4px", cursor: "pointer", color: "#a33" }}
                        >×</button>
                      )}
                      <div style={{ fontSize: 13, lineHeight: 1.2, wordBreak: "break-all" }}>{s.name}</div>
                      <div style={{ position: "absolute", left: 4, bottom: 2, fontSize: 10, color: "#2c2622", fontFamily: "sans-serif", background: "rgba(255,255,255,0.55)", padding: "1px 5px", borderRadius: 3 }}>
                        {s.shortcut ? `${s.shortcut === " " ? "空格" : s.shortcut.toUpperCase()}键` : "自定义"}
                      </div>
                      {isMissing && (
                        <div style={{ position: "absolute", right: 4, bottom: 2, fontSize: 10, color: "#a33" }}>⚠</div>
                      )}
                      {(s.clipStart != null || s.clipEnd != null) && (() => {
                        const cs = s.clipStart ?? 0;
                        const ce = s.clipEnd ?? cs;
                        const dur = ce - cs;
                        return (
                          <span
                            style={{ position: "absolute", right: 4, bottom: isMissing ? 16 : 2, fontSize: 9, color: "rgba(90,75,175,0.85)", background: "rgba(90,75,175,0.10)", borderRadius: 3, padding: "0 3px", lineHeight: "14px", whiteSpace: "nowrap", cursor: "pointer" }}
                            title={`剪辑区间：${fmtClipFull(cs)} – ${fmtClipFull(ce)}`}
                            onClick={e => { e.stopPropagation(); setClipFor(s.id); }}
                            onPointerDown={e => e.stopPropagation()}
                          >✂ {fmtClipShort(dur)}</span>
                        );
                      })()}
                    </div>
                  );
                })}
                <div
                  onClick={() => openUpload()}
                  title="新增音效"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    minHeight: 56, borderRadius: 6, cursor: "pointer",
                    border: "1.5px dashed rgba(230,182,110,0.5)",
                    background: "rgba(230,182,110,0.06)",
                    color: "var(--gold)",
                    fontSize: 13,
                  }}
                >+ 添加音效</div>
              </div>
            </div>

            {/* 快捷键设置确认弹窗（从模拟键盘或右键菜单触发） */}
            {kbdAssignKey && (
              <div style={{ position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(6px)" }}
                onClick={() => setKbdAssignKey(null)}>
                <div className="glass-strong" style={{ borderRadius: 16, padding: 24, width: 420, maxHeight: "75vh", display: "flex", flexDirection: "column", gap: 12 }} onClick={e => e.stopPropagation()}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ color: "var(--gold)", fontSize: 16, fontWeight: "bold" }}>🎀 设置快捷键</div>
                    <button className="btn" onClick={() => setKbdAssignKey(null)} style={{ padding: "2px 8px" }}>×</button>
                  </div>
                  <div style={{ textAlign: "center", color: "rgba(50,42,36,0.85)", fontSize: 14 }}>
                    将下方音效绑定到 <b style={{ color: "var(--gold)", fontFamily: "monospace" }}>{directShortcutLabel(kbdAssignKey)}</b> 键
                  </div>
                  <div className="scroll-area" style={{ flex: 1, maxHeight: 360, border: "1px solid rgba(60,50,45,0.12)", borderRadius: 8, padding: 6 }}>
                    {sounds.length === 0 ? (
                      <div style={{ color: "rgba(60,50,40,0.75)", textAlign: "center", padding: 20 }}>暂无音效，请先上传</div>
                    ) : sounds.map(s => (
                      <div key={s.id} onClick={() => confirmAssign(s.id)}
                        style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "#2c2622" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.14)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <span><span style={{ display: "inline-block", width: 10, height: 10, background: s.color || "#888", borderRadius: 2, marginRight: 8, verticalAlign: "middle" }} />{s.name}</span>
                        {s.shortcut && <span style={{ color: "rgba(60,50,40,0.75)", fontSize: 11, fontFamily: "monospace" }}>{s.shortcut === " " ? "Space" : s.shortcut.toUpperCase()}</span>}
                      </div>
                    ))}
                  </div>
                  <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
                    点击列表中的音效即完成绑定 · 如该键已被占用会自动解绑原音效<br />
                    推荐使用单键，组合键功能为桌面版规划
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}


      {/* Main two-column */}
      {!isMobile && (activeTab === "main" || activeTab === "bg" || activeTab === "mine") && (<>
      {selectedSoundIds.size > 0 && (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", marginBottom: 2, borderRadius: 8, background: "rgba(230,182,110,0.1)", border: "1px solid rgba(230,182,110,0.35)" }}>
          <span style={{ color: "var(--gold)", fontSize: 13, fontWeight: "bold" }}>已选 {selectedSoundIds.size} 个音效</span>
          <button
            className="btn"
            style={{ padding: "4px 12px", fontSize: 12 }}
            title="把所有选中的音效一次性移到另一个场景/音效分类"
            onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setBatchMoveMenu({ x: r.left, y: r.bottom + 4 }); }}
          >移动到 ▾</button>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "rgba(92,82,74,0.8)" }} title="把所有选中音效的音量统一设为该值">
            音量
            <input
              type="range" min={0} max={100} defaultValue={80}
              onChange={e => setBatchVolPreview(Number(e.target.value))}
              onMouseUp={e => batchUpdateSelected({ volume: Number((e.target as HTMLInputElement).value) })}
              onTouchEnd={e => batchUpdateSelected({ volume: Number((e.target as HTMLInputElement).value) })}
              style={{ width: 90 }}
            />
            <span style={{ width: 26, textAlign: "right", color: "var(--gold)", fontWeight: "bold" }}>{batchVolPreview}</span>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "rgba(92,82,74,0.8)" }} title="把所有选中音效的播放方式批量设为循环或单次">
            循环
            <button className="btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => batchUpdateSelected({ loop: true })}>开</button>
            <button className="btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => batchUpdateSelected({ loop: false })}>关</button>
          </span>
          <button
            className="btn"
            style={{ padding: "4px 12px", fontSize: 12 }}
            title="批量设置选中音效的卡片颜色"
            onClick={() => setBatchColorOpen(true)}
          >颜色 🎨</button>
          <button
            className="btn"
            style={{ padding: "4px 12px", fontSize: 12 }}
            title="清除所有选中音效的颜色，恢复默认外观"
            onClick={() => batchUpdateSelected({ color: undefined })}
          >清除颜色 ✕</button>
          {(() => {
            const allFav = selectedSoundIds.size > 0 && [...selectedSoundIds].every(id => sounds.find(s => s.id === id)?.favorite);
            return (
              <button
                className="btn"
                style={{ padding: "4px 12px", fontSize: 12 }}
                title={allFav ? "取消所有选中音效的收藏" : "将所有选中音效加入收藏"}
                onClick={() => batchToggleFavorite([...selectedSoundIds], !allFav)}
              >{allFav ? "取消收藏 ☆" : "加入收藏 ★"}</button>
            );
          })()}
          <button
            className="btn"
            style={{ padding: "4px 12px", fontSize: 12, color: "#c0392b", borderColor: "rgba(255,120,120,0.4)" }}
            title="删除全部选中的音效（可撤销）"
            onClick={() => deleteSoundsWithUndo([...selectedSoundIds])}
          >删除选中</button>
          <button
            className="btn"
            style={{ padding: "4px 12px", fontSize: 12 }}
            title="清空多选"
            onClick={() => { setSelectedSoundIds(new Set()); selectAnchorRef.current = null; }}
          >清空</button>
          <span style={{ color: "rgba(92,82,74,0.40)", fontSize: 11 }}>Ctrl/⌘ 点选 · Shift 区间选 · 空白拖拽框选</span>
        </div>
      )}
      {/* 布局：收藏视图 | 普通视图（左侧竖向二级分类 + 中间音效） */}
      {selCat === "收藏" ? (
        <div ref={scrollAreaRef} className="scroll-area" style={{ flex: 1, position: "relative", minWidth: 0 }} onMouseDown={handleMarqueeMouseDown}>
          {marqueeRect && (
            <div style={{ position: "fixed", left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height, background: "rgba(230,182,110,0.14)", border: "1px solid rgba(230,182,110,0.7)", borderRadius: 4, zIndex: 1500, pointerEvents: "none" }} />
          )}
          {filteredByCat.length === 0 ? (
            <div style={{ color: "rgba(92,82,74,0.40)", fontSize: 14, padding: "20px 8px", textAlign: "center" }}>
              暂无收藏音效 · 右键主播音效或背景音乐里的音效 → 加入收藏
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignContent: "flex-start" }}>
              {filteredByCat.map(s => {
                const fp = favoriteOrderInfo.pos.get(s.id);
                return (
                  <SoundCard key={s.id} s={s} playing={playing.has(s.id)} missing={missingIds.has(s.id)}
                    compact
                    selected={selectedSoundIds.has(s.id)}
                    onSelect={(e) => handleCardSelect(e, s.id, filteredByCat)}
                    onTrigger={() => tryTrigger(s.id)}
                    onDelete={() => deleteSoundWithUndo(s.id)}
                    onEdit={() => setEditId(s.id)}
                    onRightClick={(e) => setKeyCtxMenu({ x: e.clientX, y: e.clientY, soundId: s.id })}
                    onToggleFavorite={() => toggleFavorite(s.id)}
                    favoriteRank={fp != null ? { pos: fp, total: favoriteOrderInfo.count } : null}
                    onMoveFavorite={(dir) => moveFavorite(s.id, dir)}
                    onRebind={(file) => requestRebind(s.id, file)}
                    onClip={() => setClipFor(s.id)}
                  />
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 一级分类横向栏 */}
          {(activeTab === "main" || activeTab === "bg" || activeTab === "mine") && (
            <div ref={catBarRef} style={{ flexShrink: 0, display: "flex", flexDirection: "row", alignItems: "center", gap: 4, overflowX: "auto", scrollbarWidth: "none" as React.CSSProperties["scrollbarWidth"], WebkitOverflowScrolling: "touch", overscrollBehaviorX: "contain", scrollBehavior: "smooth", paddingBottom: 6, borderBottom: "1px solid var(--border-soft)", transition: "outline 0.12s", ...(dragItem?.kind === 'sub' && dragOverTarget === 'catbar' ? { outline: "2px dashed rgba(109,175,196,0.80)", borderRadius: 4 } : {}) }}>
              {(activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats).map(c => {
                const catKey = catShortcuts[catSKey(poolOfTab(activeTab), c)];
                const isDragTarget = dragItem?.kind === 'cat' && dragOverTarget === c;
                const isRenaming = inlineEdit?.kind === "renameCat" && inlineEdit.name === c;
                if (isRenaming) {
                  return (
                    <input
                      key={c}
                      ref={inlineInputRef}
                      value={inlineVal}
                      onChange={e => setInlineVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") { e.preventDefault(); commitInlineEdit(inlineVal); }
                        if (e.key === "Escape") { e.preventDefault(); cancelInlineEdit(); }
                      }}
                      onBlur={() => commitInlineEdit(inlineVal)}
                      style={{ border: "1.5px solid rgba(109,175,196,0.70)", borderRadius: 8, padding: "4px 8px", fontSize: 12, background: "rgba(255,255,255,0.92)", color: "#1a3c4e", outline: "none", width: 100, boxShadow: "0 2px 8px rgba(109,175,196,0.20)", fontFamily: "inherit", flexShrink: 0 }}
                      placeholder="分类名称…"
                      maxLength={20}
                    />
                  );
                }
                return (
                  <button
                    key={c}
                    className={`cat-pill blue${selCat === c ? " active" : ""}${isDragTarget ? " active" : ""}`}
                    data-cat-pill={c}
                    onClick={() => { setSelCat(c); setSelSub(ALL_SUB); }}
                    onDoubleClick={() => { if (!(VIRTUAL_SOUND_CATS as readonly string[]).includes(c)) addSubUnder(c); }}
                    onContextMenu={(e) => { e.preventDefault(); setCatCtxMenu({ x: e.clientX, y: e.clientY, cat: c, pool: poolOfTab(activeTab) }); }}
                    onPointerDown={(e) => { if (e.button === 0) startDragLongPress(e, 'cat', c); }}
                    onPointerUp={cancelDragLongPress}
                    onPointerLeave={cancelDragLongPress}
                    title={`${c}${catKey ? ` · 快捷键 ${catKey === " " ? "Space" : catKey.toUpperCase()}（随机播放）` : ""} · 双击新增子分类 · 右键菜单 · 长按拖拽排序`}
                    style={{
                      padding: "5px 8px", flexShrink: 0, whiteSpace: "nowrap",
                      ...(isDragTarget ? { outline: "2px dashed rgba(109,175,196,0.80)", outlineOffset: 2 } : {}),
                      display: "flex", alignItems: "center", gap: 5,
                    }}
                  >
                    <span style={{
                      display: "inline-block", width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                      background: selCat === c ? "#c82020" : "rgba(200,70,70,0.70)",
                      boxShadow: selCat === c ? "0 0 4px rgba(200,50,50,0.7)" : "none",
                      transition: "all 0.15s",
                    }} />
                    <span style={{ fontSize: 12 }}>{c}</span>
                    {catKey && (
                      <span style={{ fontSize: 9, color: "var(--blue-deep)", fontFamily: "sans-serif", flexShrink: 0 }}>
                        {catKey === " " ? "␣" : catKey.toUpperCase()}
                      </span>
                    )}
                  </button>
                );
              })}
              {inlineEdit?.kind === "newCat" && (
                <input
                  ref={inlineInputRef}
                  value={inlineVal}
                  onChange={e => setInlineVal(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); commitInlineEdit(inlineVal); }
                    if (e.key === "Escape") { e.preventDefault(); cancelInlineEdit(); }
                  }}
                  onBlur={() => commitInlineEdit(inlineVal)}
                  style={{ border: "1.5px dashed rgba(109,175,196,0.70)", borderRadius: 8, padding: "4px 8px", fontSize: 12, background: "rgba(255,255,255,0.92)", color: "#1a3c4e", outline: "none", width: 100, boxShadow: "0 2px 8px rgba(109,175,196,0.20)", fontFamily: "inherit", flexShrink: 0 }}
                  placeholder="新栏目名称…"
                  maxLength={20}
                />
              )}
              <button
                className="btn"
                onClick={e => { e.stopPropagation(); const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect(); setPlusMenu({ x: r.left, y: r.bottom + 4 }); }}
                title="添加分类"
                style={{ padding: "4px 9px", fontSize: 14, color: "var(--blue-deep)", borderStyle: "dashed", borderColor: "rgba(109,175,196,0.55)", flexShrink: 0, lineHeight: 1 }}
              >＋</button>
            </div>
          )}
          {/* 二级分类左栏 + 音效内容区 */}
          <div style={{ flex: 1, display: "flex", gap: 0, minHeight: 0, marginTop: 6 }}>
            {/* 二级分类竖栏（左侧，非虚拟分类时始终显示） */}
            {selCat && !(VIRTUAL_SOUND_CATS as readonly string[]).includes(selCat) && (
              <div ref={subBarRef} style={{ width: 90, flexShrink: 0, display: "flex", flexDirection: "column", gap: 3, borderRight: "1px solid var(--border-soft)", paddingRight: 8, marginRight: 8, overflowY: "auto", scrollbarWidth: "none" as React.CSSProperties["scrollbarWidth"], WebkitOverflowScrolling: "touch", overscrollBehaviorY: "contain", scrollBehavior: "smooth", transition: "outline 0.12s", ...(dragItem?.kind === 'cat' && dragOverTarget === 'subbar' ? { outline: "2px dashed rgba(230,182,110,0.80)", borderRadius: 8 } : {}) }}>
                {subCats.length === 0 ? (
                  <div style={{ color: "rgba(92,82,74,0.38)", fontSize: 12, textAlign: "center", padding: "16px 4px", lineHeight: 1.9 }}>
                    暂无二级分类<br />
                    <span style={{ fontSize: 11 }}>双击分类名<br />或右键→添加</span>
                  </div>
                ) : (
                  <>
                    {subCats.map(sc => {
                      const isRenamingSub = inlineEdit?.kind === "renameSub" && inlineEdit.name === sc;
                      if (isRenamingSub) {
                        return (
                          <input
                            key={sc}
                            ref={inlineInputRef}
                            value={inlineVal}
                            onChange={e => setInlineVal(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") { e.preventDefault(); commitInlineEdit(inlineVal); }
                              if (e.key === "Escape") { e.preventDefault(); cancelInlineEdit(); }
                            }}
                            onBlur={() => commitInlineEdit(inlineVal)}
                            style={{ border: "1.5px solid rgba(230,182,110,0.70)", borderRadius: 7, padding: "3px 4px", fontSize: 12, background: "rgba(255,255,255,0.92)", color: "#3a2e00", outline: "none", width: "100%", boxShadow: "0 2px 8px rgba(230,182,110,0.20)", fontFamily: "inherit" }}
                            placeholder="子分类…"
                            maxLength={20}
                          />
                        );
                      }
                      const isSubDragTarget = dragItem?.kind === 'sub' && dragOverTarget === sc;
                      return (
                        <button
                          key={sc}
                          className={`cat-pill sub${selSub === sc ? " active" : ""}`}
                          data-sub-pill={sc}
                          onClick={() => setSelSub(sc)}
                          onContextMenu={(e) => { e.preventDefault(); setSubCtxMenu({ x: e.clientX, y: e.clientY, sub: sc }); }}
                          onPointerDown={(e) => { if (e.button === 0) startDragLongPress(e, 'sub', sc); }}
                          onPointerUp={cancelDragLongPress}
                          onPointerLeave={cancelDragLongPress}
                          title={`${sc} · 右键菜单 · 长按拖拽调整顺序 · 拖到上方分类栏升级为一级`}
                          style={{ fontSize: 12, padding: "5px 4px", touchAction: "none", width: "100%", textAlign: "center", overflow: "hidden", flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, ...(isSubDragTarget ? { outline: "2px dashed rgba(230,182,110,0.80)", outlineOffset: 2, borderRadius: 7 } : {}) }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{sc.length > 5 ? sc.slice(0, 5) : sc}</span>
                          {(() => { const cnt = tabSounds.filter(s => s.category === selCat && (s.subCategory ?? "") === sc).length; return cnt > 0 ? <span style={{ fontSize: 9, color: "rgba(60,50,45,0.5)", lineHeight: 1 }}>{cnt}</span> : null; })()}
                        </button>
                      );
                    })}
                    {inlineEdit?.kind === "newSub" && inlineEdit.parent === selCat && (
                      <input
                        ref={inlineInputRef}
                        value={inlineVal}
                        onChange={e => setInlineVal(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") { e.preventDefault(); commitInlineEdit(inlineVal); }
                          if (e.key === "Escape") { e.preventDefault(); cancelInlineEdit(); }
                        }}
                        onBlur={() => commitInlineEdit(inlineVal)}
                        style={{ border: "1.5px dashed rgba(230,182,110,0.70)", borderRadius: 7, padding: "3px 4px", fontSize: 12, background: "rgba(255,255,255,0.92)", color: "#3a2e00", outline: "none", width: "100%", boxShadow: "0 2px 8px rgba(230,182,110,0.20)", fontFamily: "inherit" }}
                        placeholder="新子分类…"
                        maxLength={20}
                      />
                    )}
                    {dragItem?.kind === 'cat' && dragOverTarget === 'subbar' && (
                      <span style={{ fontSize: 11, color: "rgba(230,182,110,0.75)", pointerEvents: "none", textAlign: "center", lineHeight: 1.3 }}>↓ 变为子分类</span>
                    )}
                  </>
                )}
              </div>
            )}
            {/* 音效主内容区 */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
              {/* 导入隐藏 input：始终挂载，不受 showSubPicker 影响 */}
              {(
                <input
                  ref={desktopImportInputRef}
                  type="file"
                  accept=".mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,.webm,.wma,.aiff,.amr,audio/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={e => {
                    const files = e.target.files ? Array.from(e.target.files) : [];
                    e.target.value = "";
                    void handleMobileImportFiles(files);
                  }}
                />
              )}
              {showSubPicker ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
                  <div style={{ color: "rgba(92,82,74,0.38)", fontSize: 15, textAlign: "center", lineHeight: 2.5 }}>
                    请选择左侧二级分类查看音效
                  </div>
                  {/* L1 层导入按钮 */}
                  {selCat !== "收藏" && (
                    <button
                      onClick={() => desktopImportInputRef.current?.click()}
                      disabled={mobileImportProgress?.status === "running"}
                      title={`导入音效到「${selCat}」`}
                      style={{
                        display: "inline-flex", flexDirection: "row", alignItems: "center",
                        gap: 5, padding: "6px 14px", borderRadius: 20, cursor: "pointer",
                        border: "1.5px dashed rgba(230,182,110,0.6)",
                        background: "rgba(230,182,110,0.05)",
                        color: "var(--gold)", outline: "none", flexShrink: 0, fontFamily: "inherit",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span style={{ fontSize: 14, lineHeight: 1, fontWeight: 300 }}>＋</span>
                      <span style={{ fontSize: 13, lineHeight: 1.3 }}>导入音效</span>
                    </button>
                  )}
                </div>
              ) : (
                <div ref={scrollAreaRef} className="scroll-area" style={{ flex: 1, position: "relative", minWidth: 0 }} onMouseDown={handleMarqueeMouseDown}>
                  {marqueeRect && (
                    <div style={{ position: "fixed", left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height, background: "rgba(230,182,110,0.14)", border: "1px solid rgba(230,182,110,0.7)", borderRadius: 4, zIndex: 1500, pointerEvents: "none" }} />
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignContent: "flex-start" }}>
                    {filteredByCat.length === 0 && (
                      <div style={{ width: "100%", color: "rgba(92,82,74,0.40)", fontSize: 14, padding: "20px 8px", textAlign: "center" }}>
                        {`暂无 ${selCat} 类型的音效`}
                      </div>
                    )}
                    {filteredByCat.map(s => {
                      const fp = favoriteOrderInfo.pos.get(s.id);
                      return (
                        <SoundCard key={s.id} s={s} playing={playing.has(s.id)} missing={missingIds.has(s.id)}
                          compact
                          selected={selectedSoundIds.has(s.id)}
                          onSelect={(e) => handleCardSelect(e, s.id, filteredByCat)}
                          onTrigger={() => tryTrigger(s.id)}
                          onDelete={() => deleteSoundWithUndo(s.id)}
                          onEdit={() => setEditId(s.id)}
                          onRightClick={(e) => setKeyCtxMenu({ x: e.clientX, y: e.clientY, soundId: s.id })}
                          onToggleFavorite={() => updateSound(s.id, { favorite: !s.favorite })}
                          favoriteRank={fp != null ? { pos: fp, total: favoriteOrderInfo.count } : null}
                          onMoveFavorite={(dir) => moveFavorite(s.id, dir)}
                          onRebind={(file) => requestRebind(s.id, file)}
                          onClip={() => setClipFor(s.id)}
                        />
                      );
                    })}
                    {/* ＋导入音效按钮（排在最后） */}
                    {selCat !== "收藏" && (
                      <button
                        onClick={() => desktopImportInputRef.current?.click()}
                        disabled={mobileImportProgress?.status === "running"}
                        title={`导入音效到「${selCat}${selSub && selSub !== ALL_SUB ? ` › ${selSub}` : ""}」`}
                        style={{
                          display: "inline-flex", flexDirection: "row", alignItems: "center",
                          gap: 5, padding: "6px 14px", borderRadius: 20, cursor: "pointer",
                          border: "1.5px dashed rgba(230,182,110,0.6)",
                          background: mobileImportProgress?.status === "running"
                            ? "rgba(230,182,110,0.08)" : "rgba(230,182,110,0.05)",
                          color: "var(--gold)", outline: "none", flexShrink: 0,
                          opacity: mobileImportProgress?.status === "running" ? 0.7 : 1,
                          fontFamily: "inherit", whiteSpace: "nowrap",
                        }}
                      >
                        {mobileImportProgress?.status === "running" ? (
                          <>
                            <span style={{ fontSize: 13, lineHeight: 1 }}>⏳</span>
                            <span style={{ fontSize: 13, lineHeight: 1.3 }}>
                              {mobileImportProgress.done}/{mobileImportProgress.total}
                            </span>
                          </>
                        ) : mobileImportProgress?.status === "done" ? (
                          <>
                            <span style={{ fontSize: 13, lineHeight: 1 }}>✅</span>
                            <span style={{ fontSize: 13, lineHeight: 1.3 }}>
                              {mobileImportProgress.failed > 0
                                ? `成功${mobileImportProgress.done - mobileImportProgress.failed}`
                                : `已导入${mobileImportProgress.done}个`}
                            </span>
                          </>
                        ) : (
                          <>
                            <span style={{ fontSize: 14, lineHeight: 1, fontWeight: 300 }}>＋</span>
                            <span style={{ fontSize: 13, lineHeight: 1.3 }}>导入音效</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* 系统 / 我的 切换（桌面端底部） */}
          <div style={{ flexShrink: 0, display: "flex", gap: 4, paddingTop: 8, borderTop: "1px solid var(--border-soft)" }}>
            {([["sys", "系统"], ["mine", "我的"]] as const).map(([k, lab]) => {
              const isActive = k === "mine" ? activeTab === "mine" : activeTab !== "mine";
              return (
                <button
                  key={k}
                  className={`btn${isActive ? " blue-btn" : ""}`}
                  style={{ padding: "5px 18px", fontSize: 13, minWidth: 0, whiteSpace: "nowrap" }}
                  onClick={() => {
                    if (k === "mine" && activeTab !== "mine") {
                      const newMineFrom = activeTab === "bg" ? "bg" : "main";
                      setMineFrom(newMineFrom);
                      setActiveTab("mine");
                      setSelCat((newMineFrom === "bg" ? mineBgCats : mineCats)[0] ?? "收藏");
                      setSelectedSoundIds(new Set()); setSelSub(ALL_SUB);
                    } else if (k === "sys" && activeTab === "mine") {
                      setActiveTab(mineFrom);
                      setSelCat((mineFrom === "bg" ? bgCats : mainCats)[0] ?? "收藏");
                      setSelectedSoundIds(new Set()); setSelSub(ALL_SUB);
                    }
                  }}
                >{lab}</button>
              );
            })}
          </div>
        </>
      )}

      </>)}

      {/* 内联全局快捷键捕获遮罩 */}
      {gsDirectCapture && (() => {
        const s = sounds.find(x => x.id === gsDirectCapture);
        return (
          <div
            style={{ position: "fixed", inset: 0, zIndex: 2500, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.38)", backdropFilter: "blur(6px)" }}
            onClick={() => { setGsDirectCapture(null); setGsDirectCandidate(null); setGsDirectConflict(null); }}
          >
            <div
              style={{ background: "#fff", borderRadius: 16, padding: "28px 36px", textAlign: "center", boxShadow: "0 16px 48px rgba(0,0,0,0.22)", minWidth: 280 }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ fontSize: 13, color: "rgba(60,50,40,0.65)", marginBottom: 6 }}>正在为</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#333", marginBottom: 16 }}>「{s?.name ?? ""}」设置全局快捷键</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "var(--gold)", letterSpacing: 1, marginBottom: 10 }}>
                {gsDirectCandidate === null ? "请按下快捷键…" : gsDirectCandidate === "" ? "清除快捷键" : gsDirectCandidate}
              </div>
              {gsDirectConflict && (
                <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>
                  已被「{gsDirectConflict.name}」占用，确认后将替换原快捷键
                </div>
              )}
              <div style={{ fontSize: 12, color: "rgba(60,50,40,0.5)", lineHeight: 1.7 }}>
                支持 A–Z、0–9、F1–F12 及 Ctrl / Alt 组合键<br />
                按键后不会自动关闭 · Backspace 清除 · Esc 取消
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 16 }}>
                <button className="btn" onClick={() => { setGsDirectCapture(null); setGsDirectCandidate(null); setGsDirectConflict(null); }}>取消</button>
                <button
                  className="btn primary"
                  disabled={gsDirectCandidate === null}
                  onClick={() => {
                    if (!s || gsDirectCandidate === null) return;
                    if (gsDirectConflict?.kind === "sound-global") updateSound(gsDirectConflict.id, { globalShortcut: undefined });
                    if (gsDirectConflict?.kind === "sound-direct") updateSound(gsDirectConflict.id, { shortcut: undefined });
                    if (gsDirectConflict?.kind === "function") setFuncShortcuts(prev => removeFunctionShortcut(prev, gsDirectConflict.id));
                    updateSound(s.id, { globalShortcut: gsDirectCandidate || undefined });
                    setGsDirectCapture(null); setGsDirectCandidate(null); setGsDirectConflict(null);
                  }}
                >{gsDirectConflict ? "替换原快捷键" : "确认保存"}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Keyboard key context menu (right-click on a bound key) */}
      {keyCtxMenu && (() => {
        const s = sounds.find(x => x.id === keyCtxMenu.soundId);
        if (!s) return null;
        const items: { label: string; onClick: () => void; highlight?: boolean }[] = [
          ...(s.favorite
            ? [{ label: "☆ 取消收藏（恢复原分类）", onClick: () => toggleFavorite(s.id), highlight: true }]
            : [{ label: "⭐ 加入收藏", onClick: () => toggleFavorite(s.id) }]),
          { label: s.globalShortcut ? `全局快捷键：${s.globalShortcut}（修改）` : "设置全局快捷键", onClick: () => { setGsDirectCandidate(s.globalShortcut ?? null); setGsDirectConflict(null); setGsDirectCapture(s.id); } },
          { label: "剪辑音轨", onClick: () => { setClipFor(s.id); } },
          { label: "设置按钮颜色", onClick: () => { setColorPickerFor(s.id); } },
          { label: "移到场景分类 ▸", onClick: () => { setSoundMoveMenu({ x: keyCtxMenu.x, y: keyCtxMenu.y, soundId: s.id }); } },
          { label: "🔊 设置独立音量", onClick: () => { setSoundVolDraft(s.volume ?? 100); setSoundVolModal({ soundId: s.id }); } },
        ];
        return (
          <>
            <div onClick={() => setKeyCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setKeyCtxMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 1199 }} />
            <div
              style={{
                position: "fixed",
                top: Math.min(keyCtxMenu.y, window.innerHeight - 220),
                left: Math.min(keyCtxMenu.x, window.innerWidth - 200),
                zIndex: 1200,
                borderRadius: 10,
                padding: 6,
                minWidth: 168,
                background: "#fff",
                color: "#333",
                border: "1px solid rgba(60,50,45,0.14)",
                boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
              }}
            >
              <div style={{ padding: "4px 10px 6px", fontSize: 11, color: "rgba(0,0,0,0.45)", borderBottom: "1px solid rgba(60,50,45,0.12)", marginBottom: 4 }}>
                {s.name}{s.shortcut ? ` · ${s.shortcut === " " ? "Space" : s.shortcut.toUpperCase()}` : ""}
              </div>
              {items.map((it, i) => (
                <div
                  key={i}
                  onClick={() => { it.onClick(); setKeyCtxMenu(null); }}
                  style={{
                    padding: "7px 12px",
                    borderRadius: 6,
                    fontSize: 13,
                    color: it.highlight ? "rgba(230,182,110,0.9)" : "#333",
                    cursor: "pointer",
                    fontWeight: it.highlight ? "bold" : "normal",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >{i + 1}. {it.label}</div>
              ))}
              {/* 独立音量拉杆：实时调节该音效的音量（0–200） */}
              <div style={{ height: 1, background: "rgba(60,50,45,0.10)", margin: "4px 8px" }} />
              <div style={{ padding: "6px 12px 4px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "rgba(0,0,0,0.6)", flexShrink: 0 }}>音量</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={1}
                  value={s.volume ?? 100}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    setSounds(prev => prev.map(x => x.id === s.id ? { ...x, volume: v } : x));
                  }}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 12, color: (s.volume ?? 100) > 100 ? "#e05c3a" : "rgba(0,0,0,0.55)", width: 34, textAlign: "right" }}>{s.volume ?? 100}%</span>
              </div>
              {/* 删除该音效（带撤销） */}
              <div style={{ height: 1, background: "rgba(60,50,45,0.10)", margin: "4px 8px" }} />
              <div
                onClick={() => { deleteSoundWithUndo(s.id); setKeyCtxMenu(null); }}
                style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "#c0392b", cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(192,57,43,0.12)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >🗑 删除此音效</div>
            </div>
          </>
        );
      })()}

      {/* 长按拖动变级别 ghost */}
      {dragItem && (
        <div style={{
          position: "fixed",
          left: dragPos.x + 14,
          top: dragPos.y - 18,
          zIndex: 9999,
          pointerEvents: "none",
          padding: "5px 14px",
          borderRadius: 20,
          fontSize: 13,
          fontWeight: "bold",
          background: dragItem.kind === 'cat' ? "rgba(95,165,195,0.93)" : "rgba(195,150,100,0.93)",
          color: "#fff",
          boxShadow: "0 4px 14px rgba(0,0,0,0.30)",
          whiteSpace: "nowrap",
          userSelect: "none",
        }}>
          {dragItem.kind === 'cat'
            ? `↓ ${dragItem.name} → 子分类`
            : `↑ ${dragItem.name} → 一级分类`}
        </div>
      )}

      {/* Category pill context menu (right-click on a 分类) */}
      {catCtxMenu && (() => {
        const c = catCtxMenu.cat;
        const cSkey = catSKey(catCtxMenu.pool, c);
        const hasKey = !!catShortcuts[cSkey];
        const items: { label: string; onClick: () => void; danger?: boolean }[] = [
          { label: "添加分类", onClick: () => { setCatCtxMenu(null); addSubUnder(c); } },
          { label: "修改分类名", onClick: () => renameSoundCat(c) },
          { label: "调整顺序", onClick: () => setReorderCats([...(activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats)]) },
          { label: hasKey ? "取消快捷键" : "设置快捷键（随机播放）", onClick: () => { if (hasKey) assignCatShortcut(catCtxMenu.pool, c, null); else setCatKeyCapture({ pool: catCtxMenu.pool, cat: c }); } },
          { label: "降级为二级分类", onClick: () => setCatMoveMenu({ x: catCtxMenu.x, y: catCtxMenu.y, cat: c }) },
          { label: "删除分类", onClick: () => deleteSoundCat(c), danger: true },
        ];
        return (
          <>
            <div onClick={() => setCatCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCatCtxMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 1199 }} />
            <div
              style={{
                position: "fixed",
                top: Math.min(catCtxMenu.y, window.innerHeight - 260),
                left: Math.min(catCtxMenu.x, window.innerWidth - 210),
                zIndex: 1200, borderRadius: 10, padding: 6, minWidth: 184,
                background: "#fff",
                color: "#333",
                border: "1px solid rgba(60,50,45,0.14)",
                boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
              }}
            >
              <div style={{ padding: "4px 10px 6px", fontSize: 11, color: "rgba(0,0,0,0.45)", borderBottom: "1px solid rgba(60,50,45,0.12)", marginBottom: 4 }}>
                分类「{c}」{hasKey ? ` · ${catShortcuts[cSkey] === " " ? "Space" : catShortcuts[cSkey].toUpperCase()}` : ""}
              </div>
              {items.map((it, i) => (
                <div
                  key={i}
                  onClick={() => { it.onClick(); setCatCtxMenu(null); }}
                  style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: it.danger ? "#c0392b" : "#333", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = it.danger ? "rgba(192,57,43,0.12)" : "rgba(230,182,110,0.18)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >{i + 1}. {it.label}</div>
              ))}
            </div>
          </>
        );
      })()}

      {/* 「栏目分类」：选择把当前栏目移到哪个栏目下面（降为其子分类） */}
      {catMoveMenu && (() => {
        const child = catMoveMenu.cat;
        const targets = (activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats).filter(c => c !== child);
        return (
          <>
            <div onClick={() => setCatMoveMenu(null)} onContextMenu={e => { e.preventDefault(); setCatMoveMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 1199 }} />
            <div
              style={{
                position: "fixed",
                top: Math.min(catMoveMenu.y, window.innerHeight - 120),
                left: Math.min(catMoveMenu.x, window.innerWidth - 210),
                zIndex: 1200, borderRadius: 10, padding: 6, minWidth: 184,
                background: "#fff",
                color: "#333",
                border: "1px solid rgba(60,50,45,0.14)",
                boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
                maxHeight: "60vh", overflowY: "auto",
              }}
            >
              <div style={{ padding: "4px 10px 6px", fontSize: 11, color: "rgba(0,0,0,0.45)", borderBottom: "1px solid rgba(60,50,45,0.12)", marginBottom: 4 }}>
                把「{child}」移到哪个栏目下面
              </div>
              {targets.length === 0 ? (
                <div style={{ padding: "7px 12px", fontSize: 13, color: "rgba(0,0,0,0.4)" }}>无其他栏目可选</div>
              ) : targets.map((t, i) => (
                <div
                  key={t}
                  onClick={() => { moveCatUnder(child, t); setCatMoveMenu(null); }}
                  style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "#333", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >{i + 1}. {t}</div>
              ))}
            </div>
          </>
        );
      })()}

      {/* 「添加分类」目标选择菜单：先选在哪个场景分类下，再命名新建空子分类 */}
      {addSubMenu && (() => {
        const targets = (activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats);
        return (
          <>
            <div onClick={() => setAddSubMenu(null)} onContextMenu={e => { e.preventDefault(); setAddSubMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 1199 }} />
            <div
              style={{
                position: "fixed",
                top: Math.min(addSubMenu.y, window.innerHeight - 120),
                left: Math.min(addSubMenu.x, window.innerWidth - 210),
                zIndex: 1200, borderRadius: 10, padding: 6, minWidth: 184,
                background: "#fff",
                color: "#333",
                border: "1px solid rgba(60,50,45,0.14)",
                boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
                maxHeight: "60vh", overflowY: "auto",
              }}
            >
              <div style={{ padding: "4px 10px 6px", fontSize: 11, color: "rgba(0,0,0,0.45)", borderBottom: "1px solid rgba(60,50,45,0.12)", marginBottom: 4 }}>
                在哪个场景分类下新增子分类
              </div>
              {targets.length === 0 ? (
                <div style={{ padding: "7px 12px", fontSize: 13, color: "rgba(0,0,0,0.4)" }}>暂无场景分类</div>
              ) : targets.map((t, i) => (
                <div
                  key={t}
                  onClick={() => { setAddSubMenu(null); addSubUnder(t); }}
                  style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "#333", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >{i + 1}. {t}</div>
              ))}
            </div>
          </>
        );
      })()}

      {/* ＋ 按钮弹出的小菜单：选添加一级分类 还是 二级分类 */}
      {plusMenu && (() => {
        const cats = (activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats);
        return (
          <>
            <div onClick={() => setPlusMenu(null)} onContextMenu={e => { e.preventDefault(); setPlusMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 1299 }} />
            <div style={{
              position: "fixed",
              top: Math.min(plusMenu.y, window.innerHeight - 140),
              left: Math.min(plusMenu.x, window.innerWidth - 200),
              zIndex: 1300, borderRadius: 10, padding: 6, minWidth: 172,
              background: "#fff", color: "#333",
              border: "1px solid rgba(60,50,45,0.14)",
              boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
            }}>
              {[
                { label: "＋ 添加一级分类", onClick: () => { setPlusMenu(null); addCategory(); }, disabled: false },
                { label: "＋ 添加二级分类", onClick: () => { setPlusMenu(null); setAddSubModal({ parentCat: cats[0] ?? "", name: "" }); }, disabled: false },
                { label: "📋 批量添加分类", onClick: () => {}, disabled: true, hint: "即将推出" },
              ].map(item => (
                <div key={item.label} onClick={item.disabled ? undefined : item.onClick}
                  style={{ padding: "8px 14px", borderRadius: 6, fontSize: 13, cursor: item.disabled ? "default" : "pointer", opacity: item.disabled ? 0.45 : 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                  onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = "rgba(109,175,196,0.14)"; }}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span>{item.label}</span>
                  {'hint' in item && item.hint ? <span style={{ fontSize: 10, color: "rgba(60,50,45,0.45)", background: "rgba(60,50,45,0.07)", borderRadius: 4, padding: "1px 5px" }}>{item.hint}</span> : null}
                </div>
              ))}
            </div>
          </>
        );
      })()}

      {/* 添加二级分类 modal：选择所属一级分类 + 输入名称 */}
      {addSubModal && (() => {
        const cats = (activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats).filter(c => !(VIRTUAL_SOUND_CATS as readonly string[]).includes(c));
        const confirmAdd = () => {
          const name = addSubModal.name.trim();
          const parent = addSubModal.parentCat;
          if (!name || !parent) return;
          setAddSubModal(null);
          addSubUnder(parent);
          // addSubUnder 会设置 inlineEdit newSub，此时 inlineVal 会被 commitInlineEdit 使用
          // 但 addSubUnder 设置的是空名称等待用户内联输入；我们直接提交：
          setTimeout(() => {
            setInlineVal(name);
            setInlineEdit({ kind: "newSub", parent });
            setTimeout(() => commitInlineEdit(name), 50);
          }, 0);
        };
        return (
          <>
            <div onClick={() => setAddSubModal(null)} style={{ position: "fixed", inset: 0, zIndex: 1399, background: "rgba(0,0,0,0.25)" }} />
            <div style={{
              position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
              zIndex: 1400, borderRadius: 14, padding: "22px 24px 18px",
              background: "#fff", minWidth: 320, boxShadow: "0 16px 48px rgba(80,70,60,0.22)",
              border: "1.5px solid rgba(109,175,196,0.25)",
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#1a3c4e", marginBottom: 16 }}>添加二级分类</div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: "rgba(60,50,45,0.55)", marginBottom: 5 }}>所属一级分类</div>
                {cats.length === 0 ? (
                  <div style={{ fontSize: 13, color: "rgba(60,50,45,0.45)" }}>请先添加一级分类</div>
                ) : (
                  <select
                    value={addSubModal.parentCat}
                    onChange={e => setAddSubModal(prev => prev ? { ...prev, parentCat: e.target.value } : prev)}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1.5px solid rgba(109,175,196,0.45)", fontSize: 13, background: "rgba(245,252,255,0.95)", color: "#1a3c4e", outline: "none", fontFamily: "inherit" }}
                  >
                    {cats.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
              </div>
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 12, color: "rgba(60,50,45,0.55)", marginBottom: 5 }}>二级分类名称</div>
                <input
                  autoFocus
                  value={addSubModal.name}
                  onChange={e => setAddSubModal(prev => prev ? { ...prev, name: e.target.value } : prev)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); confirmAdd(); } if (e.key === "Escape") setAddSubModal(null); }}
                  placeholder="请输入二级分类名称"
                  maxLength={20}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1.5px solid rgba(109,175,196,0.45)", fontSize: 13, background: "rgba(245,252,255,0.95)", color: "#1a3c4e", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
                />
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn" style={{ fontSize: 13, padding: "5px 16px" }} onClick={() => setAddSubModal(null)}>取消</button>
                <button type="button" className="btn" style={{ fontSize: 13, padding: "5px 16px", background: "rgba(109,175,196,0.15)", color: "var(--blue-deep)", borderColor: "rgba(109,175,196,0.5)", fontWeight: 600 }} onClick={confirmAdd} disabled={!addSubModal.name.trim() || !addSubModal.parentCat}>确认添加</button>
              </div>
            </div>
          </>
        );
      })()}

      {/* 音效「移到场景分类」子菜单：把该音效归类到任意一个上级场景分类，显示在该分类下 */}
      {soundMoveMenu && (() => {
        const s = sounds.find(x => x.id === soundMoveMenu.soundId);
        if (!s) return null;
        const pool = soundPool(s);
        const cats = (pool === "bg" ? bgCats : pool === "mine" ? (isBgSound(s) ? mineBgCats : mineCats) : mainCats)
          .filter(c => !(VIRTUAL_SOUND_CATS as readonly string[]).includes(c));
        const subsOfCat = (cat: string): string[] => {
          const seen: string[] = [];
          for (const snd of sounds) {
            if (soundPool(snd) === pool && snd.category === cat && snd.subCategory && !seen.includes(snd.subCategory)) seen.push(snd.subCategory);
          }
          for (const sub of subCatReg[cat] ?? []) if (!seen.includes(sub)) seen.push(sub);
          return seen;
        };
        const q = soundMoveQuery.trim().toLowerCase();
        type SMItem = { cat: string; sub: string | null; displayLabel: string };
        const items: SMItem[] = [];
        for (const cat of cats) {
          const subs = subsOfCat(cat);
          if (!q) {
            items.push({ cat, sub: null, displayLabel: cat });
            for (const sub of subs) items.push({ cat, sub, displayLabel: sub });
          } else {
            const catMatch = cat.toLowerCase().includes(q);
            const matchSubs = subs.filter(sub => sub.toLowerCase().includes(q));
            if (catMatch) {
              items.push({ cat, sub: null, displayLabel: cat });
              for (const sub of subs) items.push({ cat, sub, displayLabel: sub });
            } else {
              for (const sub of matchSubs) items.push({ cat, sub, displayLabel: `${cat} / ${sub}` });
            }
          }
        }
        const closeMenu = () => { setSoundMoveMenu(null); setSoundMoveQuery(""); };
        const moveSound = (cat: string, sub: string | null) => {
          const isCur = s.category === cat && (sub !== null ? (s.subCategory ?? "") === sub : !(s.subCategory));
          if (isCur) { alert("该音效已在当前分类"); return; }
          const dest = sub ? `${cat} · ${sub}` : cat;
          setSounds(prev => prev.map(x => x.id === s.id ? { ...x, category: cat, subCategory: sub ?? "" } : x));
          if (sub && cat !== UNCAT) setSubCatReg(prev => { const ex = prev[cat] ?? []; if (ex.includes(sub)) return prev; return { ...prev, [cat]: [...ex, sub] }; });
          setMoveCatToast({ text: `已移到【${dest}】`, key: Date.now() });
          closeMenu(); setKeyCtxMenu(null);
        };
        return (
          <>
            <div onClick={closeMenu} style={{ position: "fixed", inset: 0, zIndex: 1399, background: "rgba(0,0,0,0.22)", backdropFilter: "blur(2px)" }} />
            <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 1400, borderRadius: 14, width: 320, maxHeight: "72vh", display: "flex", flexDirection: "column", background: "#fff", boxShadow: "0 16px 48px rgba(80,70,60,0.28)", border: "1.5px solid rgba(60,50,45,0.12)" }}>
              <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid rgba(60,50,45,0.10)", flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#2c2622", marginBottom: 8 }}>把「{s.name}」移到哪个分类</div>
                <input
                  autoFocus
                  value={soundMoveQuery}
                  onChange={e => setSoundMoveQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === "Escape") closeMenu(); }}
                  placeholder="搜索一级分类或二级分类"
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1.5px solid rgba(109,175,196,0.45)", fontSize: 12.5, background: "rgba(245,252,255,0.95)", color: "#1a3c4e", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
                />
              </div>
              <div style={{ overflowY: "auto", flex: 1, padding: "4px 6px" }}>
                {items.length === 0 ? (
                  <div style={{ padding: "14px", fontSize: 13, color: "rgba(0,0,0,0.4)", textAlign: "center" }}>无匹配分类</div>
                ) : items.map((item, i) => {
                  const isCur = s.category === item.cat && (item.sub !== null ? (s.subCategory ?? "") === item.sub : !(s.subCategory));
                  const isSubRow = item.sub !== null && !q;
                  return (
                    <div
                      key={i}
                      onClick={() => moveSound(item.cat, item.sub)}
                      style={{ padding: isSubRow ? "6px 12px 6px 24px" : "7px 12px", borderRadius: 6, fontSize: isSubRow ? 12.5 : 13, fontWeight: isSubRow ? 400 : 600, color: isCur ? "var(--gold)" : isSubRow ? "rgba(0,0,0,0.65)" : "#2c2622", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ flex: 1 }}>{isSubRow ? `└ ${item.displayLabel}` : item.displayLabel}</span>
                      {isCur && <span style={{ fontSize: 10, color: "var(--gold)", background: "rgba(230,182,110,0.18)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>当前</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        );
      })()}

      {/* 音效独立音量设置弹窗 */}
      {soundVolModal && (() => {
        const sv = sounds.find(x => x.id === soundVolModal.soundId);
        if (!sv) return null;
        const over100 = soundVolDraft > 100;
        return (
          <div
            style={{ position: "fixed", inset: 0, zIndex: 1500, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,100,0.32)", backdropFilter: "blur(8px)" }}
            onClick={() => setSoundVolModal(null)}
          >
            <div
              className="glass-strong"
              style={{ borderRadius: 16, padding: 0, width: 360, overflow: "hidden", boxShadow: "0 16px 48px rgba(80,70,60,0.28)", border: "1.5px solid rgba(230,182,110,0.25)" }}
              onClick={e => e.stopPropagation()}
            >
              {/* 标题栏 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px 12px", borderBottom: "1px solid rgba(60,50,45,0.10)" }}>
                <span style={{ fontSize: 16 }}>🔊</span>
                <span style={{ flex: 1, fontWeight: 700, fontSize: 15, color: "rgba(50,42,36,0.92)" }}>设置音效独立音量</span>
                <button
                  onClick={() => setSoundVolModal(null)}
                  style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "rgba(50,42,36,0.45)", padding: "0 4px", lineHeight: 1 }}
                >✕</button>
              </div>
              {/* 音效名称 */}
              <div style={{ padding: "18px 20px 4px", textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--gold)", lineHeight: 1.5, wordBreak: "break-all" }}>{sv.name}</div>
              </div>
              {/* 滑块区 */}
              <div style={{ padding: "16px 20px 6px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, color: "rgba(50,42,36,0.7)", flexShrink: 0 }}>音量</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={1}
                  value={soundVolDraft}
                  onChange={e => setSoundVolDraft(+e.target.value)}
                  style={{ flex: 1, accentColor: over100 ? "#e05c3a" : "var(--gold)" }}
                />
                <span style={{ fontSize: 16, fontWeight: 700, color: over100 ? "#e05c3a" : "var(--gold)", width: 48, textAlign: "right", flexShrink: 0 }}>{soundVolDraft}%</span>
              </div>
              {/* 说明文字 */}
              <div style={{ padding: "4px 20px 14px", fontSize: 12, color: "rgba(80,70,60,0.55)", lineHeight: 1.8 }}>
                100% 为正常音量<br />
                {over100
                  ? <span style={{ color: "#e05c3a", fontWeight: 600 }}>⚠ 大于此值会放大音量，可能导致失真<br /></span>
                  : <span>大于此值放大音量，可能会失真<br /></span>
                }
                小于此值降低音量
              </div>
              {/* 底部按钮 */}
              <div style={{ display: "flex", gap: 10, padding: "0 20px 18px" }}>
                <button
                  className="btn"
                  style={{ flex: 1, padding: "9px 0", fontSize: 13, color: "rgba(50,42,36,0.65)" }}
                  onClick={() => {
                    updateSound(sv.id, { volume: 100 });
                    setSoundVolModal(null);
                    setMoveCatToast({ text: `已恢复「${sv.name}」默认音量（100%）`, key: Date.now() });
                  }}
                >清除设置</button>
                <button
                  className="btn"
                  style={{ flex: 1, padding: "9px 0", fontSize: 13, background: "rgba(230,182,110,0.22)", borderColor: "rgba(230,182,110,0.55)", color: "rgba(50,42,36,0.92)", fontWeight: 700 }}
                  onClick={() => {
                    updateSound(sv.id, { volume: soundVolDraft });
                    setSoundVolModal(null);
                    setMoveCatToast({ text: `已保存「${sv.name}」独立音量 ${soundVolDraft}%`, key: Date.now() });
                  }}
                >保存音量</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 多选批量「移动到…」目标分类菜单：列出当前板块的全部场景分类（及其子分类），点击即把所有选中音效一次性归类过去 */}
      {batchMoveMenu && (() => {
        const poolCats = (activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats)
          .filter(c => !(VIRTUAL_SOUND_CATS as readonly string[]).includes(c));
        const subsOf = (cat: string): string[] => {
          const seen: string[] = [];
          for (const s of tabSounds) {
            if (s.category === cat && s.subCategory && !seen.includes(s.subCategory)) seen.push(s.subCategory);
          }
          for (const sub of subCatReg[cat] ?? []) if (!seen.includes(sub)) seen.push(sub);
          return seen;
        };
        const bq = batchMoveQuery.trim().toLowerCase();
        type BMItem = { cat: string; sub: string | null; displayLabel: string };
        const bmItems: BMItem[] = [];
        for (const cat of poolCats) {
          const subs = subsOf(cat);
          if (!bq) {
            bmItems.push({ cat, sub: null, displayLabel: cat });
            for (const sub of subs) bmItems.push({ cat, sub, displayLabel: sub });
          } else {
            const catMatch = cat.toLowerCase().includes(bq);
            const matchSubs = subs.filter(sub => sub.toLowerCase().includes(bq));
            if (catMatch) {
              bmItems.push({ cat, sub: null, displayLabel: cat });
              for (const sub of subs) bmItems.push({ cat, sub, displayLabel: sub });
            } else {
              for (const sub of matchSubs) bmItems.push({ cat, sub, displayLabel: `${cat} / ${sub}` });
            }
          }
        }
        const closeBatch = () => { setBatchMoveMenu(null); setBatchMoveQuery(""); };
        return (
          <>
            <div onClick={closeBatch} style={{ position: "fixed", inset: 0, zIndex: 1399, background: "rgba(0,0,0,0.22)", backdropFilter: "blur(2px)" }} />
            <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 1400, borderRadius: 14, width: 320, maxHeight: "72vh", display: "flex", flexDirection: "column", background: "#fff", boxShadow: "0 16px 48px rgba(80,70,60,0.28)", border: "1.5px solid rgba(60,50,45,0.12)" }}>
              <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid rgba(60,50,45,0.10)", flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#2c2622", marginBottom: 8 }}>把选中的 {selectedSoundIds.size} 个音效移到…</div>
                <input
                  autoFocus
                  value={batchMoveQuery}
                  onChange={e => setBatchMoveQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === "Escape") closeBatch(); }}
                  placeholder="搜索一级分类或二级分类"
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1.5px solid rgba(109,175,196,0.45)", fontSize: 12.5, background: "rgba(245,252,255,0.95)", color: "#1a3c4e", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
                />
              </div>
              <div style={{ overflowY: "auto", flex: 1, padding: "4px 6px" }}>
                {bmItems.length === 0 ? (
                  <div style={{ padding: "14px", fontSize: 13, color: "rgba(0,0,0,0.4)", textAlign: "center" }}>无匹配分类</div>
                ) : bmItems.map((item, i) => {
                  const isSubRow = item.sub !== null && !bq;
                  return (
                    <div
                      key={i}
                      onClick={() => { batchMoveSelected(item.cat, item.sub ?? ""); closeBatch(); }}
                      style={{ padding: isSubRow ? "6px 12px 6px 24px" : "7px 12px", borderRadius: 6, fontSize: isSubRow ? 12.5 : 13, fontWeight: isSubRow ? 400 : 600, color: isSubRow ? "rgba(0,0,0,0.65)" : "#2c2622", cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    >{isSubRow ? `└ ${item.displayLabel}` : item.displayLabel}</div>
                  );
                })}
              </div>
            </div>
          </>
        );
      })()}

      {/* 二级（子）分类右键菜单：移至上级分类 */}
      {subCtxMenu && (() => {
        const sub = subCtxMenu.sub;
        const subItems: { label: string; onClick: () => void; danger?: boolean }[] = [
          { label: "改名", onClick: () => renameSubCat(sub) },
          { label: "升级为一级分类", onClick: () => promoteSubCat(sub) },
          { label: "移动到其他一级分类", onClick: () => setSubMoveMenu({ x: subCtxMenu.x, y: subCtxMenu.y, sub }) },
          { label: "清空该分类音效", onClick: () => clearSubCat(sub) },
          { label: "复制分类名称", onClick: () => { navigator.clipboard.writeText(sub).catch(() => {}); } },
          { label: "删除分类", onClick: () => deleteSubCat(sub), danger: true },
        ];
        return (
          <>
            <div onClick={() => setSubCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setSubCtxMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 1199 }} />
            <div
              style={{
                position: "fixed",
                top: Math.min(subCtxMenu.y, window.innerHeight - 220),
                left: Math.min(subCtxMenu.x, window.innerWidth - 210),
                zIndex: 1200, borderRadius: 10, padding: 6, minWidth: 184,
                background: "#fff",
                color: "#333",
                border: "1px solid rgba(60,50,45,0.14)",
                boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
              }}
            >
              <div style={{ padding: "4px 10px 6px", fontSize: 11, color: "rgba(0,0,0,0.45)", borderBottom: "1px solid rgba(60,50,45,0.12)", marginBottom: 4 }}>
                子分类「{sub}」
              </div>
              {subItems.map((it, i) => (
                <div
                  key={i}
                  onClick={() => { it.onClick(); setSubCtxMenu(null); }}
                  style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: it.danger ? "#c0392b" : "#333", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = it.danger ? "rgba(192,57,43,0.12)" : "rgba(230,182,110,0.18)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >{i + 1}. {it.label}</div>
              ))}
            </div>
          </>
        );
      })()}

      {/* 子分类移动到其他一级分类 */}
      {subMoveMenu && (() => {
        const sub = subMoveMenu.sub;
        const targets = (activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats)
          .filter(c => c !== selCat && !(VIRTUAL_SOUND_CATS as readonly string[]).includes(c));
        return (
          <>
            <div onClick={() => setSubMoveMenu(null)} onContextMenu={e => { e.preventDefault(); setSubMoveMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 1199 }} />
            <div
              style={{
                position: "fixed",
                top: Math.min(subMoveMenu.y, window.innerHeight - 160),
                left: Math.min(subMoveMenu.x, window.innerWidth - 210),
                zIndex: 1200, borderRadius: 10, padding: 6, minWidth: 184,
                background: "#fff", color: "#333",
                border: "1px solid rgba(60,50,45,0.14)",
                boxShadow: "0 10px 30px rgba(120,110,120,0.22)",
                maxHeight: "60vh", overflowY: "auto",
              }}
            >
              <div style={{ padding: "4px 10px 6px", fontSize: 11, color: "rgba(0,0,0,0.45)", borderBottom: "1px solid rgba(60,50,45,0.12)", marginBottom: 4 }}>
                把「{sub}」移到哪个分类下
              </div>
              {targets.length === 0 ? (
                <div style={{ padding: "7px 12px", fontSize: 13, color: "rgba(0,0,0,0.4)" }}>无其他分类可选</div>
              ) : targets.map((t, i) => (
                <div
                  key={t}
                  onClick={() => { moveSubToParent(sub, t); setSubMoveMenu(null); }}
                  style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "#333", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(230,182,110,0.18)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >{i + 1}. {t}</div>
              ))}
            </div>
          </>
        );
      })()}

      {/* 调整分类顺序 modal */}
      {reorderCats && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
          onClick={() => setReorderCats(null)}>
          <div className="glass-strong" style={{ borderRadius: 14, padding: 20, width: 340, maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 10 }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "var(--gold)", fontSize: 16, fontWeight: "bold" }}>调整分类顺序</div>
            <div className="scroll-area" style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
              {reorderCats.map((c, i) => (
                <div key={c} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, background: "rgba(60,50,45,0.05)" }}>
                  <span style={{ flex: 1, color: "#2c2622", fontSize: 14 }}>{c}</span>
                  <button className="btn" disabled={i === 0} style={{ padding: "2px 8px", opacity: i === 0 ? 0.3 : 1 }}
                    onClick={() => setReorderCats(arr => { if (!arr) return arr; const n = [...arr]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>▲</button>
                  <button className="btn" disabled={i === reorderCats.length - 1} style={{ padding: "2px 8px", opacity: i === reorderCats.length - 1 ? 0.3 : 1 }}
                    onClick={() => setReorderCats(arr => { if (!arr) return arr; const n = [...arr]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })}>▼</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setReorderCats(null)}>取消</button>
              <button className="btn gold-btn" onClick={() => { applyCatOrder(reorderCats); setReorderCats(null); }}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 分类快捷键捕获 overlay */}
      {catKeyCapture && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
          onClick={() => setCatKeyCapture(null)}
          tabIndex={-1}
          ref={el => { el?.focus(); }}
          onKeyDown={e => {
            e.preventDefault();
            if (e.key === "Escape") { setCatKeyCapture(null); return; }
            const k = e.key === " " ? " " : e.key.length === 1 ? e.key.toLowerCase() : "";
            if (!k) return;
            assignCatShortcut(catKeyCapture.pool, catKeyCapture.cat, k);
            setCatKeyCapture(null);
          }}>
          <div className="modal-light" style={{ borderRadius: 14, padding: "28px 32px", textAlign: "center" }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "var(--gold)", fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>按下要绑定的按键</div>
            <div style={{ color: "rgba(0,0,0,0.6)", fontSize: 13 }}>分类「{catKeyCapture.cat}」· 按下后随机播放该分类音效（Esc 取消）</div>
          </div>
        </div>
      )}

      {/* 模拟键盘弹窗（全屏遮罩 · 大号） */}
      {showSimKb && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(60,50,45,0.55)", backdropFilter: "blur(12px)", padding: 20 }}
          onClick={() => { setShowSimKb(false); setKbdAssignKey(null); }}>
          <div className="glass-strong" style={{ borderRadius: 20, padding: "20px 22px 26px", maxWidth: "99vw", maxHeight: "94vh", display: "flex", flexDirection: "column", gap: 10, overflow: "hidden" }} onClick={e => e.stopPropagation()}>
            {/* 标题栏 */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ color: "var(--gold)", fontSize: 18, fontWeight: "bold", whiteSpace: "nowrap" }}>🎹 模拟键盘</div>
              {kbdAssignKey ? (
                <div style={{ flex: 1, textAlign: "center", color: "rgba(50,42,36,0.90)", fontSize: 13, background: "rgba(230,182,110,0.14)", borderRadius: 8, padding: "5px 12px", border: "1px solid rgba(230,182,110,0.45)" }}>
                  正在为 <b style={{ color: "var(--gold)", fontFamily: "monospace" }}>{directShortcutLabel(kbdAssignKey)}</b> 键选音效 ·{" "}
                  <span style={{ cursor: "pointer", textDecoration: "underline", color: "rgba(60,50,40,0.70)" }} onClick={() => setKbdAssignKey(null)}>取消</span>
                </div>
              ) : (
                <div style={{ flex: 1, textAlign: "center", color: "rgba(50,42,36,0.62)", fontSize: 13 }}>
                  金色键已绑音效（点击播放）· 右键修改 · 空白键点击开始绑定 · Esc 关闭
                </div>
              )}
              <button className="btn" onClick={() => { setShowSimKb(false); setKbdAssignKey(null); }} style={{ padding: "4px 12px", fontSize: 16, flexShrink: 0 }}>×</button>
            </div>
            {/* 键盘体 */}
            <div ref={simKbWrapRef} style={{ width: "min(96vw, 1600px)", overflow: "auto", display: "flex", justifyContent: "center", height: simKb.h || undefined }}>
              <div ref={simKbInnerRef} style={{ transform: `scale(${simKb.scale})`, transformOrigin: "top center", width: "max-content" }}>
                {/* 键盘底座：深色边框模拟键盘机身 */}
                <div style={{
                  background: "linear-gradient(170deg, #f0ebe2 0%, #e8e1d6 100%)",
                  border: "2px solid rgba(140,120,95,0.40)",
                  borderBottom: "4px solid rgba(110,90,65,0.35)",
                  borderRadius: 14,
                  padding: "16px 14px 20px",
                  boxShadow: "0 6px 28px rgba(80,60,40,0.22), inset 0 1px 0 rgba(255,255,255,0.75)",
                }}>
                  {KB_LAYOUT.map((section, si) =>
                    section.rows.map((row, ri) => {
                      const isFnRow = si === 0;
                      const rowGap = isFnRow ? 8 : 5;
                      return (
                        <div key={`${si}-${ri}`} className="kb-row" style={{ display: "flex", gap: 5, marginBottom: rowGap, justifyContent: "flex-start" }}>
                          {row.map((k, ki) => {
                            if (k === "") return <div key={ki} style={{ width: 14 }} />;
                            if (isSpacer(k)) return <div key={ki} style={{ width: keyWidth(k) }} />;
                            const kl = keyboardTokenToShortcut(k);
                            const mapped = kl ? keyMap[kl] || null : null;
                            const mappedSound = mapped ? sounds.find(s => s.id === mapped) : undefined;
                            const isPlaying = mapped ? playing.has(mapped) : false;
                            const isAssignTarget = kbdAssignKey !== null && kbdAssignKey === kl;
                            const isBindable = kl !== null;
                            const keyCls = `snd-key${mapped ? " mapped" : ""}${isAssignTarget ? " assign" : ""}${isPlaying ? " playing" : ""}`;
                            // 固定键高：普通键 42px（宽高约 1:1），F 行 32px
                            const keyH = isFnRow ? 32 : 42;
                            const keyLabel = k === "Space" ? "" : k;
                            const labelSize = k.length > 6 ? 8 : k.length > 3 ? 9 : isFnRow ? 10 : 12;
                            return (
                              <div
                                key={ki}
                                className={keyCls}
                                title={
                                  mappedSound
                                    ? `▶ ${mappedSound.name} · ${k.toUpperCase()} · 右键修改`
                                    : isBindable
                                      ? `点击绑定 ${k.toUpperCase()} 键`
                                      : k.toUpperCase()
                                }
                                onClick={() => {
                                  if (mapped) { tryTrigger(mapped, true, "kbd"); return; }
                                  if (isBindable) captureKey(k);
                                }}
                                onContextMenu={mapped ? (e) => {
                                  e.preventDefault();
                                  setKeyCtxMenu({ x: e.clientX, y: e.clientY, soundId: mapped });
                                } : undefined}
                                style={{
                                  position: "relative",
                                  width: keyWidth(k),
                                  height: keyH,
                                  fontSize: labelSize,
                                  cursor: (mapped || isBindable) ? "pointer" : "default",
                                  flexDirection: "column",
                                  justifyContent: mappedSound ? "flex-start" : "center",
                                  alignItems: "center",
                                  padding: mappedSound ? "4px 2px 2px" : "0 2px",
                                  opacity: (!mapped && !isBindable) ? 0.65 : 1,
                                  ...(mappedSound?.color ? {
                                    background: `linear-gradient(155deg, ${hexToRgba(mappedSound.color, 0.96)} 0%, ${hexToRgba(mappedSound.color, 0.72)} 55%, ${hexToRgba(mappedSound.color, 0.88)} 100%)`,
                                    borderColor: hexToRgba(mappedSound.color, 1),
                                    boxShadow: `inset 0 1px 0 rgba(255,255,255,.7), 0 2px 5px ${hexToRgba(mappedSound.color, 0.35)}`,
                                  } : {}),
                                }}
                              >
                                <span style={{ lineHeight: 1.2, position: "relative", zIndex: 1 }}>{keyLabel}</span>
                                {/* 绑定音效名：绝对定位在键底部，不撑高键位 */}
                                {mappedSound && (
                                  <div style={{
                                    position: "absolute", bottom: 2, left: 2, right: 2,
                                    fontSize: 8, textAlign: "center",
                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                    lineHeight: "11px", fontWeight: "normal",
                                    color: isPlaying ? "#9A671C" : "rgba(80,55,25,0.90)",
                                    pointerEvents: "none",
                                  }}>{mappedSound.name}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Batch color picker popover */}
      {batchColorOpen && (() => {
        const presets = ["#E6B66E", "#ff8fa0", "#7ec4f5", "#9bd989", "#e0a060", "#b794f6", "#ff6b6b", "#4ecdc4", "#ffd93d", "#6c5ce7"];
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
            onClick={() => setBatchColorOpen(false)}>
            <div className="glass-strong" style={{ borderRadius: 14, padding: 22, width: 340 }} onClick={e => e.stopPropagation()}>
              <div style={{ color: "var(--gold)", fontSize: 15, fontWeight: "bold", marginBottom: 4 }}>批量设置卡片颜色</div>
              <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 12, marginBottom: 14 }}>已选 {selectedSoundIds.size} 个音效</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 14 }}>
                {presets.map(c => (
                  <button key={c}
                    onClick={() => { batchUpdateSelected({ color: c }); setBatchColorOpen(false); }}
                    style={{
                      height: 36, borderRadius: 6, border: "1px solid rgba(60,50,45,0.18)",
                      background: c, cursor: "pointer",
                    }}
                    title={c}
                  />
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 13, color: "rgba(60,50,40,0.75)" }}>自定义</span>
                <input type="color" defaultValue="#E6B66E" onChange={e => batchUpdateSelected({ color: e.target.value })} style={{ width: 50, height: 32, border: "none", background: "none", cursor: "pointer" }} />
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => { batchUpdateSelected({ color: undefined }); setBatchColorOpen(false); }}>清除</button>
                <button className="btn gold-btn" onClick={() => setBatchColorOpen(false)}>完成</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Color picker popover */}
      {colorPickerFor && (() => {
        const s = sounds.find(x => x.id === colorPickerFor);
        if (!s) return null;
        const presets = ["#E6B66E", "#ff8fa0", "#7ec4f5", "#9bd989", "#e0a060", "#b794f6", "#ff6b6b", "#4ecdc4", "#ffd93d", "#6c5ce7"];
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
            onClick={() => setColorPickerFor(null)}>
            <div className="glass-strong" style={{ borderRadius: 14, padding: 22, width: 340 }} onClick={e => e.stopPropagation()}>
              <div style={{ color: "var(--gold)", fontSize: 15, fontWeight: "bold", marginBottom: 4 }}>设置按钮颜色</div>
              <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 12, marginBottom: 14 }}>{s.name}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 14 }}>
                {presets.map(c => (
                  <button key={c}
                    onClick={() => { updateSound(s.id, { color: c }); setColorPickerFor(null); }}
                    style={{
                      height: 36, borderRadius: 6, border: s.color === c ? "2px solid var(--gold)" : "1px solid rgba(60,50,45,0.18)",
                      background: c, cursor: "pointer",
                    }}
                    title={c}
                  />
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 13, color: "rgba(60,50,40,0.75)" }}>自定义</span>
                <input type="color" value={s.color || "#E6B66E"} onChange={e => updateSound(s.id, { color: e.target.value })} style={{ width: 50, height: 32, border: "none", background: "none", cursor: "pointer" }} />
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => { updateSound(s.id, { color: undefined }); setColorPickerFor(null); }}>清除</button>
                <button className="btn gold-btn" onClick={() => setColorPickerFor(null)}>完成</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* MIDI 时间码设置弹窗 */}
      {showMidi && (
        <MidiSettingsModal
          sounds={sounds}
          onTrigger={(id) => {
            const s = sounds.find(x => x.id === id);
            if (s) tryTrigger(s.id, hostLoop);
          }}
          onClose={() => setShowMidi(false)}
        />
      )}

      {/* Clip modal — waveform trim editor */}
      {clipFor && (() => {
        const s = sounds.find(x => x.id === clipFor);
        if (!s) return null;
        return (
          <SoundTrimModal
            sound={s}
            onSave={(start, end, fadeIn, fadeOut) => updateSound(s.id, { clipStart: start, clipEnd: end, fadeIn, fadeOut })}
            onClear={() => updateSound(s.id, { clipStart: undefined, clipEnd: undefined, fadeIn: undefined, fadeOut: undefined })}
            onClose={() => setClipFor(null)}
          />
        );
      })()}

      {/* Edit Modal */}
      {editing && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
          onClick={() => { setEditId(null); setShortcutCapture(false); setGlobalShortcutCapture(false); setPendingShortcut(null); setPendingConflictName(null); setPendingSystemKeyName(null); setPendingGlobalShortcut(null); setPendingGsConflictName(null); setGsConflictMsg(null); }}>
          <div className="modal-light" style={{ borderRadius: 16, padding: 20, width: 280 }} onClick={e => e.stopPropagation()}>
            <div style={{ color: "var(--gold)", fontSize: 16, fontWeight: "bold", marginBottom: 4 }}>编辑音效</div>
            <div style={{ color: "rgba(0,0,0,0.4)", fontSize: 12, marginBottom: 16 }}>修改即时生效</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ color: "rgba(0,0,0,0.55)", fontSize: 13, marginBottom: 5 }}>名称</div>
                <input className="inp" value={editing.name} onChange={e => updateSound(editing.id, { name: e.target.value })} />
              </div>
              <div>
                <div style={{ color: "rgba(0,0,0,0.55)", fontSize: 13, marginBottom: 5 }}>音频文件</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    ref={editFileInputRef}
                    type="file"
                    accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.weba,.webm,.wma,.aiff,.aif,.amr,.mp4"
                    style={{ display: "none" }}
                    onChange={async e => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (editing) requestRebind(editing.id, file);
                    }}
                  />
                  {(() => {
                    const isMissing = missingIds.has(editing.id);
                    const isBound = !isMissing && (!!editing.hasAudio || !!editing.url);
                    const label = isMissing ? "重新选择音频文件" : isBound ? "替换音频文件" : "选择音频文件";
                    const status = isMissing ? "⚠ 音频丢失，未绑定" : isBound ? "已绑定" : "未绑定";
                    const alert = isMissing || !isBound;
                    return (
                      <>
                        <button
                          className="btn"
                          style={isMissing ? { borderColor: "rgba(192,57,43,0.6)", color: "#c0392b" } : undefined}
                          onClick={() => editFileInputRef.current?.click()}
                        >
                          {label}
                        </button>
                        <span style={{ color: alert ? (isMissing ? "#c0392b" : "#E6B66E") : "rgba(0,0,0,0.45)", fontSize: 12 }}>
                          {status}
                        </span>
                      </>
                    );
                  })()}
                </div>
              </div>
              <div>
                <div style={{ color: "rgba(0,0,0,0.55)", fontSize: 13, marginBottom: 5 }}>快捷键</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    className="btn"
                    style={{
                      minWidth: 80,
                      fontFamily: "sans-serif",
                      letterSpacing: "0.05em",
                      borderColor: shortcutCapture
                        ? "var(--gold)"
                        : pendingConflictName
                          ? "rgba(192,57,43,0.6)"
                          : pendingShortcut && !pendingSystemKeyName
                            ? "rgba(40,160,80,0.6)"
                            : undefined,
                      color: shortcutCapture
                        ? "var(--gold)"
                        : pendingConflictName
                          ? "#c0392b"
                          : pendingShortcut && !pendingSystemKeyName
                            ? "#209850"
                            : undefined,
                    }}
                    onClick={() => {
                      setPendingShortcut(null); setPendingConflictName(null); setPendingFunctionConflictId(null); setPendingSystemKeyName(null);
                      setShortcutCapture(v => !v);
                    }}
                  >
                    {shortcutCapture
                      ? "请按下任意键…"
                      : pendingShortcut
                        ? directShortcutLabel(pendingShortcut)
                        : editing.shortcut
                          ? directShortcutLabel(editing.shortcut)
                          : "未绑定"}
                  </button>
                  {editing.shortcut && !shortcutCapture && !pendingShortcut && (
                    <button className="btn" onClick={() => updateSound(editing.id, { shortcut: undefined })}>清除</button>
                  )}
                  {/* 实时冲突/可用状态 */}
                  {!shortcutCapture && pendingShortcut && (
                    pendingConflictName ? (
                      <>
                        <span style={{ color: "#c0392b", fontSize: 12, fontWeight: "bold" }}>
                          ✗ 已被【{pendingConflictName}】占用
                        </span>
                        <div style={{ display: "flex", gap: 6, width: "100%", marginTop: 2 }}>
                          <button className="btn" style={{ fontSize: 12 }}
                            onClick={() => { setPendingShortcut(null); setPendingConflictName(null); setPendingSystemKeyName(null); setShortcutCapture(true); }}>
                            重新选择
                          </button>
                          <button className="btn" style={{ color: "var(--gold)", borderColor: "rgba(230,182,110,0.55)", fontSize: 12 }}
                            onClick={() => {
                              if (pendingFunctionConflictId) setFuncShortcuts(prev => removeFunctionShortcut(prev, pendingFunctionConflictId));
                              setSounds(prev => prev.map(s => s.id === editing.id ? { ...s, shortcut: pendingShortcut } : s.shortcut === pendingShortcut ? { ...s, shortcut: undefined } : s));
                              setPendingShortcut(null); setPendingConflictName(null); setPendingFunctionConflictId(null); setPendingSystemKeyName(null);
                            }}>
                            替换原绑定
                          </button>
                        </div>
                      </>
                    ) : pendingSystemKeyName ? (
                      <>
                        <span style={{ color: "#d07030", fontSize: 12 }}>⚠ {pendingSystemKeyName} 是系统控制键</span>
                        <div style={{ display: "flex", gap: 6, width: "100%", marginTop: 2 }}>
                          <button className="btn" style={{ fontSize: 12 }}
                            onClick={() => { setPendingShortcut(null); setPendingConflictName(null); setPendingSystemKeyName(null); setShortcutCapture(true); }}>
                            重新选择
                          </button>
                          <button className="btn" style={{ color: "var(--gold)", borderColor: "rgba(230,182,110,0.55)", fontSize: 12 }}
                            onClick={() => {
                              updateSound(editing.id, { shortcut: pendingShortcut });
                              setPendingShortcut(null); setPendingConflictName(null); setPendingSystemKeyName(null);
                            }}>
                            仍要绑定
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span style={{ color: "#209850", fontSize: 12, fontWeight: "bold" }}>✓ 快捷键可用</span>
                        <button className="btn" style={{ color: "var(--gold)", borderColor: "rgba(230,182,110,0.55)", fontSize: 12 }}
                          onClick={() => {
                            updateSound(editing.id, { shortcut: pendingShortcut });
                            setPendingShortcut(null); setPendingConflictName(null); setPendingSystemKeyName(null);
                          }}>
                          确认绑定
                        </button>
                      </>
                    )
                  )}
                  {!pendingShortcut && (
                    <span style={{ color: "rgba(0,0,0,0.4)", fontSize: 12 }}>
                      {shortcutCapture ? "Esc 取消 · Bksp 清除" : "点击后按键 — 实时检测冲突"}
                    </span>
                  )}
                </div>
              </div>
              {/* 全局快捷键（F1-F12 / Ctrl+N / Alt+N） */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                  <span style={{ color: "rgba(0,0,0,0.55)", fontSize: 13 }}>全局快捷键</span>
                  <span style={{ fontSize: 11, color: "rgba(0,0,0,0.32)", background: "rgba(230,182,110,0.12)", border: "1px solid rgba(230,182,110,0.28)", borderRadius: 4, padding: "1px 5px" }}>
                    推荐 F1–F12 / Ctrl+N / Alt+N
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    className="btn"
                    style={{
                      minWidth: 90,
                      fontFamily: "monospace",
                      letterSpacing: "0.05em",
                      borderColor: globalShortcutCapture
                        ? "rgba(109,175,196,0.80)"
                        : pendingGsConflictName
                          ? "rgba(192,57,43,0.6)"
                          : pendingGlobalShortcut
                            ? "rgba(40,160,80,0.6)"
                            : editing.globalShortcut ? "rgba(230,182,110,0.60)" : undefined,
                      color: globalShortcutCapture
                        ? "rgba(109,175,196,0.95)"
                        : pendingGsConflictName
                          ? "#c0392b"
                          : pendingGlobalShortcut
                            ? "#209850"
                            : editing.globalShortcut ? "var(--gold)" : undefined,
                    }}
                    onClick={() => {
                      setPendingGlobalShortcut(null); setPendingGsConflictName(null); setGsConflictMsg(null);
                      setGlobalShortcutCapture(v => !v);
                    }}
                  >
                    {globalShortcutCapture
                      ? "按下快捷键…"
                      : pendingGlobalShortcut
                        ? pendingGlobalShortcut
                        : editing.globalShortcut ?? "未绑定"}
                  </button>
                  {editing.globalShortcut && !globalShortcutCapture && !pendingGlobalShortcut && (
                    <button className="btn" onClick={() => { updateSound(editing.id, { globalShortcut: undefined }); setGsConflictMsg(null); }}>清除</button>
                  )}
                  {/* 实时冲突/可用状态 */}
                  {!globalShortcutCapture && pendingGlobalShortcut && (
                    pendingGsConflictName ? (
                      <>
                        <span style={{ color: "#c0392b", fontSize: 12, fontWeight: "bold" }}>
                          ✗ 已被【{pendingGsConflictName}】占用
                        </span>
                        <div style={{ display: "flex", gap: 6, width: "100%", marginTop: 2 }}>
                          <button className="btn" style={{ fontSize: 12 }}
                            onClick={() => { setPendingGlobalShortcut(null); setPendingGsConflictName(null); setGlobalShortcutCapture(true); }}>
                            重新选择
                          </button>
                          <button className="btn" style={{ color: "var(--gold)", borderColor: "rgba(230,182,110,0.55)", fontSize: 12 }}
                            onClick={() => {
                              updateSound(editing.id, { globalShortcut: pendingGlobalShortcut });
                              setPendingGlobalShortcut(null); setPendingGsConflictName(null);
                            }}>
                            替换原绑定
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span style={{ color: "#209850", fontSize: 12, fontWeight: "bold" }}>✓ 快捷键可用</span>
                        <button className="btn" style={{ color: "var(--gold)", borderColor: "rgba(230,182,110,0.55)", fontSize: 12 }}
                          onClick={() => {
                            updateSound(editing.id, { globalShortcut: pendingGlobalShortcut });
                            setPendingGlobalShortcut(null); setPendingGsConflictName(null);
                          }}>
                          确认绑定
                        </button>
                      </>
                    )
                  )}
                  {!pendingGlobalShortcut && (
                    <span style={{ color: gsConflictMsg ? "#c0392b" : "rgba(0,0,0,0.38)", fontSize: 12, maxWidth: 220 }}>
                      {globalShortcutCapture
                        ? "Esc 取消 · Bksp 清除"
                        : gsConflictMsg
                          ? gsConflictMsg
                          : "点击后按键 — 实时检测冲突"}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 22, justifyContent: "space-between" }}>
              <button className="btn" style={{ color: "#c0392b" }} onClick={() => {
                if (!confirm(`删除音效「${editing.name}」？`)) return;
                deleteSoundWithUndo(editing.id);
                setEditId(null);
              }}>删除</button>
              <button className="btn gold-btn" onClick={() => { setEditId(null); setShortcutCapture(false); setGlobalShortcutCapture(false); setGsConflictMsg(null); setPendingShortcut(null); setPendingConflictName(null); setPendingSystemKeyName(null); setPendingGlobalShortcut(null); setPendingGsConflictName(null); }}>完成</button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Modal — 带分类选择器 */}
      {showUpload && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
          onClick={() => { setShowUpload(false); setUploadFile(null); setUploadFiles([]); setUploadPickQuery(""); setUploadPickCat(null); setUploadPickSub(null); }}>
          <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 460, maxHeight: "88vh", display: "flex", flexDirection: "column", gap: 0 }} onClick={e => e.stopPropagation()}>
            {/* 文件选择 */}
            <div style={{ marginBottom: 12 }}>
              <input
                type="file"
                multiple
                accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.weba,.webm,.wma,.aiff,.aif,.amr,.mp4"
                style={{ display: "none" }}
                id="sa-upload-file-input"
                onChange={e => {
                  const files = e.target.files ? Array.from(e.target.files) : [];
                  setUploadFiles(files);
                  setUploadFile(files[0] ?? null);
                }}
              />
              <label
                htmlFor="sa-upload-file-input"
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={e => {
                  e.preventDefault(); e.stopPropagation();
                  const files = Array.from(e.dataTransfer.files).filter(f => /\.(mp3|wav|m4a|ogg|flac|aac|opus|webm|wma|aiff|amr)$/i.test(f.name) || f.type.startsWith("audio/"));
                  if (files.length > 0) { setUploadFiles(files); setUploadFile(files[0]); }
                }}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  gap: 6, padding: "22px 16px", borderRadius: 12, cursor: "pointer",
                  border: "2px dashed rgba(230,182,110,0.45)", background: "rgba(230,182,110,0.05)",
                  transition: "border-color 0.15s, background 0.15s", userSelect: "none",
                }}
              >
                <span style={{ fontSize: 36 }}>📁</span>
                <span style={{ fontWeight: "bold", color: "var(--gold)", fontSize: 16 }}>上传音效</span>
                <span style={{ fontSize: 12, color: "rgba(50,42,36,0.50)", textAlign: "center" }}>点击选择音效文件，或拖拽文件到这里</span>
                <span style={{ fontSize: 11, color: "rgba(50,42,36,0.40)" }}>支持 mp3 / wav / m4a / ogg / flac</span>
              </label>
              {uploadFiles.length > 0 && (
                <div style={{ color: "rgba(50,42,36,0.7)", fontSize: 12, marginTop: 8, lineHeight: 1.5, textAlign: "center", padding: "6px 10px", background: "rgba(230,182,110,0.08)", borderRadius: 8, border: "1px solid rgba(230,182,110,0.25)" }}>
                  {uploadFiles.length === 1
                    ? `已选择：${uploadFiles[0].name}`
                    : `已选择 ${uploadFiles.length} 个音效文件`}
                </div>
              )}
            </div>

            {/* 我的音效：类型选择 */}
            {activeTab === "mine" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                <div style={{ color: "rgba(50,42,36,0.7)", fontSize: 12 }}>类型</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {([["short", "短音效（单次）"], ["bgm", "背景音乐（循环）"]] as const).map(([t, lab]) => (
                    <button
                      key={t}
                      className={`btn${(uploadForm.type ?? "short") === t ? " gold-btn" : ""}`}
                      style={{ flex: 1, padding: "8px 0", fontSize: 13 }}
                      onClick={() => setUploadForm(f => ({ ...f, type: t, loop: t === "bgm" }))}
                    >{lab}</button>
                  ))}
                </div>
              </div>
            )}

            {/* 保存位置 标题 */}
            <div style={{ color: "rgba(50,42,36,0.7)", fontSize: 12, fontWeight: "bold", marginBottom: 6 }}>保存位置</div>

            {/* 搜索框 */}
            <input
              type="text"
              placeholder="搜索分类名称"
              value={uploadPickQuery}
              onChange={e => setUploadPickQuery(e.target.value)}
              style={{ borderRadius: 8, border: "1px solid rgba(150,130,100,0.35)", background: "rgba(255,250,242,0.7)", padding: "7px 11px", fontSize: 13, marginBottom: 8, outline: "none", color: "rgba(50,42,36,0.9)", flexShrink: 0 }}
            />

            {/* 分类树 */}
            <div style={{ overflowY: "auto", maxHeight: 240, border: "1px solid rgba(150,130,100,0.2)", borderRadius: 10, padding: "4px", background: "rgba(255,250,242,0.4)", flexShrink: 0 }}>
              {/* 未分类（固定首位） */}
              {(!uploadPickQuery || "未分类".includes(uploadPickQuery)) && (
                <div
                  onClick={() => { setUploadPickCat(UNCAT); setUploadPickSub(null); }}
                  style={{
                    padding: "8px 12px", borderRadius: 7, cursor: "pointer", fontSize: 13, marginBottom: 1,
                    background: uploadPickCat === UNCAT ? "rgba(150,150,150,0.22)" : "transparent",
                    color: uploadPickCat === UNCAT ? "rgba(50,42,36,0.85)" : "rgba(50,42,36,0.52)",
                    fontWeight: uploadPickCat === UNCAT ? "bold" : "normal",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  <span>📂</span>
                  <span>未分类</span>
                  {uploadPickCat === UNCAT && <span style={{ marginLeft: "auto", color: "var(--gold)", fontSize: 14 }}>✓</span>}
                </div>
              )}
              {/* 当前池子的一级分类 + 二级分类 */}
              {(activeTab === "bg" ? bgCats : activeTab === "mine" ? curMineCats : mainCats)
                .filter(c => !(VIRTUAL_SOUND_CATS as readonly string[]).includes(c))
                .filter(c => {
                  if (!uploadPickQuery) return true;
                  if (c.includes(uploadPickQuery)) return true;
                  const allSubs = [...new Set([...tabSounds.filter(s => s.category === c && s.subCategory).map(s => s.subCategory!), ...(subCatReg[c] ?? [])])];
                  return allSubs.some(s => s.includes(uploadPickQuery));
                })
                .map(c => {
                  const rawSubs = [...new Set([...tabSounds.filter(s => s.category === c && s.subCategory).map(s => s.subCategory!), ...(subCatReg[c] ?? [])])];
                  const filtSubs = uploadPickQuery ? rawSubs.filter(s => s.includes(uploadPickQuery)) : rawSubs;
                  const isCatSel = uploadPickCat === c && uploadPickSub === null;
                  return (
                    <div key={c}>
                      <div
                        onClick={() => { setUploadPickCat(c); setUploadPickSub(null); }}
                        style={{
                          padding: "8px 12px", borderRadius: 7, cursor: "pointer", fontSize: 13, marginBottom: 1,
                          background: isCatSel ? "rgba(230,182,110,0.18)" : "transparent",
                          color: isCatSel ? "var(--gold)" : "rgba(50,42,36,0.82)",
                          fontWeight: isCatSel ? "bold" : "normal",
                          display: "flex", alignItems: "center", gap: 6,
                        }}
                      >
                        <span style={{ fontSize: 10, opacity: 0.45 }}>▸</span>
                        <span>{c}</span>
                        {isCatSel && <span style={{ marginLeft: "auto", color: "var(--gold)", fontSize: 14 }}>✓</span>}
                      </div>
                      {filtSubs.map(sub => {
                        const isSubSel = uploadPickCat === c && uploadPickSub === sub;
                        return (
                          <div
                            key={sub}
                            onClick={() => { setUploadPickCat(c); setUploadPickSub(sub); }}
                            style={{
                              padding: "7px 12px 7px 28px", borderRadius: 7, cursor: "pointer", fontSize: 12, marginBottom: 1,
                              background: isSubSel ? "rgba(230,182,110,0.15)" : "transparent",
                              color: isSubSel ? "var(--gold)" : "rgba(50,42,36,0.62)",
                              fontWeight: isSubSel ? "bold" : "normal",
                              display: "flex", alignItems: "center", gap: 6,
                            }}
                          >
                            <span style={{ fontSize: 10, opacity: 0.4 }}>└</span>
                            <span>{sub}</span>
                            {isSubSel && <span style={{ marginLeft: "auto", color: "var(--gold)", fontSize: 14 }}>✓</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
            </div>

            {/* 路径提示 */}
            <div style={{ marginTop: 8, fontSize: 12, color: "rgba(50,42,36,0.55)", minHeight: 18 }}>
              {uploadPickCat === null
                ? "保存到：未分类（默认）"
                : uploadPickCat === UNCAT
                ? "保存到：未分类"
                : uploadPickSub
                ? `保存到：${uploadPickCat} / ${uploadPickSub}`
                : `保存到：${uploadPickCat}`}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => { setShowUpload(false); setUploadFile(null); setUploadFiles([]); setUploadPickQuery(""); setUploadPickCat(null); setUploadPickSub(null); }}>取消</button>
              <button className="btn gold-btn" onClick={async () => {
                if (uploadFiles.length === 0) { alert("请选择音频文件"); return; }
                const isMine = activeTab === "mine";
                const type: SoundItem["type"] = isMine
                  ? (uploadForm.type === "bgm" ? "bgm" : "short")
                  : (activeTab === "bg" ? "bgm" : "short");
                const loop = type === "bgm";
                const category = uploadPickCat ?? UNCAT;
                const subCategory = (uploadPickCat !== null && uploadPickCat !== UNCAT && uploadPickSub) ? uploadPickSub : "";
                const newItems: SoundItem[] = [];
                for (const file of uploadFiles) {
                  const newId = uid();
                  try { await putAudioBlob(newId, file, undefined, file.name); }
                  catch (e) { alert("保存音频失败：" + (e instanceof Error ? e.message : String(e))); return; }
                  newItems.push({
                    id: newId,
                    name: file.name.replace(/\.[^.]+$/, "") || "未命名",
                    type,
                    category,
                    subCategory: subCategory || undefined,
                    volume: 80,
                    loop,
                    hasAudio: true,
                    ...(isMine ? { mine: true } : {}),
                  });
                }
                setSounds(prev => [...prev, ...newItems]);
                if (subCategory && category !== UNCAT) {
                  setSubCatReg(prev => { const ex = prev[category] ?? []; if (ex.includes(subCategory)) return prev; return { ...prev, [category]: [...ex, subCategory] }; });
                }
                const pathLabel = category === UNCAT ? "未分类" : (subCategory ? `${category} / ${subCategory}` : category);
                setMoveCatToast({ text: `已成功上传 ${newItems.length} 个音效到【${pathLabel}】`, key: Date.now() });
                // 跳转到刚上传的分类
                setSelCat(category);
                if (subCategory) setSelSub(subCategory); else setSelSub(ALL_SUB);
                setShowUpload(false);
                setUploadForm({ volume: 80, loop: false, type: "short", category: "短音效", subCategory: "" });
                setUploadFile(null);
                setUploadFiles([]);
                setUploadPickQuery("");
                setUploadPickCat(null);
                setUploadPickSub(null);
              }}>确认上传</button>
            </div>
          </div>
        </div>
      )}

      {/* 功能控制条（移至底部） */}
      {/* Top controls bar */}
      {!isMobile && (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "rgba(60,50,40,0.75)", fontSize: 13 }}>总音量</span>
          <input type="range" min={0} max={100} value={masterVol} onChange={e => setMasterVol(+e.target.value)} style={{ width: 100 }} />
          <span style={{ color: "rgba(50,42,36,0.85)", fontSize: 13, width: 32 }}>{masterVol}%</span>
          <button
            className="btn"
            title="选择整个音效文件夹，自动识别一级/二级分类（第一层=一级分类，第二层=二级分类，音频文件=音效）"
            style={{ padding: "4px 10px", fontSize: 12, color: "var(--gold)", borderColor: "rgba(230,182,110,0.55)" }}
            onClick={() => batchFolderRef.current?.click()}
          >📁 选择音效文件夹</button>
          {memberStatus?.isAdmin && (
            <button className="btn gold-btn" onClick={() => setShowSyncModal(true)} title="将本地音效同步到云端" style={{ padding: "4px 10px", fontSize: 12 }}>☁️ 一键同步</button>
          )}
          {/* ── 开启键盘快捷键 / 开启循环播放 ──────────────────────────── */}
          <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", userSelect:"none", fontSize:13 }}>
            <input
              type="checkbox"
              style={{ accentColor:"var(--gold)", width:14, height:14 }}
              checked={appSettings.shortcutsEnabled}
              onChange={e => setSet("shortcutsEnabled", e.target.checked)}
            />
            <span style={{ color:"rgba(60,50,40,0.80)" }}>开启键盘快捷键</span>
          </label>
          <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", userSelect:"none", fontSize:13 }}>
            <input
              type="checkbox"
              style={{ accentColor:"var(--gold)", width:14, height:14 }}
              checked={hostLoop}
              onChange={e => setHostLoop(e.target.checked)}
            />
            <span style={{ color:"rgba(60,50,40,0.80)" }}>开启循环播放</span>
          </label>
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: 6, marginRight: "auto" }}
          title={sinkSupported
            ? "选择音频输出设备（耳机 / 扬声器 / 虚拟声卡 等）"
            : "当前浏览器不支持选择音频输出设备（仅 Chrome / Edge 等 Chromium 浏览器支持）"}
        >
          <span style={{ color: "rgba(60,50,40,0.75)", fontSize: 13 }}>🔊 输出</span>
          <select
            className="inp"
            disabled={!sinkSupported}
            style={{ maxWidth: 200, fontSize: 12, padding: "3px 6px", cursor: sinkSupported ? "pointer" : "not-allowed" }}
            value={audioSinkId}
            onFocus={() => void ensureDeviceLabels()}
            onMouseDown={() => void ensureDeviceLabels()}
            onChange={e => { void setAudioSinkId(e.target.value); }}
          >
            <option value="">默认设备</option>
            {audioOutputs.map(d => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `音频设备 ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => void refreshAudioOutputs()}
            title="刷新音频输出设备列表"
            style={{ padding: "2px 6px", fontSize: 11 }}
          >↻</button>
        </div>
        {(() => {
          const cur = visibleScopedTrack(playerScope, scopedTrackIds, playing, paused);
          const t = cur ? sounds.find(s => s.id === cur) : undefined;
          const active = !!t && !!cur;
          return (
            <NowPlayingBar
              inline
              track={active && t ? t : null}
              isPaused={!!cur && paused.has(cur)}
              getAudioElement={getAudioElement}
              onPauseResume={() => { if (cur) pauseResume(cur); }}
              onStop={() => { if (cur) stopSound(cur); }}
              onSeek={(sec) => { if (cur) seekSound(cur, sec); }}
              bgmMode={bgmMode}
              onBgmModeChange={setBgmMode}
              onPrev={bgmPrev}
              onNext={bgmNext}
            />
          );
        })()}
        {activeTab !== "main" && <button className="btn" onClick={stopAll}>停止全部</button>}
        {missingIds.size > 0 && (
          <button
            className="btn"
            onClick={() => setShowCleanupConfirm(true)}
            title="批量删除所有「音频丢失」的空壳条目"
            style={{ color: "#c0392b", borderColor: "rgba(255,90,90,0.45)" }}
          >
            清理失效音效（{missingIds.size}）
          </button>
        )}
        {missingIds.size > 0 && (
          <button
            className="btn"
            onClick={() => batchRebindFileRef.current?.click()}
            title="一次选中多个音频文件，按文件名自动重绑所有丢失的音效"
            style={{ color: "rgba(70,120,190,0.95)", borderColor: "rgba(70,120,190,0.5)" }}
          >
            批量重绑（{missingIds.size}）
          </button>
        )}
        <input
          ref={batchRebindFileRef}
          type="file"
          accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.weba,.webm,.wma,.aiff,.aif,.amr,.mp4"
          multiple
          style={{ display: "none" }}
          onChange={e => {
            const fl = e.target.files;
            if (fl && fl.length) openBatchRebind(fl);
            e.target.value = "";
          }}
        />
        <input
          ref={importFileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleImportFile(f);
            e.target.value = "";
          }}
        />
      </div>
      )}
      </div>
    </div>
    {/* 全局隐藏文件选择器（桌面+手机共用） */}
    <input
      ref={batchFolderRef}
      type="file"
      // @ts-expect-error non-standard directory picker attributes
      webkitdirectory="" directory="" mozdirectory=""
      multiple
      style={{ display: "none" }}
      onChange={e => { handleFolderPicked(e.target.files); e.target.value = ""; }}
    />
    <input
      ref={batchZipRef}
      type="file"
      accept=".zip,application/zip,application/x-zip-compressed"
      style={{ display: "none" }}
      onChange={e => { void handleZipPicked(e.target.files?.[0] ?? null); e.target.value = ""; }}
    />
    {showCloudPanel && <CloudSyncPanel onClose={() => setShowCloudPanel(false)} />}
    {showCloudManage && (
      <div
        style={{
          position: "fixed", inset: 0, zIndex: 9000,
          background: "rgba(0,0,0,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
        onClick={e => { if (e.target === e.currentTarget) setShowCloudManage(false); }}
      >
        <div style={{
          background: "var(--glass-bg, #fff)",
          borderRadius: 16,
          boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
          width: "min(720px, 96vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: 24,
          position: "relative",
        }}>
          <button
            onClick={() => setShowCloudManage(false)}
            style={{
              position: "absolute", top: 6, right: 8,
              background: "none", border: "none", cursor: "pointer",
              fontSize: 20, color: "rgba(60,50,40,0.5)", lineHeight: 1,
              padding: "10px 12px", minWidth: 44, minHeight: 44,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
            title="关闭"
          >✕</button>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: "var(--gold, #E6B66E)" }}>☁️ 云端管理</div>
          <CloudManageTab />
        </div>
      </div>
    )}

    {showSyncModal && (
      <SyncModal
        sounds={sounds}
        mainCats={mainCats}
        bgCats={bgCats}
        onClose={() => setShowSyncModal(false)}
      />
    )}

  </>);
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtClipShort(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

function fmtClipFull(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, "0")}`;
}

// Bottom now-playing bar: stylized music player with album art, progress bar, and icon controls.
function NowPlayingBar({ track, isPaused, getAudioElement, onPauseResume, onStop, onSeek, bgmMode, onBgmModeChange, onPrev, onNext, inline, mobile }: {
  track: SoundItem | null;
  isPaused: boolean;
  getAudioElement: (id: string) => HTMLAudioElement | undefined;
  onPauseResume: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  bgmMode: BgmMode;
  onBgmModeChange: (mode: BgmMode) => void;
  onPrev: () => void;
  onNext: () => void;
  inline?: boolean;
  mobile?: boolean;
}) {
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const trackId = track?.id;
  useEffect(() => {
    if (!trackId) { setPos(0); setDur(0); return; }
    const tick = () => {
      const a = getAudioElement(trackId);
      if (a) {
        setPos(a.currentTime || 0);
        setDur(isFinite(a.duration) ? a.duration : 0);
      }
    };
    tick();
    const t = window.setInterval(tick, 250);
    return () => window.clearInterval(t);
  }, [trackId, getAudioElement]);
  const idle = !track;
  const isBgm = !!track && (track.type === "bgm" || track.type === "pk");
  const pct = dur > 0 ? Math.min((pos / dur) * 100, 100) : 0;
  const containerStyle: React.CSSProperties = inline ? {
    display: "flex", alignItems: "center", gap: 10,
    width: mobile ? "100%" : "min(620px, 62vw)",
    background: "rgba(255,255,255,0.80)",
    backdropFilter: "blur(10px)",
    borderRadius: 14,
    border: "1px solid rgba(195,175,230,0.32)",
    boxShadow: "0 2px 14px rgba(150,120,200,0.13)",
    padding: "7px 10px",
    flexShrink: 0,
  } : {
    position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 80, zIndex: 1150,
    display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 14,
    width: "min(440px, 90vw)",
    background: "rgba(255,255,255,0.90)",
    backdropFilter: "blur(10px)",
    border: "1px solid rgba(195,175,230,0.32)",
    boxShadow: "0 8px 30px rgba(150,120,200,0.18)",
  };
  return (
    <div style={containerStyle}>
      {/* Album art */}
      <div style={{
        width: 38, height: 38, borderRadius: 9, flexShrink: 0,
        background: idle
          ? "rgba(200,180,230,0.25)"
          : "linear-gradient(135deg,#b39ddb 0%,#d08fe8 45%,#f4a0c0 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: idle ? "none" : "0 2px 10px rgba(160,120,220,0.28)",
        transition: "background 0.3s",
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill={idle ? "rgba(160,140,190,0.45)" : "rgba(255,255,255,0.9)"}>
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
        </svg>
      </div>
      {/* Track info + progress */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span style={{
            fontSize: 13, fontWeight: idle ? "normal" : "bold",
            color: idle ? "rgba(100,80,130,0.45)" : "#2c2234",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140,
          }}>{track ? track.name : "暂无播放"}</span>
          <span style={{ fontSize: 11, color: "rgba(120,100,155,0.65)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
            {fmtTime(pos)}&nbsp;/&nbsp;{fmtTime(dur)}
          </span>
        </div>
        {/* Progress track */}
        <div style={{ position: "relative", height: 4, borderRadius: 3, background: "rgba(190,170,220,0.22)" }}>
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 3,
            width: `${pct}%`,
            background: idle ? "rgba(190,170,220,0.22)" : "linear-gradient(90deg,#c084fc 0%,#f472b6 100%)",
            transition: "width 0.25s linear",
          }}/>
          <input
            type="range" min={0} max={dur || 0} step={0.1} value={Math.min(pos, dur || 0)}
            onChange={e => { const v = +e.target.value; setPos(v); onSeek(v); }}
            disabled={idle || !dur}
            style={{ position: "absolute", inset: "-6px 0", width: "100%", opacity: 0, cursor: !idle && dur ? "pointer" : "default", margin: 0, padding: 0 }}
          />
        </div>
        {isBgm && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            {([
              ["single", "单曲循环"],
              ["shuffle", "随机播放"],
              ["list", "列表循环"],
            ] as const).map(([mode, label]) => {
              const selected = bgmMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onBgmModeChange(mode)}
                  title={label}
                  aria-pressed={selected}
                  style={{
                    border: selected ? "1px solid rgba(192,132,252,0.72)" : "1px solid rgba(190,170,220,0.30)",
                    borderRadius: 999,
                    padding: "2px 7px",
                    fontSize: 10,
                    lineHeight: 1.4,
                    cursor: "pointer",
                    color: selected ? "#7040a0" : "rgba(100,80,130,0.66)",
                    background: selected ? "rgba(192,132,252,0.16)" : "rgba(255,255,255,0.55)",
                    fontWeight: selected ? 700 : 400,
                  }}
                >{label}</button>
              );
            })}
          </div>
        )}
      </div>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <button onClick={onPrev} title="上一曲" disabled={!isBgm} style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: isBgm ? "pointer" : "default", opacity: isBgm ? 0.68 : 0.28, padding: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#7c5fa8"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
        </button>
        {/* Play / Pause */}
        <button
          onClick={onPauseResume} disabled={idle}
          title={isPaused ? "继续" : "暂停"}
          style={{
            width: 36, height: 36, borderRadius: "50%", border: "none", padding: 0, flexShrink: 0,
            cursor: idle ? "default" : "pointer",
            background: idle ? "rgba(190,170,220,0.22)" : "linear-gradient(135deg,#c084fc 0%,#e879a0 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: idle ? "none" : "0 3px 12px rgba(192,132,252,0.42)",
            transition: "all 0.15s",
          }}
        >
          {isPaused || idle
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          }
        </button>
        <button onClick={onNext} title="下一曲" disabled={!isBgm} style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: isBgm ? "pointer" : "default", opacity: isBgm ? 0.68 : 0.28, padding: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#7c5fa8"><path d="M16 6h2v12h-2zM6 6v12l8.5-6z"/></svg>
        </button>
        {/* Stop */}
        <button
          onClick={onStop} disabled={idle}
          title="停止"
          style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: idle ? "default" : "pointer", opacity: idle ? 0.28 : 0.62, padding: 0, transition: "opacity 0.15s" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#7c5fa8"><path d="M6 6h12v12H6z"/></svg>
        </button>
      </div>
    </div>
  );
}

/** 与 GlobalSoundDrawer 共用的分类调色板（浅色主题适配版） */
const SA_CAT_PALETTE = [
  { bg: "rgba(55,200,175,0.14)",  border: "rgba(55,200,175,0.52)",  text: "#186858", playBg: "rgba(35,175,150,0.82)",  glow: "rgba(55,200,175,0.40)"  },
  { bg: "rgba(65,155,235,0.14)",  border: "rgba(65,155,235,0.52)",  text: "#1a5ea0", playBg: "rgba(50,140,220,0.82)",  glow: "rgba(65,155,235,0.40)"  },
  { bg: "rgba(245,170,65,0.14)",  border: "rgba(245,170,65,0.52)",  text: "#7a5010", playBg: "rgba(230,155,50,0.82)",  glow: "rgba(245,170,65,0.40)"  },
  { bg: "rgba(170,115,240,0.14)", border: "rgba(170,115,240,0.52)", text: "#6835b0", playBg: "rgba(155,100,230,0.82)", glow: "rgba(170,115,240,0.40)" },
  { bg: "rgba(245,105,145,0.14)", border: "rgba(245,105,145,0.52)", text: "#aa2555", playBg: "rgba(230,90,130,0.82)",  glow: "rgba(245,105,145,0.40)" },
  { bg: "rgba(100,210,115,0.14)", border: "rgba(100,210,115,0.52)", text: "#1e7830", playBg: "rgba(80,195,95,0.82)",   glow: "rgba(100,210,115,0.40)" },
  { bg: "rgba(250,130,75,0.14)",  border: "rgba(250,130,75,0.52)",  text: "#8a3810", playBg: "rgba(235,115,60,0.82)", glow: "rgba(250,130,75,0.40)"  },
  { bg: "rgba(55,210,235,0.14)",  border: "rgba(55,210,235,0.52)",  text: "#0f6f85", playBg: "rgba(40,195,220,0.82)", glow: "rgba(55,210,235,0.40)"  },
];
// 深色主题专用调色板：文字色升亮为鲜亮版本，背景加厚一点对比度
const SA_CAT_PALETTE_DARK = [
  { bg: "rgba(55,200,175,0.16)",  border: "rgba(55,200,175,0.44)",  text: "#62E8D5", playBg: "rgba(35,175,150,0.88)",  glow: "rgba(55,200,175,0.50)"  },
  { bg: "rgba(65,155,235,0.16)",  border: "rgba(65,155,235,0.44)",  text: "#7BBDF8", playBg: "rgba(50,140,220,0.88)",  glow: "rgba(65,155,235,0.50)"  },
  { bg: "rgba(245,170,65,0.16)",  border: "rgba(245,170,65,0.44)",  text: "#F1CD94", playBg: "rgba(230,155,50,0.88)",  glow: "rgba(245,170,65,0.50)"  },
  { bg: "rgba(170,115,240,0.16)", border: "rgba(170,115,240,0.44)", text: "#C8A8F8", playBg: "rgba(155,100,230,0.88)", glow: "rgba(170,115,240,0.50)" },
  { bg: "rgba(245,105,145,0.16)", border: "rgba(245,105,145,0.44)", text: "#F888B0", playBg: "rgba(230,90,130,0.88)",  glow: "rgba(245,105,145,0.50)" },
  { bg: "rgba(100,210,115,0.16)", border: "rgba(100,210,115,0.44)", text: "#72E88A", playBg: "rgba(80,195,95,0.88)",   glow: "rgba(100,210,115,0.50)" },
  { bg: "rgba(250,130,75,0.16)",  border: "rgba(250,130,75,0.44)",  text: "#F8A870", playBg: "rgba(235,115,60,0.88)", glow: "rgba(250,130,75,0.50)"  },
  { bg: "rgba(55,210,235,0.16)",  border: "rgba(55,210,235,0.44)",  text: "#60DCF5", playBg: "rgba(40,195,220,0.88)", glow: "rgba(55,210,235,0.50)"  },
];

function saCatColorIdx(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % SA_CAT_PALETTE.length;
}

function SoundCard({ s, playing, missing, compact, selected, onSelect, onTrigger, onDelete, onEdit, onRightClick, onToggleFavorite, favoriteRank, onMoveFavorite, onRebind, onClip }: { s: SoundItem; playing: boolean; missing?: boolean; compact?: boolean; selected?: boolean; onSelect?: (e: React.MouseEvent) => boolean; onTrigger: () => void; onDelete: () => void; onEdit: () => void; onRightClick?: (e: React.MouseEvent) => void; onToggleFavorite: () => void; favoriteRank?: { pos: number; total: number } | null; onMoveFavorite?: (dir: -1 | 1) => void; onRebind?: (file: File) => void; onClip?: () => void }) {
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const rebindInputRef = useRef<HTMLInputElement>(null);
  // Ignore a second click within 500ms so a double-click no longer pauses the
  // sound (covers a natural double-click cadence, not just very fast ones).
  const lastTrigRef = useRef(0);
  const triggerDebounced = () => {
    const now = Date.now();
    if (now - lastTrigRef.current < 500) return;
    lastTrigRef.current = now;
    onTrigger();
  };
  const startLongPress = () => {
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; onEdit(); }, 500);
  };
  const cancelLongPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };
  if (compact) {
    // 调色板颜色：优先使用用户自定义颜色，否则按分类哈希取色
    // 深色主题用鲜亮版调色板，确保按钮文字可读
    const isDark = document.documentElement.dataset.theme === "dark";
    const cc = (isDark ? SA_CAT_PALETTE_DARK : SA_CAT_PALETTE)[saCatColorIdx(s.category ?? "")];
    const customBg    = s.color ? hexToRgba(s.color, 0.18) : cc.bg;
    const customPlay  = s.color ? hexToRgba(s.color, 0.78) : cc.playBg;
    const customBdr   = s.color ? hexToRgba(s.color, 0.55) : cc.border;
    const customGlow  = s.color ? hexToRgba(s.color, 0.38) : cc.glow;
    const customText  = s.color ? hexToRgba(s.color, 0.88) : cc.text;
    const hasClip     = s.clipStart != null || s.clipEnd != null;
    return (
      <div
        className="sound-card sa-pill"
        data-sound-id={s.id}
        onClick={(e) => { if (longPressed.current) { longPressed.current = false; return; } if (onSelect && onSelect(e)) return; triggerDebounced(); }}
        onContextMenu={e => { e.preventDefault(); onRightClick?.(e); }}
        onPointerDown={startLongPress}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onPointerCancel={cancelLongPress}
        title={`${s.name}${s.shortcut ? ` · ${s.shortcut === " " ? "Space" : s.shortcut.toUpperCase()}` : ""} · 右键设置 · 长按编辑`}
        style={{
          position: "relative",
          display: "inline-flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          padding: "6px 14px",
          borderRadius: 20,
          cursor: "pointer",
          userSelect: "none",
          WebkitUserSelect: "none",
          whiteSpace: "nowrap",
          background: missing ? "rgba(255,90,90,0.10)" : playing ? customPlay : customBg,
          border: missing
            ? "1px solid rgba(255,90,90,0.55)"
            : selected
            ? "1.5px solid rgba(230,182,110,0.90)"
            : playing
            ? `1.5px solid ${customBdr}`
            : `1px solid ${customBdr}`,
          color: missing ? "#c0392b" : playing ? "#fff" : customText,
          boxShadow: missing
            ? "none"
            : selected
            ? "inset 0 0 0 2px rgba(230,182,110,0.45)"
            : playing
            ? `0 2px 12px ${customGlow}, inset 0 1px 1px rgba(255,255,255,0.18)`
            : "0 1px 5px rgba(0,0,0,0.08), inset 0 1px 1px rgba(255,255,255,0.55)",
          transform: playing ? "translateY(-1px) scale(1.02)" : undefined,
          filter: playing ? "brightness(1.06)" : undefined,
          transition: "transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease",
        }}
      >
        {/* 音效名 */}
        <span style={{ fontSize: 13, fontWeight: "bold", lineHeight: 1.25 }}>
          {missing ? `⚠ ${s.name}` : s.name}
        </span>
        {/* 快捷键徽章 */}
        {s.shortcut && (
          <span style={{
            fontSize: 10, fontFamily: "sans-serif", flexShrink: 0,
            background: playing ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.09)",
            color: playing ? "rgba(255,255,255,0.90)" : customText,
            borderRadius: 4, padding: "1px 5px", lineHeight: "15px",
          }}>
            {s.shortcut === " " ? "␣" : s.shortcut.toUpperCase()}
          </span>
        )}
        {/* 云端来源徽章 */}
        {s.source === "cloud" && (
          <span title="云端音效库" style={{
            fontSize: 9, flexShrink: 0,
            color: playing ? "rgba(255,255,255,0.70)" : "rgba(80,140,200,0.80)",
            lineHeight: 1,
          }}>☁</span>
        )}
        {/* 多选勾 */}
        {selected && (
          <span style={{ fontSize: 10, color: playing ? "#fff" : "var(--gold)", fontWeight: "bold" }}>✓</span>
        )}
        {/* 重新绑定（音频丢失） */}
        {missing && onRebind && (
          <>
            <button
              onClick={e => { e.stopPropagation(); rebindInputRef.current?.click(); }}
              onPointerDown={e => e.stopPropagation()}
              title="重新绑定音频"
              style={{ background: "none", border: "none", color: "#c0392b", cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1, flexShrink: 0 }}
            >⟳</button>
            <input ref={rebindInputRef} type="file"
              accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.weba,.webm,.wma,.aiff,.aif,.amr,.mp4"
              style={{ display: "none" }} onClick={e => e.stopPropagation()}
              onChange={e => { const f = e.target.files?.[0]; if (f) onRebind(f); e.target.value = ""; }}
            />
          </>
        )}
        {/* 剪辑徽章（内联） */}
        {hasClip && (() => {
          const cs = s.clipStart ?? 0;
          const ce = s.clipEnd ?? cs;
          const tooltip = `已剪辑：${fmtClipFull(cs)} – ${fmtClipFull(ce)}`;
          return (
            <span
              style={{
                fontSize: 11, flexShrink: 0, lineHeight: 1,
                color: playing ? "rgba(255,255,255,0.80)" : "rgba(90,75,175,0.90)",
                cursor: onClip ? "pointer" : "default",
              }}
              title={tooltip}
              onClick={onClip ? (e) => { e.stopPropagation(); onClip!(); } : undefined}
              onPointerDown={onClip ? (e) => e.stopPropagation() : undefined}
            >✂</span>
          );
        })()}
      </div>
    );
  }
  return (
    <div className={`sound-card${playing ? " playing" : ""}`}
      onClick={(e) => { if (longPressed.current) { longPressed.current = false; return; } if (onSelect && onSelect(e)) return; triggerDebounced(); }}
      onContextMenu={e => { e.preventDefault(); if (onRightClick) onRightClick(e); else onEdit(); }}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      style={{ position: "relative", ...(s.color && !playing ? { background: hexToRgba(s.color, 0.28), borderColor: hexToRgba(s.color, 0.55) } : s.color ? { background: hexToRgba(s.color, 0.28) } : null), ...(missing ? { borderColor: "rgba(255,90,90,0.45)", boxShadow: "inset 0 0 0 1px rgba(255,90,90,0.25)" } : null), ...(selected ? { borderColor: "rgba(230,182,110,0.85)", boxShadow: "inset 0 0 0 2px rgba(230,182,110,0.6)" } : null) }}
      title={missing ? `${s.name}  ·  音频丢失，请重新绑定` : `${s.name}  ·  右键菜单 / 长按编辑`}
    >
      <button
        style={{ position: "absolute", top: 2, left: 4, background: "none", border: "none", color: "rgba(92,82,74,0.40)", cursor: "pointer", fontSize: 12, padding: "0 2px", lineHeight: 1 }}
        onClick={e => { e.stopPropagation(); onEdit(); }}
        title="编辑"
      >✎</button>
      <button
        style={{ position: "absolute", top: 2, left: 22, background: "none", border: "none", color: s.favorite ? "var(--gold)" : "rgba(92,82,74,0.40)", cursor: "pointer", fontSize: 13, padding: "0 2px", lineHeight: 1 }}
        onClick={e => { e.stopPropagation(); onToggleFavorite(); }}
        title={s.favorite ? "取消置顶（不再优先显示在题词器音效条）" : "置顶（优先显示在题词器音效条）"}
      >{s.favorite ? "★" : "☆"}</button>
      <button
        style={{ position: "absolute", top: 4, right: 4, background: "none", border: "none", color: "rgba(92,82,74,0.40)", cursor: "pointer", fontSize: 13, padding: "0 2px", lineHeight: 1 }}
        onClick={e => { e.stopPropagation(); onDelete(); }}
      >×</button>
      {s.favorite && favoriteRank && favoriteRank.total > 1 && onMoveFavorite && (
        <div
          style={{ position: "absolute", top: 2, right: 22, display: "flex", alignItems: "center", gap: 2 }}
          onPointerDown={e => e.stopPropagation()}
        >
          <button
            disabled={favoriteRank.pos === 0}
            onClick={e => { e.stopPropagation(); onMoveFavorite(-1); }}
            title={`在置顶里上移（当前第 ${favoriteRank.pos + 1} / ${favoriteRank.total}）`}
            style={{ background: "none", border: "none", color: favoriteRank.pos === 0 ? "rgba(92,82,74,0.30)" : "var(--gold)", cursor: favoriteRank.pos === 0 ? "not-allowed" : "pointer", fontSize: 11, padding: "0 2px", lineHeight: 1 }}
          >▲</button>
          <button
            disabled={favoriteRank.pos === favoriteRank.total - 1}
            onClick={e => { e.stopPropagation(); onMoveFavorite(1); }}
            title={`在置顶里下移（当前第 ${favoriteRank.pos + 1} / ${favoriteRank.total}）`}
            style={{ background: "none", border: "none", color: favoriteRank.pos === favoriteRank.total - 1 ? "rgba(92,82,74,0.30)" : "var(--gold)", cursor: favoriteRank.pos === favoriteRank.total - 1 ? "not-allowed" : "pointer", fontSize: 11, padding: "0 2px", lineHeight: 1 }}
          >▼</button>
        </div>
      )}
      <div style={{ fontSize: 12, color: playing ? "var(--gold)" : "var(--text-main)", textAlign: "center", wordBreak: "break-all", lineHeight: 1.3 }}>
        {s.name}
      </div>
      {s.shortcut && (
        <div style={{ fontSize: 10, color: "var(--text-sub)", marginTop: 3, fontFamily: "sans-serif", background: "rgba(128,128,128,0.18)", padding: "1px 5px", borderRadius: 3 }}>
          {s.shortcut.toUpperCase()}
        </div>
      )}
      {s.loop && !missing && (
        <div style={{ fontSize: 10, color: "rgba(230,182,110,0.6)" }}>循环</div>
      )}
      {missing && (
        <div style={{ fontSize: 10, color: "#c0392b", marginTop: 3, textAlign: "center", lineHeight: 1.25 }}>
          ⚠ 音频丢失<br />请重新绑定
        </div>
      )}
      {missing && onRebind && (
        <>
          <button
            onClick={e => { e.stopPropagation(); rebindInputRef.current?.click(); }}
            onPointerDown={e => e.stopPropagation()}
            title="重新绑定音频（选择文件）"
            style={{ marginTop: 4, background: "rgba(255,90,90,0.15)", border: "1px solid rgba(255,90,90,0.45)", color: "#c0392b", cursor: "pointer", fontSize: 11, padding: "2px 8px", borderRadius: 4, lineHeight: 1.2 }}
          >⟳ 重新绑定</button>
          <input
            ref={rebindInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.weba,.webm,.wma,.aiff,.aif,.amr,.mp4"
            style={{ display: "none" }}
            onClick={e => e.stopPropagation()}
            onChange={e => { const f = e.target.files?.[0]; if (f) onRebind(f); e.target.value = ""; }}
          />
        </>
      )}
      {(s.clipStart != null || s.clipEnd != null) && (() => {
        const cs = s.clipStart ?? 0;
        const ce = s.clipEnd ?? cs;
        const dur = ce - cs;
        const tooltip = `剪辑区间：${fmtClipFull(cs)} – ${fmtClipFull(ce)}`;
        return (
          <span
            style={{ position: "absolute", bottom: 3, right: 4, fontSize: 9, color: "rgba(90,75,175,0.85)", background: "rgba(90,75,175,0.10)", borderRadius: 3, padding: "0 3px", lineHeight: "14px", whiteSpace: "nowrap", cursor: onClip ? "pointer" : "default" }}
            title={tooltip}
            onClick={onClip ? (e) => { e.stopPropagation(); onClip!(); } : undefined}
            onPointerDown={onClip ? (e) => e.stopPropagation() : undefined}
          >✂ {fmtClipShort(dur)}</span>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared category/sub-category grouping for the import/export scope pickers.
// Groups a pack's sounds by first-level category → second-level sub-category,
// keeping first-seen order. Each leaf tracks its sound ids and approximate bytes.
// ---------------------------------------------------------------------------
const PACK_NO_SUB = "（未分类）";

interface PackLeaf { sub: string; key: string; ids: string[]; bytes: number }
interface PackGroup { category: string; subs: PackLeaf[] }

const packLeafKey = (s: { category: string; subCategory?: string }) =>
  `${s.category}\u0000${s.subCategory ?? ""}`;
const packByteOf = (b?: string) => (b ? Math.floor((b.length * 3) / 4) : 0);

function groupPackByCategory(pack: SoundPack): PackGroup[] {
  const order: string[] = [];
  const map = new Map<string, PackLeaf[]>();
  for (const s of pack.sounds) {
    if (!map.has(s.category)) { map.set(s.category, []); order.push(s.category); }
    const subs = map.get(s.category)!;
    const key = packLeafKey(s);
    let leaf = subs.find(x => x.key === key);
    if (!leaf) { leaf = { sub: s.subCategory || PACK_NO_SUB, key, ids: [], bytes: 0 }; subs.push(leaf); }
    leaf.ids.push(s.id);
    leaf.bytes += packByteOf(s.audioBase64);
  }
  return order.map(c => ({ category: c, subs: map.get(c)! }));
}

// ---------------------------------------------------------------------------
// ImportDialog — 导入前按「音效分类 / 子分类」勾选要导入的范围。默认全选，
// 勾选变化时实时刷新「将导入条数 + 冲突数」。仅对勾选范围执行冲突检测与合并。
// ---------------------------------------------------------------------------
function ImportDialog({
  pack,
  existing,
  onCancel,
  onConfirm,
}: {
  pack: SoundPack;
  existing: SoundItem[];
  onCancel: () => void;
  onConfirm: (scopedPack: SoundPack, strategy: ConflictStrategy) => void;
}) {
  const groups = useMemo(() => groupPackByCategory(pack), [pack]);
  const allLeafKeys = useMemo(() => groups.flatMap(g => g.subs.map(s => s.key)), [groups]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allLeafKeys));
  const [strategy, setStrategy] = useState<ConflictStrategy>("keepboth");

  const toggleLeaf = (k: string) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const catSel = (g: PackGroup) => g.subs.filter(s => selected.has(s.key)).length;
  const toggleCat = (g: PackGroup) => setSelected(prev => {
    const n = new Set(prev);
    const keys = g.subs.map(s => s.key);
    const allOn = keys.every(k => n.has(k));
    keys.forEach(k => (allOn ? n.delete(k) : n.add(k)));
    return n;
  });
  const allOn = selected.size === allLeafKeys.length && allLeafKeys.length > 0;
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(allLeafKeys));

  const selectedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of pack.sounds) if (selected.has(packLeafKey(s))) ids.add(s.id);
    return ids;
  }, [pack, selected]);

  // Scope the pack down to the selected leaves, then run conflict detection /
  // merge against only that scope (live-updates as the selection changes).
  const scopedPack = useMemo(() => {
    const drop = new Set<string>();
    for (const s of pack.sounds) if (!selectedIds.has(s.id)) drop.add(s.id);
    return packWithoutSounds(pack, drop);
  }, [pack, selectedIds]);

  const conflictCount = useMemo(
    () => detectConflicts(existing, scopedPack).length,
    [existing, scopedPack],
  );
  const count = selectedIds.size;
  const total = pack.sounds.length;
  const multiCat = groups.length > 1 || groups.some(g => g.subs.length > 1);

  const ignoredCount = (total - count) + (strategy === "skip" ? conflictCount : 0);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
      onClick={onCancel}>
      <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 480, maxHeight: "86vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
        <div style={{ color: "var(--gold)", fontSize: 17, fontWeight: "bold", marginBottom: 4 }}>导入音效包</div>
        <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13, marginBottom: ignoredCount > 0 ? 4 : 10 }}>
          将导入 <b style={{ color: "#E6B66E" }}>{count}</b> / {total} 条，其中 <b style={{ color: "#E6B66E" }}>{conflictCount}</b> 条与现有音效冲突（同名或同快捷键）
        </div>
        {ignoredCount > 0 ? (
          <div style={{ fontSize: 12, color: "rgba(160,80,60,0.85)", background: "rgba(230,100,60,0.07)", border: "1px solid rgba(230,100,60,0.18)", borderRadius: 6, padding: "4px 10px", marginBottom: 10 }}>
            本次将忽略 <b>{ignoredCount}</b> 条
            {(() => {
              const parts: string[] = [];
              if (total - count > 0) parts.push(`未勾选 ${total - count} 条`);
              if (strategy === "skip" && conflictCount > 0) parts.push(`跳过冲突 ${conflictCount} 条`);
              return parts.length > 0 ? `（${parts.join(" + ")}）` : "";
            })()}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "rgba(60,140,80,0.85)", background: "rgba(60,160,80,0.07)", border: "1px solid rgba(60,160,80,0.18)", borderRadius: 6, padding: "4px 10px", marginBottom: 10 }}>
            全部导入，无内容被忽略
          </div>
        )}

        {multiCat && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13 }}>选择要导入的范围</div>
              <button className="btn" style={{ padding: "2px 10px", fontSize: 12 }} onClick={toggleAll}>
                {allOn ? "全不选" : "全选"}
              </button>
            </div>
            <div className="scroll-area" style={{ flex: "0 1 auto", overflowY: "auto", maxHeight: 240, border: "1px solid rgba(60,50,45,0.12)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, background: "rgba(255,255,255,0.5)" }}>
              {groups.map(g => {
                const sel = catSel(g);
                return (
                  <div key={g.category} style={{ marginBottom: 6 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer", color: "#2c2622", fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={sel === g.subs.length}
                        ref={el => { if (el) el.indeterminate = sel > 0 && sel < g.subs.length; }}
                        onChange={() => toggleCat(g)}
                      />
                      <span style={{ fontWeight: 600 }}>{g.category}</span>
                      <span style={{ color: "rgba(60,50,40,0.75)", fontSize: 12 }}>{g.subs.reduce((n, s) => n + s.ids.length, 0)} 条</span>
                    </label>
                    {(g.subs.length > 1 || (g.subs[0] && g.subs[0].sub !== PACK_NO_SUB)) && g.subs.map(s => (
                      <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0 3px 24px", cursor: "pointer", color: "rgba(50,42,36,0.85)", fontSize: 13 }}>
                        <input type="checkbox" checked={selected.has(s.key)} onChange={() => toggleLeaf(s.key)} />
                        <span>{s.sub}</span>
                        <span style={{ color: "rgba(92,82,74,0.40)", fontSize: 12 }}>{s.ids.length} 条</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          {([
            ["keepboth", "保留两者", "新条目用「(2)」后缀；冲突的快捷键留给已有音效"],
            ["replace", "覆盖已有", "用导入条目替换已有同名/同快捷键音效"],
            ["skip", "跳过冲突", "只导入无冲突的条目"],
          ] as [ConflictStrategy, string, string][]).map(([v, label, desc]) => (
            <label key={v} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 8, background: strategy === v ? "rgba(230,182,110,0.12)" : "rgba(255,255,255,0.45)", border: `1px solid ${strategy === v ? "rgba(230,182,110,0.5)" : "rgba(60,50,45,0.12)"}`, cursor: "pointer" }}>
              <input type="radio" name="importStrategy" value={v} checked={strategy === v} onChange={() => setStrategy(v)} style={{ marginTop: 3 }} />
              <div>
                <div style={{ color: strategy === v ? "var(--gold)" : "rgba(50,42,36,0.85)", fontSize: 14 }}>{label}</div>
                <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 12, marginTop: 2 }}>{desc}</div>
              </div>
            </label>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel}>取消</button>
          <button
            className="btn gold-btn"
            disabled={count === 0}
            title={count === 0 ? "请至少勾选一个范围" : "导入所选范围"}
            onClick={() => onConfirm(scopedPack, strategy)}
          >
            确认导入
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExportDialog — 导出前按「音效分类 / 子分类」勾选要导出的范围。默认全选，
// 勾选变化时实时刷新「预计体积」。失效（仅元数据）条目仍可跳过或一并导出。
// ---------------------------------------------------------------------------
function ExportDialog({
  pack,
  failed,
  onClose,
}: {
  pack: SoundPack;
  failed: { id: string; name: string }[];
  onClose: () => void;
}) {
  const byteOf = packByteOf;

  const groups = useMemo(() => groupPackByCategory(pack), [pack]);

  // Selection source of truth is the set of selected sound IDs, so per-sound
  // checkboxes (search list) and per-category/sub checkboxes stay consistent.
  const allIds = useMemo(() => pack.sounds.map(s => s.id), [pack]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(allIds));

  const [query, setQuery] = useState("");
  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const searching = tokens.length > 0;
  const matches = useMemo(() => {
    if (!searching) return [] as ExportedSound[];
    return pack.sounds.filter(s => {
      const name = (s.name || "").toLowerCase();
      const cat = (s.category || "").toLowerCase();
      const sub = (s.subCategory || "").toLowerCase();
      return tokens.every(t =>
        name.includes(t) || pinyinMatches(s.name || "", t) ||
        cat.includes(t) || pinyinMatches(s.category || "", t) ||
        sub.includes(t) || pinyinMatches(s.subCategory || "", t)
      );
    });
  }, [pack, tokens, searching]);

  const toggleSound = (id: string) => setSelectedIds(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const leafSel = (s: PackLeaf) => s.ids.filter(id => selectedIds.has(id)).length;
  const toggleLeaf = (s: PackLeaf) => setSelectedIds(prev => {
    const n = new Set(prev);
    const allOn = s.ids.every(id => n.has(id));
    s.ids.forEach(id => (allOn ? n.delete(id) : n.add(id)));
    return n;
  });
  const catIds = (g: PackGroup) => g.subs.flatMap(s => s.ids);
  const catSel = (g: PackGroup) => catIds(g).filter(id => selectedIds.has(id)).length;
  const toggleCat = (g: PackGroup) => setSelectedIds(prev => {
    const n = new Set(prev);
    const ids = catIds(g);
    const allOn = ids.every(id => n.has(id));
    ids.forEach(id => (allOn ? n.delete(id) : n.add(id)));
    return n;
  });
  const allOn = selectedIds.size === allIds.length && allIds.length > 0;
  const toggleAll = () => setSelectedIds(allOn ? new Set() : new Set(allIds));

  // When searching, "全选/全不选" acts on the current matches only.
  const matchIds = useMemo(() => matches.map(s => s.id), [matches]);
  const matchAllOn = matchIds.length > 0 && matchIds.every(id => selectedIds.has(id));
  const toggleMatches = () => setSelectedIds(prev => {
    const n = new Set(prev);
    if (matchAllOn) matchIds.forEach(id => n.delete(id));
    else matchIds.forEach(id => n.add(id));
    return n;
  });

  const bytes = useMemo(() => {
    let t = 0;
    for (const s of pack.sounds) if (selectedIds.has(s.id)) t += byteOf(s.audioBase64);
    return t;
  }, [pack, selectedIds]);

  const scopedPack = useMemo(() => {
    const drop = new Set<string>();
    for (const s of pack.sounds) if (!selectedIds.has(s.id)) drop.add(s.id);
    return packWithoutSounds(pack, drop);
  }, [pack, selectedIds]);

  const scopedFailed = failed.filter(f => selectedIds.has(f.id));
  const count = selectedIds.size;
  const total = pack.sounds.length;
  const multiCat = groups.length > 1 || groups.some(g => g.subs.length > 1);
  const catLabel = (s: ExportedSound) =>
    s.subCategory ? `${s.category} · ${s.subCategory}` : s.category;

  function highlight(text: string): React.ReactNode {
    if (tokens.length === 0) return text;
    const lower = text.toLowerCase();
    type Span = { start: number; end: number };
    const spans: Span[] = [];
    for (const t of tokens) {
      if (!t) continue;
      let from = 0;
      while (from <= lower.length) {
        const idx = lower.indexOf(t, from);
        if (idx < 0) break;
        spans.push({ start: idx, end: idx + t.length });
        from = idx + Math.max(t.length, 1);
      }
      for (const sp of pinyinSpans(lower, t)) spans.push(sp);
    }
    if (spans.length === 0) return text;
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Span[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) {
        if (s.end > last.end) last.end = s.end;
      } else {
        merged.push({ ...s });
      }
    }
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    merged.forEach((span, i) => {
      if (span.start > cursor) parts.push(text.slice(cursor, span.start));
      parts.push(
        <mark key={i} style={{ background: "rgba(230,182,110,0.35)", color: "#2c2622", padding: "0 1px", borderRadius: 2 }}>
          {text.slice(span.start, span.end)}
        </mark>
      );
      cursor = span.end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return <>{parts}</>;
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(120,110,120,0.28)", backdropFilter: "blur(8px)" }}
      onClick={onClose}>
      <div className="glass-strong" style={{ borderRadius: 18, padding: 28, width: 480, maxHeight: "86vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
        <div style={{ color: "var(--gold)", fontSize: 17, fontWeight: "bold", marginBottom: 4 }}>导出音效包</div>
        <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13, marginBottom: 10 }}>
          已选 <b style={{ color: "#E6B66E" }}>{count}</b> / {total} 条 · 预计体积约 <b style={{ color: "#E6B66E" }}>{formatBytes(bytes)}</b>
        </div>

        {total > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索音效名称（支持拼音/首字母）"
                style={{ flex: 1, minWidth: 0, padding: "5px 10px", fontSize: 13, borderRadius: 8, border: "1px solid rgba(60,50,45,0.2)", background: "rgba(255,255,255,0.7)", color: "#2c2622" }}
              />
              <button
                className="btn"
                style={{ padding: "2px 10px", fontSize: 12, whiteSpace: "nowrap" }}
                onClick={searching ? toggleMatches : toggleAll}
                disabled={searching && matchIds.length === 0}
              >
                {searching ? (matchAllOn ? "全不选" : "全选") : (allOn ? "全不选" : "全选")}
              </button>
            </div>

            {searching ? (
              <div className="scroll-area" style={{ flex: "0 1 auto", overflowY: "auto", maxHeight: 280, border: "1px solid rgba(60,50,45,0.12)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, background: "rgba(255,255,255,0.5)" }}>
                {matches.length === 0 ? (
                  <div style={{ color: "rgba(92,82,74,0.55)", fontSize: 13, padding: "6px 0", textAlign: "center" }}>没有匹配的音效</div>
                ) : matches.map(s => (
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer", color: "rgba(50,42,36,0.9)", fontSize: 13 }}>
                    <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSound(s.id)} />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{highlight(s.name || "")}</span>
                    <span style={{ color: "rgba(92,82,74,0.40)", fontSize: 12, whiteSpace: "nowrap" }}>{highlight(catLabel(s))} · {formatBytes(byteOf(s.audioBase64))}</span>
                  </label>
                ))}
              </div>
            ) : multiCat ? (
              <div className="scroll-area" style={{ flex: "0 1 auto", overflowY: "auto", maxHeight: 280, border: "1px solid rgba(60,50,45,0.12)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, background: "rgba(255,255,255,0.5)" }}>
                {groups.map(g => {
                  const sel = catSel(g);
                  const catTotal = catIds(g).length;
                  const catBytes = g.subs.reduce((n, s) => n + s.bytes, 0);
                  return (
                    <div key={g.category} style={{ marginBottom: 6 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer", color: "#2c2622", fontSize: 14 }}>
                        <input
                          type="checkbox"
                          checked={sel === catTotal}
                          ref={el => { if (el) el.indeterminate = sel > 0 && sel < catTotal; }}
                          onChange={() => toggleCat(g)}
                        />
                        <span style={{ fontWeight: 600 }}>{g.category}</span>
                        <span style={{ color: "rgba(60,50,40,0.75)", fontSize: 12 }}>{formatBytes(catBytes)}</span>
                      </label>
                      {(g.subs.length > 1 || (g.subs[0] && g.subs[0].sub !== PACK_NO_SUB)) && g.subs.map(s => {
                        const lsel = leafSel(s);
                        return (
                          <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0 3px 24px", cursor: "pointer", color: "rgba(50,42,36,0.85)", fontSize: 13 }}>
                            <input
                              type="checkbox"
                              checked={lsel === s.ids.length}
                              ref={el => { if (el) el.indeterminate = lsel > 0 && lsel < s.ids.length; }}
                              onChange={() => toggleLeaf(s)}
                            />
                            <span>{s.sub}</span>
                            <span style={{ color: "rgba(92,82,74,0.40)", fontSize: 12 }}>{s.ids.length} 条 · {formatBytes(s.bytes)}</span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}

        {bytes > EXPORT_LARGE_PACK_BYTES && (
          <div style={{ color: "#E6B66E", fontSize: 12.5, lineHeight: 1.6, marginBottom: 14, background: "rgba(255,150,80,0.08)", border: "1px solid rgba(255,150,80,0.25)", borderRadius: 8, padding: "8px 12px" }}>
            体积较大（超过 50MB），导出时浏览器可能会卡顿数秒，请耐心等待，不要关闭页面。
          </div>
        )}
        {scopedFailed.length > 0 && (
          <>
            <div style={{ color: "rgba(60,50,40,0.75)", fontSize: 13, marginBottom: 8 }}>
              所选范围内有 <b style={{ color: "#E6B66E" }}>{scopedFailed.length}</b> 条音效只有元数据、找不到音频文件。
            </div>
            <div className="scroll-area" style={{ maxHeight: 140, overflowY: "auto", border: "1px solid rgba(60,50,45,0.12)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, background: "rgba(255,255,255,0.5)" }}>
              {scopedFailed.map(f => (
                <div key={f.id} style={{ color: "rgba(170,60,60,0.9)", fontSize: 13, padding: "3px 0" }}>{f.name}</div>
              ))}
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button className="btn" onClick={onClose}>取消</button>
          {scopedFailed.length > 0 ? (
            <>
              <button
                className="btn"
                disabled={count === 0}
                title="导出时跳过这些没有音频的条目"
                onClick={() => {
                  const dropIds = new Set(scopedFailed.map(f => f.id));
                  downloadSoundPack(packWithoutSounds(scopedPack, dropIds));
                  onClose();
                }}
              >
                跳过这些条目
              </button>
              <button
                className="btn gold-btn"
                disabled={count === 0}
                title="把这些条目以「仅元数据」方式一并导出（导入后仍需要重新绑定音频）"
                onClick={() => { downloadSoundPack(scopedPack); onClose(); }}
              >
                一并导出
              </button>
            </>
          ) : (
            <button
              className="btn gold-btn"
              disabled={count === 0}
              title={count === 0 ? "请至少勾选一个范围" : "下载音效包"}
              onClick={() => { downloadSoundPack(scopedPack); onClose(); }}
            >
              确认导出
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
