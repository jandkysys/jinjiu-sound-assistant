/**
 * AudioWorker — 隐藏音频工作组件（audioWindow 专用）
 *
 * 不渲染任何 UI（返回 null）。职责：
 *  1. 从 IndexedDB 加载音效数据（bootstrapPersist）
 *  2. 将每个 globalShortcut 通过 electronGS 注册到主进程
 *  3. 通过 BroadcastChannel 监听主窗口的音效变更，实时刷新注册
 *
 * 音效触发路径：
 *   OS 快捷键 → main.js globalShortcut → gs-fire IPC → audioWindow →
 *   globalShortcutBridge.onFire → triggerSoundGlobal（本窗口音频引擎播放）
 */

import { useEffect, useMemo, useRef } from "react";
import { useSoundEngine } from "../lib/useSoundEngine";
import { getGlobalShortcutBridge } from "../lib/globalShortcutBridge";
import { bootstrapPersist, PERSIST_KEYS } from "../lib/persist";
import { rehydrateSoundsFromPersist } from "../lib/useSoundEngine";

export default function AudioWorker() {
  const { sounds, triggerSound } = useSoundEngine({ enableGlobalShortcuts: false });

  const triggerRef = useRef(triggerSound);
  triggerRef.current = triggerSound;
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;

  // 启动时从 IndexedDB 加载音效（persist bootstrap 完成后触发重新初始化）
  useEffect(() => {
    bootstrapPersist(PERSIST_KEYS)
      .then(() => rehydrateSoundsFromPersist())
      .catch(() => {});
  }, []);

  // 每当 sounds 的 globalShortcut 或 shortcut 变化时重新注册
  const gsKey = useMemo(
    () => sounds.map(s => `${s.id}:${s.globalShortcut ?? ""}:${s.shortcut ?? ""}`).join("|"),
    [sounds]
  );

  useEffect(() => {
    if (typeof window === "undefined" || !("electronGS" in window)) return;
    const bridge = getGlobalShortcutBridge();
    let alive = true;

    void (async () => {
      await bridge.unregisterAll();
      if (!alive) return;

      let registered = 0;
      for (const s of soundsRef.current) {
        if (!alive) break;

        // ── globalShortcut 字段（F 键 / 组合键） ──────────────────────────
        if (s.globalShortcut) {
          const sid = s.id;
          const ok = await bridge.register(s.globalShortcut, () => {
            void triggerRef.current(sid, false, false);
          });
          if (ok) registered++;
          else console.warn(`[AudioWorker] 全局快捷键 ${s.globalShortcut} 注册失败`);
        }

        // ── shortcut 字段（A-Z / 0-9 单字符）────────────────────────────
        // 注册到 Electron globalShortcut，使软件最小化后仍能触发。
        // main.js 在 hotkeyEnabled=false 时仅存表不注册 OS，确保开关语义正确。
        if (s.shortcut && s.shortcut.length <= 2) {
          const sid = s.id;
          const accel = s.shortcut.length === 1 ? s.shortcut.toUpperCase() : s.shortcut;
          await bridge.register(accel, () => {
            void triggerRef.current(sid, false, false);
          });
          registered++;
        }
      }

      if (alive && registered > 0) {
        console.log(`[AudioWorker] 已注册 ${registered} 个全局快捷键（含字母键）`);
      }
    })();

    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gsKey]);

  return null;
}
