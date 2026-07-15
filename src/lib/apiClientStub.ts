/**
 * 本地 API 客户端 — 替换 @workspace/api-client-react
 *
 * 独立 npm 打包时使用此文件，无需 pnpm workspace。
 * 所有函数对应 API Server 的 /api/activation/* 路由，
 * 错误统一抛出 { status, data } 格式以匹配原有错误处理代码。
 */

// electronAPI 类型权威声明在 electronHotkeySync.ts，此处不重复声明。

// ─── 模块级配置 ───────────────────────────────────────────────────────────────

let _baseUrl: string | null = null;
type AuthTokenGetter = () => Promise<string | null> | string | null;
let _authTokenGetter: AuthTokenGetter | null = null;

export function setBaseUrl(url: string | null): void {
  _baseUrl = url ? url.replace(/\/+$/, "") : null;
}

export function setAuthTokenGetter(getter: AuthTokenGetter | null): void {
  _authTokenGetter = getter;
}

export type { AuthTokenGetter };

// ─── 内部 fetch 工具 ──────────────────────────────────────────────────────────

class ApiError {
  constructor(
    public status: number,
    public data: unknown,
  ) {}
}

async function apiFetch<T>(
  url: string,
  init: RequestInit = {},
  extraHeaders: HeadersInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders as Record<string, string>),
  };

  if (_authTokenGetter) {
    const token = await _authTokenGetter();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  // ── Electron 路径：通过主进程 IPC 代理请求（绕过 CORS + file:// 限制）──────
  const electronAPI = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (electronAPI?.apiFetch) {
    const result = await electronAPI.apiFetch(url, {
      method: (init.method ?? "GET") as string,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      body: (init.body as string | null) ?? null,
    });
    if (!result.ok) {
      throw new ApiError(result.status, result.data);
    }
    return result.data as T;
  }

  // ── Web 路径：正常 fetch ───────────────────────────────────────────────────
  const base = _baseUrl ?? "";
  const fullUrl = url.startsWith("/") ? `${base}${url}` : url;

  const resp = await fetch(fullUrl, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });

  let data: unknown;
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    data = await resp.json();
  } else {
    data = await resp.text();
  }

  if (!resp.ok) {
    throw new ApiError(resp.status, data);
  }

  return data as T;
}

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface ActivationStatusResult {
  memberActive: boolean;
  username?: string;
  /** ISO 日期字符串；null = 永久会员；undefined = 旧版服务端未返回 */
  membershipExpiresAt?: string | null;
  /** 若旧 token 过期但账号仍有效，服务端返回已续签的新 token */
  newToken?: string;
  /** 是否是管理员账号（可导入/管理音效） */
  isAdmin?: boolean;
}

export interface ActivationLoginBody {
  username: string;
  password: string;
  deviceId?: string;
}

export interface ActivationLoginResult {
  token: string;
  username: string;
  memberActive: boolean;
}

export interface ActivationRegisterBody {
  username: string;
  password: string;
  email?: string;
}

export interface ActivationRedeemBody {
  code: string;
  deviceId?: string;
}

export interface ActivationRedeemDirectBody {
  code: string;
  deviceId?: string;
}

export interface ActivationRedeemDirectResult {
  token: string;
  username: string;
}

// ─── API 函数 ─────────────────────────────────────────────────────────────────

/**
 * GET /api/activation/status — 检查当前 token 的会员状态
 * @param headers 含 Authorization 的 headers（如 authHeader(token)）
 */
export async function activationStatus(
  headers: HeadersInit = {},
): Promise<ActivationStatusResult> {
  return apiFetch<ActivationStatusResult>(
    "/api/activation/status",
    { method: "GET" },
    headers,
  );
}

/**
 * POST /api/activation/login — 账号登录，返回 token + memberActive
 */
export async function activationLogin(
  body: ActivationLoginBody,
): Promise<ActivationLoginResult> {
  return apiFetch<ActivationLoginResult>(
    "/api/activation/login",
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * POST /api/activation/register — 注册账号
 */
export async function activationRegister(
  body: ActivationRegisterBody,
): Promise<void> {
  return apiFetch<void>(
    "/api/activation/register",
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * POST /api/activation/redeem — 已登录账号兑换激活码（需 Authorization header）
 */
export async function activationRedeem(
  body: ActivationRedeemBody,
  headers: HeadersInit = {},
): Promise<void> {
  return apiFetch<void>(
    "/api/activation/redeem",
    { method: "POST", body: JSON.stringify(body) },
    headers,
  );
}

/**
 * POST /api/activation/redeem-direct — 无账号直接用激活码开通，返回 token
 */
export async function activationRedeemDirect(
  body: ActivationRedeemDirectBody,
): Promise<ActivationRedeemDirectResult> {
  return apiFetch<ActivationRedeemDirectResult>(
    "/api/activation/redeem-direct",
    { method: "POST", body: JSON.stringify(body) },
  );
}
