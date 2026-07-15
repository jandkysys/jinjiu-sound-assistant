import { useMemo } from "react";
import type { SoundItem } from "../lib/soundPack";
import type { DraftSound, PlayMode } from "../lib/batchImport";
import { findConflicts, reassignConflicts } from "../lib/batchImport";
import { renderMatchName } from "../lib/matchHighlight";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface Props {
  drafts: DraftSound[];
  existing: SoundItem[];
  sourceLabel: string;
  busy: boolean;
  onChange: (drafts: DraftSound[]) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function BatchImportModal({
  drafts, existing, sourceLabel, busy, onChange, onCancel, onConfirm,
}: Props) {
  const conflicts = useMemo(() => findConflicts(drafts, existing), [drafts, existing]);
  const totalBytes = useMemo(() => drafts.reduce((a, d) => a + d.sizeBytes, 0), [drafts]);
  const categories = useMemo(
    () => Array.from(new Set(drafts.map(d => d.category))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    [drafts],
  );
  const subCategories = useMemo(
    () => Array.from(new Set(drafts.map(d => d.subCategory).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    [drafts],
  );

  function patch(key: string, p: Partial<DraftSound>) {
    onChange(drafts.map(d => (d.key === key ? { ...d, ...p } : d)));
  }

  function handleReassign() {
    onChange(reassignConflicts(drafts, existing));
  }

  const labelStyle: React.CSSProperties = { color: "rgba(82,72,64,0.55)", fontSize: 12 };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(60,50,45,0.25)", backdropFilter: "blur(8px)" }}
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        className="glass-strong"
        style={{ borderRadius: 18, padding: 24, width: "min(920px, 94vw)", maxHeight: "88vh", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <div style={{ color: "var(--gold)", fontSize: 18, fontWeight: "bold" }}>批量导入预览</div>
          <div style={{ color: "rgba(82,72,64,0.55)", fontSize: 13 }}>{sourceLabel}</div>
        </div>
        <div style={{ color: "rgba(82,72,64,0.55)", fontSize: 13, marginBottom: 12 }}>
          共 <b style={{ color: "var(--gold)" }}>{drafts.length}</b> 个音效，
          {categories.length} 个场景分类{subCategories.length > 0 ? `·${subCategories.length} 个子分类` : ""}，合计 {formatBytes(totalBytes)}
          {conflicts.size > 0 && (
            <span style={{ color: "rgba(255,140,140,0.95)", marginLeft: 10 }}>
              · {conflicts.size} 个快捷键冲突
            </span>
          )}
        </div>

        {conflicts.size > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 12px", borderRadius: 10, background: "rgba(255,90,90,0.12)", border: "1px solid rgba(255,90,90,0.3)" }}>
            <span style={{ color: "rgba(255,170,170,0.95)", fontSize: 13, flex: 1 }}>
              检测到快捷键冲突（与现有音效或彼此重复），保存前请先解决。
            </span>
            <button className="btn gold-btn" onClick={handleReassign}>一键重新分配</button>
          </div>
        )}

        <div style={{ overflow: "auto", flex: 1, border: "1px solid rgba(60,50,45,0.12)", borderRadius: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, background: "rgba(255,255,255,0.95)", zIndex: 1 }}>
                {["音效名称", "场景分类", "子分类", "快捷键", "播放方式", "音量", ""].map((h, i) => (
                  <th key={i} style={{ textAlign: "left", padding: "10px 10px", color: "rgba(82,72,64,0.55)", fontWeight: "normal", borderBottom: "1px solid rgba(60,50,45,0.12)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drafts.map(d => {
                const bad = conflicts.has(d.key);
                return (
                  <tr key={d.key} style={{ borderBottom: "1px solid rgba(60,50,45,0.12)" }}>
                    <td style={{ padding: "6px 10px", minWidth: 150 }}>
                      <input className="inp" value={d.name} onChange={e => patch(d.key, { name: e.target.value })} style={{ width: "100%" }} />
                      {d.sourceName && d.name !== d.sourceName && (
                        <div style={{ display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap", marginTop: 2, fontSize: 11, color: "rgba(60,50,40,0.55)" }}>
                          <span style={{ opacity: 0.75 }}>源</span>
                          <span style={{ minWidth: 0, wordBreak: "break-all" }} title={d.sourceName}>{renderMatchName(d.sourceName, d.name)}</span>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "6px 10px", minWidth: 120 }}>
                      <input className="inp" value={d.category} list="jcb-batch-cats" onChange={e => patch(d.key, { category: e.target.value })} style={{ width: "100%" }} />
                      {d.sourceFolder && d.category !== d.sourceFolder && (
                        <div style={{ display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap", marginTop: 2, fontSize: 11, color: "rgba(60,50,40,0.55)" }}>
                          <span style={{ opacity: 0.75 }}>源</span>
                          <span style={{ minWidth: 0, wordBreak: "break-all" }} title={d.sourceFolder}>{renderMatchName(d.sourceFolder, d.category)}</span>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "6px 10px", minWidth: 110 }}>
                      <input className="inp" value={d.subCategory} list="jcb-batch-subs" placeholder="可留空" onChange={e => patch(d.key, { subCategory: e.target.value })} style={{ width: "100%" }} />
                      {d.sourceSubFolder && d.subCategory !== d.sourceSubFolder && (
                        <div style={{ display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap", marginTop: 2, fontSize: 11, color: "rgba(60,50,40,0.55)" }}>
                          <span style={{ opacity: 0.75 }}>源</span>
                          <span style={{ minWidth: 0, wordBreak: "break-all" }} title={d.sourceSubFolder}>{renderMatchName(d.sourceSubFolder, d.subCategory)}</span>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "6px 10px", width: 78 }}>
                      <input
                        className="inp"
                        value={d.shortcut}
                        maxLength={1}
                        onChange={e => patch(d.key, { shortcut: e.target.value.slice(-1).toLowerCase() })}
                        placeholder="—"
                        style={{ width: 54, textAlign: "center", borderColor: bad ? "rgba(255,90,90,0.7)" : undefined, background: bad ? "rgba(255,90,90,0.12)" : undefined }}
                        title={bad ? "快捷键冲突" : "单个字符，可留空"}
                      />
                    </td>
                    <td style={{ padding: "6px 10px", width: 96 }}>
                      <select className="inp" value={d.mode} onChange={e => patch(d.key, { mode: e.target.value as PlayMode })} style={{ cursor: "pointer" }}>
                        <option value="once">单次</option>
                        <option value="loop">循环</option>
                      </select>
                    </td>
                    <td style={{ padding: "6px 10px", width: 150 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="range" min={0} max={100} value={d.volume} onChange={e => patch(d.key, { volume: +e.target.value })} style={{ width: 90 }} />
                        <span style={{ ...labelStyle, width: 30 }}>{d.volume}%</span>
                      </div>
                    </td>
                    <td style={{ padding: "6px 10px", width: 40 }}>
                      <button
                        className="btn"
                        title="移除此条"
                        onClick={() => onChange(drafts.filter(x => x.key !== d.key))}
                        style={{ padding: "2px 8px", color: "rgba(255,150,150,0.9)" }}
                      >×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <datalist id="jcb-batch-cats">
            {Array.from(new Set([...categories, ...existing.map(s => s.category)])).map(c => <option key={c} value={c} />)}
          </datalist>
          <datalist id="jcb-batch-subs">
            {Array.from(new Set([...subCategories, ...existing.map(s => s.subCategory).filter(Boolean) as string[]])).map(c => <option key={c} value={c} />)}
          </datalist>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end", alignItems: "center" }}>
          {busy && <span style={{ color: "var(--gold)", fontSize: 13, marginRight: "auto" }}>正在保存…</span>}
          <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
          <button
            className="btn gold-btn"
            onClick={onConfirm}
            disabled={busy || drafts.length === 0 || conflicts.size > 0}
            title={conflicts.size > 0 ? "请先解决快捷键冲突" : "保存到音效库"}
          >保存 {drafts.length} 个音效</button>
        </div>
      </div>
    </div>
  );
}
