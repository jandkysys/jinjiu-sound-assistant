import { secureGetSync, secureSet, secureDelete } from "./secureStorage";

export const TOKEN_KEY = "sa_token";
export const DEVICE_KEY = "sa_device_id";
export const ADMIN_TOKEN_KEY = "sa_admin_token";

/** 同步读取登录 token（从内存缓存，需先 initSecureStorage 预热）。 */
export function getToken(): string | null {
  return secureGetSync(TOKEN_KEY);
}

/** 保存登录 token（异步持久化，同步更新内存缓存）。 */
export function setToken(token: string): void {
  void secureSet(TOKEN_KEY, token);
}

/** 清除登录 token。 */
export function clearToken(): void {
  void secureDelete(TOKEN_KEY);
}

/** 同步读取管理员云端操作 token。 */
export function getAdminToken(): string | null {
  return secureGetSync(ADMIN_TOKEN_KEY);
}

/** 保存管理员云端操作 token。 */
export function setAdminToken(token: string): void {
  void secureSet(ADMIN_TOKEN_KEY, token);
}

/** 清除管理员云端操作 token。 */
export function clearAdminToken(): void {
  void secureDelete(ADMIN_TOKEN_KEY);
}

/**
 * 获取设备唯一 ID（同步读内存，首次生成时异步持久化）。
 * deviceId 用于激活码绑定设备，不应随意清除。
 */
export function getDeviceId(): string {
  let id = secureGetSync(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    void secureSet(DEVICE_KEY, id);
  }
  return id;
}

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** 返回管理员云端操作的 Authorization 头，若无 token 则返回 null。 */
export function adminAuthHeader(): Record<string, string> | null {
  const t = getAdminToken();
  return t ? { Authorization: `Bearer ${t}` } : null;
}
