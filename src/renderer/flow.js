const INSTALL_STEPS = [
  { id: 'check', label: 'Checking this computer', estimate: 'about 10 seconds' },
  { id: 'download', label: 'Downloading ElastOS', estimate: 'about 1 minute' },
  { id: 'install', label: 'Installing', estimate: 'about 30 seconds' },
  { id: 'setup', label: 'Setting up your computer', estimate: 'about 2 minutes' },
  { id: 'start', label: 'Starting', estimate: 'about 20 seconds' },
];

function stepIndexForMessage(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('ready')) return INSTALL_STEPS.length;
  if (text.includes('starting')) return 4;
  if (text.includes('setting up') || text.includes('resuming')) return 3;
  if (text.includes('installing')) return 2;
  if (text.includes('download') || text.includes('hosted installer') || text.includes('pinned')) return 1;
  if (text.includes('checking')) return 0;
  return -1;
}

function stepStates(message) {
  const active = stepIndexForMessage(message);
  return INSTALL_STEPS.map((step, index) => ({
    ...step,
    state: active >= INSTALL_STEPS.length || index < active ? 'done' : index === active ? 'active' : 'pending',
  }));
}

function primaryAction(state) {
  const status = state.status;
  if (state.busy) return { id: 'busy', label: 'Working…', enabled: false };
  if (status === 'running') {
    return {
      id: 'open',
      label: 'Open my computer',
      enabled: true,
    };
  }
  if (status === 'not-installed' || status === 'error') {
    return {
      id: status === 'error' ? 'retry' : 'install',
      label: status === 'error' ? 'Try again' : 'Install',
      enabled: true,
    };
  }
  if (status === 'starting' || status === 'stopping') {
    return { id: 'busy', label: 'Please wait', enabled: false };
  }
  return { id: 'start', label: 'Start', enabled: true };
}

function confirmCopy(_targetId, paths) {
  return {
    title: 'Uninstall ElastOS?',
    body: 'This removes the ElastOS program and its data from this computer.',
    paths,
  };
}

function resetCopy() {
  return {
    title: 'Reset ElastOS?',
    body: 'This removes the ElastOS program and its data on this computer so you can install it again.',
  };
}

function firstRunCopy(_targetId, status) {
  if (status !== 'not-installed') return '';
  return 'Install ElastOS on this computer. One button downloads it, sets it up, and starts it. Then you open your computer in the browser.';
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return 'size unavailable';
  const size = Number(bytes);
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function legacyPc2Copy(items) {
  const lines = (items || []).map((entry) => `${entry.label} — ${entry.path} (${formatBytes(entry.bytes)})`);
  return {
    title: 'Remove PC2?',
    body: 'This removes the old PC2 install from this computer. ElastOS is left as it is.',
    list: lines.join('\n'),
    backup: 'Back up my PC2 data first',
    confirm: 'Remove PC2',
    done: 'PC2 removed',
  };
}

/** The info-panel Browser line. The main process sends it on Windows only. */
function browserNoteText(info) {
  return info && typeof info.browserNote === 'string' ? info.browserNote : '';
}

function urlLabel(openUrl) {
  return String(openUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const api = {
  INSTALL_STEPS,
  stepIndexForMessage,
  stepStates,
  primaryAction,
  confirmCopy,
  resetCopy,
  firstRunCopy,
  formatBytes,
  legacyPc2Copy,
  browserNoteText,
  urlLabel,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.elastosFlow = api;
}
