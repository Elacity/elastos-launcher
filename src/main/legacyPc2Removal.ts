import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runtimeBinaryPath, runtimeDataDir, runtimeInstallStagePath } from './targets/runtimePaths';

/**
 * Isolated uninstaller for an old PC2 install. It does not install, start, or
 * configure PC2. It only lists and removes known PC2 paths after the caller
 * has confirmed.
 */

const PC2_NODE_VERSION = '22.13.1';

export const PC2_SUDOERS_FILES = [
  '/etc/sudoers.d/elastos',
  '/etc/sudoers.d/wireguard',
  '/etc/sudoers.d/amneziawg',
  '/etc/sudoers.d/pc2-wireguard',
];

export const PC2_VPN_BINARIES = [
  '/usr/local/bin/amneziawg-go',
  '/usr/local/bin/awg',
  '/usr/local/bin/awg-quick',
  '/usr/local/bin/sing-box',
  '/opt/homebrew/bin/amneziawg-go',
  '/opt/homebrew/bin/awg',
  '/opt/homebrew/bin/awg-quick',
  '/opt/homebrew/bin/sing-box',
];

/** A WSL distro is PC2's only when it was registered under one of these names. */
const PC2_DISTRO_NAMES = new Set(['pc2', 'pc2-wsl']);

const PC2_SERVICE_NAME = /^(pc2|com\.elacity\.pc2|com\.pc2)[^/]*\.(plist|service|desktop)$/i;
const PM2_SERVICE_NAME = /^pm2[.-][^/]+\.(plist|service)$/i;

export type LegacyScope = 'user' | 'system' | 'wsl' | 'distro';

export interface LegacyStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
}

export interface LegacyItem {
  scope: LegacyScope;
  path: string;
  label: string;
  bytes: number | null;
  distro?: string;
  wslHome?: string;
}

export interface LegacyProbe {
  home: string;
  platform: string;
  env?: NodeJS.ProcessEnv;
  lstat(file: string): LegacyStat;
  realpath(file: string): string;
  readdir(dir: string): string[];
  readFile(file: string): string;
  /** Raw `wsl -l -v` text. Windows only. */
  distroList?: string;
  /** PC2 files inside a non-ElastOS WSL distro. */
  wsl?: Array<{ distro: string; home: string; pc2Bytes: number | null; nodeBytes: number | null }>;
}

export interface LegacyRemovalResult {
  ok: boolean;
  message: string;
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
  backupPath?: string;
}

export interface LegacyRemovalActions {
  backup: boolean;
  downloadsDir: string;
  now?: Date;
  remove(file: string): void;
  stop(): Promise<void>;
  privilegedRemove(files: string[]): Promise<void>;
  zipDirectories?(dirs: string[], dest: string): void;
  removeWslPath?(distro: string, file: string): void;
  unregisterDistro?(name: string): Promise<void>;
}

const REMOVED_MESSAGE = 'PC2 removed';

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code?: string }).code);
  return '';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function legacyPc2Dir(home: string): string {
  return path.join(home, '.pc2');
}

export function legacyNodeDir(home: string): string {
  return path.join(home, '.elastos', 'node');
}

export function legacyServiceDirs(home: string): Array<{ dir: string; scope: 'user' | 'system' }> {
  return [
    { dir: path.join(home, 'Library', 'LaunchAgents'), scope: 'user' },
    { dir: path.join(home, '.config', 'systemd', 'user'), scope: 'user' },
    { dir: path.join(home, '.config', 'autostart'), scope: 'user' },
    { dir: '/Library/LaunchAgents', scope: 'system' },
    { dir: '/Library/LaunchDaemons', scope: 'system' },
    { dir: '/etc/systemd/system', scope: 'system' },
  ];
}

export function runtimeRoots(home: string, platform: string, env: NodeJS.ProcessEnv = {}): string[] {
  const data = runtimeDataDir(platform, home, env);
  const stage = runtimeInstallStagePath(home);
  return [
    runtimeBinaryPath(home),
    data,
    stage,
    path.dirname(stage),
  ];
}

export function isRuntimePath(file: string, home: string, platform: string, env: NodeJS.ProcessEnv = {}): boolean {
  const candidate = path.resolve(file);
  return runtimeRoots(home, platform, env).some((root) => {
    const resolved = path.resolve(root);
    return candidate === resolved || candidate.startsWith(resolved + path.sep);
  });
}

export function isPc2DistroName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'elastos') return false;
  return PC2_DISTRO_NAMES.has(normalized);
}

export function isPc2ServiceFile(basename: string, body: string | null): boolean {
  if (PC2_SERVICE_NAME.test(basename)) return true;
  if (PM2_SERVICE_NAME.test(basename) && body != null && /pc2-node|\.pc2\b|\bpc2\b/.test(body)) return true;
  return false;
}

export function parseWslDistroList(text: string): Array<{ name: string; isDefault: boolean }> {
  const clean = text.replace(/\0/g, '');
  const rows: Array<{ name: string; isDefault: boolean }> = [];
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\b/i.test(trimmed) || /Windows Subsystem/i.test(trimmed)) continue;
    const isDefault = line.includes('*') || trimmed.startsWith('*');
    const name = trimmed.replace(/^\*\s*/, '').split(/\s+/)[0];
    if (name) rows.push({ name, isDefault });
  }
  return rows;
}

/** The distro the old launcher used (`wsl` with no `-d`), never the ElastOS distro. */
export function parseWslPc2Probe(text: string): { pc2Bytes: number | null; nodeBytes: number | null } {
  let pc2Bytes: number | null = null;
  let nodeBytes: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const pc2 = line.match(/^PC2\s+(\d+)$/);
    const node = line.match(/^NODE\s+(\d+)$/);
    if (pc2) pc2Bytes = Number(pc2[1]);
    if (node) nodeBytes = Number(node[1]);
  }
  return { pc2Bytes, nodeBytes };
}

export function defaultUserDistro(rows: Array<{ name: string; isDefault: boolean }>): string | null {
  const row = rows.find((entry) => entry.isDefault) ?? null;
  if (!row) return null;
  if (row.name.toLowerCase() === 'elastos') return null;
  return row.name;
}

export function selectPc2Pids(rows: Array<{ pid: number; command: string }>, selfPid: number): number[] {
  return rows.filter((row) => {
    if (!Number.isInteger(row.pid) || row.pid <= 0 || row.pid === selfPid) return false;
    const command = row.command || '';
    if (command.includes('/.local/bin/elastos') || command.includes('Application Support/elastos')) return false;
    return command.includes('pc2-node') || command.includes('/.pc2/') || command.includes('\\.pc2\\');
  }).map((row) => row.pid);
}

export function selectWslPc2Pids(psText: string): number[] {
  const pids: number[] = [];
  for (const line of psText.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const command = match[2];
    if (command.includes('pc2-node') || command.includes('/.pc2/')) pids.push(Number(match[1]));
  }
  return pids;
}

export function legacyBackupDestination(home: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-');
  return path.join(home, 'Downloads', `PC2-backup-${stamp}.zip`);
}

export function withSupportBundle(message: string, bundlePath: string): string {
  return `${message} A support bundle was saved to ${bundlePath}.`;
}

function isSystemFile(file: string): boolean {
  return PC2_SUDOERS_FILES.includes(file) || PC2_VPN_BINARIES.includes(file);
}

function serviceParent(file: string, home: string): { dir: string; scope: 'user' | 'system' } | null {
  const resolved = path.resolve(file);
  for (const entry of legacyServiceDirs(home)) {
    if (path.dirname(resolved) === path.resolve(entry.dir)) return entry;
  }
  return null;
}

function isPc2NodeLayout(nodeDir: string, probe: Pick<LegacyProbe, 'readdir' | 'lstat'>): boolean {
  try {
    const st = probe.lstat(nodeDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let names: string[];
  try {
    names = probe.readdir(nodeDir);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!name.startsWith(`node-v${PC2_NODE_VERSION}-`)) return false;
    const bin = path.join(nodeDir, name, 'bin');
    return exists(path.join(bin, 'node'), probe.lstat) || exists(path.join(bin, 'node.exe'), probe.lstat);
  });
}

function exists(file: string, lstat: LegacyProbe['lstat']): boolean {
  try {
    lstat(file);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    return false;
  }
}

function missing(err: unknown): boolean {
  return errorCode(err) === 'ENOENT';
}

function item(scope: LegacyScope, file: string, label: string, bytes: number | null, extra: Partial<LegacyItem> = {}): LegacyItem {
  return { scope, path: file, label, bytes, ...extra };
}

function directoryBytes(root: string, probe: LegacyProbe): number {
  let bytes = 0;
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    let st: LegacyStat;
    try {
      st = probe.lstat(current);
    } catch (err) {
      if (missing(err)) continue;
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    // A symlink is counted as a link, not as the file it points at.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = probe.readdir(current);
      } catch (err) {
        if (!missing(err)) throw new Error('Refusing to remove a path that could not be inspected.');
      }
      for (const name of names) stack.push(path.join(current, name));
      continue;
    }
    bytes += st.size;
  }
  return bytes;
}

export function discoverLegacyPc2(probe: LegacyProbe): LegacyItem[] {
  const found: LegacyItem[] = [];
  const pc2 = legacyPc2Dir(probe.home);
  const listed = safeList(pc2, probe);
  if (listed) {
    found.push(item('user', pc2, 'PC2 folder', listed.bytes));
  }
  const node = legacyNodeDir(probe.home);
  if (isPc2NodeLayout(node, probe)) {
    const sized = safeList(node, probe);
    found.push(item('user', node, 'PC2 Node.js', sized ? sized.bytes : 0));
  }
  for (const dir of legacyServiceDirs(probe.home)) {
    let names: string[];
    try {
      names = probe.readdir(dir.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir.dir, name);
      if (isRuntimePath(file, probe.home, probe.platform, probe.env)) continue;
      let body: string | null = null;
      if (PM2_SERVICE_NAME.test(name)) {
        try {
          body = probe.readFile(file).slice(0, 256 * 1024);
        } catch {
          body = null;
        }
      }
      if (!isPc2ServiceFile(name, body)) continue;
      let bytes: number | null = 0;
      try {
        const st = probe.lstat(file);
        if (st.isSymbolicLink()) continue;
        bytes = st.size;
      } catch {
        continue;
      }
      found.push(item(dir.scope, file, 'PC2 startup entry', bytes));
    }
  }
  for (const file of [...PC2_SUDOERS_FILES, ...PC2_VPN_BINARIES]) {
    try {
      const st = probe.lstat(file);
      if (st.isSymbolicLink()) continue;
      found.push(item('system', file, systemLabel(file), st.size));
    } catch {
      continue;
    }
  }
  if (probe.distroList) {
    for (const row of parseWslDistroList(probe.distroList)) {
      if (!isPc2DistroName(row.name)) continue;
      found.push(item('distro', row.name, 'PC2 Linux environment', null, { distro: row.name }));
    }
  }
  for (const guest of probe.wsl ?? []) {
    if (guest.distro.toLowerCase() === 'elastos') continue;
    if (guest.pc2Bytes !== null) {
      found.push(item('wsl', `${guest.home}/.pc2`, 'PC2 folder in Windows Linux', guest.pc2Bytes, {
        distro: guest.distro,
        wslHome: guest.home,
      }));
    }
    if (guest.nodeBytes !== null) {
      found.push(item('wsl', `${guest.home}/.elastos/node`, 'PC2 Node.js in Windows Linux', guest.nodeBytes, {
        distro: guest.distro,
        wslHome: guest.home,
      }));
    }
  }
  return found;
}

function systemLabel(file: string): string {
  if (file.startsWith('/etc/sudoers.d/')) return 'PC2 sudoers rule';
  return 'PC2 VPN program';
}

function safeList(file: string, probe: LegacyProbe): { bytes: number } | null {
  try {
    const st = probe.lstat(file);
    if (st.isSymbolicLink()) return { bytes: 0 };
    if (st.isDirectory()) return { bytes: directoryBytes(file, probe) };
    return { bytes: st.size };
  } catch (err) {
    if (missing(err)) return null;
    return { bytes: 0 };
  }
}

function refusal(sentence: string): LegacyRemovalResult {
  return {
    ok: false,
    message: `PC2 was not removed. ${sentence}`,
    removed: [],
    failed: [],
  };
}

function wslHomeOk(home: string): boolean {
  return /^\/(?:home\/[A-Za-z0-9._-]+|root)$/.test(home);
}

function allowUserPath(file: string, probe: LegacyProbe): boolean {
  if (file === legacyPc2Dir(probe.home)) return true;
  if (file === legacyNodeDir(probe.home)) return isPc2NodeLayout(legacyNodeDir(probe.home), probe);
  return false;
}

function allowItem(entry: LegacyItem, probe: LegacyProbe): boolean {
  if (entry.scope === 'distro') return isPc2DistroName(entry.path) && entry.distro === entry.path;
  if (entry.scope === 'wsl') {
    if (!entry.distro || !entry.wslHome || !wslHomeOk(entry.wslHome)) return false;
    if (entry.distro.toLowerCase() === 'elastos' || !/^[A-Za-z0-9._-]+$/.test(entry.distro)) return false;
    const pc2 = `${entry.wslHome}/.pc2`;
    const node = `${entry.wslHome}/.elastos/node`;
    return entry.path === pc2 || entry.path === node;
  }
  if (isSystemFile(entry.path)) return entry.scope === 'system';
  if (allowUserPath(entry.path, probe)) return entry.scope === 'user';
  const parent = serviceParent(entry.path, probe.home);
  if (!parent || parent.scope !== entry.scope) return false;
  const base = path.basename(entry.path);
  let body: string | null = null;
  if (PM2_SERVICE_NAME.test(base)) {
    try {
      body = probe.readFile(entry.path).slice(0, 256 * 1024);
    } catch {
      return false;
    }
  }
  return isPc2ServiceFile(base, body);
}

function isInside(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

function assertNoEscapingSymlink(root: string, probe: LegacyProbe): void {
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    let st: LegacyStat;
    try {
      st = probe.lstat(current);
    } catch (err) {
      if (missing(err)) continue;
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    if (st.isSymbolicLink()) {
      try {
        const target = probe.realpath(current);
        if (!isInside(target, root)) throw new Error('Refusing to remove a path that follows a symlink.');
      } catch (err) {
        if (missing(err)) continue;
        throw err;
      }
      continue;
    }
    if (!st.isDirectory()) continue;
    let names: string[] = [];
    try {
      names = probe.readdir(current);
    } catch (err) {
      if (missing(err)) continue;
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    for (const name of names) stack.push(path.join(current, name));
  }
}

function assertPresentTree(file: string, probe: LegacyProbe): 'missing' | 'ok' {
  let st: LegacyStat;
  try {
    st = probe.lstat(file);
  } catch (err) {
    if (missing(err)) return 'missing';
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  if (st.isSymbolicLink()) throw new Error('Refusing to remove a path that follows a symlink.');
  let real = file;
  try {
    real = probe.realpath(file);
  } catch (err) {
    if (missing(err)) return 'missing';
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  if (path.resolve(real) !== path.resolve(file)) {
    throw new Error('Refusing to remove a path that follows a symlink.');
  }
  if (isRuntimePath(real, probe.home, probe.platform, probe.env)) {
    throw new Error('Refusing to remove ElastOS.');
  }
  if (st.isDirectory()) assertNoEscapingSymlink(file, probe);
  return 'ok';
}

function classifyError(err: unknown): string {
  const text = messageOf(err);
  if (text.includes('symlink') || text.includes('ElastOS') || text.includes('not part of the old PC2') || text.includes('could not be inspected')) {
    return text;
  }
  return text || 'Something went wrong while removing PC2.';
}

export async function removeDiscoveredLegacyPc2(
  entries: LegacyItem[],
  probe: LegacyProbe,
  actions: LegacyRemovalActions,
): Promise<LegacyRemovalResult> {
  for (const entry of entries) {
    if ((entry.scope === 'distro' && entry.path.toLowerCase() === 'elastos') || entry.distro?.toLowerCase() === 'elastos') {
      return refusal('Refusing to remove ElastOS.');
    }
    if (isRuntimePath(entry.path, probe.home, probe.platform, probe.env)) {
      return refusal('Refusing to remove ElastOS.');
    }
    if (!allowItem(entry, probe)) {
      return refusal('Refusing to remove a path that is not part of the old PC2 install.');
    }
  }

  const present: LegacyItem[] = [];
  try {
    for (const entry of entries) {
      if (entry.scope === 'distro' || entry.scope === 'wsl') {
        present.push(entry);
        continue;
      }
      const state = assertPresentTree(entry.path, probe);
      if (state === 'ok') present.push(entry);
    }
  } catch (err) {
    return refusal(classifyError(err));
  }

  if (present.length === 0) {
    return { ok: true, message: REMOVED_MESSAGE, removed: [], failed: [] };
  }

  let backupPath: string | undefined;
  if (actions.backup) {
    const dirs = present.filter((entry) => entry.scope === 'user' && entry.path === legacyPc2Dir(probe.home)).map((entry) => entry.path);
    if (dirs.length) {
      const name = path.basename(legacyBackupDestination(probe.home, actions.now ?? new Date()));
      backupPath = path.join(actions.downloadsDir, name);
      if (isRuntimePath(backupPath, probe.home, probe.platform, probe.env) || isRuntimePath(actions.downloadsDir, probe.home, probe.platform, probe.env)) {
        return refusal('Refusing to remove ElastOS.');
      }
      try {
        const zip = actions.zipDirectories ?? zipDirectories;
        zip(dirs, backupPath);
      } catch (err) {
        return {
          ok: false,
          message: `PC2 was not removed. The backup could not be saved (${messageOf(err)}).`,
          removed: [],
          failed: [],
        };
      }
    }
  }

  try {
    await actions.stop();
  } catch (err) {
    return {
      ok: false,
      message: backupNote(`PC2 was not removed. PC2 is still running (${messageOf(err)}).`, backupPath),
      removed: [],
      failed: present.map((entry) => ({ path: entry.path, reason: 'PC2 is still running.' })),
      backupPath,
    };
  }

  const removed: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  const system: string[] = [];
  const distros: string[] = [];

  for (const entry of present) {
    if (entry.scope === 'system') {
      system.push(entry.path);
      continue;
    }
    if (entry.scope === 'distro') {
      distros.push(entry.path);
      continue;
    }
    try {
      if (entry.scope === 'wsl') {
        if (!actions.removeWslPath || !entry.distro) throw new Error('The PC2 folder in Windows Linux could not be removed.');
        actions.removeWslPath(entry.distro, entry.path);
      } else {
        actions.remove(entry.path);
      }
      removed.push(entry.path);
    } catch (err) {
      if (missing(err)) {
        removed.push(entry.path);
        continue;
      }
      failed.push({ path: entry.path, reason: messageOf(err) });
    }
  }

  if (system.length) {
    try {
      await actions.privilegedRemove(system);
      removed.push(...system);
    } catch (err) {
      const reason = messageOf(err);
      for (const file of system) failed.push({ path: file, reason });
    }
  }

  for (const name of distros) {
    try {
      if (!actions.unregisterDistro) throw new Error('The PC2 Linux environment could not be removed.');
      await actions.unregisterDistro(name);
      removed.push(name);
    } catch (err) {
      failed.push({ path: name, reason: messageOf(err) });
    }
  }

  if (failed.length) {
    const reason = failed.length === 1
      ? `Could not remove ${failed[0].path}.`
      : 'Some PC2 files could not be removed.';
    return {
      ok: false,
      message: backupNote(
        `PC2 could not be fully removed. ${reason} Removed: ${removed.join(', ') || 'nothing'}. Still there: ${failed.map((row) => `${row.path} (${row.reason})`).join(', ')}.`,
        backupPath,
      ),
      removed,
      failed,
      backupPath,
    };
  }

  return { ok: true, message: REMOVED_MESSAGE, removed, failed: [], backupPath };
}

function backupNote(message: string, backupPath?: string): string {
  if (!backupPath) return message;
  return `${message} Your backup is ${backupPath}.`;
}

export async function removeLegacyPc2(probe: LegacyProbe, actions: LegacyRemovalActions): Promise<LegacyRemovalResult> {
  return removeDiscoveredLegacyPc2(discoverLegacyPc2(probe), probe, actions);
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ~crc >>> 0;
}

function dosTime(when: Date): { time: number; date: number } {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time, date };
}

/** Store-method zip of regular files under each directory. Symlinks are not followed. */
export function zipDirectories(dirs: string[], dest: string): void {
  const when = dosTime(new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const dir of dirs) {
    const rootName = path.basename(dir);
    const files = walkRegularFiles(dir);
    for (const file of files) {
      const relative = path.relative(dir, file).split(path.sep).join('/');
      const name = Buffer.from(`${rootName}/${relative}`, 'utf8');
      const data = fs.readFileSync(file);
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(when.time, 10);
      local.writeUInt16LE(when.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      locals.push(local, name, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(when.time, 12);
      central.writeUInt16LE(when.date, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, name);
      offset += local.length + name.length + data.length;
    }
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat([...locals, centralBytes, end]));
}

function walkRegularFiles(dir: string): string[] {
  const files: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
      continue;
    }
    if (st.isFile()) files.push(current);
  }
  return files;
}

function realProbe(home: string, platform: string, env: NodeJS.ProcessEnv): LegacyProbe {
  return {
    home,
    platform,
    env,
    lstat: (file) => fs.lstatSync(file),
    realpath: (file) => fs.realpathSync(file),
    readdir: (dir) => fs.readdirSync(dir),
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    distroList: platform === 'win32' ? readWslList() : undefined,
    wsl: platform === 'win32' ? readWslPc2Homes() : undefined,
  };
}

function readWslList(): string {
  try {
    const buf = execFileSync('wsl.exe', ['-l', '-v'], { timeout: 8000 });
    return buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8');
  } catch {
    return '';
  }
}

export function wslPc2ProbeScript(): string {
  return [
    'if [ -d "$HOME/.pc2" ] && [ ! -L "$HOME/.pc2" ]; then du -sb "$HOME/.pc2" | awk \'NR==1 { print "PC2 " $1 }\'; fi',
    'if [ -d "$HOME/.elastos/node" ] && [ ! -L "$HOME/.elastos/node" ] && find "$HOME/.elastos/node" -maxdepth 1 -type d -name "node-v22.13.1-*" | grep -q .; then du -sb "$HOME/.elastos/node" | awk \'NR==1 { print "NODE " $1 }\'; fi',
  ].join('; ');
}

function readWslPc2Homes(): LegacyProbe['wsl'] {
  const rows = parseWslDistroList(readWslList());
  const distro = defaultUserDistro(rows);
  if (!distro || distro.toLowerCase() === 'elastos') return [];
  try {
    const home = execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', 'printf %s "$HOME"'], {
      timeout: 8000,
      encoding: 'utf8',
    }).trim();
    if (!wslHomeOk(home)) return [];
    const probe = execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', wslPc2ProbeScript()], {
      timeout: 20000,
      encoding: 'utf8',
    });
    const sized = parseWslPc2Probe(probe);
    if (sized.pc2Bytes === null && sized.nodeBytes === null) return [];
    return [{ distro, home, pc2Bytes: sized.pc2Bytes, nodeBytes: sized.nodeBytes }];
  } catch {
    return [];
  }
}

export function describeLegacyPc2OnThisComputer(home = os.homedir(), platform = process.platform, env: NodeJS.ProcessEnv = process.env): LegacyItem[] {
  return discoverLegacyPc2(realProbe(home, platform, env));
}

const SYSTEM_SERVICE_DIRS = ['/Library/LaunchAgents', '/Library/LaunchDaemons', '/etc/systemd/system'];

function quoteShell(file: string): string {
  return `'${file.replace(/'/g, `'\\''`)}'`;
}

export function privilegedRemovalScript(
  files: string[],
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): string {
  for (const file of files) {
    if (isSystemFile(file)) continue;
    const base = path.basename(file);
    const body = PM2_SERVICE_NAME.test(base) ? readFile(file) : null;
    if (!SYSTEM_SERVICE_DIRS.includes(path.dirname(file)) || !isPc2ServiceFile(base, body)) {
      throw new Error('Refusing to remove a path that is not part of the old PC2 install.');
    }
  }
  return files.map((file) => {
    const quoted = quoteShell(file);
    if (file.endsWith('.service') || file.endsWith('.plist')) {
      return `launchctl bootout system ${quoted} >/dev/null 2>&1 || true; systemctl disable --now ${quoteShell(path.basename(file))} >/dev/null 2>&1 || true; rm -f -- ${quoted}`;
    }
    return `rm -f -- ${quoted}`;
  }).join('; ');
}

function runOnePrivilegedRm(files: string[]): void {
  if (files.length === 0) return;
  const script = privilegedRemovalScript(files);
  if (process.platform === 'darwin') {
    const apple = `do shell script ${JSON.stringify(script)} with administrator privileges`;
    execFileSync('osascript', ['-e', apple], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('pkexec', ['sh', '-c', script], { stdio: 'inherit' });
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
      execFileSync('sudo', ['--', 'sh', '-c', script], { stdio: 'inherit' });
    }
    return;
  }
  throw new Error('PC2 system files are not removed on this computer.');
}

export function wslRemovalArgs(distro: string, file: string): string[] {
  if (distro.toLowerCase() === 'elastos') throw new Error('Refusing to remove ElastOS.');
  if (!/^[A-Za-z0-9._-]+$/.test(distro) || !isSafeWslPath(file)) {
    throw new Error('Refusing to remove a path that is not part of the old PC2 install.');
  }
  const script = 'if [ -L "$1" ]; then exit 3; fi; if [ ! -e "$1" ]; then exit 0; fi; rm -rf -- "$1"';
  return ['-d', distro, '--', 'bash', '-c', script, 'bash', file];
}

export async function removeLegacyPc2OnThisComputer(options: { backup: boolean }): Promise<LegacyRemovalResult> {
  const home = os.homedir();
  const probe = realProbe(home, process.platform, process.env);
  return removeLegacyPc2(probe, {
    backup: options.backup,
    downloadsDir: path.join(home, 'Downloads'),
    remove: (file) => {
      if (isRuntimePath(file, home, process.platform, process.env)) {
        throw new Error('Refusing to remove ElastOS.');
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(file);
      } catch (err) {
        if (missing(err)) return;
        throw new Error('Refusing to remove a path that could not be inspected.');
      }
      if (st.isSymbolicLink()) throw new Error('Refusing to remove a path that follows a symlink.');
      const real = fs.realpathSync(file);
      if (path.resolve(real) !== path.resolve(file) || isRuntimePath(real, home, process.platform, process.env)) {
        throw new Error(isRuntimePath(real, home, process.platform, process.env)
          ? 'Refusing to remove ElastOS.'
          : 'Refusing to remove a path that follows a symlink.');
      }
      if (process.platform === 'darwin' && file.endsWith('.plist')) {
        try {
          execFileSync('launchctl', ['bootout', `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}`, file], { stdio: 'ignore' });
        } catch {
          // The agent is already unloaded.
        }
      }
      if (file.endsWith('.service') && file.includes(`${path.sep}.config${path.sep}systemd${path.sep}user${path.sep}`)) {
        try {
          execFileSync('systemctl', ['--user', 'disable', '--now', path.basename(file)], { stdio: 'ignore' });
        } catch {
          // The user service is already stopped.
        }
      }
      fs.rmSync(file, { recursive: true, force: true });
    },
    stop: () => stopLegacyPc2OnThisComputer(),
    privilegedRemove: async (files) => {
      runOnePrivilegedRm(files);
    },
    removeWslPath: (distro, file) => {
      try {
        execFileSync('wsl.exe', wslRemovalArgs(distro, file), { timeout: 120000 });
      } catch (err) {
        const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status?: number }).status) : NaN;
        if (status === 3) throw new Error('Refusing to remove a path that follows a symlink.');
        throw err;
      }
    },
    unregisterDistro: async (name) => {
      if (!isPc2DistroName(name)) throw new Error('Refusing to remove ElastOS.');
      execFileSync('wsl.exe', ['--unregister', name], { timeout: 120000 });
    },
  });
}

function isSafeWslPath(file: string): boolean {
  return /^\/(?:home\/[A-Za-z0-9._-]+|root)\/(?:\.pc2|\.elastos\/node)$/.test(file);
}

async function stopLegacyPc2OnThisComputer(): Promise<void> {
  try {
    execFileSync('pm2', ['delete', 'pc2'], { stdio: 'ignore', timeout: 15000 });
  } catch {
    // PM2 is not installed, or the pc2 app is already gone.
  }
  const pids = selectPc2Pids(listLocalPort4200(), process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (errorCode(err) !== 'ESRCH') throw new Error('PC2 is still running. Quit it, then remove it again.');
    }
  }
  if (process.platform !== 'win32') return;
  const distro = defaultUserDistro(parseWslDistroList(readWslList()));
  if (!distro || distro.toLowerCase() === 'elastos') return;
  try {
    execFileSync('wsl.exe', ['-d', distro, '--', 'pm2', 'delete', 'pc2'], { stdio: 'ignore', timeout: 15000 });
  } catch {
    // The Linux guest may not have PM2.
  }
  let ps = '';
  try {
    ps = execFileSync('wsl.exe', ['-d', distro, '--', 'ps', '-eo', 'pid,args'], { encoding: 'utf8', timeout: 8000 });
  } catch {
    return;
  }
  for (const pid of selectWslPc2Pids(ps)) {
    try {
      execFileSync('wsl.exe', ['-d', distro, '--', 'kill', String(pid)], { timeout: 8000 });
    } catch {
      throw new Error('PC2 is still running. Quit it, then remove it again.');
    }
  }
}

function listLocalPort4200(): Array<{ pid: number; command: string }> {
  let output = '';
  try {
    output = execFileSync('lsof', ['-nP', '-iTCP:4200', '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 4000 });
  } catch {
    return [];
  }
  const rows: Array<{ pid: number; command: string }> = [];
  for (const line of output.split('\n')) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let command = '';
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 4000 }).trim();
    } catch {
      command = '';
    }
    rows.push({ pid, command });
  }
  return rows;
}
