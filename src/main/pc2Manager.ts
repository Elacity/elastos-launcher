import { spawn, exec, execSync, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

const HOME = os.homedir();
const PC2_URL = 'http://localhost:4200';
const IS_WINDOWS = process.platform === 'win32';

// Store the running PC2 process
let pc2Process: ChildProcess | null = null;
let logBuffer: string[] = [];
const MAX_LOG_LINES = 500;

// Get WSL home directory (for Windows)
function getWSLHome(): string {
  if (!IS_WINDOWS) return HOME;
  
  try {
    // Get the WSL username
    const result = execSync('wsl whoami', { encoding: 'utf8' }).trim();
    return `/home/${result}`;
  } catch (e) {
    log.warn('Could not get WSL home, using default');
    return '/home/user';
  }
}

const WSL_HOME = IS_WINDOWS ? getWSLHome() : HOME;

// Wrap command for WSL if on Windows
function wslCmd(cmd: string): string {
  if (!IS_WINDOWS) return cmd;
  
  // Wrap the command to run inside WSL with proper PATH
  const wslSetup = 'source ~/.nvm/nvm.sh 2>/dev/null || true; source ~/.bashrc 2>/dev/null || true;';
  return `wsl bash -c "${wslSetup} ${cmd.replace(/"/g, '\\"')}"`;
}

// Find node executable - prefer Node 20 LTS for compatibility
function findNodePath(): string {
  // Check nvm first - prefer v20.x for compatibility with native modules
  const nvmDir = path.join(HOME, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      // Prefer v20.x (LTS) over newer versions which may have compatibility issues
      const v20Versions = versions.filter(v => v.startsWith('v20'));
      const v22Versions = versions.filter(v => v.startsWith('v22'));
      
      // Try v20 first (best compatibility), then v22
      const preferredVersions = [...v20Versions.sort().reverse(), ...v22Versions.sort().reverse()];
      
      for (const version of preferredVersions) {
        const nvmNode = path.join(nvmDir, version, 'bin', 'node');
        if (fs.existsSync(nvmNode)) {
          log.info(`Using nvm Node.js ${version}`);
          return nvmNode;
        }
      }
      
      // Fallback to any version that's not too new (< v25)
      const safeVersions = versions.filter(v => {
        const major = parseInt(v.replace('v', '').split('.')[0], 10);
        return major >= 18 && major < 25;
      }).sort().reverse();
      
      if (safeVersions.length > 0) {
        const nvmNode = path.join(nvmDir, safeVersions[0], 'bin', 'node');
        if (fs.existsSync(nvmNode)) {
          log.info(`Using nvm Node.js ${safeVersions[0]}`);
          return nvmNode;
        }
      }
    } catch (e) {
      log.warn('Could not read nvm versions:', e);
    }
  }
  
  // Common paths where node might be installed
  const possiblePaths = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ];
  
  // Check other common paths
  for (const nodePath of possiblePaths) {
    if (fs.existsSync(nodePath)) {
      return nodePath;
    }
  }
  
  // Try to find via which
  try {
    const result = execSync('which node', { encoding: 'utf8' }).trim();
    if (result) return result;
  } catch (e) {
    // Ignore
  }
  
  // Fallback to just 'node' and hope it's in PATH
  return 'node';
}

// Check if Node version is compatible (18-24)
function checkNodeVersion(): { compatible: boolean; version: string; message: string } {
  try {
    const nodePath = findNodePath();
    const version = execSync(`"${nodePath}" -v`, { encoding: 'utf8' }).trim();
    const major = parseInt(version.replace('v', '').split('.')[0], 10);
    
    if (major >= 25) {
      return {
        compatible: false,
        version,
        message: `Node.js ${version} is too new. PC2 requires Node.js 20 LTS. Please install via: nvm install 20 && nvm use 20`
      };
    } else if (major < 18) {
      return {
        compatible: false,
        version,
        message: `Node.js ${version} is too old. PC2 requires Node.js 20 LTS. Please install via: nvm install 20 && nvm use 20`
      };
    }
    
    return { compatible: true, version, message: `Node.js ${version} OK` };
  } catch (e) {
    return { compatible: false, version: 'unknown', message: 'Node.js not found. Please install Node.js 20 LTS.' };
  }
}

export { checkNodeVersion };

// Get proper shell PATH for finding node, npm etc.
function getShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  
  if (IS_WINDOWS) return env;
  
  // Common paths where node/npm might be installed (macOS/Linux)
  const additionalPaths = [
    path.join(HOME, '.nvm/versions/node'),
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
        const latestVersion = versions.sort().reverse()[0];
        additionalPaths.unshift(path.join(nvmDir, latestVersion, 'bin'));
      }
    } catch (e) {
      log.warn('Could not read nvm versions:', e);
    }
  }
  
  const currentPath = env.PATH || '';
  env.PATH = [...additionalPaths, ...currentPath.split(':')].join(':');
  
  return env;
}

const shellEnv = getShellEnv();

export type PC2Status = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'not-installed';
export type PC2Environment = 'default' | 'dev' | 'custom';

// Environment configurations
const BASE_HOME = IS_WINDOWS ? WSL_HOME : HOME;
const ENVIRONMENTS: Record<string, { dir: string; nodeDir: string; wslDir: string; wslNodeDir: string; label: string }> = {
  'default': {
    dir: IS_WINDOWS ? path.join(HOME, '.pc2') : path.join(HOME, '.pc2'),
    nodeDir: IS_WINDOWS ? path.join(HOME, '.pc2', 'pc2-node') : path.join(HOME, '.pc2', 'pc2-node'),
    wslDir: `${BASE_HOME}/.pc2`,
    wslNodeDir: `${BASE_HOME}/.pc2/pc2-node`,
    label: 'Default (~/.pc2)'
  },
  'dev': {
    dir: IS_WINDOWS ? path.join(HOME, 'pc2.net') : path.join(HOME, 'pc2.net'),
    nodeDir: IS_WINDOWS ? path.join(HOME, 'pc2.net', 'pc2-node') : path.join(HOME, 'pc2.net', 'pc2-node'),
    wslDir: `${BASE_HOME}/pc2.net`,
    wslNodeDir: `${BASE_HOME}/pc2.net/pc2-node`,
    label: 'Development (~/pc2.net)'
  },
  'custom': {
    dir: '',
    nodeDir: '',
    wslDir: '',
    wslNodeDir: '',
    label: 'Custom Location'
  }
};

function getWSLNodeDir(): string {
  return ENVIRONMENTS[currentEnv].wslNodeDir;
}

function getWSLDir(): string {
  return ENVIRONMENTS[currentEnv].wslDir;
}

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
  
  // Add to buffer
  logBuffer.push(logMessage);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }
  
  logListeners.forEach(cb => cb(logMessage));
}

export async function isInstalled(): Promise<boolean> {
  if (IS_WINDOWS) {
    return new Promise((resolve) => {
      const wslNodeDir = getWSLNodeDir();
      exec(`wsl test -f "${wslNodeDir}/dist/index.js" && echo "yes" || echo "no"`, (error, stdout) => {
        resolve(stdout.trim() === 'yes');
      });
    });
  }
  
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
    // Server not responding
  }

  // Check if we have a tracked process running
  if (pc2Process && !pc2Process.killed) {
    return 'starting'; // Process exists but health check failed = still starting
  }

  return 'stopped';
}

export async function startPC2(): Promise<void> {
  const installed = await isInstalled();
  const nodeDir = IS_WINDOWS ? getWSLNodeDir() : getPC2NodeDir();
  
  if (!installed) {
    emitStatus('not-installed');
    emitLog('PC2 is not installed. Please install first.');
    return;
  }

  // Check if already running
  if (pc2Process && !pc2Process.killed) {
    emitLog('PC2 is already running');
    return;
  }

  emitStatus('starting');
  emitLog(`Starting PC2 from ${nodeDir}...`);

  return new Promise((resolve, reject) => {
    const nodePath = findNodePath();
    const distPath = path.join(getPC2NodeDir(), 'dist', 'index.js');
    
    emitLog(`Using node: ${nodePath}`);
    emitLog(`Starting: ${distPath}`);
    
    if (IS_WINDOWS) {
      // Run node inside WSL
      const cmd = wslCmd(`cd "${nodeDir}" && node dist/index.js`);
      pc2Process = spawn(cmd, [], { 
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else {
      pc2Process = spawn(nodePath, ['dist/index.js'], {
        cwd: getPC2NodeDir(),
        env: shellEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    pc2Process.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter((l: string) => l.trim());
      lines.forEach((line: string) => emitLog(line));
    });

    pc2Process.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter((l: string) => l.trim());
      lines.forEach((line: string) => emitLog(`[stderr] ${line}`));
    });

    pc2Process.on('error', (error) => {
      emitStatus('error');
      emitLog(`Failed to start PC2: ${error.message}`);
      pc2Process = null;
      reject(error);
    });

    pc2Process.on('exit', (code, signal) => {
      if (code !== null) {
        emitLog(`PC2 exited with code ${code}`);
      } else if (signal) {
        emitLog(`PC2 was killed with signal ${signal}`);
      }
      pc2Process = null;
      emitStatus('stopped');
    });

    // Wait for server to be ready
    emitLog('Process spawned, waiting for server to be ready...');
    waitForServer().then(() => {
      emitStatus('running');
      emitLog('PC2 is now running!');
      resolve();
    }).catch((err) => {
      emitStatus('error');
      emitLog('Failed to start: ' + err.message);
      // Kill the process if it didn't start properly
      if (pc2Process && !pc2Process.killed) {
        pc2Process.kill();
        pc2Process = null;
      }
      reject(err);
    });
  });
}

export async function stopPC2(): Promise<void> {
  emitStatus('stopping');
  emitLog('Stopping PC2...');

  return new Promise((resolve) => {
    if (pc2Process && !pc2Process.killed) {
      pc2Process.kill('SIGTERM');
      
      // Give it a moment to shut down gracefully
      setTimeout(() => {
        if (pc2Process && !pc2Process.killed) {
          emitLog('Force killing PC2...');
          pc2Process.kill('SIGKILL');
        }
        pc2Process = null;
        emitStatus('stopped');
        emitLog('PC2 stopped');
        resolve();
      }, 3000);
    } else {
      // No tracked process, but maybe something is running on the port
      // Try to kill any node process on port 4200
      if (IS_WINDOWS) {
        exec(wslCmd('fuser -k 4200/tcp 2>/dev/null || true'), () => {
          emitStatus('stopped');
          emitLog('PC2 stopped');
          resolve();
        });
      } else {
        exec('lsof -ti:4200 | xargs kill -9 2>/dev/null || true', { env: shellEnv }, () => {
          emitStatus('stopped');
          emitLog('PC2 stopped');
          resolve();
        });
      }
    }
  });
}

export async function restartPC2(): Promise<void> {
  emitStatus('starting');
  emitLog('Restarting PC2...');

  await stopPC2();
  await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause
  await startPC2();
}

export async function getLogs(lines: number = 100): Promise<string> {
  // Return logs from our buffer
  const recentLogs = logBuffer.slice(-lines);
  return recentLogs.join('\n');
}

export async function installPC2(onProgress: (message: string) => void): Promise<void> {
  const pc2Dir = IS_WINDOWS ? getWSLDir() : getPC2Dir();
  const nodeDir = IS_WINDOWS ? getWSLNodeDir() : getPC2NodeDir();
  
  emitLog(`Installing PC2 to ${pc2Dir}...`);
  onProgress('Checking Node.js version...');

  // Check Node.js version compatibility
  const nodeCheck = checkNodeVersion();
  emitLog(nodeCheck.message);
  
  if (!nodeCheck.compatible) {
    onProgress('Installing Node.js 20 via nvm...');
    emitLog('Node.js version incompatible, attempting to install Node 20 via nvm...');
    
    // Try to install Node 20 via nvm
    const nvmDir = path.join(HOME, '.nvm');
    const hasNvm = fs.existsSync(nvmDir);
    
    if (!hasNvm && !IS_WINDOWS) {
      // Install nvm first
      emitLog('Installing nvm...');
      await new Promise<void>((resolve, reject) => {
        exec('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash', 
          { maxBuffer: 10 * 1024 * 1024 }, 
          (error) => {
            if (error) {
              emitLog(`Warning: Could not install nvm: ${error.message}`);
            }
            resolve();
          }
        );
      });
    }
    
    // Install Node 20 via nvm
    if (fs.existsSync(path.join(HOME, '.nvm')) || IS_WINDOWS) {
      emitLog('Installing Node.js 20 LTS via nvm...');
      const nvmInstallCmd = IS_WINDOWS 
        ? wslCmd('source ~/.nvm/nvm.sh && nvm install 20 && nvm alias default 20')
        : 'source ~/.nvm/nvm.sh && nvm install 20 && nvm alias default 20';
      
      await new Promise<void>((resolve) => {
        exec(nvmInstallCmd, { shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            emitLog(`Warning: Could not install Node 20: ${error.message}`);
            emitLog('Please manually install Node.js 20 LTS: nvm install 20 && nvm use 20');
          } else {
            emitLog('Node.js 20 LTS installed successfully');
          }
          resolve();
        });
      });
      
      // Verify installation
      const recheck = checkNodeVersion();
      if (!recheck.compatible) {
        throw new Error(`Node.js version still incompatible after install attempt. ${recheck.message}`);
      }
    } else {
      throw new Error('Node.js version incompatible and could not install nvm. Please manually install Node.js 20 LTS.');
    }
  }

  onProgress('Preparing installation...');

  // Check if directory exists
  if (IS_WINDOWS) {
    const checkCmd = `wsl test -d "${pc2Dir}" && echo "exists" || echo "no"`;
    const exists = await new Promise<boolean>((resolve) => {
      exec(checkCmd, (error, stdout) => resolve(stdout.trim() === 'exists'));
    });
    
    if (exists) {
      const hasPackageJson = await new Promise<boolean>((resolve) => {
        exec(`wsl test -f "${pc2Dir}/package.json" && echo "yes" || echo "no"`, (error, stdout) => {
          resolve(stdout.trim() === 'yes');
        });
      });
      
      if (!hasPackageJson) {
        const backupDir = `${pc2Dir}_backup_${Date.now()}`;
        emitLog(`Backing up existing ${pc2Dir} to ${backupDir}`);
        await new Promise<void>((resolve) => {
          exec(`wsl mv "${pc2Dir}" "${backupDir}"`, () => resolve());
        });
      }
    }
  } else {
    if (fs.existsSync(getPC2Dir())) {
      const hasPackageJson = fs.existsSync(path.join(getPC2Dir(), 'package.json'));
      if (!hasPackageJson) {
        const backupDir = `${getPC2Dir()}_backup_${Date.now()}`;
        emitLog(`Backing up existing ${getPC2Dir()} to ${backupDir}`);
        fs.renameSync(getPC2Dir(), backupDir);
      }
    }
  }

  onProgress('Cloning repository...');

  // Build commands
  const steps = IS_WINDOWS ? [
    { cmd: wslCmd(`git clone https://github.com/Elacity/pc2.net "${pc2Dir}"`), msg: 'Cloning repository...' },
    { cmd: wslCmd(`cd "${pc2Dir}" && npm install --legacy-peer-deps --ignore-scripts`), msg: 'Installing dependencies...' },
    { cmd: wslCmd(`cd "${nodeDir}" && npm install --legacy-peer-deps`), msg: 'Installing node dependencies...' },
    { cmd: wslCmd(`cd "${nodeDir}" && npm run build`), msg: 'Building PC2...' },
  ] : [
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
  const pc2Dir = IS_WINDOWS ? getWSLDir() : getPC2Dir();
  
  // Safety check
  if (!pc2Dir.includes('.pc2') && !pc2Dir.includes('pc2.net')) {
    throw new Error('Safety check failed: refusing to delete this path');
  }
  
  // Stop PC2 first if running
  const status = await getStatus();
  if (status === 'running') {
    await stopPC2();
  }
  
  emitLog(`Uninstalling PC2 from ${pc2Dir}...`);
  
  if (IS_WINDOWS) {
    await new Promise<void>((resolve) => {
      exec(`wsl rm -rf "${pc2Dir}"`, () => {
        emitLog('PC2 uninstalled successfully');
        resolve();
      });
    });
  } else {
    if (fs.existsSync(pc2Dir)) {
      fs.rmSync(pc2Dir, { recursive: true, force: true });
      emitLog('PC2 uninstalled successfully');
    }
  }
  
  emitStatus('not-installed');
}

export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
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
