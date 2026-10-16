import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'zlib';

const BLOCK = 512;

/** Unpack a gzipped ustar/pax archive under dest. Paths and links cannot escape dest. */
export function extractTarGz(bytes: Buffer, dest: string): void {
  const raw = gunzipSync(bytes);
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  const pax: Record<string, string> = {};
  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new Error('Python archive is damaged.');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = tarSize(header.subarray(124, 136));
    const data = raw.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'K') {
      longLink = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      const parsed = parsePax(data);
      if (type === 'g') Object.assign(pax, parsed);
      else Object.assign(pax, parsed);
      if (type === 'x') continue;
      continue;
    }
    const name = (pax.path || longName || headerName(header)).replace(/^\.\//, '');
    const link = pax.linkpath || longLink || field(header.subarray(157, 257));
    longName = null;
    longLink = null;
    for (const key of ['path', 'linkpath']) delete pax[key];
    if (!name) continue;
    const target = safePath(root, name);
    rejectSymlinks(root, target);
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (type === '2') {
      if (!symlinkStaysInside(root, target, link)) {
        throw new Error('Refusing a Python archive symlink that points outside its folder.');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(link, target);
      continue;
    }
    if (type === '1') {
      const source = safePath(root, link);
      rejectSymlinks(root, source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      continue;
    }
    if (type !== '0') throw new Error('Python archive contains an unexpected entry.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    const mode = tarSize(header.subarray(100, 108)) & 0o777;
    if (mode) fs.chmodSync(target, mode);
  }
}

function headerName(header: Buffer): string {
  const name = field(header.subarray(0, 100));
  const prefix = field(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function field(buf: Buffer): string {
  return buf.toString('utf8').replace(/\0.*$/s, '');
}

function tarSize(buf: Buffer): number {
  if (buf[0] & 0x80) {
    let value = 0;
    for (let i = 1; i < buf.length; i += 1) value = value * 256 + buf[i];
    return value;
  }
  const text = field(buf).trim();
  if (!text) return 0;
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const recorded = parseInt(field(header.subarray(148, 156)).trim(), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === recorded;
}

function parsePax(body: Buffer): Record<string, string> {
  const text = body.toString('utf8');
  const out: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(' ', index);
    if (space < 0) break;
    const length = Number(text.slice(index, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(index, index + length);
    const eq = record.indexOf('=');
    if (eq > space) out[record.slice(space + 1, eq)] = record.slice(eq + 1).replace(/\n$/, '');
    index += length;
  }
  return out;
}

function safePath(root: string, name: string): string {
  if (name.startsWith('/') || name.includes('\0')) {
    throw new Error('Refusing a Python archive path outside its folder.');
  }
  const dest = path.resolve(root, name);
  const base = path.resolve(root);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    throw new Error('Refusing a Python archive path outside its folder.');
  }
  return dest;
}

function rejectSymlinks(root: string, dest: string): void {
  const relative = path.relative(root, dest);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Refusing a Python archive path that uses a symlink.');
    }
  }
}

function symlinkStaysInside(root: string, linkPath: string, target: string): boolean {
  if (!target || path.isAbsolute(target) || target.includes('\0')) return false;
  const resolved = path.resolve(path.dirname(linkPath), target);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}
