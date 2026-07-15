/**
 * Electron 主进程
 *
 * 窗口体系：
 *  - mainWindow        主程序窗口（关闭 → 隐藏到托盘，不退出）
 *  - hotkeyFloatWindow 音效快捷键悬浮胶囊（始终置顶，独立于主窗口）
 *  - tray              系统托盘图标（右键菜单）
 *
 * 快捷键状态机：
 *  hotkeyEnabled = false 时 globalShortcut 全部注销（OS 级别关闭）
 *  hotkeyEnabled = true  时 _gsHandlers 内已存储的快捷键全部重新注册
 *  渲染进程通过 notify-hotkey-status 汇报状态变化
 *  悬浮窗通过 toggle-hotkeys 切换状态
 *  主进程广播 hotkey-status-changed 给所有窗口
 *
 * 音频文件存储：
 *  userData/jt_sounds/{id}.{ext}
 *  渲染进程通过 electronFS IPC 读写，不使用 IndexedDB blob
 *
 * API 代理（解决 CORS + file:// URL 问题）：
 *  渲染进程所有 /api/* 请求通过 api-fetch IPC 由主进程转发
 *  API 服务器地址存储在 userData/config.json → apiBaseUrl
 *  首次使用时渲染进程通过 set-api-base 配置并持久化
 */

const {
  app, BrowserWindow, globalShortcut,
  ipcMain, shell, Tray, Menu, nativeImage, screen, net,
} = require("electron");

// Allow hidden audioWindow to play sounds without a prior user gesture.
// Must be called before app.whenReady().
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { pathToFileURL } = require("url");

// ─── 托盘图标（内嵌 16×16 金色 PNG base64）──────────────────────────────────

const TRAY_ICON_B64 = "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";

function getTrayIcon() {
  return nativeImage.createFromDataURL("data:image/png;base64," + TRAY_ICON_B64);
}

// ─── 全局状态 ─────────────────────────────────────────────────────────────────

let hotkeyEnabled = false; // 每次进程启动均默认关闭
let mainWindow = null;
let audioWindow = null;    // 隐藏音频工作窗口：始终后台运行，负责全局快捷键播放
let hotkeyFloatWindow = null;
let floatPanelBounds = null;
let floatBoundsSaveTimer = null;
let tray = null;
let isQuitting = false;
let soundsDir = null;  // 音频文件存储目录（app ready 后初始化）
let teleprompterWindow = null;  // 悬浮提词窗口
let tpDataPath = null;          // userData/tp-data.json（app ready 后初始化）
const DEFAULT_API_BASE = "https://crystal-clear-prompt.replit.app";
let apiBaseUrl = DEFAULT_API_BASE;   // API 服务器地址（userData/config.json 持久化）

// ─── API 配置持久化 ───────────────────────────────────────────────────────────

function loadApiConfig() {
  try {
    const cfgPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (typeof cfg.apiBaseUrl === "string" && cfg.apiBaseUrl.trim()) {
        const stored = cfg.apiBaseUrl.replace(/\/+$/, "");
        // 若存储的是 localhost 地址（开发环境遗留），回退到生产地址
        if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(stored)) {
          console.log("[金玖] 检测到 config.json 中存有 localhost 地址，已自动重置为生产服务器:", DEFAULT_API_BASE);
          apiBaseUrl = DEFAULT_API_BASE;
          saveApiConfig(); // 覆写 config.json，消除残留的 localhost 配置
        } else {
          apiBaseUrl = stored;
          console.log("[金玖] 从 config.json 加载 API 地址:", apiBaseUrl);
        }
      } else {
        console.log("[金玖] config.json 中无 apiBaseUrl，使用默认:", apiBaseUrl);
      }
      if (cfg.floatPanelBounds && Number.isFinite(cfg.floatPanelBounds.x) && Number.isFinite(cfg.floatPanelBounds.y)) {
        floatPanelBounds = { x: cfg.floatPanelBounds.x, y: cfg.floatPanelBounds.y };
      }
    } else {
      console.log("[金玖] config.json 不存在，使用默认 API 地址:", apiBaseUrl);
    }
  } catch (e) {
    console.warn("[金玖] 读取 config.json 失败，使用默认 API 地址:", apiBaseUrl, e);
  }
}

function saveApiConfig() {
  try {
    const cfgPath = path.join(app.getPath("userData"), "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ apiBaseUrl, hotkeyEnabled, floatPanelBounds }, null, 2),
      "utf8",
    );
  } catch {}
}

/**
 * 全局快捷键注册表：key → OS-level handler function
 * unregisterAll 时不清空此 Map，以便重新启用时无需渲染进程重新发起 gs-register。
 */
const _gsHandlers = new Map();

/**
 * 每个渲染进程（by webContents.id）注册过哪些 key
 * 用于 gs-unregister-all 时只撤销当前调用方注册的快捷键，防止误清其他窗口的注册。
 */
const _senderKeys = new Map(); // senderId → Set<key>

/**
 * 功能快捷键注册表（key → OS handler）
 * gs-fire 路由到 mainWindow，而非 audioWindow，用于控制软件状态。
 */
const _funcGsHandlers = new Map();

// ─── IPC ─────────────────────────────────────────────────────────────────────

function setupIpc() {

  // ── 全局快捷键注册/注销（渲染进程 globalShortcutBridge 调用）──────────────

  ipcMain.handle("gs-register", (event, key) => {
    const sender = event.sender;
    const sid = sender.id;

    // 记录该发送方注册了哪些键（用于 gs-unregister-all 时只撤销自己的）
    if (!_senderKeys.has(sid)) _senderKeys.set(sid, new Set());
    _senderKeys.get(sid).add(key);

    // The main renderer is the only audio owner. Closing the main window hides
    // it to the tray, so it remains alive and can play while not visible.
    const handler = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("gs-fire", key);
      }
    };
    _gsHandlers.set(key, handler);

    if (!hotkeyEnabled) return true; // 快捷键已关闭，仅存表不注册 OS

    // 先撤销旧注册（让新调用方的 handler 生效），再重新注册
    if (globalShortcut.isRegistered(key)) globalShortcut.unregister(key);
    try {
      const ok = globalShortcut.register(key, handler);
      if (!ok) console.warn(`[GlobalShortcut] ${key} 注册失败（可能被其他程序占用）`);
      return ok;
    } catch (e) {
      console.error(`[GlobalShortcut] ${key} 注册异常:`, e);
      return false;
    }
  });

  ipcMain.handle("gs-unregister", (event, key) => {
    const sid = event.sender.id;
    const senderSet = _senderKeys.get(sid);
    if (senderSet) senderSet.delete(key);
    globalShortcut.unregister(key);
    _gsHandlers.delete(key);
  });

  ipcMain.handle("gs-unregister-all", (event) => {
    const sid = event.sender.id;
    const keys = _senderKeys.get(sid);
    if (!keys) {
      // 无记录时兜底：全清（兼容旧行为）
      globalShortcut.unregisterAll();
      _gsHandlers.clear();
      return;
    }
    for (const key of keys) {
      if (_gsHandlers.has(key)) {
        try { globalShortcut.unregister(key); } catch {}
        _gsHandlers.delete(key);
      }
    }
    _senderKeys.delete(sid);
  });

  ipcMain.handle("gs-is-registered", (_, key) =>
    globalShortcut.isRegistered(key)
  );

  // ── 功能快捷键（fire 路由到 mainWindow，控制软件状态而非音效播放）──────────

  ipcMain.handle("func-gs-register", (_, key) => {
    const handler = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("func-gs-fire", key);
      }
    };
    _funcGsHandlers.set(key, handler);
    if (!hotkeyEnabled) return true; // 仅存表，不注册 OS
    if (globalShortcut.isRegistered(key)) globalShortcut.unregister(key);
    try {
      const ok = globalShortcut.register(key, handler);
      if (!ok) console.warn(`[FuncGS] ${key} 注册失败（可能被其他程序占用）`);
      return ok;
    } catch (e) {
      console.error(`[FuncGS] ${key} 注册异常:`, e);
      return false;
    }
  });

  ipcMain.handle("func-gs-unregister", (_, key) => {
    _funcGsHandlers.delete(key);
    try { globalShortcut.unregister(key); } catch (_) {}
  });

  ipcMain.handle("func-gs-unregister-all", () => {
    for (const key of _funcGsHandlers.keys()) {
      try { globalShortcut.unregister(key); } catch (_) {}
    }
    _funcGsHandlers.clear();
  });

  // ── 快捷键主开关 ──────────────────────────────────────────────────────────

  ipcMain.handle("get-hotkey-status", () => hotkeyEnabled);

  ipcMain.handle("notify-hotkey-status", (_, enabled) => {
    const newState = !!enabled;
    if (newState !== hotkeyEnabled) {
      hotkeyEnabled = newState;
      syncOsShortcuts();
    }
    broadcastHotkeyStatus();
  });

  ipcMain.handle("toggle-hotkeys", () => {
    hotkeyEnabled = !hotkeyEnabled;
    syncOsShortcuts();
    broadcastHotkeyStatus();
    return hotkeyEnabled;
  });

  ipcMain.handle("enable-hotkeys", () => {
    if (hotkeyEnabled) return true;
    hotkeyEnabled = true;
    syncOsShortcuts();
    broadcastHotkeyStatus();
    return true;
  });

  ipcMain.handle("disable-hotkeys", () => {
    if (!hotkeyEnabled) return false;
    hotkeyEnabled = false;
    syncOsShortcuts();
    broadcastHotkeyStatus();
    return false;
  });

  // ── 窗口管理 IPC ──────────────────────────────────────────────────────────

  ipcMain.handle("show-main-window", () => showMainWindow());

  ipcMain.handle("hide-float-window", () => {
    if (hotkeyFloatWindow && !hotkeyFloatWindow.isDestroyed()) {
      hotkeyFloatWindow.hide();
      updateTray();
    }
  });

  ipcMain.handle("quit-app", () => {
    isQuitting = true;
    cleanup();
    app.quit();
  });

  ipcMain.handle("float-context-menu", () => {
    const items = [
      { label: "显示主窗口", click: showMainWindow },
      { type: "separator" },
      {
        label: "开启快捷键",
        enabled: !hotkeyEnabled,
        click: () => {
          hotkeyEnabled = true;
          syncOsShortcuts();
          broadcastHotkeyStatus();
        },
      },
      {
        label: "关闭快捷键",
        enabled: hotkeyEnabled,
        click: () => {
          hotkeyEnabled = false;
          syncOsShortcuts();
          broadcastHotkeyStatus();
        },
      },
      { type: "separator" },
      {
        label: "隐藏悬浮按钮",
        click: () => {
          if (hotkeyFloatWindow && !hotkeyFloatWindow.isDestroyed()) {
            hotkeyFloatWindow.hide();
          }
        },
      },
      { type: "separator" },
      {
        label: "退出软件",
        click: () => { isQuitting = true; cleanup(); app.quit(); },
      },
    ];
    const menu = Menu.buildFromTemplate(items);
    if (hotkeyFloatWindow && !hotkeyFloatWindow.isDestroyed()) {
      menu.popup({ window: hotkeyFloatWindow });
    }
  });

  // ── 音频文件存储 IPC（渲染进程 electronFS 桥接）───────────────────────────

  /**
   * 保存音频文件：{ id, buffer: ArrayBuffer, ext } → { ok, url?, error? }
   * 文件保存到 userData/jt_sounds/{id}.{ext}
   */
  ipcMain.handle("fs-save-audio", async (_, { id, buffer, ext }) => {
    if (!soundsDir) return { ok: false, error: "soundsDir 未就绪" };
    try {
      const filePath = path.join(soundsDir, `${id}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return { ok: true, url: pathToFileURL(filePath).href };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  /**
   * 获取音频文件的 file:// URL：{ id, ext } → string | null
   */
  ipcMain.handle("fs-get-audio-url", (_, { id, ext }) => {
    if (!soundsDir) return null;
    const filePath = path.join(soundsDir, `${id}.${ext}`);
    return fs.existsSync(filePath) ? pathToFileURL(filePath).href : null;
  });

  /**
   * 删除一批音频文件：[{ id, ext }] → void
   */
  ipcMain.handle("fs-delete-audio", (_, ids) => {
    if (!soundsDir || !Array.isArray(ids)) return;
    for (const { id, ext } of ids) {
      try {
        const filePath = path.join(soundsDir, `${id}.${ext}`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {}
    }
  });

  /**
   * 判断音频文件是否存在：{ id, ext } → boolean
   */
  ipcMain.handle("fs-has-audio", (_, { id, ext }) => {
    if (!soundsDir) return false;
    const filePath = path.join(soundsDir, `${id}.${ext}`);
    return fs.existsSync(filePath);
  });

  /**
   * 列出所有已保存的音频文件：→ { id, ext, size }[]
   */
  ipcMain.handle("fs-list-audio", () => {
    if (!soundsDir) return [];
    try {
      return fs.readdirSync(soundsDir)
        .map(f => {
          const m = f.match(/^(.+)\.([^.]+)$/);
          if (!m) return null;
          const [, id, ext] = m;
          const filePath = path.join(soundsDir, f);
          try {
            const { size } = fs.statSync(filePath);
            return { id, ext, size };
          } catch { return null; }
        })
        .filter(Boolean);
    } catch { return []; }
  });

  /**
   * 读取音频文件为 ArrayBuffer（供 getAudioBlob 重建 Blob）：{ id, ext } → ArrayBuffer | null
   */
  ipcMain.handle("fs-read-audio", (_, { id, ext }) => {
    if (!soundsDir) return null;
    const filePath = path.join(soundsDir, `${id}.${ext}`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const buf = fs.readFileSync(filePath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch { return null; }
  });

  // ── API 代理（解决 file:// CORS + 相对 URL 问题）────────────────────────────

  /**
   * 获取已配置的 API 服务器地址（空字符串=未配置）
   */
  ipcMain.handle("get-api-base", () => apiBaseUrl);

  /**
   * 保存 API 服务器地址到 userData/config.json
   */
  ipcMain.handle("set-api-base", (_, url) => {
    apiBaseUrl = (url ?? "").replace(/\/+$/, "");
    saveApiConfig();
  });

  /** 用系统默认浏览器打开 URL（用于测试服务器是否可访问）*/
  ipcMain.handle("open-external", (_, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  /**
   * 通过主进程转发 HTTP/HTTPS 请求，绕过渲染进程的 CORS 限制。
   * 参数：{ url: string（以 /api/... 开头）, method, headers, body }
   * 返回：{ ok, status, data }
   */
  ipcMain.handle("api-fetch", (_, { url, method, headers, body }) => {
    if (!apiBaseUrl) {
      return Promise.resolve({
        ok: false,
        status: 0,
        data: { error: "API服务器未配置，请先设置服务器地址" },
      });
    }

    const fullUrl = apiBaseUrl + (url.startsWith("/") ? url : "/" + url);
    console.log("[金玖] api-fetch →", method || "GET", fullUrl);

    try { new URL(fullUrl); }
    catch {
      return Promise.resolve({ ok: false, status: 0, data: { error: "无效的服务器地址: " + fullUrl } });
    }

    return new Promise((resolve) => {
      const bodyBuf = body ? Buffer.from(body, "utf8") : null;
      const reqHeaders = Object.assign({ "Content-Type": "application/json" }, headers ?? {});

      let req;
      try {
        req = net.request({ method: method || "GET", url: fullUrl, redirect: "follow" });
      } catch (e) {
        return resolve({ ok: false, status: 0, data: { error: "网络模块初始化失败：" + e.message } });
      }

      for (const [k, v] of Object.entries(reqHeaders)) {
        try { req.setHeader(k, String(v)); } catch (_) {}
      }

      const timer = setTimeout(() => {
        try { req.abort(); } catch (_) {}
        resolve({ ok: false, status: 0, data: { error: "请求超时（30s），请检查网络连接" } });
      }, 30000);

      req.on("response", (res) => {
        clearTimeout(timer);
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data,
          });
        });
        res.on("error", (err) => {
          resolve({ ok: false, status: 0, data: { error: "读取响应失败：" + err.message } });
        });
      });

      req.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, status: 0, data: { error: "网络连接失败：" + err.message } });
      });

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  });

  /**
   * 通过主进程转发 HTTP/HTTPS 请求，以 base64 字符串返回原始二进制体。
   * 专供音频文件下载使用（api-fetch 会把 Buffer.toString("utf8") 破坏二进制）。
   * 参数：{ url: string（以 /api/ 或 https:// 开头）, headers }
   * 返回：{ ok, status, base64, contentType }
   */
  ipcMain.handle("api-fetch-buffer", (_, { url, headers }) => {
    // 已是绝对 URL 就直接用，否则拼 apiBaseUrl
    const isAbsolute = /^https?:\/\//i.test(url);
    const fullUrl = isAbsolute
      ? url
      : (apiBaseUrl + (url.startsWith("/") ? url : "/" + url));

    if (!fullUrl || !/^https?:\/\//i.test(fullUrl)) {
      return Promise.resolve({ ok: false, status: 0, base64: null, error: "无效地址: " + fullUrl });
    }

    return new Promise((resolve) => {
      const reqHeaders = Object.assign({}, headers ?? {});

      let req;
      try {
        req = net.request({ method: "GET", url: fullUrl, redirect: "follow" });
      } catch (e) {
        return resolve({ ok: false, status: 0, base64: null, error: "网络模块初始化失败：" + e.message });
      }

      for (const [k, v] of Object.entries(reqHeaders)) {
        try { req.setHeader(k, String(v)); } catch (_) {}
      }

      const timer = setTimeout(() => {
        try { req.abort(); } catch (_) {}
        resolve({ ok: false, status: 0, base64: null, error: "下载超时" });
      }, 60000);  // 音频文件给 60 秒

      req.on("response", (res) => {
        clearTimeout(timer);
        const contentType = res.headers["content-type"] || "";
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, base64: buf.toString("base64"), contentType });
          } else {
            resolve({ ok: false, status: res.statusCode, base64: null, error: buf.toString("utf8").slice(0, 200) });
          }
        });
        res.on("error", (err) => {
          resolve({ ok: false, status: 0, base64: null, error: "读取响应失败：" + err.message });
        });
      });

      req.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, status: 0, base64: null, error: "连接失败：" + err.message });
      });

      req.end();
    });
  });

  /**
   * 通过主进程转发 multipart/form-data 文件上传请求（绕过 file:// CORS）。
   * 参数：{ url, headers, fieldName, base64Data, filename, contentType, extraFields }
   * 返回：{ ok, status, data }
   */
  ipcMain.handle("api-upload-file", (_, { url, headers, fieldName, base64Data, filename, contentType, extraFields }) => {
    if (!apiBaseUrl) {
      return Promise.resolve({ ok: false, status: 0, data: { error: "API服务器未配置" } });
    }
    const fullUrl = apiBaseUrl + (url.startsWith("/") ? url : "/" + url);
    console.log("[金玖] api-upload-file →", fullUrl, filename);

    const boundary = "----ElectronBdy" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const fileBuffer = Buffer.from(base64Data || "", "base64");

    // Build multipart body
    const parts = [];
    // File part header
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType || "application/octet-stream"}\r\n\r\n`,
      "utf8"
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from("\r\n", "utf8"));
    // Extra text fields
    for (const [key, value] of Object.entries(extraFields || {})) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
        "utf8"
      ));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    const bodyBuffer = Buffer.concat(parts);

    return new Promise((resolve) => {
      const reqHeaders = {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(bodyBuffer.length),
        ...(headers ?? {}),
      };

      let req;
      try {
        req = net.request({ method: "POST", url: fullUrl, redirect: "follow" });
      } catch (e) {
        return resolve({ ok: false, status: 0, data: { error: "网络模块初始化失败：" + e.message } });
      }

      for (const [k, v] of Object.entries(reqHeaders)) {
        try { req.setHeader(k, String(v)); } catch (_) {}
      }

      const timer = setTimeout(() => {
        try { req.abort(); } catch (_) {}
        resolve({ ok: false, status: 0, data: { error: "上传超时（60s）" } });
      }, 60000);

      req.on("response", (res) => {
        clearTimeout(timer);
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        });
        res.on("error", (err) => resolve({ ok: false, status: 0, data: { error: "读取响应失败：" + err.message } }));
      });

      req.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, status: 0, data: { error: "上传失败：" + err.message } });
      });

      req.write(bodyBuffer);
      req.end();
    });
  });

  // ─── 悬浮提词器 IPC ───────────────────────────────────────────────────────

  ipcMain.handle("tp-open", () => {
    openTeleprompterWindow();
    return true;
  });

  ipcMain.handle("tp-close", () => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
      teleprompterWindow.hide();
      broadcastTpStatus(false);
    }
    return true;
  });

  ipcMain.handle("tp-toggle", () => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed() && teleprompterWindow.isVisible()) {
      teleprompterWindow.hide();
      broadcastTpStatus(false);
    } else {
      openTeleprompterWindow();
    }
    return true;
  });

  ipcMain.handle("tp-is-open", () => {
    return !!(teleprompterWindow && !teleprompterWindow.isDestroyed() && teleprompterWindow.isVisible());
  });

  ipcMain.handle("tp-get-data", () => loadTpData());

  ipcMain.handle("tp-save-data", (_event, data) => {
    saveTpData(data);
    // 推送到提词窗口
    if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
      teleprompterWindow.webContents.send("tp-data-changed", data);
    }
    return true;
  });

  ipcMain.handle("tp-set-protection", (_event, enabled) => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
      teleprompterWindow.setContentProtection(!!enabled);
    }
    return true;
  });

  ipcMain.handle("tp-set-passthrough", (_event, enabled) => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
      teleprompterWindow.setIgnoreMouseEvents(!!enabled);
    }
    return true;
  });

  ipcMain.handle("tp-set-opacity", (_event, val) => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
      const v = Math.max(0.1, Math.min(1.0, Number(val)));
      teleprompterWindow.setOpacity(v);
    }
    return true;
  });

  ipcMain.handle("tp-move-to-screen", () => {
    if (!teleprompterWindow || teleprompterWindow.isDestroyed()) return;
    const displays = screen.getAllDisplays();
    if (displays.length < 2) return;
    const current = screen.getDisplayNearestPoint(teleprompterWindow.getBounds());
    const next = displays.find(d => d.id !== current.id) || displays[0];
    const { x, y, width } = next.workArea;
    const [tw] = teleprompterWindow.getSize();
    teleprompterWindow.setPosition(x + Math.round((width - tw) / 2), y + 40);
  });
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function syncOsShortcuts() {
  if (hotkeyEnabled) {
    // 先注册音效快捷键，再注册功能快捷键（同 key 时功能快捷键优先）
    for (const [key, handler] of _gsHandlers) {
      // 若同 key 已在 _funcGsHandlers 中，跳过（func 版本后续会覆盖）
      if (_funcGsHandlers.has(key)) continue;
      if (!globalShortcut.isRegistered(key)) {
        globalShortcut.register(key, handler);
      }
    }
    for (const [key, handler] of _funcGsHandlers) {
      // 功能快捷键始终覆盖同 key 的音效快捷键
      if (globalShortcut.isRegistered(key)) globalShortcut.unregister(key);
      globalShortcut.register(key, handler);
    }
  } else {
    globalShortcut.unregisterAll();
  }
}

function broadcastHotkeyStatus() {
  notifyMain(hotkeyEnabled);
  notifyFloat(hotkeyEnabled);
  updateTray();
  saveApiConfig(); // 保存 API 与悬浮窗位置；启动时快捷键仍会强制关闭
}

function notifyMain(enabled) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("hotkey-status-changed", enabled);
  }
}

function notifyFloat(enabled) {
  if (hotkeyFloatWindow && !hotkeyFloatWindow.isDestroyed()) {
    hotkeyFloatWindow.webContents.send("hotkey-status-changed", enabled);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ─── 托盘 ─────────────────────────────────────────────────────────────────────

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: "金玖音效助手", enabled: false },
    { type: "separator" },
    { label: "显示主窗口", click: showMainWindow },
    {
      label: hotkeyFloatWindow && !hotkeyFloatWindow.isDestroyed() && hotkeyFloatWindow.isVisible()
        ? "隐藏悬浮快捷键"
        : "显示悬浮快捷键",
      click: () => {
        if (!hotkeyFloatWindow || hotkeyFloatWindow.isDestroyed()) {
          createFloatPanelWindow();
        } else if (hotkeyFloatWindow.isVisible()) {
          hotkeyFloatWindow.hide();
        } else {
          hotkeyFloatWindow.show();
        }
        updateTray();
      },
    },
    { type: "separator" },
    {
      label: hotkeyEnabled ? "✓ 快捷键 已开启" : "  快捷键 已关闭",
      click: () => {
        hotkeyEnabled = !hotkeyEnabled;
        syncOsShortcuts();
        broadcastHotkeyStatus();
      },
    },
    { type: "separator" },
    {
      label: teleprompterWindow && !teleprompterWindow.isDestroyed() && teleprompterWindow.isVisible()
        ? "✓ 隐藏提词器"
        : "  显示提词器",
      click: () => {
        if (teleprompterWindow && !teleprompterWindow.isDestroyed() && teleprompterWindow.isVisible()) {
          teleprompterWindow.hide();
          broadcastTpStatus(false);
        } else {
          openTeleprompterWindow();
        }
        updateTray();
      },
    },
    { type: "separator" },
    {
      label: "退出软件",
      click: () => { isQuitting = true; cleanup(); app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`金玖音效助手 — 快捷键${hotkeyEnabled ? "已开启" : "已关闭"}`);
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip("金玖音效助手");
  tray.on("double-click", showMainWindow);
  updateTray();
}

// ─── 窗口创建 ─────────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    resizable: true,
    backgroundColor: "#F7F1E8",
    title: "金玖音效助手",
    icon: path.join(__dirname, "resources/icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,  // 最小化后仍响应 IPC / 快捷键
    },
  });

  const isDev = process.env.NODE_ENV === "development";
  if (isDev) {
    // 开发模式：加载本地 Vite dev server
    // - Replit：通过 ELECTRON_DEV_URL 注入完整 URL
    // - 本地 Windows：默认 http://localhost:3000
    const devUrl = process.env.ELECTRON_DEV_URL || "http://localhost:3000";
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    // 生产模式：加载 vite build 输出的 dist/electron/index.html
    mainWindow.loadFile(path.join(__dirname, "../dist/electron/index.html"));
  }

  // 关闭 → 隐藏到托盘（不退出）
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function getInitialFloatPanelPosition(width, height) {
  if (floatPanelBounds) {
    const intersectsDisplay = screen.getAllDisplays().some(({ workArea }) =>
      floatPanelBounds.x < workArea.x + workArea.width &&
      floatPanelBounds.x + width > workArea.x &&
      floatPanelBounds.y < workArea.y + workArea.height &&
      floatPanelBounds.y + height > workArea.y
    );
    if (intersectsDisplay) return floatPanelBounds;
  }

  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
  };
}

function createFloatPanelWindow() {
  if (hotkeyFloatWindow && !hotkeyFloatWindow.isDestroyed()) {
    hotkeyFloatWindow.show();
    return;
  }

  const width = 150;
  const height = 78;
  const initialPosition = getInitialFloatPanelPosition(width, height);
  hotkeyFloatWindow = new BrowserWindow({
    width,
    height,
    x: initialPosition.x,
    y: initialPosition.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: ["--float-panel"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  hotkeyFloatWindow.setAlwaysOnTop(true, "screen-saver");
  hotkeyFloatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const isDev = process.env.NODE_ENV === "development";
  if (isDev) {
    const devUrl = process.env.ELECTRON_DEV_URL || "http://localhost:3000";
    hotkeyFloatWindow.loadURL(`${devUrl}#/float-sound-panel`);
  } else {
    hotkeyFloatWindow.loadFile(path.join(__dirname, "../dist/electron/index.html"), {
      hash: "/float-sound-panel",
    });
  }

  hotkeyFloatWindow.webContents.once("did-finish-load", () => {
    if (hotkeyFloatWindow && !hotkeyFloatWindow.isDestroyed()) {
      hotkeyFloatWindow.showInactive();
      updateTray();
    }
  });

  hotkeyFloatWindow.on("move", () => {
    if (!hotkeyFloatWindow || hotkeyFloatWindow.isDestroyed()) return;
    if (floatBoundsSaveTimer) clearTimeout(floatBoundsSaveTimer);
    floatBoundsSaveTimer = setTimeout(() => {
      if (!hotkeyFloatWindow || hotkeyFloatWindow.isDestroyed()) return;
      const { x, y } = hotkeyFloatWindow.getBounds();
      floatPanelBounds = { x, y };
      saveApiConfig();
    }, 150);
  });

  hotkeyFloatWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hotkeyFloatWindow.hide();
      updateTray();
    }
  });

  hotkeyFloatWindow.on("show", updateTray);
  hotkeyFloatWindow.on("hide", updateTray);
}

// ─── 清理 ─────────────────────────────────────────────────────────────────────

function createAudioWindow() {
  audioWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,          // 永久隐藏，用户不可见
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-audio.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 后台不限速：保证快捷键触发时 AudioContext 正常运行
    },
  });

  const isDev = process.env.NODE_ENV === "development";
  if (isDev) {
    const devUrl = process.env.ELECTRON_DEV_URL || "http://localhost:3000";
    audioWindow.loadURL(devUrl + "#/audio-worker");
  } else {
    audioWindow.loadFile(path.join(__dirname, "../dist/electron/index.html"), {
      hash: "/audio-worker",
    });
  }

  // 阻止关闭（只隐藏）
  audioWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      audioWindow.hide();
    }
  });
}

// ─── 提词器辅助函数 ───────────────────────────────────────────────────────────

const DEFAULT_TP_DATA = {
  script: "",
  fontSize: 32,
  speed: 1.0,
  opacity: 0.92,
  protection: false,
  passthrough: false,
};

function loadTpData() {
  try {
    if (tpDataPath && fs.existsSync(tpDataPath)) {
      return { ...DEFAULT_TP_DATA, ...JSON.parse(fs.readFileSync(tpDataPath, "utf8")) };
    }
  } catch {}
  return { ...DEFAULT_TP_DATA };
}

function saveTpData(patch) {
  try {
    const current = loadTpData();
    const next = { ...current, ...patch };
    fs.writeFileSync(tpDataPath, JSON.stringify(next, null, 2), "utf8");
  } catch {}
}

function broadcastTpStatus(isOpen) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("tp-status-changed", isOpen);
  }
}

function createTeleprompterWindow() {
  if (teleprompterWindow && !teleprompterWindow.isDestroyed()) return;

  const data = loadTpData();
  const { workArea } = screen.getPrimaryDisplay();

  teleprompterWindow = new BrowserWindow({
    width: 820,
    height: 270,
    x: Math.round(workArea.x + (workArea.width - 820) / 2),
    y: workArea.y + 30,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-teleprompter.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  teleprompterWindow.setAlwaysOnTop(true, "screen-saver");
  teleprompterWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (data.opacity != null) teleprompterWindow.setOpacity(Math.max(0.1, Math.min(1, data.opacity)));

  teleprompterWindow.loadFile(path.join(__dirname, "teleprompter.html"));

  teleprompterWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      teleprompterWindow.hide();
      broadcastTpStatus(false);
    }
  });

  teleprompterWindow.on("closed", () => {
    teleprompterWindow = null;
  });
}

function openTeleprompterWindow() {
  if (!teleprompterWindow || teleprompterWindow.isDestroyed()) {
    createTeleprompterWindow();
  }
  teleprompterWindow.show();
  broadcastTpStatus(true);
}

function sendTpCommand(command) {
  if (teleprompterWindow && !teleprompterWindow.isDestroyed() && teleprompterWindow.isVisible()) {
    teleprompterWindow.webContents.send("tp-command", command);
  }
}

function cleanup() {
  globalShortcut.unregisterAll();
  _gsHandlers.clear();
  _senderKeys.clear();
  if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
    teleprompterWindow.destroy();
    teleprompterWindow = null;
  }
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}

// ─── App 生命周期 ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // 初始化音频存储目录
  soundsDir = path.join(app.getPath("userData"), "jt_sounds");
  if (!fs.existsSync(soundsDir)) {
    fs.mkdirSync(soundsDir, { recursive: true });
  }

  // 初始化提词器数据文件路径
  tpDataPath = path.join(app.getPath("userData"), "tp-data.json");

  // 读取 API 服务器配置
  loadApiConfig();
  // 全局音效快捷键是运行期状态，不恢复上次的开启值。
  hotkeyEnabled = false;
  console.log("[金玖] 应用启动完成。当前 API 地址：", apiBaseUrl);
  console.log("[金玖] userData 目录：", app.getPath("userData"));

  setupIpc();
  createMainWindow();
  createFloatPanelWindow();
  createTeleprompterWindow(); // 提词器窗口（默认隐藏）
  createTray();

  // ─── 悬浮提词器全局快捷键 ─────────────────────────────────────────────
  // 这些快捷键在直播穿透模式下仍然有效（不受音效快捷键开关影响）

  // Ctrl+Alt+Space  播放/暂停
  globalShortcut.register("Ctrl+Alt+Space", () => sendTpCommand("toggle"));

  // Ctrl+Alt+Up  上一句
  globalShortcut.register("Ctrl+Alt+Up", () => sendTpCommand("prev"));

  // Ctrl+Alt+Down  下一句
  globalShortcut.register("Ctrl+Alt+Down", () => sendTpCommand("next"));

  // Ctrl+Alt+H  显示/隐藏提词器
  globalShortcut.register("Ctrl+Alt+H", () => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed() && teleprompterWindow.isVisible()) {
      teleprompterWindow.hide();
      broadcastTpStatus(false);
    } else {
      openTeleprompterWindow();
    }
    updateTray();
  });

  // Ctrl+Alt+P  切换鼠标穿透
  globalShortcut.register("Ctrl+Alt+P", () => {
    if (!teleprompterWindow || teleprompterWindow.isDestroyed()) return;
    const data = loadTpData();
    const next = !data.passthrough;
    teleprompterWindow.setIgnoreMouseEvents(next);
    saveTpData({ passthrough: next });
    teleprompterWindow.webContents.send("tp-command", next ? "passthrough-on" : "passthrough-off");
  });

  // Ctrl+Alt+G  切换防采集
  globalShortcut.register("Ctrl+Alt+G", () => {
    if (!teleprompterWindow || teleprompterWindow.isDestroyed()) return;
    const data = loadTpData();
    const next = !data.protection;
    teleprompterWindow.setContentProtection(next);
    saveTpData({ protection: next });
    teleprompterWindow.webContents.send("tp-command", next ? "protection-on" : "protection-off");
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length === 0) {
      createMainWindow();
    }
  });
});

// 不自动退出——所有窗口关闭后仍保留托盘
app.on("window-all-closed", () => {
  // 故意留空：托盘仍运行，用户需通过托盘菜单退出
});

app.on("will-quit", () => {
  cleanup();
});
