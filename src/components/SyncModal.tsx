/**
 * SyncModal — 一键同步弹窗
 * 打开即自动执行同步，显示步骤进度，完成后展示统计摘要。
 */
import { useEffect, useRef, useState } from "react";
import {
  executePreparedSync,
  prepareFullSync,
  type PreparedSync,
  type SyncProgressUpdate,
  type SyncStats,
} from "@/lib/syncService";
import type { ConflictResolution } from "@/lib/syncConflicts";
import type { SoundItem } from "@/lib/soundPack";
import SoundConflictDialog from "./SoundConflictDialog";

interface Props {
  sounds: SoundItem[];
  mainCats: string[];
  bgCats: string[];
  onClose: () => void;
}

export default function SyncModal({ sounds, mainCats, bgCats, onClose }: Props) {
  const [progress, setProgress] = useState<SyncProgressUpdate>({
    phase: "running",
    step: "正在初始化…",
  });
  const [stats, setStats]     = useState<SyncStats | null>(null);
  const [prepared, setPrepared] = useState<PreparedSync | null>(null);
  const [errExpanded, setErrExpanded] = useState(false);
  const hasRun = useRef(false);

  async function execute(preflight: PreparedSync, resolutions: Record<string, ConflictResolution>) {
    try {
      const result = await executePreparedSync(preflight, resolutions, p => setProgress(p));
      setStats(result);
      setPrepared(null);
      setProgress({ phase: "done", step: "同步完成" });
    } catch (error) {
      setPrepared(null);
      setProgress({
        phase: "error",
        step: "同步失败",
        detail: String(error instanceof Error ? error.message : error),
      });
    }
  }

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    prepareFullSync(sounds, mainCats, bgCats, p => setProgress(p))
      .then(preflight => {
        if (preflight.conflicts.length > 0) {
          setPrepared(preflight);
          setProgress({ phase: "running", step: "等待处理同名冲突…" });
          return;
        }
        void execute(preflight, {});
      })
      .catch((err: unknown) => {
        setProgress({
          phase: "error",
          step: "同步失败",
          detail: String(err instanceof Error ? err.message : err),
        });
      });
  }, [sounds, mainCats, bgCats]);

  const isDone  = progress.phase === "done";
  const isError = progress.phase === "error";

  if (prepared?.conflicts.length) {
    return (
      <SoundConflictDialog
        conflicts={prepared.conflicts}
        existingNames={[
          ...prepared.cloudSounds.map(sound => sound.name),
          ...prepared.local.map(item => item.sound.name),
        ]}
        onCancel={onClose}
        onConfirm={resolutions => void execute(prepared, resolutions)}
      />
    );
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(40,30,20,0.45)", backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          background: "rgba(252,246,238,0.97)",
          border: "1.5px solid rgba(230,182,110,0.45)",
          borderRadius: 18,
          boxShadow: "0 12px 48px rgba(100,70,30,0.22)",
          width: 420, maxWidth: "92vw",
          padding: "28px 30px 24px",
          fontFamily: "KaiTi, 楷体, serif",
        }}
      >
        {/* 标题栏 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: "rgba(80,55,25,0.92)", letterSpacing: 1 }}>
            {isDone ? "☁️ 同步完成" : isError ? "⚠️ 同步失败" : "☁️ 一键同步"}
          </span>
          {(isDone || isError) && (
            <button
              onClick={onClose}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontSize: 20, color: "rgba(120,90,50,0.6)", lineHeight: 1,
                padding: "2px 6px", borderRadius: 8,
              }}
              title="关闭"
            >×</button>
          )}
        </div>

        {/* 进行中 */}
        {!isDone && !isError && (
          <div style={{ minHeight: 120 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <SpinnerIcon />
              <span style={{ fontSize: 15, color: "rgba(80,55,25,0.88)" }}>{progress.step}</span>
            </div>

            {progress.detail && (
              <div style={{ fontSize: 13, color: "rgba(100,75,40,0.65)", marginLeft: 30, marginBottom: 8, wordBreak: "break-all" }}>
                {progress.detail}
              </div>
            )}

            {progress.progress && (
              <ProgressBar current={progress.progress.current} total={progress.progress.total} />
            )}

            <div style={{ marginTop: 18, fontSize: 12, color: "rgba(120,90,50,0.45)", textAlign: "center" }}>
              正在同步，请勿关闭页面…
            </div>
          </div>
        )}

        {/* 出错 */}
        {isError && (
          <div>
            <div style={{
              background: "rgba(200,60,50,0.07)", border: "1px solid rgba(200,60,50,0.2)",
              borderRadius: 10, padding: "12px 16px", fontSize: 14,
              color: "rgba(150,40,30,0.85)", marginBottom: 18,
            }}>
              {progress.detail ?? "未知错误"}
            </div>
            <div style={{ textAlign: "right" }}>
              <button
                className="btn gold-btn"
                onClick={onClose}
                style={{ padding: "6px 22px", fontSize: 14 }}
              >关闭</button>
            </div>
          </div>
        )}

        {/* 完成摘要 */}
        {isDone && stats && (
          <div>
            <div style={{
              background: "rgba(230,182,110,0.10)",
              border: "1px solid rgba(230,182,110,0.30)",
              borderRadius: 12, padding: "14px 18px",
              marginBottom: 16, display: "grid",
              gridTemplateColumns: "1fr 1fr", gap: "10px 20px",
            }}>
              <StatRow icon="✅" label="新增上传" count={stats.added} color="#3a7a3a" />
              <StatRow icon="✏️" label="元数据更新" count={stats.updated} color="#5a5a20" />
              <StatRow icon="📁" label="分类移动" count={stats.categoryMoved} color="#5a3a10" />
              <StatRow icon="⏭️" label="无变化跳过" count={stats.skipped} color="#5a5a5a" />
              <StatRow icon="❌" label="处理失败" count={stats.failed} color={stats.failed > 0 ? "#c03030" : "#5a5a5a"} />
            </div>

            {stats.errors.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <button
                  onClick={() => setErrExpanded(v => !v)}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: 13, color: "rgba(150,60,40,0.80)",
                    display: "flex", alignItems: "center", gap: 5, padding: 0,
                  }}
                >
                  <span>{errExpanded ? "▼" : "▶"}</span>
                  <span>查看失败详情（{stats.errors.length} 条）</span>
                </button>
                {errExpanded && (
                  <div style={{
                    marginTop: 8, maxHeight: 150, overflowY: "auto",
                    background: "rgba(200,50,30,0.05)", borderRadius: 8,
                    border: "1px solid rgba(200,50,30,0.15)", padding: "8px 12px",
                  }}>
                    {stats.errors.map((e, i) => (
                      <div key={i} style={{ fontSize: 12, color: "rgba(120,40,30,0.85)", marginBottom: 4 }}>
                        <span style={{ fontWeight: 600 }}>{e.name}</span>
                        {" — "}
                        <span>{e.error}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ textAlign: "right" }}>
              <button
                className="btn gold-btn"
                onClick={onClose}
                style={{ padding: "6px 28px", fontSize: 14 }}
              >关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 小组件 ─────────────────────────────────────────────────────────────────────

function SpinnerIcon() {
  return (
    <span
      style={{
        display: "inline-block", width: 18, height: 18, flexShrink: 0,
        border: "2.5px solid rgba(230,182,110,0.35)",
        borderTopColor: "rgba(230,182,110,0.90)",
        borderRadius: "50%",
        animation: "sync-spin 0.8s linear infinite",
      }}
    />
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return (
    <div>
      <div style={{
        height: 6, borderRadius: 4,
        background: "rgba(230,182,110,0.20)",
        overflow: "hidden", marginBottom: 4,
      }}>
        <div style={{
          height: "100%", borderRadius: 4,
          background: "linear-gradient(90deg,rgba(230,182,110,0.80),rgba(200,140,70,0.90))",
          width: `${pct}%`, transition: "width 0.3s ease",
        }} />
      </div>
      <div style={{ fontSize: 12, color: "rgba(100,75,40,0.60)", textAlign: "right" }}>
        {current} / {total}
      </div>
    </div>
  );
}

function StatRow({ icon, label, count, color }: { icon: string; label: string; count: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 15 }}>{icon}</span>
      <span style={{ fontSize: 13, color: "rgba(80,55,25,0.70)", flex: 1 }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 700, color, minWidth: 28, textAlign: "right" }}>{count}</span>
    </div>
  );
}
