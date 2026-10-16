import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';

/**
 * The pinned install.sh calls curl and sha256sum. This file is copied out of
 * the app and run with the app's own Node (ELECTRON_RUN_AS_NODE). It uses
 * only Node built-ins so it still runs from a real path when the app is packed.
 */

export interface CurlRun {
  code: number;
  stderr: string;
}

export interface CurlDeps {
  fetch: typeof fetch;
  writeFile: (file: string, data: Buffer) => void;
  stdout: Writable;
  sleep: (ms: number) => Promise<void>;
}

interface CurlCall {
  url: string;
  output: string | null;
  fail: boolean;
  location: boolean;
  proto: string | null;
  protoRedir: string | null;
  maxRedirs: number | null;
  maxTimeSec: number | null;
  retry: number;
  retryAllErrors: boolean;
  retryDelaySec: number;
  connectTimeoutSec: number | null;
  speedLimit: number | null;
  speedTimeSec: number | null;
}

const VALUE_FLAGS = new Set([
  'proto',
  'proto-redir',
  'max-redirs',
  'max-time',
  'retry',
  'retry-delay',
  'connect-timeout',
  'speed-limit',
  'speed-time',
  'output',
]);

export function formatSha256Sum(file: string, bytes: Buffer): string {
  const hex = createHash('sha256').update(bytes).digest('hex');
  return `${hex}  ${file}\n`;
}

export async function runCurl(argv: readonly string[], deps: CurlDeps): Promise<CurlRun> {
  const parsed = parseCurl(argv);
  if (parsed.error) return { code: 2, stderr: parsed.error };
  const call = parsed.call as CurlCall;
  const attempts = Math.max(1, call.retry + 1);
  let last: CurlRun = { code: 7, stderr: '' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await curlOnce(call, deps);
    if (last.code === 0 || last.code === 1) return last;
    const retryable = call.retryAllErrors || last.code === 7 || last.code === 28;
    if (!retryable || attempt === attempts) return last;
    if (call.retryDelaySec > 0) await deps.sleep(call.retryDelaySec * 1000);
  }
  return last;
}

async function curlOnce(call: CurlCall, deps: CurlDeps): Promise<CurlRun> {
  if (!protocolAllowed(call.url, call.proto)) {
    return { code: 1, stderr: 'protocol refused\n' };
  }
  const controller = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  if (call.maxTimeSec && call.maxTimeSec > 0) {
    timers.push(setTimeout(() => controller.abort(), call.maxTimeSec * 1000));
  }
  let connectTimer: NodeJS.Timeout | null = null;
  if (call.connectTimeoutSec && call.connectTimeoutSec > 0) {
    connectTimer = setTimeout(() => controller.abort(), call.connectTimeoutSec * 1000);
    timers.push(connectTimer);
  }
  try {
    let current = call.url;
    let followed = 0;
    const limit = call.maxRedirs == null ? (call.location ? 50 : 0) : call.maxRedirs;
    for (;;) {
      const response = await deps.fetch(current, { redirect: 'manual', signal: controller.signal });
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (!call.location || followed >= limit) {
          await response.body?.cancel();
          return { code: call.location ? 47 : 0, stderr: '' };
        }
        const next = new URL(response.headers.get('location') as string, current).href;
        await response.body?.cancel();
        if (!protocolAllowed(next, call.protoRedir ?? call.proto)) {
          return { code: 1, stderr: 'protocol refused\n' };
        }
        followed += 1;
        current = next;
        continue;
      }
      if (call.fail && response.status >= 400) {
        await response.body?.cancel();
        return { code: 22, stderr: `HTTP ${response.status}\n` };
      }
      const body = await readLimited(response, call, controller.signal);
      if (body === 'slow' || body === 'aborted') return { code: 28, stderr: 'transfer too slow\n' };
      if (call.output) deps.writeFile(call.output, body);
      else deps.stdout.write(body);
      return { code: 0, stderr: '' };
    }
  } catch (err) {
    if (isAbort(err)) return { code: 28, stderr: 'timed out\n' };
    return { code: 7, stderr: 'download failed\n' };
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

async function readLimited(
  response: Response,
  call: CurlCall,
  signal: AbortSignal,
): Promise<Buffer | 'slow' | 'aborted'> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const started = Date.now();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) return 'aborted';
      const step = await reader.read();
      if (step.done) return Buffer.concat(chunks);
      const chunk = Buffer.from(step.value);
      chunks.push(chunk);
      bytes += chunk.length;
      if (call.speedLimit != null && call.speedTimeSec != null && call.speedTimeSec > 0) {
        const elapsed = (Date.now() - started) / 1000;
        if (elapsed >= call.speedTimeSec && bytes / elapsed < call.speedLimit) {
          await reader.cancel();
          return 'slow';
        }
      }
    }
  } catch (err) {
    if (isAbort(err)) return 'aborted';
    throw err;
  }
}

function parseCurl(argv: readonly string[]): { call?: CurlCall; error?: string } {
  const call: CurlCall = {
    url: '',
    output: null,
    fail: false,
    location: false,
    proto: null,
    protoRedir: null,
    maxRedirs: null,
    maxTimeSec: null,
    retry: 0,
    retryAllErrors: false,
    retryDelaySec: 0,
    connectTimeoutSec: null,
    speedLimit: null,
    speedTimeSec: null,
    };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
      const inline = eq === -1 ? null : arg.slice(eq + 1);
      if (key === 'fail') call.fail = true;
      else if (key === 'silent') { /* progress stays off */ }
      else if (key === 'show-error') { /* errors already go to stderr */ }
      else if (key === 'location') call.location = true;
      else if (key === 'tlsv1.2' || key === 'progress-bar' || key === 'retry-all-errors') {
        if (key === 'retry-all-errors') call.retryAllErrors = true;
      } else if (VALUE_FLAGS.has(key)) {
        const taken = takeValue(argv, i, inline);
        if (taken.error) return { error: taken.error };
        i = taken.index;
        assignValue(call, key, taken.value as string);
      } else {
        return { error: `unsupported option ${arg}\n` };
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const cluster = arg.slice(1);
      let consumed = false;
      for (let c = 0; c < cluster.length; c += 1) {
        const flag = cluster[c];
        if (flag === 'f') call.fail = true;
        else if (flag === 's' || flag === 'S') { /* silent / show error */ }
        else if (flag === 'L') call.location = true;
        else if (flag === 'o') {
          const rest = cluster.slice(c + 1);
          if (rest) call.output = rest;
          else {
            const next = argv[i + 1];
            if (!next) return { error: 'missing output file\n' };
            call.output = next;
            i += 1;
          }
          consumed = true;
          break;
        } else {
          return { error: `unsupported option -${flag}\n` };
        }
      }
      if (consumed) continue;
      continue;
    }
    positionals.push(arg);
  }
  if (positionals.length === 0) return { error: 'missing url\n' };
  call.url = positionals[positionals.length - 1];
  return { call };
}

function takeValue(
  argv: readonly string[],
  index: number,
  inline: string | null,
): { value?: string; index: number; error?: string } {
  if (inline != null) return { value: inline, index };
  const next = argv[index + 1];
  if (!next) return { index, error: 'missing option value\n' };
  return { value: next, index: index + 1 };
}

function assignValue(call: CurlCall, key: string, value: string): void {
  if (key === 'proto') call.proto = value;
  else if (key === 'proto-redir') call.protoRedir = value;
  else if (key === 'output') call.output = value;
  else if (key === 'max-redirs') call.maxRedirs = numberValue(value);
  else if (key === 'max-time') call.maxTimeSec = numberValue(value);
  else if (key === 'retry') call.retry = numberValue(value);
  else if (key === 'retry-delay') call.retryDelaySec = numberValue(value);
  else if (key === 'connect-timeout') call.connectTimeoutSec = numberValue(value);
  else if (key === 'speed-limit') call.speedLimit = numberValue(value);
  else if (key === 'speed-time') call.speedTimeSec = numberValue(value);
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** curl --proto '=https' allows only that scheme. A mismatch is exit 1. */
export function protocolAllowed(url: string, proto: string | null): boolean {
  if (!proto) return true;
  let scheme = '';
  try {
    scheme = new URL(url).protocol.replace(':', '').toLowerCase();
  } catch {
    return false;
  }
  const spec = proto.startsWith('=') ? proto.slice(1) : proto;
  const allowed = spec.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(scheme);
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError';
}

function defaultDeps(): CurlDeps {
  return {
    fetch,
    writeFile: (file, data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    },
    stdout: process.stdout,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

async function sha256sumCli(args: readonly string[]): Promise<number> {
  if (args.length === 0) {
    process.stderr.write('missing file\n');
    return 1;
  }
  for (const file of args) {
    if (file.startsWith('-')) {
      process.stderr.write('unsupported option\n');
      return 2;
    }
    try {
      process.stdout.write(formatSha256Sum(file, fs.readFileSync(file)));
    } catch {
      process.stderr.write(`cannot read ${file}\n`);
      return 1;
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] !== '--elastos-tool') return 2;
  if (argv[1] === 'curl') {
    const result = await runCurl(argv.slice(2), defaultDeps());
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  if (argv[1] === 'sha256sum') return sha256sumCli(argv.slice(2));
  return 127;
}

if (require.main === module) {
  main().then((code) => {
    process.exit(code);
  }).catch(() => {
    process.exit(1);
  });
}
