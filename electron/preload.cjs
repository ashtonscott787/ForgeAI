const { contextBridge, ipcRenderer, webUtils } = require("electron");
contextBridge.exposeInMainWorld("forge", {
  invoke: (cmd, args) => ipcRenderer.invoke("forge:" + cmd, args ?? {}),
  // Drag-and-drop hands the renderer a File; the shell needs its path on disk.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  on: (event, cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
});
