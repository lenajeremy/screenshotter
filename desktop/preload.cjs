// The page's way to the desktop app (main.js): window.glassine.native.postMessage({ cmd, ...args })
// answers with a promise, as the Swift app's web view did (window.webkit.messageHandlers.native).
// Nothing else of Electron or Node reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glassine", {
  native: { postMessage: (msg) => ipcRenderer.invoke("native", msg) },
  platform: process.platform,
});
