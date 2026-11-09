import { app, BrowserWindow, clipboard, dialog, ipcMain, Tray, Menu, nativeImage, shell, screen } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';
import { createDefaultLaunchController, finishQuitAfterGatewayStop, isLoginLaunch, startHomeAtLogin, homeLogFolder } from './launchController';
import { describeLegacyPc2OnThisComputer, removeLegacyPc2OnThisComputer, withSupportBundle } from './legacyPc2Removal';
import { contentWindowBounds } from './launcherWindow';
import { buildHomeMenu, HomeModel, HomeActionKind, trayPresentation } from './homeMenu';
import { createOpenHome } from './openHome';
import { scrubSupportText } from './targets/preflight';
import type { UpdateCheck } from './targets/types';

const platform = process.platform;

// Chromium never shares the Runtime Home, even on case-insensitive Macs.
const electronData = path.join(os.homedir(), '.elastos-launcher', 'electron');
fs.mkdirSync(electronData, { recursive: true, mode: 0o700 });
app.setPath('userData', electronData);
app.setPath('sessionData', electronData);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppLogsPath(path.join(electronData, 'logs'));
app.setName('ElastOS');
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
export const launch = createDefaultLaunchController(process.env);
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let actionGeneration = 0;
let menuSignature = '';
const homeState: HomeModel = { observed: 'stopped', inFlight: null, failure: null, quitting: false };
let offer: UpdateCheck | null = null;
let legacyItems: Awaited<ReturnType<typeof describeLegacyPc2OnThisComputer>> = [];
const quitGate = { started: false, ready: false };
type WindowState = {
  kind: 'install' | 'progress' | 'error' | 'update';
  ready?: boolean; message?: string; actionLabel?: string; releaseNotes?: boolean;
};
let windowState: WindowState = { kind: 'install' };
type HomeAction = (generation: number) => Promise<void>;
let retry: HomeAction | null = null;
let failureError: unknown;

// Reads own only the observation. An older request cannot replace a newer action/read.
async function readStatus(): Promise<void> {
  const generation = actionGeneration;
  try {
    const observed = await launch.getStatus();
    if (generation === actionGeneration) homeState.observed = observed;
  } catch (error) { log.error(String(error)); }
  updateMenu();
}

function setWindowState(state: WindowState): void {
  windowState = state;
  mainWindow?.webContents.send('elastos:windowState', state);
}
function showWindow(state: WindowState): void {
  setWindowState(state);
  if (!mainWindow) {
    const window = new BrowserWindow({
      width: 360, height: 320, useContentSize: true, resizable: false,
      webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false },
      titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default',
      backgroundColor: '#f5f5f5', show: false, autoHideMenuBar: true,
      icon: path.join(__dirname, '../../resources/icon.png'),
    });
    mainWindow = window;
    window.loadFile(path.join(__dirname, '../../src/renderer/index.html'));
    window.once('ready-to-show', () => { window.show(); window.focus(); });
    window.on('closed', () => { mainWindow = null; });
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
}
function closeWindow(): void { mainWindow?.close(); }
async function showError(error: unknown, again: HomeAction | null = null, generation = actionGeneration): Promise<string | null> {
  log.error(error instanceof Error ? error.message : String(error));
  const failure = await launch.describeFailure(error).catch(() => null);
  const message = failure?.message || 'ElastOS could not finish.';
  if (homeState.quitting || generation !== actionGeneration) return null;
  retry = again;
  failureError = error;
  showWindow({ kind: 'error', message,
    actionLabel: failure?.fixLabel ? 'Try Again' : (again ? 'Try Again' : 'Show Logs') });
  return message;
}
async function reportReadError(action: () => Promise<void>): Promise<void> {
  const generation = actionGeneration;
  try { await action(); } catch (error) { await showError(error, null, generation); }
}
async function perform(kind: HomeActionKind, action: HomeAction): Promise<void> {
  if (homeState.inFlight || homeState.quitting) return;
  const generation = ++actionGeneration;
  homeState.inFlight = { kind, generation };
  homeState.failure = null;
  updateMenu();
  try { await action(generation); } catch (error) { homeState.failure = await showError(error, action, generation); }
  finally {
    homeState.inFlight = null;
    updateMenu();
    await readStatus();
  }
}
// Signed 2.0.0's Home command opens the browser itself on a cold start.
async function startHome(): Promise<void> { await launch.start(); }
async function stopHome(): Promise<void> { await launch.stop(); }
async function openHome(): Promise<void> {
  await createOpenHome({ getStatus: () => launch.getStatus(), start: () => launch.start(), openInBrowser: () => launch.openInBrowser() }, () => showWindow({ kind: 'install' }), true)();
}
async function openApp(): Promise<void> { await perform('open', openHome); }
async function copyDiagnostics(): Promise<void> {
  const file = log.transports.file.getFile().path;
  let tail = '';
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) {
      const bytes = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const count = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length));
      tail = bytes.subarray(0, count).toString('utf8');
    }
  } catch { /* The current session diagnostics are still available. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  clipboard.writeText(scrubSupportText(`${await launch.getDiagnostics()}\n${tail}`));
}
async function showLogs(): Promise<void> {
  const error = await shell.openPath(homeLogFolder(platform, os.homedir(), process.env));
  if (error) throw new Error(error);
}
async function confirm(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}
async function reset(): Promise<void> {
  const backup = await launch.describeResetBackup();
  if ('blocked' in backup && backup.blocked) throw new Error(String(backup.blocked));
  const answer = await confirm({ type: 'warning', title: 'Reset ElastOS', message: 'Reset ElastOS?',
    detail: 'This removes ElastOS and your Home data so you can install it again.',
    buttons: ['Cancel', 'Reset'], defaultId: 0, cancelId: 0, noLink: true,
    ...(backup.present ? { checkboxLabel: backup.enough ? 'Back Up First' : 'Reset Without a Backup', checkboxChecked: backup.enough } : {}) });
  if (answer.response !== 1) return;
  if (backup.present && !backup.enough && !answer.checkboxChecked) return;
  await launch.resetRuntime({ backup: backup.present && backup.enough && answer.checkboxChecked });
  showWindow({ kind: 'install' });
}
async function uninstall(): Promise<void> {
  const answer = await confirm({ type: 'warning', title: 'Uninstall ElastOS', message: 'Uninstall ElastOS?',
    detail: 'This removes ElastOS from this computer and keeps your Home data unless you choose to delete it.',
    checkboxLabel: 'Also delete my Home data', checkboxChecked: false,
    buttons: ['Cancel', 'Uninstall'], defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response !== 1) return;
  const result = await launch.uninstall(async prompt => (await confirm({ type: 'warning', title: prompt.title,
    message: prompt.message, detail: prompt.detail, buttons: [prompt.cancelLabel, prompt.confirmLabel],
    defaultId: 0, cancelId: 0, noLink: true })).response === 1, answer.checkboxChecked);
  if (result?.linuxCopyMessage) log.info(result.linuxCopyMessage);
  launch.setOpenAtLogin(false);
  closeWindow();
}
async function removePc2(generation: number): Promise<void> {
  const items = await describeLegacyPc2OnThisComputer();
  if (!items.length) return;
  const answer = await confirm({ type: 'warning', title: 'Remove Old PC2 Files', message: 'Remove old PC2 files?',
    detail: `PC2 was the earlier ElastOS Personal Cloud app; this removes its old files.\n${items.map(item => item.path).join('\n')}`,
    checkboxLabel: 'Back Up First', checkboxChecked: true,
    buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response !== 1) return;
  const result = await removeLegacyPc2OnThisComputer({ backup: answer.checkboxChecked, paths: items.map(item => item.path) });
  if (!result.ok) {
    const bundle = await launch.saveSupportBundle().catch(() => '');
    throw new Error(bundle ? withSupportBundle(result.message, bundle) : result.message);
  }
  await refreshMaintenance(generation);
}
function updateMenu(): void {
  if (!tray) return;
  const state = { ...homeState, platform, login: launch.getOpenAtLogin(), pc2: legacyItems.length > 0, update: offer };
  const signature = JSON.stringify(state);
  if (signature === menuSignature) return;
  menuSignature = signature;
  const presentation = trayPresentation(state);
  const icon = nativeImage.createFromPath(path.join(__dirname, `../../resources/tray/${presentation.image}${platform === 'darwin' ? 'Template' : ''}.png`)).resize({ width: 18, height: 18 });
  if (platform === 'darwin') icon.setTemplateImage(true);
  tray.setImage(icon);
  tray.setToolTip(presentation.tooltip);
  const template = buildHomeMenu(state, {
    open: () => { void openApp(); }, start: () => { void perform('start', startHome); }, stop: () => { void perform('stop', stopHome); },
    update: () => { if (offer) showWindow({ kind: 'update', message: `Update ElastOS to ${offer.latest}?`, releaseNotes: Boolean(offer.releaseUrl) }); },
    login: enabled => { void perform('maintenance', async () => { launch.setOpenAtLogin(enabled); }); },
    diagnostics: () => { void reportReadError(copyDiagnostics); }, logs: () => { void reportReadError(showLogs); },
    removePc2: () => { void perform('maintenance', removePc2); }, reset: () => { void perform('maintenance', reset); }, uninstall: () => { void perform('maintenance', uninstall); },
    about: () => app.showAboutPanel(), quit: () => app.quit(),
  });
  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
  if (platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ElastOS', submenu: template }, { role: 'editMenu' },
  ]));
  // Real Electron menu objects, used by the packaged CI tests.
  (global as typeof globalThis & { __elastosTrayMenu?: Menu; __elastosTrayState?: string }).__elastosTrayMenu = menu;
  (global as typeof globalThis & { __elastosTrayState?: string }).__elastosTrayState = presentation.image;
}
async function refreshMaintenance(generation = actionGeneration): Promise<void> {
  const items = await describeLegacyPc2OnThisComputer().catch(error => { log.warn(String(error)); return []; });
  const update = await launch.checkForUpdate().catch(error => { log.warn(String(error)); return null; });
  if (generation !== actionGeneration || homeState.quitting) return;
  legacyItems = items; offer = update;
  updateMenu();
}
function step(message: string): void {
  log.info(message);
  setWindowState({ kind: 'progress', message: /start|home ready/i.test(message) ? 'Starting Home' : /download|fetch/i.test(message) ? 'Downloading' : 'Setting up' });
}
async function install(login: boolean): Promise<void> {
  await perform('start', async generation => {
    launch.setOpenAtLogin(login);
    showWindow({ kind: 'progress', message: 'Downloading' });
    await launch.install(step);
    if (homeState.quitting || generation !== actionGeneration) return;
    step('Starting Home');
    await launch.start();
    if (homeState.quitting || generation !== actionGeneration) return;
    setWindowState({ kind: 'install', ready: true, message: 'Home is ready.' });
    void refreshMaintenance(generation);
  });
}
async function update(): Promise<void> {
  if (!offer?.updateAvailable) return;
  await perform('update', async generation => {
    showWindow({ kind: 'progress', message: 'Downloading' });
    await launch.update(step);
    if (await launch.getStatus() !== 'running') await launch.start();
    if (generation === actionGeneration) offer = null;
    closeWindow();
  });
}
// Only the action catch records a failure; controller notifications do not own menu state.
launch.onLog(message => log.info(message));

// Only the current small window may invoke its actions. No destructive renderer IPC.
function handle(name: string, action: (...args: any[]) => unknown): void {
  ipcMain.handle(`elastos:${name}`, (event, ...args) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unknown window.');
    return action(...args);
  });
}
handle('getWindowState', () => windowState);
handle('install', login => windowState.kind === 'install' && !windowState.ready ? install(login === true) : undefined);
handle('update', () => windowState.kind === 'update' ? update() : undefined);
handle('retry', () => perform('maintenance', async generation => {
  const error = failureError;
  const failure = await launch.describeFailure(error);
  if (failure.fixLabel) {
    if (platform === 'win32' && failure.kind === 'windows') {
      const answer = await confirm({ type: 'question', title: 'Set Up ElastOS', message: 'Set up ElastOS on this computer?',
        detail: 'Windows may ask for permission to enable Linux support and may need to restart.',
        buttons: ['Cancel', 'Set Up'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return;
    }
    const result = await launch.fixFailure(error);
    const windowsReady = failure.kind === 'windows' && !(await launch.getPreflight()).checks
      .some(check => check.id === 'windows' && check.level === 'block');
    if (windowsReady && retry) await retry(generation);
    else if (result === 'ready') {
      if (await launch.isInstalled()) { await openHome(); closeWindow(); }
      else showWindow({ kind: 'install' });
    }
    else throw error;
  } else if (retry) await retry(generation);
  else await showLogs();
}));
handle('openHome', async () => { await openApp(); if (windowState.kind !== 'error') closeWindow(); });
handle('copyDiagnostics', copyDiagnostics);
handle('releaseNotes', () => { if (offer?.releaseUrl && /^https:\/\//.test(offer.releaseUrl)) return shell.openExternal(offer.releaseUrl); });
handle('closeWindow', closeWindow);
ipcMain.on('elastos:contentSize', (event, height: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds(contentWindowBounds(Math.max(320, height), bounds, mainWindow.getContentBounds(), screen.getDisplayMatching(bounds).workArea));
});
app.on('second-instance', () => { void app.whenReady().then(openApp); });
app.on('activate', () => { void openApp(); });
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  app.dock?.hide();
  app.setAboutPanelOptions({ applicationName: 'ElastOS', applicationVersion: '2.0.0', version: '', copyright: 'Copyright © Elacity Labs', iconPath: path.join(__dirname, '../../resources/icon.png') });
  if (platform !== 'darwin') Menu.setApplicationMenu(null);
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../../resources/tray/stoppedTemplate.png')));
  (global as typeof globalThis & { __elastosTray?: true }).__elastosTray = true;
  (global as typeof globalThis & { __elastosLogPath?: string }).__elastosLogPath = log.transports.file.getFile().path;
  updateMenu();
  // macOS and Linux show their attached context menu on primary activation.
  if (platform === 'win32') tray.on('click', () => tray?.popUpContextMenu());
  const login = isLoginLaunch(platform, process.argv, platform === 'darwin' ? app.getLoginItemSettings() : {});
  if (launch.getOpenAtLogin()) launch.setOpenAtLogin(true);
  if (login) await perform('start', () => startHomeAtLogin(launch.getOpenAtLogin(), launch));
  else if (await launch.resumeInstallPlan() === 'install') {
    await install(launch.getOpenAtLogin());
    launch.finishResumeInstall(windowState.ready === true);
  } else await openApp();
  void refreshMaintenance();
  let checkingStatus = false;
  const statusTimer = setInterval(async () => {
    if (homeState.inFlight || homeState.quitting || checkingStatus) return;
    checkingStatus = true;
    try { await readStatus(); }
    finally { checkingStatus = false; }
  }, 2000);
  statusTimer.unref();
  const updateTimer = setInterval(() => { if (!homeState.inFlight && !homeState.quitting) void refreshMaintenance(); }, 60 * 60 * 1000);
  updateTimer.unref();
}).catch(error => { void showError(error); });
app.on('before-quit', event => {
  if (!homeState.quitting) ++actionGeneration;
  homeState.quitting = true;
  updateMenu();
  void finishQuitAfterGatewayStop(quitGate, event, () => launch.shutdown(), () => app.quit(), {
    log: line => log.error(line), onBudget: () => launch.forceStopGateway(),
    onStopping: () => log.info('Stopping Home before quit.'),
  }).catch(error => log.error(String(error)));
});
