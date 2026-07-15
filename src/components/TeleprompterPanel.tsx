import { useState, useEffect, useRef, useCallback } from "react";

interface TpData {
  script: string;
  fontSize: number;
  speed: number;
  opacity: number;
  protection: boolean;
  passthrough: boolean;
}

const DEFAULT_DATA: TpData = {
  script: "",
  fontSize: 32,
  speed: 1.0,
  opacity: 0.92,
  protection: false,
  passthrough: false,
};

interface Props {
  onClose: () => void;
}

declare global {
  interface Window {
    electronTP?: {
      open:           () => Promise<void>;
      close:          () => Promise<void>;
      toggle:         () => Promise<void>;
      isOpen:         () => Promise<boolean>;
      getData:        () => Promise<TpData | null>;
      saveData:       (data: Partial<TpData>) => Promise<void>;
      onStatusChanged:(cb: (open: boolean) => void) => void;
    };
  }
}

export default function TeleprompterPanel({ onClose }: Props) {
  const [data, setData] = useState<TpData>(DEFAULT_DATA);
  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [protectionSupported, setProtectionSupported] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasElectronTP = typeof window !== "undefined" && !!window.electronTP;

  useEffect(() => {
    if (!hasElectronTP) return;
    (async () => {
      const d = await window.electronTP!.getData().catch(() => null);
      if (d) setData(d);
      const open = await window.electronTP!.isOpen().catch(() => false);
      setIsOpen(open);
    })();
    window.electronTP!.onStatusChanged((open) => setIsOpen(open));
  }, [hasElectronTP]);

  const save = useCallback(async (patch: Partial<TpData>) => {
    const next = { ...data, ...patch };
    setData(next);
    if (!hasElectronTP) return;
    setSaving(true);
    try {
      await window.electronTP!.saveData(next);
    } finally {
      setSaving(false);
    }
  }, [data, hasElectronTP]);

  const handleOpen = async () => {
    if (!hasElectronTP) return;
    await window.electronTP!.open();
    setIsOpen(true);
  };

  const handleClose = async () => {
    if (!hasElectronTP) return;
    await window.electronTP!.close();
    setIsOpen(false);
  };

  const handleToggleProtection = async () => {
    const next = !data.protection;
    await save({ protection: next });
  };

  const handleTogglePassthrough = async () => {
    const next = !data.passthrough;
    await save({ passthrough: next });
  };

  const dot = (on: boolean, color = "#22c55e") => (
    <span style={{
      display: "inline-block",
      width: 7, height: 7,
      borderRadius: "50%",
      background: on ? color : "rgba(180,170,160,0.4)",
      boxShadow: on ? `0 0 5px ${color}` : "none",
      marginRight: 5,
      verticalAlign: "middle",
      transition: "background 0.2s",
    }} />
  );

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 1200,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.35)",
    backdropFilter: "blur(4px)",
  };

  const cardStyle: React.CSSProperties = {
    background: "rgba(247,241,232,0.97)",
    border: "1.5px solid rgba(230,182,110,0.4)",
    borderRadius: 16,
    padding: "20px 24px",
    width: 540,
    maxWidth: "90vw",
    boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: "rgba(60,50,40,0.75)",
    whiteSpace: "nowrap",
  };

  const btnBase: React.CSSProperties = {
    border: "1px solid rgba(200,180,140,0.5)",
    borderRadius: 7,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    transition: "all 0.15s",
    fontFamily: "inherit",
  };

  const btnGold: React.CSSProperties = {
    ...btnBase,
    background: "rgba(230,182,110,0.18)",
    color: "rgba(140,90,30,0.9)",
    borderColor: "rgba(230,182,110,0.5)",
  };

  const btnActive: React.CSSProperties = {
    ...btnBase,
    background: "rgba(34,197,94,0.18)",
    color: "rgba(20,120,50,0.9)",
    borderColor: "rgba(34,197,94,0.5)",
  };

  const btnDanger: React.CSSProperties = {
    ...btnBase,
    background: "rgba(220,60,60,0.12)",
    color: "rgba(180,30,30,0.9)",
    borderColor: "rgba(220,60,60,0.4)",
  };

  const btnNeutral: React.CSSProperties = {
    ...btnBase,
    background: "rgba(200,195,185,0.2)",
    color: "rgba(80,70,60,0.8)",
    borderColor: "rgba(200,195,185,0.45)",
  };

  return (
    <div style={panelStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={cardStyle}>
        {/* 标题行 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>📜</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: "rgba(100,70,30,0.9)" }}>悬浮提词器</span>
            <span style={{
              fontSize: 11, padding: "2px 7px", borderRadius: 4,
              background: isOpen ? "rgba(34,197,94,0.15)" : "rgba(200,195,185,0.3)",
              color: isOpen ? "rgba(20,120,50,0.9)" : "rgba(120,110,100,0.8)",
              border: `1px solid ${isOpen ? "rgba(34,197,94,0.4)" : "rgba(200,195,185,0.5)"}`,
            }}>
              {dot(isOpen)}{isOpen ? "已开启" : "已关闭"}
            </span>
          </div>
          <button style={btnNeutral} onClick={onClose}>✕ 关闭</button>
        </div>

        {!hasElectronTP && (
          <div style={{
            padding: "10px 14px", borderRadius: 8,
            background: "rgba(240,200,80,0.12)",
            border: "1px solid rgba(240,200,80,0.35)",
            fontSize: 12, color: "rgba(120,90,20,0.85)",
          }}>
            ⚠️ 仅限 Windows 客户端（Electron）使用，网页版无法开启悬浮窗。
          </div>
        )}

        {/* 脚本编辑 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>台词脚本 <span style={{ opacity: 0.6, fontSize: 11 }}>（每行一句，空行为间隔）</span></span>
          <textarea
            ref={textareaRef}
            value={data.script}
            onChange={e => setData(d => ({ ...d, script: e.target.value }))}
            onBlur={() => save({ script: data.script })}
            placeholder={"在这里粘贴或输入台词...\n每行一句话\n空行为停顿间隔"}
            style={{
              width: "100%", height: 120,
              resize: "vertical",
              padding: "8px 10px",
              borderRadius: 8,
              border: "1.5px solid rgba(200,180,140,0.5)",
              background: "rgba(255,252,248,0.9)",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: "inherit",
              color: "rgba(60,50,40,0.9)",
              outline: "none",
            }}
          />
        </div>

        {/* 字号 + 速度 */}
        <div style={rowStyle}>
          <span style={labelStyle}>字号</span>
          <button style={btnNeutral} onClick={() => save({ fontSize: Math.max(16, data.fontSize - 2) })}>A－</button>
          <span style={{ fontSize: 13, minWidth: 28, textAlign: "center", color: "rgba(60,50,40,0.9)" }}>{data.fontSize}</span>
          <button style={btnNeutral} onClick={() => save({ fontSize: Math.min(72, data.fontSize + 2) })}>A＋</button>

          <div style={{ width: 1, height: 20, background: "rgba(200,180,140,0.4)" }} />

          <span style={labelStyle}>滚速</span>
          <button style={btnNeutral} onClick={() => save({ speed: Math.max(0.1, +(data.speed - 0.1).toFixed(1)) })}>－</button>
          <span style={{ fontSize: 13, minWidth: 36, textAlign: "center", color: "rgba(60,50,40,0.9)", fontVariantNumeric: "tabular-nums" }}>{data.speed.toFixed(1)}×</span>
          <button style={btnNeutral} onClick={() => save({ speed: Math.min(5.0, +(data.speed + 0.1).toFixed(1)) })}>＋</button>

          <div style={{ width: 1, height: 20, background: "rgba(200,180,140,0.4)" }} />

          <span style={labelStyle}>透明度</span>
          <input
            type="range" min={10} max={100} value={Math.round(data.opacity * 100)}
            onChange={e => setData(d => ({ ...d, opacity: +e.target.value / 100 }))}
            onMouseUp={() => save({ opacity: data.opacity })}
            style={{ width: 80, accentColor: "#E6B66E" }}
          />
          <span style={{ fontSize: 12, color: "rgba(60,50,40,0.7)", width: 32 }}>{Math.round(data.opacity * 100)}%</span>
        </div>

        {/* 防采集 + 穿透 */}
        <div style={rowStyle}>
          <button
            style={data.protection ? btnActive : btnGold}
            onClick={handleToggleProtection}
            title="开启后 OBS/录屏软件采集不到该悬浮窗（Windows 专属功能）"
          >
            {dot(data.protection, "#22c55e")}🔒 防采集 {data.protection ? "已开" : "已关"}
          </button>

          <button
            style={data.passthrough ? btnActive : btnNeutral}
            onClick={handleTogglePassthrough}
            title="开启后鼠标点击穿透提词窗，可正常操作背后的直播软件。穿透时请用全局快捷键控制。"
          >
            {dot(data.passthrough, "#60a5fa")}👻 穿透模式 {data.passthrough ? "已开" : "已关"}
          </button>

          {!protectionSupported && (
            <span style={{ fontSize: 11, color: "rgba(180,80,30,0.8)" }}>
              ⚠️ 防采集仅支持 Windows
            </span>
          )}
        </div>

        {/* 全局快捷键说明 */}
        <div style={{
          padding: "8px 12px", borderRadius: 8,
          background: "rgba(230,182,110,0.08)",
          border: "1px solid rgba(230,182,110,0.25)",
          fontSize: 11, color: "rgba(100,80,50,0.8)",
          lineHeight: 1.8,
        }}>
          <strong style={{ fontSize: 12 }}>全局快捷键（直播中可用）</strong><br />
          <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>Ctrl+Alt+Space</code> 播放/暂停 &nbsp;
          <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>Ctrl+Alt+↑</code> 上一句 &nbsp;
          <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>Ctrl+Alt+↓</code> 下一句<br />
          <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>Ctrl+Alt+H</code> 显示/隐藏 &nbsp;
          <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>Ctrl+Alt+P</code> 切换穿透 &nbsp;
          <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>Ctrl+Alt+G</code> 切换防采集
        </div>

        {/* 操作按钮 */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          {saving && <span style={{ fontSize: 12, color: "rgba(120,100,60,0.7)", alignSelf: "center" }}>保存中…</span>}
          {isOpen ? (
            <>
              <button style={btnDanger} onClick={handleClose} disabled={!hasElectronTP}>关闭悬浮窗</button>
              <button style={btnGold} onClick={() => save({ script: data.script })} disabled={!hasElectronTP}>更新台词</button>
            </>
          ) : (
            <button
              style={{
                ...btnBase,
                background: "rgba(230,182,110,0.25)",
                color: "rgba(110,70,20,0.95)",
                borderColor: "rgba(230,182,110,0.6)",
                padding: "6px 18px",
                fontWeight: 600,
                fontSize: 13,
              }}
              onClick={handleOpen}
              disabled={!hasElectronTP}
            >
              📜 开启悬浮提词
            </button>
          )}
        </div>

        {/* 副屏提示 */}
        <div style={{ fontSize: 11, color: "rgba(120,100,70,0.6)", textAlign: "center" }}>
          提词窗内右上角「⊞副屏」可移至第二显示器 &nbsp;·&nbsp; 「🔒防采集」仅 Windows 10/11 有效<br />
          若防采集失败，建议将提词器放在第二屏或手机/平板上遥控
        </div>
      </div>
    </div>
  );
}
