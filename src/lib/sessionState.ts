// 会话级界面状态记忆（Session-level UI state memory）。
//
// 语义：在一次软件使用周期内（跨页面导航、跨刷新）保留各模块的「界面所在位置」
// 状态（当前标签、选中的场景/分类、搜索关键词等）；关闭浏览器标签页 / 退出桌面端
// 后自动清空，下次打开恢复初始默认值。这正是 sessionStorage 的语义。
//
// 与 persist.ts 区分：长期数据（话术、音效库、题词器布局、各类偏好）仍走 persist.ts
// （localStorage/IndexedDB，关闭软件也保留）；本模块只处理「界面导航态」，走
// sessionStorage（关闭软件即清空）。
//
// useSessionState 是 useState 的直接替代品：初始化时从 sessionStorage 读取（带可选
// 有效性校验，脏数据回退默认），之后每次 set 写回 sessionStorage。

import { useState, useCallback, type Dispatch, type SetStateAction } from "react";

const PREFIX = "jt_ss_";

function readRaw(key: string): string | null {
  try {
    return sessionStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    sessionStorage.setItem(PREFIX + key, value);
  } catch {
    /* sessionStorage 不可用 / 配额满：忽略，退化为普通 useState 行为 */
  }
}

/**
 * 会话级记忆版 useState。
 *
 * @param key      会话存储键名（自动加 `jt_ss_` 前缀），需全局唯一。
 * @param initial  初始值或惰性初始化函数（无会话值或会话值无效时使用）。
 * @param validate 可选有效性校验：恢复出的值传入，返回 false 则丢弃并回退初始值。
 *                 用于过滤已删除的场景/分类 id 等脏数据。
 */
export function useSessionState<T>(
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
      } catch {
        /* 解析失败：回退默认 */
      }
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
        try {
          writeRaw(key, JSON.stringify(next));
        } catch {
          /* 序列化失败：忽略 */
        }
        return next;
      });
    },
    [key],
  );

  return [state, setAndPersist];
}
