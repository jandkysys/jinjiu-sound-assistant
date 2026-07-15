import { createContext, useContext } from "react";

export interface MemberStatus {
  username?: string;
  /** null = 永久会员；ISO 字符串 = 有到期日；undefined = 未知 */
  membershipExpiresAt?: string | null;
  memberActive: boolean;
  /** 是否是管理员账号（可导入/发布音效） */
  isAdmin?: boolean;
}

const MemberStatusContext = createContext<MemberStatus | null>(null);

export const MemberStatusProvider = MemberStatusContext.Provider;

export function useMemberStatus(): MemberStatus | null {
  return useContext(MemberStatusContext);
}

export interface ExpiryInfo {
  text: string;
  subText?: string;
  daysLeft: number | null;
  status: "permanent" | "ok" | "warning" | "expired";
}

/** 根据 membershipExpiresAt 生成显示文字和状态 */
export function formatExpiry(expiresAt: string | null | undefined): ExpiryInfo {
  // null = 服务端明确返回「永久会员」
  if (expiresAt === null) {
    return { text: "永久会员", daysLeft: null, status: "permanent" };
  }
  // undefined = 数据尚未加载或旧版服务端未返回此字段，不能误报为「永久」
  if (expiresAt === undefined) {
    return { text: "状态加载中…", daysLeft: null, status: "ok" };
  }
  const exp = new Date(expiresAt);
  if (isNaN(exp.getTime())) {
    return { text: "永久会员", daysLeft: null, status: "permanent" };
  }
  const now = new Date();
  const msLeft = exp.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

  const mm = exp.getMonth() + 1;
  const dd = exp.getDate();
  const dateStr = `${mm}月${dd}日`;

  if (daysLeft <= 0) {
    return { text: "会员已过期", subText: `到期日：${dateStr}`, daysLeft: 0, status: "expired" };
  }
  if (daysLeft <= 7) {
    return {
      text: `有效期至 ${dateStr}`,
      subText: `还剩 ${daysLeft} 天，即将到期`,
      daysLeft,
      status: "warning",
    };
  }
  return {
    text: `有效期至 ${dateStr}`,
    subText: `剩余 ${daysLeft} 天`,
    daysLeft,
    status: "ok",
  };
}
