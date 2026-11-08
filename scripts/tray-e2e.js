const fs = require('node:fs');
const logPaths = new WeakMap();

async function diagnostics(app) {
  let state;
  try {
    state = await app.evaluate(async ({ BrowserWindow }) => ({
      focused: BrowserWindow.getFocusedWindow()?.id ?? null,
      windows: await Promise.all(BrowserWindow.getAllWindows().map(async win => ({
        id: win.id, title: win.getTitle(), visible: win.isVisible(), focused: win.isFocused(),
        renderer: await win.webContents.executeJavaScript(`({
          kind: document.body.dataset.state,
          message: document.querySelector('#message')?.textContent,
          primary: document.querySelector('#primary')?.textContent,
          disabled: document.querySelector('#primary')?.disabled
        })`).catch(error => ({ error: error.message })),
      }))),
      openedHome: global.__openedHome,
    }));
  } catch (error) {
    const unavailable = `unavailable: ${error.message}`;
    state = { focused: unavailable, windows: unavailable, openedHome: unavailable };
  }
  let tail;
  let fd;
  try {
    fd = fs.openSync(logPaths.get(app), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
    const count = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    tail = bytes.subarray(0, count).toString('utf8').trimEnd().split('\n').slice(-60).join('\n');
  } catch (error) { tail = `unavailable: ${error.message}`; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return `focused window: ${state.focused}\ncurrent window state: ${JSON.stringify(state.windows)}\n__openedHome: ${JSON.stringify(state.openedHome)}\nlauncher log (last 60 lines):\n${tail}`;
}

async function waitFor(check, timeoutMs, message, app) {
  // Health can time out after Quit, when Electron can no longer report its log path.
  if (app && !logPaths.has(app)) {
    try { logPaths.set(app, await app.evaluate(() => process.mainModule.require('electron-log').transports.file.getFile().path)); }
    catch { /* Diagnostics will name the unavailable connection if the app has exited. */ }
  }
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(typeof message === 'function' ? message() : message);
  } catch (error) {
    if (!app) throw error;
    const detail = await diagnostics(app);
    console.error(`${error.message}\n${detail}`);
    throw new Error(`${error.message}\n${detail}`, { cause: error });
  }
}

async function focusWindow(app) {
  const id = await app.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    app.focus({ steal: true });
    win.focus();
    return win.id;
  });
  // Dock-hidden apps can have no global focused window. Check this window itself.
  await waitFor(() => app.evaluate(({ BrowserWindow }, id) =>
    BrowserWindow.getAllWindows().find(win => win.id === id)?.isFocused(), id), 10000, 'Launcher window did not gain focus', app);
}
async function clickMenu(app, label) {
  await app.evaluate((_electron, label) => {
    const menu = global.__elastosTrayMenu;
    const items = menu.items.flatMap(item => [item, ...(item.submenu?.items || [])]);
    const item = items.find(item => item.label === label);
    if (!item || !item.enabled) throw new Error(`No enabled menu item: ${label}`);
    item.click();
  }, label);
}
async function trayState(app, image) {
  await waitFor(() => app.evaluate((_e, image) => global.__elastosTrayState === image, image), 180000, `Tray did not become ${image}`, app);
}
async function noWindow(app) {
  let windows = [];
  await waitFor(async () => {
    windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
      id: window.id, title: window.getTitle(), visible: window.isVisible(),
    })));
    return windows.every(window => !window.visible);
  }, 10000, () => `No visible windows after 10000 ms: expected none; last window state: ${JSON.stringify(windows)}`, app);
}
module.exports = { waitFor, clickMenu, trayState, noWindow, focusWindow };
