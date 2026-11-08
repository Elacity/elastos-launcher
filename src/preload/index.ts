import { contextBridge, ipcRenderer } from 'electron';

// Maintenance stays in the native menu. The renderer can only act on its current dialog.
contextBridge.exposeInMainWorld('elastos', {
  platform: process.platform,
  contentSize: (height: number) => ipcRenderer.send('elastos:contentSize', height),
  getWindowState: () => ipcRenderer.invoke('elastos:getWindowState'),
  install: (login: boolean) => ipcRenderer.invoke('elastos:install', login === true),
  update: () => ipcRenderer.invoke('elastos:update'),
  retry: () => ipcRenderer.invoke('elastos:retry'),
  openHome: () => ipcRenderer.invoke('elastos:openHome'),
  copyDiagnostics: () => ipcRenderer.invoke('elastos:copyDiagnostics'),
  releaseNotes: () => ipcRenderer.invoke('elastos:releaseNotes'),
  closeWindow: () => ipcRenderer.invoke('elastos:closeWindow'),
  onWindowState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('elastos:windowState', listener);
    return () => ipcRenderer.removeListener('elastos:windowState', listener);
  },
});
