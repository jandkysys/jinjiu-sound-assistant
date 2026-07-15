/**
 * MIDI 时间码设置弹窗
 *
 * 功能：
 * - 检测 Web MIDI API 可用性，引导浏览器授权
 * - 列出并选择 MIDI 输入设备
 * - 实时显示收到的 MIDI 消息（Note On/Off、CC、MTC 时间码）
 * - 学习模式：按下 MIDI 键 → 绑定到选中的音效
 * - 管理 Note → Sound 绑定列表（增/删）
 * - 设置持久化到 localStorage（jt_midi_device_id + jt_midi_note_bindings）
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { SoundItem } from "../lib/soundPack";

const DEVICE_KEY   = "jt_midi_device_id";
const BINDINGS_KEY = "jt_midi_note_bindings";

interface Binding { note: number; soundId: string }
interface MidiMsg  { ts: number; label: string; raw: number[] }

interface Props {
  sounds: SoundItem[];
  onTrigger: (soundId: string) => void;
  onClose: () => void;
}

// MIDI note number → readable name (C-1 … G9)
function noteName(n: number): string {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}

function formatMtc(data: number[]): string | null {
  // MTC quarter-frame: 0xF1, then 1 data byte
  if (data[0] !== 0xF1 || data.length < 2) return null;
  return `MTC QF type=${(data[1] >> 4) & 0x7} val=${data[1] & 0xF}`;
}

function parseMidi(data: number[]): string {
  if (data.length === 0) return "空";
  const st = data[0];
  const ch = (st & 0xF) + 1;
  const type = st & 0xF0;
  if (st === 0xF1) return formatMtc(data) ?? `MTC QF ${data[1]}`;
  if (st === 0xF8) return "MIDI Clock";
  if (st === 0xFA) return "Start";
  if (st === 0xFB) return "Continue";
  if (st === 0xFC) return "Stop";
  if (type === 0x90 && data.length >= 3) {
    return data[2] > 0
      ? `Note On  ch${ch} ${noteName(data[1])}(${data[1]}) vel=${data[2]}`
      : `Note Off ch${ch} ${noteName(data[1])}(${data[1]})`;
  }
  if (type === 0x80 && data.length >= 3) return `Note Off ch${ch} ${noteName(data[1])}(${data[1]})`;
  if (type === 0xB0 && data.length >= 3) return `CC ch${ch} #${data[1]}=${data[2]}`;
  if (type === 0xC0 && data.length >= 2) return `Program Change ch${ch} #${data[1]}`;
  if (type === 0xE0 && data.length >= 3) return `Pitch Bend ch${ch} ${((data[2] << 7) | data[1]) - 8192}`;
  return data.map(b => b.toString(16).padStart(2,"0").toUpperCase()).join(" ");
}

function loadBindings(): Binding[] {
  try {
    const r = localStorage.getItem(BINDINGS_KEY);
    if (r) {
      const obj = JSON.parse(r) as Record<string, string>;
      return Object.entries(obj).map(([k, v]) => ({ note: Number(k), soundId: v }));
    }
  } catch {}
  return [];
}

function saveBindings(bindings: Binding[]) {
  const obj: Record<string, string> = {};
  for (const b of bindings) obj[String(b.note)] = b.soundId;
  localStorage.setItem(BINDINGS_KEY, JSON.stringify(obj));
}

export default function MidiSettingsModal({ sounds, onTrigger, onClose }: Props) {
  const [supported, setSupported]   = useState<boolean | null>(null);  // null=checking
  const [inputs, setInputs]         = useState<{ id: string; name: string }[]>([]);
  const [deviceId, setDeviceId]     = useState<string>(() => localStorage.getItem(DEVICE_KEY) ?? "");
  const [msgs, setMsgs]             = useState<MidiMsg[]>([]);
  const [bindings, setBindings]     = useState<Binding[]>(loadBindings);
  const [learnMode, setLearnMode]   = useState(false);
  const [learnSoundId, setLearnSoundId] = useState<string>("");
  const [errMsg, setErrMsg]         = useState<string>("");

  const accessRef  = useRef<MIDIAccess | null>(null);
  const deviceRef  = useRef(deviceId);
  deviceRef.current = deviceId;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const learnRef    = useRef(learnMode);
  learnRef.current  = learnMode;
  const learnSndRef = useRef(learnSoundId);
  learnSndRef.current = learnSoundId;
  const triggerRef  = useRef(onTrigger);
  triggerRef.current = onTrigger;
  const msgsRef     = useRef(msgs);
  msgsRef.current   = msgs;

  const addMsg = useCallback((label: string, raw: number[]) => {
    const entry: MidiMsg = { ts: Date.now(), label, raw };
    setMsgs(prev => [entry, ...prev].slice(0, 30));
  }, []);

  // 设置当前输入设备的 MIDI 消息处理器
  const bindDevice = useCallback((acc: MIDIAccess, id: string) => {
    for (const inp of acc.inputs.values()) {
      (inp as MIDIInput).onmidimessage = null;
    }
    if (!id) return;
    const inp = acc.inputs.get(id);
    if (!inp) return;
    (inp as MIDIInput).onmidimessage = (ev: MIDIMessageEvent) => {
      const data = Array.from(ev.data ?? []);
      if (!data.length) return;
      const status = data[0] & 0xF0;
      const isNoteOn = status === 0x90 && data.length >= 3 && data[2] > 0;
      const label = parseMidi(data);
      addMsg(label, data);

      if (isNoteOn) {
        const noteNum = data[1];
        if (learnRef.current && learnSndRef.current) {
          // 学习模式：将 MIDI note 绑定到选中音效
          setBindings(prev => {
            const next = prev.filter(b => b.note !== noteNum && b.soundId !== learnSndRef.current);
            const updated = [...next, { note: noteNum, soundId: learnSndRef.current }];
            saveBindings(updated);
            return updated;
          });
          setLearnMode(false);
          return;
        }
        // 正常触发：查找绑定
        const bound = bindingsRef.current.find(b => b.note === noteNum);
        if (bound) triggerRef.current(bound.soundId);
      }
    };
  }, [addMsg]);

  // 初始化 Web MIDI
  useEffect(() => {
    const nav = navigator as Navigator & {
      requestMIDIAccess?: (opts?: { sysex: boolean }) => Promise<MIDIAccess>;
    };
    if (!nav.requestMIDIAccess) {
      setSupported(false);
      return;
    }
    setSupported(null);
    let cancelled = false;
    nav.requestMIDIAccess({ sysex: false }).then(acc => {
      if (cancelled) return;
      setSupported(true);
      accessRef.current = acc;

      const refresh = () => {
        const list: { id: string; name: string }[] = [];
        acc.inputs.forEach(inp => list.push({ id: inp.id, name: inp.name ?? inp.id }));
        setInputs(list);
        // 如果当前选中设备仍存在，重新绑定（连接/断开事件后刷新）
        bindDevice(acc, deviceRef.current);
      };

      acc.onstatechange = refresh;
      refresh();
    }).catch(e => {
      if (!cancelled) {
        setSupported(false);
        setErrMsg(String(e));
      }
    });
    return () => { cancelled = true; };
  }, [bindDevice]);

  // 切换设备时重新绑定
  useEffect(() => {
    localStorage.setItem(DEVICE_KEY, deviceId);
    if (accessRef.current) bindDevice(accessRef.current, deviceId);
  }, [deviceId, bindDevice]);

  // 卸载时清除监听
  useEffect(() => {
    return () => {
      if (accessRef.current) {
        accessRef.current.inputs.forEach(inp => { (inp as MIDIInput).onmidimessage = null; });
      }
    };
  }, []);

  const removeBinding = (note: number) => {
    setBindings(prev => {
      const next = prev.filter(b => b.note !== note);
      saveBindings(next);
      return next;
    });
  };

  const soundName = (id: string) => sounds.find(s => s.id === id)?.name ?? `(已删除 ${id.slice(0,6)})`;

  const panelStyle: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 1300,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(110,100,95,0.30)", backdropFilter: "blur(10px)",
  };
  const boxStyle: React.CSSProperties = {
    borderRadius: 18, padding: "22px 24px",
    width: 640, maxWidth: "96vw", maxHeight: "90vh",
    overflowY: "auto",
    background: "rgba(247,241,232,0.97)",
    boxShadow: "0 16px 48px rgba(120,110,100,0.28), 0 2px 8px rgba(120,110,100,0.14)",
    border: "1.5px solid rgba(230,182,110,0.35)",
  };
  const sectionStyle: React.CSSProperties = {
    background: "rgba(247,241,232,0.70)", borderRadius: 12,
    padding: "12px 14px", marginBottom: 14,
    border: "1px solid rgba(210,195,170,0.28)",
  };
  const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
    padding: "5px 14px", borderRadius: 8, border: "1px solid rgba(210,195,170,0.50)",
    background: "rgba(247,241,232,0.80)", cursor: "pointer", fontSize: 13,
    color: "rgba(80,65,45,0.90)", ...extra,
  });

  return (
    <div style={panelStyle} onClick={onClose}>
      <div style={boxStyle} onClick={e => e.stopPropagation()}>
        {/* 标题 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: "bold", color: "var(--gold)" }}>🎹 MIDI 时间码设置</div>
            <div style={{ fontSize: 12, color: "rgba(80,65,45,0.55)", marginTop: 2 }}>
              Web MIDI API · Note 触发 · 实时监听 · 时间码接收
            </div>
          </div>
          <button onClick={onClose} style={btn({ padding: "4px 10px", fontSize: 15 })}>✕</button>
        </div>

        {/* 可用性状态 */}
        {supported === null && (
          <div style={{ ...sectionStyle, color: "rgba(130,110,85,0.70)", fontSize: 13 }}>
            正在请求 MIDI 访问权限…
          </div>
        )}
        {supported === false && (
          <div style={{ ...sectionStyle, background: "rgba(240,220,220,0.70)", color: "rgba(160,60,60,0.90)", fontSize: 13 }}>
            <b>此浏览器不支持 Web MIDI API</b>（需 Chrome / Edge）。<br />
            {errMsg && <span style={{ fontSize: 11, opacity: 0.75 }}>{errMsg}</span>}
            <div style={{ marginTop: 8, fontSize: 12, color: "rgba(120,60,60,0.75)" }}>
              桌面客户端版本（Tauri）将支持系统级 MIDI 输入，不受浏览器限制。
            </div>
          </div>
        )}

        {supported === true && (
          <>
            {/* 设备选择 */}
            <div style={sectionStyle}>
              <div style={{ fontSize: 12, color: "var(--gold)", fontWeight: "bold", marginBottom: 8 }}>MIDI 输入设备</div>
              {inputs.length === 0 ? (
                <div style={{ fontSize: 13, color: "rgba(130,110,85,0.65)" }}>
                  未检测到 MIDI 输入设备。请连接 MIDI 控制器或虚拟 MIDI 设备后刷新。
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div
                    onClick={() => setDeviceId("")}
                    style={{
                      padding: "7px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13,
                      background: !deviceId ? "rgba(230,182,110,0.22)" : "transparent",
                      border: !deviceId ? "1px solid rgba(230,182,110,0.50)" : "1px solid transparent",
                      color: "rgba(80,65,45,0.75)",
                    }}
                  >
                    不监听任何设备
                  </div>
                  {inputs.map(inp => (
                    <div
                      key={inp.id}
                      onClick={() => setDeviceId(inp.id)}
                      style={{
                        padding: "7px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13,
                        background: deviceId === inp.id ? "rgba(230,182,110,0.22)" : "transparent",
                        border: deviceId === inp.id ? "1px solid rgba(230,182,110,0.55)" : "1px solid transparent",
                        color: "rgba(80,65,45,0.90)",
                        display: "flex", alignItems: "center", gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 16 }}>🎛</span>
                      <span>{inp.name}</span>
                      {deviceId === inp.id && (
                        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--gold)" }}>● 已选中</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Note 绑定管理 */}
            <div style={sectionStyle}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "var(--gold)", fontWeight: "bold" }}>
                  MIDI Note → 音效 绑定
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {bindings.length > 0 && (
                    <button style={btn({ color: "rgba(180,80,80,0.85)" })}
                      onClick={() => { setBindings([]); saveBindings([]); }}>
                      清空绑定
                    </button>
                  )}
                </div>
              </div>

              {/* 学习模式 */}
              <div style={{ marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={learnSoundId}
                  onChange={e => setLearnSoundId(e.target.value)}
                  style={{
                    flex: 1, minWidth: 160, padding: "5px 10px", borderRadius: 8, fontSize: 13,
                    border: "1px solid rgba(210,195,170,0.50)", background: "rgba(247,241,232,0.90)",
                    color: "rgba(80,65,45,0.90)",
                  }}
                >
                  <option value="">选择要绑定的音效…</option>
                  {sounds.filter(s => s.hasAudio || !s.url).map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button
                  disabled={!deviceId || !learnSoundId}
                  onClick={() => setLearnMode(m => !m)}
                  style={btn({
                    minWidth: 100,
                    background: learnMode ? "rgba(231,76,60,0.16)" : "rgba(230,182,110,0.16)",
                    color:      learnMode ? "rgba(180,60,60,0.90)" : "var(--gold)",
                    borderColor: learnMode ? "rgba(231,76,60,0.40)" : "rgba(230,182,110,0.50)",
                    opacity: (!deviceId || !learnSoundId) ? 0.4 : 1,
                  })}
                >
                  {learnMode ? "⏹ 取消学习" : "🎯 按下 MIDI 键学习"}
                </button>
              </div>
              {learnMode && (
                <div style={{
                  padding: "8px 12px", borderRadius: 8, fontSize: 12,
                  background: "rgba(231,76,60,0.08)", border: "1px solid rgba(231,76,60,0.28)",
                  color: "rgba(160,60,60,0.90)", marginBottom: 8,
                  animation: "none",
                }}>
                  ⌨ 正在监听… 请按下 MIDI 控制器上的任意键，将绑定到「{soundName(learnSoundId)}」
                </div>
              )}

              {/* 绑定列表 */}
              {bindings.length === 0 ? (
                <div style={{ fontSize: 13, color: "rgba(130,110,85,0.55)", fontStyle: "italic" }}>
                  暂无绑定。选择音效后点击「学习」，按下 MIDI 键完成绑定。
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {bindings.sort((a, b) => a.note - b.note).map(b => (
                    <div key={b.note} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "5px 10px", borderRadius: 8,
                      background: "rgba(247,241,232,0.80)", border: "1px solid rgba(210,195,170,0.30)",
                    }}>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--gold)", minWidth: 70 }}>
                        {noteName(b.note)} ({b.note})
                      </span>
                      <span style={{ fontSize: 12, color: "rgba(80,65,45,0.80)", flex: 1 }}>
                        → {soundName(b.soundId)}
                      </span>
                      <button
                        onClick={() => { onTrigger(b.soundId); }}
                        style={btn({ padding: "2px 8px", fontSize: 11 })}
                      >▶ 试听</button>
                      <button
                        onClick={() => removeBinding(b.note)}
                        style={btn({ padding: "2px 8px", fontSize: 11, color: "rgba(180,80,80,0.85)" })}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 实时 MIDI 消息监听 */}
            <div style={sectionStyle}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: "var(--gold)", fontWeight: "bold" }}>
                  实时 MIDI 消息（含 MTC 时间码）
                </div>
                <button style={btn({ fontSize: 11, padding: "3px 8px" })}
                  onClick={() => setMsgs([])}>清空</button>
              </div>
              {!deviceId ? (
                <div style={{ fontSize: 12, color: "rgba(130,110,85,0.55)" }}>请先选择 MIDI 输入设备</div>
              ) : msgs.length === 0 ? (
                <div style={{ fontSize: 12, color: "rgba(130,110,85,0.55)", fontStyle: "italic" }}>
                  等待 MIDI 消息…（按下 MIDI 控制器按键可测试）
                </div>
              ) : (
                <div style={{
                  maxHeight: 160, overflowY: "auto",
                  fontFamily: "monospace", fontSize: 11,
                  display: "flex", flexDirection: "column", gap: 3,
                }}>
                  {msgs.map((m, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 10, alignItems: "baseline",
                      color: m.label.startsWith("Note On") ? "rgba(80,55,170,0.90)"
                           : m.label.startsWith("Note Off") ? "rgba(130,110,85,0.70)"
                           : m.label.startsWith("MTC") ? "rgba(60,140,80,0.90)"
                           : "rgba(80,65,45,0.80)",
                    }}>
                      <span style={{ opacity: 0.50, minWidth: 55 }}>
                        {new Date(m.ts).toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span>{m.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* 说明 */}
        <div style={{ fontSize: 11, color: "rgba(130,110,85,0.55)", lineHeight: 1.7 }}>
          <b>Web MIDI API</b> 需要 Chrome / Edge 浏览器，首次使用需授权。
          • Note On 消息触发绑定的音效 • MTC 时间码实时显示于消息列表 •
          桌面版（Tauri）将支持后台全局 MIDI 监听。
        </div>
      </div>
    </div>
  );
}
