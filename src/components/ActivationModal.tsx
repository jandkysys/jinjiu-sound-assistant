import { useState, useRef, useEffect } from "react";
import { activationRedeem } from "@/lib/apiClientStub";
import { getDeviceId, authHeader } from "@/lib/auth";

interface Props {
  token: string;
  username: string;
  onSuccess: () => void;
  onClose?: () => void;
}

function formatCode(raw: string): string {
  const clean = raw.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 15);
  const parts: string[] = [];
  if (clean.length > 0) parts.push(clean.slice(0, 3));
  if (clean.length > 3) parts.push(clean.slice(3, 7));
  if (clean.length > 7) parts.push(clean.slice(7, 11));
  if (clean.length > 11) parts.push(clean.slice(11, 15));
  return parts.join("-");
}

function isApiError(err: unknown): err is { status: number; data: unknown } {
  return typeof err === "object" && err !== null && "status" in err;
}

function getErrMsg(err: unknown): string {
  if (!isApiError(err)) return "";
  const d = err.data;
  if (d && typeof d === "object" && "error" in d && typeof (d as { error?: unknown }).error === "string") {
    return (d as { error: string }).error;
  }
  return "";
}

function parseError(err: unknown): string {
  if (isApiError(err)) {
    const msg = getErrMsg(err);
    if (msg.includes("not found") || msg.includes("不存在")) return "激活码不存在，请检查是否输入正确";
    if (msg.includes("used") || msg.includes("已使用")) return "该激活码已被使用，无法重复激活";
    if (msg.includes("expired") || msg.includes("过期")) return "该激活码已过期";
    if (msg.includes("disabled") || msg.includes("已禁用")) return "该激活码已被禁用";
    if (msg.includes("device") || msg.includes("设备")) return "该激活码已绑定其他设备";
    if (msg) return msg;
    if (err.status === 400) return "激活码格式有误";
    if (err.status === 404) return "激活码不存在";
    if (err.status === 409) return "该激活码已被使用";
  }
  return "激活失败，请稍后重试";
}

export default function ActivationModal({ token, username, onSuccess, onClose }: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleCodeChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCode(formatCode(e.target.value));
    setError("");
  }

  async function handleActivate() {
    const raw = code.replace(/-/g, "");
    if (raw.length < 15) {
      setError("请输入完整的激活码（格式：XJT-XXXX-XXXX-XXXX）");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await activationRedeem(
        { code: code, deviceId: getDeviceId() },
        authHeader(token),
      );
      onSuccess();
    } catch (err) {
      setError(parseError(err));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleActivate();
    if (e.key === "Escape" && onClose) onClose();
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9000,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(60,40,90,0.38)",
      backdropFilter: "blur(6px)",
    }}>
      <div style={{
        background: "rgba(252,248,255,0.97)",
        backdropFilter: "blur(32px)",
        border: "1.5px solid rgba(230,182,110,0.55)",
        borderRadius: 20,
        boxShadow: "0 24px 64px rgba(80,50,120,0.22)",
        padding: "36px 40px 32px",
        width: "min(420px, 92vw)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        fontFamily: "KaiTi, STKaiti, 楷体, serif",
      }}>
        <div style={{ fontSize: 28, marginBottom: 6 }}>🔑</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#7C3AED", marginBottom: 4 }}>
          输入激活码
        </div>
        <div style={{ fontSize: 13, color: "rgba(100,80,140,0.62)", marginBottom: 24, textAlign: "center" }}>
          请输入管理员发放的激活码以激活会员
        </div>

        <div style={{
          background: "rgba(168,85,247,0.08)",
          border: "1px solid rgba(168,85,247,0.18)",
          borderRadius: 8, padding: "6px 14px",
          fontSize: 13, color: "rgba(100,80,140,0.7)",
          marginBottom: 18,
        }}>
          当前账号：<span style={{ color: "#7C3AED", fontWeight: 600 }}>{username}</span>
        </div>

        <input
          ref={inputRef}
          value={code}
          onChange={handleCodeChange}
          onKeyDown={handleKeyDown}
          placeholder="XJT-XXXX-XXXX-XXXX"
          maxLength={18}
          style={{
            width: "100%",
            padding: "12px 16px",
            borderRadius: 12,
            border: `1.5px solid ${error ? "rgba(220,50,50,0.55)" : "rgba(230,182,110,0.55)"}`,
            background: "rgba(255,253,248,0.9)",
            fontSize: 18,
            letterSpacing: "0.12em",
            fontFamily: "'Courier New', Courier, monospace",
            textAlign: "center",
            color: "#4A3060",
            outline: "none",
            boxSizing: "border-box",
          }}
        />

        {error && (
          <div style={{
            marginTop: 8,
            fontSize: 13,
            color: "#DC2626",
            textAlign: "center",
            lineHeight: 1.4,
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleActivate}
          disabled={loading}
          style={{
            marginTop: 20,
            width: "100%",
            padding: "13px 0",
            borderRadius: 50,
            border: "1.5px solid rgba(230,182,110,0.70)",
            background: loading
              ? "rgba(230,182,110,0.35)"
              : "linear-gradient(180deg, #FFF3DE 0%, #F5D9AA 100%)",
            color: loading ? "rgba(154,103,28,0.5)" : "#9A671C",
            fontSize: 16,
            fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
            letterSpacing: "0.06em",
            fontFamily: "KaiTi, STKaiti, 楷体, serif",
            transition: "all 0.18s",
          }}
        >
          {loading ? "激活中…" : "✨ 立即激活"}
        </button>

        <button
          onClick={onClose}
          style={{
            marginTop: 10,
            background: "none",
            border: "none",
            color: "rgba(100,80,140,0.45)",
            fontSize: 13,
            cursor: "pointer",
            padding: "4px 0",
          }}
        >
          联系管理员获取激活码
        </button>
      </div>
    </div>
  );
}
