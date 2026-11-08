const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("forge", {
  invoke: (cmd, args) => ipcRenderer.invoke("forge:" + cmd, args ?? {}),
  on: (event, cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
});
