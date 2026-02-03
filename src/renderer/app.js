// UI Elements
const statusLed = document.getElementById('status-led');
const statusText = document.getElementById('status-text');
const powerBtn = document.getElementById('power-btn');
const openBtn = document.getElementById('open-btn');
const logsBtn = document.getElementById('logs-btn');
const uninstallBtn = document.getElementById('uninstall-btn');
const logsPanel = document.getElementById('logs-panel');
const logsContent = document.getElementById('logs-content');
const closeLogsBtn = document.getElementById('close-logs');
const envSelect = document.getElementById('env-select');
const confirmModal = document.getElementById('confirm-modal');
const confirmPath = document.getElementById('confirm-path');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmDelete = document.getElementById('confirm-delete');
const copyLogsBtn = document.getElementById('copy-logs');

let currentStatus = 'stopped';
let logs = [];
const MAX_LOGS = 200;

// Status labels
const statusLabels = {
  'running': 'Running',
  'stopped': 'Stopped',
  'starting': 'Starting...',
  'stopping': 'Stopping...',
  'error': 'Error',
  'not-installed': 'Not Installed'
};

// Update UI based on status
function updateStatus(status) {
  currentStatus = status;
  
  // Update LED
  statusLed.className = 'led ' + status;
  
  // Update text
  statusText.textContent = statusLabels[status] || status;
  
  // Update power button
  powerBtn.className = 'power-button' + (status === 'running' ? ' running' : '');
  powerBtn.disabled = status === 'starting' || status === 'stopping';
  
  // Update buttons - enable when running
  const isRunning = status === 'running';
  openBtn.disabled = !isRunning;
  
  // Enable uninstall only when stopped and installed
  const isInstalled = status !== 'not-installed';
  uninstallBtn.disabled = !isInstalled || isRunning;
}

// Add log message
function addLog(message) {
  logs.push(message);
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }
  
  logsContent.textContent = logs.join('\n');
  logsContent.scrollTop = logsContent.scrollHeight;
}

// Power button click - starts or stops, installs if needed
powerBtn.addEventListener('click', async () => {
  if (currentStatus === 'running') {
    await window.pc2.stop();
  } else if (currentStatus === 'stopped' || currentStatus === 'error') {
    await window.pc2.start();
  } else if (currentStatus === 'not-installed') {
    // Install and start
    updateStatus('starting');
    statusText.textContent = 'Installing...';
    try {
      await window.pc2.install();
      await window.pc2.start();
    } catch (err) {
      updateStatus('error');
      addLog('Installation failed: ' + err.message);
    }
  }
});

// Open browser button
openBtn.addEventListener('click', () => {
  window.pc2.openBrowser();
});

// Toggle logs panel
logsBtn.addEventListener('click', async () => {
  if (logsPanel.classList.contains('hidden')) {
    // Load logs
    const logText = await window.pc2.getLogs(100);
    logs = logText.split('\n').filter(l => l.trim());
    logsContent.textContent = logs.join('\n');
    logsContent.scrollTop = logsContent.scrollHeight;
    logsPanel.classList.remove('hidden');
  } else {
    logsPanel.classList.add('hidden');
  }
});

// Close logs
closeLogsBtn.addEventListener('click', () => {
  logsPanel.classList.add('hidden');
});

// Copy logs
copyLogsBtn.addEventListener('click', async () => {
  const logText = logsContent.textContent;
  try {
    await navigator.clipboard.writeText(logText);
    copyLogsBtn.classList.add('copied');
    setTimeout(() => copyLogsBtn.classList.remove('copied'), 2000);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
});

// Uninstall button - show confirmation
uninstallBtn.addEventListener('click', async () => {
  const envInfo = await window.pc2.getEnvironment();
  confirmPath.textContent = envInfo.path.replace(/^\/Users\/[^/]+/, '~');
  confirmModal.classList.remove('hidden');
});

// Confirm cancel
confirmCancel.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
});

// Confirm delete
confirmDelete.addEventListener('click', async () => {
  confirmModal.classList.add('hidden');
  statusText.textContent = 'Uninstalling...';
  try {
    await window.pc2.uninstall();
    addLog('PC2 uninstalled successfully');
  } catch (err) {
    addLog('Uninstall failed: ' + err.message);
  }
});

// Click outside confirm modal to close
confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) {
    confirmModal.classList.add('hidden');
  }
});

// Environment selector
envSelect.addEventListener('change', async () => {
  const env = envSelect.value;
  
  // Stop PC2 if running before switching
  if (currentStatus === 'running') {
    await window.pc2.stop();
  }
  
  await window.pc2.setEnvironment(env);
  
  // Check status in new environment
  const status = await window.pc2.getStatus();
  updateStatus(status);
});

// Listen for status changes
window.pc2.onStatus((status) => {
  updateStatus(status);
});

// Listen for log messages
window.pc2.onLog((log) => {
  addLog(log);
});

// Listen for install progress
window.pc2.onInstallProgress((message) => {
  statusText.textContent = message;
  addLog(message);
});

// Initial setup
async function init() {
  try {
    // Load current environment
    const envInfo = await window.pc2.getEnvironment();
    envSelect.value = envInfo.env;
    
    // Check status
    const status = await window.pc2.getStatus();
    updateStatus(status);
  } catch (err) {
    console.error('Init error:', err);
    updateStatus('error');
  }
}

init();
