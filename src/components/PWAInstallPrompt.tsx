import { useState, useEffect, useRef } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = "jsa_pwa_dismissed";

export function PWAInstallPrompt() {
  const [show, setShow] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "electronGS" in window) return;
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (isStandalone) return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;

    const ios =
      /iphone|ipad|ipod/i.test(navigator.userAgent) &&
      !(window as Window & typeof globalThis & { MSStream?: unknown }).MSStream;
    setIsIOS(ios);

    if (ios) {
      const t = setTimeout(() => setShow(true), 3500);
      return () => clearTimeout(t);
    }

    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const dismiss = () => {
    setShow(false);
    localStorage.setItem(DISMISS_KEY, "1");
  };

  const install = async () => {
    if (!deferredPrompt.current) return;
    await deferredPrompt.current.prompt();
    const { outcome } = await deferredPrompt.current.userChoice;
    deferredPrompt.current = null;
    if (outcome === "accepted") setShow(false);
    else dismiss();
  };

  if (!show) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 76,
        left: 12,
        right: 12,
        zIndex: 9999,
        background: "linear-gradient(135deg, rgba(38,32,18,0.97), rgba(22,18,10,0.97))",
        border: "1px solid rgba(230,180,95,0.68)",
        borderRadius: 18,
        padding: "13px 14px",
        display: "flex",
        alignItems: "center",
        gap: 11,
        boxShadow:
          "0 6px 28px rgba(0,0,0,0.55), 0 0 0 1px rgba(230,180,95,0.12)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
      }}
    >
      <span style={{ fontSize: 26, flexShrink: 0, lineHeight: 1 }}>🎵</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#F6DFA8",
            lineHeight: 1.3,
          }}
        >
          添加到主屏幕
        </div>
        <div
          style={{
            fontSize: 11,
            color: "rgba(246,223,168,0.62)",
            marginTop: 3,
            lineHeight: 1.45,
          }}
        >
          {isIOS
            ? "点底部分享按钮 → 【添加到主屏幕】"
            : "安装为 App，随时快捷启动"}
        </div>
      </div>
      {!isIOS && (
        <button
          onClick={install}
          style={{
            background: "linear-gradient(135deg, #E6B66E, #C48C24)",
            color: "#1a1206",
            border: "none",
            borderRadius: 10,
            padding: "8px 13px",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            flexShrink: 0,
            boxShadow: "0 2px 8px rgba(230,182,110,0.38)",
            fontFamily: "inherit",
          }}
        >
          安装
        </button>
      )}
      <button
        onClick={dismiss}
        style={{
          background: "none",
          border: "none",
          color: "rgba(246,223,168,0.38)",
          fontSize: 20,
          cursor: "pointer",
          padding: "0 2px",
          flexShrink: 0,
          lineHeight: 1,
          fontFamily: "sans-serif",
        }}
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  );
}
