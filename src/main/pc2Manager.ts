import { spawn, exec, execSync, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import log from 'electron-log';

const HOME = os.homedir();
const PC2_URL = 'http://localhost:4200';
const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_ARM = process.arch === 'arm64';

// Node.js 22 LTS download URLs (Active LTS with best compatibility)
// jsdom@27 requires >=20.19.0 or ^22.12.0, so using Node 22 LTS
const NODE_VERSION = '22.13.1';
const NODE_URLS: Record<string, string> = {
  'darwin-arm64': `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
  'darwin-x64': `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
  'linux-x64': `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`,
  'linux-arm64': `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz`,
  'win32-x64': `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
};

// Where we store our bundled Node.js (separate from .pc2 to avoid backup issues)
const BUNDLED_NODE_DIR = path.join(HOME, '.elastos', 'node');

// Store the running PC2 process
let pc2Process: ChildProcess | null = null;
let logBuffer: string[] = [];
const MAX_LOG_LINES = 500;

// Check if git is available on the system (critical for Windows where git may not be pre-installed)
function isGitAvailable(): boolean {
  try {
    execSync('git --version', { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if a pre-built PC2 bundle is included in the packaged Electron app (Windows only).
// When built via CI, electron-builder's extraResources places the pre-compiled PC2
// at process.resourcesPath/pc2-bundle/ so users don't need git or build tools.
function getBundledPC2Path(): string | null {
  try {
    const bundlePath = path.join(process.resourcesPath, 'pc2-bundle');
    if (fs.existsSync(path.join(bundlePath, 'dist', 'index.js'))) {
      return bundlePath;
    }
  } catch {
    // process.resourcesPath may not exist in dev mode
  }
  return null;
}

// Recursively copy a directory tree from src to dest
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Get the path to our bundled Node.js binary
// Windows Node.js zip extracts to node-v22.13.1-win-x64/ with node.exe at root (no bin/ subfolder)
// macOS/Linux tar.gz extracts to node-v22.13.1-<platform>-<arch>/bin/node
function getBundledNodePath(): string {
  if (IS_WINDOWS) {
    return path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}-win-x64`, 'node.exe');
  }
  return path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}-${process.platform}-${process.arch}`, 'bin', 'node');
}

// Get the directory containing the bundled Node.js binary (used for PATH)
function getBundledNodeBinDir(): string {
  if (IS_WINDOWS) {
    return path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}-win-x64`);
  }
  return path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}-${process.platform}-${process.arch}`, 'bin');
}

// Check if we have our bundled Node.js installed
function hasBundledNode(): boolean {
  const nodePath = getBundledNodePath();
  return fs.existsSync(nodePath);
}

// Download a file with progress
async function downloadFile(url: string, dest: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(redirectUrl, dest, onProgress).then(resolve).catch(reject);
          return;
        }
      }
      
      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.round((downloadedBytes / totalBytes) * 100));
        }
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {}); // Delete the file on error
      reject(err);
    });
  });
}

// Download and extract Node.js for the current platform
async function downloadBundledNode(onProgress: (message: string) => void): Promise<void> {
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}-${arch}`;
  
  const url = NODE_URLS[key];
  if (!url) {
    throw new Error(`No Node.js binary available for ${key}. Please install Node.js ${NODE_VERSION} manually.`);
  }
  
  // Create directory
  if (!fs.existsSync(BUNDLED_NODE_DIR)) {
    fs.mkdirSync(BUNDLED_NODE_DIR, { recursive: true });
  }
  
  const isZip = url.endsWith('.zip');
  const archiveExt = isZip ? '.zip' : '.tar.gz';
  const archivePath = path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}${archiveExt}`);
  
  onProgress(`Downloading Node.js ${NODE_VERSION}...`);
  log.info(`Downloading Node.js from ${url}`);
  
  await downloadFile(url, archivePath, (percent) => {
    onProgress(`Downloading Node.js ${NODE_VERSION}... ${percent}%`);
  });
  
  onProgress('Extracting Node.js...');
  log.info('Extracting Node.js...');
  
  // Extract the archive
  await new Promise<void>((resolve, reject) => {
    let extractCmd: string;
    
    if (isZip) {
      // Windows: Use PowerShell Expand-Archive for .zip files
      extractCmd = `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${BUNDLED_NODE_DIR}' -Force"`;
    } else {
      // macOS/Linux: Use tar for .tar.gz files
      extractCmd = `tar -xzf "${archivePath}" -C "${BUNDLED_NODE_DIR}"`;
    }
    
    exec(extractCmd, (error) => {
      if (error) {
        reject(error);
      } else {
        // Clean up archive
        fs.unlinkSync(archivePath);
        resolve();
      }
    });
  });
  
  log.info(`Node.js ${NODE_VERSION} installed to ${BUNDLED_NODE_DIR}`);
}

// Find node executable - ALWAYS prefer our bundled Node.js
function findNodePath(): string {
  // First check for our bundled Node.js (guaranteed compatible)
  const bundledNode = getBundledNodePath();
  if (fs.existsSync(bundledNode)) {
    log.info(`Using bundled Node.js: ${bundledNode}`);
    return bundledNode;
  }
  
  if (IS_WINDOWS) {
    // On Windows, check common Node.js installation paths
    const possiblePaths = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    ];
    
    for (const nodePath of possiblePaths) {
      if (nodePath && fs.existsSync(nodePath)) {
        log.warn(`Using system Node.js: ${nodePath} - may have compatibility issues`);
        return nodePath;
      }
    }
    
    // On Windows, 'node' on PATH will work if Node.js is installed
    return 'node';
  }
  
  // Fallback: Check nvm for v20.x (macOS/Linux only)
  const nvmDir = path.join(HOME, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      const v20Versions = versions.filter(v => v.startsWith('v20')).sort().reverse();
      
      for (const version of v20Versions) {
        const nvmNode = path.join(nvmDir, version, 'bin', 'node');
        if (fs.existsSync(nvmNode)) {
          log.info(`Using nvm Node.js ${version}`);
          return nvmNode;
        }
      }
    } catch (e) {
      log.warn('Could not read nvm versions:', e);
    }
  }
  
  // Last resort: system node (may have compatibility issues)
  const possiblePaths = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ];
  
  for (const nodePath of possiblePaths) {
    if (fs.existsSync(nodePath)) {
      log.warn(`Using system Node.js: ${nodePath} - may have compatibility issues`);
      return nodePath;
    }
  }
  
  return 'node';
}

// Get npm path (relative to our node)
// On Windows, npm is a .cmd file; on macOS/Linux it's a shell script
function findNpmPath(): string {
  const bundledNode = getBundledNodePath();
  if (fs.existsSync(bundledNode)) {
    const npmName = IS_WINDOWS ? 'npm.cmd' : 'npm';
    const npmPath = path.join(path.dirname(bundledNode), npmName);
    if (fs.existsSync(npmPath)) {
      return npmPath;
    }
  }
  return IS_WINDOWS ? 'npm.cmd' : 'npm';
}

export { hasBundledNode, downloadBundledNode };

// Get proper shell PATH for finding node, npm etc.
function getShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  
  // Prioritize our bundled Node.js in PATH
  const bundledBinDir = getBundledNodeBinDir();
  const pathSeparator = IS_WINDOWS ? ';' : ':';
  
  if (IS_WINDOWS) {
    // On Windows, prepend bundled Node.js to PATH
    const currentPath = env.PATH || '';
    env.PATH = bundledBinDir + pathSeparator + currentPath;
    return env;
  }
  
  // Common paths where node/npm might be installed (macOS/Linux)
  const additionalPaths = [
    bundledBinDir,  // Our bundled Node first!
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
  env.PATH = [...additionalPaths, ...currentPath.split(pathSeparator)].join(pathSeparator);
  
  return env;
}

const shellEnv = getShellEnv();

export type PC2Status = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'not-installed';
export type PC2Environment = 'default' | 'dev' | 'custom';

// Environment configurations - all paths are native OS paths (no WSL)
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
  
  // Add to buffer
  logBuffer.push(logMessage);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }
  
  logListeners.forEach(cb => cb(logMessage));
}

export async function isInstalled(): Promise<boolean> {
  // Use native fs for all platforms (no WSL needed)
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
  const nodeDir = getPC2NodeDir();
  
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
    const distPath = path.join(nodeDir, 'dist', 'index.js');
    
    emitLog(`Using node: ${nodePath}`);
    emitLog(`Starting: ${distPath}`);
    
    // Native spawn for all platforms (no WSL)
    pc2Process = spawn(nodePath, ['dist/index.js'], {
      cwd: nodeDir,
      env: shellEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // shell: true needed on Windows for .exe resolution when using PATH
      ...(IS_WINDOWS ? { shell: true } : {}),
    });

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
      // Try to kill any process on port 4200
      if (IS_WINDOWS) {
        // Windows: Use netstat to find PID on port 4200, then taskkill
        exec('for /f "tokens=5" %a in (\'netstat -ano ^| findstr :4200 ^| findstr LISTENING\') do taskkill /F /PID %a 2>nul', { shell: 'cmd.exe' }, () => {
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
  const pc2Dir = getPC2Dir();
  const nodeDir = getPC2NodeDir();
  
  emitLog(`Installing PC2 to ${pc2Dir}...`);
  
  // On Windows, check if we have a pre-built PC2 bundle from the packaged app.
  // This enables a true download-and-run experience: no git, no build tools, no npm needed.
  const bundlePath = getBundledPC2Path();
  if (IS_WINDOWS && bundlePath) {
    await installFromBundle(bundlePath, pc2Dir, nodeDir, onProgress);
    return;
  }
  
  // Fallback: Clone from source and build (macOS/Linux, or Windows dev mode without bundle)
  await installFromSource(pc2Dir, nodeDir, onProgress);
}

// Install PC2 by copying the pre-built bundle from the packaged Electron app.
// Used on Windows when the .exe includes the pre-compiled PC2 via extraResources.
async function installFromBundle(
  bundlePath: string,
  pc2Dir: string,
  nodeDir: string,
  onProgress: (message: string) => void,
): Promise<void> {
  emitLog(`Installing from bundled PC2 at ${bundlePath}...`);
  
  // Step 1: Ensure we have our bundled Node.js (still needed to run PC2)
  if (!hasBundledNode()) {
    onProgress(`Downloading Node.js ${NODE_VERSION} LTS...`);
    emitLog(`Downloading bundled Node.js ${NODE_VERSION} LTS for compatibility...`);
    
    try {
      await downloadBundledNode(onProgress);
      emitLog(`Node.js ${NODE_VERSION} ready`);
    } catch (error: any) {
      emitLog(`Warning: Could not download bundled Node.js: ${error.message}`);
      emitLog('Will try to use system Node.js...');
    }
  }
  
  onProgress('Preparing installation...');
  
  // Back up existing directory if it's not a valid PC2 install
  if (fs.existsSync(pc2Dir)) {
    const hasPackageJson = fs.existsSync(path.join(pc2Dir, 'package.json'));
    if (!hasPackageJson) {
      const backupDir = `${pc2Dir}_backup_${Date.now()}`;
      emitLog(`Backing up existing ${pc2Dir} to ${backupDir}`);
      fs.renameSync(pc2Dir, backupDir);
    }
  }
  
  // Create the target directories
  fs.mkdirSync(nodeDir, { recursive: true });
  
  // Step 2: Copy pre-built dist/ to ~/.pc2/pc2-node/dist/
  onProgress('Installing PC2 backend...');
  emitLog('Copying pre-built backend...');
  copyDirRecursive(path.join(bundlePath, 'dist'), path.join(nodeDir, 'dist'));
  
  // Step 3: Copy pre-built frontend/ to ~/.pc2/pc2-node/frontend/
  onProgress('Installing PC2 frontend...');
  emitLog('Copying pre-built frontend...');
  const frontendSrc = path.join(bundlePath, 'frontend');
  if (fs.existsSync(frontendSrc)) {
    copyDirRecursive(frontendSrc, path.join(nodeDir, 'frontend'));
  }
  
  // Step 4: Copy node_modules/ (pre-compiled native modules included)
  onProgress('Installing dependencies (pre-compiled)...');
  emitLog('Copying pre-compiled node_modules...');
  copyDirRecursive(path.join(bundlePath, 'node_modules'), path.join(nodeDir, 'node_modules'));
  
  // Step 5: Copy package.json
  const pkgSrc = path.join(bundlePath, 'package.json');
  if (fs.existsSync(pkgSrc)) {
    fs.copyFileSync(pkgSrc, path.join(nodeDir, 'package.json'));
  }
  
  // Step 6: Copy config/ to ~/.pc2/config/
  onProgress('Installing configuration...');
  emitLog('Copying configuration...');
  const configSrc = path.join(bundlePath, 'config');
  if (fs.existsSync(configSrc)) {
    const configDest = path.join(pc2Dir, 'config');
    copyDirRecursive(configSrc, configDest);
  }
  
  emitLog('Installation complete! (from pre-built bundle)');
  onProgress('Installation complete!');
}

// Install PC2 by cloning from source and building.
// Used on macOS/Linux and as a fallback on Windows when no bundle is available (dev mode).
async function installFromSource(
  pc2Dir: string,
  nodeDir: string,
  onProgress: (message: string) => void,
): Promise<void> {
  // Step 0: Check git is available (critical on Windows where it may not be pre-installed)
  if (!isGitAvailable()) {
    const gitMsg = IS_WINDOWS
      ? 'Git is not installed. Please download and install Git from https://git-scm.com/download/win then restart the launcher.'
      : 'Git is not installed. Please install git and try again.';
    emitLog(gitMsg);
    throw new Error(gitMsg);
  }
  
  // Step 1: Ensure we have our bundled Node.js (guaranteed compatible)
  if (!hasBundledNode()) {
    onProgress(`Downloading Node.js ${NODE_VERSION} LTS...`);
    emitLog(`Downloading bundled Node.js ${NODE_VERSION} LTS for compatibility...`);
    
    try {
      await downloadBundledNode(onProgress);
      emitLog(`Node.js ${NODE_VERSION} ready`);
    } catch (error: any) {
      emitLog(`Warning: Could not download bundled Node.js: ${error.message}`);
      emitLog('Will try to use system Node.js...');
    }
  }
  
  const nodePath = findNodePath();
  const npmPath = findNpmPath();
  emitLog(`Using Node.js: ${nodePath}`);
  emitLog(`Using npm: ${npmPath}`);

  onProgress('Preparing installation...');

  // Check if directory exists and back up if it's not a valid PC2 install
  if (fs.existsSync(pc2Dir)) {
    const hasPackageJson = fs.existsSync(path.join(pc2Dir, 'package.json'));
    if (!hasPackageJson) {
      const backupDir = `${pc2Dir}_backup_${Date.now()}`;
      emitLog(`Backing up existing ${pc2Dir} to ${backupDir}`);
      fs.renameSync(pc2Dir, backupDir);
    }
  }

  onProgress('Cloning repository...');

  // Build commands - use our bundled npm for guaranteed compatibility
  const npmCmd = `"${npmPath}"`;
  
  const steps = [
    { cmd: `git clone https://github.com/Elacity/pc2.net "${pc2Dir}"`, msg: 'Cloning repository...' },
    { cmd: `cd "${pc2Dir}" && ${npmCmd} install --legacy-peer-deps --ignore-scripts`, msg: 'Installing dependencies...' },
    { cmd: `cd "${nodeDir}" && ${npmCmd} install --legacy-peer-deps`, msg: 'Installing node dependencies...' },
    { cmd: `cd "${nodeDir}" && ${npmCmd} run build`, msg: 'Building PC2...' },
  ];

  for (const step of steps) {
    onProgress(step.msg);
    emitLog(step.msg);
    
    await new Promise<void>((resolve, reject) => {
      exec(step.cmd, { maxBuffer: 10 * 1024 * 1024, env: shellEnv, shell: IS_WINDOWS ? 'cmd.exe' : '/bin/sh' }, (error, stdout, stderr) => {
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
  
  // Use native fs for all platforms (no WSL)
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
