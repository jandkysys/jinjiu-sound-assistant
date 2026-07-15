import { useState, useEffect, useRef } from "react";
import { API_BASE_URL } from "@/config/backend";

interface Props {
  onConfigured: () => void;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch { return false; }
}

const DEFAULT_SERVER_URL = API_BASE_URL;

export default function ServerSetup({ onConfigured }: Props) {
  const [url, setUrl] = useState(DEFAULT_SERVER_URL);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSave() {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (!trimmed) { setError("请输入服务器地址"); return; }
    if (!isValidUrl(trimmed)) { setError("地址格式有误，需以 https:// 或 http:// 开头"); return; }

    setTesting(true);
    setError("");
    setHint("正在测试连接…");

    try {
      // 保存地址
      await window.electronAPI!.setApiBase!(trimmed);

      // 测试连接（GET /api/activation/status，无 token → 401 也算通）
      const result = await window.electronAPI!.apiFetch!("/api/activation/status", {
        method: "GET",
        headers: {},
        body: null,
      });

      if (result.status === 0) {
        setError(`无法连接到服务器：${(result.data as { error?: string }).error ?? "网络错误"}`);
        setHint("");
        setTesting(false);
        return;
      }

      // status > 0 说明服务器有响应（401 Unauthorized 也正常）
      setHint("连接成功！");
      setTimeout(() => onConfigured(), 600);
    } catch (err) {
      setError("连接测试出错，请重试");
      setHint("");
      setTesting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave();
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(135deg, #EDE8FF 0%, #F5F0FF 50%, #FFE8F6 100%)",
      fontFamily: "KaiTi, STKaiti, 楷体, serif",
    }}>
      {/* 背景装饰 */}
      <div style={{
        position: "absolute", top: "8%", left: "10%",
        width: 280, height: 280, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(168,85,247,0.10) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", bottom: "10%", right: "8%",
        width: 240, height: 240, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(230,182,110,0.12) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <div style={{
        background: "rgba(252,248,255,0.97)",
        backdropFilter: "blur(32px)",
        border: "1.5px solid rgba(255,255,255,0.85)",
        borderRadius: 24,
        boxShadow: "0 24px 64px rgba(80,50,120,0.16)",
        padding: "40px 44px 36px",
        width: "min(480px, 90vw)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🔗</div>
        <div style={{
          fontSize: 22, fontWeight: 800, letterSpacing: "0.06em",
          background: "linear-gradient(135deg, #E6B66E 0%, #C9883C 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          marginBottom: 6,
        }}>
          首次配置
        </div>
        <div style={{
          fontSize: 14, color: "rgba(100,80,140,0.6)",
          marginBottom: 28, textAlign: "center", lineHeight: 1.7,
        }}>
          服务器地址已预填，直接点击「保存并连接」即可<br />
          <span style={{ fontSize: 12, color: "rgba(100,80,140,0.4)" }}>
            如需更换私有服务器，可修改下方地址
          </span>
        </div>

        <div style={{ width: "100%", marginBottom: 6 }}>
          <label style={{ fontSize: 13, color: "rgba(100,80,140,0.65)", display: "block", marginBottom: 6, paddingLeft: 2 }}>
            服务器地址
          </label>
          <input
            ref={inputRef}
            value={url}
            onChange={e => { setUrl(e.target.value); setError(""); setHint(""); }}
            onKeyDown={handleKeyDown}
            placeholder="https://yourapp.replit.app"
            disabled={testing}
            style={{
              width: "100%",
              padding: "13px 16px",
              borderRadius: 12,
              border: `1.5px solid ${error ? "rgba(220,50,50,0.55)" : "rgba(230,182,110,0.50)"}`,
              background: testing ? "rgba(255,253,248,0.5)" : "rgba(255,253,248,0.9)",
              fontSize: 15,
              color: "#4A3060",
              outline: "none",
              fontFamily: "'Courier New', Courier, monospace",
              boxSizing: "border-box",
              transition: "border-color 0.18s",
            }}
          />
        </div>

        {error && (
          <div style={{
            width: "100%",
            padding: "8px 12px",
            background: "rgba(220,50,50,0.07)",
            border: "1px solid rgba(220,50,50,0.20)",
            borderRadius: 8,
            fontSize: 13,
            color: "#DC2626",
            marginBottom: 4,
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {hint && (
          <div style={{
            width: "100%",
            padding: "8px 12px",
            background: "rgba(34,197,94,0.07)",
            border: "1px solid rgba(34,197,94,0.20)",
            borderRadius: 8,
            fontSize: 13,
            color: "#15803D",
            marginBottom: 4,
          }}>
            {hint}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={testing}
          style={{
            marginTop: 16,
            width: "100%",
            padding: "14px 0",
            borderRadius: 50,
            border: "1.5px solid rgba(230,182,110,0.70)",
            background: testing
              ? "rgba(230,182,110,0.35)"
              : "linear-gradient(180deg, #FFF3DE 0%, #F5D9AA 100%)",
            color: testing ? "rgba(154,103,28,0.5)" : "#9A671C",
            fontSize: 17,
            fontWeight: 700,
            cursor: testing ? "not-allowed" : "pointer",
            letterSpacing: "0.08em",
            fontFamily: "KaiTi, STKaiti, 楷体, serif",
            transition: "all 0.18s",
          }}
        >
          {testing ? "连接测试中…" : "✓  保存并连接"}
        </button>

        <div style={{ fontSize: 12, color: "rgba(100,80,140,0.35)", marginTop: 12, textAlign: "center", lineHeight: 1.5 }}>
          配置保存在本机，下次启动无需重新设置<br />
          需要更改时可在设置页面修改
        </div>
      </div>
    </div>
  );
}
