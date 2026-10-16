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
  const targetId = state.targetId;
  const status = state.status;
  if (state.busy) return { id: 'busy', label: 'Working…', enabled: false };
  if (status === 'running') {
    return {
      id: 'open',
      label: targetId === 'runtime' ? 'Open my computer' : 'Open My Cloud',
      enabled: true,
    };
  }
  if (status === 'not-installed' || status === 'error') {
    return {
      id: status === 'error' ? 'retry' : 'install',
      label: status === 'error' ? 'Try again' : 'Install',
      enabled: targetId === 'runtime' || status === 'not-installed',
    };
  }
  if (status === 'starting' || status === 'stopping') {
    return { id: 'busy', label: 'Please wait', enabled: false };
  }
  return { id: 'start', label: 'Start', enabled: true };
}

function confirmCopy(targetId, paths) {
  if (targetId === 'runtime') {
    return {
      title: 'Uninstall ElastOS?',
      body: 'This removes ElastOS from this computer. It does not delete PC2.',
      paths,
    };
  }
  return {
    title: 'Uninstall PC2?',
    body: 'This permanently deletes the PC2 files at:',
    paths,
  };
}

function resetCopy() {
  return {
    title: 'Reset ElastOS?',
    body: 'This removes the ElastOS program and its data on this computer so you can install it again.',
  };
}

function firstRunCopy(targetId, status) {
  if (targetId !== 'runtime' || status !== 'not-installed') return '';
  return 'Install ElastOS on this computer. One button downloads it, sets it up, and starts it. Then you open your computer in the browser.';
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
  urlLabel,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.elastosFlow = api;
}
