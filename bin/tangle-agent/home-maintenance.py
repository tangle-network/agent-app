#!/usr/bin/env python3
"""The sole writer of the protected agent home. Installed root-owned, invoked
through one exact sudo command with Python -I. No caller paths or environment
choose the home, executable, git configuration, or policy. JSON on stdin/stdout.
"""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import sys
import tempfile

BASE = pathlib.Path('/var/lib/tangle-agent')
ROOT = BASE / 'home'
STATE = BASE / 'state'
CONFIG = pathlib.Path('/etc/tangle-agent/home.json')
GIT = STATE / 'home.git'
FIXED = {'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'BOOTSTRAP.md'}
MAX_FILES = 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_PENDING_BYTES = 1024 * 1024
CAPS = {}
IDENTITY = None
BINDING_FILE = '.tangle-home-binding.json'


def learning_identity(value):
    if not isinstance(value, dict) or set(value) != {'workspaceId', 'stateId', 'scope'}:
        raise ValueError('invalid home learning identity')
    scope = value['scope']
    if not isinstance(scope, dict):
        raise ValueError('invalid home learning scope')
    kind = scope.get('kind')
    subject = 'memberId' if kind == 'personal' else 'groupId' if kind == 'shared' else None
    if subject is None or set(scope) != {'kind', subject, 'agentId'}:
        raise ValueError('invalid home learning scope')
    for field in [value['workspaceId'], value['stateId'], scope[subject], scope['agentId']]:
        if not isinstance(field, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', field):
            raise ValueError('invalid home learning identity field')
    return value


def load_identity(policy):
    # The expected identity is operator-owned configuration outside the volume.
    # Both home and journal carry it, so mixing two restored directories fails
    # closed even when st_dev happens to match. No request can change identity.
    identity = policy.get('identity')
    if identity is not None:
        learning_identity(identity)
    for directory in [ROOT, STATE]:
        marker = directory / BINDING_FILE
        if marker.exists() or marker.is_symlink():
            protected(marker)
            actual = learning_identity(json.loads(marker.read_text(encoding='utf8')))
            if actual != identity:
                raise ValueError('home learning identity does not match the installed volume')
        elif identity is not None:
            raise ValueError('home learning identity marker is missing')
    return identity


def protected(path, directory=False):
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
        raise ValueError('home ownership or permissions are unsafe')
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('home directory is not a directory')
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('home entry must be a root-owned regular file with one link')
    return info


def load_policy():
    global IDENTITY
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError('use the installed privileged home command without arguments')
    for path in [pathlib.Path('/etc'), CONFIG.parent, pathlib.Path('/var'),
                 pathlib.Path('/var/lib'), BASE, ROOT, STATE]:
        protected(path, True)
    if ROOT.stat().st_dev != STATE.stat().st_dev:
        raise ValueError('home and journal must share one persistent filesystem')
    protected(CONFIG)
    policy = json.loads(CONFIG.read_text(encoding='utf8'))
    IDENTITY = load_identity(policy)
    uid = policy.get('runtimeUid')
    if not isinstance(uid, int) or isinstance(uid, bool) or uid <= 0:
        raise ValueError('home runtime identity is invalid')
    # sudo supplies SUDO_UID and the exact-command sudoers grant disallows
    # SETENV. Direct root invocation is reserved for image/operator setup.
    sudo_uid = os.environ.get('SUDO_UID')
    if sudo_uid is not None and sudo_uid != str(uid):
        raise ValueError('this caller does not own this member home')
    caps = policy.get('caps', {})
    if set(caps) != FIXED | {'dailyNote', 'skill'} or any(
        not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > 32768
        for value in caps.values()
    ):
        raise ValueError('home caps are invalid')
    CAPS.update(caps)
    protected(ROOT / 'AGENTS.md')
    if hashlib.sha256((ROOT / 'AGENTS.md').read_bytes()).hexdigest() != policy.get('agentsSha256'):
        raise ValueError('platform AGENTS.md attestation failed')


def checked(name):
    if not isinstance(name, str):
        raise ValueError('home path must be text')
    if name not in FIXED:
        note = re.fullmatch(r'memory/(\d{4}-\d{2}-\d{2})\.md', name)
        skill = re.fullmatch(r'skills/[a-z0-9][a-z0-9-]{0,63}/SKILL\.md', name)
        if note:
            datetime.date.fromisoformat(note.group(1))
        elif not skill:
            raise ValueError('path is outside the home allowlist')
    target = ROOT / name
    current = ROOT
    for component in pathlib.PurePosixPath(name).parts:
        current = current / component
        if current.exists() or current.is_symlink():
            protected(current, current != target)
    return target


def cap(name):
    return CAPS[name] if name in FIXED else CAPS['skill' if name.startswith('skills/') else 'dailyNote']


def bounded(name, content):
    checked(name)
    if not isinstance(content, str) or len(content) > cap(name):
        raise ValueError('home character budget exceeded')
    if len(content.encode('utf8')) > cap(name) * 4:
        raise ValueError('home byte budget exceeded')
    return content


def read(name):
    path = checked(name)
    if not path.exists():
        return ''
    if path.stat().st_size > cap(name) * 4:
        raise ValueError('home byte budget exceeded')
    with path.open('r', encoding='utf8', newline='') as content:
        return bounded(name, content.read())


def paths():
    result = []
    for directory, directories, files in os.walk(ROOT, followlinks=False):
        for child in directories:
            protected(pathlib.Path(directory) / child, True)
        for child in files:
            name = str((pathlib.Path(directory) / child).relative_to(ROOT))
            if name == BINDING_FILE:
                protected(ROOT / name)
                continue
            checked(name)
            result.append(name)
            if len(result) > MAX_FILES:
                raise ValueError('home file-count budget exceeded')
    return sorted(result)


def sync_directory(path):
    directory = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def atomic(path, content, mode=0o444):
    fd, temporary = tempfile.mkstemp(prefix='.home-', dir=STATE)
    try:
        with os.fdopen(fd, 'w', encoding='utf8', newline='') as output:
            output.write(content)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def git(*args, trim=True):
    # Neither the caller's PATH/HOME nor git-related environment is inherited.
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
    result = subprocess.run(['/usr/bin/git', '--git-dir=' + str(GIT), '--work-tree=' + str(ROOT),
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all',
        '-c', 'user.name=Tangle home', '-c', 'user.email=home@localhost', *args],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=20, check=False)
    if result.returncode:
        raise RuntimeError('home git operation failed')
    output = result.stdout.decode('utf8')
    return output.strip() if trim else output


def checkpoint():
    existing = paths()
    if sum(len(read(name).encode('utf8')) for name in existing) > MAX_TOTAL_BYTES:
        raise ValueError('home total-byte budget exceeded')
    tracked = list(filter(None, git('ls-files', '-z').split('\0')))
    selected = sorted(set(existing + tracked))
    for name in selected:
        checked(name)
    if selected:
        git('add', '--all', '--', *selected)
    changed = bool(git('diff', '--cached', '--name-only'))
    if changed:
        git('commit', '-m', 'home: ' + datetime.datetime.now(datetime.timezone.utc).isoformat())
    return {'commit': git('rev-parse', '--verify', 'HEAD'), 'changed': changed}


def validate_updates(updates):
    if not isinstance(updates, dict) or not updates or len(updates) > MAX_FILES:
        raise ValueError('home updates must be a nonempty bounded object')
    for name, value in updates.items():
        checked(name)
        if name == 'AGENTS.md':
            raise ValueError('AGENTS.md is platform-owned')
        if value is not None:
            bounded(name, value)


def apply(updates):
    # Validate the whole change before writing any document. A durable journal
    # finishes the same transaction after a crash instead of mixing two nightly
    # summaries. Neither the journal nor the git metadata is agent-writable.
    validate_updates(updates)
    current = {name: read(name) for name in paths()}
    for name, value in updates.items():
        checked(name)
        if name == 'AGENTS.md':
            raise ValueError('AGENTS.md is platform-owned')
        if value is None:
            current.pop(name, None)
        else:
            current[name] = bounded(name, value)
    if len(current) > MAX_FILES or sum(len(value.encode('utf8')) for value in current.values()) > MAX_TOTAL_BYTES:
        raise ValueError('home total budget exceeded')
    atomic(STATE / 'pending.json', json.dumps(updates, ensure_ascii=False), 0o600)
    return finish_pending()


def finish_pending():
    pending = STATE / 'pending.json'
    if not pending.exists():
        return None
    if protected(pending).st_size > MAX_PENDING_BYTES:
        raise ValueError('home pending journal exceeds its byte budget')
    updates = json.loads(pending.read_text(encoding='utf8'))
    # Even a corrupt operator-restored journal must be rejected in full before
    # recovery touches a document. Valid journals were budgeted before staging.
    validate_updates(updates)
    for name, content in updates.items():
        target = checked(name)
        if name == 'AGENTS.md':
            raise ValueError('AGENTS.md is platform-owned')
        if content is None:
            if target.exists():
                target.unlink()
                sync_directory(target.parent)
        else:
            bounded(name, content)
            parent = ROOT
            for component in pathlib.PurePosixPath(name).parts[:-1]:
                parent = parent / component
                if not parent.exists():
                    parent.mkdir(mode=0o755)
                    parent.chmod(0o755)
                    sync_directory(parent.parent)
                protected(parent, True)
            checked(name)
            atomic(target, content)
    result = checkpoint()
    pending.unlink()
    sync_directory(STATE)
    return result


def portable(name):
    checked(name)
    if name not in {'USER.md', 'MEMORY.md'} and not name.startswith(('memory/', 'skills/')):
        raise ValueError('path is outside portable learning state')
    return name


def snapshot_base(since, head):
    if not isinstance(since, str) or not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', since):
        raise ValueError('snapshot since must be an exact base commit')
    try:
        if git('cat-file', '-t', since) != 'commit':
            raise ValueError('snapshot since must be a commit')
        git('merge-base', '--is-ancestor', since, head)
    except RuntimeError:
        raise ValueError('snapshot base commit is missing or is not an ancestor of the current home') from None
    return since


def deleted_portable_paths(since, head):
    # Git already records removals. Retain absent paths as tombstones so an
    # older imported snapshot cannot silently recreate them. The range belongs
    # to an immutable turn pin, never all lifetime history. Disable rename
    # detection: a moved skill still deleted its old portable path.
    deleted = set(filter(None, git('log', '--format=', '--name-only', '--diff-filter=D',
                                  '--no-renames', '-z', since + '..' + head).split('\0')))
    result = set()
    for name in deleted:
        checked(name)
        if name in {'USER.md', 'MEMORY.md'} or name.startswith(('memory/', 'skills/')):
            result.add(name)
    if len(result) > MAX_FILES:
        raise ValueError('portable home history exceeds the snapshot file-count budget')
    return result


def portable_inventory(since, head):
    existing = set(paths())
    names = {name for name in existing | deleted_portable_paths(since, head)
             if name in {'USER.md', 'MEMORY.md'} or name.startswith(('memory/', 'skills/'))}
    if len(names) > MAX_FILES:
        raise ValueError('portable home history exceeds the snapshot file-count budget')
    return existing, names


def portable_snapshot(commit, since):
    existing, names = portable_inventory(since, commit)
    files = [{'path': name, 'content': git('show', commit + ':' + name, trim=False)
              if name in existing else None} for name in sorted(names)]
    if sum(len((file['content'] or '').encode('utf8')) for file in files) > MAX_TOTAL_BYTES:
        raise ValueError('home total-byte budget exceeded')
    return {'commit': commit, 'since': since, 'files': files}


def expect_head(request):
    expected = request.get('expectedHead')
    if not isinstance(expected, str) or not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', expected):
        raise ValueError('expectedHead is required; read the current home commit before replacing or deleting files')
    if expected != git('rev-parse', '--verify', 'HEAD'):
        raise ValueError('home changed; reread the current snapshot before retrying')


def receipt(result):
    # A local fsynced Git checkpoint is not evidence of remote persistence or a
    # successful sandbox-volume restore. The host must attest those separately.
    return {**result, 'identity': IDENTITY, 'checkpointScope': 'local'}


def main():
    load_policy()
    os.umask(0o077)
    raw = sys.stdin.buffer.read(262145)
    if len(raw) > 262144:
        raise ValueError('home command input exceeds 262144 bytes')
    request = json.loads(raw)
    fields = {'status': set(), 'snapshot': set(), 'commit': set(), 'bootstrap': set(), 'read': {'path'},
              'write': {'path', 'content', 'expectedHead'}, 'append': {'path', 'content'},
              'delete': {'path', 'expectedHead'}, 'reconcile': {'updates', 'expectedHead'},
              'consolidate': {'user', 'memory', 'expectedHead'}}
    if not isinstance(request, dict) or request.get('action') not in fields:
        raise ValueError('unknown home operation')
    action = request['action']
    if action in {'write', 'delete', 'reconcile', 'consolidate'} and 'expectedHead' not in request:
        raise ValueError('expectedHead is required; read the current home commit before replacing or deleting files')
    required = {'action'} | fields[action]
    optional = {'since'} if action in {'snapshot', 'reconcile'} else set()
    if not required <= set(request) or not set(request) <= required | optional:
        raise ValueError('invalid home operation fields')
    lock = STATE / 'home.lock'
    with lock.open('a') as handle:
        protected(lock)
        fcntl.flock(handle, fcntl.LOCK_EX)
        if not GIT.exists():
            git('init')
        protected(GIT, True)
        finish_pending()
        if action == 'snapshot':
            if 'since' in request:
                snapshot_base(request['since'], git('rev-parse', '--verify', 'HEAD'))
            # Reconcile any operator-updated seed before naming a revision;
            # export the committed bytes, not an uncheckpointed filesystem view.
            current_commit = checkpoint()['commit']
            return receipt(portable_snapshot(current_commit, request.get('since', current_commit)))
        if action == 'read':
            return receipt({'path': request['path'], 'content': read(request['path']),
                    'commit': git('rev-parse', '--verify', 'HEAD')})
        if action in {'write', 'append', 'delete'}:
            if action != 'append':
                expect_head(request)
            name = request['path']
            content = None if action == 'delete' else request['content']
            if action != 'delete' and not isinstance(content, str):
                raise ValueError('home content must be text')
            if action == 'append':
                content = read(name) + content
            result = apply({name: content})
            return receipt({**result, 'path': name, 'ownerNoticeRequired': name == 'SOUL.md'})
        if action == 'reconcile':
            expect_head(request)
            since = snapshot_base(request.get('since', request['expectedHead']), request['expectedHead'])
            updates = request['updates']
            if not isinstance(updates, dict):
                raise ValueError('home updates must be a nonempty bounded object')
            for name in updates:
                portable(name)
            _existing, names = portable_inventory(since, request['expectedHead'])
            if len(names | set(updates)) > MAX_FILES:
                raise ValueError('portable home history exceeds the snapshot file-count budget')
            for name, value in updates.items():
                if value is None and name not in names:
                    raise ValueError('cannot persist deletion of a never-tracked portable path in this snapshot range')
            result = apply(updates)
            return receipt({**result, **portable_snapshot(result['commit'], since)})
        if action == 'bootstrap':
            if not read('IDENTITY.md').strip():
                raise ValueError('fill IDENTITY.md before completing bootstrap')
            return receipt(apply({'BOOTSTRAP.md': None}))
        if action == 'consolidate':
            expect_head(request)
            return receipt(apply({'USER.md': bounded('USER.md', request['user']),
                                  'MEMORY.md': bounded('MEMORY.md', request['memory'])}))
        result = checkpoint()
        if action == 'status':
            result['files'] = [{'path': name, 'characters': len(read(name)),
                'sha256': hashlib.sha256(read(name).encode('utf8')).hexdigest()} for name in paths()]
        return receipt(result)


if __name__ == '__main__':
    signal.alarm(30)
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        # Do not reflect file bodies, request data, or subprocess diagnostics.
        print(json.dumps({'error': str(error) if isinstance(error, (ValueError, RuntimeError))
                         else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
