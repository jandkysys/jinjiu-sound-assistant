/**
 * Electron Preload 脚本（悬浮窗 hotkeyFloatWindow 专用）
 *
 * 只暴露悬浮窗所需的 IPC 方法（最小权限原则）。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floatAPI", {

  /** 切换快捷键开启/关闭。返回 Promise<boolean>（新状态）。 */
  toggleHotkeys:   () => ipcRenderer.invoke("toggle-hotkeys"),

  /** 获取当前快捷键状态。返回 Promise<boolean>。 */
  getStatus:       () => ipcRenderer.invoke("get-hotkey-status"),

  /**
   * 监听主进程广播的状态变化。
   * @param {(enabled: boolean) => void} cb
   */
  onHotkeyStatusChanged: (cb) => {
    ipcRenderer.on("hotkey-status-changed", (_event, enabled) => cb(enabled));
  },

  /** 显示主窗口 */
  showMainWindow:  () => ipcRenderer.invoke("show-main-window"),

  /** 隐藏自身（悬浮窗） */
  hideFloatWindow: () => ipcRenderer.invoke("hide-float-window"),

  /** 显示右键原生上下文菜单 */
  showContextMenu: () => ipcRenderer.invoke("float-context-menu"),

  /** 退出整个软件 */
  quitApp:         () => ipcRenderer.invoke("quit-app"),
});
