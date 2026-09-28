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
CAPS = {}


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
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError('use the installed privileged home command without arguments')
    for path in [pathlib.Path('/etc'), CONFIG.parent, pathlib.Path('/var'),
                 pathlib.Path('/var/lib'), BASE, ROOT, STATE]:
        protected(path, True)
    if ROOT.stat().st_dev != STATE.stat().st_dev:
        raise ValueError('home and journal must share one persistent filesystem')
    protected(CONFIG)
    policy = json.loads(CONFIG.read_text(encoding='utf8'))
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
    return bounded(name, path.read_text(encoding='utf8'))


def paths():
    result = []
    for directory, directories, files in os.walk(ROOT, followlinks=False):
        for child in directories:
            protected(pathlib.Path(directory) / child, True)
        for child in files:
            name = str((pathlib.Path(directory) / child).relative_to(ROOT))
            checked(name)
            result.append(name)
            if len(result) > MAX_FILES:
                raise ValueError('home file-count budget exceeded')
    return sorted(result)


def atomic(path, content, mode=0o444):
    fd, temporary = tempfile.mkstemp(prefix='.home-', dir=STATE)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as output:
            output.write(content)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def git(*args):
    # Neither the caller's PATH/HOME nor git-related environment is inherited.
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
    result = subprocess.run(['/usr/bin/git', '--git-dir=' + str(GIT), '--work-tree=' + str(ROOT),
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all',
        '-c', 'user.name=Tangle home', '-c', 'user.email=home@localhost', *args],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=20, check=False)
    if result.returncode:
        raise RuntimeError('home git operation failed')
    return result.stdout.strip()


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


def apply(updates):
    # Validate the whole change before writing any document. A durable journal
    # finishes the same transaction after a crash instead of mixing two nightly
    # summaries. Neither the journal nor the git metadata is agent-writable.
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
    protected(pending)
    updates = json.loads(pending.read_text(encoding='utf8'))
    for name, content in updates.items():
        target = checked(name)
        if name == 'AGENTS.md':
            raise ValueError('AGENTS.md is platform-owned')
        if content is None:
            if target.exists():
                target.unlink()
        else:
            bounded(name, content)
            parent = ROOT
            for component in pathlib.PurePosixPath(name).parts[:-1]:
                parent = parent / component
                if not parent.exists():
                    parent.mkdir(mode=0o755)
                    parent.chmod(0o755)
                protected(parent, True)
            checked(name)
            atomic(target, content)
    result = checkpoint()
    pending.unlink()
    return result


def main():
    load_policy()
    os.umask(0o077)
    raw = sys.stdin.buffer.read(262145)
    if len(raw) > 262144:
        raise ValueError('home command input exceeds 262144 bytes')
    request = json.loads(raw)
    fields = {'status': set(), 'commit': set(), 'bootstrap': set(), 'read': {'path'},
              'write': {'path', 'content'}, 'append': {'path', 'content'}, 'delete': {'path'},
              'consolidate': {'user', 'memory', 'expectedHead'}}
    if not isinstance(request, dict) or request.get('action') not in fields:
        raise ValueError('unknown home operation')
    action = request['action']
    if set(request) != {'action'} | fields[action]:
        raise ValueError('invalid home operation fields')
    lock = STATE / 'home.lock'
    with lock.open('a') as handle:
        protected(lock)
        fcntl.flock(handle, fcntl.LOCK_EX)
        if not GIT.exists():
            git('init')
        protected(GIT, True)
        finish_pending()
        if action == 'read':
            return {'path': request['path'], 'content': read(request['path']),
                    'commit': git('rev-parse', '--verify', 'HEAD')}
        if action in {'write', 'append', 'delete'}:
            name = request['path']
            content = None if action == 'delete' else request['content']
            if action == 'append':
                content = read(name) + content
            result = apply({name: content})
            return {**result, 'path': name, 'ownerNoticeRequired': name == 'SOUL.md'}
        if action == 'bootstrap':
            if not read('IDENTITY.md').strip():
                raise ValueError('fill IDENTITY.md before completing bootstrap')
            return apply({'BOOTSTRAP.md': None})
        if action == 'consolidate':
            if request['expectedHead'] != git('rev-parse', '--verify', 'HEAD'):
                raise ValueError('home changed; reread notes before consolidating')
            return apply({'USER.md': request['user'], 'MEMORY.md': request['memory']})
        result = checkpoint()
        if action == 'status':
            result['files'] = [{'path': name, 'characters': len(read(name)),
                'sha256': hashlib.sha256(read(name).encode('utf8')).hexdigest()} for name in paths()]
        return result


if __name__ == '__main__':
    signal.alarm(30)
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        # Do not reflect file bodies, request data, or subprocess diagnostics.
        print(json.dumps({'error': str(error) if isinstance(error, (ValueError, RuntimeError))
                         else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
