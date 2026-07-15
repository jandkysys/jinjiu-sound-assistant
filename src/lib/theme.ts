import { useCallback, useState } from "react";
import { getPersisted, setPersisted } from "./persist";

export type ThemeMode = "light" | "dark" | "system";

let _sysHandler: (() => void) | null = null;

function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolvedTheme(mode) === "dark" ? "dark" : "";
}

function attachSysListener(): void {
  if (typeof window === "undefined" || _sysHandler) return;
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  _sysHandler = () => applyTheme("system");
  mql.addEventListener("change", _sysHandler);
}

function detachSysListener(): void {
  if (!_sysHandler || typeof window === "undefined") return;
  window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", _sysHandler);
  _sysHandler = null;
}

export function initTheme(): void {
  const mode = (getPersisted("jt_theme") ?? "system") as ThemeMode;
  applyTheme(mode);
  if (mode === "system") attachSysListener();
}

export function useTheme(): { mode: ThemeMode; setTheme: (m: ThemeMode) => void } {
  const [mode, setMode] = useState<ThemeMode>(
    () => (getPersisted("jt_theme") ?? "system") as ThemeMode,
  );

  const setTheme = useCallback((m: ThemeMode) => {
    setPersisted("jt_theme", m);
    setMode(m);
    applyTheme(m);
    if (m === "system") {
      attachSysListener();
    } else {
      detachSysListener();
    }
  }, []);

  return { mode, setTheme };
}
