const statusText = document.getElementById('status-text');
const powerBtn = document.getElementById('power-btn');
const openBtn = document.getElementById('open-btn');
const openLabel = document.getElementById('open-label');
const uninstallBtn = document.getElementById('uninstall-btn');
const resetBtn = document.getElementById('reset-btn');
const logsContent = document.getElementById('logs-content');
const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmBody = document.getElementById('confirm-body');
const confirmPath = document.getElementById('confirm-path');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmDelete = document.getElementById('confirm-delete');
const versionEl = document.getElementById('version');
const updateBtn = document.getElementById('update-btn');
const updateBtnLabel = document.getElementById('update-btn-label');
const rollbackBtn = document.getElementById('rollback-btn');
const platformNote = document.getElementById('platform-note');
const fixBtn = document.getElementById('fix-btn');
const diagnosticsBtn = document.getElementById('diagnostics-btn');
const supportBtn = document.getElementById('support-btn');
const loginCheckbox = document.getElementById('login-checkbox');
const urlValue = document.getElementById('url-value');
const removePc2Btn = document.getElementById('remove-pc2-btn');
const confirmBackupRow = document.getElementById('confirm-backup-row');
const confirmBackup = document.getElementById('confirm-backup');
const resetBackup = document.getElementById('reset-backup');
const resetBackupText = document.getElementById('reset-backup-text');
const resetBackupWarning = document.getElementById('reset-backup-warning');
const resetBackupYes = document.getElementById('reset-backup-yes');
const resetBackupNo = document.getElementById('reset-backup-no');
const resetBackupYesLabel = document.getElementById('reset-backup-yes-label');
const resetBackupNoLabel = document.getElementById('reset-backup-no-label');
const resetBackupSpace = document.getElementById('reset-backup-space');
const browserRow = document.getElementById('browser-row');
const browserNote = document.getElementById('browser-note');

let currentStatus = 'stopped';
let confirmMode = 'uninstall';
let legacyItems = [];
let legacyConfirmPaths = [];
let pc2Busy = false;
let resetOffer = null;
/** Windows: Uninstall removes the ElastOS Linux environment after it saves it (launch info). */
let uninstallRemovesLinux = false;
let targetId = 'runtime';
// The main process sends the Home address (src/main/targets/gatewayAddress.ts).
let openUrl = '';
let busy = false;
let errorMessage = '';
let statusMessage = '';
let errorGeneration = 0;
let logs = [];
const MAX_LOGS = 200;
const flow = window.elastosFlow;

const statusLabels = {
  running: 'Home is running',
  stopped: 'Home is stopped',
  starting: 'Starting...',
  stopping: 'Stopping...',
  error: 'Home needs attention.',
  'not-installed': 'Home is not installed',
  'other-home': 'another ElastOS Home is running'
};

async function showError(message) {
  const generation = ++errorGeneration;
  errorMessage = message ? String(message) : 'Home needs attention.';
  statusMessage = '';
  fixBtn.classList.add('hidden');
  updateStatus(currentStatus);
  addLog(message);
  try {
    const screen = await window.elastos.describeFailure();
    if (generation !== errorGeneration || !screen) return;
    if (!message && screen.message) {
      errorMessage = screen.message;
      addLog(screen.message);
      updateStatus(currentStatus);
    }
    fixBtn.classList.toggle('hidden', !screen.fixLabel);
    if (screen.fixLabel) fixBtn.textContent = screen.fixLabel;
  } catch {
    if (generation === errorGeneration) fixBtn.classList.add('hidden');
  }
}

function hidePc2Backup() {
  confirmBackupRow.classList.add('hidden');
  confirmBackup.checked = false;
}

function hideResetBackup() {
  resetOffer = null;
  resetBackup.classList.add('hidden');
  resetBackupYes.checked = false;
  resetBackupNo.checked = false;
  confirmDelete.disabled = false;
}

/** Reset stays off until the person answers the backup offer. Only Reset offers it. */
function syncResetButton() {
  if (confirmMode !== 'reset') return;
  if (!resetOffer) {
    confirmDelete.disabled = true;
    return;
  }
  confirmDelete.disabled = Boolean(resetOffer.blocked)
    || (resetOffer.needsChoice && !resetBackupYes.checked && !resetBackupNo.checked);
}

function showResetBackup(description) {
  const copy = flow.resetBackupCopy(description);
  resetOffer = copy;
  resetBackupText.textContent = copy.text;
  resetBackupWarning.textContent = copy.canSave ? copy.warning : '';
  resetBackupYesLabel.textContent = copy.yes;
  resetBackupNoLabel.textContent = copy.no;
  resetBackupYes.checked = false;
  resetBackupNo.checked = false;
  resetBackupYes.disabled = !copy.canSave;
  resetBackupYes.parentElement.classList.toggle('hidden', !copy.needsChoice);
  resetBackupNo.parentElement.classList.toggle('hidden', !copy.needsChoice);
  resetBackupSpace.textContent = copy.space;
  resetBackupSpace.classList.toggle('hidden', !copy.space);
  resetBackup.classList.remove('hidden');
  syncResetButton();
}

function showLegacyPc2(items) {
  legacyItems = Array.isArray(items) ? items : [];
  removePc2Btn.classList.toggle('hidden', legacyItems.length === 0);
}

async function refreshLegacyPc2() {
  try {
    const found = await window.elastos.describeLegacyPc2();
    showLegacyPc2(found && found.items);
  } catch {
    showLegacyPc2([]);
  }
}

function clearError() {
  errorGeneration++;
  errorMessage = '';
  statusMessage = '';
  fixBtn.classList.add('hidden');
  updateStatus(currentStatus);
}

function updateStatus(status) {
  currentStatus = status;
  statusText.textContent = errorMessage ? errorMessage.split(/\n|(?<=[.!?])\s+/)[0]
    : statusMessage || statusLabels[status] || status;
  statusText.dataset.status = status;
  statusText.dataset.error = String(Boolean(errorMessage));
  const action = flow.primaryAction({ targetId, status, busy });
  openLabel.textContent = action.label;
  openBtn.disabled = !action.enabled;
  openBtn.dataset.action = action.id;
  powerBtn.classList.toggle('hidden', status !== 'running');
  powerBtn.disabled = busy;
  updateBtn.disabled = busy;
  const installed = status !== 'not-installed';
  uninstallBtn.disabled = !installed || status === 'running' || busy;
  resetBtn.disabled = !installed || busy;
  removePc2Btn.disabled = busy || pc2Busy;
  urlValue.textContent = openUrl;
  urlValue.href = openUrl;
  urlValue.classList.toggle('hidden', status !== 'running' || !openUrl);
}

async function runHomeAction(action) {
  if (busy) return;
  busy = true;
  clearError();
  try {
    await action();
    clearError();
  } catch (err) {
    await showError(err.message);
  } finally {
    busy = false;
    updateStatus(await window.elastos.getStatus().catch(() => currentStatus));
  }
}

async function retryHome() {
  if (busy) return;
  try {
    if (await window.elastos.isInstalled()) await runHomeAction(() => window.elastos.start());
    else await runInstall();
  } catch (err) {
    await showError(err.message);
  }
}

function addLog(message) {
  message = flow.launcherLog(message);
  if (!message) return;
  logs.push(message);
  if (logs.length > MAX_LOGS) logs.shift();
  logsContent.textContent = logs.join('\n');
  logsContent.scrollTop = logsContent.scrollHeight;
}

async function runInstall() {
  if (busy) return;
  busy = true;
  clearError();
  statusMessage = 'Installing…';
  updateStatus(currentStatus);
  try {
    const preflight = await window.elastos.getPreflight();
    const blocked = (preflight.checks || []).filter((check) => check.level === 'block');
    const warnings = (preflight.checks || []).filter((check) => check.level === 'warn');
    if (warnings.length) {
      platformNote.textContent = warnings.map((check) => check.message).join(' ');
      platformNote.classList.remove('hidden');
    }
    if (!preflight.ok) {
      await showError(blocked.map((check) => check.message).join(' '));
      return;
    }
    await window.elastos.install();
    await window.elastos.start();
    clearError();
    await refreshVersion();
    const started = await window.elastos.getLaunchInfo();
    if (flow.shouldOpenBrowserAfterStart(started)) {
      await window.elastos.openBrowser();
    }
  } catch (err) {
    await showError(err && err.message ? err.message : 'Something went wrong. Try again.');
    updateStatus('error');
  } finally {
    busy = false;
    statusMessage = '';
    const status = await window.elastos.getStatus().catch(() => currentStatus);
    updateStatus(status);
  }
}

openBtn.addEventListener('click', async () => {
  const action = openBtn.dataset.action;
  if (action === 'install') await runInstall();
  if (action === 'retry') await retryHome();
  if (action === 'open') await runHomeAction(() => window.elastos.openBrowser());
  if (action === 'start') await runHomeAction(() => window.elastos.start());
});

urlValue.addEventListener('click', async (event) => {
  event.preventDefault();
  await runHomeAction(() => window.elastos.openBrowser());
});

fixBtn.addEventListener('click', async () => {
  fixBtn.disabled = true;
  try {
    const result = await window.elastos.fixFailure();
    if (result === 'ready') {
      clearError();
      await retryHome();
      return;
    }
    await showError('That still needs attention.');
  } catch (err) {
    await showError(err && err.message ? err.message : 'Fix it did not finish.');
  } finally {
    fixBtn.disabled = false;
  }
});

diagnosticsBtn.addEventListener('click', async () => {
  const text = await window.elastos.getDiagnostics();
  try {
    await navigator.clipboard.writeText(text);
    diagnosticsBtn.textContent = 'Copied';
    setTimeout(() => { diagnosticsBtn.textContent = 'Copy diagnostics'; }, 2000);
  } catch (err) {
    addLog('Could not copy diagnostics.');
  }
});

supportBtn.addEventListener('click', async () => {
  try {
    await window.elastos.saveSupportBundle();
    supportBtn.textContent = 'Saved';
    addLog('Saved ElastOS-support.txt on the Desktop, or in the home folder if there is no Desktop.');
    setTimeout(() => { supportBtn.textContent = 'Save support file'; }, 2000);
  } catch (err) {
    showError(err && err.message ? err.message : 'Could not save the support bundle.');
  }
});

powerBtn.addEventListener('click', () => runHomeAction(() => window.elastos.stop()));

document.getElementById('log-folder-btn').addEventListener('click', async () => {
  try {
    await window.elastos.openLogFolder();
    clearError();
  } catch (err) {
    await showError(err.message);
  }
});

document.getElementById('details').addEventListener('toggle', async (event) => {
  if (!event.target.open || logs.length) return;
  try {
    const text = await window.elastos.getLogs(100);
    logs = flow.launcherLog(text).split('\n').filter(Boolean);
    logsContent.textContent = logs.join('\n') || 'No recent launcher messages.';
  } catch (err) {
    await showError(err.message);
  }
});

resetBtn.addEventListener('click', async () => {
  const copy = flow.resetCopy();
  confirmMode = 'reset';
  hidePc2Backup();
  hideResetBackup();
  confirmTitle.textContent = copy.title;
  confirmBody.textContent = copy.body;
  confirmPath.textContent = 'The ElastOS program and its data folder';
  confirmDelete.textContent = 'Reset';
  confirmModal.classList.remove('hidden');
  await loadBackupOffer('reset');
});

/** Show "Checking the size", then the offer. Nothing can be confirmed until it is answered. */
async function loadBackupOffer(mode) {
  resetBackupText.textContent = 'Checking the size of your ElastOS data...';
  resetBackupWarning.textContent = '';
  resetBackupSpace.classList.add('hidden');
  resetBackupYes.parentElement.classList.add('hidden');
  resetBackupNo.parentElement.classList.add('hidden');
  resetBackup.classList.remove('hidden');
  confirmDelete.disabled = true;
  let description = null;
  try {
    description = await window.elastos.describeResetBackup();
  } catch {
    description = null;
  }
  if (confirmMode !== mode || confirmModal.classList.contains('hidden')) return;
  showResetBackup(description);
}

resetBackupYes.addEventListener('change', syncResetButton);
resetBackupNo.addEventListener('change', syncResetButton);

uninstallBtn.addEventListener('click', async () => {
  confirmMode = 'uninstall';
  hidePc2Backup();
  hideResetBackup();
  confirmDelete.textContent = uninstallRemovesLinux ? 'Uninstall' : 'Delete';
  const copy = flow.confirmCopy(targetId, [], uninstallRemovesLinux);
  confirmTitle.textContent = copy.title;
  confirmBody.textContent = copy.body;
  confirmPath.textContent = uninstallRemovesLinux
    ? 'The Linux environment named ElastOS, with everything in it'
    : 'The ElastOS program and its data folder';
  confirmModal.classList.remove('hidden');
});

removePc2Btn.addEventListener('click', () => {
  if (!legacyItems.length || pc2Busy) return;
  legacyConfirmPaths = legacyItems.map((entry) => String(entry.path));
  const copy = flow.legacyPc2Copy(legacyItems);
  confirmMode = 'pc2';
  hideResetBackup();
  confirmTitle.textContent = copy.title;
  confirmBody.textContent = copy.body;
  confirmPath.textContent = copy.list;
  confirmDelete.textContent = copy.confirm;
  const canBackup = legacyItems.some((entry) => entry.scope === 'distro' || String(entry.path).endsWith('/.pc2') || String(entry.path).endsWith('\\.pc2'));
  confirmBackupRow.classList.toggle('hidden', !canBackup);
  confirmBackup.checked = false;
  confirmModal.classList.remove('hidden');
});

confirmCancel.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
  hideResetBackup();
});

confirmDelete.addEventListener('click', async () => {
  let resetChoice = null;
  if (confirmMode === 'reset') {
    // No answer to the backup offer means no Reset.
    if (!resetOffer || resetOffer.blocked) return;
    if (resetOffer.needsChoice && !resetBackupYes.checked && !resetBackupNo.checked) return;
    resetChoice = { backup: Boolean(resetOffer.canSave && resetBackupYes.checked) };
  }
  confirmModal.classList.add('hidden');
  if (confirmMode === 'pc2') {
    if (pc2Busy) return;
    const backup = confirmBackup.checked;
    const paths = legacyConfirmPaths.slice();
    hidePc2Backup();
    pc2Busy = true;
    busy = true;
    clearError();
    statusMessage = 'Removing old PC2 files…';
    updateStatus(currentStatus);
    try {
      const result = await window.elastos.removeLegacyPc2(backup, paths);
      if (result && result.ok === false) throw new Error(result.message);
      clearError();
      statusMessage = 'Old PC2 files removed.';
      addLog(statusMessage);
      if (result && result.message) addLog(result.message);
      showLegacyPc2([]);
    } catch (err) {
      showError(err && err.message ? err.message : 'PC2 could not be removed.');
    } finally {
      pc2Busy = false;
      busy = false;
    }
    await refreshLegacyPc2();
    updateStatus(currentStatus);
    return;
  }
  const resetting = confirmMode === 'reset';
  const saving = Boolean(resetChoice && resetChoice.backup);
  busy = true;
  clearError();
  statusMessage = resetting
    ? (saving ? 'Saving a copy of your data, then resetting...' : 'Resetting...')
    : (uninstallRemovesLinux ? 'Saving the whole Linux environment, then removing it...' : 'Removing...');
  hideResetBackup();
  updateStatus(currentStatus);
  try {
    if (resetting) {
      const result = await window.elastos.resetRuntime(resetChoice);
      if (result && result.backupPath) addLog(`A copy of your ElastOS data is in ${result.backupPath}. Keep it private.`);
      addLog('ElastOS was reset. Click Install to set it up again.');
    } else {
      const result = await window.elastos.uninstall();
      if (result && result.linuxCopyMessage) addLog(result.linuxCopyMessage);
      addLog(result && result.removedLinux ? 'ElastOS was removed, with its Linux environment.' : 'ElastOS was removed.');
    }
    clearError();
    await refreshVersion();
  } catch (err) {
    await showError(err.message);
  } finally {
    busy = false;
    updateStatus(await window.elastos.getStatus().catch(() => currentStatus));
  }
});

confirmModal.addEventListener('click', (event) => {
  if (event.target === confirmModal) confirmModal.classList.add('hidden');
});

loginCheckbox.addEventListener('change', async () => {
  const enabled = loginCheckbox.checked;
  loginCheckbox.disabled = true;
  try {
    loginCheckbox.checked = await window.elastos.setOpenAtLogin(enabled);
    clearError();
  } catch (err) {
    loginCheckbox.checked = !enabled;
    await showError(err.message);
  } finally {
    loginCheckbox.disabled = false;
  }
});

window.elastos.onActionSuccess(clearError);
window.elastos.onStatus((status) => {
  updateStatus(status);
  if (status === 'error' && !errorMessage) void showError();
});
window.elastos.onLog((log) => addLog(log));
window.elastos.onInstallProgress((message) => {
  statusMessage = 'Installing…';
  updateStatus(currentStatus);
  addLog(message);
});
window.elastos.onUpdateProgress((message) => {
  statusMessage = 'Updating…';
  updateStatus(currentStatus);
  addLog(message);
});

async function refreshVersion() {
  try {
    const version = await window.elastos.getVersion();
    versionEl.textContent = !version || version === 'not installed' || /not supported/i.test(version)
      ? 'ElastOS 2.0.0'
      : `ElastOS ${version.replace(/^(ElastOS |v)/, '')}`;
  } catch {
    versionEl.textContent = 'ElastOS 2.0.0';
  }
}

async function checkForUpdate() {
  try {
    const result = await window.elastos.checkForUpdate();
    if (result.updateAvailable) {
      updateBtn.classList.remove('hidden');
      updateBtnLabel.textContent = result.latest && result.latest !== 'a newer release'
        ? `Update to ${result.latest}`
        : 'Update';
    } else {
      updateBtn.classList.add('hidden');
    }
  } catch {
    updateBtn.classList.add('hidden');
  }
}

rollbackBtn.addEventListener('click', () => runHomeAction(async () => {
  await window.elastos.rollback();
  await refreshVersion();
  addLog('Restored the previous ElastOS release.');
}));

updateBtn.addEventListener('click', async () => {
  if (busy) return;
  await runHomeAction(async () => {
    await window.elastos.update();
    await refreshVersion();
    updateBtn.classList.add('hidden');
  });
  updateStatus(currentStatus);
});

async function refreshLaunch() {
  const info = await window.elastos.getLaunchInfo();
  targetId = 'runtime';
  openUrl = info.openUrl || '';
  uninstallRemovesLinux = Boolean(info.uninstallRemovesLinux);
  if (rollbackBtn) rollbackBtn.classList.toggle('hidden', !info.canRollback);
  loginCheckbox.checked = Boolean(info.openAtLogin);
  const browserText = window.elastos.platform === 'win32' ? flow.browserNoteText(info) : '';
  browserNote.textContent = browserText;
  browserRow.classList.toggle('hidden', !browserText);
  const blocks = (info.preflight.checks || []).filter((check) => check.level === 'block' || check.level === 'warn');
  if (info.platformNote || blocks.length) {
    platformNote.textContent = info.platformNote || blocks.map((check) => check.message).join(' ');
    platformNote.classList.remove('hidden');
  } else {
    platformNote.classList.add('hidden');
  }
  updateStatus(info.status || await window.elastos.getStatus());
  if (info.error) await showError(info.error);
  await refreshVersion();
  checkForUpdate();
  await refreshLegacyPc2();
}

async function maybeResumeInstall() {
  if (busy) return;
  try {
    const plan = await window.elastos.resumeInstallPlan();
    if (plan !== 'install' || busy) return;
    await runInstall();
    const status = await window.elastos.getStatus().catch(() => 'error');
    if (typeof window.elastos.finishResumeInstall === 'function') {
      await window.elastos.finishResumeInstall(status === 'running');
    }
  } catch (err) {
    console.error('Resume error:', err);
    if (typeof window.elastos.finishResumeInstall === 'function') {
      await window.elastos.finishResumeInstall(false).catch(() => {});
    }
  }
}

async function init() {
  try {
    await refreshLaunch();
  } catch (err) {
    console.error('Init error:', err);
    updateStatus('error');
    showError(err && err.message ? err.message : 'Could not read this computer. Quit ElastOS and open it again.');
    return;
  }
  await maybeResumeInstall();
}

const resizeObserver = new ResizeObserver(() => {
  window.elastos.contentSize(Math.ceil(document.getElementById('window-content').getBoundingClientRect().height));
});
resizeObserver.observe(document.getElementById('window-content'));

init();
