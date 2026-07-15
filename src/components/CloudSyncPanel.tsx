import { useState, useEffect, useCallback } from "react";
import CloudSyncModal from "@/components/CloudSyncModal";
import {
  checkCloudVersion,
  getStoredCloudVersion,
  getLastSyncTime,
  getPreSyncSnapshot,
  clearPreSyncSnapshot,
  forceCloudRefresh,
  getCacheStats,
  getLastCloudError,
  getLastCloudStatus,
  type CloudVersionInfo,
} from "@/lib/cloudSync";
import { getToken } from "@/lib/auth";
import { getPersisted } from "@/lib/persist";
import { invalidateAudioCache, dispatchSoundsChange } from "@/lib/useSoundEngine";
import { safeSaveSounds } from "@/lib/soundPack";
import type { SoundItem } from "@/lib/soundPack";
import { API_BASE_URL } from "@/config/backend";

function loadSounds(): SoundItem[] {
  try {
    const r = getPersisted("jt_sounds");
    if (r) return JSON.parse(r) as SoundItem[];
  } catch {}
  return [];
}

function CacheStatsRow() {
  const [stats, setStats] = useState<{ bytes: number; count: number } | null>(null);
  useEffect(() => {
    void getCacheStats().then(setStats);
  }, []);
  if (!stats || stats.count === 0) return null;
  const fmtBytes = (b: number) =>
    b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <div style={{ fontSize: 12, color: "rgba(60,50,45,0.4)" }}>
      💾 本地缓存 {stats.count} 条 / {fmtBytes(stats.bytes)}
    </div>
  );
}

export default function CloudSyncPanel({ onClose }: { onClose: () => void }) {
  const [versionInfo, setVersionInfo] = useState<CloudVersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState<string>("");
  const [showModal, setShowModal] = useState(false);
  const [forceRefreshSync, setForceRefreshSync] = useState(false);
  const [forceRefreshLoading, setForceRefreshLoading] = useState(false);
  const [sounds, setSounds] = useState<SoundItem[]>(() => loadSounds());
  const [hasSnapshot, setHasSnapshot] = useState(() => getPreSyncSnapshot() !== null);
  const [lastSync, setLastSync] = useState(() => getLastSyncTime());
  const [diagStatus, setDiagStatus] = useState<number>(0);
  const [diagToken, setDiagToken] = useState<boolean>(!!getToken());

  // 加载当前 API 地址（仅 Electron），加载完立即触发连接检测
  useEffect(() => {
    void (async () => {
      const b = await window.electronAPI?.getApiBase?.();
      if (b) setApiBase(b);
      void doCheck();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    setDiagToken(!!getToken());
    try {
      const info = await checkCloudVersion();
      setDiagStatus(getLastCloudStatus());
      if (info) {
        setVersionInfo(info);
        setCheckError(null);
      } else {
        setCheckError(getLastCloudError() ?? "未知错误");
      }
    } finally {
      setChecking(false);
    }
  }, []);

  const handleRestore = useCallback(() => {
    const snap = getPreSyncSnapshot();
    if (!snap) return;
    if (!confirm("确认恢复到同步前的音效配置？当前音效库将被替换。")) return;
    safeSaveSounds(snap);
    invalidateAudioCache([]);
    dispatchSoundsChange(snap);
    clearPreSyncSnapshot();
    setHasSnapshot(false);
  }, []);

  return (
    <>
      <div
        style={{
          position: "fixed", inset: 0, zIndex: 7500,
          background: "rgba(40,30,20,0.35)", backdropFilter: "blur(3px)",
        }}
        onClick={onClose}
      />
      <div style={{
        position: "fixed", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 7600,
        background: "rgba(255,250,243,0.97)",
        border: "1.5px solid rgba(230,182,110,0.40)",
        borderRadius: 18,
        boxShadow: "0 8px 40px rgba(40,30,20,0.18)",
        padding: "28px 32px",
        minWidth: 320,
        maxWidth: 420,
        width: "88vw",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>☁️</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#E6B66E" }}>云端音效库</span>
            <span style={{ fontSize: 10, color: "rgba(60,50,45,0.3)", marginLeft: 2 }}>Build v43</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "rgba(60,50,45,0.5)", lineHeight: 1, padding: "8px 10px", margin: "-8px -10px", minWidth: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center" }}
          >×</button>
        </div>

        <div style={{ background: "rgba(230,182,110,0.06)", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: "rgba(60,50,45,0.65)", marginBottom: 4 }}>
            {versionInfo ? (
              <>
                云端 <strong style={{ color: "#E6B66E" }}>v{versionInfo.version}</strong>
                <span style={{ marginLeft: 10, color: "rgba(60,50,45,0.4)", fontSize: 12 }}>
                  本地已同步 v{getStoredCloudVersion()}
                </span>
                {versionInfo.hasUpdate && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: "#4CAF50", fontWeight: 600 }}>● 有新版本</span>
                )}
              </>
            ) : checking ? (
              <span style={{ color: "rgba(60,50,45,0.4)" }}>正在检测…</span>
            ) : (
              <span style={{ color: "#c0392b", fontWeight: 600 }}>⚠ 连接失败</span>
            )}
          </div>

            {/* 连接失败时的醒目错误框 */}
          {!versionInfo && !checking && checkError && (
            <div style={{ marginTop: 6, padding: "10px 12px", background: "rgba(220,53,69,0.08)", borderRadius: 8, border: "1.5px solid rgba(220,53,69,0.30)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#c0392b", marginBottom: 6 }}>
                ⚠ 无法连接服务器
              </div>
              <div style={{ fontSize: 11, color: "#c0392b", wordBreak: "break-all", lineHeight: 1.6, userSelect: "text", fontFamily: "monospace", background: "rgba(0,0,0,0.04)", padding: "4px 6px", borderRadius: 4, marginBottom: 6 }}>
                {checkError}
              </div>
              <div style={{ fontSize: 11, color: "rgba(60,50,45,0.5)", marginBottom: 8, lineHeight: 1.6 }}>
                可能原因：① 网络防火墙/VPN拦截 ② 服务器维护 ③ 服务器地址有误
              </div>
              {(window.electronAPI as { openExternal?: (url: string) => void } | undefined)?.openExternal && apiBase && (
                <button
                  type="button"
                  onClick={() => {
                    const testUrl = apiBase + "/api/cloud/library-version?app=sound_assistant";
                    (window.electronAPI as { openExternal?: (url: string) => void }).openExternal?.(testUrl);
                  }}
                  style={{
                    fontSize: 12, padding: "5px 10px",
                    background: "rgba(255,255,255,0.8)", color: "#c0392b",
                    border: "1px solid rgba(220,53,69,0.35)", borderRadius: 6,
                    cursor: "pointer", display: "block", width: "100%", marginBottom: 4,
                  }}
                >
                  🌐 用浏览器测试此地址（能打开=网络正常，否则=被拦截）
                </button>
              )}
            </div>
          )}

          {/* 诊断三行：Token / API地址 / 状态码 */}
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 11, color: "rgba(60,50,45,0.5)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ minWidth: 80 }}>Token</span>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 4,
                background: diagToken ? "rgba(76,175,80,0.12)" : "rgba(220,53,69,0.10)",
                color: diagToken ? "#388e3c" : "#c0392b",
                userSelect: "text",
              }}>
                {diagToken ? "✓ 已登录" : "✗ 未登录"}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "rgba(60,50,45,0.5)", display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ minWidth: 80, flexShrink: 0 }}>API 地址</span>
              <span style={{ fontFamily: "monospace", wordBreak: "break-all", userSelect: "text", color: "rgba(60,50,45,0.7)" }}>
                {apiBase || "(获取中…)"}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "rgba(60,50,45,0.5)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ minWidth: 80 }}>状态码</span>
              {checking ? (
                <span style={{ color: "rgba(60,50,45,0.35)" }}>检测中…</span>
              ) : diagStatus === 0 ? (
                <span style={{ color: "rgba(60,50,45,0.35)" }}>—</span>
              ) : (
                <span style={{
                  fontFamily: "monospace", fontWeight: 600, padding: "1px 7px", borderRadius: 4,
                  background: diagStatus === 200 ? "rgba(76,175,80,0.12)" : "rgba(220,53,69,0.10)",
                  color: diagStatus === 200 ? "#388e3c" : "#c0392b",
                  userSelect: "text",
                }}>
                  {diagStatus}
                </span>
              )}
            </div>
          </div>

          {lastSync && (
            <div style={{ fontSize: 12, color: "rgba(60,50,45,0.4)", marginTop: 6 }}>
              上次同步：{new Date(lastSync).toLocaleString("zh-CN")}
            </div>
          )}
          <CacheStatsRow />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); setForceRefreshSync(false); setSounds(loadSounds()); setShowModal(true); }}
            disabled={!versionInfo || versionInfo.version === 0}
            style={{
              background: versionInfo?.hasUpdate ? "#E6B66E" : "rgba(230,182,110,0.15)",
              color: versionInfo?.hasUpdate ? "#fff" : "#E6B66E",
              border: "1.5px solid rgba(230,182,110,0.50)",
              borderRadius: 9,
              padding: "9px 0",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              opacity: (!versionInfo || versionInfo.version === 0) ? 0.5 : 1,
            }}
          >
            {versionInfo?.hasUpdate ? "⬇ 同步新版本" : "↻ 重新同步音效库"}
          </button>

          <button
            type="button"
            onClick={(e) => { e.preventDefault(); void doCheck(); }}
            disabled={checking}
            style={{
              background: "rgba(255,255,255,0.6)",
              color: "rgba(60,50,45,0.6)",
              border: "1px solid rgba(60,50,45,0.15)",
              borderRadius: 9,
              padding: "8px 0",
              cursor: "pointer",
              fontSize: 13,
              opacity: checking ? 0.6 : 1,
            }}
          >
            {checking ? "检测中…" : "手动检查更新"}
          </button>

          <button
            type="button"
            disabled={forceRefreshLoading}
            onClick={async (e) => {
              e.preventDefault();
              if (!confirm("强制刷新将清除本地所有云端音效缓存，重新从云端下载全部音频。确认继续？")) return;
              setForceRefreshLoading(true);
              try {
                const current = loadSounds();
                const cleared = await forceCloudRefresh(current);
                invalidateAudioCache([]);
                dispatchSoundsChange(cleared);
                setSounds(cleared);
                setLastSync(null);
                void checkCloudVersion().then(info => { if (info) setVersionInfo(info); });
                setForceRefreshSync(true);
                setShowModal(true);
              } finally {
                setForceRefreshLoading(false);
              }
            }}
            style={{
              background: "rgba(255,255,255,0.6)",
              color: "rgba(60,50,45,0.6)",
              border: "1px solid rgba(60,50,45,0.15)",
              borderRadius: 9,
              padding: "8px 0",
              cursor: "pointer",
              fontSize: 13,
              opacity: forceRefreshLoading ? 0.6 : 1,
            }}
          >
            {forceRefreshLoading ? "清除中…" : "🔄 强制刷新（重新下载）"}
          </button>

          {hasSnapshot && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); handleRestore(); }}
              style={{
                background: "rgba(255,235,235,0.7)",
                color: "rgba(180,60,60,0.9)",
                border: "1px solid rgba(180,60,60,0.25)",
                borderRadius: 9,
                padding: "8px 0",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              ↩ 恢复到同步前的备份
            </button>
          )}

          {/* 服务器地址 + 一键重置（Electron 常驻显示） */}
          {window.electronAPI?.setApiBase && (
            <div style={{ marginTop: 4, padding: "8px 10px", background: "rgba(230,182,110,0.06)", borderRadius: 8, border: "1px solid rgba(230,182,110,0.18)" }}>
              <div style={{ fontSize: 11, color: "rgba(60,50,45,0.45)", marginBottom: 5, wordBreak: "break-all" }}>
                🔗 服务器：{apiBase || "（加载中…）"}
              </div>
              <button
                type="button"
                onClick={async () => {
                  const DEFAULT = API_BASE_URL;
                  await window.electronAPI!.setApiBase!(DEFAULT);
                  setApiBase(DEFAULT);
                  void doCheck();
                }}
                style={{
                  fontSize: 12, padding: "5px 12px",
                  background: "rgba(230,182,110,0.18)", color: "#c8882a",
                  border: "1px solid rgba(230,182,110,0.45)", borderRadius: 6,
                  cursor: "pointer", fontWeight: 600,
                }}
              >
                🔄 一键重置服务器地址并重试
              </button>
            </div>
          )}
        </div>
      </div>

      {showModal && versionInfo && (
        <CloudSyncModal
          versionInfo={versionInfo}
          currentSounds={sounds}
          forceRefreshAudio={forceRefreshSync}
          onClose={() => { setShowModal(false); setForceRefreshSync(false); }}
          onSynced={(newSounds) => {
            setSounds(newSounds);
            setShowModal(false);
            setForceRefreshSync(false);
            setLastSync(new Date().toISOString());
            setHasSnapshot(true);
            void checkCloudVersion().then(info => { if (info) setVersionInfo(info); });
          }}
        />
      )}
    </>
  );
}
