import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import * as pc2Manager from './pc2Manager';
import { createDefaultLaunchController } from './launchController';

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
let currentStatus: pc2Manager.PC2Status = 'stopped';

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
    mainWindow?.webContents.send('pc2:status', currentStatus);
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
  const statusLabels: Record<pc2Manager.PC2Status, string> = {
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
      label: launch.target.id === 'runtime' ? 'Start' : 'Start PC2',
      enabled: currentStatus === 'stopped' || currentStatus === 'error',
      click: () => { void launch.start(); }
    },
    {
      label: launch.target.id === 'runtime' ? 'Stop' : 'Stop PC2',
      enabled: currentStatus === 'running',
      click: () => { void launch.stop(); }
    },
    { type: 'separator' },
    {
      label: launch.target.id === 'runtime' ? 'Open my computer' : 'Open in Browser',
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
  mainWindow?.webContents.send('pc2:status', status);
  updateTrayMenu();
});

// Set up log listener
launch.onLog((logMessage) => {
  mainWindow?.webContents.send('pc2:log', logMessage);
});

// IPC Handlers. Preload keeps the pc2:* channel names; the controller
// chooses the target. Default target methods are the pc2Manager functions.
ipcMain.handle('pc2:getStatus', () => launch.getStatus());
ipcMain.handle('pc2:start', () => launch.start());
ipcMain.handle('pc2:stop', () => launch.stop());
ipcMain.handle('pc2:restart', () => launch.restart());
ipcMain.handle('pc2:getLogs', (_, lines) => launch.getLogs(lines));
ipcMain.handle('pc2:isInstalled', () => launch.isInstalled());
ipcMain.handle('pc2:openBrowser', () => launch.openInBrowser());
ipcMain.handle('pc2:install', async (event) => {
  return launch.install((msg) => {
    event.sender.send('pc2:installProgress', msg);
  });
});

ipcMain.handle('pc2:uninstall', () => launch.uninstall());

// Version and updates
ipcMain.handle('pc2:getVersion', () => launch.getVersion());
ipcMain.handle('pc2:checkForUpdate', () => launch.checkForUpdate());
ipcMain.handle('pc2:update', async (event) => {
  return launch.update((msg) => {
    event.sender.send('pc2:updateProgress', msg);
  });
});

// Environment management
ipcMain.handle('pc2:setEnvironment', async (_, env: string, customPath?: string) => {
  pc2Manager.setEnvironment(env as pc2Manager.PC2Environment, customPath);
  const status = await launch.getStatus();
  mainWindow?.webContents.send('pc2:status', status);
  return {
    env,
    path: pc2Manager.getPC2Dir(),
    installed: await pc2Manager.isInstalled()
  };
});

ipcMain.handle('pc2:getEnvironment', () => ({
  env: pc2Manager.getEnvironment(),
  path: pc2Manager.getPC2Dir(),
  label: pc2Manager.getEnvironmentLabel()
}));

// Network info
ipcMain.handle('pc2:getLanURL', () => pc2Manager.getLanURL());
ipcMain.handle('pc2:getQRCode', () => pc2Manager.generateQRCode());

ipcMain.handle('pc2:getLaunchInfo', () => launch.getLaunchInfo());
ipcMain.handle('pc2:setLaunchTarget', async (_, id: string) => {
  const next = launch.setLaunchTarget(id);
  const status = await launch.getStatus();
  mainWindow?.webContents.send('pc2:status', status);
  updateTrayMenu();
  return next;
});
ipcMain.handle('pc2:getPreflight', () => launch.getPreflight());
ipcMain.handle('pc2:getDiagnostics', () => launch.getDiagnostics());
ipcMain.handle('pc2:setOpenAtLogin', (_, enabled: boolean) => {
  launch.setOpenAtLogin(enabled);
  return launch.getOpenAtLogin();
});
ipcMain.handle('pc2:rollback', async (event) => {
  return launch.rollback((msg) => {
    event.sender.send('pc2:updateProgress', msg);
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
  // v1.2.7.13: clean up the heartbeat poller's interval timer so the
  // event loop doesn't keep the app process alive after BrowserWindow
  // closes. (The poller uses unref'd timers in pc2-node but Electron's
  // setInterval doesn't auto-unref, so we stop it explicitly.)
  launch.shutdown();
});
