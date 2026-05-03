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
};

// Where we store our bundled Node.js (separate from .pc2 to avoid backup issues)
const BUNDLED_NODE_DIR = path.join(HOME, '.elastos', 'node');

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

// Get the path to our bundled Node.js binary
function getBundledNodePath(): string {
  const platform = IS_WINDOWS ? 'win32' : process.platform;
  const arch = process.arch;
  const nodeBin = IS_WINDOWS ? 'node.exe' : 'node';
  return path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}-${platform}-${arch}`, 'bin', nodeBin);
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
    throw new Error(`No Node.js binary available for ${key}. Please install Node.js 20 manually.`);
  }
  
  // Create directory
  if (!fs.existsSync(BUNDLED_NODE_DIR)) {
    fs.mkdirSync(BUNDLED_NODE_DIR, { recursive: true });
  }
  
  const tarPath = path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}.tar.gz`);
  
  onProgress(`Downloading Node.js ${NODE_VERSION}...`);
  log.info(`Downloading Node.js from ${url}`);
  
  await downloadFile(url, tarPath, (percent) => {
    onProgress(`Downloading Node.js ${NODE_VERSION}... ${percent}%`);
  });
  
  onProgress('Extracting Node.js...');
  log.info('Extracting Node.js...');
  
  // Extract the tarball
  await new Promise<void>((resolve, reject) => {
    exec(`tar -xzf "${tarPath}" -C "${BUNDLED_NODE_DIR}"`, (error) => {
      if (error) {
        reject(error);
      } else {
        // Clean up tarball
        fs.unlinkSync(tarPath);
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
  
  // Fallback: Check nvm for v20.x
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
function findNpmPath(): string {
  const bundledNode = getBundledNodePath();
  if (fs.existsSync(bundledNode)) {
    const npmPath = path.join(path.dirname(bundledNode), 'npm');
    if (fs.existsSync(npmPath)) {
      return npmPath;
    }
  }
  return 'npm';
}

export { hasBundledNode, downloadBundledNode };

// Get proper shell PATH for finding node, npm etc.
function getShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  
  if (IS_WINDOWS) return env;
  
  // Common paths where node/npm might be installed (macOS/Linux)
  // Prioritize our bundled Node.js
  const bundledBinDir = path.join(BUNDLED_NODE_DIR, `node-v${NODE_VERSION}-${process.platform}-${process.arch}`, 'bin');
  
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

// ─────────────────────────────────────────────────────────────────────
// SQLite-adapter probe (v1.2.6+)
//
// pc2-node v1.2.7 replaced `better-sqlite3` (V8-ABI-specific, requires
// per-Node-major prebuild OR Xcode CLT to compile) with
// `@photostructure/sqlite` (Node-API based, single prebuild bundled
// inside the npm tarball, works across Node majors with no compiler).
// pc2-node v1.2.6 and earlier still use `better-sqlite3`.
//
// The launcher must support BOTH (operator might update the launcher
// before pc2.net, or roll back pc2.net to a pre-v1.2.7 release). We
// detect which adapter is present by reading pc2-node's package.json
// and build the right load-probe accordingly. If neither shows up
// (corrupt install / missing package.json), we return null and the
// caller falls back to a generic "node modules broken" error.
// ─────────────────────────────────────────────────────────────────────
export interface SqliteProbe {
  readonly moduleName: string;
  /** A Node `-e` script body that throws on failure to load. */
  readonly loadCheckScript: string;
  /** Human-readable hint shown to the user if the probe fails. */
  readonly fixHint: string;
}

export function detectSqliteAdapter(pc2NodeDir: string): SqliteProbe | null {
  try {
    const pkgPath = path.join(pc2NodeDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return null;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps: Record<string, string> = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    // Prefer @photostructure/sqlite when both are listed (it's the v1.2.7+
    // adapter; better-sqlite3 may linger in lockfile during transition).
    if (deps['@photostructure/sqlite']) {
      return {
        moduleName: '@photostructure/sqlite',
        loadCheckScript:
          "const { DatabaseSync } = require('@photostructure/sqlite'); " +
          "new DatabaseSync(':memory:').exec('SELECT 1');",
        // @photostructure/sqlite ships prebuilds for darwin-arm64, darwin-x64,
        // linux-x64, linux-arm64 (glibc + musl), win32-x64, win32-arm64 inside
        // the npm tarball. If the prebuild somehow doesn't load, the most
        // likely cause is a corrupt node_modules — full reinstall is the cure.
        fixHint:
          "Reinstall pc2.net: cd ~/.pc2 && rm -rf node_modules pc2-node/node_modules, " +
          "then click Update in the launcher.",
      };
    }
    if (deps['better-sqlite3']) {
      return {
        moduleName: 'better-sqlite3',
        loadCheckScript:
          "require('better-sqlite3')(':memory:').prepare('SELECT 1').get();",
        fixHint:
          "On macOS without Xcode Command Line Tools, install them with " +
          "`xcode-select --install`. Better long-term fix: update pc2.net to " +
          "v1.2.7 or later (uses @photostructure/sqlite, no compiler needed).",
      };
    }
    return null;
  } catch {
    return null;
  }
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

  // Defensive pre-flight check (v1.2.6): verify the SQLite native module
  // actually loads before we even try to spawn PC2. Without this, a half-
  // installed state from a previous failed install would let startPC2
  // happily spawn a doomed process (Sasha's Apr 30 2026 case — got a
  // cryptic NODE_MODULE_VERSION 115 vs 127 crash because better-sqlite3's
  // .node binary was for a different Node ABI than the bundled Node).
  //
  // v1.2.6 of the launcher is adapter-aware: probes whichever SQLite
  // binding pc2-node's package.json declares (@photostructure/sqlite for
  // pc2.net v1.2.7+, better-sqlite3 for v1.2.6 and earlier).
  if (!IS_WINDOWS) {
    const nodePath = findNodePath();
    const sqliteProbe = detectSqliteAdapter(getPC2NodeDir());
    if (sqliteProbe) {
      const probe = `"${nodePath}" -e "${sqliteProbe.loadCheckScript.replace(/"/g, '\\"')}"`;
      const probeFailed = await new Promise<string | null>((resolve) => {
        exec(`cd "${getPC2NodeDir()}" && ${probe}`, { timeout: 5000, env: shellEnv }, (error, _stdout, stderr) => {
          if (error) {
            // Capture the most-relevant error line (usually mentions NODE_MODULE_VERSION
            // or "no such file or directory" for missing prebuild, or ERR_DLOPEN for
            // ABI mismatch on platforms with bundled prebuilds that didn't unpack).
            const errLine = (stderr || error.message).split('\n').find(l => /NODE_MODULE_VERSION|MODULE_NOT_FOUND|ERR_DLOPEN|no such file/.test(l));
            resolve(errLine || error.message.split('\n')[0]);
          } else {
            resolve(null);
          }
        });
      });
      if (probeFailed) {
        emitStatus('error');
        emitLog(`Cannot start PC2 — ${sqliteProbe.moduleName} failed to load: ${probeFailed}`);
        emitLog(`Hint: ${sqliteProbe.fixHint}`);
        emitLog('Or click "Update" / reinstall to repair the broken state.');
        throw new Error(`PC2 install is incomplete or corrupt (${sqliteProbe.moduleName}). Click Update to repair. (${probeFailed})`);
      }
    }
    // If sqliteProbe is null (no recognised SQLite dep in pc2-node/package.json),
    // skip pre-flight rather than fail. The actual PC2 boot will surface any
    // missing-deps error with full context, and a "no probe" state usually means
    // brand-new install hasn't finished — startPC2 will then spawn and emit
    // structured errors via stdout/stderr that we capture downstream.
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
      // No tracked process -- kill PC2 on port 4200 but exclude our own Electron process
      const selfPid = process.pid;
      if (IS_WINDOWS) {
        exec(wslCmd('fuser -k 4200/tcp 2>/dev/null || true'), () => {
          emitStatus('stopped');
          emitLog('PC2 stopped');
          resolve();
        });
      } else {
        exec(`lsof -ti:4200 2>/dev/null | grep -v "^${selfPid}$" | xargs kill -9 2>/dev/null || true`, { env: shellEnv }, () => {
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

function sudoExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (IS_MAC) {
      const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const osa = `osascript -e 'do shell script "${escaped}" with administrator privileges'`;
      exec(osa, { maxBuffer: 10 * 1024 * 1024, env: shellEnv }, (error, stdout, stderr) => {
        if (error) reject(error); else resolve({ stdout, stderr });
      });
    } else {
      exec(`sudo -n ${cmd} 2>/dev/null || pkexec ${cmd}`, { maxBuffer: 10 * 1024 * 1024, env: shellEnv }, (error, stdout, stderr) => {
        if (error) reject(error); else resolve({ stdout, stderr });
      });
    }
  });
}

function commandExists(bin: string): boolean {
  try {
    execSync(`which ${bin} 2>/dev/null`, { env: shellEnv });
    return true;
  } catch { return false; }
}

async function setupNetworking(pc2Dir: string, onProgress: (msg: string) => void): Promise<void> {
  const brewPrefix = IS_MAC ? (execSync('brew --prefix 2>/dev/null || echo /usr/local', { env: shellEnv }).toString().trim()) : '';
  const binDir = IS_MAC ? `${brewPrefix}/bin` : '/usr/local/bin';

  // WireGuard
  if (!commandExists('wg')) {
    onProgress('Installing WireGuard...');
    emitLog('Installing WireGuard tools...');
    try {
      if (IS_MAC) {
        exec('brew install wireguard-tools', { env: shellEnv }, () => {});
        await new Promise(r => setTimeout(r, 10000));
      } else {
        await sudoExec('apt-get install -y wireguard-tools');
      }
    } catch (e: any) { emitLog(`WireGuard install warning: ${e.message}`); }
  }

  // WireGuard sudoers
  const wgQuickPath = commandExists('wg-quick') ? execSync('which wg-quick', { env: shellEnv }).toString().trim() : '';
  if (wgQuickPath) {
    try {
      const user = os.userInfo().username;
      await sudoExec(`sh -c "echo '${user} ALL=(ALL) NOPASSWD: ${wgQuickPath}' > /etc/sudoers.d/wireguard && chmod 440 /etc/sudoers.d/wireguard"`);
      emitLog('WireGuard permissions configured');
    } catch (e: any) { emitLog(`WireGuard sudoers warning: ${e.message}`); }
  }

  // AmneziaWG
  if (!commandExists('amneziawg-go')) {
    onProgress('Building AmneziaWG stealth transport...');
    emitLog('Building amneziawg-go from source...');
    try {
      if (!commandExists('go')) {
        if (IS_MAC) {
          execSync('brew install go 2>&1', { env: shellEnv, timeout: 120000 });
        } else {
          await sudoExec('apt-get install -y golang-go');
        }
      }
      if (commandExists('go')) {
        const tmpDir = execSync('mktemp -d', { env: shellEnv }).toString().trim();
        execSync(`cd "${tmpDir}" && git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-go.git 2>&1 && cd amneziawg-go && make 2>&1`, { env: shellEnv, timeout: 180000 });
        if (IS_MAC) {
          execSync(`cp "${tmpDir}/amneziawg-go/amneziawg-go" "${binDir}/amneziawg-go" && chmod 755 "${binDir}/amneziawg-go"`, { env: shellEnv });
        } else {
          await sudoExec(`cp "${tmpDir}/amneziawg-go/amneziawg-go" "${binDir}/amneziawg-go" && chmod 755 "${binDir}/amneziawg-go"`);
        }
        execSync(`rm -rf "${tmpDir}"`, { env: shellEnv });
        emitLog('AmneziaWG binary installed');
      }
    } catch (e: any) { emitLog(`AmneziaWG build warning: ${e.message}`); }
  }

  // awg-quick + awg tools
  if (!commandExists('awg-quick')) {
    onProgress('Installing AmneziaWG tools...');
    emitLog('Building awg-quick from source...');
    try {
      const tmpDir = execSync('mktemp -d', { env: shellEnv }).toString().trim();
      const quickScript = IS_MAC ? 'darwin.bash' : 'linux.bash';
      execSync(`cd "${tmpDir}" && git clone --depth 1 https://github.com/amnezia-vpn/amnezia-wg-tools.git 2>&1 && cd amnezia-wg-tools/src && make 2>&1`, { env: shellEnv, timeout: 120000 });
      if (IS_MAC) {
        execSync(`cp "${tmpDir}/amnezia-wg-tools/src/wg" "${binDir}/awg" && cp "${tmpDir}/amnezia-wg-tools/src/wg-quick/${quickScript}" "${binDir}/awg-quick" && chmod 755 "${binDir}/awg" "${binDir}/awg-quick"`, { env: shellEnv });
      } else {
        await sudoExec(`cp "${tmpDir}/amnezia-wg-tools/src/wg" "${binDir}/awg" && cp "${tmpDir}/amnezia-wg-tools/src/wg-quick/${quickScript}" "${binDir}/awg-quick" && chmod 755 "${binDir}/awg" "${binDir}/awg-quick"`);
      }
      execSync(`rm -rf "${tmpDir}"`, { env: shellEnv });
      emitLog('AmneziaWG tools installed');
    } catch (e: any) { emitLog(`AmneziaWG tools warning: ${e.message}`); }
  }

  // Patch awg-quick
  if (commandExists('awg-quick')) {
    try {
      const awqPath = execSync('which awg-quick', { env: shellEnv }).toString().trim();
      const content = fs.readFileSync(awqPath, 'utf8');
      if (content.includes('/var/run/wireguard/$INTERFACE.name') || content.includes('cmd wg ')) {
        emitLog('Patching awg-quick (fixing upstream bugs)...');
        const sedFlag = IS_MAC ? "-i ''" : '-i.bak';
        await sudoExec(`sed ${sedFlag} -e 's|/var/run/wireguard/\\$INTERFACE\\.name|/var/run/amneziawg/\\$INTERFACE.name|g' -e 's|/var/run/wireguard/\\$REAL_INTERFACE\\.sock|/var/run/amneziawg/\\$REAL_INTERFACE.sock|g' -e 's|cmd wg setconf|cmd awg setconf|g' -e 's|cmd wg showconf|cmd awg showconf|g' -e 's|wg show interfaces|awg show interfaces|g' "${awqPath}" && rm -f "${awqPath}.bak" 2>/dev/null || true`);
        emitLog('awg-quick patched');
      }
    } catch (e: any) { emitLog(`awg-quick patch warning: ${e.message}`); }
  }

  // AmneziaWG sudoers
  if (commandExists('awg-quick')) {
    try {
      const user = os.userInfo().username;
      const awqPath = execSync('which awg-quick', { env: shellEnv }).toString().trim();
      const killallPath = commandExists('killall') ? execSync('which killall', { env: shellEnv }).toString().trim() : '/usr/bin/killall';
      await sudoExec(`sh -c "printf '${user} ALL=(ALL) NOPASSWD:SETENV: ${awqPath}\\n${user} ALL=(ALL) NOPASSWD: ${killallPath} amneziawg-go\\n${user} ALL=(ALL) NOPASSWD: /bin/rm -rf /var/run/amneziawg/\\n' > /etc/sudoers.d/amneziawg && chmod 440 /etc/sudoers.d/amneziawg"`);
      emitLog('AmneziaWG permissions configured');
    } catch (e: any) { emitLog(`AmneziaWG sudoers warning: ${e.message}`); }
  }

  // sing-box
  if (!commandExists('sing-box') && !fs.existsSync('/usr/local/bin/sing-box')) {
    onProgress('Installing sing-box (VLESS Reality)...');
    emitLog('Installing sing-box 1.13.0...');
    try {
      const sbVersion = '1.13.0';
      if (IS_MAC) {
        execSync('brew install sing-box 2>&1 || true', { env: shellEnv, timeout: 60000 });
        if (!commandExists('sing-box')) {
          const sbArch = IS_ARM ? 'arm64' : 'amd64';
          const tmpDir = execSync('mktemp -d', { env: shellEnv }).toString().trim();
          execSync(`curl -sL "https://github.com/SagerNet/sing-box/releases/download/v${sbVersion}/sing-box-${sbVersion}-darwin-${sbArch}.tar.gz" -o "${tmpDir}/sb.tar.gz" && cd "${tmpDir}" && tar -xzf sb.tar.gz && cp sing-box-*/sing-box /usr/local/bin/sing-box && chmod 755 /usr/local/bin/sing-box`, { env: shellEnv, timeout: 60000 });
          execSync(`rm -rf "${tmpDir}"`, { env: shellEnv });
        }
      } else {
        const sbArch = IS_ARM ? 'arm64' : 'amd64';
        const tmpDir = execSync('mktemp -d', { env: shellEnv }).toString().trim();
        execSync(`curl -sL "https://github.com/SagerNet/sing-box/releases/download/v${sbVersion}/sing-box-${sbVersion}-linux-${sbArch}.tar.gz" -o "${tmpDir}/sb.tar.gz" && cd "${tmpDir}" && tar -xzf sb.tar.gz`, { env: shellEnv, timeout: 60000 });
        await sudoExec(`cp "${tmpDir}"/sing-box-*/sing-box /usr/local/bin/sing-box && chmod 755 /usr/local/bin/sing-box`);
        execSync(`rm -rf "${tmpDir}"`, { env: shellEnv });
      }
      emitLog('sing-box installed');
    } catch (e: any) { emitLog(`sing-box install warning: ${e.message}`); }
  }

  // Particle auth .env
  const particleEnv = path.join(pc2Dir, 'packages', 'particle-auth', '.env');
  if (!fs.existsSync(particleEnv)) {
    onProgress('Configuring wallet integration...');
    try {
      const dir = path.dirname(particleEnv);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(particleEnv, `VITE_PARTICLE_PROJECT_ID=01cdbdd6-b07e-45b5-81ca-7036e45dff0d
VITE_PARTICLE_CLIENT_KEY=cMSSRMUCgciyuStuvPg2FSLKSovXDmrbvknJJnLU
VITE_PARTICLE_APP_ID=1567a90d-9ff3-459a-bca8-d264685482cb
VITE_WALLETCONNECT_PROJECT_ID=0d1ac2ba93587a74b54f92189bdc341e
VITE_PUTER_API_URL=http://localhost:4200
`);
      emitLog('Particle auth configured');
    } catch (e: any) { emitLog(`Particle auth warning: ${e.message}`); }
  }
}

export async function installPC2(onProgress: (message: string) => void): Promise<void> {
  const pc2Dir = IS_WINDOWS ? getWSLDir() : getPC2Dir();
  const nodeDir = IS_WINDOWS ? getWSLNodeDir() : getPC2NodeDir();
  
  emitLog(`Installing PC2 to ${pc2Dir}...`);
  
  // Step 1: Ensure we have our bundled Node.js (guaranteed compatible)
  if (!hasBundledNode() && !IS_WINDOWS) {
    onProgress('Downloading Node.js 20 LTS...');
    emitLog('Downloading bundled Node.js 20 LTS for compatibility...');
    
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
    // Smart "existing directory" handling (v1.2.6).
    //
    // Sasha hit this on Apr 30 2026: a previous install attempt failed
    // mid-way. ~/.pc2 was left half-populated (with a package.json from
    // the partial clone). When she clicked "Power On" again, installPC2
    // ran `git clone` which immediately failed with "destination path
    // already exists". The launcher's renderer then called startPC2
    // anyway, which spawned PC2 against the broken half-installed state,
    // crashing on better-sqlite3 ABI mismatch.
    //
    // Three states to handle:
    //   (a) doesn't exist  → normal fresh install (clone)
    //   (b) exists but no package.json → leftover junk → backup aside
    //   (c) exists with package.json from OUR repo → repair existing
    //       install (skip clone, run npm install + build to fix it)
    //   (d) exists with package.json from SOME OTHER repo → backup aside
    if (fs.existsSync(getPC2Dir())) {
      const packageJsonPath = path.join(getPC2Dir(), 'package.json');
      const hasPackageJson = fs.existsSync(packageJsonPath);

      // Detect whether the existing install is OUR pc2.net repo
      // (state c) or some other repo / corrupt state (state d).
      let isOurRepo = false;
      if (hasPackageJson) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          if (pkg.name === 'puter') {
            isOurRepo = true;
          }
        } catch {
          // Malformed package.json — treat as corrupt
        }
        // Also check for a .git pointing at our origin
        if (isOurRepo) {
          try {
            const gitConfig = fs.readFileSync(
              path.join(getPC2Dir(), '.git', 'config'),
              'utf8'
            );
            if (!gitConfig.includes('Elacity/pc2.net')) {
              isOurRepo = false;
            }
          } catch {
            // No .git config — partial clone or non-git copy. Treat as corrupt.
            isOurRepo = false;
          }
        }
      }

      if (isOurRepo) {
        emitLog(`Found existing PC2 install at ${getPC2Dir()} — running repair (will skip git clone)`);
      } else {
        const backupDir = `${getPC2Dir()}_backup_${Date.now()}`;
        emitLog(`Backing up unrecognized ${getPC2Dir()} to ${backupDir}`);
        fs.renameSync(getPC2Dir(), backupDir);
      }
    }
  }

  // Compute "should we skip clone?" — true if dir already exists and
  // contains our repo (the "repair" path from the smart-existing-dir
  // handler above). False otherwise (the normal fresh-install path).
  const shouldSkipClone = !IS_WINDOWS && fs.existsSync(path.join(getPC2Dir(), 'package.json'));

  onProgress(shouldSkipClone ? 'Repairing existing install...' : 'Cloning repository...');

  // Build commands - use our bundled npm for guaranteed compatibility
  const npmCmd = `"${npmPath}"`;
  const nodeCmd = `"${nodePath}"`;
  
  // Rebuild strategy (v1.2.6 launcher, supports both pc2.net v1.2.6 and v1.2.7+):
  //
  // pc2-node v1.2.7 replaced `better-sqlite3` (V8-ABI specific, prebuild-install
  // postinstall download, often required Xcode CLT on Mac when prebuilds for
  // the user's Node major didn't match) with `@photostructure/sqlite` (Node-API
  // based, single prebuild bundled inside the npm tarball, works across all
  // Node majors with no compiler step).
  //
  // For the launcher's install pipeline this means:
  //   - On pc2.net v1.2.7+: plain `npm install` is enough — the SQLite prebuild
  //     is unpacked from the tarball and works immediately. No Xcode CLT, no
  //     compile, no postinstall download. Genuinely zero-friction on Mac.
  //   - On pc2.net v1.2.6: better-sqlite3@^11.10.0 ships Node 22 darwin-arm64
  //     prebuilds; plain `npm install` works for that case too. The pre-v11
  //     `--build-from-source` path is gone.
  //
  // The verification gauntlet below adapts to whichever SQLite adapter
  // pc2-node's package.json declares (see `detectSqliteAdapter`). If a load
  // fails (corrupt extract, partial tarball, edge case), it retries via clean
  // reinstall before giving up with an actionable error.
  //
  // HUSKY=0 neutralises the `prepare` script so the root install never bombs
  // with "sh: husky: not found" on a fresh, dev-tools-free user box.
  const npmEnvPrefix = IS_WINDOWS ? '' : 'HUSKY=0 ';

  // For "repair" runs (existing install detected), do `git fetch + reset --hard`
  // instead of `git clone` to bring the existing tree to origin/main.
  const cloneOrRepair = shouldSkipClone
    ? `cd "${pc2Dir}" && git fetch origin && git reset --hard origin/main`
    : `git clone https://github.com/Elacity/pc2.net "${pc2Dir}"`;
  const cloneOrRepairMsg = shouldSkipClone
    ? 'Syncing existing install with latest release...'
    : 'Cloning repository...';

  const steps = IS_WINDOWS ? [
    { cmd: wslCmd(cloneOrRepair), msg: cloneOrRepairMsg },
    { cmd: wslCmd(`cd "${pc2Dir}" && HUSKY=0 npm install --legacy-peer-deps --ignore-scripts`), msg: 'Installing dependencies...' },
    { cmd: wslCmd(`cd "${nodeDir}" && HUSKY=0 npm install --legacy-peer-deps`), msg: 'Installing node dependencies...' },
    { cmd: wslCmd(`cd "${nodeDir}" && npm run build`), msg: 'Building PC2...' },
  ] : [
    { cmd: cloneOrRepair, msg: cloneOrRepairMsg },
    { cmd: `cd "${pc2Dir}" && ${npmEnvPrefix}${npmCmd} install --legacy-peer-deps --ignore-scripts`, msg: 'Installing dependencies...' },
    { cmd: `cd "${nodeDir}" && ${npmEnvPrefix}${npmCmd} install --legacy-peer-deps`, msg: 'Installing node dependencies...' },
    { cmd: `cd "${nodeDir}" && ${nodeCmd} -e "console.log('Native modules for Node ' + process.version + ' (MODULE_VERSION ' + process.versions.modules + ') — using prebuilds, no compiler needed')"`, msg: 'Verifying Node ABI...' },
    { cmd: `cd "${nodeDir}" && ${npmCmd} run build`, msg: 'Building PC2...' },
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

  // ──────────────────────────────────────────────────────────────────
  // Native module verification gauntlet (v1.2.5).
  //
  // After the build completes, verify both critical native modules
  // actually load. If either fails, attempt a clean reinstall (Ahmed's
  // Apr 30 2026 fix pattern — `npm rebuild` reuses install-time prebuild
  // metadata, only `rm -rf MOD && npm install MOD` queries fresh against
  // the current Node ABI). If THAT also fails, fail loudly with module-
  // specific fix instructions instead of letting PC2 crash-loop on boot.
  //
  // Without this: v1.2.4 silently shipped broken node-datachannel for
  // Sasha (cmake missing) and the install reported success.
  // ──────────────────────────────────────────────────────────────────
  await verifyNativeModules(nodeDir, nodeCmd, npmCmd, npmEnvPrefix, onProgress);

  // Install networking tools (WireGuard, AmneziaWG, sing-box)
  if (!IS_WINDOWS) {
    onProgress('Setting up networking...');
    try {
      await setupNetworking(pc2Dir, onProgress);
    } catch (e: any) {
      emitLog(`Networking setup warning: ${e.message}`);
      emitLog('PC2 will work but stealth transport may not be available');
    }
  }

  emitLog('Installation complete!');
  onProgress('Installation complete!');
}

/**
 * Verify that critical native modules actually load against the bundled Node.
 * Three-attempt gauntlet per module:
 *   1. Plain load (works for clean prebuild-install case).
 *   2. Clean reinstall (rm -rf node_modules/MOD && npm install MOD) —
 *      forces prebuild-install to query fresh against the current Node ABI.
 *   3. If still failing, throw with module-specific fix instructions.
 *
 * v1.2.6 (sqlite-adapter aware): the SQLite module is detected from
 * pc2-node's package.json — `@photostructure/sqlite` for pc2.net v1.2.7+
 * (Node-API, no compiler) or `better-sqlite3` for v1.2.6 and earlier
 * (V8-ABI, may need Xcode CLT on Mac). See `detectSqliteAdapter`.
 */
interface NativeModuleSpec {
  name: string;
  /** Inline JS payload for `node -e "..."` (must throw on failure). */
  loadCheckScript: string;
  /** Human-readable hint shown to the user if the module won't load. */
  fixHint: string;
}

async function verifyNativeModules(
  nodeDir: string,
  nodeCmd: string,
  npmCmd: string,
  npmEnvPrefix: string,
  onProgress: (m: string) => void
): Promise<void> {
  const modules: NativeModuleSpec[] = [];

  // Add whichever SQLite adapter pc2-node's package.json declares. If
  // package.json is missing or has neither, skip the SQLite check rather
  // than guess — the actual pc2 boot will surface a clearer error.
  const sqliteProbe = detectSqliteAdapter(nodeDir);
  if (sqliteProbe) {
    modules.push({
      name: sqliteProbe.moduleName,
      loadCheckScript: sqliteProbe.loadCheckScript,
      fixHint: sqliteProbe.fixHint,
    });
  } else {
    emitLog('⚠ Could not determine SQLite adapter from pc2-node/package.json — skipping SQLite verification');
  }

  // node-datachannel is consistent across pc2-node versions (NAPI module,
  // no V8-ABI version coupling). Probe is ESM-style (dynamic import).
  modules.push({
    name: 'node-datachannel',
    loadCheckScript:
      "import('node-datachannel').then(m => { if (!m) throw new Error('null'); }).catch(e => { console.error(e.message); process.exit(1); })",
    fixHint: 'Install cmake: brew install cmake (or apt-get install cmake on Linux)',
  });

  for (const mod of modules) {
    onProgress(`Verifying ${mod.name}...`);
    emitLog(`Verifying ${mod.name} loads against bundled Node...`);

    // Escape double-quotes in the inline script so it survives shell quoting.
    const loadProbe = `${nodeCmd} -e "${mod.loadCheckScript.replace(/"/g, '\\"')}"`;

    const tryLoad = (): Promise<boolean> =>
      new Promise((resolve) => {
        exec(`cd "${nodeDir}" && ${loadProbe}`, { maxBuffer: 1024 * 1024, env: shellEnv }, (err) => {
          resolve(!err);
        });
      });

    if (await tryLoad()) {
      emitLog(`✓ ${mod.name} verified`);
      continue;
    }

    emitLog(`⚠ ${mod.name} failed to load — attempting clean reinstall...`);
    onProgress(`Recovering ${mod.name} via clean reinstall...`);

    const reinstallCmd = IS_WINDOWS
      ? wslCmd(`cd "${nodeDir}" && rm -rf node_modules/${mod.name} && HUSKY=0 npm install ${mod.name} --legacy-peer-deps`)
      : `cd "${nodeDir}" && rm -rf node_modules/${mod.name} && ${npmEnvPrefix}${npmCmd} install ${mod.name} --legacy-peer-deps`;

    await new Promise<void>((resolve) => {
      exec(reinstallCmd, { maxBuffer: 10 * 1024 * 1024, env: shellEnv }, () => resolve());
    });

    if (await tryLoad()) {
      emitLog(`✓ ${mod.name} recovered via clean reinstall`);
      continue;
    }

    const errMsg = `${mod.name} failed to load even after clean reinstall. ${mod.fixHint}`;
    emitLog(`❌ ${errMsg}`);
    throw new Error(errMsg);
  }
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

export function getPC2Version(): string {
  const pkgPath = path.join(getPC2Dir(), 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'not installed';
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkForUpdate(): Promise<{ current: string; latest: string; updateAvailable: boolean; releaseUrl: string }> {
  const current = getPC2Version();
  const result = { current, latest: current, updateAvailable: false, releaseUrl: '' };

  if (current === 'not installed' || current === 'unknown') return result;

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/Elacity/pc2.net/releases/latest',
      headers: { 'User-Agent': 'elastos-launcher' }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latest = (release.tag_name || '').replace(/^v/, '');
          result.latest = latest;
          result.releaseUrl = release.html_url || '';
          result.updateAvailable = latest !== '' && compareVersions(latest, current) > 0;
        } catch (e) {
          log.warn('Failed to parse GitHub release:', e);
        }
        resolve(result);
      });
    }).on('error', (e) => {
      log.warn('Failed to check for updates:', e.message);
      resolve(result);
    });
  });
}

export async function updatePC2(onProgress: (msg: string) => void): Promise<void> {
  const pc2Dir = IS_WINDOWS ? getWSLDir() : getPC2Dir();
  const nodeDir = IS_WINDOWS ? getWSLNodeDir() : getPC2NodeDir();
  const nodePath = findNodePath();
  const npmPath = findNpmPath();
  const nodeCmd = `"${nodePath}"`;
  const npmCmd = `"${npmPath}"`;

  const wasRunning = pc2Process !== null && !pc2Process.killed;
  if (wasRunning) {
    onProgress('Stopping PC2...');
    emitLog('Stopping PC2 for update...');
    pc2Process!.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 3000));
    if (pc2Process && !pc2Process.killed) {
      pc2Process.kill('SIGKILL');
    }
    pc2Process = null;
    emitStatus('stopped');
    await new Promise(r => setTimeout(r, 1000));
  }

  // Update flow mirrors the install flow: must include root deps (for the
  // GUI build) and HUSKY=0 to defend against legacy package.json versions
  // that lacked the husky-tolerant prepare script.
  //
  // v1.2.6 launcher: no --build-from-source step. Both supported pc2.net
  // SQLite adapters (`better-sqlite3` on v1.2.6, `@photostructure/sqlite`
  // on v1.2.7+) install without invoking a C++ compiler:
  //   - better-sqlite3 ^11.10.0 → Node 22 prebuilt binary downloaded by
  //     prebuild-install during postinstall.
  //   - @photostructure/sqlite ^1.2.1 → prebuilt binary unpacked from the
  //     npm tarball during `npm install`, no postinstall download needed.
  // The verification gauntlet below catches any edge cases where neither
  // path produces a loadable binary, and retries via clean reinstall.
  //
  // git reset --hard handles ALL drift (modified files, deleted files,
  // build artifacts) without the safety-guard hassle — production launcher
  // installs are managed entirely by us, so there's nothing legitimate the
  // user could have edited.
  const gitPull = `cd "${pc2Dir}" && git fetch origin && git reset --hard origin/main`;
  const npmEnvPrefix = IS_WINDOWS ? '' : 'HUSKY=0 ';
  const steps = IS_WINDOWS ? [
    { cmd: wslCmd(gitPull), msg: 'Pulling latest code...' },
    { cmd: wslCmd(`cd "${pc2Dir}" && HUSKY=0 npm install --legacy-peer-deps --ignore-scripts`), msg: 'Updating root dependencies...' },
    { cmd: wslCmd(`cd "${nodeDir}" && HUSKY=0 npm install --legacy-peer-deps`), msg: 'Installing dependencies...' },
    { cmd: wslCmd(`cd "${nodeDir}" && npm run build`), msg: 'Building PC2...' },
  ] : [
    { cmd: gitPull, msg: 'Pulling latest code...' },
    { cmd: `cd "${pc2Dir}" && ${npmEnvPrefix}${npmCmd} install --legacy-peer-deps --ignore-scripts`, msg: 'Updating root dependencies...' },
    { cmd: `cd "${nodeDir}" && ${npmEnvPrefix}${npmCmd} install --legacy-peer-deps`, msg: 'Installing dependencies...' },
    { cmd: `cd "${nodeDir}" && ${npmCmd} run build`, msg: 'Building PC2...' },
  ];

  for (const step of steps) {
    onProgress(step.msg);
    emitLog(step.msg);

    await new Promise<void>((resolve, reject) => {
      exec(step.cmd, { maxBuffer: 10 * 1024 * 1024, env: shellEnv }, (error, stdout, stderr) => {
        if (error) {
          emitLog(`Update error: ${error.message}`);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  // Same verification gauntlet as install — make sure the rebuild
  // actually produced loadable native modules before declaring victory.
  await verifyNativeModules(nodeDir, nodeCmd, npmCmd, npmEnvPrefix, onProgress);

  const newVersion = getPC2Version();
  onProgress(`Update complete! v${newVersion}`);
  emitLog(`PC2 updated to v${newVersion}`);

  if (wasRunning) {
    onProgress('Restarting PC2...');
    emitLog('Restarting PC2 after update...');
    await startPC2();
  }
}

export const PC2_URL_EXPORT = PC2_URL;
