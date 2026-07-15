// localStorage 版 useState — 跨 App 关闭/重启也保留（与 sessionState.ts 的
// sessionStorage 版相比：sessionStorage 关闭浏览器 Tab 即清空；本模块关闭也保留）。
//
// 用于：各板块选中分类/场景/标签 等"下次打开恢复"的 UI 偏好。
// 不要用于临时拖拽、hover、modal 等真正一次性的 UI 状态。
//
// 键名自动加前缀 jt_ps_，与 sessionStorage 键（jt_ss_）和数据键（jt_）互不干扰。

import { useState, useCallback, type Dispatch, type SetStateAction } from "react";

const PREFIX = "jt_ps_";

function readRaw(key: string): string | null {
  try { return localStorage.getItem(PREFIX + key); } catch { return null; }
}

function writeRaw(key: string, value: string): void {
  try { localStorage.setItem(PREFIX + key, value); } catch {}
}

/**
 * 持久化版 useState（localStorage，关闭 App 也保留）。
 *
 * @param key      键名（自动加 jt_ps_ 前缀），需全局唯一。
 * @param initial  初始值或惰性初始化函数（无存储值或存储值无效时使用）。
 * @param validate 可选有效性校验：恢复出的值传入，返回 false 则丢弃并回退初始值。
 *                 用于过滤已删除的场景/分类 ID 等过时数据。
 */
export function usePersistState<T>(
  key: string,
  initial: T | (() => T),
  validate?: (restored: T) => boolean,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    const fallback = (): T =>
      typeof initial === "function" ? (initial as () => T)() : initial;
    const raw = readRaw(key);
    if (raw != null) {
      try {
        const parsed = JSON.parse(raw) as T;
        if (!validate || validate(parsed)) return parsed;
      } catch {}
    }
    return fallback();
  });

  const setAndPersist = useCallback<Dispatch<SetStateAction<T>>>(
    (value) => {
      setState((prev) => {
        const next =
          typeof value === "function"
            ? (value as (p: T) => T)(prev)
            : value;
        try { writeRaw(key, JSON.stringify(next)); } catch {}
        return next;
      });
    },
    [key],
  );

  return [state, setAndPersist];
}
