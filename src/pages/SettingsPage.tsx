import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { getPersisted, setPersisted } from "../lib/persist";
import { useTheme, type ThemeMode } from "../lib/theme";
import { getToken, clearToken, authHeader } from "../lib/auth";
import { activationStatus, type ActivationStatusResult } from "../lib/apiClientStub";
import { formatExpiry } from "../lib/memberStatus";
import DiagnosticPanel from "../components/DiagnosticPanel";

// ── 类型 ─────────────────────────────────────────────────────────────────────

type AppSettings = {
  windowPinned: boolean;
  shiftShortcuts: boolean;
  volumeStep: number;
  fadePlay: boolean;
  fadeMs: number;
  cardFontPct: number;
  showShortcutBelowName: boolean;
  layoutMode: "default" | "compact" | "wide";
  tapNoStop: boolean;
  shortcutsEnabled: boolean;
  shortcutMode: "register" | "listen";
};

const DEFAULT_SETTINGS: AppSettings = {
  windowPinned: false,
  shiftShortcuts: true,
  volumeStep: 10,
  fadePlay: false,
  fadeMs: 200,
  cardFontPct: 100,
  showShortcutBelowName: true,
  layoutMode: "default",
  tapNoStop: false,
  shortcutsEnabled: true,
  shortcutMode: "register",
};

const DEFAULT_MAIN_CATS = ["短音效"];
const DEFAULT_BG_CATS = ["PK音乐", "背景音乐"];

function loadSettings(): AppSettings {
  try {
    const raw = getPersisted("jt_sound_settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function loadCats(key: string, fallback: string[]): string[] {
  try {
    const raw = getPersisted(key);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      return Array.isArray(arr) && arr.length ? arr : fallback;
    }
  } catch {}
  return fallback;
}

// ── 通用行组件 ───────────────────────────────────────────────────────────────

function SRow({
  label,
  sub,
  right,
  rightNode,
  onClick,
  danger,
  indent,
}: {
  label: string;
  sub?: string;
  right?: string;
  rightNode?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={`s-row${onClick ? " s-row-tap" : ""}${danger ? " s-row-danger" : ""}`}
      style={indent ? { paddingLeft: 28 } : {}}
      onClick={onClick}
    >
      <div className="s-row-left">
        <span className="s-row-label">{label}</span>
        {sub && <span className="s-row-sub">{sub}</span>}
      </div>
      {rightNode ?? (right && <span className="s-row-right">{right}</span>)}
    </div>
  );
}

function SToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={`s-toggle${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
    >
      <div className="s-toggle-thumb" />
    </div>
  );
}

function SSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="s-section">
      <div className="s-section-header">{title}</div>
      <div className="s-section-body">{children}</div>
    </div>
  );
}

// ── 主页面 ───────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [, navigate] = useLocation();
  const { mode: themeMode, setTheme } = useTheme();

  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [mainCats, setMainCats] = useState<string[]>(() =>
    loadCats("jt_sound_main_cats", DEFAULT_MAIN_CATS),
  );
  const [bgCats, setBgCats] = useState<string[]>(() =>
    loadCats("jt_sound_bg_cats", DEFAULT_BG_CATS),
  );
  const [editingCat, setEditingCat] = useState<{ pool: "main" | "bg"; idx: number } | null>(null);
  const [editingVal, setEditingVal] = useState("");

  const [account, setAccount] = useState<ActivationStatusResult | null>(null);
  const [accountState, setAccountState] = useState<"loading" | "ok" | "offline" | "no-token">("loading");

  const [catPool, setCatPool] = useState<"main" | "bg">("main");

  // 读取账号状态
  useEffect(() => {
    const token = getToken();
    if (!token) { setAccountState("no-token"); return; }
    activationStatus(authHeader(token))
      .then(data => {
        setAccount(data);
        setAccountState("ok");
        try { localStorage.setItem("jt_is_admin_cache", data.isAdmin ? "1" : "0"); } catch {}
      })
      .catch(() => {
        // 离线时从缓存恢复 isAdmin，确保管理员标识在弱网下也能显示
        const cachedAdmin = localStorage.getItem("jt_is_admin_cache");
        if (cachedAdmin !== null) {
          setAccount({ isAdmin: cachedAdmin === "1" } as ActivationStatusResult);
        }
        setAccountState("offline");
      });
  }, []);

  // 保存设置
  const setSetting = useCallback(<K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [k]: v };
      try { setPersisted("jt_sound_settings", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  function saveCats(pool: "main" | "bg", cats: string[]) {
    if (pool === "main") {
      setMainCats(cats);
      try { setPersisted("jt_sound_main_cats", JSON.stringify(cats)); } catch {}
    } else {
      setBgCats(cats);
      try { setPersisted("jt_sound_bg_cats", JSON.stringify(cats)); } catch {}
    }
  }

  function startEditCat(pool: "main" | "bg", idx: number, val: string) {
    setEditingCat({ pool, idx });
    setEditingVal(val);
  }

  function commitEditCat() {
    if (!editingCat) return;
    const { pool, idx } = editingCat;
    const cats = pool === "main" ? [...mainCats] : [...bgCats];
    const trimmed = editingVal.trim();
    if (trimmed && trimmed !== cats[idx]) {
      cats[idx] = trimmed;
      saveCats(pool, cats);
    }
    setEditingCat(null);
  }

  function addCat(pool: "main" | "bg") {
    const cats = pool === "main" ? [...mainCats] : [...bgCats];
    const name = `分类${cats.length + 1}`;
    saveCats(pool, [...cats, name]);
  }

  function removeCat(pool: "main" | "bg", idx: number) {
    const cats = pool === "main" ? [...mainCats] : [...bgCats];
    if (cats.length <= 1) { alert("至少保留一个分类"); return; }
    cats.splice(idx, 1);
    saveCats(pool, cats);
  }

  function resetCats(pool: "main" | "bg") {
    if (!confirm("恢复默认分类？当前自定义分类名称将丢失（音效不受影响）")) return;
    saveCats(pool, pool === "main" ? [...DEFAULT_MAIN_CATS] : [...DEFAULT_BG_CATS]);
  }

  function handleLogout() {
    if (!confirm("确定要退出登录吗？")) return;
    clearToken();
    navigate("/login");
  }

  const expiry = account ? formatExpiry(account.membershipExpiresAt) : null;
  const activeCats = catPool === "main" ? mainCats : bgCats;

  const APP_VERSION = "1.0.0";

  return (
    <div className="settings-page">
      {/* 顶部导航 */}
      <div className="settings-header">
        <button className="s-back-btn" onClick={() => navigate("/")}>
          <span>‹</span>
        </button>
        <span className="settings-title">设置</span>
        <div style={{ width: 40 }} />
      </div>

      <div className="settings-scroll">

        {/* ── 账号 ─────────────────────────────────────── */}
        <SSection title="账号">
          {accountState === "no-token" ? (
            <SRow
              label="登录账号"
              right="去登录 ›"
              onClick={() => navigate("/login")}
            />
          ) : accountState === "loading" ? (
            <SRow label="账号" right="验证中…" />
          ) : (
            <>
              <div className="s-account-card">
                <div className="s-avatar">{account?.username?.[0]?.toUpperCase() ?? "👤"}</div>
                <div className="s-account-info">
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div className="s-account-name">{account?.username ?? "—"}</div>
                    {account?.isAdmin && (
                      <span style={{
                        fontSize: 11, fontWeight: 600, color: "#fff",
                        background: "var(--gold, #E6B66E)", borderRadius: 4,
                        padding: "1px 6px", lineHeight: 1.6,
                      }}>管理员</span>
                    )}
                  </div>
                  <div
                    className="s-account-status"
                    style={{
                      color:
                        accountState === "offline" ? "#aaa"
                        : expiry?.status === "expired" ? "#e05050"
                        : expiry?.status === "warning" ? "#d07030"
                        : "var(--gold)",
                    }}
                  >
                    {accountState === "offline"
                      ? "⚠️ 服务器连接失败，显示缓存状态"
                      : (expiry?.text ?? "—")}
                  </div>
                  {expiry?.subText && (
                    <div className="s-account-sub">{expiry.subText}</div>
                  )}
                </div>
              </div>
              <SRow
                label="退出登录"
                right="›"
                onClick={handleLogout}
                danger
              />
            </>
          )}
        </SSection>

        {/* ── 外观主题 ──────────────────────────────────── */}
        <SSection title="外观">
          <div className="s-row">
            <span className="s-row-label">主题</span>
            <div className="s-theme-seg">
              {([["system", "跟随系统"], ["dark", "深色"]] as [ThemeMode, string][]).map(
                ([m, label]) => (
                  <button
                    key={m}
                    className={`s-seg-btn${themeMode === m ? " active" : ""}`}
                    onClick={() => setTheme(m)}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </div>
        </SSection>

        {/* ── 播放设置 ──────────────────────────────────── */}
        <SSection title="播放设置">
          <SRow
            label="再次单击停止音效"
            sub="单击已播放的音效会将其停止"
            rightNode={
              <SToggle
                on={!settings.tapNoStop}
                onChange={v => setSetting("tapNoStop", !v)}
              />
            }
          />
          <SRow
            label="淡入淡出"
            sub="播放和停止音效时平滑过渡"
            rightNode={
              <SToggle on={settings.fadePlay} onChange={v => setSetting("fadePlay", v)} />
            }
          />
          <SRow
            label="在名称下方显示快捷键"
            rightNode={
              <SToggle
                on={settings.showShortcutBelowName}
                onChange={v => setSetting("showShortcutBelowName", v)}
              />
            }
          />
          <SRow
            label="卡片布局"
            rightNode={
              <div className="s-theme-seg">
                {([["default", "默认"], ["compact", "紧凑"], ["wide", "宽大"]] as [AppSettings["layoutMode"], string][]).map(
                  ([m, label]) => (
                    <button
                      key={m}
                      className={`s-seg-btn${settings.layoutMode === m ? " active" : ""}`}
                      onClick={() => setSetting("layoutMode", m)}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
            }
          />
        </SSection>

        {/* ── 快捷键设置 ────────────────────────────────── */}
        <SSection title="键盘快捷键">
          <SRow
            label="启用键盘快捷键"
            rightNode={
              <SToggle
                on={settings.shortcutsEnabled}
                onChange={v => setSetting("shortcutsEnabled", v)}
              />
            }
          />
          <SRow
            label="Shift 键辅助快捷键"
            sub="Shift+字母 触发更多音效"
            rightNode={
              <SToggle
                on={settings.shiftShortcuts}
                onChange={v => setSetting("shiftShortcuts", v)}
              />
            }
          />
          <div className="s-row">
            <span className="s-row-label">快捷键模式</span>
            <div className="s-theme-seg">
              {([["listen", "监听"], ["register", "注册"]] as [AppSettings["shortcutMode"], string][]).map(
                ([m, label]) => (
                  <button
                    key={m}
                    className={`s-seg-btn${settings.shortcutMode === m ? " active" : ""}`}
                    onClick={() => setSetting("shortcutMode", m)}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </div>
          <div className="s-row">
            <div className="s-row-left">
              <span className="s-row-label">音量步进</span>
              <span className="s-row-sub">快捷键调整音量的幅度</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="range" min={1} max={50} value={settings.volumeStep}
                onChange={e => setSetting("volumeStep", +e.target.value)}
                style={{ width: 80 }}
              />
              <span style={{ fontSize: 12, color: "var(--gold)", fontFamily: "sans-serif", minWidth: 28, textAlign: "right" }}>
                {settings.volumeStep}%
              </span>
            </div>
          </div>
        </SSection>

        {/* ── 分类设置 ──────────────────────────────────── */}
        <SSection title="分类管理">
          <div className="s-row" style={{ gap: 8 }}>
            <span className="s-row-label" style={{ flex: 1 }}>编辑分类</span>
            <div className="s-theme-seg">
              {([["main", "主播音效"], ["bg", "背景音乐"]] as ["main" | "bg", string][]).map(([p, lab]) => (
                <button
                  key={p}
                  className={`s-seg-btn${catPool === p ? " active" : ""}`}
                  onClick={() => setCatPool(p)}
                >
                  {lab}
                </button>
              ))}
            </div>
          </div>
          {activeCats.map((cat, idx) => {
            const isEditing = editingCat?.pool === catPool && editingCat?.idx === idx;
            return (
              <div key={idx} className="s-row s-cat-row">
                <span className="s-cat-badge">{idx + 1}</span>
                {isEditing ? (
                  <input
                    className="s-cat-input inp"
                    value={editingVal}
                    autoFocus
                    onChange={e => setEditingVal(e.target.value)}
                    onBlur={commitEditCat}
                    onKeyDown={e => { if (e.key === "Enter") commitEditCat(); if (e.key === "Escape") setEditingCat(null); }}
                  />
                ) : (
                  <span
                    className="s-cat-name"
                    onClick={() => startEditCat(catPool, idx, cat)}
                  >
                    {cat}
                  </span>
                )}
                <button
                  className="s-cat-del"
                  onClick={() => removeCat(catPool, idx)}
                  title="删除"
                >
                  ×
                </button>
              </div>
            );
          })}
          <div className="s-row" style={{ gap: 10 }}>
            <button className="btn" style={{ flex: 1, fontSize: 13 }} onClick={() => addCat(catPool)}>
              + 添加分类
            </button>
            <button className="btn" style={{ flex: 1, fontSize: 13 }} onClick={() => resetCats(catPool)}>
              恢复默认
            </button>
          </div>
        </SSection>

        {/* ── 更多 ─────────────────────────────────────── */}
        <SSection title="更多">
          <SRow label="开通 / 续费会员" right="›" onClick={() => alert("请联系客服开通会员")} />
          <SRow label="账号信息" right="›" onClick={() => alert("功能开发中")} />
          <SRow label="修改密码" right="›" onClick={() => alert("功能开发中")} />
          <SRow label="使用帮助" right="›" onClick={() => alert("功能开发中")} />
          <SRow label="问题反馈" right="›" onClick={() => alert("功能开发中")} />
          <SRow label="窗口置顶（桌面版）"
            rightNode={
              <SToggle
                on={settings.windowPinned}
                onChange={v => setSetting("windowPinned", v)}
              />
            }
          />
          <SRow
            label="注销账号"
            right="›"
            onClick={() => alert("注销账号请联系客服")}
            danger
          />
        </SSection>

        {/* ── 诊断 ─────────────────────────────────────── */}
        <SSection title="连接诊断">
          <DiagnosticPanel />
        </SSection>

        {/* 版本 */}
        <div className="s-version">金玖音效助手 v{APP_VERSION}</div>

      </div>
    </div>
  );
}
