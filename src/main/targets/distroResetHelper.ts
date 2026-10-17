/**
 * The fixed Python helper that Reset runs inside the ElastOS Linux
 * environment. It is passed as one argument to `python3 -c`, with the
 * operation name as the next argument. Every path and name it uses comes in
 * as JSON on stdin, so nothing from the file system is ever part of a
 * command line. The text holds no double quote, backslash, dollar sign, or
 * backtick, so no command-line or shell rule can change it.
 *
 * Operations:
 * - `inspect`: what is at the program, the stage file, and the data folder,
 *   and the install record bytes. Prints JSON.
 * - `measure`: the files a copy holds, with the backup exclusions. Prints JSON.
 * - `zip`: writes a stored zip of the data folder to stdout, with ZIP64 when
 *   needed, and the entry count to stderr. Each file is read twice and must
 *   not change between the reads.
 * - `remove`: checks that nothing changed since `inspect`, then deletes the
 *   program, the stage file, and the data folder. Prints JSON. Exit 3 means
 *   it refused before deleting anything.
 */
export const DISTRO_RESET_HELPER = `
import base64, hashlib, json, os, secrets, shutil, stat, struct, sys, time, zlib
op = sys.argv[1]
req = json.loads(sys.stdin.buffer.read().decode('utf-8', 'surrogateescape') or '{}')
root = req['root']
HEAD_MAX = 64 * 1024
CHUNK = 1024 * 1024
HOLD = '.elastos-removing-'
NL = chr(10)

class Refused(Exception):
    pass

def checked(p):
    if type(p) is not str or not p.startswith('/') or os.path.normpath(p) != p:
        raise Refused('bad path')
    if not p.startswith(root + '/'):
        raise Refused('bad path')
    return p

def kind(p):
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return 'absent'
    except OSError:
        return 'unknown'
    if stat.S_ISLNK(st.st_mode):
        return 'link'
    if stat.S_ISDIR(st.st_mode):
        return 'dir'
    if stat.S_ISREG(st.st_mode):
        return 'file'
    return 'other'

def entries(data):
    out = []
    for name in sorted(os.listdir(data)):
        out.append([name, kind(os.path.join(data, name))])
    return out

def record(data):
    folder = os.path.join(data, 'installation')
    head = os.path.join(folder, 'release-head.json')
    if kind(folder) != 'dir':
        return {'kind': kind(folder)}
    if kind(head) != 'file':
        return {'kind': kind(head)}
    fd = os.open(head, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > HEAD_MAX:
            return {'kind': 'other'}
        raw = os.read(fd, HEAD_MAX + 1)
    finally:
        os.close(fd)
    if len(raw) > HEAD_MAX:
        return {'kind': 'other'}
    return {'kind': 'file', 'text': base64.b64encode(raw).decode('ascii'), 'sha256': hashlib.sha256(raw).hexdigest()}

def excluded(rel, excludes):
    for entry in excludes:
        if rel == entry or rel.startswith(entry + '/'):
            return True
    return False

def walk(data, excludes):
    stack = ['']
    while stack:
        rel = stack.pop()
        full = os.path.join(data, rel) if rel else data
        if rel and excluded(rel, excludes):
            continue
        st = os.lstat(full)
        if stat.S_ISLNK(st.st_mode):
            continue
        if stat.S_ISDIR(st.st_mode):
            for name in os.listdir(full):
                stack.append(rel + '/' + name if rel else name)
            continue
        if stat.S_ISREG(st.st_mode):
            yield rel, full

def arcname(rel):
    return ('elastos/' + rel).encode('utf-8', 'surrogateescape')

def do_inspect():
    data = checked(req['data'])
    out = {'binary': kind(checked(req['binary'])), 'stage': kind(checked(req['stage'])), 'data': kind(data)}
    out['ancestors'] = [[p, kind(checked(p))] for p in req['ancestors']]
    if out['data'] == 'dir':
        out['entries'] = entries(data)
        out['record'] = record(data)
    print(json.dumps(out))

def do_measure():
    data = checked(req['data'])
    if kind(data) == 'absent':
        print(json.dumps({'present': False}))
        return
    if kind(data) != 'dir':
        raise Refused('not a folder')
    files = 0
    size = 0
    names = 0
    for rel, full in walk(data, req['excludes']):
        files += 1
        size += os.lstat(full).st_size
        names += len(arcname(rel))
    print(json.dumps({'present': True, 'files': files, 'bytes': size, 'nameBytes': names}))

def pread_all(fd, size, sink):
    crc = 0
    seen = 0
    while seen < size:
        block = os.pread(fd, min(CHUNK, size - seen), seen)
        if not block:
            raise Refused('a file changed while it was copied')
        crc = zlib.crc32(block, crc)
        if sink is not None:
            sink(block)
        seen += len(block)
    return crc & 0xffffffff

def zip64_extra(size, offset):
    big_size = size > 0xffffffff
    big_offset = offset is not None and offset > 0xffffffff
    if not big_size and not big_offset:
        return b''
    payload = b''
    if big_size:
        payload += struct.pack('<QQ', size, size)
    if big_offset:
        payload += struct.pack('<Q', offset)
    return struct.pack('<HH', 1, len(payload)) + payload

def do_zip():
    data = checked(req['data'])
    if kind(data) != 'dir':
        raise Refused('not a folder')
    out = sys.stdout.buffer
    now = time.localtime()
    dos_time = (now.tm_hour << 11) | (now.tm_min << 5) | (now.tm_sec // 2)
    dos_date = ((now.tm_year - 1980) << 9) | (now.tm_mon << 5) | now.tm_mday
    offset = 0
    centrals = []
    count = 0
    for rel, full in walk(data, req['excludes']):
        name = arcname(rel)
        if len(name) > 0xffff:
            raise Refused('a name is too long')
        fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise Refused('a file changed while it was copied')
            size = st.st_size
            crc = pread_all(fd, size, None)
            extra = zip64_extra(size, None)
            version = 45 if extra else 20
            field = 0xffffffff if extra else size
            local = struct.pack('<IHHHHHIIIHH', 0x04034b50, version, 0x800, 0, dos_time, dos_date, crc, field, field, len(name), len(extra))
            out.write(local + name + extra)
            data_offset = offset + len(local) + len(name) + len(extra)
            again = pread_all(fd, size, out.write)
            if again != crc or os.fstat(fd).st_size != size:
                raise Refused('a file changed while it was copied')
        finally:
            os.close(fd)
        cextra = zip64_extra(size, offset)
        csize = 0xffffffff if size > 0xffffffff else size
        coffset = 0xffffffff if offset > 0xffffffff else offset
        central = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 45 if cextra else 20, version, 0x800, 0, dos_time, dos_date, crc, csize, csize, len(name), len(cextra), 0, 0, 0, 0, coffset)
        centrals.append(central + name + cextra)
        offset = data_offset + size
        count += 1
    start = offset
    central_size = 0
    for part in centrals:
        out.write(part)
        central_size += len(part)
    if count > 0xffff or central_size > 0xffffffff or start > 0xffffffff:
        out.write(struct.pack('<IQHHIIQQQQ', 0x06064b50, 44, 45, 45, 0, 0, count, count, central_size, start))
        out.write(struct.pack('<IIQI', 0x07064b50, 0, start + central_size, 1))
        out.write(struct.pack('<IHHHHIIH', 0x06054b50, 0xffff, 0xffff, 0xffff, 0xffff, 0xffffffff, 0xffffffff, 0))
    else:
        out.write(struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, count, count, central_size, start, 0))
    out.flush()
    sys.stderr.write('ELASTOS-ZIP-ENTRIES ' + str(count) + NL)

def pid_gone(raw):
    if not raw.isdigit():
        return False
    pid = int(raw)
    if pid <= 1:
        return False
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False

def sweep(parent, names):
    try:
        listing = os.listdir(parent)
    except OSError:
        return
    for name in listing:
        if not name.startswith(HOLD):
            continue
        parts = name[len(HOLD):].split('-', 2)
        if len(parts) != 3 or parts[2] not in names:
            continue
        if len(parts[1]) != 16 or any(c not in '0123456789abcdef' for c in parts[1]):
            continue
        if not pid_gone(parts[0]):
            continue
        full = os.path.join(parent, name)
        k = kind(full)
        if k == 'dir':
            shutil.rmtree(full)
        elif k == 'file':
            os.unlink(full)

def do_remove():
    data = checked(req['data'])
    binary = checked(req['binary'])
    stage = checked(req['stage'])
    for p in req['ancestors']:
        if kind(checked(p)) not in ('dir', 'absent'):
            raise Refused('changed')
    for p in (binary, stage):
        if kind(p) not in ('file', 'absent'):
            raise Refused('changed')
    now = kind(data)
    if now != req['dataKind']:
        raise Refused('changed')
    if now == 'dir':
        if entries(data) != req['entries']:
            raise Refused('changed')
        if req['recordSha256'] is not None:
            seen = record(data)
            if seen.get('sha256') != req['recordSha256']:
                raise Refused('changed')
    elif now != 'absent':
        raise Refused('changed')
    removed = []
    for p in (binary, stage):
        if kind(p) == 'file':
            os.unlink(p)
            removed.append(p)
    if now == 'dir':
        parent = os.path.dirname(data)
        holding = os.path.join(parent, HOLD + str(os.getpid()) + '-' + secrets.token_hex(8) + '-' + os.path.basename(data))
        os.rename(data, holding)
        if kind(holding) != 'dir':
            raise OSError('the data folder changed while it was removed')
        shutil.rmtree(holding)
        removed.append(data)
    sweep(os.path.dirname(data), ('elastos',))
    print(json.dumps({'removed': removed}))

try:
    if op == 'inspect':
        do_inspect()
    elif op == 'measure':
        do_measure()
    elif op == 'zip':
        do_zip()
    elif op == 'remove':
        do_remove()
    else:
        raise Refused('unknown operation')
except Refused as err:
    sys.stderr.write('ELASTOS-REFUSED ' + str(err) + NL)
    sys.exit(3)
`.trim();
