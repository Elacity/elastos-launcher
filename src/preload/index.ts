import { contextBridge, ipcRenderer } from 'electron';

export type RuntimeStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'not-installed';

contextBridge.exposeInMainWorld('elastos', {
  start: () => ipcRenderer.invoke('elastos:start'),
  stop: () => ipcRenderer.invoke('elastos:stop'),
  restart: () => ipcRenderer.invoke('elastos:restart'),
  openBrowser: () => ipcRenderer.invoke('elastos:openBrowser'),
  install: () => ipcRenderer.invoke('elastos:install'),
  uninstall: () => ipcRenderer.invoke('elastos:uninstall'),
  resetRuntime: () => ipcRenderer.invoke('elastos:resetRuntime'),

  getStatus: () => ipcRenderer.invoke('elastos:getStatus'),
  getLogs: (lines: number) => ipcRenderer.invoke('elastos:getLogs', lines),
  isInstalled: () => ipcRenderer.invoke('elastos:isInstalled'),

  getVersion: () => ipcRenderer.invoke('elastos:getVersion'),
  checkForUpdate: () => ipcRenderer.invoke('elastos:checkForUpdate'),
  update: () => ipcRenderer.invoke('elastos:update'),
  rollback: () => ipcRenderer.invoke('elastos:rollback'),
  getLaunchInfo: () => ipcRenderer.invoke('elastos:getLaunchInfo'),
  getPreflight: () => ipcRenderer.invoke('elastos:getPreflight'),
  getDiagnostics: () => ipcRenderer.invoke('elastos:getDiagnostics'),
  saveSupportBundle: () => ipcRenderer.invoke('elastos:saveSupportBundle'),
  describeLegacyPc2: () => ipcRenderer.invoke('elastos:describeLegacyPc2'),
  removeLegacyPc2: (backup: boolean) => ipcRenderer.invoke('elastos:removeLegacyPc2', backup === true),
  describeFailure: () => ipcRenderer.invoke('elastos:describeFailure'),
  fixFailure: () => ipcRenderer.invoke('elastos:fixFailure'),
  setOpenAtLogin: (enabled: boolean) => ipcRenderer.invoke('elastos:setOpenAtLogin', enabled),

  onStatus: (callback: (status: RuntimeStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: RuntimeStatus) => callback(status);
    ipcRenderer.on('elastos:status', listener);
    return () => ipcRenderer.removeListener('elastos:status', listener);
  },

  onLog: (callback: (log: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, log: string) => callback(log);
    ipcRenderer.on('elastos:log', listener);
    return () => ipcRenderer.removeListener('elastos:log', listener);
  },

  onInstallProgress: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('elastos:installProgress', listener);
    return () => ipcRenderer.removeListener('elastos:installProgress', listener);
  },

  onUpdateProgress: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('elastos:updateProgress', listener);
    return () => ipcRenderer.removeListener('elastos:updateProgress', listener);
  }
});

declare global {
  interface Window {
    elastos: {
      start: () => Promise<void>;
      stop: () => Promise<void>;
      restart: () => Promise<void>;
      openBrowser: () => void;
      install: () => Promise<void>;
      uninstall: () => Promise<void>;
      resetRuntime: () => Promise<void>;
      getStatus: () => Promise<RuntimeStatus>;
      getLogs: (lines: number) => Promise<string>;
      isInstalled: () => Promise<boolean>;
      getVersion: () => Promise<string>;
      checkForUpdate: () => Promise<{ current: string; latest: string; updateAvailable: boolean; releaseUrl: string }>;
      update: () => Promise<void>;
      rollback: () => Promise<void>;
      getLaunchInfo: () => Promise<{
        id: string;
        displayName: string;
        openUrl: string;
        status: RuntimeStatus;
        platformNote: string | null;
        preflight: { ok: boolean; checks: Array<{ id: string; level: string; message: string }> };
        openAtLogin: boolean;
        canRollback: boolean;
      }>;
      getPreflight: () => Promise<{ ok: boolean; checks: Array<{ id: string; level: string; message: string }> }>;
      getDiagnostics: () => Promise<string>;
      saveSupportBundle: () => Promise<string>;
      describeLegacyPc2: () => Promise<{
        items: Array<{ scope: string; path: string; label: string; bytes: number | null }>;
      }>;
      removeLegacyPc2: (backup: boolean) => Promise<{ ok: boolean; message: string }>;
      describeFailure: () => Promise<{
        kind: string;
        title: string;
        message: string;
        retryLabel: string;
        fixLabel: string | null;
      }>;
      fixFailure: () => Promise<'ready' | 'still-blocked'>;
      setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
      onStatus: (callback: (status: RuntimeStatus) => void) => () => void;
      onLog: (callback: (log: string) => void) => () => void;
      onInstallProgress: (callback: (message: string) => void) => () => void;
      onUpdateProgress: (callback: (message: string) => void) => () => void;
    };
  }
}
