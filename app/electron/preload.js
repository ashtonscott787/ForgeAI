'use strict';
// Exposed only to the local first-run screen (file://), never to web pages loaded from a server.
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('aicoreDesktop', {
    info: () => ipcRenderer.invoke('aicore:info'),
    discover: () => ipcRenderer.invoke('aicore:discover'),
    probe: (url) => ipcRenderer.invoke('aicore:probe', url),
    runServer: () => ipcRenderer.invoke('aicore:runServer'),
    connect: (url) => ipcRenderer.invoke('aicore:connect', url),
  });
} else if (/^https?:\/\/127\.0\.0\.1:\d+$/.test(location.origin)) {
  // This computer's own dashboard (server mode): native folder picker. The main process re-checks the sender.
  contextBridge.exposeInMainWorld('forgeDesktop', {
    pickFolder: () => ipcRenderer.invoke('forge:pickFolder'),
    reveal: (p) => ipcRenderer.invoke('forge:reveal', p),
  });
}
