import { createHash, createPublicKey, timingSafeEqual, verify } from 'crypto';

const DOMAIN = 'elastos.release.head.v1';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export class ReleaseHeadError extends Error {
  readonly code = 'RUNTIME_RELEASE_HEAD';

  constructor(message: string) {
    super(message);
    this.name = 'ReleaseHeadError';
  }
}

/** SHA-256 of the exact installer bytes, lowercase hex. */
export function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Equals(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

/**
 * Verify a release-head envelope the way install.sh does:
 * SHA256(domain + NUL + canonical payload), then Ed25519 against the did:key.
 * Duplicate JSON keys are rejected. A wrong DID or a tampered payload throws.
 */
export function verifyReleaseHead(text: string, expectedDid: string): {
  channel: string;
  version: string;
  latestReleaseCid: string;
  signerDid: string;
} {
  let envelope: unknown;
  try {
    envelope = parseJsonUnique(text);
  } catch (err) {
    throw new ReleaseHeadError(err instanceof Error ? err.message : 'Release head is not valid JSON.');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new ReleaseHeadError('Release head must be a JSON object.');
  }
  const record = envelope as Record<string, unknown>;
  const signer = record.signer_did;
  if (typeof signer !== 'string' || signer !== expectedDid) {
    throw new ReleaseHeadError('Envelope signer differs from the pinned maintainer DID.');
  }
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReleaseHeadError('Release payload must be a JSON object.');
  }
  const body = payload as Record<string, unknown>;
  if ('signer_did' in body && body.signer_did !== signer) {
    throw new ReleaseHeadError('Payload and envelope signer differ.');
  }
  const signature = record.signature;
  if (typeof signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signature)) {
    throw new ReleaseHeadError('Signature must contain 64 hex-encoded bytes.');
  }
  const digest = createHash('sha256')
    .update(Buffer.concat([Buffer.from(`${DOMAIN}\0`), Buffer.from(canonicalJson(body), 'utf8')]))
    .digest();
  const ok = verify(null, digest, didKeyToPublic(signer), Buffer.from(signature, 'hex'));
  if (!ok) {
    throw new ReleaseHeadError('Release head signature does not match the pinned maintainer DID.');
  }
  return {
    channel: typeof body.channel === 'string' ? body.channel : '',
    version: typeof body.version === 'string' ? body.version : '',
    latestReleaseCid: typeof body.latest_release_cid === 'string' ? body.latest_release_cid : '',
    signerDid: signer,
  };
}

/** Compact sorted JSON, matching the publisher's json.dumps(sort_keys=True, separators). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ReleaseHeadError('Release JSON numbers must be safe integers.');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new ReleaseHeadError('Release JSON has an unsupported value.');
}

function didKeyToPublic(did: string) {
  if (!did.startsWith('did:key:z')) {
    throw new ReleaseHeadError('Expected an Ed25519 did:key with base58btc encoding.');
  }
  const raw = decodeBase58(did.slice('did:key:z'.length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) {
    throw new ReleaseHeadError('DID key must use the Ed25519 multicodec.');
  }
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw.subarray(2)]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

function decodeBase58(text: string): Buffer {
  if (text.length < 1 || text.length > 64) {
    throw new ReleaseHeadError('Invalid DID key length.');
  }
  let number = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new ReleaseHeadError('Invalid DID key length.');
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let raw = hex === '0' ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let pad = 0;
  for (const char of text) {
    if (char !== '1') break;
    pad += 1;
  }
  if (pad) raw = Buffer.concat([Buffer.alloc(pad), raw]);
  return raw;
}

export function parseJsonUnique(text: string): unknown {
  let index = 0;
  const skip = () => {
    while (index < text.length && ' \n\r\t'.includes(text[index])) index += 1;
  };
  const parseValue = (): unknown => {
    skip();
    const char = text[index];
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === 't') return parseLiteral('true', true);
    if (char === 'f') return parseLiteral('false', false);
    if (char === 'n') return parseLiteral('null', null);
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    throw new ReleaseHeadError('Release head is not valid JSON.');
  };
  const parseObject = (): Record<string, unknown> => {
    index += 1;
    const result: Record<string, unknown> = {};
    skip();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    for (;;) {
      skip();
      if (text[index] !== '"') throw new ReleaseHeadError('Release head is not valid JSON.');
      const key = parseString();
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        throw new ReleaseHeadError(`Duplicate JSON field: ${key}`);
      }
      skip();
      if (text[index] !== ':') throw new ReleaseHeadError('Release head is not valid JSON.');
      index += 1;
      result[key] = parseValue();
      skip();
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      if (text[index] !== ',') throw new ReleaseHeadError('Release head is not valid JSON.');
      index += 1;
    }
  };
  const parseArray = (): unknown[] => {
    index += 1;
    const result: unknown[] = [];
    skip();
    if (text[index] === ']') {
      index += 1;
      return result;
    }
    for (;;) {
      result.push(parseValue());
      skip();
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      if (text[index] !== ',') throw new ReleaseHeadError('Release head is not valid JSON.');
      index += 1;
    }
  };
  const parseString = (): string => {
    index += 1;
    let out = '';
    while (index < text.length) {
      const char = text[index];
      index += 1;
      if (char === '"') return out;
      if (char === '\\') {
        const escaped = text[index];
        index += 1;
        if (escaped === '"' || escaped === '\\' || escaped === '/') out += escaped;
        else if (escaped === 'b') out += '\b';
        else if (escaped === 'f') out += '\f';
        else if (escaped === 'n') out += '\n';
        else if (escaped === 'r') out += '\r';
        else if (escaped === 't') out += '\t';
        else if (escaped === 'u') {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ReleaseHeadError('Release head is not valid JSON.');
          out += String.fromCharCode(parseInt(hex, 16));
          index += 4;
        } else throw new ReleaseHeadError('Release head is not valid JSON.');
      } else {
        out += char;
      }
    }
    throw new ReleaseHeadError('Release head has an unterminated string.');
  };
  const parseLiteral = (word: string, value: unknown): unknown => {
    if (text.slice(index, index + word.length) !== word) {
      throw new ReleaseHeadError('Release head is not valid JSON.');
    }
    index += word.length;
    return value;
  };
  const parseNumber = (): number => {
    const start = index;
    if (text[index] === '-') index += 1;
    if (text[index] === '0') index += 1;
    else if (text[index] >= '1' && text[index] <= '9') {
      while (text[index] >= '0' && text[index] <= '9') index += 1;
    } else throw new ReleaseHeadError('Release head is not valid JSON.');
    if (text[index] === '.' || text[index] === 'e' || text[index] === 'E') {
      throw new ReleaseHeadError('Release JSON numbers must be safe integers.');
    }
    const value = Number(text.slice(start, index));
    if (!Number.isSafeInteger(value)) throw new ReleaseHeadError('Release JSON numbers must be safe integers.');
    return value;
  };
  const value = parseValue();
  skip();
  if (index !== text.length) throw new ReleaseHeadError('Release head has trailing data.');
  return value;
}

/** Drop installer overrides so a parent environment cannot retarget the script. */
export function installerChildEnv(parent: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...parent };
  delete env.ELASTOS_MAINTAINER_DID;
  delete env.ELASTOS_PUBLISHER_GATEWAY;
  delete env.ELASTOS_HEAD_CID;
  return env;
}
