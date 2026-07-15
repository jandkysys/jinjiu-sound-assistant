/**
 * 连接诊断面板
 *
 * 显示：API 地址 / 账号 / 角色 / token / 三个测试按钮
 * 每个测试显示：完整请求地址、HTTP status、完整响应体
 * 控制台同步打印：[诊断] → 请求地址、← 响应
 */
import { useState } from "react";
import { getApiBase } from "@/lib/apiConfig";
import { getToken, getAdminToken } from "@/lib/auth";
import { useMemberStatus } from "@/lib/memberStatus";

// ─── 类型 ──────────────────────────────────────────────────────────────────────

type Phase = "idle" | "loading" | "ok" | "error";

interface TestResult {
  phase: Phase;
  requestUrl?: string;       // 实际发出的完整请求地址
  status?: number;           // HTTP 状态码
  body?: string;             // 完整响应体（不截断）
  error?: string;            // 网络异常信息
}

const IDLE: TestResult = { phase: "idle" };

// ─── 核心请求函数（附控制台日志） ─────────────────────────────────────────────

interface DiagResponse {
  ok: boolean;
  status: number;
  body: string;
  requestUrl: string;
}

async function diagFetch(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<DiagResponse> {
  const method  = init.method ?? "GET";
  const headers = init.headers ?? {};

  // 在 Electron 里，main.js 用 apiBaseUrl + path 构造完整 URL；
  // 这里也用同一个 base，让 UI 和控制台都能显示实际请求地址。
  const base        = getApiBase();
  const requestUrl  = base ? `${base}${path}` : `(相对路径)${path}`;

  console.log(`[诊断] → ${method} ${requestUrl}`, headers);

  // ── Electron IPC 路径 ──────────────────────────────────────────────────────
  const eAPI = typeof window !== "undefined"
    ? (window as Window & {
        electronAPI?: {
          apiFetch?: (
            u: string,
            o: { method: string; headers: Record<string, string>; body: null },
          ) => Promise<{ ok: boolean; status: number; data: unknown }>;
        };
      }).electronAPI
    : undefined;

  if (eAPI?.apiFetch) {
    let result: { ok: boolean; status: number; data: unknown };
    try {
      result = await eAPI.apiFetch(path, { method, headers, body: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[诊断] ← IPC 异常 ${requestUrl}:`, msg);
      throw new Error(`IPC 调用异常：${msg}`);
    }

    const body =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data, null, 2);

    console.log(`[诊断] ← HTTP ${result.status} ${requestUrl}\n`, body);
    return { ok: result.ok, status: result.status, body, requestUrl };
  }

  // ── Web 路径（浏览器直接 fetch）────────────────────────────────────────────
  const fetchUrl = base ? `${base}${path}` : path;
  console.log(`[诊断] → fetch ${fetchUrl}`);

  const resp = await fetch(fetchUrl, { method, headers });
  const body = await resp.text().catch(() => "(无法读取响应体)");

  console.log(`[诊断] ← HTTP ${resp.status} ${fetchUrl}\n`, body);
  return { ok: resp.ok, status: resp.status, body, requestUrl: fetchUrl };
}

// ─── UI 子组件 ─────────────────────────────────────────────────────────────────

function Badge({ phase }: { phase: Phase }) {
  const cfg: Record<Phase, { text: string; color: string }> = {
    idle:    { text: "待测",    color: "#999" },
    loading: { text: "请求中…", color: "#E6B66E" },
    ok:      { text: "✓ 成功",   color: "#4caf50" },
    error:   { text: "✗ 失败",   color: "#d44" },
  };
  const { text, color } = cfg[phase];
  return (
    <span style={{
      fontSize: 11, fontFamily: "sans-serif",
      color, background: `${color}1a`,
      borderRadius: 4, padding: "1px 7px",
      whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
}

function ResultBlock({ r }: { r: TestResult }) {
  if (r.phase === "idle" || r.phase === "loading") return null;

  const isErr = r.phase === "error";
  const bg    = isErr ? "rgba(212,68,68,0.06)"  : "rgba(76,175,80,0.06)";
  const border= isErr ? "rgba(212,68,68,0.25)"  : "rgba(76,175,80,0.25)";
  const hdr   = isErr ? "#c33" : "#2e7d32";

  return (
    <div style={{
      marginTop: 8,
      borderRadius: 8,
      border: `1px solid ${border}`,
      background: bg,
      overflow: "hidden",
      fontSize: 11,
      fontFamily: "monospace, sans-serif",
    }}>
      {/* 请求地址行 */}
      <div style={{
        padding: "5px 10px",
        borderBottom: `1px solid ${border}`,
        color: "#555",
        wordBreak: "break-all",
        lineHeight: 1.5,
      }}>
        <span style={{ color: "#999" }}>请求地址 </span>
        {r.requestUrl ?? "—"}
      </div>

      {/* status + 错误信息 */}
      <div style={{
        padding: "5px 10px",
        borderBottom: r.body ? `1px solid ${border}` : "none",
        color: hdr,
        fontWeight: 600,
      }}>
        {r.status != null ? `HTTP ${r.status}` : ""}
        {r.error ? `  ${r.error}` : ""}
      </div>

      {/* 响应体（完整，可滚动） */}
      {r.body && (
        <pre style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          maxHeight: 220,
          overflowY: "auto",
          color: isErr ? "#b33" : "#2a7a30",
          lineHeight: 1.5,
        }}>
          {r.body}
        </pre>
      )}
    </div>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export default function DiagnosticPanel() {
  const memberStatus = useMemberStatus();

  const [connR, setConnR] = useState<TestResult>(IDLE);
  const [permR, setPermR] = useState<TestResult>(IDLE);
  const [maniR, setManiR] = useState<TestResult>(IDLE);

  const apiBase  = getApiBase();
  const token    = getToken();
  const adminTok = getAdminToken();

  const username = memberStatus?.username;
  const isAdmin  = memberStatus?.isAdmin;
  const role     = isAdmin === true ? "admin" : isAdmin === false ? "user" : "undefined";
  const roleClr  = role === "admin" ? "#E6B66E" : role === "user" ? "#4caf50" : "#999";

  // ── 测试函数 ──────────────────────────────────────────────────────────────

  async function testConnect() {
    setConnR({ phase: "loading" });
    try {
      const r = await diagFetch("/api/cloud/library-version?app=sound_assistant");
      setConnR({
        phase: r.ok ? "ok" : "error",
        requestUrl: r.requestUrl,
        status: r.status,
        body: r.body,
      });
    } catch (e) {
      const base = getApiBase();
      setConnR({
        phase: "error",
        requestUrl: `${base}/api/cloud/library-version?app=sound_assistant`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function testPerm() {
    if (!token) {
      setPermR({ phase: "error", error: "无 token，请先登录" });
      return;
    }
    setPermR({ phase: "loading" });
    try {
      const r = await diagFetch("/api/activation/status", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      setPermR({
        phase: r.ok ? "ok" : "error",
        requestUrl: r.requestUrl,
        status: r.status,
        body: r.body,
      });
    } catch (e) {
      const base = getApiBase();
      setPermR({
        phase: "error",
        requestUrl: `${base}/api/activation/status`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function testManifest() {
    setManiR({ phase: "loading" });
    try {
      const r = await diagFetch("/api/cloud/manifest?app=sound_assistant");
      setManiR({
        phase: r.ok ? "ok" : "error",
        requestUrl: r.requestUrl,
        status: r.status,
        body: r.body,
      });
    } catch (e) {
      const base = getApiBase();
      setManiR({
        phase: "error",
        requestUrl: `${base}/api/cloud/manifest?app=sound_assistant`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── 样式常量 ──────────────────────────────────────────────────────────────

  const row: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "9px 0", borderBottom: "1px solid rgba(0,0,0,0.06)", gap: 8,
  };
  const lbl: React.CSSProperties = {
    fontSize: 13, color: "#777", whiteSpace: "nowrap", flexShrink: 0,
  };
  const val: React.CSSProperties = {
    fontSize: 11, fontFamily: "monospace, sans-serif",
    wordBreak: "break-all", textAlign: "right", flex: 1,
  };
  const tRow: React.CSSProperties = {
    display: "flex", flexDirection: "column",
    padding: "10px 0", borderBottom: "1px solid rgba(0,0,0,0.06)",
  };
  const tHdr: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
  };
  const btn: React.CSSProperties = {
    padding: "4px 14px", borderRadius: 8, cursor: "pointer",
    border: "1px solid rgba(230,182,110,0.45)",
    background: "rgba(230,182,110,0.08)",
    color: "#9a6c20", fontSize: 12, fontFamily: "sans-serif",
    whiteSpace: "nowrap",
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "0 0 4px" }}>

      {/* ── 静态状态 ── */}
      <div style={row}>
        <span style={lbl}>API 地址</span>
        <span style={{ ...val, color: apiBase ? "#1a7fcf" : "#d44", fontWeight: 600 }}>
          {apiBase || "⚠ 未配置（Electron 可能未完成 IPC 初始化）"}
        </span>
      </div>
      <div style={row}>
        <span style={lbl}>登录账号</span>
        <span style={{ ...val, color: username ? "#333" : "#999" }}>
          {username ?? "(未登录 / 加载中)"}
        </span>
      </div>
      <div style={row}>
        <span style={lbl}>当前角色</span>
        <span style={{ ...val, color: roleClr, fontWeight: 700 }}>{role}</span>
      </div>
      <div style={row}>
        <span style={lbl}>用户 Token</span>
        <span style={{ ...val, color: token ? "#4caf50" : "#d44" }}>
          {token
            ? `存在  ${token.slice(0, 20)}…（长度 ${token.length}）`
            : "不存在"}
        </span>
      </div>
      <div style={{ ...row, borderBottom: "none" }}>
        <span style={lbl}>管理员 Token</span>
        <span style={{ ...val, color: adminTok ? "#E6B66E" : "#bbb" }}>
          {adminTok
            ? `存在  ${adminTok.slice(0, 20)}…（长度 ${adminTok.length}）`
            : "不存在"}
        </span>
      </div>

      {/* ── 测试区 ── */}
      <div style={{
        marginTop: 14,
        background: "rgba(0,0,0,0.025)",
        borderRadius: 10,
        padding: "2px 12px 8px",
      }}>

        {/* 测试 1 */}
        <div style={tRow}>
          <div style={tHdr}>
            <span style={lbl}>测试连接云端</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Badge phase={connR.phase} />
              <button style={btn} disabled={connR.phase === "loading"}
                onClick={() => void testConnect()}>测试</button>
            </div>
          </div>
          <ResultBlock r={connR} />
        </div>

        {/* 测试 2 */}
        <div style={tRow}>
          <div style={tHdr}>
            <span style={lbl}>测试用户权限</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Badge phase={permR.phase} />
              <button style={btn} disabled={permR.phase === "loading"}
                onClick={() => void testPerm()}>测试</button>
            </div>
          </div>
          <ResultBlock r={permR} />
        </div>

        {/* 测试 3 */}
        <div style={{ ...tRow, borderBottom: "none" }}>
          <div style={tHdr}>
            <span style={lbl}>测试拉取音效列表</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Badge phase={maniR.phase} />
              <button style={btn} disabled={maniR.phase === "loading"}
                onClick={() => void testManifest()}>测试</button>
            </div>
          </div>
          <ResultBlock r={maniR} />
        </div>

      </div>
    </div>
  );
}
