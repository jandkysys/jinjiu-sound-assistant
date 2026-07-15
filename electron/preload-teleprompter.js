/**
 * Electron Preload（悬浮提词窗口专用）
 *
 * 只暴露提词器所需的 IPC（最小权限原则）：
 *  - tpAPI  读写提词数据 + 窗口控制
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tpAPI", {
  /** 获取提词器数据（脚本、字号、速度等） */
  getData: () => ipcRenderer.invoke("tp-get-data"),

  /** 保存提词器数据到 userData 并通知主进程 */
  saveData: (data) => ipcRenderer.invoke("tp-save-data", data),

  /** 关闭/隐藏提词器窗口 */
  close: () => ipcRenderer.invoke("tp-close"),

  /** 开启/关闭防采集（setContentProtection）*/
  setProtection: (enabled) => ipcRenderer.invoke("tp-set-protection", enabled),

  /** 开启/关闭鼠标穿透（setIgnoreMouseEvents）*/
  setPassthrough: (enabled) => ipcRenderer.invoke("tp-set-passthrough", enabled),

  /** 设置窗口透明度 0.1~1.0 */
  setOpacity: (val) => ipcRenderer.invoke("tp-set-opacity", val),

  /** 移动窗口到下一个显示器 */
  moveToScreen: () => ipcRenderer.invoke("tp-move-to-screen"),

  /**
   * 监听主进程推送的数据更新（脚本被主窗口改变时触发）
   * @param {(data: object) => void} cb
   */
  onDataChanged: (cb) => {
    ipcRenderer.on("tp-data-changed", (_ev, data) => cb(data));
  },

  /**
   * 监听来自主进程的控制命令（全局快捷键触发）
   * command: 'play' | 'pause' | 'toggle' | 'prev' | 'next' | 'hide'
   * @param {(command: string) => void} cb
   */
  onCommand: (cb) => {
    ipcRenderer.on("tp-command", (_ev, command) => cb(command));
  },
});
