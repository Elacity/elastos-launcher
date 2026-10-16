import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import { createDefaultLaunchController, TargetStatus } from './launchController';
import { describeLegacyPc2OnThisComputer, removeLegacyPc2OnThisComputer, withSupportBundle } from './legacyPc2Removal';

const launch = createDefaultLaunchController(process.env);

// Set app name for dock/taskbar and menu bar
app.setName('ElastOS');

// For macOS, set the name before app is ready
if (process.platform === 'darwin') {
  app.name = 'ElastOS';
}

// Set dock icon on macOS
if (process.platform === 'darwin') {
  const iconPath = path.join(__dirname, '../../resources/icon.png');
  const { nativeImage } = require('electron');
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock?.setIcon(icon);
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let currentStatus: TargetStatus = 'stopped';

// Configure logging
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#121212',
    show: false,
    icon: path.join(__dirname, '../../resources/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../../src/renderer/index.html'));

  mainWindow.once('ready-to-show', async () => {
    mainWindow?.show();
    
    // Check initial status
    currentStatus = await launch.getStatus();
    mainWindow?.webContents.send('elastos:status', currentStatus);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  // Simple tray icon
  const iconPath = path.join(__dirname, '../../resources/icon.png');
  let icon: Electron.NativeImage;
  
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // Fallback to a simple icon
      icon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAH5SURBVFiF7Ze/axRBFMc/M7t3yUWjhYVYiI2NjQERbfwPrGxEOwsLsRAsLPwPbGwsxMbKQrCwEWzEQrDQRhALC8FCCYiIRuNdkuzujsXu3e7l7nKXM+D3wzDM8N7MZ+a9NzOQUXAIGAN2s+0CtXBkCfgD/AJ+ArPAT2ANWBdRFXgEZuUmcAEodshrA5yECcBTcBB4BZwGfOAZ8ETESv+X+i5wEbiY9H0Z2AmMA/uTvieqGuvpxfMYOJbSrqvOIEACMpAJSAJeAF5S9gM2U2OaAYmqhcAz8BpoBc+BzuuLdEiKZrLMSj0B7JIGFQK1wBM/xhp05QfsBKoNYC8wDzzvFyQJiCeJN8DFaJHXxXJV1tQ68IaYcLrpDyLoJ5APvCOLCRwNVCcJYy2wyQs7KiZlJuoB79oj/wBwtXNOtfYmGIrLWpLK+w5c60UYTANFJOsYcKRPCHPAAWASeMojwChWBxTpFrKu2vQC4BlwyUeFE0KxP0AqYT3JQE+B4SSwH6hnQAFYBO6JqPQKkQZYS5bXgccitP8N/oEKMCGi3C/IEPARuNcvRIb+yO4nngvMAe+Tzr5BkoBBYDfwot9qSOsUyxUNjQ8i6sMggmRoD7nHI/+wHTAGPBNR7hciCRj6LpjCxBpw00d5nyAZGgT2AEv/M/4vmHGRlTWP0ioAAAAASUVORK5CYII='
      );
    }
  } catch (e) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAH5SURBVFiF7Ze/axRBFMc/M7t3yUWjhYVYiI2NjQERbfwPrGxEOwsLsRAsLPwPbGwsxMbKQrCwEWzEQrDQRhALC8FCCYiIRuNdkuzujsXu3e7l7nKXM+D3wzDM8N7MZ+a9NzOQUXAIGAN2s+0CtXBkCfgD/AJ+ArPAT2ANWBdRFXgEZuUmcAEodshrA5yECcBTcBB4BZwGfOAZ8ETESv+X+i5wEbiY9H0Z2AmMA/uTvieqGuvpxfMYOJbSrqvOIEACMpAJSAJeAF5S9gM2U2OaAYmqhcAz8BpoBc+BzuuLdEiKZrLMSj0B7JIGFQK1wBM/xhp05QfsBKoNYC8wDzzvFyQJiCeJN8DFaJHXxXJV1tQ68IaYcLrpDyLoJ5APvCOLCRwNVCcJYy2wyQs7KiZlJuoB79oj/wBwtXNOtfYmGIrLWpLK+w5c60UYTANFJOsYcKRPCHPAAWASeMojwChWBxTpFrKu2vQC4BlwyUeFE0KxP0AqYT3JQE+B4SSwH6hnQAFYBO6JqPQKkQZYS5bXgccitP8N/oEKMCGi3C/IEPARuNcvRIb+yO4nngvMAe+Tzr5BkoBBYDfwot9qSOsUyxUNjQ8i6sMggmRoD7nHI/+wHTAGPBNR7hciCRj6LpjCxBpw00d5nyAZGgT2AEv/M/4vmHGRlTWP0ioAAAAASUVORK5CYII='
    );
  }

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('ElastOS');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
    }
  });
}

function updateTrayMenu(): void {
  const statusLabels: Record<TargetStatus, string> = {
    'running': '🟢 Running',
    'stopped': '⚫ Stopped',
    'starting': '🟡 Starting...',
    'stopping': '🟡 Stopping...',
    'error': '🔴 Error',
    'not-installed': '⚪ Not Installed'
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: `Status: ${statusLabels[currentStatus]}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Start',
      enabled: currentStatus === 'stopped' || currentStatus === 'error',
      click: () => { void launch.start(); }
    },
    {
      label: 'Stop',
      enabled: currentStatus === 'running',
      click: () => { void launch.stop(); }
    },
    { type: 'separator' },
    {
      label: 'Open my computer',
      enabled: currentStatus === 'running',
      click: () => launch.openInBrowser()
    },
    { type: 'separator' },
    { label: 'Show Window', click: () => mainWindow?.show() },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray?.setContextMenu(contextMenu);
}

// Set up status change listener
launch.onStatusChange((status) => {
  currentStatus = status;
  mainWindow?.webContents.send('elastos:status', status);
  updateTrayMenu();
});

// Set up log listener
launch.onLog((logMessage) => {
  mainWindow?.webContents.send('elastos:log', logMessage);
});

// IPC handlers. The preload exposes these as window.elastos.
ipcMain.handle('elastos:getStatus', () => launch.getStatus());
ipcMain.handle('elastos:start', () => launch.start());
ipcMain.handle('elastos:stop', () => launch.stop());
ipcMain.handle('elastos:restart', () => launch.restart());
ipcMain.handle('elastos:getLogs', (_, lines) => launch.getLogs(lines));
ipcMain.handle('elastos:isInstalled', () => launch.isInstalled());
ipcMain.handle('elastos:openBrowser', () => launch.openInBrowser());
ipcMain.handle('elastos:install', async (event) => {
  return launch.install((msg) => {
    event.sender.send('elastos:installProgress', msg);
  });
});

ipcMain.handle('elastos:uninstall', () => launch.uninstall());
ipcMain.handle('elastos:resetRuntime', () => launch.resetRuntime());

// Version and updates
ipcMain.handle('elastos:getVersion', () => launch.getVersion());
ipcMain.handle('elastos:checkForUpdate', () => launch.checkForUpdate());
ipcMain.handle('elastos:update', async (event) => {
  return launch.update((msg) => {
    event.sender.send('elastos:updateProgress', msg);
  });
});

ipcMain.handle('elastos:getLaunchInfo', () => launch.getLaunchInfo());
ipcMain.handle('elastos:getPreflight', () => launch.getPreflight());
ipcMain.handle('elastos:getDiagnostics', () => launch.getDiagnostics());
ipcMain.handle('elastos:saveSupportBundle', () => launch.saveSupportBundle());
ipcMain.handle('elastos:describeLegacyPc2', async () => ({ items: await describeLegacyPc2OnThisComputer() }));
ipcMain.handle('elastos:removeLegacyPc2', async (_event, backup: unknown, paths: unknown) => {
  const confirmed = Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === 'string') : [];
  const result = await removeLegacyPc2OnThisComputer({ backup: backup === true, paths: confirmed });
  if (result.ok) return result;
  let bundle = '';
  try {
    bundle = await launch.saveSupportBundle();
  } catch {
    bundle = '';
  }
  const message = bundle ? withSupportBundle(result.message, bundle) : result.message;
  throw new Error(message);
});
ipcMain.handle('elastos:describeFailure', () => launch.describeFailure());
ipcMain.handle('elastos:fixFailure', () => launch.fixFailure());
ipcMain.handle('elastos:setOpenAtLogin', (_, enabled: boolean) => {
  launch.setOpenAtLogin(enabled);
  return launch.getOpenAtLogin();
});
ipcMain.handle('elastos:rollback', async (event) => {
  return launch.rollback((msg) => {
    event.sender.send('elastos:updateProgress', msg);
  });
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
  if (launch.getOpenAtLogin()) launch.setOpenAtLogin(true);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  launch.shutdown();
});
