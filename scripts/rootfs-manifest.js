#!/usr/bin/env node
/**
 * Make the manifest of what the pinned Ubuntu WSL rootfs puts in /root and
 * /etc/skel, and which user its cloud-init makes, from the rootfs file
 * itself. Windows Uninstall (src/main/targets/windowsUninstall.ts) allows
 * only these outside the data folder.
 *
 *   node scripts/rootfs-manifest.js <ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz>
 *
 * The file must have the pinned SHA-256 (ELASTOS_ROOTFS_SHA256 in
 * src/main/targets/windowsHost.ts). The script prints the manifest as JSON
 * and says whether it equals ROOTFS_MANIFEST in
 * src/main/targets/rootfsManifest.ts (run `npx tsc` first). Exit 1 when not.
 */
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const WANT_FILES = /^(root\/[^/]+|etc\/skel\/[^/]+|etc\/cloud\/cloud\.cfg)$/;
const WANT_DIRS = /^(root|home|etc\/skel)\/[^/]*$|^(root|home)$/;
const MAX_FILE = 1024 * 1024;

function octal(buf, start, len) {
  const text = buf.subarray(start, start + len).toString('latin1').replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
}

function cstr(buf, start, len) {
  return buf.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
}

function paxPath(body) {
  let rest = body.toString('utf8');
  while (rest.length) {
    const space = rest.indexOf(' ');
    const len = parseInt(rest.slice(0, space), 10);
    if (!(len > 0)) break;
    const record = rest.slice(space + 1, len - 1);
    rest = rest.slice(len);
    if (record.startsWith('path=')) return record.slice(5);
  }
  return null;
}

/** Calls onEntry({ name, type, size, mode, body }) for each tar entry; body only for wanted small files. */
async function readTar(file, onEntry) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  let buf = Buffer.alloc(0);
  let need = 512;
  let state = 'header';
  let entry = null;
  let longName = null;
  let paxName = null;
  let skipped = 0;
  for await (const chunk of input) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= need) {
      if (state === 'header') {
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (header.every((b) => b === 0)) { need = 512; continue; }
        const prefix = cstr(header, 345, 155);
        let name = cstr(header, 0, 100);
        if (prefix) name = `${prefix}/${name}`;
        if (longName != null) { name = longName; longName = null; }
        if (paxName != null) { name = paxName; paxName = null; }
        const type = String.fromCharCode(header[156] || 48);
        const size = octal(header, 124, 12);
        const mode = octal(header, 100, 8);
        name = name.replace(/^\.\//, '').replace(/\/$/, '');
        entry = { name, type, size, mode };
        const padded = Math.ceil(size / 512) * 512;
        if (type === 'L' || type === 'x' || (type === '0' && WANT_FILES.test(name) && size <= MAX_FILE)) {
          state = 'body';
          need = padded;
          entry.padded = padded;
        } else {
          onEntry(entry);
          skipped = padded;
          state = 'skip';
          need = 0;
        }
      } else if (state === 'skip') {
        const take = Math.min(skipped, buf.length);
        buf = buf.subarray(take);
        skipped -= take;
        if (skipped === 0) { state = 'header'; need = 512; } else { need = 1; }
      } else {
        const body = Buffer.from(buf.subarray(0, entry.size));
        buf = buf.subarray(entry.padded);
        if (entry.type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
        else if (entry.type === 'x') paxName = paxPath(body);
        else onEntry({ ...entry, body });
        state = 'header';
        need = 512;
      }
    }
  }
}

function defaultUser(cloudCfg) {
  // etc/cloud/cloud.cfg: system_info: default_user: name: <user>
  const match = /\n\s*default_user:\s*\n\s+name:\s*([a-z_][a-z0-9_-]*)\s*\n/.exec(cloudCfg);
  if (!match) throw new Error('etc/cloud/cloud.cfg names no default_user');
  return match[1];
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/rootfs-manifest.js <rootfs.tar.gz>');
    process.exit(2);
  }
  const { ELASTOS_ROOTFS_SHA256 } = require('../dist/main/targets/windowsHost');
  const sha = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  const fileSha = sha.digest('hex');
  if (fileSha !== ELASTOS_ROOTFS_SHA256) {
    console.error(`This file is not the pinned rootfs: SHA-256 ${fileSha}, pin ${ELASTOS_ROOTFS_SHA256}`);
    process.exit(1);
  }
  const manifest = { rootfsSha256: fileSha, rootFiles: {}, rootDirs: [], homeEntries: [], skel: {}, defaultUser: null };
  const others = [];
  await readTar(file, (entry) => {
    const { name, type } = entry;
    if (!WANT_FILES.test(name) && !WANT_DIRS.test(name)) return;
    const describe = () => ({ size: entry.size, sha256: crypto.createHash('sha256').update(entry.body).digest('hex') });
    if (name === 'etc/cloud/cloud.cfg') manifest.defaultUser = defaultUser(entry.body.toString('utf8'));
    else if (name.startsWith('root/') && type === '0') manifest.rootFiles[name.slice(5)] = describe();
    else if (name.startsWith('root/') && type === '5') manifest.rootDirs.push(name.slice(5));
    else if (name.startsWith('home/')) manifest.homeEntries.push(name.slice(5));
    else if (name.startsWith('etc/skel/') && type === '0') manifest.skel[name.slice(9)] = describe();
    else if (name.startsWith('root/') || name.startsWith('etc/skel/')) others.push(`${name} (tar type ${type})`);
  });
  if (others.length) {
    console.error(`The rootfs has entries this manifest cannot describe: ${others.join(', ')}`);
    process.exit(1);
  }
  manifest.rootDirs.sort();
  manifest.homeEntries.sort();
  const text = JSON.stringify(manifest, null, 2);
  console.log(text);
  const { ROOTFS_MANIFEST } = require('../dist/main/targets/rootfsManifest');
  if (JSON.stringify(ROOTFS_MANIFEST, null, 2) === text) {
    console.log('ROOTFS_MANIFEST in src/main/targets/rootfsManifest.ts matches this rootfs.');
  } else {
    console.error('ROOTFS_MANIFEST in src/main/targets/rootfsManifest.ts does not match this rootfs.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
