async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(typeof message === 'function' ? message() : message);
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
  await waitFor(() => app.evaluate((_e, image) => global.__elastosTrayState === image, image), 180000, `Tray did not become ${image}`);
}
async function noWindow(app) {
  let windows = [];
  await waitFor(async () => {
    windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
      id: window.id, title: window.getTitle(), visible: window.isVisible(),
    })));
    return windows.every(window => !window.visible);
  }, 10000, () => `No visible windows after 10000 ms: expected none; last window state: ${JSON.stringify(windows)}`);
}
module.exports = { waitFor, clickMenu, trayState, noWindow };
