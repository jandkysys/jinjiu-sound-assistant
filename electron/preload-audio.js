/**
 * Electron Preload 脚本（隐藏音频工作窗口专用）
 *
 * 与 preload.js 相同，额外暴露 electronAPI.isAudioWorker = true，
 * 供渲染层跳过 ServerSetup / AuthGate，直接渲染 AudioWorker 组件。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronGS", {
  register:      (key) => ipcRenderer.invoke("gs-register", key),
  unregister:    (key) => ipcRenderer.invoke("gs-unregister", key),
  unregisterAll: ()    => ipcRenderer.invoke("gs-unregister-all"),
  isRegistered:  (key) => ipcRenderer.invoke("gs-is-registered", key),

  onFire: (cb) => {
    ipcRenderer.on("gs-fire", (_event, key) => cb(key));
  },
});

contextBridge.exposeInMainWorld("electronAPI", {
  platform:      process.platform,
  isElectron:    true,
  isAudioWorker: true,  // ← 标识：此窗口为隐藏音频工作窗口

  getHotkeyStatus:    () => ipcRenderer.invoke("get-hotkey-status"),
  notifyHotkeyStatus: (enabled) => ipcRenderer.invoke("notify-hotkey-status", enabled),

  onHotkeyStatusChanged: (cb) => {
    ipcRenderer.on("hotkey-status-changed", (_event, enabled) => cb(enabled));
  },

  showMainWindow:  () => ipcRenderer.invoke("show-main-window"),
  hideFloatWindow: () => ipcRenderer.invoke("hide-float-window"),
  quitApp:         () => ipcRenderer.invoke("quit-app"),

  getApiBase: () => ipcRenderer.invoke("get-api-base"),
  setApiBase: (url) => ipcRenderer.invoke("set-api-base", url),

  apiFetch: (url, init) => ipcRenderer.invoke("api-fetch", {
    url,
    method:  init?.method  ?? "GET",
    headers: init?.headers ?? {},
    body:    init?.body    ?? null,
  }),
});

contextBridge.exposeInMainWorld("electronFS", {
  saveAudioFile:    (id, buffer, ext) => ipcRenderer.invoke("fs-save-audio", { id, buffer, ext }),
  getAudioUrl:      (id, ext)         => ipcRenderer.invoke("fs-get-audio-url", { id, ext }),
  deleteAudioFiles: (ids)             => ipcRenderer.invoke("fs-delete-audio", ids),
  hasAudioFile:     (id, ext)         => ipcRenderer.invoke("fs-has-audio", { id, ext }),
  listAudioFiles:   ()                => ipcRenderer.invoke("fs-list-audio"),
  readAudioFile:    (id, ext)         => ipcRenderer.invoke("fs-read-audio", { id, ext }),
});
