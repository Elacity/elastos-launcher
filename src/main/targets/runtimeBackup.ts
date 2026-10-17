import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { backupStamp, zipDirectories } from '../legacyPc2Removal';
import { RUNTIME_LEFT_OUT_TEMP_NAMES, launcherOwnedDirectories, runtimeDataDir } from './runtimePaths';

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
 * - A temporary copy of one of these that a crashed write leaves, by the
 *   exact name its writer uses (`RUNTIME_LEFT_OUT_TEMP_NAMES` in
 *   runtimePaths.ts), such as `.gateway-runtime-coords.json.<32 hex>.tmp`.
 * - The same names inside the data directory of a managed child runtime
 *   (`CHILD_DATA_ROOT`).
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

/**
 * A managed child runtime has its own data directory inside this one. Its
 * HOME is `managed-runtimes/<kind>/home` (runtime_control.rs:525, 1342), so
 * its data directory is `.local/share/elastos` there, or
 * `Library/Application Support/elastos` on macOS (runtime_control.rs:532-544).
 */
const CHILD_DATA_ROOT = /^managed-runtimes\/[^/]+\/home\/(?:\.local\/share|Library\/Application Support)\/elastos\//;

/**
 * The same rules as `backupExcluded`, as data for the Reset helper that
 * copies the data inside the ElastOS Linux environment on Windows
 * (distroResetHelper.ts). The patterns go as their source text, and the
 * helper matches each one against the whole name, as `^...$` does here.
 */
export interface BackupExclusionRules {
  excludes: readonly string[];
  leftOutTempNames: string[];
  childDataRoot: string;
}

export function backupExclusionRules(): BackupExclusionRules {
  const patterns = [...RUNTIME_LEFT_OUT_TEMP_NAMES, CHILD_DATA_ROOT];
  if (patterns.some((pattern) => pattern.flags !== '')) throw new Error('A backup rule has flags the helper cannot read.');
  return {
    excludes: RUNTIME_BACKUP_EXCLUDES,
    leftOutTempNames: RUNTIME_LEFT_OUT_TEMP_NAMES.map((pattern) => pattern.source),
    childDataRoot: CHILD_DATA_ROOT.source,
  };
}

/** True for a path, relative to the data directory with `/`, that a backup leaves out. */
export function backupExcluded(relative: string): boolean {
  const inner = relative.replace(CHILD_DATA_ROOT, '');
  const top = inner.split('/')[0];
  return RUNTIME_BACKUP_EXCLUDES.some((entry) => inner === entry || inner.startsWith(`${entry}/`))
    || RUNTIME_LEFT_OUT_TEMP_NAMES.some((pattern) => pattern.test(top));
}

export interface BackupMeasure {
  files: number;
  bytes: number;
  /** Bytes the zip needs on disk: the file bytes plus its headers and a margin. */
  neededBytes: number;
}

const ZIP_MARGIN_BYTES = 16 * 1024 * 1024;

/**
 * Bytes a stored zip needs: the file bytes, a local and a central header
 * per file, each name twice, room for ZIP64 fields, the end records, and a
 * margin. `nameBytes` is the sum of the UTF-8 entry names.
 */
export function backupNeededBytes(files: number, bytes: number, nameBytes: number): number {
  return bytes + 22 + 56 + 20 + files * (30 + 46 + 48) + 2 * nameBytes + ZIP_MARGIN_BYTES;
}

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
  let nameBytes = 0;
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
    files += 1;
    bytes += st.size;
    nameBytes += Buffer.byteLength(`${rootName}/${relative}`, 'utf8');
  }
  return { files, bytes, neededBytes: backupNeededBytes(files, bytes, nameBytes) };
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
  return describeMeasuredBackup(measureRuntimeBackup(input.dataDir), input.home, input.freeBytes);
}

/** The dialog facts for a measured copy. Null `measured` means there is no data folder. */
export function describeMeasuredBackup(
  measured: BackupMeasure | null,
  home: string,
  freeBytes?: (dir: string) => number | null,
): BackupDescription {
  const folder = backupFolder(home);
  if (!measured) {
    return { present: false, bytes: 0, neededBytes: 0, freeBytes: null, enough: true, folder };
  }
  const free = (freeBytes ?? freeBytesAt)(existingParent(folder));
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
  for (let attempt = 1; attempt <= MAX_BACKUP_ATTEMPTS; attempt += 1) {
    const dest = path.join(folder, backupFileName(stamp, attempt));
    try {
      zip([input.dataDir], dest, { exclude: backupExcluded, exclusive: true });
      return dest;
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(TOO_MANY_BACKUPS);
}

export const MAX_BACKUP_ATTEMPTS = 50;
export const TOO_MANY_BACKUPS = 'Too many backups were saved this second. Wait a moment and try again.';

/** `ElastOS-data-<stamp>.zip`, then `-2`, `-3`, and so on. */
export function backupFileName(stamp: string, attempt: number): string {
  return `ElastOS-data-${stamp}${attempt === 1 ? '' : `-${attempt}`}.zip`;
}

export interface StoredZipEntry {
  name: string;
  dataOffset: number;
  size: number;
  crc: number;
}

const ZIP_FAILED = 'The copy of your data is not a complete zip file.';

/**
 * Read the central directory of a stored (not compressed) zip, with ZIP64.
 * Each entry's data offset comes from its local header. Anything this reader
 * does not expect is refused, so a cut-off or altered copy is not trusted.
 */
export function readStoredZipEntries(file: string): StoredZipEntry[] {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const read = (offset: number, length: number): Buffer => {
      if (offset < 0 || length < 0 || offset + length > total) throw new Error(ZIP_FAILED);
      const buf = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const n = fs.readSync(fd, buf, done, length - done, offset + done);
        if (n <= 0) throw new Error(ZIP_FAILED);
        done += n;
      }
      return buf;
    };
    if (total < 22) throw new Error(ZIP_FAILED);
    const end = read(total - 22, 22);
    if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(20) !== 0) throw new Error(ZIP_FAILED);
    let count = end.readUInt16LE(10);
    let centralSize = end.readUInt32LE(12);
    let centralOffset = end.readUInt32LE(16);
    let centralEnd = total - 22;
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      const locator = read(total - 22 - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error(ZIP_FAILED);
      const recordOffset = Number(locator.readBigUInt64LE(8));
      const record = read(recordOffset, 56);
      if (record.readUInt32LE(0) !== 0x06064b50) throw new Error(ZIP_FAILED);
      count = Number(record.readBigUInt64LE(32));
      centralSize = Number(record.readBigUInt64LE(40));
      centralOffset = Number(record.readBigUInt64LE(48));
      centralEnd = recordOffset;
    }
    if (!Number.isSafeInteger(count) || centralOffset + centralSize !== centralEnd) throw new Error(ZIP_FAILED);
    const central = read(centralOffset, centralSize);
    const entries: StoredZipEntry[] = [];
    let at = 0;
    let expectedOffset = 0;
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) throw new Error(ZIP_FAILED);
      const method = central.readUInt16LE(at + 10);
      const crc = central.readUInt32LE(at + 16);
      let size = central.readUInt32LE(at + 24);
      const compressed = central.readUInt32LE(at + 20);
      const nameLength = central.readUInt16LE(at + 28);
      const extraLength = central.readUInt16LE(at + 30);
      const commentLength = central.readUInt16LE(at + 32);
      let localOffset = central.readUInt32LE(at + 42);
      if (method !== 0 || compressed !== size || commentLength !== 0) throw new Error(ZIP_FAILED);
      const name = central.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      const extra = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      if (size === 0xffffffff || localOffset === 0xffffffff) {
        let cursor = 0;
        let found = false;
        while (cursor + 4 <= extra.length) {
          const id = extra.readUInt16LE(cursor);
          const length = extra.readUInt16LE(cursor + 2);
          if (id === 1) {
            let field = cursor + 4;
            if (size === 0xffffffff) {
              size = Number(extra.readBigUInt64LE(field));
              field += 16;
            }
            if (localOffset === 0xffffffff) localOffset = Number(extra.readBigUInt64LE(field));
            found = true;
            break;
          }
          cursor += 4 + length;
        }
        if (!found) throw new Error(ZIP_FAILED);
      }
      if (localOffset !== expectedOffset) throw new Error(ZIP_FAILED);
      const local = read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== 0) throw new Error(ZIP_FAILED);
      const localName = read(localOffset + 30, local.readUInt16LE(26)).toString('utf8');
      if (localName !== name) throw new Error(ZIP_FAILED);
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (!Number.isSafeInteger(size) || dataOffset + size > centralOffset) throw new Error(ZIP_FAILED);
      entries.push({ name, dataOffset, size, crc });
      expectedOffset = dataOffset + size;
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== central.length || expectedOffset !== centralOffset) throw new Error(ZIP_FAILED);
    return entries;
  } finally {
    fs.closeSync(fd);
  }
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
  /** `write-distro` saves the ElastOS data of the Windows Linux environment. */
  op: 'describe' | 'write' | 'write-distro';
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
