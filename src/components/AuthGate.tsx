import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { activationStatus } from "@/lib/apiClientStub";
import { getToken, setToken, clearToken, authHeader, setAdminToken, clearAdminToken } from "@/lib/auth";
import { MemberStatusProvider, type MemberStatus } from "@/lib/memberStatus";
import { getApiBase } from "@/lib/apiConfig";

type State = "checking" | "ok" | "redirect";

/** 用用户 JWT 换取云端管理 JWT（仅 isAdmin 用户调用）。静默失败，不影响正常登录。 */
async function fetchAdminToken(userToken: string): Promise<void> {
  try {
    const base = getApiBase();
    const res = await fetch(`${base}/api/activation/admin-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { adminToken?: string };
      if (data.adminToken) setAdminToken(data.adminToken);
    }
  } catch {
    // 网络不可用时静默忽略，管理功能离线不可用
  }
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>("checking");
  const [memberStatus, setMemberStatus] = useState<MemberStatus | null>(null);
  const [, navigate] = useLocation();

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setState("redirect");
      return;
    }
    activationStatus(authHeader(token))
      .then(async (data) => {
        if (data.newToken) setToken(data.newToken);
        if (data.memberActive) {
          const isAdmin = data.isAdmin ?? false;
          setMemberStatus({
            username: data.username,
            membershipExpiresAt: data.membershipExpiresAt,
            memberActive: true,
            isAdmin,
          });
          setState("ok");
          // 管理员自动换取云端操作 token，并跳转到管理页
          if (isAdmin) {
            await fetchAdminToken(data.newToken ?? token);
            navigate("/manage");
          } else {
            clearAdminToken();
          }
        } else {
          clearToken();
          clearAdminToken();
          setState("redirect");
        }
      })
      .catch((err: unknown) => {
        const isNetworkErr =
          !err ||
          (typeof err === "object" &&
            "status" in (err as object) &&
            (err as { status: number }).status === 0);
        if (isNetworkErr) {
          setMemberStatus({ username: undefined, membershipExpiresAt: undefined, memberActive: true });
          setState("ok");
        } else {
          if (typeof window !== "undefined" && "electronGS" in window) {
            const raw = JSON.stringify(typeof err === "object" && err !== null ? err : String(err));
            window.alert("【身份验证失败，跳转登录页】\n原始错误：\n" + raw);
          }
          clearToken();
          clearAdminToken();
          setState("redirect");
        }
      });
  }, []);

  useEffect(() => {
    if (state === "redirect") {
      navigate("/login");
    }
  }, [state, navigate]);

  if (state === "checking") {
    return (
      <div style={{
        position: "fixed", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(135deg, #EDE8FF 0%, #F5F0FF 45%, #FFE8F6 100%)",
      }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%",
            border: "3px solid rgba(230,182,110,0.25)",
            borderTopColor: "#E6B66E",
            animation: "spin 0.9s linear infinite",
          }} />
          <div style={{ fontSize: 13, color: "rgba(100,80,140,0.5)", fontFamily: "KaiTi,serif" }}>
            验证会员身份…
          </div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (state === "redirect") return null;

  return (
    <MemberStatusProvider value={memberStatus}>
      {children}
    </MemberStatusProvider>
  );
}
