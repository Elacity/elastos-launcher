import { spawn, exec, execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

const HOME = os.homedir();
const PC2_URL = 'http://localhost:4200';

// Get proper shell PATH for finding pm2, node, npm etc.
function getShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  
  // Common paths where node/npm/pm2 might be installed
  const additionalPaths = [
    path.join(HOME, '.nvm/versions/node'),  // nvm
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(HOME, '.npm-global/bin'),
    path.join(HOME, '.local/bin'),
  ];
  
  // Find nvm node version
  const nvmDir = path.join(HOME, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      if (versions.length > 0) {
        // Use the most recent version
        const latestVersion = versions.sort().reverse()[0];
        additionalPaths.unshift(path.join(nvmDir, latestVersion, 'bin'));
      }
    } catch (e) {
      log.warn('Could not read nvm versions:', e);
    }
  }
  
  // Build PATH
  const currentPath = env.PATH || '';
  env.PATH = [...additionalPaths, ...currentPath.split(':')].join(':');
  
  return env;
}

const shellEnv = getShellEnv();

export type PC2Status = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'not-installed';
export type PC2Environment = 'default' | 'dev' | 'custom';

// Environment configurations
const ENVIRONMENTS: Record<string, { dir: string; nodeDir: string; label: string }> = {
  'default': {
    dir: path.join(HOME, '.pc2'),
    nodeDir: path.join(HOME, '.pc2', 'pc2-node'),
    label: 'Default (~/.pc2)'
  },
  'dev': {
    dir: path.join(HOME, 'pc2.net'),
    nodeDir: path.join(HOME, 'pc2.net', 'pc2-node'),
    label: 'Development (~/pc2.net)'
  },
  'custom': {
    dir: '',
    nodeDir: '',
    label: 'Custom Location'
  }
};

let currentEnv: PC2Environment = 'default';
let customPath: string = '';

export function setEnvironment(env: PC2Environment, customDir?: string): void {
  currentEnv = env;
  if (env === 'custom' && customDir) {
    customPath = customDir;
    ENVIRONMENTS.custom.dir = customDir;
    ENVIRONMENTS.custom.nodeDir = path.join(customDir, 'pc2-node');
  }
  log.info(`Environment set to: ${env}`, getPC2Dir());
}

export function getEnvironment(): PC2Environment {
  return currentEnv;
}

export function getPC2Dir(): string {
  return ENVIRONMENTS[currentEnv].dir;
}

export function getPC2NodeDir(): string {
  return ENVIRONMENTS[currentEnv].nodeDir;
}

export function getEnvironmentLabel(): string {
  return ENVIRONMENTS[currentEnv].label;
}

let statusListeners: ((status: PC2Status) => void)[] = [];
let logListeners: ((log: string) => void)[] = [];

export function onStatusChange(callback: (status: PC2Status) => void): void {
  statusListeners.push(callback);
}

export function onLog(callback: (log: string) => void): void {
  logListeners.push(callback);
}

function emitStatus(status: PC2Status): void {
  statusListeners.forEach(cb => cb(status));
}

function emitLog(message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  const logMessage = `[${timestamp}] ${message}`;
  log.info(logMessage);
  logListeners.forEach(cb => cb(logMessage));
}

export async function isInstalled(): Promise<boolean> {
  const nodeDir = getPC2NodeDir();
  return fs.existsSync(nodeDir) && fs.existsSync(path.join(nodeDir, 'dist', 'index.js'));
}

export async function getStatus(): Promise<PC2Status> {
  // First check if installed
  const installed = await isInstalled();
  if (!installed) {
    return 'not-installed';
  }

  // Try to hit the health endpoint
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    
    const response = await fetch(`${PC2_URL}/health`, { 
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    
    if (response.ok) {
      return 'running';
    }
  } catch (err) {
    // Server not responding, check PM2
  }

  // Check PM2 process
  return new Promise((resolve) => {
    exec('pm2 jlist', { env: shellEnv }, (error, stdout) => {
      if (error) {
        resolve('stopped');
        return;
      }
      
      try {
        const processes = JSON.parse(stdout || '[]');
        const pc2 = processes.find((p: any) => p.name === 'pc2');
        
        if (pc2?.pm2_env?.status === 'online') {
          resolve('starting'); // PM2 says online but health check failed = still starting
        } else {
          resolve('stopped');
        }
      } catch (e) {
        resolve('stopped');
      }
    });
  });
}

export async function startPC2(): Promise<void> {
  const installed = await isInstalled();
  const nodeDir = getPC2NodeDir();
  
  if (!installed) {
    emitStatus('not-installed');
    emitLog('PC2 is not installed. Please install first.');
    return;
  }

  emitStatus('starting');
  emitLog(`Starting PC2 from ${nodeDir}...`);

  return new Promise((resolve, reject) => {
    const pm2Start = spawn('pm2', ['start', 'npm', '--name', 'pc2', '--', 'start'], {
      cwd: nodeDir,
      shell: true,
      env: shellEnv
    });

    pm2Start.stdout.on('data', (data) => {
      emitLog(data.toString().trim());
    });

    pm2Start.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) emitLog(msg);
    });

    pm2Start.on('close', (code) => {
      if (code === 0) {
        emitLog('PM2 process started, waiting for server...');
        waitForServer().then(() => {
          emitStatus('running');
          emitLog('PC2 is now running!');
          resolve();
        }).catch((err) => {
          emitStatus('error');
          emitLog('Failed to start: ' + err.message);
          reject(err);
        });
      } else {
        emitStatus('error');
        emitLog(`Failed to start PC2 (exit code: ${code})`);
        reject(new Error(`PM2 start failed with code ${code}`));
      }
    });
  });
}

export async function stopPC2(): Promise<void> {
  emitStatus('stopping');
  emitLog('Stopping PC2...');

  return new Promise((resolve) => {
    const pm2Stop = spawn('pm2', ['stop', 'pc2'], { shell: true, env: shellEnv });

    pm2Stop.stdout.on('data', (data) => {
      emitLog(data.toString().trim());
    });

    pm2Stop.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) emitLog(msg);
    });

    pm2Stop.on('close', () => {
      emitStatus('stopped');
      emitLog('PC2 stopped');
      resolve();
    });
  });
}

export async function restartPC2(): Promise<void> {
  emitStatus('starting');
  emitLog('Restarting PC2...');

  return new Promise((resolve, reject) => {
    const pm2Restart = spawn('pm2', ['restart', 'pc2'], { shell: true, env: shellEnv });

    pm2Restart.on('close', (code) => {
      if (code === 0) {
        waitForServer().then(() => {
          emitStatus('running');
          emitLog('PC2 restarted successfully');
          resolve();
        }).catch(reject);
      } else {
        emitStatus('error');
        reject(new Error(`Restart failed with code ${code}`));
      }
    });
  });
}

export async function getLogs(lines: number = 100): Promise<string> {
  return new Promise((resolve) => {
    exec(`pm2 logs pc2 --nostream --lines ${lines}`, { env: shellEnv }, (error, stdout, stderr) => {
      resolve(stdout + stderr);
    });
  });
}

export async function installPC2(onProgress: (message: string) => void): Promise<void> {
  const pc2Dir = getPC2Dir();
  const nodeDir = getPC2NodeDir();
  
  emitLog(`Installing PC2 to ${pc2Dir}...`);
  onProgress('Preparing installation...');

  // If directory exists but is not a valid PC2 install, back up and remove
  if (fs.existsSync(pc2Dir)) {
    const hasPackageJson = fs.existsSync(path.join(pc2Dir, 'package.json'));
    if (!hasPackageJson) {
      // Back up existing contents to a temp location
      const backupDir = `${pc2Dir}_backup_${Date.now()}`;
      emitLog(`Backing up existing ${pc2Dir} to ${backupDir}`);
      fs.renameSync(pc2Dir, backupDir);
    }
  }

  onProgress('Cloning repository...');

  const steps = [
    { cmd: `git clone https://github.com/Elacity/pc2.net "${pc2Dir}"`, msg: 'Cloning repository...' },
    { cmd: `cd "${pc2Dir}" && npm install --legacy-peer-deps --ignore-scripts`, msg: 'Installing dependencies...' },
    { cmd: `cd "${nodeDir}" && npm install --legacy-peer-deps`, msg: 'Installing node dependencies...' },
    { cmd: `cd "${nodeDir}" && npm run build`, msg: 'Building PC2...' },
  ];

  for (const step of steps) {
    onProgress(step.msg);
    emitLog(step.msg);
    
    await new Promise<void>((resolve, reject) => {
      exec(step.cmd, { maxBuffer: 10 * 1024 * 1024, env: shellEnv }, (error, stdout, stderr) => {
        if (error) {
          emitLog(`Error: ${error.message}`);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  emitLog('Installation complete!');
  onProgress('Installation complete!');
}

async function waitForServer(timeout: number = 30000): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`${PC2_URL}/health`, { 
        signal: controller.signal 
      });
      clearTimeout(timeoutId);
      
      if (response.ok) {
        return;
      }
    } catch (err) {
      // Keep trying
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error('Timeout waiting for server to start');
}

export function openInBrowser(): void {
  const { shell } = require('electron');
  shell.openExternal(PC2_URL);
}

export async function uninstallPC2(): Promise<void> {
  const pc2Dir = getPC2Dir();
  
  // Safety check - don't delete if it's a dev environment or system path
  if (!pc2Dir.includes('.pc2') && !pc2Dir.includes('pc2.net')) {
    throw new Error('Safety check failed: refusing to delete this path');
  }
  
  // Stop PC2 first if running
  const status = await getStatus();
  if (status === 'running') {
    await stopPC2();
  }
  
  emitLog(`Uninstalling PC2 from ${pc2Dir}...`);
  
  // Remove the directory
  if (fs.existsSync(pc2Dir)) {
    fs.rmSync(pc2Dir, { recursive: true, force: true });
    emitLog('PC2 uninstalled successfully');
  }
  
  emitStatus('not-installed');
}

export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

export function getLanURL(): string {
  const ip = getLocalIP();
  return `http://${ip}:4200`;
}

export async function generateQRCode(): Promise<string> {
  const QRCode = require('qrcode');
  const lanURL = getLanURL();
  return QRCode.toDataURL(lanURL, {
    width: 200,
    margin: 2,
    color: {
      dark: '#ffffff',
      light: '#1e1e1e'
    }
  });
}

export const PC2_URL_EXPORT = PC2_URL;
