import { useState, useRef } from "react";
import { activationLogin, activationRedeemDirect, activationRegister, activationStatus } from "@/lib/apiClientStub";
import { setToken, getDeviceId, authHeader } from "@/lib/auth";
import type { MemberStatus } from "@/lib/memberStatus";

type Tab = "login" | "register" | "code";

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

function parseLoginError(err: unknown): string {
  if (isApiError(err)) {
    const msg = getErrMsg(err);
    if (msg.includes("not found") || msg.includes("不存在") || err.status === 404)
      return "账号不存在，请联系管理员";
    if (msg.includes("password") || msg.includes("密码") || err.status === 401)
      return "密码错误，请重新输入";
    if (msg) return msg;
  }
  return "登录失败，请检查网络后重试";
}

function parseCodeError(err: unknown): string {
  if (isApiError(err)) {
    const msg = getErrMsg(err);
    if (msg.includes("不存在") || err.status === 404) return "激活码不存在，请检查是否输入正确";
    if (msg.includes("已被使用") || err.status === 409) return "该激活码已被使用";
    if (msg.includes("过期") || err.status === 410) return "该激活码已过期";
    if (msg.includes("已被禁用") || err.status === 403) return "该激活码已被禁用";
    if (msg) return msg;
  }
  return "激活失败，请检查网络后重试";
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

async function resolveStatus(token: string): Promise<MemberStatus> {
  try {
    console.log("[金玖] resolveStatus: calling activationStatus...");
    const data = await activationStatus(authHeader(token));
    const isAdmin = data.isAdmin ?? false;
    console.log("[金玖] resolveStatus: ok, isAdmin=", isAdmin);
    try { localStorage.setItem("jt_is_admin_cache", isAdmin ? "1" : "0"); } catch {}
    return {
      username: data.username,
      membershipExpiresAt: data.membershipExpiresAt ?? null,
      memberActive: true,
      isAdmin,
    };
  } catch (err) {
    console.error("[金玖] resolveStatus: activationStatus threw:", err);
    const cached = localStorage.getItem("jt_is_admin_cache");
    return { memberActive: true, isAdmin: cached === "1" };
  }
}

export default function LoginPage({ onLogin }: { onLogin?: (status: MemberStatus) => void }) {
  const [tab, setTab] = useState<Tab>("code");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState("");

  const [code, setCode] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState("");
  const codeInputRef = useRef<HTMLInputElement>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setLoginError("请填写账号和密码");
      return;
    }
    setLoginLoading(true);
    setLoginError("");
    try {
      const data = await activationLogin({
        username: username.trim(),
        password,
        deviceId: getDeviceId(),
      });
      setToken(data.token);
      const status = await resolveStatus(data.token);
      onLogin?.(status);
    } catch (err) {
      setLoginError(parseLoginError(err));
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!regUsername.trim() || !regPassword.trim()) {
      setRegError("请填写账号和密码");
      return;
    }
    if (regUsername.trim().length < 2) {
      setRegError("账号至少 2 个字符");
      return;
    }
    if (regPassword.length < 6) {
      setRegError("密码至少 6 位");
      return;
    }
    if (regPassword !== regConfirm) {
      setRegError("两次密码不一致");
      return;
    }
    setRegLoading(true);
    setRegError("");
    try {
      await activationRegister({ username: regUsername.trim(), password: regPassword });
      const data = await activationLogin({
        username: regUsername.trim(),
        password: regPassword,
        deviceId: getDeviceId(),
      });
      setToken(data.token);
      const status = await resolveStatus(data.token);
      onLogin?.(status);
    } catch (err) {
      let msg = "注册失败，请稍后重试";
      if (isApiError(err) && err.status === 409) {
        msg = "该账号名已被注册，请换一个";
      } else if (isApiError(err) && err.status === 400) {
        msg = "账号至少 2 个字符，密码至少 6 位";
      }
      setRegError(msg);
    } finally {
      setRegLoading(false);
    }
  }

  async function handleRedeemDirect(e: React.FormEvent) {
    e.preventDefault();
    const raw = code.replace(/-/g, "");
    if (raw.length < 15) {
      setCodeError("请输入完整的激活码（格式：XJT-XXXX-XXXX-XXXX）");
      return;
    }
    setCodeLoading(true);
    setCodeError("");
    try {
      const data = await activationRedeemDirect({
        code,
        deviceId: getDeviceId(),
      });
      setToken(data.token);
      const status = await resolveStatus(data.token);
      onLogin?.(status);
    } catch (err) {
      const msg = parseCodeError(err);
      setCodeError(msg);
    } finally {
      setCodeLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 12,
    border: "1.5px solid rgba(230,182,110,0.45)",
    background: "rgba(255,253,248,0.85)",
    fontSize: 16,
    color: "#4A3060",
    outline: "none",
    fontFamily: "KaiTi, STKaiti, 楷体, serif",
    boxSizing: "border-box",
    transition: "border-color 0.18s",
  };

  const btnStyle = (loading: boolean): React.CSSProperties => ({
    marginTop: 4,
    width: "100%",
    padding: "14px 0",
    borderRadius: 50,
    border: "1.5px solid rgba(230,182,110,0.70)",
    background: loading
      ? "rgba(230,182,110,0.35)"
      : "linear-gradient(180deg, #FFF3DE 0%, #F5D9AA 100%)",
    color: loading ? "rgba(154,103,28,0.5)" : "#9A671C",
    fontSize: 17,
    fontWeight: 700,
    cursor: loading ? "not-allowed" : "pointer",
    letterSpacing: "0.08em",
    fontFamily: "KaiTi, STKaiti, 楷体, serif",
    transition: "all 0.18s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  });

  return (
    <div style={{
      position: "fixed", inset: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(135deg, #EDE8FF 0%, #F5F0FF 50%, #FFE8F6 100%)",
      fontFamily: "KaiTi, STKaiti, 楷体, serif",
    }}>
      <div style={{
        position: "absolute", top: "8%", left: "10%",
        width: 320, height: 320, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(168,85,247,0.12) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", bottom: "10%", right: "8%",
        width: 260, height: 260, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(236,72,153,0.10) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <div style={{
        background: "rgba(252,248,255,0.96)",
        backdropFilter: "blur(32px)",
        WebkitBackdropFilter: "blur(32px)",
        border: "1.5px solid rgba(255,255,255,0.85)",
        borderRadius: 24,
        boxShadow: "0 24px 64px rgba(80,50,120,0.16)",
        padding: "36px 40px 32px",
        width: "min(400px, 90vw)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        position: "relative",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 26 }}>🏅</span>
          <span style={{ fontSize: 26 }}>🏅</span>
        </div>
        <div style={{
          fontSize: 22, fontWeight: 800, letterSpacing: "0.08em",
          background: "linear-gradient(135deg, #E6B66E 0%, #C9883C 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          marginBottom: 4,
        }}>
          金玖音效助手
        </div>
        <div style={{
          fontSize: 13, color: "rgba(100,80,140,0.5)",
          marginBottom: 24, letterSpacing: "0.04em",
        }}>
          会员专属版
        </div>

        <div style={{
          display: "flex",
          width: "100%",
          borderRadius: 12,
          background: "rgba(168,85,247,0.07)",
          padding: 3,
          marginBottom: 24,
          gap: 3,
        }}>
          {([
            { key: "code" as Tab, label: "激活码登录", icon: "🔑" },
            { key: "login" as Tab, label: "账号登录", icon: "👤" },
            { key: "register" as Tab, label: "注册账号", icon: "✍️" },
          ] as const).map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => { setTab(key); setLoginError(""); setCodeError(""); setRegError(""); }}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 10,
                border: "none",
                background: tab === key ? "rgba(255,255,255,0.92)" : "transparent",
                boxShadow: tab === key ? "0 2px 8px rgba(80,50,120,0.10)" : "none",
                color: tab === key ? "#7C3AED" : "rgba(100,80,140,0.45)",
                fontSize: 13,
                fontWeight: tab === key ? 700 : 500,
                cursor: "pointer",
                fontFamily: "KaiTi, STKaiti, 楷体, serif",
                transition: "all 0.18s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </div>

        {tab === "code" && (
          <form onSubmit={handleRedeemDirect} style={{ width: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 13, color: "rgba(100,80,140,0.65)", paddingLeft: 4 }}>激活码</label>
              <input
                ref={codeInputRef}
                type="text"
                value={code}
                onChange={e => { setCode(formatCode(e.target.value)); setCodeError(""); }}
                placeholder="XJT-XXXX-XXXX-XXXX"
                maxLength={18}
                autoComplete="off"
                spellCheck={false}
                style={{
                  ...inputStyle,
                  fontSize: 18,
                  letterSpacing: "0.12em",
                  fontFamily: "'Courier New', Courier, monospace",
                  textAlign: "center",
                  border: `1.5px solid ${codeError ? "rgba(220,50,50,0.55)" : "rgba(230,182,110,0.45)"}`,
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: "rgba(100,80,140,0.45)", textAlign: "center", lineHeight: 1.6,
              padding: "8px 12px", background: "rgba(168,85,247,0.05)", borderRadius: 8, border: "1px solid rgba(168,85,247,0.10)" }}>
              输入管理员发放的激活码直接进入<br />
              <span style={{ color: "rgba(100,80,140,0.3)", fontSize: 11 }}>每次打开只需输一次，之后自动保持登录</span>
            </div>
            {codeError && (
              <div style={{ padding: "8px 12px", background: "rgba(220,50,50,0.08)", border: "1px solid rgba(220,50,50,0.22)",
                borderRadius: 8, fontSize: 13, color: "#DC2626", textAlign: "center" }}>
                {codeError}
              </div>
            )}
            <button type="submit" disabled={codeLoading} style={btnStyle(codeLoading)}>
              {codeLoading ? "验证中…" : <><span style={{ fontSize: 16 }}>✨</span>立即进入</>}
            </button>
          </form>
        )}

        {tab === "login" && (
          <form onSubmit={handleLogin} style={{ width: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 13, color: "rgba(100,80,140,0.65)", paddingLeft: 4 }}>账号</label>
              <input type="text" value={username} onChange={e => { setUsername(e.target.value); setLoginError(""); }}
                placeholder="请输入账号" autoComplete="username" style={inputStyle} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 13, color: "rgba(100,80,140,0.65)", paddingLeft: 4 }}>密码</label>
              <input type="password" value={password} onChange={e => { setPassword(e.target.value); setLoginError(""); }}
                placeholder="请输入密码" autoComplete="current-password" style={inputStyle} />
            </div>
            {loginError && (
              <div style={{ padding: "8px 12px", background: "rgba(220,50,50,0.08)", border: "1px solid rgba(220,50,50,0.22)",
                borderRadius: 8, fontSize: 13, color: "#DC2626", textAlign: "center" }}>
                {loginError}
              </div>
            )}
            <button type="submit" disabled={loginLoading} style={btnStyle(loginLoading)}>
              {loginLoading ? "登录中…" : <><span style={{ fontSize: 16 }}>👑</span>会员登录</>}
            </button>
          </form>
        )}

        {tab === "register" && (
          <form onSubmit={handleRegister} style={{ width: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 13, color: "rgba(100,80,140,0.65)", paddingLeft: 4 }}>账号</label>
              <input type="text" value={regUsername} onChange={e => { setRegUsername(e.target.value); setRegError(""); }}
                placeholder="至少 2 个字符" autoComplete="username" style={inputStyle} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 13, color: "rgba(100,80,140,0.65)", paddingLeft: 4 }}>密码</label>
              <input type="password" value={regPassword} onChange={e => { setRegPassword(e.target.value); setRegError(""); }}
                placeholder="至少 6 位" autoComplete="new-password" style={inputStyle} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 13, color: "rgba(100,80,140,0.65)", paddingLeft: 4 }}>确认密码</label>
              <input type="password" value={regConfirm} onChange={e => { setRegConfirm(e.target.value); setRegError(""); }}
                placeholder="再输一次密码" autoComplete="new-password" style={inputStyle} />
            </div>
            {regError && (
              <div style={{ padding: "8px 12px", background: "rgba(220,50,50,0.08)", border: "1px solid rgba(220,50,50,0.22)",
                borderRadius: 8, fontSize: 13, color: "#DC2626", textAlign: "center" }}>
                {regError}
              </div>
            )}
            <button type="submit" disabled={regLoading} style={btnStyle(regLoading)}>
              {regLoading ? "注册中…" : <><span style={{ fontSize: 16 }}>✍️</span>立即注册</>}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
