/**
 * CloudManageTab — 管理员专用云端管理面板
 * 分类 CRUD + 音效上传 + 一键发布
 * 使用 adminAuthHeader() 调用 /api/cloud/admin/* 端点
 */
import { useState, useEffect, useRef } from "react";
import { getApiBase } from "@/lib/apiConfig";
import { adminAuthHeader } from "@/lib/auth";
import { getPersisted } from "../lib/persist";
import {
  prepareCloudUpload,
  sha256Hex,
  type CloudUploadDescriptor,
} from "../lib/audioUploadPolicy";
import {
  classifyNameMatch,
  normalizeSoundName,
  type ConflictResolution,
  type SyncConflict,
} from "../lib/syncConflicts";
import SoundConflictDialog from "./SoundConflictDialog";
import SyncModal from "./SyncModal";
import type { SoundItem } from "../lib/soundPack";

// ── 本地数据读取 ──────────────────────────────────────────────────────────────

interface LocalSound {
  id: string;
  name: string;
  type: string;
  category: string;
  subCategory?: string;
  loop: boolean;
  volume: number;
  mine?: boolean;
  source?: string;
}

function readLocalCats(): { main: string[]; bg: string[] } {
  function parse(key: string, fb: string[]): string[] {
    try { const r = getPersisted(key); if (r) { const a = JSON.parse(r) as unknown; if (Array.isArray(a)) return a as string[]; } } catch {}
    return fb;
  }
  return {
    main: parse("jt_sound_main_cats", ["短音效"]),
    bg: parse("jt_sound_bg_cats", ["PK音乐", "背景音乐"]),
  };
}

function readLocalSounds(): LocalSound[] {
  try {
    const r = getPersisted("jt_sounds");
    if (r) { const a = JSON.parse(r) as unknown; if (Array.isArray(a)) return a as LocalSound[]; }
  } catch {}
  return [];
}

interface CloudCat {
  id: number;
  name: string;
  appScope: string;
  level: number;
  parentId: number | null;
  isSystem: boolean;
  isEnabled: boolean;
  sortOrder: number;
  soundCount: number;
}

/** Electron IPC 代理（返回 Response 形态对象，绕过 file:// CORS）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _eAPI = (): any => (typeof window !== "undefined" ? (window as any).electronAPI : undefined);

async function cloudFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = adminAuthHeader();
  if (!headers) throw new Error("无管理员 token，请重新登录");

  const eAPI = _eAPI();

  // ── Electron + FormData：multipart 文件上传 ─────────────────────────────
  if (opts.body instanceof FormData && eAPI?.apiUploadFile) {
    const fd = opts.body;
    const fileField = fd.get("file") as File | null;
    if (!fileField) throw new Error("无文件字段");

    // 读取文件为 base64
    const base64Data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(fileField);
    });

    const extraFields: Record<string, string> = {};
    for (const [k, v] of fd.entries()) {
      if (k !== "file" && typeof v === "string") extraFields[k] = v;
    }

    const result = await eAPI.apiUploadFile(path, {
      fieldName: "file",
      base64Data,
      filename: fileField.name,
      contentType: fileField.type || "audio/mpeg",
      extraFields,
      headers,
    });

    return {
      ok:   result.ok,
      status: result.status,
      json: async () => result.data,
      text: async () => (typeof result.data === "string" ? result.data : JSON.stringify(result.data)),
    } as unknown as Response;
  }

  // ── Electron + JSON/GET：通过 apiFetch IPC ──────────────────────────────
  if (!(opts.body instanceof FormData) && eAPI?.apiFetch) {
    const combinedHeaders = {
      "Content-Type": "application/json",
      ...headers,
      ...(opts.headers as Record<string, string> | undefined ?? {}),
    };
    const result = await eAPI.apiFetch(path, {
      method: (opts.method ?? "GET") as string,
      headers: combinedHeaders,
      body: (opts.body as string | null) ?? null,
    });
    return {
      ok:   result.ok,
      status: result.status,
      json: async () => result.data,
      text: async () => (typeof result.data === "string" ? result.data : JSON.stringify(result.data)),
    } as unknown as Response;
  }

  // ── Web 路径：正常 fetch ─────────────────────────────────────────────────
  const base = getApiBase();
  // FormData 上传不能设 Content-Type（浏览器自动带 boundary）
  const fetchHeaders = opts.body instanceof FormData
    ? { ...headers }
    : { ...headers, ...(opts.headers as Record<string, string> | undefined) };
  return fetch(`${base}${path}`, { ...opts, headers: fetchHeaders });
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await cloudFetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── 分类管理 ──────────────────────────────────────────────────────────────────

function CatsPanel() {
  const [cats, setCats] = useState<CloudCat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<CloudCat[]>("/api/cloud/admin/categories");
      // 只显示 sound_assistant / both 范围的一级分类
      setCats(data.filter(c => (c.appScope === "sound_assistant" || c.appScope === "both") && c.level === 1));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function addCat() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await apiFetch("/api/cloud/admin/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, appScope: "sound_assistant", level: 1 }),
      });
      setNewName("");
      await load();
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  }

  async function deleteCat(cat: CloudCat) {
    if (!confirm(`删除云端分类「${cat.name}」？${cat.soundCount > 0 ? `含 ${cat.soundCount} 个音效将移至未分类。` : ""}`)) return;
    setBusy(true);
    try {
      const res = await cloudFetch(`/api/cloud/admin/categories/${cat.id}`, { method: "DELETE" });
      if (res.status === 409) {
        // Has children/sounds — confirm with cascade
        const ok = confirm(`分类下还有内容，确定强制删除（音效移至未分类）？`);
        if (!ok) { setBusy(false); return; }
        await apiFetch(`/api/cloud/admin/categories/${cat.id}/confirm-delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strategy: "move_to_uncat" }),
        });
      } else if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  }

  async function commitRename() {
    if (!renaming) return;
    const name = renameVal.trim();
    if (!name || name === renaming.name) { setRenaming(null); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/cloud/admin/categories/${renaming.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setRenaming(null);
      await load();
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  }

  async function syncLocalCats() {
    setSyncing(true);
    setSyncResult(null);
    try {
      // 拉取已有云端分类
      const cloudCats = await apiFetch<CloudCat[]>("/api/cloud/admin/categories");
      const cloudL1 = cloudCats.filter(c =>
        (c.appScope === "sound_assistant" || c.appScope === "both") && c.level === 1,
      );
      const cloudL1Names = new Set(cloudL1.map(c => c.name));
      const nameToId = new Map<string, number>(cloudL1.map(c => [c.name, c.id]));

      // 读取本地一级分类
      const { main, bg } = readLocalCats();
      const allL1 = [...new Set([...main, ...bg])];

      let created = 0;
      // 创建本地有、云端没有的 L1
      for (const name of allL1) {
        if (!cloudL1Names.has(name)) {
          const nc = await apiFetch<CloudCat>("/api/cloud/admin/categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, appScope: "sound_assistant", level: 1 }),
          });
          nameToId.set(name, nc.id);
          created++;
        }
      }

      // 读取本地音效，提取 (category→subCategory) 对
      const localSounds = readLocalSounds();
      const subMap = new Map<string, Set<string>>();
      for (const s of localSounds) {
        if (!s.mine && s.subCategory) {
          if (!subMap.has(s.category)) subMap.set(s.category, new Set());
          subMap.get(s.category)!.add(s.subCategory);
        }
      }

      // 已有云端 L2
      const cloudL2Key = new Set(
        cloudCats.filter(c => c.level === 2 && c.parentId != null)
          .map(c => `${c.parentId}:${c.name}`),
      );

      // 创建缺失 L2
      for (const [catName, subSet] of subMap) {
        const parentId = nameToId.get(catName);
        if (!parentId) continue;
        for (const subName of subSet) {
          if (!cloudL2Key.has(`${parentId}:${subName}`)) {
            await apiFetch("/api/cloud/admin/categories", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: subName, appScope: "sound_assistant", level: 2, parentId }),
            });
            created++;
          }
        }
      }

      setSyncResult(`✅ 同步完成，新建 ${created} 个分类`);
      await load();
    } catch (e) {
      setSyncResult(`❌ ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  if (loading) return <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 13 }}>加载云端分类…</div>;
  if (error) return (
    <div style={{ padding: 16 }}>
      <div style={{ color: "#c05050", fontSize: 13, marginBottom: 10 }}>❌ {error}</div>
      <button className="btn" onClick={() => void load()}>重试</button>
    </div>
  );

  return (
    <div>
      {/* 一键同步本地分类 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "10px 12px", borderRadius: 10, background: "rgba(230,182,110,0.08)", border: "1px solid rgba(230,182,110,0.2)" }}>
        <button
          className="btn gold-btn"
          disabled={syncing || busy}
          onClick={() => void syncLocalCats()}
          style={{ fontSize: 12, padding: "5px 14px", whiteSpace: "nowrap" }}
        >
          {syncing ? "同步中…" : "⇅ 一键同步本地分类"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>将管理员客户端的一级/二级分类同步到云端（跳过已存在）</span>
        {syncResult && (
          <span style={{ fontSize: 12, color: syncResult.startsWith("✅") ? "#2a7" : "#c05050", whiteSpace: "nowrap" }}>{syncResult}</span>
        )}
      </div>

      {/* 新建 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          className="inp"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="新分类名称"
          style={{ flex: 1, fontSize: 13, padding: "5px 10px", height: 32 }}
          onKeyDown={e => { if (e.key === "Enter") void addCat(); }}
          disabled={busy}
        />
        <button className="btn green-btn" onClick={() => void addCat()} disabled={busy || !newName.trim()}>
          + 新建
        </button>
      </div>

      {cats.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--text-dim)" }}>暂无分类</div>
      )}

      {cats.map(cat => (
        <div key={cat.id} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
          marginBottom: 6, borderRadius: 8,
          background: "rgba(255,255,255,0.45)", border: "1px solid rgba(230,182,110,0.2)",
        }}>
          {renaming?.id === cat.id ? (
            <input
              className="inp"
              value={renameVal}
              autoFocus
              onChange={e => setRenameVal(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={e => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              style={{ flex: 1, fontSize: 13, padding: "2px 6px", height: 26 }}
            />
          ) : (
            <span style={{ flex: 1, fontSize: 13 }}>{cat.name}</span>
          )}
          <span style={{ fontSize: 11, color: "var(--text-dim)", minWidth: 40 }}>{cat.soundCount} 音效</span>
          {!cat.isSystem && renaming?.id !== cat.id && (
            <>
              <button className="btn" disabled={busy} onClick={() => { setRenaming({ id: cat.id, name: cat.name }); setRenameVal(cat.name); }}
                style={{ fontSize: 11, padding: "2px 8px" }}>改名</button>
              <button className="btn danger-btn" disabled={busy} onClick={() => void deleteCat(cat)}
                style={{ fontSize: 11, padding: "2px 8px" }}>删除</button>
            </>
          )}
          {cat.isSystem && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>系统</span>}
        </div>
      ))}
    </div>
  );
}

// ── 音效上传 ──────────────────────────────────────────────────────────────────

interface PreparedDirectUpload {
  file: File;
  soundName: string;
  upload: CloudUploadDescriptor;
  hash: string;
  sameFile: boolean;
  conflictKey?: string;
}

function UploadPanel() {
  const [cats, setCats] = useState<CloudCat[]>([]);
  const [selCatId, setSelCatId] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number; skipped: number } | null>(null);
  const [done, setDone] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PreparedDirectUpload[] | null>(null);
  const [pendingConflicts, setPendingConflicts] = useState<SyncConflict[]>([]);
  const [knownCloudNames, setKnownCloudNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch<CloudCat[]>("/api/cloud/admin/categories").then(data => {
      const filtered = data.filter(c => (c.appScope === "sound_assistant" || c.appScope === "both") && c.level === 1 && !c.isSystem);
      setCats(filtered);
      if (filtered[0]) setSelCatId(filtered[0].id);
    }).catch(() => {});
  }, []);

  async function executeUploads(items: PreparedDirectUpload[], resolutions: Record<string, ConflictResolution>) {
    setProgress({ done: 0, total: items.length, failed: 0, skipped: 0 });
    setDone(false);
    setUploadErrors([]);
    let failed = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const resolution = item.conflictKey ? resolutions[item.conflictKey] : undefined;
      if (item.sameFile || resolution?.action === "keep-cloud") {
        skipped++;
        setProgress({ done: i + 1, total: items.length, failed, skipped });
        continue;
      }
      try {
        const soundName = resolution?.action === "save-as" ? resolution.name.trim().replace(/\.[^.]+$/, "") : item.soundName;
        const prepared = resolution?.action === "save-as"
          ? await prepareCloudUpload(item.file, soundName, item.file.name)
          : item.upload;
        const fd = new FormData();
        fd.append("file", prepared.blob, prepared.filename);
        fd.append("name", soundName);
        if (selCatId) fd.append("categoryId", String(selCatId));
        fd.append("appScope", "sound_assistant");
        const res = await cloudFetch("/api/cloud/admin/sounds/upload-file", { method: "POST", body: fd });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
      } catch (error) {
        failed++;
        errors.push(`${item.file.name}：${error instanceof Error ? error.message : String(error)}`);
        setUploadErrors([...errors]);
      }
      setProgress({ done: i + 1, total: items.length, failed, skipped });
    }
    setDone(true);
    setPendingUploads(null);
    setPendingConflicts([]);
    setFiles([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function upload() {
    if (!files.length) return;
    setDone(false);
    setUploadErrors([]);
    setProgress({ done: 0, total: files.length, failed: 0, skipped: 0 });
    try {
      const cloudSounds = (await apiFetch<CloudSound[]>("/api/cloud/admin/sounds?appScope=sound_assistant"))
        .filter(sound => !sound.deletedAt);
      setKnownCloudNames(cloudSounds.map(sound => sound.name));
      const cloudByName = new Map<string, CloudSound[]>();
      for (const cloud of cloudSounds) {
        const key = normalizeSoundName(cloud.name);
        cloudByName.set(key, [...(cloudByName.get(key) ?? []), cloud]);
      }

      const preparedItems: PreparedDirectUpload[] = [];
      const conflicts: SyncConflict[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!;
        const soundName = file.name.replace(/\.[^.]+$/, "");
        const prepared = await prepareCloudUpload(file, soundName, file.name);
        const hash = await sha256Hex(file);
        const candidates = cloudByName.get(normalizeSoundName(soundName)) ?? [];
        const same = candidates.find(candidate => classifyNameMatch(hash, candidate.hash) === "same-file");
        const cloud = same ?? candidates[0];
        const conflictKey = !same && cloud ? `direct-${index}:${cloud.id}` : undefined;
        if (cloud && conflictKey) {
          const decision = classifyNameMatch(hash, cloud.hash);
          conflicts.push({
            key: conflictKey,
            localSoundId: `direct-${index}`,
            localName: soundName,
            localHash: hash,
            localFileSize: file.size,
            cloudSoundId: cloud.id,
            cloudName: cloud.name,
            cloudHash: cloud.hash,
            cloudFileSize: cloud.fileSize,
            reason: decision === "different-file" ? "different-file" : "unknown-cloud-file",
          });
        }
        preparedItems.push({ file, soundName, upload: prepared, hash, sameFile: !!same, conflictKey });
        setProgress({ done: index + 1, total: files.length, failed: 0, skipped: 0 });
      }

      if (conflicts.length > 0) {
        setPendingUploads(preparedItems);
        setPendingConflicts(conflicts);
        setProgress(null);
        return;
      }
      await executeUploads(preparedItems, {});
    } catch (error) {
      setDone(true);
      setProgress({ done: files.length, total: files.length, failed: 1, skipped: 0 });
      setUploadErrors([error instanceof Error ? error.message : String(error)]);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>上传到分类</label>
        <select
          className="inp"
          value={selCatId ?? ""}
          onChange={e => setSelCatId(Number(e.target.value))}
          style={{ width: "100%", fontSize: 13, padding: "5px 8px", height: 32 }}
        >
          {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,.webm,audio/*"
          multiple
          style={{ display: "none" }}
          onChange={e => setFiles(Array.from(e.target.files ?? []))}
        />
        <button className="btn" onClick={() => inputRef.current?.click()} style={{ marginRight: 8 }}>
          选择音频文件
        </button>
        {files.length > 0 && (
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>已选 {files.length} 个文件</span>
        )}
      </div>

      {files.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: 12, color: "var(--text-dim)" }}>
          {files.map(f => f.name).join("、")}
        </div>
      )}

      {progress && (
        <div style={{ marginBottom: 12, fontSize: 13, color: done && progress.failed === 0 ? "#4a9" : "var(--text-dim)" }}>
          {done
            ? `✅ 已上传 ${progress.done - progress.failed - progress.skipped} 个${progress.skipped > 0 ? `，复用/保留 ${progress.skipped} 个` : ""}${progress.failed > 0 ? `，失败 ${progress.failed} 个` : ""}`
            : `⏳ 上传中 ${progress.done} / ${progress.total}…`}
        </div>
      )}

      {uploadErrors.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, color: "#d66" }}>
          {uploadErrors.map(message => <div key={message}>{message}</div>)}
        </div>
      )}

      <button
        className="btn green-btn"
        disabled={!files.length || (!!progress && !done)}
        onClick={() => void upload()}
        style={{ fontSize: 13 }}
      >
        ☁️ 上传到云端
      </button>

      {pendingUploads && pendingConflicts.length > 0 && (
        <SoundConflictDialog
          conflicts={pendingConflicts}
          existingNames={[...knownCloudNames, ...pendingUploads.map(item => item.soundName)]}
          onCancel={() => {
            setPendingUploads(null);
            setPendingConflicts([]);
            setProgress(null);
          }}
          onConfirm={resolutions => void executeUploads(pendingUploads, resolutions)}
        />
      )}
    </div>
  );
}

// ── 发布同步 ──────────────────────────────────────────────────────────────────

function PublishPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function publish() {
    if (!confirm("发布后所有普通用户下次同步将拉取最新云端音效库，确定发布？")) return;
    setBusy(true);
    setResult(null);
    try {
      const data = await apiFetch<{ version?: number; message?: string }>("/api/cloud/admin/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appScope: "sound_assistant", note: "客户端管理员发布" }),
      });
      setResult(`✅ 发布成功！云端版本 v${data.version ?? "?"}`);
    } catch (e) {
      setResult(`❌ 发布失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 16, lineHeight: 1.7 }}>
        <p>• 每次上传/修改分类后可点击「一键发布」</p>
        <p>• 发布后自动生成新版本快照</p>
        <p>• 普通用户打开客户端或手动同步时将拉取最新版本</p>
      </div>
      <button
        className="btn green-btn"
        disabled={busy}
        onClick={() => void publish()}
        style={{ fontSize: 14, padding: "8px 24px" }}
      >
        {busy ? "发布中…" : "☁️ 一键发布同步"}
      </button>
      {result && (
        <div style={{ marginTop: 12, fontSize: 13, color: result.startsWith("✅") ? "#4a9" : "#c05050" }}>
          {result}
        </div>
      )}
    </div>
  );
}

// ── 音效管理 Tab（批量删除）────────────────────────────────────────────────────

interface CloudSound {
  id: number;
  name: string;
  categoryId: number | null;
  appScope: string;
  isEnabled: boolean;
  sortOrder: number;
  shortcut: string | null;
  loop: boolean;
  duration: number | null;
  hash: string | null;
  fileSize: number | null;
  deletedAt?: string | null;
}

function SoundsPanel() {
  const [cats, setCats] = useState<CloudCat[]>([]);
  const [selCatId, setSelCatId] = useState<number | null>(null);
  const [sounds, setSounds] = useState<CloudSound[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 批量管理状态
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const [showSyncModal, setShowSyncModal] = useState(false);

  // 加载分类列表
  useEffect(() => {
    apiFetch<CloudCat[]>("/api/cloud/admin/categories").then(data => {
      const filtered = data.filter(
        c => (c.appScope === "sound_assistant" || c.appScope === "both") && c.level === 1,
      );
      setCats(filtered);
      if (filtered[0]) setSelCatId(filtered[0].id);
    }).catch(() => {});
  }, []);

  // 加载所选分类的音效
  const loadSounds = async (catId: number | null) => {
    if (catId === null) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ categoryId: String(catId) });
      const rows = await apiFetch<CloudSound[]>(`/api/cloud/admin/sounds?${params}`);
      setSounds(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadSounds(selCatId); }, [selCatId]);

  function enterBatch() {
    setBatchMode(true);
    setSelected(new Set());
    setResult(null);
  }

  function exitBatch() {
    setBatchMode(false);
    setSelected(new Set());
    setResult(null);
  }

  function toggleOne(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === sounds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sounds.map(s => s.id)));
    }
  }

  async function handleDelete() {
    if (selected.size === 0) return;
    const ok = confirm(
      `确认删除已选 ${selected.size} 个音效？删除后客户端同步也会移除。`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await cloudFetch("/api/cloud/admin/sounds/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      setResult(`✅ 已删除 ${selected.size} 个音效`);
      exitBatch();
      await loadSounds(selCatId);
    } catch (e) {
      setResult(`❌ ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  }

  const allSelected = sounds.length > 0 && selected.size === sounds.length;

  return (
    <div style={{ position: "relative", paddingBottom: batchMode ? 60 : 0 }}>
      {showSyncModal && (
        <SyncModal
          sounds={readLocalSounds().filter(sound => !sound.mine && sound.source !== "cloud") as SoundItem[]}
          mainCats={readLocalCats().main}
          bgCats={readLocalCats().bg}
          onClose={() => {
            setShowSyncModal(false);
            void loadSounds(selCatId);
          }}
        />
      )}
      {/* 一键同步本地音效 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "10px 12px", borderRadius: 10, background: "rgba(230,182,110,0.08)", border: "1px solid rgba(230,182,110,0.2)", flexWrap: "wrap" }}>
        <button
          className="btn gold-btn"
          disabled={showSyncModal || deleting}
          onClick={() => setShowSyncModal(true)}
          style={{ fontSize: 12, padding: "5px 14px", whiteSpace: "nowrap" }}
        >
          {showSyncModal ? "同步处理中…" : "⇅ 一键同步本地音效"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>将管理员客户端的音效文件批量上传到云端（跳过无音频文件的条目）</span>
      </div>

      {/* 分类选择器 + 批量管理按钮 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <select
          className="inp"
          value={selCatId ?? ""}
          onChange={e => {
            exitBatch();
            setSelCatId(Number(e.target.value));
          }}
          style={{ flex: 1, fontSize: 13, padding: "5px 8px", height: 32 }}
        >
          {cats.map(c => <option key={c.id} value={c.id}>{c.name}（{c.soundCount} 音效）</option>)}
        </select>
        {!batchMode && sounds.length > 0 && (
          <button
            className="btn"
            onClick={enterBatch}
            style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
          >
            批量管理
          </button>
        )}
        {batchMode && (
          <button
            className="btn"
            onClick={toggleAll}
            style={{ fontSize: 12, padding: "4px 10px", whiteSpace: "nowrap" }}
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
        )}
      </div>

      {/* 操作结果提示 */}
      {result && (
        <div style={{
          marginBottom: 10, fontSize: 13, padding: "6px 10px", borderRadius: 6,
          background: result.startsWith("✅") ? "rgba(60,180,100,0.1)" : "rgba(200,80,80,0.1)",
          color: result.startsWith("✅") ? "#2a7" : "#c05050",
        }}>
          {result}
        </div>
      )}

      {/* 音效列表 */}
      {loading && (
        <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
          加载中…
        </div>
      )}
      {error && (
        <div style={{ padding: 16 }}>
          <div style={{ color: "#c05050", fontSize: 13, marginBottom: 8 }}>❌ {error}</div>
          <button className="btn" onClick={() => void loadSounds(selCatId)}>重试</button>
        </div>
      )}
      {!loading && !error && sounds.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--text-dim)", padding: "16px 0" }}>
          该分类暂无音效
        </div>
      )}
      {!loading && !error && sounds.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {sounds.map(s => {
            const isSel = selected.has(s.id);
            return (
              <div
                key={s.id}
                onClick={() => batchMode && toggleOne(s.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 10px", borderRadius: 8,
                  background: isSel ? "rgba(230,182,110,0.18)" : "rgba(255,255,255,0.45)",
                  border: `1px solid ${isSel ? "rgba(230,182,110,0.6)" : "rgba(230,182,110,0.15)"}`,
                  cursor: batchMode ? "pointer" : "default",
                  transition: "background 0.15s, border-color 0.15s",
                }}
              >
                {/* 选择框 */}
                {batchMode && (
                  <div style={{
                    width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
                    border: `2px solid ${isSel ? "#E6B66E" : "rgba(0,0,0,0.2)"}`,
                    background: isSel ? "#E6B66E" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {isSel && <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>✓</span>}
                  </div>
                )}
                {/* 音效名 */}
                <span style={{ flex: 1, fontSize: 13 }}>{s.name}</span>
                {/* 元数据 */}
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {s.shortcut && (
                    <span style={{
                      fontSize: 10, padding: "1px 5px", borderRadius: 4,
                      background: "rgba(230,182,110,0.2)", color: "var(--gold)",
                    }}>
                      {s.shortcut.toUpperCase()}
                    </span>
                  )}
                  <span style={{
                    fontSize: 10, padding: "1px 5px", borderRadius: 4,
                    background: "rgba(0,0,0,0.07)", color: "var(--text-dim)",
                  }}>
                    {s.loop ? "循环" : "单次"}
                  </span>
                  {!s.isEnabled && (
                    <span style={{
                      fontSize: 10, padding: "1px 5px", borderRadius: 4,
                      background: "rgba(200,80,80,0.12)", color: "#c05050",
                    }}>
                      已禁用
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 批量操作底部栏 */}
      {batchMode && (
        <div style={{
          position: "sticky", bottom: 0, left: 0, right: 0,
          background: "rgba(247,241,232,0.95)",
          backdropFilter: "blur(12px)",
          borderTop: "1px solid rgba(230,182,110,0.25)",
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 12px",
          marginTop: 12,
          borderRadius: "0 0 12px 12px",
          zIndex: 10,
        }}>
          <span style={{ flex: 1, fontSize: 13, color: "var(--text-dim)" }}>
            已选择 <strong style={{ color: "var(--gold)" }}>{selected.size}</strong> 个音效
          </span>
          <button
            className="btn danger-btn"
            disabled={selected.size === 0 || deleting}
            onClick={() => void handleDelete()}
            style={{ fontSize: 13, padding: "5px 16px" }}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
          <button
            className="btn"
            disabled={deleting}
            onClick={exitBatch}
            style={{ fontSize: 13, padding: "5px 14px" }}
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

type SubTab = "cats" | "upload" | "sounds" | "publish";

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "cats",    label: "📂 分类管理" },
  { key: "sounds",  label: "🎵 音效管理" },
  { key: "upload",  label: "⬆️ 上传音效" },
  { key: "publish", label: "🚀 发布同步" },
];

export default function CloudManageTab() {
  const [sub, setSub] = useState<SubTab>("cats");
  const hasToken = !!adminAuthHeader();

  if (!hasToken) {
    return (
      <div style={{ padding: 20, fontSize: 13, color: "var(--text-dim)", textAlign: "center" }}>
        <div style={{ marginBottom: 8 }}>⚠️ 管理员 token 未就绪</div>
        <div style={{ fontSize: 12 }}>请退出登录后重新登录，或检查网络连接。</div>
      </div>
    );
  }

  return (
    <div>
      {/* 子标签 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            className={`btn${sub === t.key ? " gold-btn" : ""}`}
            onClick={() => setSub(t.key)}
            style={{ fontSize: 12, padding: "4px 12px" }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "cats"    && <CatsPanel />}
      {sub === "sounds"  && <SoundsPanel />}
      {sub === "upload"  && <UploadPanel />}
      {sub === "publish" && <PublishPanel />}
    </div>
  );
}
