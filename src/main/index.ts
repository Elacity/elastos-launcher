import { app, BrowserWindow, clipboard, dialog, ipcMain, Tray, Menu, nativeImage, shell, screen } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';
import { createDefaultLaunchController, finishQuitAfterGatewayStop, isLoginLaunch, startHomeAtLogin, homeLogFolder, TargetStatus } from './launchController';
import { describeLegacyPc2OnThisComputer, removeLegacyPc2OnThisComputer, withSupportBundle } from './legacyPc2Removal';
import { contentWindowBounds } from './launcherWindow';
import { buildHomeMenu, HomeState, trayPresentation } from './homeMenu';
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
let isQuitting = false;
type HomeMenuState = {
  currentStatus: TargetStatus;
  updating: boolean;
  busy: boolean;
  error: string;
  offer: UpdateCheck | null;
  legacyItems: Awaited<ReturnType<typeof describeLegacyPc2OnThisComputer>>;
};
let homeState: Readonly<HomeMenuState> = {
  currentStatus: 'stopped',
  updating: false,
  busy: false,
  error: '',
  offer: null,
  legacyItems: [],
};
const quitGate = { started: false, ready: false };
type WindowState = {
  kind: 'install' | 'progress' | 'error' | 'update';
  ready?: boolean; message?: string; actionLabel?: string; releaseNotes?: boolean;
};
let windowState: WindowState = { kind: 'install' };
type HomeAction = (generation: number) => Promise<void>;
let retry: HomeAction | null = null;

// All menu state publications use the generation captured before asynchronous work.
function publishHomeState(generation: number, state: Partial<HomeMenuState>): boolean {
  if (generation !== actionGeneration) return false;
  homeState = { ...homeState, ...state };
  updateMenu();
  return true;
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
async function showError(error: unknown, again: HomeAction | null = null, generation = actionGeneration): Promise<void> {
  log.error(error instanceof Error ? error.message : String(error));
  const failure = await launch.describeFailure().catch(() => null);
  const message = failure?.message || 'ElastOS could not finish.';
  if (!publishHomeState(generation, { currentStatus: 'error', error: message })) return;
  retry = again;
  showWindow({ kind: 'error', message,
    actionLabel: failure?.fixLabel ? 'Try Again' : (again ? 'Try Again' : 'Show Logs') });
}
async function reportReadError(action: () => Promise<void>): Promise<void> {
  const generation = actionGeneration;
  try { await action(); } catch (error) { await showError(error, null, generation); }
}
async function perform(action: HomeAction): Promise<void> {
  if (homeState.busy || isQuitting) return;
  const generation = ++actionGeneration;
  publishHomeState(generation, { busy: true, error: '' });
  try { await action(generation); } catch (error) { await showError(error, action, generation); }
  finally {
    publishHomeState(generation, { busy: false });
    const currentStatus = await launch.getStatus().catch(() => 'error' as const);
    publishHomeState(generation, { currentStatus });
  }
}
// Signed 2.0.0's Home command opens the browser itself on a cold start.
async function startHome(generation: number): Promise<void> { publishHomeState(generation, { currentStatus: 'starting' }); await launch.start(); }
async function stopHome(generation: number): Promise<void> { publishHomeState(generation, { currentStatus: 'stopping' }); await launch.stop(); }
async function openHome(generation: number): Promise<void> {
  await createOpenHome({ getStatus: () => launch.getStatus(), start: () => startHome(generation), openInBrowser: () => launch.openInBrowser() }, () => showWindow({ kind: 'install' }), true)();
}
async function openApp(): Promise<void> { await perform(openHome); }
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
  const status: HomeState = homeState.updating ? 'updating' : homeState.currentStatus;
  const state = { status, platform: platform, busy: homeState.busy, error: homeState.error, login: launch.getOpenAtLogin(), pc2: homeState.legacyItems.length > 0, update: homeState.offer };
  const signature = JSON.stringify(state);
  if (signature === menuSignature) return;
  menuSignature = signature;
  const presentation = trayPresentation(status);
  const icon = nativeImage.createFromPath(path.join(__dirname, `../../resources/tray/${presentation.image}${platform === 'darwin' ? 'Template' : ''}.png`)).resize({ width: 18, height: 18 });
  if (platform === 'darwin') icon.setTemplateImage(true);
  tray.setImage(icon);
  tray.setToolTip(presentation.tooltip);
  const template = buildHomeMenu(state, {
    open: () => { void openApp(); }, start: () => { void perform(startHome); }, stop: () => { void perform(stopHome); },
    update: () => { if (homeState.offer) showWindow({ kind: 'update', message: `Update ElastOS to ${homeState.offer.latest}?`, releaseNotes: Boolean(homeState.offer.releaseUrl) }); },
    login: enabled => { void perform(async () => { launch.setOpenAtLogin(enabled); }); },
    diagnostics: () => { void reportReadError(copyDiagnostics); }, logs: () => { void reportReadError(showLogs); },
    removePc2: () => { void perform(removePc2); }, reset: () => { void perform(reset); }, uninstall: () => { void perform(uninstall); },
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
  const legacyItems = await describeLegacyPc2OnThisComputer().catch(error => { log.warn(String(error)); return []; });
  const offer = await launch.checkForUpdate().catch(error => { log.warn(String(error)); return null; });
  publishHomeState(generation, { legacyItems, offer });
}
function step(message: string): void {
  log.info(message);
  setWindowState({ kind: 'progress', message: /start|home ready/i.test(message) ? 'Starting Home' : /download|fetch/i.test(message) ? 'Downloading' : 'Setting up' });
}
async function install(login: boolean): Promise<void> {
  await perform(async generation => {
    launch.setOpenAtLogin(login);
    publishHomeState(generation, { currentStatus: 'starting' });
    showWindow({ kind: 'progress', message: 'Downloading' });
    await launch.install(step);
    setWindowState({ kind: 'install', ready: true, message: 'Home is ready.' });
    void refreshMaintenance(generation);
  });
}
async function update(): Promise<void> {
  if (!homeState.offer?.updateAvailable) return;
  await perform(async generation => {
    publishHomeState(generation, { updating: true });
    showWindow({ kind: 'progress', message: 'Downloading' });
    try {
      await launch.update(step);
      if (await launch.getStatus() !== 'running') await launch.start();
      publishHomeState(generation, { offer: null });
      closeWindow();
    } finally { publishHomeState(generation, { updating: false }); }
  });
}
// perform publishes action failures with their original generation; do not republish
// controller notifications using the generation at notification time.
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
handle('retry', () => perform(async generation => {
  const failure = await launch.describeFailure();
  if (failure.fixLabel) {
    if (platform === 'win32' && failure.kind === 'windows') {
      const answer = await confirm({ type: 'question', title: 'Set Up ElastOS', message: 'Set up ElastOS on this computer?',
        detail: 'Windows may ask for permission to enable Linux support and may need to restart.',
        buttons: ['Cancel', 'Set Up'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return;
    }
    const result = await launch.fixFailure();
    const windowsReady = failure.kind === 'windows' && !(await launch.getPreflight()).checks
      .some(check => check.id === 'windows' && check.level === 'block');
    if (windowsReady && retry) await retry(generation);
    else if (result === 'ready') {
      if (await launch.isInstalled()) { await openHome(generation); closeWindow(); }
      else showWindow({ kind: 'install' });
    }
    else await showError(new Error((await launch.describeFailure()).message), retry, generation);
  } else if (retry) await retry(generation);
  else await showLogs();
}));
handle('openHome', async () => { await openApp(); if (windowState.kind !== 'error') closeWindow(); });
handle('copyDiagnostics', copyDiagnostics);
handle('releaseNotes', () => { if (homeState.offer?.releaseUrl && /^https:\/\//.test(homeState.offer.releaseUrl)) return shell.openExternal(homeState.offer.releaseUrl); });
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
  updateMenu();
  // macOS and Linux show their attached context menu on primary activation.
  if (platform === 'win32') tray.on('click', () => tray?.popUpContextMenu());
  const login = isLoginLaunch(platform, process.argv, platform === 'darwin' ? app.getLoginItemSettings() : {});
  if (launch.getOpenAtLogin()) launch.setOpenAtLogin(true);
  if (login) await perform(() => startHomeAtLogin(launch.getOpenAtLogin(), launch));
  else if (await launch.resumeInstallPlan() === 'install') {
    await install(launch.getOpenAtLogin());
    launch.finishResumeInstall(windowState.ready === true);
  } else await openApp();
  void refreshMaintenance();
  let checkingStatus = false;
  const statusTimer = setInterval(async () => {
    if (homeState.busy || isQuitting || checkingStatus) return;
    checkingStatus = true;
    const generation = actionGeneration;
    try {
      const status = await launch.getStatus();
      publishHomeState(generation, { currentStatus: status });
    } catch (error) { log.error(String(error)); }
    finally { checkingStatus = false; }
  }, 2000);
  statusTimer.unref();
  const updateTimer = setInterval(() => { if (!homeState.busy && !isQuitting) void refreshMaintenance(); }, 60 * 60 * 1000);
  updateTimer.unref();
}).catch(error => { void showError(error); });
app.on('before-quit', event => {
  isQuitting = true;
  const generation = ++actionGeneration;
  void finishQuitAfterGatewayStop(quitGate, event, () => launch.shutdown(), () => app.quit(), {
    log: line => log.error(line), onBudget: () => launch.forceStopGateway(),
    onStopping: () => { publishHomeState(generation, { currentStatus: 'stopping' }); log.info('Stopping Home before quit.'); },
  }).catch(error => log.error(String(error)));
});
