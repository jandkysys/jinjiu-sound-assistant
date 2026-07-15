/**
 * Electron 快捷键主开关双向同步 Hook
 *
 * 职责：
 *  1. 挂载时从主进程读取当前快捷键状态，同步到渲染进程
 *  2. 监听主进程广播（悬浮窗 / 托盘切换时），更新渲染进程状态
 *  3. 渲染进程 shortcutsEnabled 变化时，通知主进程（同步 OS 快捷键 + 悬浮窗 UI）
 *
 * 防循环设计：
 *  - 来自主进程广播的状态变化设置 isFromMainRef = true
 *  - 第二个 useEffect 检测到 isFromMainRef = true 时，跳过向主进程的通知
 *  - 避免 renderer → main → renderer 无限广播
 *
 * 只在 Electron 环境生效（window.electronAPI 不存在时静默忽略）。
 */

import { useEffect, useRef } from "react";

// 扩展 window 类型（与 preload.js / preload-audio.js 保持一致）
// 所有 electronAPI 属性的权威类型声明（其他文件不要再重复声明此属性）
declare global {
  interface Window {
    electronAPI?: {
      platform?: string;
      isElectron?: boolean;
      /** 隐藏音频工作窗口标志（preload-audio.js 注入，主窗口无此属性）*/
      isAudioWorker?: boolean;
      /** 独立悬浮快捷键面板窗口标志 */
      isFloatPanel?: boolean;
      getHotkeyStatus?: () => Promise<boolean>;
      notifyHotkeyStatus?: (enabled: boolean) => void;
      onHotkeyStatusChanged?: (cb: (enabled: boolean) => void) => void;
      showMainWindow?: () => void;
      hideFloatWindow?: () => void;
      quitApp?: () => void;
      // API 代理（通过主进程转发，绕过 CORS / file:// 限制）
      getApiBase?: () => Promise<string>;
      setApiBase?: (url: string) => Promise<void>;
      apiFetch?: (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string | null }
      ) => Promise<{ ok: boolean; status: number; data: unknown }>;
      /** 专供二进制文件下载，返回 base64 字符串，不破坏音频数据 */
      apiFetchBuffer?: (
        url: string,
        init: { headers?: Record<string, string> }
      ) => Promise<{ ok: boolean; status: number; base64: string | null; contentType: string; error?: string }>;
    };
  }
}

/**
 * @param shortcutsEnabled 当前 shortcutsEnabled 状态（来自 appSettings）
 * @param onStatusChange   更新 shortcutsEnabled 的 setter（setSet 包装）
 */
export function useElectronHotkeySync(
  shortcutsEnabled: boolean,
  onStatusChange: (enabled: boolean) => void,
): void {
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  /** 标记本次变化是否由主进程广播引起（防止回声） */
  const isFromMainRef = useRef(false);

  /**
   * 跳过首次 render 时向主进程的通知。
   * 首次挂载时让主进程的真实状态（getHotkeyStatus）覆盖本地存储，
   * 而不是用本地存储的（可能为 false）值立刻把主进程的 hotkeyEnabled 覆盖掉。
   */
  const isInitialMountRef = useRef(true);

  // ── 初始化：获取主进程当前状态（主进程为 source of truth）──────────────────
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getHotkeyStatus) return;

    api.getHotkeyStatus()
      .then((enabled) => {
        isFromMainRef.current = true;
        onStatusChangeRef.current(!!enabled);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 监听主进程广播（悬浮窗 / 托盘切换）────────────────────────────────────
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onHotkeyStatusChanged) return;

    api.onHotkeyStatusChanged((enabled) => {
      isFromMainRef.current = true;
      onStatusChangeRef.current(!!enabled);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 渲染进程状态变化 → 通知主进程（跳过来自主进程的回声 & 首次挂载）────────
  useEffect(() => {
    // 首次挂载：跳过，让 getHotkeyStatus 的结果作为初始状态
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }

    if (isFromMainRef.current) {
      // 这次变化来自主进程广播，不要再回传，防止无限循环
      isFromMainRef.current = false;
      return;
    }

    const api = window.electronAPI;
    if (!api?.notifyHotkeyStatus) return;

    api.notifyHotkeyStatus(shortcutsEnabled);
  }, [shortcutsEnabled]);
}
