import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * 自动倒计时 toast 外壳：负责底部进度条、悬停暂停/移开恢复、到时回调。
 * 视觉/排版（背景、定位、padding 等）通过 `style` 传入；内部 children 支持
 * 函数式写法以便读取剩余秒数与 hovered 状态（例如撤销 toast 的"还剩 N 秒"）。
 */
export function CountdownToast({
  toastKey,
  durationMs,
  onExpire,
  style,
  progressColor = "var(--gold)",
  children,
}: {
  toastKey: string | number;
  durationMs: number;
  onExpire: () => void;
  style?: CSSProperties;
  progressColor?: string;
  children: ReactNode | ((ctx: { remainingSec: number; hovered: boolean }) => ReactNode);
}) {
  const [progress, setProgress] = useState(1);
  const [hovered, setHovered] = useState(false);
  const expiresAtRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const onExpireRef = useRef(onExpire);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);

  useEffect(() => {
    setProgress(1);
    setHovered(false);
    expiresAtRef.current = Date.now() + durationMs;
    pausedAtRef.current = null;
    const tick = () => {
      const remaining = expiresAtRef.current - Date.now();
      const pct = Math.max(0, Math.min(1, remaining / durationMs));
      setProgress(pct);
      if (pct > 0 && pausedAtRef.current === null) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    timerRef.current = window.setTimeout(() => onExpireRef.current(), durationMs);
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      if (rafRef.current !== null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      pausedAtRef.current = null;
    };
  }, [toastKey, durationMs]);

  function pause() {
    if (pausedAtRef.current !== null) return;
    pausedAtRef.current = Date.now();
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    if (rafRef.current !== null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }
  function resume() {
    if (pausedAtRef.current === null) return;
    const pausedFor = Date.now() - pausedAtRef.current;
    expiresAtRef.current += pausedFor;
    pausedAtRef.current = null;
    const remaining = Math.max(0, expiresAtRef.current - Date.now());
    timerRef.current = window.setTimeout(() => onExpireRef.current(), remaining);
    const tick = () => {
      const rem = expiresAtRef.current - Date.now();
      const pct = Math.max(0, Math.min(1, rem / durationMs));
      setProgress(pct);
      if (pct > 0 && pausedAtRef.current === null) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }

  const remainingSec = Math.max(1, Math.ceil(progress * durationMs / 1000));
  const content = typeof children === "function" ? children({ remainingSec, hovered }) : children;
  return (
    <div
      onMouseEnter={() => { setHovered(true); pause(); }}
      onMouseLeave={() => { setHovered(false); resume(); }}
      onFocus={() => pause()}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        resume();
      }}
      style={{ position: "fixed", overflow: "hidden", ...style }}
    >
      {content}
      <div style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        height: 2,
        width: `${progress * 100}%`,
        background: progressColor,
        transition: "width 80ms linear",
        pointerEvents: "none",
      }} />
    </div>
  );
}

export default CountdownToast;
