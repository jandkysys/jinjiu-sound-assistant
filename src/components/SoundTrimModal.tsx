import { useEffect, useRef, useState, useCallback } from "react";
import type { SoundItem } from "../lib/soundPack";
import { getAudioBlob } from "../lib/audioStore";

const NUM_BARS = 280;
const CANVAS_W = 560;
const CANVAS_H = 112;
const RULER_H = 18;
const HANDLE_HIT = 12;

/**
 * 解析用户手动输入的时间字符串。
 * 支持格式：m:ss.mmm、m:ss、ss.mmm、ss（秒）。
 * 返回秒数，无法解析时返回 null。
 */
function parseTimeInput(str: string): number | null {
  str = str.trim();
  // mm:ss.mmm 或 mm:ss
  const colonMatch = str.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (colonMatch) {
    const m  = parseInt(colonMatch[1]);
    const s  = parseInt(colonMatch[2]);
    const ms = colonMatch[3] ? parseInt(colonMatch[3].padEnd(3, "0")) : 0;
    if (s >= 60) return null;
    return m * 60 + s + ms / 1000;
  }
  // 纯秒数：83.456 或 83
  const secMatch = str.match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (secMatch) {
    const s  = parseInt(secMatch[1]);
    const ms = secMatch[2] ? parseInt(secMatch[2].padEnd(3, "0")) : 0;
    return s + ms / 1000;
  }
  return null;
}

function formatMs(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = Math.floor(s);
  const ms = Math.round((s - ss) * 1000);
  return `${m}:${ss.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

async function decodeWaveformPeaks(
  blob: Blob,
  numBars: number,
): Promise<{ peaks: Float32Array; duration: number }> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const actx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await actx.decodeAudioData(arrayBuffer);
  } finally {
    await actx.close().catch(() => {});
  }
  const data = decoded.getChannelData(0);
  const total = data.length;
  const peaks = new Float32Array(numBars);
  for (let i = 0; i < numBars; i++) {
    const start = Math.floor((i / numBars) * total);
    const end = Math.floor(((i + 1) / numBars) * total);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return { peaks, duration: decoded.duration };
}

interface Props {
  sound: SoundItem;
  onSave: (start: number, end: number, fadeIn: number, fadeOut: number) => void;
  onClear: () => void;
  onClose: () => void;
}

export default function SoundTrimModal({
  sound,
  onSave,
  onClear,
  onClose,
}: Props) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(sound.clipStart ?? 0);
  const [trimEnd, setTrimEnd] = useState<number>(sound.clipEnd ?? 0);
  const [playhead, setPlayhead] = useState(sound.clipStart ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [fadeIn, setFadeIn] = useState(sound.fadeIn ?? 0);
  const [fadeOut, setFadeOut] = useState(sound.fadeOut ?? 0);
  // 手动输入起点/终点时间：用 inputStr 跟踪正在编辑的文本，focused 防止拖拽时覆盖输入中的文字
  const [startInputStr, setStartInputStr] = useState(formatMs(sound.clipStart ?? 0));
  const [endInputStr, setEndInputStr]     = useState(formatMs(sound.clipEnd ?? 0));
  const [startFocused, setStartFocused]   = useState(false);
  const [endFocused, setEndFocused]       = useState(false);
  const [startInputErr, setStartInputErr] = useState(false);
  const [endInputErr, setEndInputErr]     = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const durationRef = useRef(0);
  const trimStartRef = useRef(trimStart);
  const trimEndRef = useRef(trimEnd);
  const isPlayingRef = useRef(false);

  useEffect(() => { trimStartRef.current = trimStart; }, [trimStart]);
  useEffect(() => { trimEndRef.current = trimEnd; }, [trimEnd]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // 拖拽/点击改变 trimStart/trimEnd 时同步刷新输入框显示（仅当输入框未被用户激活时）
  useEffect(() => { if (!startFocused) { setStartInputStr(formatMs(trimStart)); setStartInputErr(false); } }, [trimStart, startFocused]);
  useEffect(() => { if (!endFocused)   { setEndInputStr(formatMs(trimEnd));     setEndInputErr(false);   } }, [trimEnd, endFocused]);

  const stopPreview = useCallback(() => {
    const aud = audioRef.current;
    if (aud) {
      aud.pause();
      try { aud.currentTime = trimStartRef.current; } catch {}
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");

    (async () => {
      if (!sound.hasAudio) {
        setLoadError("此音效未绑定音频文件，无法显示波形");
        setLoading(false);
        return;
      }
      const blob = await getAudioBlob(sound.id);
      if (!blob) {
        setLoadError("音频文件读取失败，请确认音效已正确导入");
        setLoading(false);
        return;
      }
      if (cancelled) return;

      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;

      try {
        const { peaks, duration } = await decodeWaveformPeaks(blob, NUM_BARS);
        if (cancelled) return;
        setPeaks(peaks);
        setDuration(duration);
        durationRef.current = duration;
        const start = Math.max(0, Math.min(sound.clipStart ?? 0, duration));
        const end = sound.clipEnd != null
          ? Math.max(start, Math.min(sound.clipEnd, duration))
          : duration;
        setTrimStart(start);
        setTrimEnd(end);
        setPlayhead(start);
        trimStartRef.current = start;
        trimEndRef.current = end;
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setLoadError("波形解码失败：" + String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      stopPreview();
      const aud = audioRef.current;
      if (aud) {
        aud.pause();
        aud.src = "";
        audioRef.current = null;
      }
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [sound.id, stopPreview]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = CANVAS_W;
    const H = CANVAS_H;
    const waveH = H - RULER_H;

    ctx.clearRect(0, 0, W, H);

    const startX = duration > 0 ? (trimStart / duration) * W : 0;
    const endX = duration > 0 ? (trimEnd / duration) * W : W;
    const playX = duration > 0 ? (playhead / duration) * W : 0;

    const maxPeak = Math.max(0.01, ...peaks);
    const barW = W / NUM_BARS - 0.4;
    const cy = waveH / 2;

    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * W;
      const barH = (peaks[i] / maxPeak) * (waveH - 10) * 0.88;
      const inSel = x >= startX && x <= endX;
      ctx.fillStyle = inSel
        ? "rgba(130, 95, 200, 0.78)"
        : "rgba(175, 160, 135, 0.28)";
      ctx.fillRect(x, cy - barH / 2, Math.max(barW, 1), Math.max(barH, 2));
    }

    // Fade-in overlay: gradient from opaque-purple to transparent over fadeIn width
    if (fadeIn > 0 && duration > 0) {
      const fiW = Math.min((fadeIn / duration) * W, endX - startX);
      if (fiW > 1) {
        const grad = ctx.createLinearGradient(startX, 0, startX + fiW, 0);
        grad.addColorStop(0, "rgba(80, 55, 170, 0.52)");
        grad.addColorStop(1, "rgba(80, 55, 170, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(startX, 0, fiW, waveH);
      }
    }

    // Fade-out overlay: gradient from transparent to opaque-rose over fadeOut width
    if (fadeOut > 0 && duration > 0) {
      const foW = Math.min((fadeOut / duration) * W, endX - startX);
      if (foW > 1) {
        const grad = ctx.createLinearGradient(endX - foW, 0, endX, 0);
        grad.addColorStop(0, "rgba(160, 50, 75, 0)");
        grad.addColorStop(1, "rgba(160, 50, 75, 0.50)");
        ctx.fillStyle = grad;
        ctx.fillRect(endX - foW, 0, foW, waveH);
      }
    }

    const drawHandle = (x: number, color: string, dir: -1 | 1) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, waveH);
      ctx.stroke();
      ctx.fillStyle = color;
      const tip = 11 * dir;
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x + tip, 13);
      ctx.lineTo(x, 20);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, waveH - 6);
      ctx.lineTo(x + tip, waveH - 13);
      ctx.lineTo(x, waveH - 20);
      ctx.closePath();
      ctx.fill();
    };

    drawHandle(startX, "rgba(90, 75, 175, 0.92)", 1);
    drawHandle(endX, "rgba(170, 60, 90, 0.92)", -1);

    ctx.strokeStyle = "rgba(230, 182, 110, 0.90)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, waveH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(230, 182, 110, 0.80)";
    ctx.beginPath();
    ctx.moveTo(playX - 5, 0);
    ctx.lineTo(playX + 5, 0);
    ctx.lineTo(playX, 7);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(160, 140, 110, 0.28)";
    ctx.fillRect(0, waveH, W, RULER_H);

    const numTicks = 6;
    ctx.fillStyle = "rgba(80, 65, 45, 0.62)";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let t = 0; t <= numTicks; t++) {
      const tx = (t / numTicks) * W;
      const timeSec = duration > 0 ? (t / numTicks) * duration : 0;
      ctx.fillStyle = "rgba(130, 110, 85, 0.50)";
      ctx.fillRect(tx, waveH, 1, 5);
      ctx.fillStyle = "rgba(80, 65, 45, 0.65)";
      ctx.fillText(formatMs(timeSec), tx, H - 3);
    }
  }, [peaks, trimStart, trimEnd, playhead, duration, fadeIn, fadeOut]);

  useEffect(() => { draw(); }, [draw]);

  const xToTime = useCallback((x: number): number => {
    if (durationRef.current <= 0) return 0;
    return Math.max(0, Math.min(durationRef.current, (x / CANVAS_W) * durationRef.current));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const x = (e.clientX - rect.left) * scaleX;

    const startX = duration > 0 ? (trimStart / duration) * CANVAS_W : 0;
    const endX = duration > 0 ? (trimEnd / duration) * CANVAS_W : CANVAS_W;

    if (Math.abs(x - startX) <= HANDLE_HIT) {
      dragRef.current = "start";
    } else if (Math.abs(x - endX) <= HANDLE_HIT) {
      dragRef.current = "end";
    } else {
      const t = xToTime(x);
      setPlayhead(t);
      const aud = audioRef.current;
      // 无论是否在播放都 seek，这样"设为起点/终点"点击前无需先播放
      if (aud) {
        try { aud.currentTime = t; } catch {}
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [duration, trimStart, trimEnd, xToTime]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const x = (e.clientX - rect.left) * scaleX;
    const t = xToTime(x);
    if (dragRef.current === "start") {
      setTrimStart(Math.min(t, trimEndRef.current - 0.01));
    } else {
      setTrimEnd(Math.max(t, trimStartRef.current + 0.01));
    }
  }, [xToTime]);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const startPreview = useCallback(() => {
    if (!blobUrlRef.current) return;
    stopPreview();
    let aud = audioRef.current;
    if (!aud || aud.src !== blobUrlRef.current) {
      aud = new Audio(blobUrlRef.current);
      audioRef.current = aud;
    }
    const start = trimStartRef.current;
    const end = trimEndRef.current;
    aud.currentTime = start;
    aud.ontimeupdate = () => {
      if (!isPlayingRef.current) return;
      setPlayhead(aud!.currentTime);
      if (aud!.currentTime >= end) {
        aud!.pause();
        try { aud!.currentTime = start; } catch {}
        setPlayhead(start);
        setIsPlaying(false);
      }
    };
    aud.onended = () => {
      setPlayhead(start);
      setIsPlaying(false);
    };
    aud.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
  }, [stopPreview]);

  const pausePreview = useCallback(() => {
    const aud = audioRef.current;
    if (aud && isPlaying) {
      aud.pause();
      setIsPlaying(false);
    } else if (aud && !isPlaying) {
      aud.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  }, [isPlaying]);

  const selDuration = trimEnd - trimStart;

  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1200,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(110,100,95,0.26)", backdropFilter: "blur(9px)",
      }}
      onClick={onClose}
    >
      <div
        className="glass-strong"
        style={{ borderRadius: 16, padding: "20px 22px", width: 620, maxWidth: "96vw" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ color: "var(--gold)", fontSize: 15, fontWeight: "bold", marginBottom: 2 }}>
          剪辑音轨 · {sound.name}
        </div>
        <div style={{ color: "rgba(80,65,45,0.62)", fontSize: 12, marginBottom: 14 }}>
          拖动波形两端手柄框选要保留的片段 · 点波形可定位播放头 · 试听选区听效果 · 满意后保存剪辑
        </div>

        {loading && (
          <div style={{ height: CANVAS_H, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(247,241,232,0.55)", borderRadius: 10, marginBottom: 12, color: "rgba(130,110,85,0.65)", fontSize: 13 }}>
            正在解析波形…
          </div>
        )}

        {loadError && (
          <div style={{ height: CANVAS_H, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(247,241,232,0.55)", borderRadius: 10, marginBottom: 12, color: "rgba(180,80,80,0.80)", fontSize: 13, textAlign: "center", padding: "0 20px" }}>
            {loadError}
          </div>
        )}

        {!loading && !loadError && (
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            style={{
              width: "100%", height: CANVAS_H, display: "block",
              borderRadius: 10, marginBottom: 12,
              background: "rgba(247,241,232,0.55)",
              border: "1px solid rgba(210,195,170,0.30)",
              cursor: dragRef.current ? "ew-resize" : "crosshair",
              touchAction: "none",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        )}

        {!loading && !loadError && (
          <>
            <div style={{ ...row, marginBottom: 10 }}>
              <button
                className="btn gold-btn"
                style={{ minWidth: 90 }}
                onClick={startPreview}
              >
                ▶ 试听选区
              </button>
              <button
                className="btn"
                style={{ minWidth: 72 }}
                disabled={!isPlaying}
                onClick={pausePreview}
              >
                ⏸ 暂停
              </button>
              <button
                className="btn"
                style={{ minWidth: 64 }}
                onClick={stopPreview}
              >
                ■ 停止
              </button>
              <div style={{ flex: 1 }} />
              <div style={{ fontSize: 12, color: "rgba(80,65,45,0.60)", fontFamily: "monospace" }}>
                {formatMs(playhead)} / {formatMs(duration)}
              </div>
            </div>

            <div style={{
              display: "grid", gridTemplateColumns: "1fr auto 1fr",
              gap: 8, alignItems: "center", marginBottom: 12,
              background: "rgba(247,241,232,0.60)", borderRadius: 10,
              padding: "10px 14px",
              border: "1px solid rgba(210,195,170,0.25)",
            }}>
              <div>
                <div style={{ fontSize: 11, color: "rgba(90, 75, 175, 0.75)", marginBottom: 4, fontWeight: "bold" }}>起点</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {/* 手动输入框：支持 m:ss.mmm 或纯秒 */}
                  <input
                    type="text"
                    value={startInputStr}
                    onChange={e => {
                      setStartInputStr(e.target.value);
                      const parsed = parseTimeInput(e.target.value);
                      if (parsed !== null && parsed < trimEndRef.current - 0.01 && parsed >= 0 && parsed <= durationRef.current) {
                        setTrimStart(parsed);
                        setStartInputErr(false);
                      } else {
                        setStartInputErr(true);
                      }
                    }}
                    onFocus={() => setStartFocused(true)}
                    onBlur={() => { setStartFocused(false); setStartInputStr(formatMs(trimStart)); setStartInputErr(false); }}
                    onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    style={{
                      fontFamily: "monospace", fontSize: 13, width: "100%",
                      padding: "3px 8px", borderRadius: 6,
                      border: `1px solid ${startInputErr ? "rgba(200,80,80,0.60)" : "rgba(90,75,175,0.30)"}`,
                      background: startInputErr ? "rgba(250,235,235,0.80)" : "rgba(247,241,232,0.80)",
                      color: "rgba(80,65,45,0.90)", outline: "none",
                    }}
                    placeholder="0:00.000"
                    title="支持格式：m:ss.mmm 或 秒数（如 1:23.456 或 83.456）"
                  />
                  <button
                    className="btn"
                    style={{ fontSize: 11, padding: "3px 9px", borderColor: "rgba(90,75,175,0.30)", color: "rgba(90,75,175,0.85)" }}
                    disabled={playhead >= trimEnd - 0.01}
                    onClick={() => setTrimStart(playhead)}
                  >设为起点</button>
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "rgba(130,110,85,0.55)", marginBottom: 3 }}>选区时长</div>
                <div style={{ fontFamily: "monospace", fontSize: 13, color: "rgba(80,65,45,0.80)" }}>{formatMs(selDuration)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "rgba(170, 60, 90, 0.75)", marginBottom: 4, fontWeight: "bold" }}>终点</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end" }}>
                  <button
                    className="btn"
                    style={{ fontSize: 11, padding: "3px 9px", borderColor: "rgba(170,60,90,0.30)", color: "rgba(170,60,90,0.85)" }}
                    disabled={playhead <= trimStart + 0.01}
                    onClick={() => setTrimEnd(playhead)}
                  >设为终点</button>
                  {/* 手动输入框 */}
                  <input
                    type="text"
                    value={endInputStr}
                    onChange={e => {
                      setEndInputStr(e.target.value);
                      const parsed = parseTimeInput(e.target.value);
                      if (parsed !== null && parsed > trimStartRef.current + 0.01 && parsed <= durationRef.current) {
                        setTrimEnd(parsed);
                        setEndInputErr(false);
                      } else {
                        setEndInputErr(true);
                      }
                    }}
                    onFocus={() => setEndFocused(true)}
                    onBlur={() => { setEndFocused(false); setEndInputStr(formatMs(trimEnd)); setEndInputErr(false); }}
                    onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    style={{
                      fontFamily: "monospace", fontSize: 13, width: "100%",
                      padding: "3px 8px", borderRadius: 6, textAlign: "right",
                      border: `1px solid ${endInputErr ? "rgba(200,80,80,0.60)" : "rgba(170,60,90,0.30)"}`,
                      background: endInputErr ? "rgba(250,235,235,0.80)" : "rgba(247,241,232,0.80)",
                      color: "rgba(80,65,45,0.90)", outline: "none",
                    }}
                    placeholder="0:00.000"
                    title="支持格式：m:ss.mmm 或 秒数（如 1:23.456 或 83.456）"
                  />
                </div>
              </div>
            </div>

            <div style={{
              background: "rgba(247,241,232,0.60)", borderRadius: 10,
              padding: "10px 14px", marginBottom: 12,
              border: "1px solid rgba(210,195,170,0.25)",
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "rgba(80,55,170,0.80)", fontWeight: "bold", minWidth: 90 }}>
                  淡入时长
                </span>
                <input
                  type="range" min={0} max={3} step={0.05}
                  value={fadeIn}
                  onChange={e => setFadeIn(Number(e.target.value))}
                  style={{ flex: 1, accentColor: "rgba(80,55,170,0.75)" }}
                />
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "rgba(80,65,45,0.75)", minWidth: 36, textAlign: "right" }}>
                  {fadeIn.toFixed(2)}s
                </span>
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: "2px 7px" }}
                  onClick={() => setFadeIn(0)}
                >关</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "rgba(160,50,75,0.80)", fontWeight: "bold", minWidth: 90 }}>
                  淡出时长
                </span>
                <input
                  type="range" min={0} max={3} step={0.05}
                  value={fadeOut}
                  onChange={e => setFadeOut(Number(e.target.value))}
                  style={{ flex: 1, accentColor: "rgba(160,50,75,0.75)" }}
                />
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "rgba(80,65,45,0.75)", minWidth: 36, textAlign: "right" }}>
                  {fadeOut.toFixed(2)}s
                </span>
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: "2px 7px" }}
                  onClick={() => setFadeOut(0)}
                >关</button>
              </div>
            </div>

            <div style={{ ...row, justifyContent: "space-between" }}>
              <div style={{ ...row, gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => {
                    setTrimStart(0);
                    setTrimEnd(durationRef.current);
                    setPlayhead(0);
                    setFadeIn(0);
                    setFadeOut(0);
                  }}
                >重置选区</button>
                <button
                  className="btn danger-btn"
                  onClick={() => { onClear(); onClose(); }}
                >清除剪辑</button>
              </div>
              <button
                className="btn gold-btn"
                style={{ minWidth: 80 }}
                onClick={() => { onSave(trimStart, trimEnd, fadeIn, fadeOut); onClose(); }}
              >保存剪辑</button>
            </div>
          </>
        )}

        {(loading || loadError) && (
          <div style={{ ...row, justifyContent: "flex-end", marginTop: 10 }}>
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        )}
      </div>
    </div>
  );
}
