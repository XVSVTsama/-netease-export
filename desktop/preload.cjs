// 把 Tauri 的 invoke 桥到 Electron 主进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__TAURI__', {
  core: {
    invoke: (cmd, args) => ipcRenderer.invoke('eta:invoke', cmd, args || {}),
  },
});
