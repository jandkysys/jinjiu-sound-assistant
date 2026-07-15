/**
 * 电子全局快捷键桥接类型（仅 Electron 桌面端可用）
 */
interface ElectronFuncGS {
  register: (key: string) => Promise<boolean>;
  unregister: (key: string) => Promise<void>;
  unregisterAll: () => Promise<void>;
  onFire: (cb: (key: string) => void) => void;
}

declare global {
  interface Window {
    electronFuncGS?: ElectronFuncGS;
  }
}

/**
 * 功能快捷键共享层
 *
 * 定义 FuncActionId、FUNC_ACTIONS、组合键序列化/展示工具，
 * 以及 useFuncShortcutListener hook——可同时挂在 SoundAssistant 和 Teleprompter 上，
 * 从而让音效功能快捷键（包含数字键 0-9、组合键等）在题词器中也同时生效。
 */
import { useEffect, useRef } from "react";
import { getPersisted } from "./persist";

export const FUNC_SHORTCUTS_KEY = "jt_sound_func_shortcuts";

export type FuncActionId =
  | "sfxStop" | "sfxPause" | "sfxVolUp" | "sfxVolDown" | "toggleLoop" | "duck"
  | "bgmPlayPause" | "bgmPrev" | "bgmNext" | "bgmVolUp" | "bgmVolDown"
  | "toggleShortcuts" | "toggleWindow";

export const FUNC_ACTIONS: { id: FuncActionId; label: string }[] = [
  { id: "sfxStop",         label: "音效停止" },
  { id: "sfxPause",        label: "音效暂停" },
  { id: "sfxVolUp",        label: "音效音量增大" },
  { id: "sfxVolDown",      label: "音效音量减小" },
  { id: "toggleLoop",      label: "切换音效循环播放开启状态" },
  { id: "duck",            label: "闪避 / 压音" },
  { id: "bgmPlayPause",    label: "背景音乐播放 / 暂停" },
  { id: "bgmPrev",         label: "背景音乐上一首" },
  { id: "bgmNext",         label: "背景音乐下一首" },
  { id: "bgmVolUp",        label: "背景音乐音量增大" },
  { id: "bgmVolDown",      label: "背景音乐音量减小" },
  { id: "toggleShortcuts", label: "切换快捷键开启状态" },
  { id: "toggleWindow",    label: "打开 / 缩小窗口" },
];

/**
 * 把一次按键事件序列化为规范的组合键字符串（如 "ctrl+alt+d"、"a"、"space"、"f1"）。
 * 仅按下修饰键本身时返回 null（继续等待真正的按键）。
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  const base = k === " " ? "space" : k.toLowerCase();
  if (!base) return null;
  parts.push(base);
  return parts.join("+");
}

/**
 * 把 comboFromEvent 格式（如 "ctrl+alt+d"、"a"、"f5"）转为
 * Electron globalShortcut 所需的 Accelerator 格式（如 "Ctrl+Alt+D"、"A"、"F5"）。
 */
export function comboToAccelerator(combo: string): string {
  return combo.split("+").map(p =>
    p === "ctrl"  ? "Ctrl"  :
    p === "alt"   ? "Alt"   :
    p === "shift" ? "Shift" :
    p === "meta"  ? "Cmd"   :
    p === "space" ? "Space" :
    p.toUpperCase()
  ).join("+");
}

/** 组合键的展示文本，如 "ctrl+alt+d" → "Ctrl + Alt + D" */
export function comboLabel(combo: string): string {
  return combo.split("+").map(p =>
    p === "ctrl" ? "Ctrl" : p === "alt" ? "Alt" : p === "shift" ? "Shift" : p === "meta" ? "Cmd"
    : p === "space" ? "Space" : p.toUpperCase(),
  ).join(" + ");
}

/** 从持久化存储读取功能快捷键绑定表 */
export function loadFuncShortcuts(): Record<string, string> {
  try {
    const r = getPersisted(FUNC_SHORTCUTS_KEY);
    if (r) { const o = JSON.parse(r) as unknown; if (o && typeof o === "object") return o as Record<string, string>; }
  } catch {}
  return {};
}

/**
 * 全局功能快捷键监听 hook。
 *
 * - 在捕获阶段（capture phase）注册 keydown，优先于普通音效字母键监听器。
 * - 每次 keydown 实时从持久化存储读取绑定表，无需在 deps 中传入 funcShortcuts state。
 * - `active = false` 时（如题词器未开启音效快捷键、SoundAssistant 正在录制新快捷键）不注册监听。
 *
 * @param handler 匹配到绑定动作时调用，参数为 FuncActionId 字符串
 * @param active  是否激活监听，默认 true
 */
/**
 * Electron accelerator 格式（"Ctrl+A"、"F1"、"0"）→ comboFromEvent 格式（"ctrl+a"、"f1"、"0"）
 */
export function acceleratorToCombo(accel: string): string {
  return accel.split("+").map(p =>
    p === "Ctrl"  ? "ctrl"  :
    p === "Alt"   ? "alt"   :
    p === "Shift" ? "shift" :
    p === "Cmd"   ? "meta"  :
    p === "Space" ? "space" :
    p.toLowerCase()
  ).join("+");
}

/**
 * 在 Electron 桌面端将功能快捷键注册为 OS 级全局快捷键。
 * 软件最小化/隐藏后仍然响应。非 Electron 环境（无 window.electronFuncGS）时静默跳过。
 *
 * @param funcShortcuts 当前功能快捷键绑定表 Record<FuncActionId, comboString>
 * @param handler       匹配到动作时调用，参数为 FuncActionId
 * @param active        false 时暂停注册（如正在录制快捷键）
 */
export function useFuncGlobalShortcut(
  funcShortcuts: Record<string, string>,
  handler: (id: string) => void,
  active = true,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // 始终保持最新绑定表，onFire 通过 ref 查找，无需等待异步 accelMap 填入
  const shortcutsRef = useRef(funcShortcuts);
  shortcutsRef.current = funcShortcuts;

  // 每当绑定表或激活状态变化，重新向主进程注册 OS 快捷键
  useEffect(() => {
    const gs = window.electronFuncGS;
    if (!gs) return;

    let alive = true;
    void (async () => {
      await gs.unregisterAll();
      if (!alive || !active) return;
      for (const [, combo] of Object.entries(shortcutsRef.current)) {
        if (!combo) continue;
        await gs.register(comboToAccelerator(combo));
      }
    })();

    return () => {
      alive = false;
      void gs.unregisterAll();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, JSON.stringify(funcShortcuts)]);

  // onFire 监听只注册一次（ipcRenderer.on 不应叠加）
  // 直接将 fired accelerator 转回 combo 格式后在 shortcutsRef 中反向查找，
  // 不再依赖异步填入的 accelMap，彻底避免时序漏洞。
  useEffect(() => {
    const gs = window.electronFuncGS;
    if (!gs) return;
    gs.onFire((firedAccel) => {
      const firedCombo = acceleratorToCombo(firedAccel);
      const entry = Object.entries(shortcutsRef.current).find(([, c]) => c === firedCombo);
      if (entry) handlerRef.current(entry[0]);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useFuncShortcutListener(
  handler: (id: string) => void,
  active = true,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const isCombo = e.ctrlKey || e.altKey || e.metaKey;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField =
        tag === "INPUT" || tag === "TEXTAREA" ||
        (e.target as HTMLElement | null)?.isContentEditable;
      if (!isCombo && inField) return;
      const shortcuts = loadFuncShortcuts();
      const hit = Object.entries(shortcuts).find(([, c]) => c === combo);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handlerRef.current(hit[0]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
}
