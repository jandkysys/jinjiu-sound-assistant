/**
 * API 地址与鉴权配置
 *
 * Web / Replit:
 *   VITE_API_BASE_URL 为空 → 使用相对路径，Replit 代理自动路由 /api/*
 *
 * 桌面端 (Electron):
 *   vite.electron.config.ts 默认注入生产服务器地址；
 *   运行时可通过 setRuntimeApiBase() 覆盖（ServerSetup 保存后调用）。
 */

import { setBaseUrl, setAuthTokenGetter } from "@/lib/apiClientStub";
import { getToken } from "./auth";

const COMPILE_TIME_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

let _runtimeBase: string | null = null;

/**
 * 供 App.tsx 在 Electron IPC 解析完 apiBaseUrl 后调用，
 * 覆盖编译期烧入的地址（处理用户在 ServerSetup 里填写自定义地址的情形）。
 */
export function setRuntimeApiBase(base: string): void {
  _runtimeBase = base ? base.replace(/\/+$/, "") : null;
  setBaseUrl(_runtimeBase || COMPILE_TIME_BASE || null);
}

export function initApiConfig(): void {
  setBaseUrl(COMPILE_TIME_BASE || null);
  setAuthTokenGetter(getToken);
}

export function getApiBase(): string {
  if (_runtimeBase !== null) return _runtimeBase;
  return COMPILE_TIME_BASE.replace(/\/+$/, "");
}
