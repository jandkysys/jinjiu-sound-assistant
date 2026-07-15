export const PRODUCTION_API_BASE_URL =
  "https://crystal-clear-prompt.replit.app" as const;

export function normalizeApiBaseUrl(value?: string): string {
  const candidate = value?.trim() || PRODUCTION_API_BASE_URL;
  const url = new URL(candidate);

  if (url.protocol !== "https:") {
    throw new Error("生产后台必须使用 HTTPS");
  }

  return url.origin;
}

export const API_BASE_URL = normalizeApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL,
);

export const BACKEND_HEALTH_URL = `${API_BASE_URL}/api/healthz`;
