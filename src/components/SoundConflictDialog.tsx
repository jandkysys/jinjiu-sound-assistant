import { useEffect, useMemo, useState } from "react";
import {
  validateSaveAsName,
  type ConflictResolution,
  type SyncConflict,
} from "../lib/syncConflicts";

interface Props {
  conflicts: SyncConflict[];
  existingNames: string[];
  onCancel: () => void;
  onConfirm: (resolutions: Record<string, ConflictResolution>) => void;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function SoundConflictDialog({ conflicts, existingNames, onCancel, onConfirm }: Props) {
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({});

  useEffect(() => setResolutions({}), [conflicts]);

  const errors = useMemo(() => {
    const result: Record<string, string | null> = {};
    for (const conflict of conflicts) {
      const resolution = resolutions[conflict.key];
      if (resolution?.action !== "save-as") continue;
      const otherNames = new Set(existingNames);
      for (const [key, other] of Object.entries(resolutions)) {
        if (key !== conflict.key && other.action === "save-as") otherNames.add(other.name);
      }
      result[conflict.key] = validateSaveAsName(resolution.name, otherNames);
    }
    return result;
  }, [conflicts, existingNames, resolutions]);

  const canConfirm = conflicts.length > 0 && conflicts.every(conflict => {
    const resolution = resolutions[conflict.key];
    return resolution?.action === "keep-cloud" || (resolution?.action === "save-as" && !errors[conflict.key]);
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10020, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(30,22,15,.52)", padding: 20 }}>
      <div style={{ width: 680, maxWidth: "96vw", maxHeight: "88vh", overflow: "auto", borderRadius: 16, background: "#fffaf3", border: "1px solid rgba(188,132,62,.35)", boxShadow: "0 18px 60px rgba(50,30,10,.28)", padding: 24 }}>
        <h3 style={{ margin: "0 0 8px", color: "#69451f" }}>发现同名音效冲突</h3>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#806747", lineHeight: 1.6 }}>
          云端已经存在同名但内容不同或哈希未知的音效。请选择保留云端，或使用唯一名称另存为新音效。
        </p>
        <p style={{ margin: "0 0 18px", fontSize: 12, color: "#9a7446" }}>
          命名示例：A-欢迎掌声、B-PK欢呼，或 场景-用途-名称
        </p>

        {conflicts.map(conflict => {
          const resolution = resolutions[conflict.key];
          const saveAs = resolution?.action === "save-as" ? resolution.name : "";
          return (
            <div key={conflict.key} style={{ marginBottom: 14, border: "1px solid rgba(188,132,62,.25)", borderRadius: 12, padding: 14, background: "rgba(255,255,255,.68)" }}>
              <div style={{ fontWeight: 700, color: "#5d3d1b", marginBottom: 7 }}>{conflict.localName}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12, color: "#786044", marginBottom: 12 }}>
                <div>本地：{formatSize(conflict.localFileSize)} · {conflict.localHash.slice(0, 8)}</div>
                <div>云端：{formatSize(conflict.cloudFileSize)} · {conflict.cloudHash?.replace(/^sha-?256:/i, "").slice(0, 8) || "哈希未知"}</div>
              </div>

              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 9, cursor: "pointer" }}>
                <input
                  type="radio"
                  name={`resolution-${conflict.key}`}
                  checked={resolution?.action === "keep-cloud"}
                  onChange={() => setResolutions(previous => ({ ...previous, [conflict.key]: { action: "keep-cloud" } }))}
                />
                保留云端（本地这条不上传）
              </label>

              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                <input
                  type="radio"
                  name={`resolution-${conflict.key}`}
                  checked={resolution?.action === "save-as"}
                  onChange={() => setResolutions(previous => ({
                    ...previous,
                    [conflict.key]: { action: "save-as", name: `${conflict.localName}-新音效` },
                  }))}
                />
                另存为新音效
              </label>
              {resolution?.action === "save-as" && (
                <div style={{ margin: "8px 0 0 26px" }}>
                  <input
                    className="inp"
                    value={saveAs}
                    onChange={event => setResolutions(previous => ({
                      ...previous,
                      [conflict.key]: { action: "save-as", name: event.target.value },
                    }))}
                    placeholder="请输入唯一名称"
                    style={{ width: "min(360px, 100%)" }}
                  />
                  {errors[conflict.key] && <div style={{ color: "#b84232", fontSize: 12, marginTop: 4 }}>{errors[conflict.key]}</div>}
                </div>
              )}

              <button disabled title="需要后台原子替换接口，当前版本不可用" style={{ marginTop: 10, fontSize: 12, opacity: .5 }}>
                覆盖云端（当前不可用）
              </button>
              <span style={{ marginLeft: 8, fontSize: 11, color: "#a17c50" }}>需要后台原子替换接口，当前版本不可用</span>
            </div>
          );
        })}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          <button className="btn" onClick={onCancel}>取消，不做任何更改</button>
          <button className="btn gold-btn" disabled={!canConfirm} onClick={() => canConfirm && onConfirm(resolutions)}>
            确认并继续
          </button>
        </div>
      </div>
    </div>
  );
}
