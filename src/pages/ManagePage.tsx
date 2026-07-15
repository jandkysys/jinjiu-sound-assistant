import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { getPersisted, setPersisted } from "../lib/persist";
import { estimateAudioStoreBytes, listAudioIds } from "../lib/audioStore";
import { dispatchSoundsChange } from "../lib/useSoundEngine";
import { getToken, authHeader } from "../lib/auth";
import { activationStatus } from "../lib/apiClientStub";
import { formatExpiry, useMemberStatus } from "../lib/memberStatus";
import CloudSyncPanel from "../components/CloudSyncPanel";
import CloudManageTab from "../components/CloudManageTab";
import BatchImportModal from "../components/BatchImportModal";
import { entriesFromFolder, buildDrafts } from "../lib/batchImport";
import type { DraftSound } from "../lib/batchImport";
import type { SoundItem } from "../lib/soundPack";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const SOUND_MAIN_CATS_KEY = "jt_sound_main_cats";
const SOUND_BG_CATS_KEY = "jt_sound_bg_cats";
const SOUND_MINE_CATS_KEY = "jt_sound_mine_cats";
const DEFAULT_MAIN_CATS = ["短音效"];
const DEFAULT_BG_CATS = ["PK音乐", "背景音乐"];
const DEFAULT_MINE_CATS = ["我的音效"];
const DEFAULT_SOUNDS: SoundItem[] = [
  { id: "default-1", name: "欢迎", type: "short", category: "短音效", loop: false, volume: 1 },
  { id: "default-2", name: "掌声", type: "short", category: "短音效", loop: false, volume: 1 },
  { id: "default-3", name: "背景音乐1", type: "bgm", category: "PK音乐", loop: true, volume: 0.7 },
];

type ManageTab = "sounds" | "cats" | "shortcuts" | "cloud" | "cloudManage" | "account" | "storage";

// 管理员标签
const ADMIN_TABS: { key: ManageTab; label: string; icon: string }[] = [
  { key: "cloudManage", label: "云端管理", icon: "☁️" },
  { key: "sounds",      label: "本地音效", icon: "🎵" },
  { key: "cats",        label: "本地分类", icon: "📂" },
  { key: "shortcuts",   label: "快捷键",  icon: "⌨️" },
  { key: "cloud",       label: "同步下载", icon: "⬇️" },
  { key: "account",     label: "账号",    icon: "👤" },
  { key: "storage",     label: "存储",    icon: "💾" },
];

// 普通用户标签（只读操作）
const USER_TABS: { key: ManageTab; label: string; icon: string }[] = [
  { key: "cloud",   label: "云端同步", icon: "☁️" },
  { key: "account", label: "我的账号", icon: "👤" },
];

function loadSounds(): SoundItem[] {
  try {
    const r = getPersisted("jt_sounds");
    if (r) { const arr = JSON.parse(r); if (Array.isArray(arr)) return arr; }
  } catch {}
  return [];
}

function loadCats(key: string, fallback: string[]): string[] {
  try {
    const r = getPersisted(key);
    if (r) { const arr = JSON.parse(r); if (Array.isArray(arr) && arr.length) return arr; }
  } catch {}
  return fallback;
}

// ── 音效管理 Tab ──────────────────────────────────────────────────────────────

function SoundsTab({
  sounds, editMode, selectedIds,
  onToggleSelect, onDeleteSelected, onRestoreDefault, onFileAdd, onFolderImport,
}: {
  sounds: SoundItem[];
  editMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onDeleteSelected: () => void;
  onRestoreDefault: () => void;
  onFileAdd: () => void;
  onFolderImport: () => void;
}) {
  return (
    <div className="mg-tab-content">
      {/* 文件夹批量导入（始终显示，不需要进入编辑模式） */}
      <div style={{ margin: "0 0 10px" }}>
        <button
          className="btn gold-btn"
          onClick={onFolderImport}
          style={{ width: "100%", fontSize: 14, padding: "10px 0", borderRadius: 10 }}
        >
          📁 选择音效文件夹（批量导入）
        </button>
      </div>
      <div className="mg-toolbar">
        {editMode && (
          <>
            <button className="btn" onClick={onFileAdd} style={{ fontSize: 13 }}>
              + 添加本地音频
            </button>
            {selectedIds.size > 0 && (
              <button className="btn danger-btn" onClick={onDeleteSelected} style={{ fontSize: 13 }}>
                删除 ({selectedIds.size})
              </button>
            )}
            <button className="btn" onClick={onRestoreDefault} style={{ fontSize: 13 }}>
              恢复默认
            </button>
          </>
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>
          共 {sounds.length} 条音效
        </span>
      </div>

      {sounds.length === 0 ? (
        <div className="mg-empty">暂无音效，点击「添加本地音频」导入</div>
      ) : (
        <div className="mg-sound-list">
          {sounds.map(s => (
            <div
              key={s.id}
              className={`mg-sound-row${editMode ? " selectable" : ""}${selectedIds.has(s.id) ? " selected" : ""}`}
              onClick={() => editMode && onToggleSelect(s.id)}
            >
              {editMode && (
                <div className={`mg-checkbox${selectedIds.has(s.id) ? " checked" : ""}`} />
              )}
              <div className="mg-sound-name">{s.name}</div>
              <div className="mg-sound-meta">
                <span className="mg-badge">{s.category ?? "未分类"}</span>
                {s.shortcut && (
                  <span className="mg-key">{s.shortcut === " " ? "␣" : s.shortcut.toUpperCase()}</span>
                )}
                <span className="mg-badge-type">{s.type === "bgm" ? "BGM" : "短"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 分类管理 Tab ──────────────────────────────────────────────────────────────

function CatsTab({
  mainCats, bgCats, mineCats, editMode,
  onAdd, onDelete, onRename,
}: {
  mainCats: string[]; bgCats: string[]; mineCats: string[];
  editMode: boolean;
  onAdd: (pool: "main" | "bg") => void;
  onDelete: (pool: "main" | "bg", name: string) => void;
  onRename: (pool: "main" | "bg", old: string, next: string) => void;
}) {
  const [renaming, setRenaming] = useState<{ pool: "main" | "bg"; name: string } | null>(null);
  const [renameVal, setRenameVal] = useState("");

  function startRename(pool: "main" | "bg", name: string) {
    setRenaming({ pool, name });
    setRenameVal(name);
  }

  function commitRename() {
    if (!renaming) return;
    const trimmed = renameVal.trim();
    if (trimmed && trimmed !== renaming.name) {
      onRename(renaming.pool, renaming.name, trimmed);
    }
    setRenaming(null);
  }

  function CatList({ pool, cats }: { pool: "main" | "bg"; cats: string[] }) {
    return (
      <div className="mg-cat-pool">
        <div className="mg-cat-pool-title">
          {pool === "main" ? "主播音效" : "背景音乐"}
          {editMode && (
            <button className="btn" onClick={() => onAdd(pool)} style={{ fontSize: 11, padding: "2px 8px", marginLeft: 8 }}>
              + 添加
            </button>
          )}
        </div>
        {cats.map(cat => {
          const isRen = renaming?.pool === pool && renaming?.name === cat;
          return (
            <div key={cat} className="mg-cat-row">
              <span className="mg-cat-dot" />
              {isRen ? (
                <input
                  className="inp"
                  value={renameVal}
                  autoFocus
                  style={{ flex: 1, fontSize: 13, padding: "2px 6px", height: 28 }}
                  onChange={e => setRenameVal(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                />
              ) : (
                <span className="mg-cat-name" onDoubleClick={() => editMode && startRename(pool, cat)}>
                  {cat}
                </span>
              )}
              {editMode && !isRen && (
                <div className="mg-cat-actions">
                  <button className="btn" onClick={() => startRename(pool, cat)} style={{ fontSize: 11, padding: "1px 6px" }}>
                    改名
                  </button>
                  <button className="btn danger-btn" onClick={() => onDelete(pool, cat)} style={{ fontSize: 11, padding: "1px 6px" }}>
                    删除
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mg-tab-content">
      <CatList pool="main" cats={mainCats} />
      <CatList pool="bg" cats={bgCats} />
      <div className="mg-cat-pool">
        <div className="mg-cat-pool-title" style={{ color: "var(--text-dim)" }}>我的音效（固定）</div>
        {mineCats.map(c => (
          <div key={c} className="mg-cat-row">
            <span className="mg-cat-dot" />
            <span className="mg-cat-name">{c}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 快捷键管理 Tab ────────────────────────────────────────────────────────────

function ShortcutsTab({ sounds }: { sounds: SoundItem[] }) {
  const actionKeys = [
    { key: "Enter",    desc: "播放 / 停止当前选中音效" },
    { key: "Space",    desc: "全部停止 / 恢复" },
    { key: "F3",       desc: "切换快捷键启用 / 禁用" },
    { key: "PageUp",   desc: "BGM 上一首" },
    { key: "PageDown", desc: "BGM 下一首" },
    { key: "Home",     desc: "BGM 首曲" },
    { key: "End",      desc: "BGM 末曲" },
  ];

  const assigned = sounds
    .filter(s => s.shortcut)
    .sort((a, b) => (a.shortcut ?? "").localeCompare(b.shortcut ?? ""));

  return (
    <div className="mg-tab-content">
      <div className="mg-shortcut-section">
        <div className="mg-shortcut-title">功能快捷键</div>
        {actionKeys.map(({ key, desc }) => (
          <div key={key} className="mg-shortcut-row">
            <span className="mg-key">{key}</span>
            <span className="mg-shortcut-desc">{desc}</span>
          </div>
        ))}
      </div>
      <div className="mg-shortcut-section">
        <div className="mg-shortcut-title">音效快捷键（已分配 {assigned.length} / {sounds.length}）</div>
        {assigned.length === 0 ? (
          <div className="mg-empty">暂无分配快捷键的音效</div>
        ) : (
          assigned.map(s => (
            <div key={s.id} className="mg-shortcut-row">
              <span className="mg-key">{s.shortcut === " " ? "␣" : (s.shortcut ?? "").toUpperCase()}</span>
              <span className="mg-shortcut-desc">{s.name}</span>
              <span className="mg-badge" style={{ marginLeft: "auto" }}>{s.category}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── 账号 Tab ──────────────────────────────────────────────────────────────────

function AccountTab() {
  const memberStatus = useMemberStatus();
  const expiry = memberStatus ? formatExpiry(memberStatus.membershipExpiresAt) : null;

  return (
    <div className="mg-tab-content">
      <div className="mg-account-card glass">
        <div className="mg-account-avatar">
          {memberStatus?.username?.[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="mg-account-info">
          <div className="mg-account-name">{memberStatus?.username ?? "未登录"}</div>
          <div className="mg-account-role">
            {memberStatus?.isAdmin
              ? "🛡️ 管理员"
              : memberStatus?.memberActive
                ? "✅ 会员有效"
                : "❌ 未激活"}
          </div>
          {expiry && (
            <div className="mg-account-expiry" style={{
              color: expiry.status === "expired" ? "#e05050" : expiry.status === "warning" ? "#d07030" : "var(--gold)",
            }}>
              {expiry.text}
              {expiry.subText && <span style={{ fontSize: 11, marginLeft: 6, opacity: 0.8 }}>{expiry.subText}</span>}
            </div>
          )}
        </div>
      </div>
      <div style={{ padding: "16px 0 4px", fontSize: 13, color: "var(--text-dim)" }}>
        在「设置」页可退出登录或管理账号。
      </div>
    </div>
  );
}

// ── 存储状态 Tab ──────────────────────────────────────────────────────────────

function StorageTab({ soundCount }: { soundCount: number }) {
  const [bytes, setBytes] = useState<number | null>(null);
  const [audioCount, setAudioCount] = useState<number | null>(null);

  useEffect(() => {
    estimateAudioStoreBytes().then(r => { setBytes(r.bytes); setAudioCount(r.count); })
      .catch(() => {});
  }, []);

  function fmt(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <div className="mg-tab-content">
      <div className="mg-storage-grid">
        <div className="mg-storage-card glass">
          <div className="mg-storage-num">{soundCount}</div>
          <div className="mg-storage-label">音效条目</div>
        </div>
        <div className="mg-storage-card glass">
          <div className="mg-storage-num">{audioCount ?? "—"}</div>
          <div className="mg-storage-label">音频文件</div>
        </div>
        <div className="mg-storage-card glass">
          <div className="mg-storage-num" style={{ fontSize: bytes !== null && bytes > 1024 * 1024 ? 20 : 28 }}>
            {bytes !== null ? fmt(bytes) : "计算中…"}
          </div>
          <div className="mg-storage-label">存储用量</div>
        </div>
      </div>
      <div style={{ marginTop: 20, fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}>
        <p>• 音效元数据存储在 IndexedDB（<code>jt_sounds</code>）</p>
        <p>• 音频 Blob 存储在 IndexedDB（<code>jt_audio</code>）</p>
        <p>• 分类、设置等存储在 localStorage（<code>jt_*</code>）</p>
        <p>• 清除浏览器数据会同时清除以上内容，请定期导出备份</p>
      </div>
    </div>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

export default function ManagePage() {
  const [, navigate] = useLocation();
  const memberStatus = useMemberStatus();

  // isAdmin 以自验证为权威（不依赖 context 时序）
  const [isAdmin, setIsAdmin] = useState<boolean | null>(() => {
    // 从缓存预填，避免 null→loading→正确值 的闪烁
    const cached = localStorage.getItem("jt_is_admin_cache");
    return cached !== null ? cached === "1" : null;
  });

  const TABS = isAdmin ? ADMIN_TABS : USER_TABS;
  const [activeTab, setActiveTab] = useState<ManageTab>("cloud");
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [sounds, setSounds] = useState<SoundItem[]>(loadSounds);
  const [mainCats, setMainCats] = useState<string[]>(() => loadCats(SOUND_MAIN_CATS_KEY, DEFAULT_MAIN_CATS));
  const [bgCats, setBgCats] = useState<string[]>(() => loadCats(SOUND_BG_CATS_KEY, DEFAULT_BG_CATS));
  const [mineCats, setMineCats] = useState<string[]>(() => loadCats(SOUND_MINE_CATS_KEY, DEFAULT_MINE_CATS));

  // 批量文件夹导入
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [batchDrafts, setBatchDrafts] = useState<DraftSound[] | null>(null);
  const [batchSource, setBatchSource] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const soundsRef = useRef(sounds);
  useEffect(() => { soundsRef.current = sounds; }, [sounds]);

  // 挂载时验证 token，确保 isAdmin 正确（不依赖 context 时序）
  useEffect(() => {
    let cancelled = false;
    if (memberStatus !== null) {
      setIsAdmin(memberStatus.isAdmin ?? false);
      return () => { cancelled = true; };
    }
    const token = getToken();
    if (!token) { navigate("/login"); return; }
    activationStatus(authHeader(token)).then(data => {
      if (cancelled) return;
      setIsAdmin(data.isAdmin ?? false);
      try { localStorage.setItem("jt_is_admin_cache", data.isAdmin ? "1" : "0"); } catch {}
    }).catch(() => {
      if (cancelled) return;
      const cached = localStorage.getItem("jt_is_admin_cache");
      setIsAdmin(cached === "1");
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberStatus]);

  // 监听 sounds 变化
  useEffect(() => {
    const handler = () => setSounds(loadSounds());
    window.addEventListener("jt_sounds_change", handler);
    return () => window.removeEventListener("jt_sounds_change", handler);
  }, []);

  // isAdmin 确定后设置默认 tab
  useEffect(() => {
    if (isAdmin !== null) {
      setActiveTab(isAdmin ? "cloudManage" : "cloud");
    }
  }, [isAdmin]);

  const persistSounds = useCallback((next: SoundItem[]) => {
    try { setPersisted("jt_sounds", JSON.stringify(next)); } catch {}
    dispatchSoundsChange(next);
    setSounds(next);
  }, []);

  // ── 文件夹批量导入 ──
  const handleFolderPicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    const folderName = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] || "文件夹";
    const entries = await entriesFromFolder(files);
    const usedKeys = new Set(soundsRef.current.map(s => s.shortcut).filter(Boolean) as string[]);
    const drafts = buildDrafts(entries, usedKeys);
    setBatchSource(folderName);
    setBatchDrafts(drafts);
  }, []);

  const confirmBatchImport = useCallback(async () => {
    if (!batchDrafts || batchDrafts.length === 0) return;
    setBatchBusy(true);
    const { putAudioBlob } = await import("../lib/audioStore");
    const next = [...soundsRef.current];
    try {
      for (const d of batchDrafts) {
        const newId = `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await putAudioBlob(newId, d.file, undefined, d.file.name);
        const isLoop = d.mode === "loop";
        next.push({
          id: newId,
          name: d.name.trim() || d.file.name,
          type: isLoop ? "bgm" : "short",
          category: d.category,
          subCategory: d.subCategory || undefined,
          loop: isLoop,
          volume: d.volume ?? 1,
          shortcut: d.shortcut || undefined,
          hasAudio: true,
        } as SoundItem);
      }
      persistSounds(next);
      setBatchDrafts(null);
      setBatchSource("");
    } finally {
      setBatchBusy(false);
    }
  }, [batchDrafts, persistSounds]);

  function persistCats(pool: "main" | "bg", cats: string[]) {
    const key = pool === "main" ? SOUND_MAIN_CATS_KEY : SOUND_BG_CATS_KEY;
    try { setPersisted(key, JSON.stringify(cats)); } catch {}
    if (pool === "main") setMainCats(cats);
    else setBgCats(cats);
  }

  // ── 音效操作 ──
  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function deleteSelected() {
    if (!confirm(`确定删除选中的 ${selectedIds.size} 条音效？此操作不可撤销。`)) return;
    persistSounds(sounds.filter(s => !selectedIds.has(s.id)));
    setSelectedIds(new Set());
  }

  function restoreDefault() {
    if (!confirm("恢复默认音效？当前所有音效将被清空并替换为默认音效。")) return;
    persistSounds([...DEFAULT_SOUNDS]);
    setSelectedIds(new Set());
  }

  function addLocalFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,video/*";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      const { putAudioBlob } = await import("../lib/audioStore");
      const next = [...sounds];
      for (const f of files) {
        const id = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await putAudioBlob(id, f, undefined, f.name);
        next.push({
          id,
          name: f.name.replace(/\.[^.]+$/, ""),
          type: "short",
          category: mainCats[0] ?? "短音效",
          loop: false,
          volume: 1,
        });
      }
      persistSounds(next);
    };
    input.click();
  }

  // ── 分类操作 ──
  function addCat(pool: "main" | "bg") {
    const cats = pool === "main" ? [...mainCats] : [...bgCats];
    persistCats(pool, [...cats, `分类${cats.length + 1}`]);
  }

  function deleteCat(pool: "main" | "bg", name: string) {
    const cats = pool === "main" ? [...mainCats] : [...bgCats];
    if (cats.length <= 1) { alert("至少保留一个分类"); return; }
    if (!confirm(`删除分类「${name}」？该分类下的音效将移至「${cats.find(c => c !== name) ?? "未分类"}」`)) return;
    const filtered = cats.filter(c => c !== name);
    persistCats(pool, filtered);
    const fallback = filtered[0] ?? "未分类";
    persistSounds(sounds.map(s => s.category === name ? { ...s, category: fallback } : s));
  }

  function renameCat(pool: "main" | "bg", old: string, next: string) {
    const cats = (pool === "main" ? [...mainCats] : [...bgCats]).map(c => c === old ? next : c);
    persistCats(pool, cats);
    persistSounds(sounds.map(s => s.category === old ? { ...s, category: next } : s));
  }

  // isAdmin 未确定前显示加载中（防止闪烁到错误视图）
  if (isAdmin === null) {
    return (
      <div style={{
        position: "fixed", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg-page, #F7F1E8)",
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          border: "3px solid rgba(230,182,110,0.25)",
          borderTopColor: "#E6B66E",
          animation: "spin 0.9s linear infinite",
        }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  // 仅 admin 显示「编辑」按钮的 tab
  const showEditBtn = isAdmin && (activeTab === "sounds" || activeTab === "cats");

  return (
    <div className="manage-page">
      {/* 隐藏的文件夹选择器 */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard
        webkitdirectory=""
        multiple
        style={{ display: "none" }}
        onChange={handleFolderPicked}
      />

      {/* 批量导入预览弹窗 */}
      {batchDrafts && (
        <BatchImportModal
          drafts={batchDrafts}
          existing={soundsRef.current}
          sourceLabel={batchSource}
          busy={batchBusy}
          onChange={setBatchDrafts}
          onConfirm={confirmBatchImport}
          onCancel={() => { if (!batchBusy) { setBatchDrafts(null); setBatchSource(""); } }}
        />
      )}

      {/* 顶部导航 */}
      <div className="manage-header">
        <button className="s-back-btn" onClick={() => { setEditMode(false); navigate("/"); }}>
          <span>‹</span>
        </button>
        <span className="manage-title">
          {isAdmin ? "管理（管理员）" : "管理"}
        </span>
        {showEditBtn && (
          <button
            className={`btn${editMode ? " gold-btn" : ""}`}
            style={{ fontSize: 13, padding: "4px 12px" }}
            onClick={() => { setEditMode(v => !v); setSelectedIds(new Set()); }}
          >
            {editMode ? "完成" : "编辑"}
          </button>
        )}
      </div>

      {/* 标签栏 */}
      <div className="manage-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`manage-tab-btn${activeTab === t.key ? " active" : ""}`}
            onClick={() => { setActiveTab(t.key); setSelectedIds(new Set()); setEditMode(false); }}
          >
            <span className="manage-tab-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className="manage-body">
        {/* 管理员专用：云端管理 */}
        {activeTab === "cloudManage" && isAdmin && (
          <div className="mg-tab-content">
            <CloudManageTab />
          </div>
        )}

        {/* 管理员专用：本地音效/分类/快捷键 */}
        {activeTab === "sounds" && isAdmin && (
          <SoundsTab
            sounds={sounds}
            editMode={editMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onDeleteSelected={deleteSelected}
            onRestoreDefault={restoreDefault}
            onFileAdd={addLocalFile}
            onFolderImport={() => folderInputRef.current?.click()}
          />
        )}
        {activeTab === "cats" && isAdmin && (
          <CatsTab
            mainCats={mainCats}
            bgCats={bgCats}
            mineCats={mineCats}
            editMode={editMode}
            onAdd={addCat}
            onDelete={deleteCat}
            onRename={renameCat}
          />
        )}
        {activeTab === "shortcuts" && isAdmin && <ShortcutsTab sounds={sounds} />}

        {/* 所有用户：云端同步 */}
        {activeTab === "cloud" && (
          <div className="mg-tab-content">
            <CloudSyncPanel onClose={() => setActiveTab(isAdmin ? "cloudManage" : "account")} />
          </div>
        )}

        {/* 所有用户：账号 */}
        {activeTab === "account" && <AccountTab />}

        {/* 管理员专用：存储状态 */}
        {activeTab === "storage" && isAdmin && <StorageTab soundCount={sounds.length} />}
      </div>
    </div>
  );
}
