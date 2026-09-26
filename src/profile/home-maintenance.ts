/** Runs inside the existing sandbox. It has no network client and does not seed another home. */
export const HOME_MAINTENANCE = String.raw`#!/usr/bin/env python3
"""Bounded home maintenance. JSON input/output; diagnostics never contain file bodies.
This command enforces its own write contract. It is not a filesystem security boundary.
"""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE = ROOT / '.tangle'
GIT = STATE / 'home.git'
CAPS = {'AGENTS.md': 12000, 'SOUL.md': 8000, 'IDENTITY.md': 4000,
        'USER.md': 4000, 'MEMORY.md': 16000, 'BOOTSTRAP.md': 8000}


def checked(path):
    """Only regular, unlinked home files. Never follow a symlink out of the home."""
    if not isinstance(path, str):
        raise ValueError('path must be a string')
    if path not in CAPS:
        match = re.fullmatch(r'memory/(\d{4}-\d{2}-\d{2})\.md', path)
        if not match:
            raise ValueError('path is outside the home allowlist')
        datetime.date.fromisoformat(match.group(1))
    candidate = ROOT / path
    cursor = ROOT
    for part in pathlib.PurePosixPath(path).parts:
        cursor = cursor / part
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('home paths cannot contain symlinks')
        if cursor == candidate and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise ValueError('home entries must be regular files with one link')
    return candidate


def bounded(path, content):
    if not isinstance(content, str):
        raise ValueError('content must be text')
    limit = CAPS.get(path, 12000)
    # Code points, not UTF-16 units or UTF-8 bytes: a Spanish/Japanese preference
    # gets the same 4,000-character USER.md limit as an English preference.
    if len(content) > limit or len(content.encode('utf-8')) > 4 * limit:
        raise ValueError('home character budget exceeded: ' + path)
    return content


def read(path):
    target = checked(path)
    if not target.exists():
        return ''
    with target.open('r', encoding='utf-8') as source:
        content = source.read(CAPS.get(path, 12000) + 1)
    return bounded(path, content)


def write(path, content):
    if path == 'AGENTS.md':
        raise ValueError('AGENTS.md is platform-owned and cannot be edited by the home command')
    target = checked(path)
    bounded(path, content)
    target.parent.mkdir(parents=True, exist_ok=True)
    checked(path)
    fd, temp = tempfile.mkstemp(prefix='.home-write-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        checked(path)
        os.replace(temp, target)
        directory = os.open(target.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def paths():
    values = list(CAPS)
    notes = ROOT / 'memory'
    if notes.exists():
        if notes.is_symlink() or not notes.is_dir():
            raise ValueError('memory must be a directory, not a link')
        for child in sorted(notes.iterdir()):
            if child.name.endswith('.md'):
                checked('memory/' + child.name)
                values.append('memory/' + child.name)
    return values


def git(*args):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
    command = ['git', '--git-dir=' + str(GIT), '--work-tree=' + str(ROOT),
               '-c', 'core.hooksPath=' + os.devnull, '-c', 'core.fsmonitor=false',
               '-c', 'user.name=Tangle home', '-c', 'user.email=home@localhost', *args]
    result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError('home git command failed with exit ' + str(result.returncode))
    return result.stdout.strip()


def init():
    if STATE.is_symlink() or not STATE.is_dir():
        raise ValueError('home maintenance directory is invalid')
    if GIT.is_symlink():
        raise ValueError('home git directory cannot be a symlink')
    if not GIT.exists():
        git('init')
    if not GIT.is_dir():
        raise ValueError('home git directory is invalid')
    # Do not run repository-provided hooks or refresh an inherited index.
    for name in ['config', 'index', 'HEAD', 'objects', 'refs']:
        item = GIT / name
        if item.is_symlink():
            raise ValueError('home git metadata cannot be symlinked')
    tracked = git('ls-files', '-z').split('\0')
    for path in filter(None, tracked):
        checked(path)
    (ROOT / 'memory').mkdir(exist_ok=True)


def commit():
    init()
    existing = []
    for path in paths():
        if checked(path).exists():
            read(path)
            existing.append(path)
    # This separate index cannot stage code, credentials, harness logs or browser state.
    git('add', '--all', '--', *[path for path in CAPS if checked(path).exists() or path in git('ls-files').splitlines()], 'memory')
    changes = git('diff', '--cached', '--name-only')
    if changes:
        git('commit', '-m', 'home: ' + datetime.datetime.now(datetime.timezone.utc).isoformat())
    heads = subprocess.run(['git', '--git-dir=' + str(GIT), 'rev-parse', '--verify', 'HEAD'],
                           text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    return {'commit': heads.stdout.strip() if heads.returncode == 0 else None,
            'changed': bool(changes), 'paths': existing}


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else 'status'
    if action not in {'status', 'read', 'write', 'append', 'commit', 'bootstrap', 'consolidate'}:
        raise ValueError('unknown home operation')
    STATE.mkdir(exist_ok=True)
    if STATE.is_symlink():
        raise ValueError('home maintenance directory cannot be a symlink')
    lock_path = STATE / 'home.lock'
    if lock_path.is_symlink():
        raise ValueError('home lock cannot be a symlink')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        init()
        if action in {'read', 'write', 'append', 'consolidate'}:
            raw = sys.stdin.read(1_048_577)
            if len(raw) > 1_048_576:
                raise ValueError('home command input is too large')
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError('home command input must be an object')
        if action == 'read':
            return {'path': data['path'], 'content': read(data['path'])}
        if action in {'write', 'append'}:
            path = data['path']
            content = data['content']
            if action == 'append':
                content = read(path) + content
            write(path, content)
            result = {'path': path, 'characters': len(content)}
            if path == 'SOUL.md':
                result['ownerNoticeRequired'] = True
            return result
        if action == 'consolidate':
            # The agent produces the curated text. Validate both documents before either write.
            user = bounded('USER.md', data['user'])
            memory = bounded('MEMORY.md', data['memory'])
            write('USER.md', user)
            write('MEMORY.md', memory)
            return commit()
        if action == 'bootstrap':
            if not read('IDENTITY.md').strip():
                raise ValueError('fill IDENTITY.md before completing bootstrap')
            target = checked('BOOTSTRAP.md')
            if target.exists():
                target.unlink()
            return commit()
        if action == 'commit':
            return commit()
        state = []
        for path in paths():
            if checked(path).exists():
                content = read(path)
                state.append({'path': path, 'characters': len(content),
                              'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()})
        return {'files': state, 'dirty': git('status', '--porcelain', '--untracked-files=no')}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        # Errors contain paths and failure kinds, never the user's memory body.
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
`
