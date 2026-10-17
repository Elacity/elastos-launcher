import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { backupStamp, zipDirectories } from '../legacyPc2Removal';
import { launcherOwnedDirectories, runtimeDataDir } from './runtimePaths';

/**
 * Rebuildable entries a Reset backup leaves out, relative to the data
 * directory. Install and setup write them again.
 * - The release files install.sh manages (`RELEASE_FILES` in the runtime's
 *   scripts/install.sh). Downloaded model weights live under `capsules`.
 * - VM images, VM sockets, and caches the runtime writes (elastos-crosvm,
 *   elastos-vz, browser-vz-engine-supervisor, gateway cache_dir,
 *   content_cache, model-preparation).
 * - Live process state that the next start writes again. The coords files
 *   hold a local attach secret. This includes the Kubo start lock and coords
 *   (capsules/ipfs-provider), the Community network-choice lock, the
 *   gateway's child-process records (`gateway-owned-runtimes`), and the
 *   `elastos run` ready receipt (`run`).
 * Everything else is kept, including names this list does not know. The
 * Community history and network choice (`collaboration*`) are the user's.
 * `ipfs-repo` is kept too: it holds the Kubo node key and blocks pinned on
 * this computer, which can be the only copy of content the user published
 * or imported. It can be large; the size check before the copy counts it.
 */
export const RUNTIME_BACKUP_EXCLUDES: readonly string[] = [
  'bin', 'capsules', 'libexec', 'tools', 'scripts', 'browser-vm/image-set',
  'model-catalog.json', 'components.json', 'sources.json', 'installation', 'update-controller',
  'browser-vm/vmlinux', 'browser-vm/rootfs.ext4', 'browser-vm/initrd', 'rootfs-cache',
  'crosvm', 'crosvm-empty', 'cache', 'gateway-cache', 'content_cache', 'model-preparation',
  'host-process.lock', 'gateway-runtime-ownership.lock', 'managed-runtime-start.lock',
  'runtime-coords.json', 'gateway-runtime-coords.json', 'home-runtime-coords.json', '.components.upgrade.tmp',
  'ipfs-startup.lock', 'ipfs-coords.json', '.collaboration-network-choice.lock', 'gateway-owned-runtimes', 'run',
];

export const BACKUP_FOLDER_NAME = 'ElastOS-backups';

/** True for a path, relative to the data directory with `/`, that a backup leaves out. */
export function backupExcluded(relative: string): boolean {
  return RUNTIME_BACKUP_EXCLUDES.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
}

export interface BackupMeasure {
  files: number;
  bytes: number;
  /** Bytes the zip needs on disk: the file bytes plus its headers and a margin. */
  neededBytes: number;
}

const ZIP_MARGIN_BYTES = 16 * 1024 * 1024;

/**
 * Size of what a backup would hold. Null when the data directory is missing.
 * A symlinked data directory is refused. Symlinks inside are not followed.
 */
export function measureRuntimeBackup(dataDir: string): BackupMeasure | null {
  let root: fs.Stats;
  try {
    root = fs.lstatSync(dataDir);
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') return null;
    throw new Error('ElastOS could not read its data folder.');
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error('The ElastOS data folder is not a real folder.');
  }
  let files = 0;
  let bytes = 0;
  let overhead = 22 + 56 + 20;
  const rootName = path.basename(dataDir);
  const stack = [dataDir];
  while (stack.length) {
    const current = stack.pop() as string;
    const relative = path.relative(dataDir, current).split(path.sep).join('/');
    if (current !== dataDir && backupExcluded(relative)) continue;
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
      continue;
    }
    if (!st.isFile()) continue;
    const nameBytes = Buffer.byteLength(`${rootName}/${relative}`, 'utf8');
    files += 1;
    bytes += st.size;
    // Local header, central header, the name twice, and room for ZIP64 fields.
    overhead += 30 + 46 + 2 * nameBytes + 48;
  }
  return { files, bytes, neededBytes: bytes + overhead + ZIP_MARGIN_BYTES };
}

/** Free bytes for this account at `dir`, or null when it cannot be read. */
export function freeBytesAt(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

export class BackupSpaceError extends Error {
  readonly code = 'backup-space';

  constructor(readonly neededBytes: number, readonly freeBytes: number | null) {
    super(freeBytes == null
      ? 'ElastOS could not check the free space for a copy of your data.'
      : `There is not enough free space for a copy of your data. It needs about ${plainBytes(neededBytes)}, and ${plainBytes(freeBytes)} is free.`);
    this.name = 'BackupSpaceError';
  }
}

export function plainBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.ceil(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function backupFolder(home: string): string {
  return path.join(home, BACKUP_FOLDER_NAME);
}

export interface BackupDescription {
  /** False when there is no data folder, so there is nothing to save. */
  present: boolean;
  bytes: number;
  neededBytes: number;
  freeBytes: number | null;
  enough: boolean;
  folder: string;
}

/** The closest existing folder at or above `dir`, for a free-space read before the folder exists. */
function existingParent(dir: string): string {
  let cursor = dir;
  for (;;) {
    if (fs.existsSync(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}

/** What the Reset dialog shows before the person chooses. */
export function describeRuntimeBackup(input: {
  dataDir: string;
  home: string;
  freeBytes?: (dir: string) => number | null;
}): BackupDescription {
  const folder = backupFolder(input.home);
  const measured = measureRuntimeBackup(input.dataDir);
  if (!measured) {
    return { present: false, bytes: 0, neededBytes: 0, freeBytes: null, enough: true, folder };
  }
  const free = (input.freeBytes ?? freeBytesAt)(existingParent(folder));
  return {
    present: true,
    bytes: measured.bytes,
    neededBytes: measured.neededBytes,
    freeBytes: free,
    enough: free != null && free >= measured.neededBytes,
    folder,
  };
}

/** Refuse before anything is stopped or written when the copy cannot fit. */
export function assertBackupSpace(input: {
  dataDir: string;
  home: string;
  freeBytes?: (dir: string) => number | null;
}): void {
  const seen = describeRuntimeBackup(input);
  if (seen.present && !seen.enough) throw new BackupSpaceError(seen.neededBytes, seen.freeBytes);
}

/**
 * `~/ElastOS-backups`, created with mode 0700. An existing name must be a
 * real folder of this account. It must not be a path Reset deletes.
 */
export function prepareBackupFolder(home: string, dataDir: string, platform: string = process.platform): string {
  const folder = backupFolder(home);
  const inside = path.relative(dataDir, folder);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
    throw new Error('The backup folder is inside the ElastOS data folder.');
  }
  if (launcherOwnedDirectories(folder, home, platform)) {
    throw new Error('The backup folder is a folder Reset deletes.');
  }
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (err) {
    if (!(err && typeof err === 'object' && (err as { code?: string }).code === 'EEXIST')) {
      throw new Error(`ElastOS could not make ${folder}.`);
    }
  }
  const st = fs.lstatSync(folder);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${folder} is not a folder.`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${folder} belongs to another account.`);
  }
  fs.chmodSync(folder, 0o700);
  return folder;
}

/**
 * Write the backup zip and return its path. Null when there is no data
 * folder. The name is dated and never replaces a file: a second backup in
 * the same second gets `-2`, `-3`, and so on. Space is checked again first.
 */
export function writeRuntimeBackup(input: {
  dataDir: string;
  home: string;
  now?: Date;
  platform?: string;
  freeBytes?: (dir: string) => number | null;
  zip?: typeof zipDirectories;
}): string | null {
  const measured = measureRuntimeBackup(input.dataDir);
  if (!measured) return null;
  const folder = prepareBackupFolder(input.home, input.dataDir, input.platform);
  const free = (input.freeBytes ?? freeBytesAt)(folder);
  if (free == null || free < measured.neededBytes) throw new BackupSpaceError(measured.neededBytes, free);
  const stamp = backupStamp(input.now ?? new Date());
  const zip = input.zip ?? zipDirectories;
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const dest = path.join(folder, `ElastOS-data-${stamp}${attempt === 1 ? '' : `-${attempt}`}.zip`);
    try {
      zip([input.dataDir], dest, { exclude: backupExcluded, exclusive: true });
      return dest;
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('Too many backups were saved this second. Wait a moment and try again.');
}

/**
 * The worker loads from inside app.asar. Electron reads asar in worker
 * threads. An unpacked copy could not require its imports, which stay in
 * app.asar.
 */
export function backupWorkerScript(): string {
  return path.join(__dirname, '..', 'runtimeBackupWorker.js');
}

export interface BackupWorkerJob {
  op: 'describe' | 'write';
  dataDir: string;
  home: string;
}

/** Measure and copy in a worker, so a large folder does not freeze the window. */
export function runBackupWorker<T>(job: BackupWorkerJob, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(backupWorkerScript(), { workerData: job });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Saving a copy of your data took too long.')));
    }, timeoutMs);
    worker.once('message', (msg: { ok?: boolean; value?: T; error?: string }) => {
      finish(() => {
        if (!msg || msg.ok !== true) reject(new Error(msg && msg.error ? msg.error : 'The copy of your data could not be saved.'));
        else resolve(msg.value as T);
      });
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`Saving a copy stopped (${code}).`)));
    });
  });
}

export function describeRuntimeBackupOnThisComputer(): Promise<BackupDescription> {
  const home = os.homedir();
  return runBackupWorker<BackupDescription>({
    op: 'describe',
    home,
    dataDir: runtimeDataDir(process.platform, home, process.env),
  }, 120_000);
}

export function writeRuntimeBackupOnThisComputer(dataDir: string): Promise<string | null> {
  return runBackupWorker<string | null>({ op: 'write', home: os.homedir(), dataDir }, 6 * 60 * 60 * 1000);
}
