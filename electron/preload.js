/**
 * Electron Preload 脚本（主窗口）
 *
 * 通过 contextBridge 安全地向渲染进程暴露 IPC API：
 *  - electronGS   全局快捷键桥接（globalShortcutBridge.ts 使用）
 *  - electronAPI  通用平台信息 + 快捷键主开关 IPC
 *  - electronFS   音频文件存储（audioStore.ts Electron 分支使用）
 */

const { contextBridge, ipcRenderer } = require("electron");

// ─── 全局快捷键桥接（与 globalShortcutBridge.ts 配合）──────────────────────

contextBridge.exposeInMainWorld("electronGS", {
  register:      (key) => ipcRenderer.invoke("gs-register", key),
  unregister:    (key) => ipcRenderer.invoke("gs-unregister", key),
  unregisterAll: ()    => ipcRenderer.invoke("gs-unregister-all"),
  isRegistered:  (key) => ipcRenderer.invoke("gs-is-registered", key),

  onFire: (cb) => {
    ipcRenderer.on("gs-fire", (_event, key) => cb(key));
  },
});

// ─── 功能快捷键桥接（fire 路由到 mainWindow，控制软件状态）─────────────────────

contextBridge.exposeInMainWorld("electronFuncGS", {
  register:      (key) => ipcRenderer.invoke("func-gs-register", key),
  unregister:    (key) => ipcRenderer.invoke("func-gs-unregister", key),
  unregisterAll: ()    => ipcRenderer.invoke("func-gs-unregister-all"),

  onFire: (cb) => {
    ipcRenderer.on("func-gs-fire", (_event, key) => cb(key));
  },
});

// ─── 通用平台信息 + 快捷键主开关 IPC ─────────────────────────────────────────

contextBridge.exposeInMainWorld("electronAPI", {
  platform:   process.platform,
  isElectron: true,
  isFloatPanel: process.argv.includes("--float-panel"),

  getHotkeyStatus:    () => ipcRenderer.invoke("get-hotkey-status"),
  notifyHotkeyStatus: (enabled) => ipcRenderer.invoke("notify-hotkey-status", enabled),

  onHotkeyStatusChanged: (cb) => {
    ipcRenderer.on("hotkey-status-changed", (_event, enabled) => cb(enabled));
  },

  showMainWindow:  () => ipcRenderer.invoke("show-main-window"),
  hideFloatWindow: () => ipcRenderer.invoke("hide-float-window"),
  quitApp:         () => ipcRenderer.invoke("quit-app"),

  // ── API 代理（绕过 CORS / file:// 限制）──────────────────────────────────

  /**
   * 获取已保存的 API 服务器地址（空字符串 = 未配置）
   * @returns {Promise<string>}
   */
  getApiBase: () => ipcRenderer.invoke("get-api-base"),

  /**
   * 保存 API 服务器地址（写入 userData/config.json）
   * @param {string} url  例如 https://yourapp.replit.app
   */
  setApiBase: (url) => ipcRenderer.invoke("set-api-base", url),

  /** 用系统浏览器打开 URL，用于测试服务器连通性 */
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  /**
   * 通过主进程转发 HTTP 请求（绕过 CORS + file:// URL 限制）
   * @param {string} url       /api/... 路径
   * @param {{ method?:string, headers?:Record<string,string>, body?:string|null }} init
   * @returns {Promise<{ok:boolean, status:number, data:unknown}>}
   */
  apiFetch: (url, init) => ipcRenderer.invoke("api-fetch", {
    url,
    method:  init?.method  ?? "GET",
    headers: init?.headers ?? {},
    body:    init?.body    ?? null,
  }),

  /**
   * 通过主进程转发 GET 请求，以 base64 字符串返回原始二进制体（专供音频下载）。
   * @param {string} url  /api/... 或完整 https:// URL
   * @returns {Promise<{ok:boolean, status:number, base64:string|null, contentType:string, error?:string}>}
   */
  apiFetchBuffer: (url, init) => ipcRenderer.invoke("api-fetch-buffer", {
    url,
    headers: init?.headers ?? {},
  }),

  /**
   * 通过主进程转发 multipart/form-data 文件上传（绕过 file:// CORS）。
   * @param {string} url  /api/... 路径
   * @param {{ fieldName, base64Data, filename, contentType, extraFields, headers }} opts
   * @returns {Promise<{ok:boolean, status:number, data:unknown}>}
   */
  apiUploadFile: (url, opts) => ipcRenderer.invoke("api-upload-file", {
    url,
    fieldName:   opts?.fieldName   ?? "file",
    base64Data:  opts?.base64Data  ?? "",
    filename:    opts?.filename    ?? "upload",
    contentType: opts?.contentType ?? "application/octet-stream",
    extraFields: opts?.extraFields ?? {},
    headers:     opts?.headers     ?? {},
  }),
});

// ─── 音频文件系统 IPC（替代 IndexedDB blob 存储）──────────────────────────────

contextBridge.exposeInMainWorld("electronFS", {
  /**
   * 保存音频文件到 userData/jt_sounds/{id}.{ext}
   * @returns {Promise<{ok:boolean, url?:string, error?:string}>}
   */
  saveAudioFile: (id, buffer, ext) =>
    ipcRenderer.invoke("fs-save-audio", { id, buffer, ext }),

  /**
   * 获取音效 file:// URL（用于 <audio> 播放）
   * @returns {Promise<string|null>}
   */
  getAudioUrl: (id, ext) =>
    ipcRenderer.invoke("fs-get-audio-url", { id, ext }),

  /**
   * 批量删除音频文件
   * @param {Array<{id:string, ext:string}>} ids
   */
  deleteAudioFiles: (ids) =>
    ipcRenderer.invoke("fs-delete-audio", ids),

  /**
   * @returns {Promise<boolean>}
   */
  hasAudioFile: (id, ext) =>
    ipcRenderer.invoke("fs-has-audio", { id, ext }),

  /**
   * @returns {Promise<Array<{id:string, ext:string, size:number}>>}
   */
  listAudioFiles: () =>
    ipcRenderer.invoke("fs-list-audio"),

  /**
   * 读取为 ArrayBuffer（供导出重建 Blob）
   * @returns {Promise<ArrayBuffer|null>}
   */
  readAudioFile: (id, ext) =>
    ipcRenderer.invoke("fs-read-audio", { id, ext }),
});

// ─── 悬浮提词器控制（主窗口 → 主进程 → 提词窗口）────────────────────────────

contextBridge.exposeInMainWorld("electronTP", {
  /** 打开/显示提词器窗口 */
  open:   () => ipcRenderer.invoke("tp-open"),

  /** 隐藏提词器窗口 */
  close:  () => ipcRenderer.invoke("tp-close"),

  /** 切换显示/隐藏 */
  toggle: () => ipcRenderer.invoke("tp-toggle"),

  /** 当前提词器窗口是否可见 */
  isOpen: () => ipcRenderer.invoke("tp-is-open"),

  /** 读取存储的提词数据（脚本、字号、速度等）*/
  getData: () => ipcRenderer.invoke("tp-get-data"),

  /**
   * 保存提词数据并推送到提词器窗口
   * @param {object} data  Partial<TpData>
   */
  saveData: (data) => ipcRenderer.invoke("tp-save-data", data),

  /**
   * 监听提词器窗口的开/关状态变化
   * @param {(open: boolean) => void} cb
   */
  onStatusChanged: (cb) => {
    ipcRenderer.on("tp-status-changed", (_event, open) => cb(open));
  },
});
