import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function openAtLoginPath(homeDir: string): string {
  return path.join(homeDir, '.elastos-launcher', 'open-at-login.json');
}

export function linuxAutostartPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'autostart', 'elastos.desktop');
}

export function linuxAutostartFile(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=ElastOS',
    'Comment=Open your computer',
    `Exec=${execPath}`,
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function readOpenAtLogin(homeDir: string = os.homedir()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(openAtLoginPath(homeDir), 'utf8')) as { enabled?: boolean };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

export function writeOpenAtLogin(enabled: boolean, homeDir: string = os.homedir()): void {
  const file = openAtLoginPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enabled }));
}

export interface AutostartFs {
  mkdirp(dir: string): void;
  writeFile(file: string, contents: string): void;
  remove(file: string): void;
}

/** Linux sign-in launch. macOS and Windows use Electron login items at the call site. */
export function syncLinuxAutostart(
  enabled: boolean,
  homeDir: string,
  execPath: string,
  files: AutostartFs,
): string | null {
  const file = linuxAutostartPath(homeDir);
  if (!enabled) {
    files.remove(file);
    return null;
  }
  files.mkdirp(path.dirname(file));
  files.writeFile(file, linuxAutostartFile(execPath));
  return file;
}

export function applyOpenAtLogin(enabled: boolean, homeDir: string = os.homedir()): void {
  writeOpenAtLogin(enabled, homeDir);
  if (process.platform === 'linux') {
    syncLinuxAutostart(enabled, homeDir, process.execPath, {
      mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
      writeFile: (file, contents) => fs.writeFileSync(file, contents),
      remove: (file) => fs.rmSync(file, { force: true }),
    });
    return;
  }
  try {
    const electron = require('electron') as { app?: { setLoginItemSettings: (settings: { openAtLogin: boolean }) => void } };
    electron.app?.setLoginItemSettings?.({ openAtLogin: enabled });
  } catch {
    // Unit tests are not inside Electron.
  }
}
