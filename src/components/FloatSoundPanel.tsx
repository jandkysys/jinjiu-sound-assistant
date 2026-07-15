/**
 * FloatSoundPanel — 音效快捷键启动开关条
 *
 * 功能：
 * - 快捷键开启/关闭切换，持久化
 * - 全局键盘监听（开启后切换页面仍可触发音效）
 * - 可拖动位置（Pointer Events，支持触摸）——拖动把手区域（非按钮处）
 * - 有音效正在播放时显示「全部停止」按钮
 * - 右上角 × 关闭按钮 → 收起为右侧边缘小标签，点击可重新展开
 */
import {
  useState, useEffect, useRef, useCallback,
} from "react";
import { useSoundEngine } from "../lib/useSoundEngine";
import { comboFromEvent } from "../lib/funcShortcuts";
import { useIsMobile } from "../hooks/use-mobile";
import type { SoundItem } from "../lib/soundPack";

/* ─── 存储键 ──────────────────────────────────────────────────────── */
const FLOAT_POS_KEY       = "jt_float_panel_pos";
const FLOAT_SHORTCUTS_KEY = "jt_float_shortcuts_enabled";
const FLOAT_HIDDEN_KEY    = "jt_float_panel_hidden";

/* ─── 类型 ────────────────────────────────────────────────────────── */
interface PanelPos { x: number; y: number; }

/* ─── 工具函数 ────────────────────────────────────────────────────── */
function isBgSound(s: SoundItem) { return s.type === "bgm" || s.type === "pk"; }
function loadPos(): PanelPos {
  try {
    const s = localStorage.getItem(FLOAT_POS_KEY);
    if (s) { const p = JSON.parse(s) as PanelPos; if (typeof p.x === "number") return p; }
  } catch {}
  return { x: -1, y: 8 };
}
function savePos(p: PanelPos) {
  try { localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(p)); } catch {}
}
function clampPos(x: number, y: number, w: number, h: number): PanelPos {
  return {
    x: Math.max(0, Math.min(window.innerWidth  - w, x)),
    y: Math.max(0, Math.min(window.innerHeight - h, y)),
  };
}

/* ─── 主组件 ─────────────────────────────────────────────────────── */
export default function FloatSoundPanel({ standalone = false }: { standalone?: boolean }) {
  const isMobile = useIsMobile();

  /* 快捷键开关由 Electron 主进程提供运行期真值；每次启动初始关闭。 */
  const [floatShortcutsEnabled, setFloatShortcutsEnabled] = useState<boolean>(false);

  /* 隐藏状态 */
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem(FLOAT_HIDDEN_KEY) === "1"; } catch { return false; }
  });

  /* 面板位置 */
  const [pos, setPos] = useState<PanelPos>(loadPos);
  const panelRef  = useRef<HTMLDivElement>(null);
  const dragging  = useRef(false);
  const didDrag   = useRef(false);   // 区分点击和拖动（防误触关闭）
  const dragStart = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  /* 音效引擎 */
  const { sounds, playing, triggerSound, stopSound, stopAll } =
    useSoundEngine({ enableGlobalShortcuts: false });

  /* 供 effect 使用的 ref */
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;
  const triggerSoundRef = useRef(triggerSound);
  triggerSoundRef.current = triggerSound;
  const stopSoundRef = useRef(stopSound);
  stopSoundRef.current = stopSound;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  /* ─── 从 Electron 主进程初始化并监听运行期状态 ─────────────── */
  useEffect(() => {
    const api = window.electronAPI;
    void api?.getHotkeyStatus?.()
      .then(enabled => setFloatShortcutsEnabled(!!enabled))
      .catch(() => {});
    api?.onHotkeyStatusChanged?.((enabled) => {
      setFloatShortcutsEnabled(!!enabled);
    });
  }, []);

  /* ─── 持久化 + 通知 SoundAssistant 同步状态 ─────────────────── */
  useEffect(() => {
    try { localStorage.setItem(FLOAT_SHORTCUTS_KEY, floatShortcutsEnabled ? "1" : "0"); } catch {}
    // 通知同页面内的 SoundAssistant（主面板）同步 shortcutsEnabled 状态
    window.dispatchEvent(
      new CustomEvent("jt-float-shortcuts-change", { detail: { enabled: floatShortcutsEnabled } })
    );
  }, [floatShortcutsEnabled]);

  const handleHotkeyToggle = useCallback(() => {
    const next = !floatShortcutsEnabled;
    setFloatShortcutsEnabled(next);
    void window.electronAPI?.notifyHotkeyStatus?.(next);
  }, [floatShortcutsEnabled]);

  useEffect(() => {
    try { localStorage.setItem(FLOAT_HIDDEN_KEY, hidden ? "1" : "0"); } catch {}
  }, [hidden]);

  /* ─── 全局快捷键监听（capture 阶段，防与主面板双触） ─────────── */
  useEffect(() => {
    if (standalone && window.electronAPI?.isElectron) return;
    if (!floatShortcutsEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const hit = soundsRef.current.find(s => s.shortcut && s.shortcut === combo);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isBgSound(hit)) {
        for (const pid of Array.from(playingRef.current)) {
          const s = soundsRef.current.find(x => x.id === pid);
          if (s && isBgSound(s)) stopSoundRef.current(pid);
        }
        triggerSoundRef.current(hit.id, false, true);
      } else {
        triggerSoundRef.current(hit.id, false, true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [floatShortcutsEnabled, standalone]);

  /* ─── 拖动面板（Pointer Events）──────────────────────────────── */
  const resolveX = useCallback((rawX: number) => {
    if (rawX === -1) {
      const w = panelRef.current?.offsetWidth ?? 220;
      return Math.max(0, (window.innerWidth - w) / 2);
    }
    return rawX;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    didDrag.current  = false;
    const px = resolveX(pos.x);
    dragStart.current = { mx: e.clientX, my: e.clientY, px, py: pos.y };
  }, [pos, resolveX]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.mx;
    const dy = e.clientY - dragStart.current.my;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
    const nx = dragStart.current.px + dx;
    const ny = dragStart.current.py + dy;
    const w = panelRef.current?.offsetWidth  ?? 220;
    const h = panelRef.current?.offsetHeight ?? 40;
    setPos(clampPos(nx, ny, w, h));
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setPos(cur => { savePos(cur); return cur; });
  }, []);

  /* ─── 关闭 / 展开 ─────────────────────────────────────────────── */
  function handleHide() {
    if (standalone) {
      void window.electronAPI?.hideFloatWindow?.();
      return;
    }
    setHidden(true);
  }
  function handleShow() { setHidden(false); }

  /* ─── 派生数据 ────────────────────────────────────────────────── */
  const playCount = sounds.filter(s => playing.has(s.id)).length;

  /* ─── 实际渲染 X 坐标 ─────────────────────────────────────────── */
  const renderX = pos.x === -1
    ? `calc(50% - ${(panelRef.current?.offsetWidth ?? 220) / 2}px)`
    : `${pos.x}px`;

  if (isMobile && !standalone) return null;

  /* ─── 隐藏时：右侧边缘小标签 ──────────────────────────────────── */
  if (hidden && !standalone) {
    return (
      <div
        onClick={handleShow}
        title="点击展开音效快捷键面板"
        style={{
          position: "fixed",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          zIndex: 1200,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          padding: "10px 5px",
          background: "linear-gradient(180deg, rgba(255,253,248,0.97) 0%, rgba(250,246,238,0.95) 100%)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          border: "1px solid rgba(255,255,255,0.80)",
          borderRight: "none",
          borderRadius: "10px 0 0 10px",
          boxShadow: "-4px 0 16px rgba(115,100,85,0.16)",
          cursor: "pointer",
          userSelect: "none",
          transition: "all 0.18s",
        }}
      >
        <span style={{ fontSize: 16 }}>🎵</span>
        <span style={{
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          fontSize: 11,
          color: "rgba(140,110,70,0.75)",
          letterSpacing: "0.1em",
          fontFamily: "var(--app-font-sans, sans-serif)",
          lineHeight: 1.2,
        }}>
          快捷键
        </span>
        {floatShortcutsEnabled && (
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: "#dc2626",
            boxShadow: "0 0 5px rgba(220,38,38,0.75)",
          }} />
        )}
      </div>
    );
  }

  /* ─── 正常展示 ─────────────────────────────────────────────────── */
  return (
    <div
      ref={panelRef}
      className={`fsp-root${standalone ? " fsp-standalone" : ""}`}
      style={standalone ? {
        width: "100%",
        zIndex: 1200,
      } : {
        left: renderX,
        top: `${pos.y}px`,
        width: "auto",
        zIndex: 1200,
      }}
    >
      {/* ── 标题栏（拖动把手 + 按钮）─────────────────────────────── */}
      <div
        className="fsp-handle fsp-handle-pill"
        onPointerDown={standalone ? undefined : onPointerDown}
        onPointerMove={standalone ? undefined : onPointerMove}
        onPointerUp={standalone ? undefined : onPointerUp}
        onPointerCancel={standalone ? undefined : onPointerUp}
        data-tauri-drag-region
        style={{ cursor: dragging.current ? "grabbing" : "grab" }}
      >
        <span className="fsp-grip" title="拖动移动位置">⠿</span>
        <span className="fsp-title">金玖</span>
        {playCount > 0 && (
          <button className="fsp-hbtn" onClick={stopAll} title="全部停止">■</button>
        )}
        {/* 关闭按钮 */}
        <button
          className="fsp-hbtn fsp-hbtn-close"
          onClick={handleHide}
          title="收起面板（点击右侧标签可重新展开）"
        >×</button>
      </div>

      {/* ── 快捷键滑杆开关 ──────────────────────────────────────────── */}
      <div
        className="fsp-no-drag"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "7px 8px",
          background: "linear-gradient(180deg,rgba(250,246,238,0.96) 0%,rgba(248,243,234,0.92) 100%)",
          borderTop: "1px solid rgba(230,220,205,0.45)",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={handleHotkeyToggle}
      >
        <span style={{ fontSize: 12, color: "rgba(80,65,45,0.75)", whiteSpace: "nowrap" }}>
          快捷键
        </span>
        {/* 滑杆轨道 */}
        <div style={{
          position: "relative",
          width: 34,
          height: 20,
          borderRadius: 11,
          flexShrink: 0,
          background: floatShortcutsEnabled
            ? "linear-gradient(90deg,#E6B66E,#F0C57A)"
            : "rgba(190,175,155,0.40)",
          border: `1px solid ${floatShortcutsEnabled ? "rgba(230,182,110,0.65)" : "rgba(190,175,155,0.30)"}`,
          transition: "background 0.2s, border-color 0.2s",
        }}>
          {/* 滑块 */}
          <div style={{
            position: "absolute",
            top: 2,
            left: floatShortcutsEnabled ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: floatShortcutsEnabled ? "#fff" : "rgba(210,195,175,0.90)",
            boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
            transition: "left 0.2s",
          }} />
        </div>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: floatShortcutsEnabled ? "var(--gold)" : "rgba(140,120,95,0.55)",
          minWidth: 24,
          transition: "color 0.2s",
        }}>
          {floatShortcutsEnabled ? "开" : "关"}
        </span>
      </div>

    </div>
  );
}
