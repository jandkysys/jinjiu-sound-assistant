import { useState, useEffect } from "react";
import { Router, Route, Switch, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import SoundAssistant from "@/pages/SoundAssistant";
import SettingsPage from "@/pages/SettingsPage";
import ManagePage from "@/pages/ManagePage";
import LoginPage from "@/pages/LoginPage";
import FloatSoundPanel from "@/components/FloatSoundPanel";
import BottomTabBar from "@/components/BottomTabBar";
import ServerSetup from "@/components/ServerSetup";
import AudioWorker from "@/components/AudioWorker";
import { setRuntimeApiBase, getApiBase } from "@/lib/apiConfig";
import { initTheme } from "@/lib/theme";
import { activationStatus } from "@/lib/apiClientStub";
import { getToken, setToken, clearToken, authHeader, setAdminToken, clearAdminToken } from "@/lib/auth";
import { MemberStatusProvider, type MemberStatus } from "@/lib/memberStatus";
import { PWAInstallPrompt } from "@/components/PWAInstallPrompt";
import { API_BASE_URL } from "@/config/backend";

const isElectronEnv = typeof window !== "undefined" && "electronGS" in window;
const isAudioWorker = typeof window !== "undefined" && !!window.electronAPI?.isAudioWorker;
const isFloatPanel = typeof window !== "undefined" && !!window.electronAPI?.isFloatPanel;

function FloatPanelPage() {
  useEffect(() => {
    const root = document.getElementById("root");
    document.documentElement.classList.add("float-panel-page");
    document.body.classList.add("float-panel-page");
    root?.classList.add("float-panel-page");
    return () => {
      document.documentElement.classList.remove("float-panel-page");
      document.body.classList.remove("float-panel-page");
      root?.classList.remove("float-panel-page");
    };
  }, []);

  return <FloatSoundPanel standalone />;
}

async function fetchAdminToken(userToken: string): Promise<void> {
  try {
    const path = "/api/activation/admin-token";
    const headers = { Authorization: `Bearer ${userToken}` };
    // Electron 环境：通过 IPC 代理（绕过 file:// 限制）
    const eAPI = typeof window !== "undefined"
      ? (window as Window & typeof globalThis & { electronAPI?: { apiFetch?: (u: string, o: { method: string; headers: Record<string, string>; body: null }) => Promise<{ ok: boolean; data: Record<string, unknown> }> } }).electronAPI
      : undefined;
    if (eAPI?.apiFetch) {
      const result = await eAPI.apiFetch(path, { method: "POST", headers, body: null });
      const tok = (result.data as { adminToken?: string })?.adminToken;
      if (result.ok && tok) setAdminToken(tok);
      return;
    }
    // Web 环境：正常 fetch
    const base = getApiBase();
    const res = await fetch(`${base}${path}`, { method: "POST", headers });
    if (res.ok) {
      const data = (await res.json()) as { adminToken?: string };
      if (data.adminToken) setAdminToken(data.adminToken);
    }
  } catch {
    // 静默失败，不影响登录状态
  }
}

function MainPages({
  serverReady,
  onConfigured,
}: {
  serverReady: boolean | null;
  onConfigured: () => void;
}) {
  const [loc, navigate] = useLocation();
  const [memberStatus, setMemberStatus] = useState<MemberStatus | null>(null);

  // ── 启动时验证 token，设置角色，管理员自动跳管理页 ──
  useEffect(() => {
    if (serverReady !== true) return;
    const token = getToken();
    console.log("[金玖] 启动检查 token:", token ? "有token" : "无token", "loc:", loc);
    if (!token) {
      if (loc !== "/login") navigate("/login");
      return;
    }
    activationStatus(authHeader(token))
      .then(async (data) => {
        console.log("[金玖] activationStatus ok, isAdmin=", data.isAdmin, "loc=", loc);
        if (data.newToken) setToken(data.newToken);
        const isAdmin = data.isAdmin ?? false;
        try { localStorage.setItem("jt_is_admin_cache", isAdmin ? "1" : "0"); } catch {}
        setMemberStatus({
          username: data.username,
          membershipExpiresAt: data.membershipExpiresAt ?? null,
          memberActive: true,
          isAdmin,
        });
        if (isAdmin) {
          await fetchAdminToken(data.newToken ?? token);
        } else {
          clearAdminToken();
        }
      })
      .catch((err) => {
        console.error("[金玖] activationStatus 失败:", err);
        // 若缓存显示曾是管理员，保持登录态以便离线使用；否则跳登录
        const cached = localStorage.getItem("jt_is_admin_cache");
        if (cached === null) {
          clearToken();
          clearAdminToken();
          if (loc !== "/login") navigate("/login");
        } else {
          setMemberStatus({
            memberActive: true,
            isAdmin: cached === "1",
          });
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverReady]);

  if (serverReady === null) {
    return (
      <div style={{
        position: "fixed", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(135deg,#EDE8FF 0%,#F5F0FF 50%,#FFE8F6 100%)",
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%",
          border: "3px solid rgba(230,182,110,0.25)",
          borderTopColor: "#E6B66E",
          animation: "spin 0.9s linear infinite",
        }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (serverReady === false) {
    return <ServerSetup onConfigured={onConfigured} />;
  }

  if (loc === "/login") {
    return (
      <MemberStatusProvider value={memberStatus}>
        <div className="app-root">
          <div className="app-bg" />
          <div className="app-content">
            <div className="page-wrap">
              <LoginPage onLogin={async (status) => {
                setMemberStatus(status);
                if (status.isAdmin) {
                  const tok = getToken();
                  if (tok) { try { await fetchAdminToken(tok); } catch {} }
                } else {
                  clearAdminToken();
                }
                navigate("/");
              }} />
            </div>
          </div>
        </div>
      </MemberStatusProvider>
    );
  }

  const isSettings = loc.startsWith("/settings");
  const isManage = loc.startsWith("/manage");

  return (
    <MemberStatusProvider value={memberStatus}>
      <div className="app-root">
        <div className="app-bg" />
        <div className="app-content">
          <div className="page-wrap" style={isSettings || isManage ? { display: "none" } : {}}>
            <SoundAssistant />
          </div>
          {isSettings && (
            <div className="page-wrap overlay-page">
              <SettingsPage />
            </div>
          )}
          {isManage && (
            <div className="page-wrap overlay-page">
              <ManagePage />
            </div>
          )}
          <BottomTabBar />
        </div>
      </div>
    </MemberStatusProvider>
  );
}

function App() {
  const [serverReady, setServerReady] = useState<boolean | null>(
    !isElectronEnv || isAudioWorker || isFloatPanel ? true : null,
  );

  useEffect(() => {
    initTheme();
  }, []);

  useEffect(() => {
    if (!isElectronEnv || isAudioWorker || isFloatPanel) return;
    window.electronAPI?.getApiBase?.().then(base => {
      const resolvedBase = base || API_BASE_URL;
      console.log("[金玖] Electron 启动，API 地址：", resolvedBase, base ? "(来自 IPC)" : "(IPC 返回空，用默认)");
      setRuntimeApiBase(resolvedBase);
      setServerReady(true);
    }).catch((e) => {
      console.warn("[金玖] getApiBase IPC 失败，使用编译时地址", e);
      setServerReady(true);
    });
  }, []);

  const onConfigured = () => setServerReady(true);

  return (
    <TooltipProvider>
      {isElectronEnv ? (
        <Router hook={useHashLocation}>
          <Switch>
            <Route path="/audio-worker">
              <AudioWorker />
            </Route>
            <Route path="/float-sound-panel">
              <FloatPanelPage />
            </Route>
            <Route>
              <MainPages serverReady={serverReady} onConfigured={onConfigured} />
            </Route>
          </Switch>
        </Router>
      ) : (
        <Router base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
          <MainPages serverReady={serverReady} onConfigured={onConfigured} />
          <PWAInstallPrompt />
        </Router>
      )}
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
