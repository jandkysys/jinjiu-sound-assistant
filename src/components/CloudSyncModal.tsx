import { useState, useCallback, useEffect } from "react";
import { dispatchSoundsChange, invalidateAudioCache } from "../lib/useSoundEngine";
import { safeSaveSounds } from "../lib/soundPack";
import type { SoundItem } from "../lib/soundPack";
import {
  type SyncMode,
  type SyncScope,
  type SyncProgress,
  type SyncResult,
  type CategoryTree,
  type CloudVersionInfo,
  syncCloudLibrary,
  fetchManifestCategories,
  preDownloadSounds,
  getCacheStats,
  saveCloudVersion,
  saveLastSyncTime,
  snapshotPreSync,
} from "../lib/cloudSync";

interface Props {
  versionInfo: CloudVersionInfo;
  currentSounds: SoundItem[];
  onClose: () => void;
  onSynced: (sounds: SoundItem[]) => void;
  forceRefreshAudio?: boolean;
}

type Step = "confirm" | "syncing" | "done" | "error";

const phaseLabel: Record<SyncProgress["phase"], string> = {
  fetching:    "正在获取云端音效列表…",
  downloading: "正在下载音频文件…",
  merging:     "正在合并数据…",
  done:        "完成",
};

const SYNC_MODES: { value: SyncMode; label: string; desc: string }[] = [
  {
    value: "merge",
    label: "合并更新（推荐）",
    desc: "新增/更新云端音效，本地自定义音效完整保留；云端已移除的旧音效会从本地删除",
  },
  {
    value: "addOnly",
    label: "仅新增",
    desc: "只下载本地还没有的音效，已有的音效保持原样不变",
  },
  {
    value: "overwrite",
    label: "覆盖当前范围",
    desc: "先清除所选范围的本地云端音效，再完整导入；本地自定义音效不受影响",
  },
  {
    value: "skip",
    label: "跳过不下载",
    desc: "不下载任何内容，仅记录已检查更新",
  },
];

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ScopePicker({
  tree,
  scope,
  onChange,
}: {
  tree: CategoryTree | null;
  scope: SyncScope;
  onChange: (s: SyncScope) => void;
}) {
  if (!tree) {
    return (
      <div style={{ fontSize: 12, color: "rgba(60,50,45,0.4)", padding: "8px 0" }}>
        加载分类列表中…
      </div>
    );
  }

  const totalCount = tree.primaryCategories.reduce((a, p) => a + p.totalSoundCount, 0);

  const radioStyle: React.CSSProperties = {
    accentColor: "var(--gold, #E6B66E)",
    cursor: "pointer",
  };
  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 10px",
    borderRadius: 8,
    background: active ? "rgba(230,182,110,0.10)" : "transparent",
    cursor: "pointer",
    fontSize: 13,
    color: "var(--text-main, #3c3228)",
    border: `1px solid ${active ? "rgba(230,182,110,0.40)" : "transparent"}`,
    marginBottom: 2,
    transition: "all 0.12s",
  });

  return (
    <div style={{
      maxHeight: 200, overflowY: "auto",
      border: "1px solid rgba(230,182,110,0.20)",
      borderRadius: 10, padding: "6px 8px",
      background: "rgba(255,255,255,0.4)",
    }}>
      <label style={rowStyle(scope.type === "all")}>
        <input
          type="radio" style={radioStyle}
          checked={scope.type === "all"}
          onChange={() => onChange({ type: "all" })}
        />
        <span style={{ flex: 1 }}>全部云端音效</span>
        <span style={{ fontSize: 12, color: "rgba(60,50,45,0.45)" }}>{totalCount} 条</span>
      </label>

      {tree.primaryCategories.map(pc => (
        <div key={pc.name}>
          <label style={rowStyle(scope.type === "primaryCat" && scope.name === pc.name)}>
            <input
              type="radio" style={radioStyle}
              checked={scope.type === "primaryCat" && scope.name === pc.name}
              onChange={() => onChange({ type: "primaryCat", name: pc.name })}
            />
            <span style={{ flex: 1, fontWeight: 500 }}>{pc.name}</span>
            <span style={{ fontSize: 12, color: "rgba(60,50,45,0.45)" }}>{pc.totalSoundCount} 条</span>
          </label>

          {pc.subcategories.map(sc => (
            <label
              key={sc.name}
              style={{
                ...rowStyle(
                  scope.type === "subCat" &&
                  scope.primaryName === pc.name &&
                  scope.subName === sc.name,
                ),
                paddingLeft: 28,
              }}
            >
              <input
                type="radio" style={radioStyle}
                checked={
                  scope.type === "subCat" &&
                  scope.primaryName === pc.name &&
                  scope.subName === sc.name
                }
                onChange={() =>
                  onChange({ type: "subCat", primaryName: pc.name, subName: sc.name })
                }
              />
              <span style={{ fontSize: 12, color: "rgba(60,50,45,0.6)", marginRight: 2 }}>└</span>
              <span style={{ flex: 1 }}>{sc.name}</span>
              <span style={{ fontSize: 12, color: "rgba(60,50,45,0.45)" }}>{sc.soundCount} 条</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function CloudSyncModal({
  versionInfo,
  currentSounds,
  onClose,
  onSynced,
  forceRefreshAudio,
}: Props) {
  const [step, setStep] = useState<Step>("confirm");
  const [syncScope, setSyncScope] = useState<SyncScope>({ type: "all" });
  const [syncMode, setSyncMode] = useState<SyncMode>("merge");
  const [categoryTree, setCategoryTree] = useState<CategoryTree | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [syncedSounds, setSyncedSounds] = useState<SoundItem[]>(currentSounds);

  const [preDownloading, setPreDownloading] = useState(false);
  const [preDlDone, setPreDlDone] = useState(0);
  const [preDlTotal, setPreDlTotal] = useState(0);
  const [preDlFailed, setPreDlFailed] = useState(0);
  const [preDlFinished, setPreDlFinished] = useState(false);

  useEffect(() => {
    void fetchManifestCategories().then(tree => {
      if (tree) setCategoryTree(tree);
    });
  }, []);

  const handleSync = useCallback(async () => {
    setStep("syncing");
    setProgress({ phase: "fetching", done: 0, total: 0 });
    snapshotPreSync(currentSounds);
    const startTime = new Date().toISOString();
    console.log(`[CloudSync] ▶ 开始同步 ${startTime}，本地音效 ${currentSounds.length} 条，范围=${JSON.stringify(syncScope)}，模式=${syncMode}`);
    try {
      const { sounds, result: syncResult, version } = await syncCloudLibrary(
        currentSounds,
        (p) => {
          setProgress(p);
          if (p.phase === "merging" && p.currentName) {
            console.log(`[CloudSync] 合并 ${p.done}/${p.total}: ${p.currentName}`);
          }
        },
        {
          syncScope,
          syncMode,
          forceRefreshAudio,
          strategy: "cloud_only",
        },
      );
      const saveResult = safeSaveSounds(sounds);
      if (!saveResult.ok) {
        console.error("[CloudSync] ✗ 保存失败:", saveResult);
        throw new Error("本地保存失败，请检查存储空间");
      }
      invalidateAudioCache([]);
      dispatchSoundsChange(sounds);
      saveCloudVersion(version);
      saveLastSyncTime();
      setSyncedSounds(sounds);
      setResult(syncResult);
      console.log(`[CloudSync] ✓ 同步完成 v${version}，新增=${syncResult.added} 更新=${syncResult.updated} 移除=${syncResult.removed} 跳过=${syncResult.skipped}`);
      // ⚠️ 不在此处调用 onSynced —— onSynced 会立即关闭 modal，导致 done 页面从未显示。
      // 正确做法：由用户点击「完成」按钮触发 onSynced。
      setStep("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "同步失败，请检查网络连接";
      console.error("[CloudSync] ✗ 同步错误:", e);
      setErrorMsg(msg);
      setStep("error");
    }
  }, [currentSounds, syncScope, syncMode, forceRefreshAudio]);

  const handlePreDownload = useCallback(async (filter: "all" | "favorites") => {
    setPreDownloading(true);
    setPreDlDone(0); setPreDlTotal(0); setPreDlFailed(0); setPreDlFinished(false);
    try {
      const { sounds: updated, done, failed } = await preDownloadSounds(
        syncedSounds,
        filter,
        (d, t, _n, f) => { setPreDlDone(d); setPreDlTotal(t); setPreDlFailed(f); },
      );
      const cache = await getCacheStats();
      setResult(prev => prev ? { ...prev, cacheBytes: cache.bytes } : prev);
      safeSaveSounds(updated);
      dispatchSoundsChange(updated);
      setSyncedSounds(updated);
      setPreDlDone(done); setPreDlFailed(failed); setPreDlFinished(true);
    } finally {
      setPreDownloading(false);
    }
  }, [syncedSounds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pct = progress
    ? progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : progress.phase === "fetching" ? 10 : progress.phase === "merging" ? 95 : 100
    : 0;

  const uncachedCount = syncedSounds.filter(
    s => s.source === "cloud" && !s.hasAudio && !s.isCloudDisabled && s.cloudUrl,
  ).length;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(40,30,20,0.45)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={e => { if (e.target === e.currentTarget && step !== "syncing") onClose(); }}
    >
      <div
        style={{
          background: "var(--glass-bg, rgba(255,250,243,0.96))",
          border: "1.5px solid rgba(230,182,110,0.35)",
          borderRadius: 18,
          boxShadow: "0 8px 40px rgba(40,30,20,0.18)",
          padding: "32px 36px",
          minWidth: 380,
          maxWidth: 520,
          width: "92vw",
          maxHeight: "90dvh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <span style={{ fontSize: 22 }}>☁️</span>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--gold, #E6B66E)" }}>
            {forceRefreshAudio ? "强制刷新云端音效库" : "云端音效库同步"}
          </h2>
        </div>

        {step === "confirm" && (
          <>
            {forceRefreshAudio && (
              <div style={{
                background: "rgba(229,115,115,0.08)", border: "1px solid rgba(229,115,115,0.30)",
                borderRadius: 10, padding: "10px 14px", marginBottom: 14,
                fontSize: 13, color: "rgba(180,60,60,0.85)", lineHeight: 1.6,
              }}>
                🔄 强制刷新模式：已清除本地云端音效缓存，音频将在首次播放时自动重新下载。
              </div>
            )}

            <div style={{
              background: "rgba(230,182,110,0.07)", borderRadius: 10,
              padding: "12px 14px", marginBottom: 16,
            }}>
              <div style={{ color: "rgba(60,50,45,0.75)", fontSize: 14, lineHeight: 1.8, marginBottom: 8 }}>
                <div>
                  云端版本 <strong style={{ color: "var(--gold)" }}>v{versionInfo.version}</strong>
                  {versionInfo.publishedAt && (
                    <span style={{ color: "rgba(60,50,45,0.5)", fontSize: 12, marginLeft: 8 }}>
                      {new Date(versionInfo.publishedAt).toLocaleDateString("zh-CN")}
                    </span>
                  )}
                </div>
                {versionInfo.storedVersion > 0 && (
                  <div style={{ fontSize: 12, color: "rgba(60,50,45,0.5)" }}>
                    本地已同步 v{versionInfo.storedVersion}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {(() => {
                  const cloudCount = currentSounds.filter(s => s.source === "cloud").length;
                  const localCount = currentSounds.filter(s => s.source !== "cloud").length;
                  return (
                    <>
                      <span style={{ fontSize: 12, color: "rgba(60,50,45,0.55)" }}>
                        ☁ 本地云端音效 <strong style={{ color: "var(--gold)" }}>{cloudCount}</strong> 条
                      </span>
                      <span style={{ fontSize: 12, color: "rgba(60,50,45,0.55)" }}>
                        🎵 本地自定义 <strong style={{ color: "rgba(60,50,45,0.75)" }}>{localCount}</strong> 条（保留不变）
                      </span>
                    </>
                  );
                })()}
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: "rgba(60,50,45,0.6)", marginBottom: 8, fontWeight: 600 }}>
                同步范围
              </div>
              <ScopePicker tree={categoryTree} scope={syncScope} onChange={setSyncScope} />
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, color: "rgba(60,50,45,0.6)", marginBottom: 10, fontWeight: 600 }}>
                同步方式
              </div>
              {SYNC_MODES.map(m => (
                <label
                  key={m.value}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "10px 14px", borderRadius: 10,
                    background: syncMode === m.value ? "rgba(230,182,110,0.12)" : "rgba(255,255,255,0.35)",
                    border: `1.5px solid ${syncMode === m.value ? "rgba(230,182,110,0.55)" : "rgba(60,50,45,0.10)"}`,
                    cursor: "pointer", marginBottom: 8, transition: "all 0.15s",
                  }}
                >
                  <input
                    type="radio" name="syncMode" value={m.value}
                    checked={syncMode === m.value}
                    onChange={() => setSyncMode(m.value)}
                    style={{ marginTop: 2, accentColor: "var(--gold)" }}
                  />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main, #3c3228)" }}>
                      {m.label}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(60,50,45,0.55)", marginTop: 2, lineHeight: 1.6 }}>
                      {m.desc}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <div style={{
              fontSize: 12, color: "rgba(60,50,45,0.5)",
              background: "rgba(60,50,45,0.04)", borderRadius: 8, padding: "8px 12px",
              marginBottom: 18, lineHeight: 1.6,
            }}>
              💡 同步采用懒加载：音频文件在首次播放时自动下载并缓存，无需等待全量下载。<br />
              同步前会自动备份当前配置，可在设置页点击「恢复到同步前」还原。
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={onClose}>取消</button>
              <button type="button" className="btn gold-btn" onClick={(e) => { e.preventDefault(); void handleSync(); }}>开始同步</button>
            </div>
          </>
        )}

        {step === "syncing" && progress && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14, color: "rgba(60,50,45,0.75)", marginBottom: 16 }}>
              {phaseLabel[progress.phase]}
              {progress.currentName && (
                <div style={{ fontSize: 12, color: "rgba(60,50,45,0.5)", marginTop: 4, fontFamily: "monospace" }}>
                  {progress.currentName}
                </div>
              )}
            </div>
            <div style={{ background: "rgba(60,50,45,0.08)", borderRadius: 8, height: 8, overflow: "hidden", marginBottom: 10 }}>
              <div style={{
                background: "var(--gold, #E6B66E)", height: "100%",
                width: `${pct}%`, borderRadius: 8, transition: "width 0.3s ease",
              }} />
            </div>
            <div style={{ fontSize: 12, color: "rgba(60,50,45,0.5)" }}>
              {progress.total > 0 ? `${progress.done} / ${progress.total}` : "请稍候…"}
            </div>
          </div>
        )}

        {step === "done" && result && (
          <>
            <div style={{
              background: "rgba(230,182,110,0.07)", borderRadius: 10,
              padding: "10px 14px", marginBottom: 14,
              display: "flex", alignItems: "center", gap: 8, fontSize: 14,
            }}>
              <span style={{ color: "rgba(60,50,45,0.5)", fontSize: 13 }}>
                {result.localVersion > 0 ? `v${result.localVersion}` : "未同步"}
              </span>
              <span style={{ color: "rgba(60,50,45,0.3)" }}>→</span>
              <strong style={{ color: "var(--gold, #E6B66E)" }}>v{result.version}</strong>
              <span style={{ fontSize: 12, color: "#4CAF50", fontWeight: 600, marginLeft: 4 }}>✓ 已同步</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
              {[
                { label: "新增", value: result.added, color: "#4CAF50" },
                { label: "更新", value: result.updated, color: "var(--gold)" },
                { label: "跳过", value: result.skipped, color: "rgba(60,50,45,0.4)" },
                { label: "移除", value: result.removed, color: "rgba(60,50,45,0.5)" },
              ].map(item => (
                <div key={item.label} style={{
                  padding: "10px 8px", textAlign: "center",
                  background: "rgba(255,255,255,0.5)",
                  borderRadius: 10, border: "1px solid rgba(60,50,45,0.08)",
                }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: item.color }}>{item.value}</div>
                  <div style={{ fontSize: 11, color: "rgba(60,50,45,0.55)", marginTop: 2 }}>{item.label}</div>
                </div>
              ))}
            </div>

            {(result.newPrimaryCats.length > 0 || result.newSubCats.length > 0) && (
              <div style={{
                fontSize: 12, color: "rgba(60,50,45,0.7)",
                background: "rgba(76,175,80,0.06)",
                border: "1px solid rgba(76,175,80,0.20)",
                borderRadius: 8, padding: "8px 12px", marginBottom: 12, lineHeight: 1.8,
              }}>
                🗂 已自动注册新分类：
                {result.newPrimaryCats.length > 0 && (
                  <span> 一级分类 <strong style={{ color: "#4CAF50" }}>{result.newPrimaryCats.length}</strong> 个</span>
                )}
                {result.newPrimaryCats.length > 0 && result.newSubCats.length > 0 && "，"}
                {result.newSubCats.length > 0 && (
                  <span> 二级分类 <strong style={{ color: "#4CAF50" }}>{result.newSubCats.length}</strong> 个</span>
                )}
              </div>
            )}

            {result.disabled > 0 && (
              <div style={{
                fontSize: 12, color: "rgba(180,60,60,0.8)",
                background: "rgba(229,115,115,0.06)",
                border: "1px solid rgba(229,115,115,0.18)",
                borderRadius: 8, padding: "8px 12px", marginBottom: 12, lineHeight: 1.6,
              }}>
                ⚠️ 有 <strong>{result.disabled}</strong> 条音效已被后台禁用，不会在音效列表中显示。
              </div>
            )}

            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 12, color: "rgba(60,50,45,0.5)",
              background: "rgba(60,50,45,0.04)", borderRadius: 8, padding: "7px 12px",
              marginBottom: uncachedCount > 0 ? 12 : 16,
            }}>
              <span>💾 本地缓存</span>
              <strong style={{ color: "rgba(60,50,45,0.7)" }}>{fmtBytes(result.cacheBytes)}</strong>
              {uncachedCount > 0 && (
                <span style={{ marginLeft: "auto" }}>还有 <strong>{uncachedCount}</strong> 条未缓存</span>
              )}
            </div>

            {uncachedCount > 0 && !preDlFinished && (
              <div style={{
                background: "rgba(230,182,110,0.07)", border: "1px solid rgba(230,182,110,0.25)",
                borderRadius: 10, padding: "12px 14px", marginBottom: 16,
              }}>
                <div style={{ fontSize: 13, color: "rgba(60,50,45,0.7)", marginBottom: 10, lineHeight: 1.6 }}>
                  音频懒加载：播放时自动下载缓存。可选择现在预下载，之后无需等待：
                </div>
                {preDownloading ? (
                  <>
                    <div style={{ background: "rgba(60,50,45,0.08)", borderRadius: 6, height: 6, overflow: "hidden", marginBottom: 8 }}>
                      <div style={{
                        background: "var(--gold, #E6B66E)", height: "100%",
                        width: preDlTotal > 0 ? `${Math.round((preDlDone / preDlTotal) * 100)}%` : "5%",
                        borderRadius: 6, transition: "width 0.3s ease",
                      }} />
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(60,50,45,0.5)" }}>
                      {preDlTotal > 0
                        ? `正在下载 ${preDlDone} / ${preDlTotal}${preDlFailed > 0 ? `（失败 ${preDlFailed}）` : ""}`
                        : "准备中…"}
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn gold-btn" style={{ fontSize: 12, padding: "5px 12px" }}
                      onClick={(e) => { e.preventDefault(); void handlePreDownload("all"); }}
                    >
                      ⬇ 预下载全部（{uncachedCount} 条）
                    </button>
                    {syncedSounds.some(s => s.source === "cloud" && !s.hasAudio && s.favorite) && (
                      <button
                        type="button"
                        className="btn" style={{ fontSize: 12, padding: "5px 12px" }}
                        onClick={(e) => { e.preventDefault(); void handlePreDownload("favorites"); }}
                      >
                        ⭐ 仅收藏
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {preDlFinished && (
              <div style={{
                fontSize: 12, color: "#4CAF50", background: "rgba(76,175,80,0.07)",
                borderRadius: 8, padding: "8px 12px", marginBottom: 16, lineHeight: 1.6,
              }}>
                ✓ 预下载完成：{preDlDone} 条已缓存{preDlFailed > 0 ? `，${preDlFailed} 条失败` : ""}。
              </div>
            )}

            <div style={{ fontSize: 12, color: "rgba(60,50,45,0.4)", marginBottom: 16, lineHeight: 1.6 }}>
              如需还原，可在设置页点击「恢复到同步前」。
            </div>
            <div style={{ textAlign: "center" }}>
              <button
                type="button"
                className="btn gold-btn"
                onClick={() => {
                  // 在用户主动关闭时才通知父组件更新并关闭 modal，
                  // 避免 handleSync 里提前关闭导致 done 页面无法显示（闪断）。
                  onSynced(syncedSounds);
                }}
              >
                ✓ 完成
              </button>
            </div>
          </>
        )}

        {step === "error" && (
          <>
            <div style={{
              fontSize: 14, color: "rgba(180,80,80,0.9)",
              background: "rgba(255,200,200,0.25)", borderRadius: 10, padding: "14px 16px",
              marginBottom: 20, lineHeight: 1.7,
            }}>
              ⚠️ {errorMsg}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={onClose}>关闭</button>
              <button type="button" className="btn gold-btn" onClick={() => setStep("confirm")}>重试</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
