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
 * - `list`: the names and kinds in each folder asked for (Uninstall uses it
 *   to look for files outside the data folder). Prints JSON.
 * - `remove`: checks that nothing changed since `inspect`, then moves the
 *   data folder aside, deletes the program and the stage file, and then
 *   deletes the moved folder. Prints JSON. Exit 3 means it refused before
 *   it changed anything. Exit 4 means a step failed; the JSON says which
 *   step, and where the data is now.
 *
 * Every delete goes through an open folder: the helper opens each folder
 * with no link followed, checks that it is still the folder it saw (drive,
 * inode, and type) and that it is on the same drive and mount as the data
 * folder, and deletes names only through that open folder. It never enters
 * another drive or mount, so a drive mounted inside the data folder (such as
 * /mnt/c) is never touched. `inspect` reports such names so Reset can refuse
 * before it stops or copies anything.
 */
export const DISTRO_RESET_HELPER = `
import base64, hashlib, json, os, re, secrets, stat, struct, sys, time, zlib
op = sys.argv[1]
req = json.loads(sys.stdin.buffer.read().decode('utf-8', 'surrogateescape') or '{}')
root = req['root']
HEAD_MAX = 64 * 1024
CHUNK = 1024 * 1024
HOLD = '.elastos-removing-'
NL = chr(10)
CLOEXEC = getattr(os, 'O_CLOEXEC', 0)
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | CLOEXEC
LINUX = sys.platform.startswith('linux')

class Refused(Exception):
    pass

class Partial(Exception):
    pass

def checked(p):
    if type(p) is not str or not p.startswith('/') or os.path.normpath(p) != p:
        raise Refused('bad path')
    if not p.startswith(root + '/'):
        raise Refused('bad path')
    return p

def kind_of(st):
    if stat.S_ISLNK(st.st_mode):
        return 'link'
    if stat.S_ISDIR(st.st_mode):
        return 'dir'
    if stat.S_ISREG(st.st_mode):
        return 'file'
    return 'other'

def kind(p):
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return 'absent'
    except OSError:
        return 'unknown'
    return kind_of(st)

def lstat_at(dfd, name):
    return os.stat(name, dir_fd=dfd, follow_symlinks=False)

def kind_at(dfd, name):
    try:
        st = lstat_at(dfd, name)
    except FileNotFoundError:
        return 'absent'
    except OSError:
        return 'unknown'
    return kind_of(st)

def ident(st):
    return (st.st_dev, st.st_ino, stat.S_IFMT(st.st_mode))

def mount_id(fd):
    try:
        with open('/proc/self/fdinfo/' + str(fd), 'r') as f:
            text = f.read()
    except OSError:
        return None
    for line in text.split(NL):
        if line.startswith('mnt_id:'):
            return int(line.split(':', 1)[1].strip())
    return None

def place(fd):
    # The drive and the mount of an open folder. On Linux both must be known.
    mid = mount_id(fd)
    if LINUX and mid is None:
        raise Refused('check')
    return (os.fstat(fd).st_dev, mid)

def open_under_root(p):
    # Open the folder p one name at a time below root, never through a link.
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | CLOEXEC)
    try:
        for part in [x for x in p[len(root) + 1:].split('/') if x]:
            nfd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nfd
    except BaseException:
        os.close(fd)
        raise
    return fd

def open_dir_at(dfd, name, st, base):
    # Open name in dfd only when it is still the folder seen as st, on the drive and mount of base.
    try:
        fd = os.open(name, DIR_FLAGS, dir_fd=dfd)
    except OSError:
        return None
    try:
        if ident(os.fstat(fd)) == ident(st) and place(fd) == base:
            return fd
    except (OSError, Refused):
        pass
    os.close(fd)
    return None

def entries_at(dfd):
    return [[name, kind_at(dfd, name)] for name in sorted(os.listdir(dfd))]

def record_at(dfd):
    k = kind_at(dfd, 'installation')
    if k != 'dir':
        return {'kind': k}
    ifd = os.open('installation', DIR_FLAGS, dir_fd=dfd)
    try:
        k = kind_at(ifd, 'release-head.json')
        if k != 'file':
            return {'kind': k}
        fd = os.open('release-head.json', os.O_RDONLY | os.O_NOFOLLOW | CLOEXEC, dir_fd=ifd)
    finally:
        os.close(ifd)
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

def crossings(dfd, base, rel, out):
    # Names below the open folder dfd that are on another drive or mount, or that changed while they were read.
    for name in sorted(os.listdir(dfd)):
        sub = rel + '/' + name if rel else name
        st = lstat_at(dfd, name)
        if st.st_dev != base[0]:
            out.append(sub)
        elif stat.S_ISDIR(st.st_mode):
            cfd = open_dir_at(dfd, name, st, base)
            if cfd is None:
                out.append(sub)
                continue
            try:
                crossings(cfd, base, sub, out)
            finally:
                os.close(cfd)
    return out

def same_again(dfd, name, st):
    try:
        return ident(lstat_at(dfd, name)) == ident(st)
    except OSError:
        return False

def wipe(dfd, base, rel, left):
    # Delete what is in the open folder dfd, through dfd only. A name on another
    # drive or mount, or one that changed after it was checked, is left and reported.
    for name in os.listdir(dfd):
        sub = rel + '/' + name if rel else name
        try:
            st = lstat_at(dfd, name)
            if st.st_dev != base[0]:
                left.append(sub)
                continue
            if stat.S_ISDIR(st.st_mode):
                cfd = open_dir_at(dfd, name, st, base)
                if cfd is None:
                    left.append(sub)
                    continue
                before = len(left)
                try:
                    wipe(cfd, base, sub, left)
                finally:
                    os.close(cfd)
                if len(left) != before:
                    continue
                if not same_again(dfd, name, st):
                    left.append(sub)
                    continue
                os.rmdir(name, dir_fd=dfd)
            else:
                if not same_again(dfd, name, st):
                    left.append(sub)
                    continue
                os.unlink(name, dir_fd=dfd)
        except OSError:
            left.append(sub)

def remove_folder_at(pfd, name, st, base):
    # Delete the folder name in pfd, seen as st. Returns the names it left.
    left = []
    hfd = open_dir_at(pfd, name, st, base)
    if hfd is None:
        return ['.']
    try:
        wipe(hfd, base, '', left)
    finally:
        os.close(hfd)
    if left:
        return left
    try:
        if not same_again(pfd, name, st):
            return ['.']
        os.rmdir(name, dir_fd=pfd)
    except OSError:
        return ['.']
    return []

def walk(data, rules):
    dev = os.lstat(data).st_dev
    stack = ['']
    while stack:
        rel = stack.pop()
        full = os.path.join(data, rel) if rel else data
        if rel and excluded(rel, rules):
            continue
        st = os.lstat(full)
        if stat.S_ISLNK(st.st_mode) or st.st_dev != dev:
            continue
        if stat.S_ISDIR(st.st_mode):
            for name in os.listdir(full):
                stack.append(rel + '/' + name if rel else name)
            continue
        if stat.S_ISREG(st.st_mode):
            yield rel, full

def whole(pattern, name):
    m = re.match(pattern, name, re.ASCII)
    return m is not None and m.end() == len(name)

def excluded(rel, rules):
    # The rules of backupExcluded in runtimeBackup.ts, sent by the launcher.
    m = re.match(rules['childDataRoot'], rel, re.ASCII)
    inner = rel[m.end():] if m else rel
    for entry in rules['excludes']:
        if inner == entry or inner.startswith(entry + '/'):
            return True
    top = inner.split('/')[0]
    return any(whole(pattern, top) for pattern in rules['leftOutTempNames'])

def arcname(rel):
    return ('elastos/' + rel).encode('utf-8', 'surrogateescape')

def do_inspect():
    data = checked(req['data'])
    out = {'binary': kind(checked(req['binary'])), 'stage': kind(checked(req['stage'])), 'data': kind(data)}
    out['ancestors'] = [[p, kind(checked(p))] for p in req['ancestors']]
    if out['data'] == 'dir':
        try:
            pfd = open_under_root(os.path.dirname(data))
        except OSError:
            out['data'] = 'unknown'
            pfd = None
        if pfd is not None:
            try:
                dfd = os.open(os.path.basename(data), DIR_FLAGS, dir_fd=pfd)
                try:
                    out['entries'] = entries_at(dfd)
                    out['record'] = record_at(dfd)
                    base = place(dfd)
                    out['crossing'] = ['.'] if base != place(pfd) else crossings(dfd, base, '', [])
                finally:
                    os.close(dfd)
            except OSError:
                out['data'] = 'unknown'
            finally:
                os.close(pfd)
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
    for rel, full in walk(data, req['rules']):
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
    for rel, full in walk(data, req['rules']):
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

def sweep(pfd, parent, names):
    # Delete holding folders that an earlier Reset left when it stopped. Returns what is still there.
    left = []
    try:
        base = place(pfd)
        listing = os.listdir(pfd)
    except (OSError, Refused):
        return left
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
        full = parent + '/' + name
        try:
            st = lstat_at(pfd, name)
            if stat.S_ISDIR(st.st_mode):
                if remove_folder_at(pfd, name, st, base):
                    left.append(full)
            elif stat.S_ISREG(st.st_mode):
                os.unlink(name, dir_fd=pfd)
        except OSError:
            left.append(full)
    return left

def unlink_file(p):
    # Delete the plain file p through its open folder. False when it is not there.
    try:
        pfd = open_under_root(os.path.dirname(p))
    except FileNotFoundError:
        return False
    try:
        name = os.path.basename(p)
        try:
            st = lstat_at(pfd, name)
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(st.st_mode):
            raise Refused('changed')
        os.unlink(name, dir_fd=pfd)
        return True
    finally:
        os.close(pfd)

def put_back(pfd, hold, name):
    # Move the data folder back to its own name. False when that cannot be done.
    try:
        lstat_at(pfd, name)
        return False
    except FileNotFoundError:
        pass
    except OSError:
        return False
    try:
        os.rename(hold, name, src_dir_fd=pfd, dst_dir_fd=pfd)
        return True
    except OSError:
        return False

def partial(step, removed, restored, holding, left):
    return Partial({'failed': step, 'removed': removed, 'restored': restored, 'holding': holding, 'left': left[:20]})

def remove_with_data(pfd, data, binary, stage):
    parent = os.path.dirname(data)
    name = os.path.basename(data)
    try:
        dfd = os.open(name, DIR_FLAGS, dir_fd=pfd)
    except OSError:
        raise Refused('changed')
    try:
        seen = os.fstat(dfd)
        base = place(dfd)
        if base != place(pfd):
            raise Refused('mount')
        if entries_at(dfd) != req['entries']:
            raise Refused('changed')
        if req['recordSha256'] is not None and record_at(dfd).get('sha256') != req['recordSha256']:
            raise Refused('changed')
        if crossings(dfd, base, '', []):
            raise Refused('mount')
    finally:
        os.close(dfd)
    # Step 1: move the data aside, in the same folder, so it is on the same drive.
    hold = HOLD + str(os.getpid()) + '-' + secrets.token_hex(8) + '-' + name
    try:
        os.rename(name, hold, src_dir_fd=pfd, dst_dir_fd=pfd)
    except OSError:
        raise partial('move', [], True, None, [])
    if not same_again(pfd, hold, seen):
        if put_back(pfd, hold, name):
            raise Refused('changed')
        raise partial('move', [], False, parent + '/' + hold, [])
    # Step 2: delete the program. If that fails, put the data back.
    removed = []
    try:
        for p in (binary, stage):
            if unlink_file(p):
                removed.append(p)
    except (OSError, Refused):
        back = put_back(pfd, hold, name)
        raise partial('program', removed, back, None if back else parent + '/' + hold, [])
    removed.append(data)
    # Step 3: delete the moved data.
    left = remove_folder_at(pfd, hold, seen, base)
    if left:
        raise partial('delete', removed, False, parent + '/' + hold, left)
    return removed

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
    if now != req['dataKind'] or now not in ('dir', 'absent'):
        raise Refused('changed')
    parent = os.path.dirname(data)
    try:
        pfd = open_under_root(parent)
    except FileNotFoundError:
        if now == 'dir':
            raise Refused('changed')
        pfd = None
    except OSError:
        raise Refused('changed')
    try:
        if now == 'dir':
            removed = remove_with_data(pfd, data, binary, stage)
        else:
            removed = []
            try:
                for p in (binary, stage):
                    if unlink_file(p):
                        removed.append(p)
            except (OSError, Refused):
                raise partial('program', removed, True, None, [])
        left = sweep(pfd, parent, ('elastos',)) if pfd is not None else []
    finally:
        if pfd is not None:
            os.close(pfd)
    if left:
        raise partial('delete', removed, False, left[0], left)
    print(json.dumps({'removed': removed}))

def open_from_top(p):
    # Open the folder p one name at a time from /, never through a link.
    if type(p) is not str or not p.startswith('/') or os.path.normpath(p) != p:
        raise Refused('bad path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | CLOEXEC)
    try:
        for part in [x for x in p.split('/') if x]:
            nfd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nfd
    except BaseException:
        os.close(fd)
        raise
    return fd

def do_list():
    # The names in each folder asked for, or absent, or unknown (a link or an error on the way).
    out = {}
    for p in req['dirs']:
        try:
            fd = open_from_top(p)
        except FileNotFoundError:
            out[p] = 'absent'
            continue
        except OSError:
            out[p] = 'unknown'
            continue
        try:
            out[p] = entries_at(fd)
        except OSError:
            out[p] = 'unknown'
        finally:
            os.close(fd)
    print(json.dumps(out))

try:
    if op == 'inspect':
        do_inspect()
    elif op == 'list':
        do_list()
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
except Partial as err:
    print(json.dumps(err.args[0]))
    sys.exit(4)
`.trim();
