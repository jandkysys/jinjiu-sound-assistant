import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SoundItem } from "./soundPack";
import { safeSaveSounds } from "./soundPack";
import { getPersisted, setPersisted } from "./persist";
import { getAudioObjectUrl, revokeAudioObjectUrl, putAudioBlob } from "./audioStore";

const SOUNDS_KEY = "jt_sounds";
const MASTER_VOL_KEY = "jt_master_vol";
const DUCK_ENABLED_KEY = "jt_duck_enabled";
const DUCK_FACTOR_KEY = "jt_duck_factor";
const DUCK_FADE_KEY = "jt_duck_fade";
const SINK_KEY = "jt_audio_sink";
const SOUNDS_EVENT = "jt_sounds_change";
const MASTER_VOL_EVENT = "jt_master_vol_change";
const DUCK_ENABLED_EVENT = "jt_duck_enabled_change";
const DUCK_FACTOR_EVENT = "jt_duck_factor_change";
const DUCK_FADE_EVENT = "jt_duck_fade_change";
const SINK_EVENT = "jt_audio_sink_change";

// Ducking defaults. The factor is stored/displayed as a percentage (how far BGM
// is pushed down, 10–80%); the fade duration in ms (100–2000) controls how
// smoothly loops dip and recover. Both are user-adjustable and persisted.
const DUCK_FACTOR_DEFAULT = 30;
const DUCK_FADE_MS_DEFAULT = 450;
export const DUCK_FACTOR_MIN = 10;
export const DUCK_FACTOR_MAX = 80;
export const DUCK_FADE_MS_MIN = 100;
export const DUCK_FADE_MS_MAX = 2000;
const DUCK_FADE_STEPS = 18;

function loadSounds(): SoundItem[] {
  try {
    const r = getPersisted(SOUNDS_KEY);
    if (r) return JSON.parse(r);
  } catch {}
  return [];
}

function loadMasterVol(): number {
  try {
    const r = getPersisted(MASTER_VOL_KEY);
    if (r != null) {
      const n = Number(r);
      if (!Number.isNaN(n) && n >= 0 && n <= 100) return n;
    }
  } catch {}
  return 80;
}

function loadSinkId(): string {
  try {
    const r = getPersisted(SINK_KEY);
    if (r != null) return r;
  } catch {}
  return "";
}

function loadDuckEnabled(): boolean {
  try {
    const r = getPersisted(DUCK_ENABLED_KEY);
    if (r != null) return r === "1" || r === "true";
  } catch {}
  return true;
}

function clampDuckFactor(n: number): number {
  return Math.max(DUCK_FACTOR_MIN, Math.min(DUCK_FACTOR_MAX, Math.round(n)));
}

function clampDuckFade(n: number): number {
  return Math.max(DUCK_FADE_MS_MIN, Math.min(DUCK_FADE_MS_MAX, Math.round(n)));
}

function loadDuckFactor(): number {
  try {
    const r = getPersisted(DUCK_FACTOR_KEY);
    if (r != null) {
      const n = Number(r);
      if (!Number.isNaN(n)) return clampDuckFactor(n);
    }
  } catch {}
  return DUCK_FACTOR_DEFAULT;
}

function loadDuckFade(): number {
  try {
    const r = getPersisted(DUCK_FADE_KEY);
    if (r != null) {
      const n = Number(r);
      if (!Number.isNaN(n)) return clampDuckFade(n);
    }
  } catch {}
  return DUCK_FADE_MS_DEFAULT;
}

export interface SoundEngine {
  sounds: SoundItem[];
  masterVol: number;
  setMasterVol: (v: number) => void;
  duckEnabled: boolean;
  setDuckEnabled: (v: boolean) => void;
  // How far BGM is pushed down while ducking, as a percentage (10–80).
  duckFactor: number;
  setDuckFactor: (v: number) => void;
  // Fade duration (ms) for dipping and recovering loops (100–2000).
  duckFadeMs: number;
  setDuckFadeMs: (v: number) => void;
  audioSinkId: string;
  setAudioSinkId: (id: string) => Promise<void>;
  playing: Set<string>;
  // Sounds paused in place (resumable from their current position).
  paused: Set<string>;
  // Most-recently-started sound still playing/paused; drives the now-playing bar.
  currentTrackId: string | null;
  triggerSound: (id: string, forceLoop?: boolean, replay?: boolean) => void;
  setSoundVolume: (id: string, volume: number) => void;
  setSoundShortcut: (id: string, key: string | undefined) => void;
  stopAll: () => void;
  // Pause/resume a single track (used by the now-playing bar + BGM pause key).
  pauseResume: (id: string) => void;
  stopSound: (id: string) => void;
  seekSound: (id: string, seconds: number) => void;
  getAudioElement: (id: string) => HTMLAudioElement | undefined;
  // BGM playlist controller.
  bgmMode: BgmMode;
  setBgmMode: (mode: BgmMode) => void;
  setBgmPlaylist: (ids: string[]) => void;
  playBgm: (id: string, replay?: boolean) => void;
  bgmCurrentId: string | null;
  // Manual BGM playlist navigation (功能快捷键 上一首 / 下一首). Honors the
  // active play mode (shuffle picks a random other track).
  bgmNext: () => void;
  bgmPrev: () => void;
  // Manually enter/leave the ducked state (e.g. while the teleprompter is
  // reading aloud). Shares the same `duckEnabled` switch and active-ducker set
  // as short non-loop sound effects, so BGM gets out of the way the same way.
  startDucking: (id?: string) => void;
  endDucking: (id?: string) => void;
}

// Default ducker id used by external callers (teleprompter voice follow / TTS)
// that don't manage their own sound id.
export const READING_DUCK_ID = "__reading__";

interface Options {
  enableGlobalShortcuts?: boolean;
}

// ---- Module-level singleton store ----
// Audio elements, playing-set and "live" sound/volume snapshots live here so
// they survive component unmounts. Background music keeps playing across page
// changes.

let soundsState: SoundItem[] =
  typeof window === "undefined" ? [] : loadSounds();
let masterVolState: number =
  typeof window === "undefined" ? 80 : loadMasterVol();
let duckEnabledState: boolean =
  typeof window === "undefined" ? true : loadDuckEnabled();
let duckFactorState: number =
  typeof window === "undefined" ? DUCK_FACTOR_DEFAULT : loadDuckFactor();
let duckFadeMsState: number =
  typeof window === "undefined" ? DUCK_FADE_MS_DEFAULT : loadDuckFade();
let sinkIdState: string =
  typeof window === "undefined" ? "" : loadSinkId();

type AudioWithSink = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
type AudioCtxWithSink = AudioContext & { setSinkId?: (id: string) => Promise<void> };

function applySinkTo(aud: HTMLAudioElement): Promise<void> {
  const a = aud as AudioWithSink;
  if (!sinkIdState || typeof a.setSinkId !== "function") return Promise.resolve();
  return a.setSinkId(sinkIdState).catch(() => {});
}
async function applySinkToAll(): Promise<void> {
  // Elements wired through Web Audio lose their element-level setSinkId;
  // route the AudioContext output to the selected device instead.
  if (vuCtx && sinkIdState) {
    const ctxS = vuCtx as AudioCtxWithSink;
    if (typeof ctxS.setSinkId === "function") {
      await ctxS.setSinkId(sinkIdState).catch(() => {});
    }
  }
  // Apply to any elements not yet in the Web Audio graph.
  for (const [id, aud] of Object.entries(audioMap)) {
    if (!vuSrcNodes.has(aud)) await applySinkTo(aud);
    // If already connected to Web Audio the AudioContext.setSinkId call above
    // covers the routing; calling aud.setSinkId would be a silent no-op.
    void id;
  }
}

// ---- Web Audio level metering -----------------------------------------------
// Each playing audio element is connected through a shared AudioContext so the
// UI can read live RMS levels (getSoundLevel). The graph per sound is:
//   MediaElementAudioSourceNode → AnalyserNode → AudioContext.destination
// HTMLAudioElement.volume still applies before the source node, so per-sound
// volume control, ducking, and fade-in/out all work unchanged.
//
// Output device routing: once MediaElementAudioSourceNode is created,
// HTMLAudioElement.setSinkId() has no effect. We compensate by calling
// AudioContext.setSinkId() (Chrome 110+) on every device-change; on browsers
// that do not support this API the default output device is used.

let vuCtx: AudioContext | null = null;
const vuSrcNodes = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
const vuAnalysers: Record<string, AnalyserNode> = {};
const vuDataBufs: Record<string, Uint8Array<ArrayBuffer>> = {};

function getOrCreateVuCtx(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    if (!vuCtx || vuCtx.state === "closed") {
      vuCtx = new AudioContext();
      // Apply the current output device to the freshly-created context.
      if (sinkIdState) {
        const ctxS = vuCtx as AudioCtxWithSink;
        if (typeof ctxS.setSinkId === "function") {
          ctxS.setSinkId(sinkIdState).catch(() => {});
        }
      }
    }
    if (vuCtx.state === "suspended") vuCtx.resume().catch(() => {});
    return vuCtx;
  } catch { return null; }
}

// Set up (or reuse) the Web Audio chain for a sound. Safe to call multiple
// times — subsequent calls are no-ops. Called every time a sound starts
// playing so newly-created or freshly-replaced elements are always wired in.
function setupVuAnalyser(id: string, aud: HTMLAudioElement): void {
  if (vuAnalysers[id]) return;
  const ctx = getOrCreateVuCtx();
  if (!ctx) return;
  try {
    let src = vuSrcNodes.get(aud);
    if (!src) {
      src = ctx.createMediaElementSource(aud);
      vuSrcNodes.set(aud, src);
      // Must connect to destination or audio will be silenced through the graph.
      src.connect(ctx.destination);
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    vuAnalysers[id] = analyser;
    vuDataBufs[id] = new Uint8Array(analyser.frequencyBinCount);
  } catch { /* Web Audio unavailable or element already claimed elsewhere */ }
}

// Remove the per-sound analyser entries when a sound is deleted / rebound.
function teardownVuAnalyser(id: string): void {
  try { vuAnalysers[id]?.disconnect(); } catch {}
  delete vuAnalysers[id];
  delete vuDataBufs[id];
}

// Returns the current RMS amplitude level (0–1) for a sound. Returns 0 while
// not yet connected to the Web Audio graph (i.e. sound has not played yet in
// this session). Call periodically via rAF for live readings during playback.
export function getSoundLevel(id: string): number {
  const analyser = vuAnalysers[id];
  const data = vuDataBufs[id];
  if (!analyser || !data) return 0;
  analyser.getByteFrequencyData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  return sum / data.length / 255;
}
let playingState: Set<string> = new Set();
// Sounds that are paused (kept "current" but not actively playing). Their
// <audio> elements retain currentTime so they can resume in place.
let pausedState: Set<string> = new Set();
// The most-recently-started sound that is still playing/paused. Drives the
// now-playing player bar. Cleared when it stops.
let currentTrackIdState: string | null = null;
const audioMap: Record<string, HTMLAudioElement> = {};
const subscribers = new Set<() => void>();

// ---- BGM playlist controller ----------------------------------------------
// Background music plays as a single exclusive stream with a play mode:
//   single  → repeat the current track (loop)
//   list    → play the playlist in order, wrapping at the end
//   shuffle → pick a random next track
const BGM_MODE_KEY = "jt_bgm_mode";
const BGM_MODE_EVENT = "jt_bgm_mode_change";
export type BgmMode = "single" | "list" | "shuffle" | "stop";
function loadBgmMode(): BgmMode {
  try {
    const r = getPersisted(BGM_MODE_KEY);
    if (r === "single" || r === "list" || r === "shuffle" || r === "stop") return r;
  } catch {}
  return "single";
}
let bgmModeState: BgmMode = typeof window === "undefined" ? "single" : loadBgmMode();
// Ordered ids the page considers the active BGM playlist (current bg category).
let bgmPlaylist: string[] = [];
// The BGM track currently loaded into the exclusive stream (playing or paused).
let bgmCurrentIdState: string | null = null;

// Elapsed-play-time bookkeeping for currently-playing loops. Lives at module
// scope so the running total survives page changes and component unmounts.
//
// For loops backed by a real <audio> element the elapsed time is derived from
// the element's own playback progress: `loopAccumulatedMs` holds the summed
// duration of completed loop cycles, and the live `audio.currentTime` is added
// on read. This keeps the counter tied to actual playback (it stalls when the
// media is paused, buffering, blocked by autoplay, etc.) instead of wall-clock.
// `loopLastTimeMs` tracks the previous `currentTime` sample so we can detect a
// wrap-around (cycle completion) inside the `timeupdate` handler.
//
// `loopStartTimes` is a wall-clock fallback used only for "loops" that have no
// audio bound (the UI still shows a playing indicator in that case).
const loopAccumulatedMs: Record<string, number> = {};
const loopLastTimeMs: Record<string, number> = {};
const loopStartTimes: Record<string, number> = {};

// Session-level cumulative BGM playtime. This sums how long every loop has
// played across the whole live session, surviving single-stop / stop-all so the
// host can estimate total usage. Only `resetSessionTotal()` (a manual "清零")
// or a page refresh resets it. The displayed total is this finalized sum plus
// the live elapsed time of any loops currently playing.
let sessionTotalFinalizedMs = 0;

function clearLoopTiming(id: string) {
  // Roll this loop's elapsed time into the session total before discarding its
  // per-loop bookkeeping, so stopping a loop preserves the cumulative figure.
  sessionTotalFinalizedMs += getLoopElapsedMs(id);
  const aud = audioMap[id];
  if (aud) aud.ontimeupdate = null;
  delete loopAccumulatedMs[id];
  delete loopLastTimeMs[id];
  delete loopStartTimes[id];
}

function beginLoopTiming(id: string, aud: HTMLAudioElement | null) {
  if (aud) {
    delete loopStartTimes[id];
    loopAccumulatedMs[id] = 0;
    loopLastTimeMs[id] = aud.currentTime * 1000;
    aud.ontimeupdate = () => {
      const cur = aud.currentTime * 1000;
      const last = loopLastTimeMs[id] ?? 0;
      // currentTime jumped backwards → the loop wrapped, so a full cycle
      // completed. Add the track duration (best estimate of the cycle length).
      if (cur + 50 < last) {
        const dur = aud.duration;
        const cycle = Number.isFinite(dur) && dur > 0 ? dur * 1000 : last;
        loopAccumulatedMs[id] = (loopAccumulatedMs[id] ?? 0) + cycle;
      }
      loopLastTimeMs[id] = cur;
    };
  } else {
    delete loopAccumulatedMs[id];
    delete loopLastTimeMs[id];
    loopStartTimes[id] = Date.now();
  }
}

export function getLoopElapsedMs(id: string): number {
  const acc = loopAccumulatedMs[id];
  if (acc != null) {
    const aud = audioMap[id];
    return acc + (aud ? aud.currentTime * 1000 : 0);
  }
  const start = loopStartTimes[id];
  return start == null ? 0 : Date.now() - start;
}

// Total BGM playtime for the current session: the finalized sum of stopped
// loops plus the live elapsed of any loops still playing.
export function getSessionTotalMs(): number {
  let total = sessionTotalFinalizedMs;
  for (const id of playingState) total += getLoopElapsedMs(id);
  for (const id of pausedState) if (!playingState.has(id)) total += getLoopElapsedMs(id);
  return total;
}

export function getAudioElement(id: string): HTMLAudioElement | undefined {
  return audioMap[id];
}

// Set the "current track" shown in the now-playing bar. Pass null to clear.
function setCurrentTrack(id: string | null) {
  if (currentTrackIdState === id) return;
  currentTrackIdState = id;
}

// When a sound stops, if it was the current track move focus to any other
// still-active (playing or paused) sound, preferring the BGM stream.
function reassignCurrentTrackAfterStop(stoppedId: string) {
  if (currentTrackIdState !== stoppedId) return;
  if (bgmCurrentIdState && bgmCurrentIdState !== stoppedId) { setCurrentTrack(bgmCurrentIdState); return; }
  const next = [...playingState, ...pausedState].find((x) => x !== stoppedId) ?? null;
  setCurrentTrack(next);
}

// Manually reset the session total to zero. Any loops still playing have their
// live baseline rebased so counting resumes from 0 rather than jumping back up.
export function resetSessionTotal() {
  sessionTotalFinalizedMs = 0;
  for (const id of playingState) {
    if (loopAccumulatedMs[id] != null) {
      const aud = audioMap[id];
      // getLoopElapsedMs returns `acc + currentTime`. To make the elapsed read
      // exactly 0 right now (even mid-track), offset the accumulator by the
      // current playhead. As playback advances (and on each loop wrap) the
      // elapsed grows from 0 again.
      const cur = aud ? aud.currentTime * 1000 : 0;
      loopAccumulatedMs[id] = -cur;
      loopLastTimeMs[id] = cur;
    } else if (loopStartTimes[id] != null) {
      loopStartTimes[id] = Date.now();
    }
  }
  notify();
}

// IDs of currently playing non-loop sounds that are actively ducking BGM.
const activeDuckers = new Set<string>();

// Per-sound clip-end enforcers. Stored as EventListener so they can be
// attached/detached without touching `ontimeupdate` (used for loop timing).
const clipEnforcers: Record<string, EventListener> = {};

// Per-sound fade timers (setInterval handles) for fade-in and fade-out ramps.
const soundFadeTimers: Record<string, number> = {};
// Per-sound fade-out watchers: timeupdate listener that fires the fade-out ramp
// when playback approaches clipEnd.
const soundFadeOutListeners: Record<string, EventListener> = {};

function clearSoundFadeTimer(id: string) {
  const t = soundFadeTimers[id];
  if (t != null) { clearInterval(t); delete soundFadeTimers[id]; }
}

function detachFadeOutWatcher(id: string) {
  const fn = soundFadeOutListeners[id];
  const aud = audioMap[id];
  if (fn && aud) aud.removeEventListener("timeupdate", fn);
  delete soundFadeOutListeners[id];
}

function detachSoundFade(id: string) {
  clearSoundFadeTimer(id);
  detachFadeOutWatcher(id);
}

// Ramp audio volume from 0 → targetVol over fadeInSec seconds.
function startFadeIn(id: string, aud: HTMLAudioElement, targetVol: number, fadeInSec: number) {
  clearSoundFadeTimer(id);
  if (fadeInSec <= 0) { aud.volume = targetVol; return; }
  aud.volume = 0;
  const steps = Math.max(10, Math.round(fadeInSec * 30));
  const stepMs = (fadeInSec * 1000) / steps;
  let step = 0;
  soundFadeTimers[id] = window.setInterval(() => {
    step++;
    const p = Math.min(1, step / steps);
    aud.volume = targetVol * p;
    if (step >= steps) clearSoundFadeTimer(id);
  }, stepMs);
}

// Attach a timeupdate watcher that starts a fade-out ramp when the playhead
// enters the last fadeOutSec of the clipped region, then calls onStop.
function attachFadeOutWatcher(
  id: string,
  aud: HTMLAudioElement,
  clipEnd: number,
  fadeOutSec: number,
  onStop: () => void,
) {
  detachFadeOutWatcher(id);
  if (fadeOutSec <= 0) return;
  const fn: EventListener = () => {
    const remaining = clipEnd - aud.currentTime;
    if (remaining > fadeOutSec || remaining <= 0) return;
    detachFadeOutWatcher(id);
    clearSoundFadeTimer(id);
    const startVol = aud.volume;
    const steps = Math.max(8, Math.round(remaining * 25));
    const stepMs = (remaining * 1000) / steps;
    let step = 0;
    soundFadeTimers[id] = window.setInterval(() => {
      step++;
      const p = Math.min(1, step / steps);
      aud.volume = Math.max(0, startVol * (1 - p));
      if (step >= steps) {
        clearSoundFadeTimer(id);
        onStop();
      }
    }, stepMs);
  };
  soundFadeOutListeners[id] = fn;
  aud.addEventListener("timeupdate", fn);
}

function detachClipEnforcer(id: string) {
  const fn = clipEnforcers[id];
  const aud = audioMap[id];
  if (fn && aud) aud.removeEventListener("timeupdate", fn);
  delete clipEnforcers[id];
  detachSoundFade(id);
}

// onEnd: optional override for what happens when clipEnd is reached (used by
// BGM non-loop modes to call bgmAdvanceGlobal instead of the generic stop).
function attachClipEnforcer(
  id: string,
  aud: HTMLAudioElement,
  s: SoundItem,
  isLoop: boolean,
  onEnd?: () => void,
) {
  detachClipEnforcer(id);
  if (s.clipEnd == null) return;
  const end = s.clipEnd;
  const start = s.clipStart ?? 0;
  const fn: EventListener = () => {
    if (aud.currentTime < end) return;
    if (isLoop) {
      try { aud.currentTime = start; } catch {}
    } else if (onEnd) {
      detachClipEnforcer(id);
      onEnd();
    } else {
      detachClipEnforcer(id);
      try { aud.pause(); aud.currentTime = 0; } catch {}
      aud.onended = null;
      endDucking(id);
      const n = new Set(playingState); n.delete(id); playingState = n;
      reassignCurrentTrackAfterStop(id);
      notify();
    }
  };
  clipEnforcers[id] = fn;
  aud.addEventListener("timeupdate", fn);
}
// Per-loop-audio fade timer handles so we can cancel mid-fade.
const fadeTimers: Record<string, number> = {};

function baseVolumeFor(s: SoundItem): number {
  return (s.volume / 100) * (masterVolState / 100);
}

function shouldDuck(s: SoundItem): boolean {
  return !!s.loop && duckEnabledState && activeDuckers.size > 0;
}

function targetVolumeFor(s: SoundItem): number {
  const base = baseVolumeFor(s);
  return shouldDuck(s) ? base * (duckFactorState / 100) : base;
}

function clearFade(id: string) {
  const t = fadeTimers[id];
  if (t != null) {
    clearInterval(t);
    delete fadeTimers[id];
  }
}

function fadeAudioVolume(id: string, target: number) {
  const aud = audioMap[id];
  if (!aud) return;
  clearFade(id);
  const start = aud.volume;
  const delta = target - start;
  if (Math.abs(delta) < 0.005) { aud.volume = target; return; }
  let step = 0;
  const stepMs = duckFadeMsState / DUCK_FADE_STEPS;
  fadeTimers[id] = window.setInterval(() => {
    step++;
    const t = Math.min(1, step / DUCK_FADE_STEPS);
    aud.volume = Math.max(0, Math.min(1, start + delta * t));
    if (step >= DUCK_FADE_STEPS) clearFade(id);
  }, stepMs);
}

function applyDuckToActiveLoops(ramp: boolean) {
  for (const id of playingState) {
    const s = soundsState.find((x) => x.id === id);
    if (!s || !s.loop) continue;
    const aud = audioMap[id];
    if (!aud) continue;
    const target = targetVolumeFor(s);
    if (ramp) fadeAudioVolume(id, target);
    else { clearFade(id); aud.volume = target; }
  }
}

function startDucking(forId: string) {
  if (!duckEnabledState) return;
  const wasEmpty = activeDuckers.size === 0;
  activeDuckers.add(forId);
  if (wasEmpty) applyDuckToActiveLoops(false);
}

function endDucking(forId: string) {
  if (!activeDuckers.delete(forId)) return;
  if (activeDuckers.size === 0) applyDuckToActiveLoops(true);
}

function notify() {
  subscribers.forEach((fn) => fn());
}

function hasAudioRef(s: SoundItem): boolean {
  return !!s.hasAudio || !!s.url;
}

function setSoundsInternal(next: SoundItem[]) {
  const prev = soundsState;
  soundsState = next;
  let nextPlaying = playingState;
  let playingChanged = false;
  const ensurePlayingMutable = () => {
    if (!playingChanged) {
      nextPlaying = new Set(playingState);
      playingChanged = true;
    }
  };
  const purged: string[] = [];
  for (const id of Object.keys(audioMap)) {
    const ns = next.find((s) => s.id === id);
    const ps = prev.find((s) => s.id === id);
    // Sound removed entirely → tear down the audio element.
    if (!ns) {
      detachClipEnforcer(id);
      clearLoopTiming(id);
      teardownVuAnalyser(id);
      try { audioMap[id].pause(); } catch {}
      delete audioMap[id];
      revokeAudioObjectUrl(id);
      endDucking(id);
      if (nextPlaying.has(id)) {
        ensurePlayingMutable();
        nextPlaying.delete(id);
      }
      purged.push(id);
      continue;
    }
    // Audio reference changed (re-bound or import replaced the blob) → drop
    // the cached <audio> so the next trigger rebuilds it from IndexedDB.
    const prevHas = ps ? hasAudioRef(ps) : false;
    const currHas = hasAudioRef(ns);
    if (prevHas !== currHas || (ps && ps.url !== ns.url)) {
      detachClipEnforcer(id);
      clearLoopTiming(id);
      teardownVuAnalyser(id);
      try { audioMap[id].pause(); } catch {}
      delete audioMap[id];
      revokeAudioObjectUrl(id);
      endDucking(id);
      if (nextPlaying.has(id)) {
        ensurePlayingMutable();
        nextPlaying.delete(id);
      }
      purged.push(id);
      continue;
    }
    const aud = audioMap[id];
    const wasLoop = aud.loop;
    aud.loop = !!ns.loop;
    clearFade(id);
    aud.volume = targetVolumeFor(ns);
    if (wasLoop && !ns.loop && nextPlaying.has(id)) {
      // Finalize elapsed into the session total before resetting currentTime.
      clearLoopTiming(id);
      try { aud.pause(); aud.currentTime = 0; } catch {}
      ensurePlayingMutable();
      nextPlaying.delete(id);
    }
  }
  if (playingChanged) playingState = nextPlaying;
  // Reconcile paused/current-track state for any torn-down sounds so the
  // NowPlaying bar never points at an id without a valid audio element.
  if (purged.length) {
    let pausedChanged = false;
    const p = new Set(pausedState);
    for (const id of purged) { if (p.delete(id)) pausedChanged = true; }
    if (pausedChanged) pausedState = p;
    if (currentTrackIdState && purged.includes(currentTrackIdState)) {
      if (bgmCurrentIdState && !purged.includes(bgmCurrentIdState)) setCurrentTrack(bgmCurrentIdState);
      else setCurrentTrack([...playingState, ...pausedState][0] ?? null);
    }
  }
  notify();
}

function setMasterVolInternal(v: number) {
  masterVolState = v;
  for (const [id, aud] of Object.entries(audioMap)) {
    const s = soundsState.find((x) => x.id === id);
    if (s) { clearFade(id); aud.volume = targetVolumeFor(s); }
  }
  notify();
}

function setSoundVolumeGlobal(id: string, volume: number) {
  const v = Math.max(0, Math.min(200, Math.round(volume)));
  const idx = soundsState.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const next = soundsState.slice();
  next[idx] = { ...next[idx], volume: v };
  setSoundsInternal(next);
  safeSaveSounds(next);
  window.dispatchEvent(new CustomEvent(SOUNDS_EVENT, { detail: next }));
}

function setSoundShortcutGlobal(id: string, key: string | undefined) {
  const next = soundsState.map(s => {
    if (s.id === id) return { ...s, shortcut: key };
    if (key && s.shortcut === key) return { ...s, shortcut: undefined };
    return s;
  });
  setSoundsInternal(next);
  safeSaveSounds(next);
  window.dispatchEvent(new CustomEvent(SOUNDS_EVENT, { detail: next }));
}

function setDuckEnabledInternal(v: boolean) {
  if (duckEnabledState === v) return;
  duckEnabledState = v;
  if (!v) {
    // Disabling while ducking → restore loops smoothly and clear duckers.
    const wasActive = activeDuckers.size > 0;
    activeDuckers.clear();
    if (wasActive) applyDuckToActiveLoops(true);
  } else if (activeDuckers.size > 0) {
    // Re-enabled with non-loop sounds still playing → re-duck.
    applyDuckToActiveLoops(false);
  }
  notify();
}

function setDuckFactorInternal(v: number) {
  const next = clampDuckFactor(v);
  if (duckFactorState === next) return;
  duckFactorState = next;
  // If loops are currently ducked, re-apply the new depth smoothly.
  if (duckEnabledState && activeDuckers.size > 0) applyDuckToActiveLoops(true);
  notify();
}

function setDuckFadeMsInternal(v: number) {
  const next = clampDuckFade(v);
  if (duckFadeMsState === next) return;
  duckFadeMsState = next;
  notify();
}

async function resolveAudioUrl(s: SoundItem): Promise<string | null> {
  if (s.hasAudio) {
    const url = await getAudioObjectUrl(s.id);
    if (url) return url;
    // Blob gone (IndexedDB cleared) — fall through to re-download below.
  }
  // Legacy fallback: a `blob:` URL stored by an older build.
  if (s.url) return s.url;
  // Cloud audio: lazy-download and cache on first play.
  if (s.cloudUrl) {
    try {
      const resp = await fetch(s.cloudUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        await putAudioBlob(s.id, blob);
        markSoundCached(s.id); // updates hasAudio=true in state + persists
        const cached = await getAudioObjectUrl(s.id);
        if (cached) return cached;
      }
    } catch {}
    // Network error or blob URL unavailable — stream directly as fallback.
    return s.cloudUrl;
  }
  return null;
}

async function triggerSoundGlobal(id: string, forceLoop = false, replay = false) {
  const s = soundsState.find((x) => x.id === id);
  if (!s) return;

  // Ensure AudioContext is running before playing.
  // Critical for background/minimized window playback: Chromium suspends the
  // AudioContext when the page is hidden. resume() reactivates it so sounds
  // connected via MediaElementAudioSourceNode → AudioContext are audible.
  if (vuCtx && vuCtx.state !== "running") {
    try { await vuCtx.resume(); } catch {}
  }

  const mv = masterVolState;
  // `forceLoop` lets the host-loop toggle play a non-loop sound on repeat
  // without mutating its stored config.
  const effLoop = !!s.loop || forceLoop;
  const url = await resolveAudioUrl(s);
  if (url) {
    let aud = audioMap[id];
    if (!aud) {
      aud = new Audio(url);
      audioMap[id] = aud;
      await applySinkTo(aud);
    }
    setupVuAnalyser(id, aud);
    if (effLoop) {
      aud.loop = true;
      if (!replay && (playingState.has(id) || pausedState.has(id))) {
        // Finalize elapsed into the session total *before* resetting currentTime,
        // otherwise the current (unfinished) cycle's playtime would be lost.
        clearFade(id);
        clearLoopTiming(id);
        try { aud.pause(); aud.currentTime = 0; } catch {}
        const n = new Set(playingState); n.delete(id); playingState = n;
        if (pausedState.has(id)) { const p = new Set(pausedState); p.delete(id); pausedState = p; }
        reassignCurrentTrackAfterStop(id);
      } else {
        clearFade(id);
        // ── loop 互斥：同一时间只允许播放一首循环音效（含 BGM/PK）。
        // 触发任何 loop 音效时，停止其他所有 loop 音效（BGM 之间也互斥，保证同时只播一首）。
        const loopIdsToStop = [
          ...Array.from(playingState),
          ...Array.from(pausedState),
        ].filter(oid => {
          if (oid === id) return false;
          const o = soundsState.find(x => x.id === oid);
          if (!o || !(o.loop || forceLoop)) return false;
          return true;
        });
        for (const oid of loopIdsToStop) {
          detachClipEnforcer(oid);
          clearLoopTiming(oid);
          const otherAud = audioMap[oid];
          if (otherAud) { try { otherAud.pause(); otherAud.currentTime = 0; } catch {} }
          if (playingState.has(oid)) { const np = new Set(playingState); np.delete(oid); playingState = np; }
          if (pausedState.has(oid)) { const pp = new Set(pausedState); pp.delete(oid); pausedState = pp; }
          if (bgmCurrentIdState === oid) bgmCurrentIdState = null;
          reassignCurrentTrackAfterStop(oid);
        }
        const loopTarget = targetVolumeFor(s);
        aud.currentTime = s.clipStart ?? 0;
        aud.play().catch(() => {});
        beginLoopTiming(id, aud);
        attachClipEnforcer(id, aud, s, true);
        startFadeIn(id, aud, loopTarget, s.fadeIn ?? 0);
        const n = new Set(playingState); n.add(id); playingState = n;
        setCurrentTrack(id);
      }
    } else if (playingState.has(id) && !replay) {
      // Already playing → a second click stops it (play/stop toggle).
      detachClipEnforcer(id);
      try { aud.pause(); aud.currentTime = 0; } catch {}
      aud.onended = null;
      endDucking(id);
      const n = new Set(playingState); n.delete(id); playingState = n;
      reassignCurrentTrackAfterStop(id);
    } else {
      // SE 短音效：独占主播音效频道，停掉其他所有非-BGM 声音（loop 或 短音效），保留 BGM 继续播放。
      for (const otherId of [...Array.from(playingState), ...Array.from(pausedState)]) {
        if (otherId === id) continue;
        const other = soundsState.find((x) => x.id === otherId);
        if (!other || other.type === "bgm" || other.type === "pk") continue; // 保留 BGM
        detachClipEnforcer(otherId);
        detachSoundFade(otherId);
        if (other.loop) { clearFade(otherId); clearLoopTiming(otherId); }
        const otherAud = audioMap[otherId];
        if (otherAud) { try { otherAud.pause(); otherAud.currentTime = 0; } catch {} otherAud.onended = null; }
        endDucking(otherId);
        if (playingState.has(otherId)) { const ns = new Set(playingState); ns.delete(otherId); playingState = ns; }
        if (pausedState.has(otherId)) { const ps = new Set(pausedState); ps.delete(otherId); pausedState = ps; }
        reassignCurrentTrackAfterStop(otherId);
      }
      aud.loop = false;
      if (pausedState.has(id)) { const p = new Set(pausedState); p.delete(id); pausedState = p; }
      aud.currentTime = s.clipStart ?? 0;
      const shortTarget = (s.volume / 100) * (mv / 100);
      startDucking(id);
      const shortStop = () => {
        detachClipEnforcer(id);
        endDucking(id);
        const n = new Set(playingState); n.delete(id); playingState = n;
        reassignCurrentTrackAfterStop(id);
        notify();
      };
      aud.onended = shortStop;
      attachClipEnforcer(id, aud, s, false);
      if (s.fadeOut != null && s.fadeOut > 0 && s.clipEnd != null) {
        attachFadeOutWatcher(id, aud, s.clipEnd, s.fadeOut, shortStop);
      }
      const n = new Set(playingState); n.add(id); playingState = n;
      setCurrentTrack(id);
      aud.play().then(() => {
        startFadeIn(id, aud, shortTarget, s.fadeIn ?? 0);
      }).catch(() => {
        detachClipEnforcer(id);
        endDucking(id);
        const nn = new Set(playingState); nn.delete(id); playingState = nn;
        reassignCurrentTrackAfterStop(id);
        notify();
      });
    }
  } else {
    // No audio bound → flash the playing indicator briefly so the UI still
    // gives feedback.
    if (effLoop) {
      const n = new Set(playingState);
      if (n.has(id) && !replay) { n.delete(id); clearLoopTiming(id); reassignCurrentTrackAfterStop(id); }
      else {
        // 无音频 loop 互斥：触发任何 loop 时停止其他所有 loop（含 BGM，保证同时只播一首）。
        for (const oid of [...Array.from(n), ...Array.from(pausedState)].filter(oid => {
          if (oid === id) return false;
          const o = soundsState.find(x => x.id === oid);
          if (!o || !(o.loop || forceLoop)) return false;
          return true;
        })) {
          n.delete(oid); clearLoopTiming(oid);
          if (pausedState.has(oid)) { const pp = new Set(pausedState); pp.delete(oid); pausedState = pp; }
          if (bgmCurrentIdState === oid) bgmCurrentIdState = null;
          reassignCurrentTrackAfterStop(oid);
        }
        n.add(id); beginLoopTiming(id, null); setCurrentTrack(id);
      }
      playingState = n;
    } else {
      const n = new Set(playingState); n.add(id); playingState = n;
      setCurrentTrack(id);
      setTimeout(() => {
        const nn = new Set(playingState); nn.delete(id); playingState = nn;
        reassignCurrentTrackAfterStop(id);
        notify();
      }, 500);
    }
  }
  notify();
}

// Pause the current track in place (keeps currentTime so it can resume).
function pauseSoundGlobal(id: string) {
  if (!playingState.has(id)) return;
  const aud = audioMap[id];
  try { aud?.pause(); } catch {}
  // A paused non-loop sound is silent, so it must release its BGM duck.
  endDucking(id);
  const n = new Set(playingState); n.delete(id); playingState = n;
  const p = new Set(pausedState); p.add(id); pausedState = p;
  notify();
}

// Resume a paused track from where it left off.
function resumeSoundGlobal(id: string) {
  if (!pausedState.has(id)) return;
  const aud = audioMap[id];
  const p = new Set(pausedState); p.delete(id); pausedState = p;
  const n = new Set(playingState); n.add(id); playingState = n;
  setCurrentTrack(id);
  // Re-duck only for non-loop sounds (loop tracks never duck). The BGM stream
  // (bgmCurrentIdState) is itself a loop-style track and must not duck.
  if (aud && !aud.loop && bgmCurrentIdState !== id) startDucking(id);
  try { aud?.play().catch(() => {}); } catch {}
  notify();
}

function pauseResumeGlobal(id: string) {
  if (playingState.has(id)) pauseSoundGlobal(id);
  else if (pausedState.has(id)) resumeSoundGlobal(id);
}

// Fully stop a single track (works for both normal sounds and BGM tracks).
function stopSoundGlobal(id: string) {
  // If this is the tracked BGM, clear the tracker so the controller knows it's gone.
  // Don't call stopBgmStream() exclusively — allow other BGM tracks to keep playing.
  if (bgmCurrentIdState === id) bgmCurrentIdState = null;
  detachClipEnforcer(id);
  const aud = audioMap[id];
  if (aud) { try { aud.pause(); aud.currentTime = 0; } catch {} aud.onended = null; }
  clearFade(id);
  clearLoopTiming(id);
  endDucking(id);
  if (playingState.has(id)) { const n = new Set(playingState); n.delete(id); playingState = n; }
  if (pausedState.has(id)) { const p = new Set(pausedState); p.delete(id); pausedState = p; }
  reassignCurrentTrackAfterStop(id);
  notify();
}

function seekSoundGlobal(id: string, seconds: number) {
  const aud = audioMap[id];
  if (!aud) return;
  try { aud.currentTime = Math.max(0, Math.min(seconds, aud.duration || seconds)); } catch {}
  notify();
}

// ---- BGM playlist controller functions ------------------------------------
function setBgmModeGlobal(mode: BgmMode) {
  bgmModeState = mode;
  try { setPersisted(BGM_MODE_KEY, mode); } catch {}
  // Reflect the new mode on the currently-loaded BGM stream immediately,
  // including re-attaching the clip enforcer so it matches the new mode.
  if (bgmCurrentIdState) {
    const id = bgmCurrentIdState;
    const aud = audioMap[id];
    if (aud) {
      if (mode === "single") {
        aud.loop = true;
        aud.onended = null;
        const s = soundsState.find(x => x.id === id);
        if (s) attachClipEnforcer(id, aud, s, true);
      } else if (mode === "stop") {
        aud.loop = false;
        aud.onended = () => stopBgmStream();
        const s = soundsState.find(x => x.id === id);
        if (s) {
          const clipStop = () => {
            aud.onended = null;
            try { aud.pause(); aud.currentTime = 0; } catch {}
            clearLoopTiming(id);
            if (playingState.has(id)) { const n = new Set(playingState); n.delete(id); playingState = n; }
            if (pausedState.has(id)) { const p = new Set(pausedState); p.delete(id); pausedState = p; }
            bgmCurrentIdState = null;
            notify();
          };
          attachClipEnforcer(id, aud, s, false, clipStop);
        }
      } else {
        aud.loop = false;
        aud.onended = () => bgmAdvanceGlobal();
        const s = soundsState.find(x => x.id === id);
        if (s) {
          const clipAdvance = () => {
            aud.onended = null;
            try { aud.pause(); aud.currentTime = 0; } catch {}
            clearLoopTiming(id);
            if (playingState.has(id)) { const n = new Set(playingState); n.delete(id); playingState = n; }
            if (pausedState.has(id)) { const p = new Set(pausedState); p.delete(id); pausedState = p; }
            bgmCurrentIdState = null;
            bgmAdvanceGlobal();
          };
          attachClipEnforcer(id, aud, s, false, clipAdvance);
        }
      }
    }
  }
  try { window.dispatchEvent(new Event(BGM_MODE_EVENT)); } catch {}
  notify();
}

function setBgmPlaylistGlobal(ids: string[]) {
  bgmPlaylist = [...ids];
}

// Stop whatever BGM is on the exclusive stream (finalizing its elapsed time).
function stopBgmStream() {
  const cur = bgmCurrentIdState;
  if (!cur) return;
  detachClipEnforcer(cur);
  clearFade(cur);
  clearLoopTiming(cur);
  const aud = audioMap[cur];
  if (aud) { try { aud.pause(); aud.currentTime = 0; } catch {} aud.onended = null; }
  if (playingState.has(cur)) { const n = new Set(playingState); n.delete(cur); playingState = n; }
  if (pausedState.has(cur)) { const p = new Set(pausedState); p.delete(cur); pausedState = p; }
  bgmCurrentIdState = null;
  reassignCurrentTrackAfterStop(cur);
}

// Start a BGM track on the exclusive stream according to the current mode.
async function playBgmGlobal(id: string, replay = false) {
  const s = soundsState.find((x) => x.id === id);
  if (!s) return;
  // Toggle: clicking a BGM track that is already playing/paused pauses/resumes it.
  // `replay` (category shortcut) forces a restart instead of toggling.
  if (!replay && (playingState.has(id) || pausedState.has(id))) {
    pauseResumeGlobal(id);
    return;
  }
  // ── 先发制人：await 前就宣示占据 BGM 频道 ──────────────────────────────────
  // resolveAudioUrl 是异步操作（IndexedDB 读取）。若在 await 期间另一首 BGM 也被触发，
  // 后者同样会在 await 前清掉前一首尚未进入 playingState 的轨道。
  // 解决方案：await 前就设 bgmCurrentIdState = id；await 返回后检查是否已被抢占，若是则中止。
  bgmCurrentIdState = id;
  // BGM 单例：启动新 BGM 前，先停掉所有其他正在播放/暂停的 BGM（bgm/pk 类型）。
  // 规则：背景音乐频道最多 1 首，点第二首先停第一首。
  const otherBgmIds = [...Array.from(playingState), ...Array.from(pausedState)].filter(oid => {
    if (oid === id) return false;
    const o = soundsState.find(x => x.id === oid);
    return o && (o.type === "bgm" || o.type === "pk");
  });
  for (const oid of otherBgmIds) {
    detachClipEnforcer(oid);
    clearFade(oid);
    detachSoundFade(oid);
    clearLoopTiming(oid);
    const otherAud = audioMap[oid];
    if (otherAud) { try { otherAud.pause(); otherAud.currentTime = 0; } catch {} otherAud.onended = null; }
    if (playingState.has(oid)) { const n = new Set(playingState); n.delete(oid); playingState = n; }
    if (pausedState.has(oid)) { const p = new Set(pausedState); p.delete(oid); pausedState = p; }
    // 注意：不在此处重置 bgmCurrentIdState（已在 await 前设为 id，重置会破坏抢占保护）。
    endDucking(oid);
  }
  const url = await resolveAudioUrl(s);
  // ── 并发保护：await 返回后检查是否被后发 BGM 抢占 ──────────────────────────
  // 若在 await 期间另一首 BGM 已设 bgmCurrentIdState 为自己的 id，则放弃本次播放。
  if (bgmCurrentIdState !== id) return;
  if (!url) {
    // No audio bound → flash indicator briefly, then clear so the stream does
    // not stay stuck as a permanently "playing" BGM track.
    const n = new Set(playingState); n.add(id); playingState = n;
    setCurrentTrack(id);
    notify();
    setTimeout(() => {
      if (bgmCurrentIdState !== id) return;
      bgmCurrentIdState = null;
      const nn = new Set(playingState); nn.delete(id); playingState = nn;
      reassignCurrentTrackAfterStop(id);
      notify();
    }, 500);
    return;
  }
  let aud = audioMap[id];
  if (!aud) { aud = new Audio(url); audioMap[id] = aud; await applySinkTo(aud); }
  // ── 第二次并发保护（applySinkTo 也是 async）────────────────────────────────
  if (bgmCurrentIdState !== id) return;
  setupVuAnalyser(id, aud);
  clearFade(id);
  if (pausedState.has(id)) { const p = new Set(pausedState); p.delete(id); pausedState = p; }
  aud.loop = bgmModeState === "single";
  aud.onended = bgmModeState === "single" ? null : () => bgmAdvanceGlobal();
  const bgmTarget = targetVolumeFor(s);
  try { aud.currentTime = s.clipStart ?? 0; } catch {}
  aud.play().then(() => {
    startFadeIn(id, aud, bgmTarget, s.fadeIn ?? 0);
  }).catch(() => {});
  beginLoopTiming(id, aud);
  // Single mode loops within the clip range; list/shuffle should advance at clipEnd.
  const bgmIsLoop = bgmModeState === "single";
  if (bgmIsLoop) {
    attachClipEnforcer(id, aud, s, true);
  } else {
    // Non-loop BGM: stop + clean up the current track cleanly before advancing,
    // then clear onended to prevent the natural end from triggering a second advance.
    const clipAdvance = () => {
      aud.onended = null;
      try { aud.pause(); aud.currentTime = 0; } catch {}
      clearLoopTiming(id);
      if (playingState.has(id)) { const n = new Set(playingState); n.delete(id); playingState = n; }
      if (pausedState.has(id)) { const p = new Set(pausedState); p.delete(id); pausedState = p; }
      bgmCurrentIdState = null;
      bgmAdvanceGlobal();
    };
    attachClipEnforcer(id, aud, s, false, clipAdvance);
    // Attach fade-out watcher for non-loop BGM with clipEnd + fadeOut set.
    if (s.fadeOut != null && s.fadeOut > 0 && s.clipEnd != null) {
      attachFadeOutWatcher(id, aud, s.clipEnd, s.fadeOut, clipAdvance);
    }
  }
  const n = new Set(playingState); n.add(id); playingState = n;
  setCurrentTrack(id);
  notify();
}

// Advance the BGM stream to the next track per the active mode.
function bgmAdvanceGlobal() {
  const cur = bgmCurrentIdState;
  const list = bgmPlaylist.filter((x) => soundsState.some((s) => s.id === x));
  if (!cur || list.length === 0) { stopBgmStream(); notify(); return; }
  // stop mode: play once then stop
  if (bgmModeState === "stop") { stopBgmStream(); notify(); return; }
  if (list.length === 1) { void playBgmGlobal(list[0]); return; }
  let nextId: string;
  if (bgmModeState === "shuffle") {
    const pool = list.filter((x) => x !== cur);
    nextId = pool[Math.floor(Math.random() * pool.length)] ?? cur;
  } else {
    const i = list.indexOf(cur);
    nextId = list[(i + 1 + list.length) % list.length];
  }
  // Finalize the just-finished track before loading the next one.
  clearLoopTiming(cur);
  if (playingState.has(cur)) { const n = new Set(playingState); n.delete(cur); playingState = n; }
  bgmCurrentIdState = null;
  void playBgmGlobal(nextId);
}

// Manually step the BGM stream forward (dir=1) or backward (dir=-1) per the
// active mode. Used by the 功能快捷键 上一首/下一首 actions; always restarts the
// target track (replay) rather than toggling.
function bgmStepGlobal(dir: 1 | -1) {
  const list = bgmPlaylist.filter((x) => soundsState.some((s) => s.id === x));
  if (list.length === 0) return;
  const cur = bgmCurrentIdState;
  if (!cur || list.length === 1) { void playBgmGlobal(list[0], true); return; }
  let nextId: string;
  if (bgmModeState === "shuffle") {
    const pool = list.filter((x) => x !== cur);
    nextId = pool[Math.floor(Math.random() * pool.length)] ?? cur;
  } else {
    const i = list.indexOf(cur);
    const base = i < 0 ? 0 : i;
    nextId = list[(base + dir + list.length) % list.length];
  }
  // 正确停掉当前 BGM 音频（包括 pause + currentTime=0），再播下一首
  stopBgmStream();
  void playBgmGlobal(nextId, true);
}

function stopAllGlobal() {
  for (const id of Object.keys(fadeTimers)) clearFade(id);
  for (const id of Object.keys(soundFadeTimers)) clearSoundFadeTimer(id);
  for (const id of Object.keys(soundFadeOutListeners)) detachFadeOutWatcher(id);
  for (const id of Object.keys(clipEnforcers)) detachClipEnforcer(id);
  // Finalize each loop's elapsed into the session total *before* resetting
  // currentTime so stop-all preserves the cumulative playtime.
  for (const id of playingState) clearLoopTiming(id);
  for (const id of pausedState) clearLoopTiming(id);
  Object.values(audioMap).forEach((a) => {
    try { a.pause(); a.currentTime = 0; a.onended = null; } catch {}
  });
  activeDuckers.clear();
  playingState = new Set();
  pausedState = new Set();
  bgmCurrentIdState = null;
  setCurrentTrack(null);
  notify();
}

/**
 * Mark a cloud sound's local blob as cached (hasAudio = true).
 * Called automatically by resolveAudioUrl after lazy-caching on first play.
 */
export function markSoundCached(id: string): void {
  const idx = soundsState.findIndex(s => s.id === id);
  if (idx < 0 || soundsState[idx].hasAudio) return;
  const next = soundsState.slice();
  next[idx] = { ...next[idx], hasAudio: true };
  setSoundsInternal(next);
  safeSaveSounds(next);
  window.dispatchEvent(new CustomEvent(SOUNDS_EVENT, { detail: next }));
}

export function invalidateAudioCache(ids: string[]) {
  if (!ids.length) return;
  for (const id of ids) {
    clearLoopTiming(id);
    const a = audioMap[id];
    if (a) {
      teardownVuAnalyser(id);
      try { a.pause(); } catch {}
      delete audioMap[id];
    }
    clearFade(id);
    revokeAudioObjectUrl(id);
  }
  const n = new Set(playingState);
  let changed = false;
  for (const id of ids) {
    if (n.delete(id)) changed = true;
  }
  if (changed) playingState = n;
  let pausedChanged = false;
  const p = new Set(pausedState);
  for (const id of ids) {
    if (p.delete(id)) pausedChanged = true;
  }
  if (pausedChanged) pausedState = p;
  if (bgmCurrentIdState && ids.includes(bgmCurrentIdState)) bgmCurrentIdState = null;
  if (currentTrackIdState && ids.includes(currentTrackIdState)) {
    if (bgmCurrentIdState && !ids.includes(bgmCurrentIdState)) setCurrentTrack(bgmCurrentIdState);
    else setCurrentTrack([...playingState, ...pausedState][0] ?? null);
  }
  let duckChanged = false;
  for (const id of ids) {
    if (activeDuckers.delete(id)) duckChanged = true;
  }
  if (duckChanged && activeDuckers.size === 0) applyDuckToActiveLoops(true);
  notify();
}

// Initialize cross-tab / cross-component listeners exactly once.
let listenersInited = false;
function initListeners() {
  if (listenersInited || typeof window === "undefined") return;
  listenersInited = true;
  window.addEventListener(SOUNDS_EVENT, (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (Array.isArray(detail)) setSoundsInternal(detail as SoundItem[]);
    else setSoundsInternal(loadSounds());
  });
  window.addEventListener(MASTER_VOL_EVENT, (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (typeof detail === "number") setMasterVolInternal(detail);
    else setMasterVolInternal(loadMasterVol());
  });
  window.addEventListener(DUCK_ENABLED_EVENT, (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (typeof detail === "boolean") setDuckEnabledInternal(detail);
    else setDuckEnabledInternal(loadDuckEnabled());
  });
  window.addEventListener(DUCK_FACTOR_EVENT, (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (typeof detail === "number") setDuckFactorInternal(detail);
    else setDuckFactorInternal(loadDuckFactor());
  });
  window.addEventListener(DUCK_FADE_EVENT, (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (typeof detail === "number") setDuckFadeMsInternal(detail);
    else setDuckFadeMsInternal(loadDuckFade());
  });
  window.addEventListener(SINK_EVENT, (e: Event) => {
    const detail = (e as CustomEvent).detail;
    sinkIdState = typeof detail === "string" ? detail : loadSinkId();
    void applySinkToAll();
    notify();
  });
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === SOUNDS_KEY) setSoundsInternal(loadSounds());
    else if (e.key === MASTER_VOL_KEY) setMasterVolInternal(loadMasterVol());
    else if (e.key === DUCK_ENABLED_KEY) setDuckEnabledInternal(loadDuckEnabled());
    else if (e.key === DUCK_FACTOR_KEY) setDuckFactorInternal(loadDuckFactor());
    else if (e.key === DUCK_FADE_KEY) setDuckFadeMsInternal(loadDuckFade());
    else if (e.key === SINK_KEY) { sinkIdState = loadSinkId(); void applySinkToAll(); notify(); }
  });

  // Cross-window sound sync via BroadcastChannel.
  // When mainWindow saves sounds (safeSaveSounds → BroadcastChannel.postMessage),
  // the hidden audioWindow picks up the change and re-registers global shortcuts.
  if (typeof BroadcastChannel !== "undefined") {
    const bc = new BroadcastChannel("jt_sounds_bc");
    bc.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "sounds" && Array.isArray(e.data.sounds)) {
        setSoundsInternal(e.data.sounds as SoundItem[]);
      }
    };
  }
}
initListeners();

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function useSoundEngine(options: Options = {}): SoundEngine {
  const { enableGlobalShortcuts = true } = options;

  const sounds = useSyncExternalStore(
    subscribe,
    () => soundsState,
    () => soundsState,
  );
  const masterVol = useSyncExternalStore(
    subscribe,
    () => masterVolState,
    () => masterVolState,
  );
  const duckEnabled = useSyncExternalStore(
    subscribe,
    () => duckEnabledState,
    () => duckEnabledState,
  );
  const duckFactor = useSyncExternalStore(
    subscribe,
    () => duckFactorState,
    () => duckFactorState,
  );
  const duckFadeMs = useSyncExternalStore(
    subscribe,
    () => duckFadeMsState,
    () => duckFadeMsState,
  );
  const audioSinkId = useSyncExternalStore(
    subscribe,
    () => sinkIdState,
    () => sinkIdState,
  );
  const playing = useSyncExternalStore(
    subscribe,
    () => playingState,
    () => playingState,
  );
  const paused = useSyncExternalStore(
    subscribe,
    () => pausedState,
    () => pausedState,
  );
  const currentTrackId = useSyncExternalStore(
    subscribe,
    () => currentTrackIdState,
    () => currentTrackIdState,
  );
  const bgmCurrentId = useSyncExternalStore(
    subscribe,
    () => bgmCurrentIdState,
    () => bgmCurrentIdState,
  );
  const bgmMode = useSyncExternalStore(
    subscribe,
    () => bgmModeState,
    () => bgmModeState,
  );

  const setMasterVol = useCallback((v: number) => {
    setMasterVolInternal(v);
    try { setPersisted(MASTER_VOL_KEY, String(v)); } catch {}
    window.dispatchEvent(new CustomEvent(MASTER_VOL_EVENT, { detail: v }));
  }, []);

  const setDuckEnabled = useCallback((v: boolean) => {
    setDuckEnabledInternal(v);
    try { setPersisted(DUCK_ENABLED_KEY, v ? "1" : "0"); } catch {}
    window.dispatchEvent(new CustomEvent(DUCK_ENABLED_EVENT, { detail: v }));
  }, []);

  const setDuckFactor = useCallback((v: number) => {
    const n = clampDuckFactor(v);
    setDuckFactorInternal(n);
    try { setPersisted(DUCK_FACTOR_KEY, String(n)); } catch {}
    window.dispatchEvent(new CustomEvent(DUCK_FACTOR_EVENT, { detail: n }));
  }, []);

  const setDuckFadeMs = useCallback((v: number) => {
    const n = clampDuckFade(v);
    setDuckFadeMsInternal(n);
    try { setPersisted(DUCK_FADE_KEY, String(n)); } catch {}
    window.dispatchEvent(new CustomEvent(DUCK_FADE_EVENT, { detail: n }));
  }, []);

  const setAudioSinkId = useCallback(async (id: string) => {
    sinkIdState = id;
    try { setPersisted(SINK_KEY, id); } catch {}
    await applySinkToAll();
    window.dispatchEvent(new CustomEvent(SINK_EVENT, { detail: id }));
    notify();
  }, []);

  const triggerSound = useCallback((id: string, forceLoop = false, replay = false) => { void triggerSoundGlobal(id, forceLoop, replay); }, []);
  const setSoundVolume = useCallback((id: string, volume: number) => { setSoundVolumeGlobal(id, volume); }, []);
  const setSoundShortcut = useCallback((id: string, key: string | undefined) => { setSoundShortcutGlobal(id, key); }, []);
  const stopAll = useCallback(() => stopAllGlobal(), []);
  const pauseResume = useCallback((id: string) => { pauseResumeGlobal(id); }, []);
  const stopSound = useCallback((id: string) => { stopSoundGlobal(id); }, []);
  const seekSound = useCallback((id: string, seconds: number) => { seekSoundGlobal(id, seconds); }, []);
  const getAudioElementCb = useCallback((id: string) => getAudioElement(id), []);
  const setBgmMode = useCallback((mode: BgmMode) => { setBgmModeGlobal(mode); }, []);
  const setBgmPlaylist = useCallback((ids: string[]) => { setBgmPlaylistGlobal(ids); }, []);
  const playBgm = useCallback((id: string, replay = false) => { void playBgmGlobal(id, replay); }, []);
  const bgmNext = useCallback(() => { bgmStepGlobal(1); }, []);
  const bgmPrev = useCallback(() => { bgmStepGlobal(-1); }, []);
  const startDuckingCb = useCallback((id: string = READING_DUCK_ID) => { startDucking(id); }, []);
  const endDuckingCb = useCallback((id: string = READING_DUCK_ID) => { endDucking(id); }, []);

  useEffect(() => {
    if (!enableGlobalShortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;

      // ── 全局快捷键（复合键：F1-F12 / Ctrl+N / Alt+N 等）────────────────
      // 优先检查，支持修饰键，切换式语义（再次按 = 停止，与字母键 replay 不同）。
      // 这组快捷键也是 Electron 桌面版 globalShortcut 注册的目标格式。
      const globalHit = soundsState.find(s => {
        if (!s.globalShortcut) return false;
        const parts = s.globalShortcut.split("+");
        const key = parts[parts.length - 1];
        const needsCtrl = parts.includes("Ctrl");
        const needsAlt = parts.includes("Alt");
        if (needsCtrl !== (e.ctrlKey || e.metaKey)) return false;
        if (needsAlt !== e.altKey) return false;
        if (/^F\d+$/.test(key)) return e.key === key;
        if (/^\d$/.test(key)) return e.key === key;
        return e.key.toUpperCase() === key || e.key === key;
      });
      if (globalHit) {
        e.preventDefault();
        // 全局快捷键用切换语义（与字母键 replay 不同）：再次按停止，已停止则播放。
        void triggerSoundGlobal(globalHit.id, false, false);
        return;
      }

      // ── 原有单字符快捷键（字母 / 空格，不含修饰键）────────────────────
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key === " " ? " " : e.key.length === 1 ? e.key.toLowerCase() : "";
      if (!k) return;
      const hit = soundsState.find(
        (s) => s.shortcut && s.shortcut.toLowerCase() === k,
      );
      if (hit) {
        // 注册模式（默认）会覆盖按键默认功能（preventDefault）；监听模式不覆盖。
        if (k !== " " && getPersisted("jt_shortcut_mode") !== "listen") e.preventDefault();
        // 字母键快捷键始终用 replay 语义：再次按同一个键不会停止音效，而是重新
        // 触发并保持继续播放（绝不切换为停止）。
        void triggerSoundGlobal(hit.id, false, true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enableGlobalShortcuts]);

  return { sounds, masterVol, setMasterVol, duckEnabled, setDuckEnabled, duckFactor, setDuckFactor, duckFadeMs, setDuckFadeMs, audioSinkId, setAudioSinkId, playing, paused, currentTrackId, triggerSound, setSoundVolume, setSoundShortcut, stopAll, pauseResume, stopSound, seekSound, getAudioElement: getAudioElementCb, bgmMode, setBgmMode, setBgmPlaylist, playBgm, bgmCurrentId, bgmNext, bgmPrev, startDucking: startDuckingCb, endDucking: endDuckingCb };
}

export function dispatchSoundsChange(sounds: SoundItem[]) {
  window.dispatchEvent(new CustomEvent(SOUNDS_EVENT, { detail: sounds }));
}

// Re-read all engine state from the persistence layer into the module-level
// store. Every `*State` above is computed at import time, which happens before
// `bootstrapPersist()` hydrates the IndexedDB-backed cache. Since these keys now
// live in IndexedDB (no synchronous localStorage copy after migration), those
// initial reads can be empty/default. Call this once bootstrap completes so the
// engine (and every `useSoundEngine` consumer) reflects the persisted library
// and playback params (总音量、闪避开关/压低/恢复时长、输出设备).
export function rehydrateSoundsFromPersist() {
  setSoundsInternal(loadSounds());
  setMasterVolInternal(loadMasterVol());
  setDuckEnabledInternal(loadDuckEnabled());
  setDuckFactorInternal(loadDuckFactor());
  setDuckFadeMsInternal(loadDuckFade());
  sinkIdState = loadSinkId();
  bgmModeState = loadBgmMode();
  void applySinkToAll();
  notify();
}

export function dispatchMasterVolChange(v: number) {
  window.dispatchEvent(new CustomEvent(MASTER_VOL_EVENT, { detail: v }));
}
