const api = window.elastos;
const $ = id => document.getElementById(id);
let state;
function render(next) {
  state = next;
  document.body.dataset.state = state.kind;
  $('message').hidden = !state.message;
  $('message').textContent = state.message || '';
  $('login-row').hidden = state.kind !== 'install' || state.ready;
  $('location').hidden = !state.ready;
  $('location').textContent = api.platform === 'darwin' ? '↑ ElastOS is in the menu bar.'
    : api.platform === 'win32' ? "ElastOS is in the system tray. If you don't see it, click ^ next to the clock."
      : 'ElastOS is in the top bar.';
  $('release-notes').hidden = state.kind !== 'update' || !state.releaseNotes;
  $('progress').hidden = state.kind !== 'progress';
  $('actions').hidden = state.kind === 'progress';
  $('cancel').hidden = state.kind !== 'update';
  $('diagnostics').hidden = state.kind !== 'error';
  $('primary').textContent = state.kind === 'update' ? 'Update' : state.kind === 'error' ? state.actionLabel
    : state.ready ? 'Open Home' : 'Install';
  if (state.kind !== 'progress') $('primary').focus();
}
$('primary').addEventListener('click', async () => {
  $('primary').disabled = true;
  try {
    if (state.kind === 'install' && !state.ready) await api.install($('login').checked);
    else if (state.kind === 'update') await api.update();
    else if (state.kind === 'error') await api.retry();
    else await api.openHome();
  } finally { $('primary').disabled = false; }
});
$('cancel').addEventListener('click', () => api.closeWindow());
$('release-notes').addEventListener('click', event => { event.preventDefault(); api.releaseNotes(); });
$('diagnostics').addEventListener('click', async () => {
  await api.copyDiagnostics();
  $('diagnostics').textContent = 'Copied';
  setTimeout(() => { $('diagnostics').textContent = 'Copy Diagnostics'; }, 2000);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') api.closeWindow();
  if (event.key === 'Enter' && !['BUTTON', 'A'].includes(document.activeElement.tagName) && state.kind !== 'progress') $('primary').click();
});
api.onWindowState(render);
api.getWindowState().then(render);
new ResizeObserver(() => api.contentSize(Math.ceil($('window-content').getBoundingClientRect().height)))
  .observe($('window-content'));
