const { EventEmitter } = require('node:events');
const Module = require('node:module');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Load the real entry point, replacing only OS/runtime boundaries. No source extraction.
async function mainFixture({ login = false, enabled = true, lock = true, platform = 'darwin', installed = true, status = 'stopped', entry = '../dist/main/index', controller = null } = {}) {
  const calls = [], windows = [], handlers = new Map(), dialogs = [], answers = [], timers = [];
  let statusListener;
  const app = new EventEmitter();
  let ready;
  const whenReady = new Promise(resolve => { ready = resolve; });
  Object.assign(app, {
    requestSingleInstanceLock() { calls.push('lock'); return lock; },
    exit() { calls.push('exit'); throw new Error('fixture exit'); },
    setPath() {}, setAppLogsPath() {}, setName() {}, setAboutPanelOptions(v) { this.about = v; }, showAboutPanel() { calls.push('about'); },
    dock: { setIcon() {}, hide() { calls.push('dock-hide'); } }, whenReady: () => whenReady,
    getLoginItemSettings: () => ({ wasOpenedAtLogin: login }), quit() { calls.push('quit'); },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = { send() {} };
      this.bounds = { x: 100, y: 100, width: 360, height: 320 }; this.shows = 0; windows.push(this);
    }
    getBounds() { return this.bounds; } getContentBounds() { return this.bounds; }
    setBounds(value) { this.bounds = value; }
    loadFile() { setImmediate(() => this.emit('ready-to-show')); }
    show() { this.shows++; } focus() {} isMinimized() { return false; }
    close() { this.emit('closed'); }
  }
  const launch = controller || {
    onStatusChange(fn) { statusListener = fn; }, onLog() {}, onActionSuccess() {}, getLogs: async () => '',
    getStatus: async () => installed ? status : 'not-installed',
    getOpenAtLogin: () => enabled, setOpenAtLogin(value) { enabled = value; calls.push(['login', value]); },
    start: async () => { calls.push('start'); status = 'running'; statusListener?.(status); },
    stop: async () => { calls.push('stop'); status = 'stopped'; statusListener?.(status); },
    openInBrowser() { calls.push('open'); },
    checkForUpdate: async () => ({ latest: '2.0.1', updateAvailable: true, releaseUrl: '' }),
    describeResetBackup: async () => ({ present: true, enough: true }),
    resetRuntime: async choice => { calls.push(['reset', choice]); installed = false; },
    uninstall: async (confirm, deleteData) => { calls.push(['uninstall', deleteData]); },
    describeFailure: async () => ({ message: 'The download stopped.', fixLabel: null }),
    install: async progress => { calls.push('install'); progress('Starting Home'); installed = true; status = 'running'; },
    update: async progress => { calls.push('update'); progress('Downloading'); status = 'running'; },
    getDiagnostics: async () => 'diagnostic fixture', shutdown: async () => calls.push('shutdown'), forceStopGateway() {},
    saveSupportBundle: async () => '/fixture/support.txt', resumeInstallPlan: async () => 'none', finishResumeInstall() {},
  };
  const image = { isEmpty: () => false, resize() { return this; }, setTemplateImage() {} };
  const tray = new EventEmitter();
  Object.assign(tray, { setToolTip(value) { this.tooltip = value; }, setImage() {}, setContextMenu(value) { this.menu = value; } });
  const electron = { app, BrowserWindow, clipboard: { writeText(v) { calls.push(['clipboard', v]); } },
    shell: { openPath: async v => { calls.push(['folder', v]); return ''; } },
    dialog: { async showMessageBox(...args) { dialogs.push(args.at(-1)); return answers.shift() || { response: 0, checkboxChecked: false }; } },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
    nativeImage: { createFromPath: () => image },
    ipcMain: { handle(name, fn) { handlers.set(name, fn); }, on(name, fn) { handlers.set(name, fn); } },
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} }, Tray: class { constructor() { return tray; } },
  };
  const log = { transports: { file: { getFile: () => ({ path: "/fixture/main.log" }) }, console: {} }, error() {}, info() {}, warn() {} };
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalArgv = process.argv;
  const originalInterval = global.setInterval;
  const file = require.resolve(entry);
  delete require.cache[file];
  Module._load = function(name, ...args) {
    if (name === 'electron') return electron;
    if (name === 'electron-log') return log;
    if (name === 'fs' && args[0]?.filename === file) return { mkdirSync() { calls.push('mkdir'); } };
    if (name === './launchController') return { ...originalLoad.call(this, name, ...args), createDefaultLaunchController() { calls.push('controller'); return launch; } };
    if (name === './legacyPc2Removal') return {
      describeLegacyPc2OnThisComputer: async () => [{ path: '/fixture/.pc2' }],
      removeLegacyPc2OnThisComputer: async choice => { calls.push(['pc2', choice]); return { ok: true }; }, withSupportBundle: m => m,
    };
    return originalLoad.call(this, name, ...args);
  };
  Object.defineProperty(process, 'platform', { value: platform });
  process.argv = login ? ['fixture', '--login'] : ['fixture'];
  global.setInterval = fn => { timers.push(fn); return { unref() {} }; };
  try {
    if (!lock) {
      require('node:assert/strict').throws(() => require(file), /fixture exit/);
    } else {
      require(file); ready(); await tick(); await tick(); await tick();
    }
  } finally {
    Module._load = originalLoad; Object.defineProperty(process, 'platform', originalPlatform);
    process.argv = originalArgv; global.setInterval = originalInterval;
  }
  async function click(label) {
    const menu = tray.menu;
    const item = menu.flatMap(i => [i, ...(i.submenu || [])]).find(i => i.label === label);
    if (!item) throw new Error(`Missing menu ${label}`);
    item.click({ checked: !item.checked }); await tick(); await tick();
  }
  const invoke = (name, ...args) => handlers.get(`elastos:${name}`)({ sender: windows.at(-1)?.webContents }, ...args);
  return { calls, windows, app, handlers, tray, click, invoke, dialogs, answers, launch, timers, dialog: electron.dialog };
}
module.exports = { mainFixture, tick };
