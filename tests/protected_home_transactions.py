"""Functional transaction tests with real Git and a disposable, unprivileged home.

Only fixture ownership/policy checks are substituted. This is not the deployed
sudo/UID/mount proof; scripts/prove-protected-home.mjs owns that separate gate.
"""
import importlib.util
import io
import json
import multiprocessing
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'bin/tangle-agent/home-maintenance.py'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('home_writer', SOURCE)
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


def invoke(request):
    with patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))):
        return writer.main()


def race(request, results):
    try:
        results.put(('ok', invoke(request)))
    except Exception as error:
        results.put(('error', str(error)))


class ProtectedHomeTransactions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tangle-home-test-')
        self.addCleanup(self.temporary.cleanup)
        root = pathlib.Path(self.temporary.name)
        self.patches = patch.multiple(writer, BASE=root, ROOT=root / 'home', STATE=root / 'state',
                                     GIT=root / 'state/home.git', IDENTITY=None)
        self.patches.start()
        self.addCleanup(self.patches.stop)
        writer.ROOT.mkdir()
        writer.STATE.mkdir()
        writer.CAPS = {name: 32768 for name in writer.FIXED | {'dailyNote', 'skill'}}
        writer.CAPS['USER.md'] = 4000
        for name, body in {'AGENTS.md': 'platform policy', 'SOUL.md': 'private behavior',
                           'IDENTITY.md': 'fixture', 'USER.md': 'original preference',
                           'MEMORY.md': 'original memory', 'BOOTSTRAP.md': 'setup'}.items():
            (writer.ROOT / name).write_text(body)
            (writer.ROOT / name).chmod(0o444)

        def fixture_protected(path, directory=False):
            self.assertTrue(path.is_relative_to(root), 'fixture must never touch a deployed path')
            info = path.lstat()
            if info.st_uid != os.getuid() or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                raise ValueError('unsafe fixture ownership or permissions')
            if directory:
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError('fixture is not a directory')
            elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('fixture is not a single-link regular file')
            return info

        policy = patch.object(writer, 'load_policy', lambda: None)
        protected = patch.object(writer, 'protected', fixture_protected)
        policy.start()
        protected.start()
        self.addCleanup(policy.stop)
        self.addCleanup(protected.stop)
        self.initial = invoke({'action': 'status'})['commit']

    def mutate(self, action='write', **kwargs):
        return invoke({'action': action, 'expectedHead': self.initial, **kwargs})

    def test_stale_write_and_delete_leave_everything_unchanged(self):
        winner = self.mutate(path='USER.md', content='new owner preference')
        for action, extra in [('write', {'content': 'stale'}), ('delete', {})]:
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'home changed'):
                self.mutate(action, path='USER.md', **extra)
            self.assertEqual(writer.read('USER.md'), 'new owner preference')
            self.assertEqual(invoke({'action': 'status'})['commit'], winner['commit'])
            self.assertFalse((writer.STATE / 'pending.json').exists())

    def test_missing_head_is_a_descriptive_refusal(self):
        for action in ['write', 'delete']:
            request = {'action': action, 'path': 'USER.md'}
            if action == 'write':
                request['content'] = 'must not land'
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'expectedHead is required'):
                invoke(request)
        self.assertEqual(writer.read('USER.md'), 'original preference')
        self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)

    def test_concurrent_compare_and_swap_has_exactly_one_winner(self):
        context = multiprocessing.get_context('fork')
        results = context.Queue()
        processes = [context.Process(target=race, args=({'action': 'write', 'path': 'USER.md',
            'content': content, 'expectedHead': self.initial}, results)) for content in ['writer one', 'writer two']]
        for process in processes:
            process.start()
        try:
            for process in processes:
                process.join(10)
                self.assertEqual(process.exitcode, 0)
            received = [results.get(timeout=2) for _ in processes]
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                process.join()
            results.close()
        self.assertEqual(sorted(item[0] for item in received), ['error', 'ok'])
        self.assertIn('home changed', next(value for kind, value in received if kind == 'error'))
        self.assertIn(writer.read('USER.md'), ['writer one', 'writer two'])
        self.assertEqual(writer.git('rev-list', '--count', 'HEAD'), '2')

    def test_exact_write_retry_after_success_is_not_another_mutation(self):
        first = self.mutate(path='USER.md', content='once')
        with self.assertRaisesRegex(ValueError, 'home changed'):
            self.mutate(path='USER.md', content='once')
        self.assertEqual(writer.git('rev-parse', 'HEAD'), first['commit'])
        self.assertEqual(writer.git('rev-list', '--count', 'HEAD'), '2')

    def test_reconcile_validates_all_updates_before_writing(self):
        for bad_path, bad_content in [('AGENTS.md', 'policy'), ('SOUL.md', 'behavior'),
            ('IDENTITY.md', 'identity'), ('../escape', 'escape'), ('USER.md', 'x' * 4001)]:
            updates = {'MEMORY.md': 'must not partially land', bad_path: bad_content}
            with self.subTest(path=bad_path), self.assertRaises(ValueError):
                self.mutate('reconcile', updates=updates)
            self.assertEqual(writer.read('MEMORY.md'), 'original memory')
            self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)
            self.assertFalse((writer.STATE / 'pending.json').exists())

    def test_failed_commit_is_recovered_before_any_new_cas(self):
        updates = {'USER.md': 'committed preference', 'MEMORY.md': 'committed memory'}
        with patch.object(writer, 'checkpoint', side_effect=RuntimeError('injected commit failure')):
            with self.assertRaisesRegex(RuntimeError, 'injected commit failure'):
                self.mutate('reconcile', updates=updates)
        self.assertTrue((writer.STATE / 'pending.json').exists())
        self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)
        # The same request must recover its journal, then refuse its now-old
        # revision rather than replaying another mutation over a newer head.
        with self.assertRaisesRegex(ValueError, 'home changed'):
            self.mutate('reconcile', updates=updates)
        self.assertEqual({name: writer.read(name) for name in updates}, updates)
        self.assertFalse((writer.STATE / 'pending.json').exists())
        self.assertEqual(writer.git('rev-list', '--count', 'HEAD'), '2')

    def test_partial_transaction_recovery_precedes_snapshot(self):
        original = writer.atomic

        def fail_second(path, content, mode=0o444):
            if path == writer.ROOT / 'MEMORY.md':
                raise RuntimeError('injected interruption')
            return original(path, content, mode)

        with patch.object(writer, 'atomic', fail_second):
            with self.assertRaisesRegex(RuntimeError, 'injected interruption'):
                self.mutate('reconcile', updates={'USER.md': 'new user', 'MEMORY.md': 'new memory'})
        self.assertEqual(writer.read('USER.md'), 'new user')
        self.assertEqual(writer.read('MEMORY.md'), 'original memory')
        snapshot = invoke({'action': 'snapshot'})
        self.assertEqual({file['path']: file['content'] for file in snapshot['files']},
                         {'USER.md': 'new user', 'MEMORY.md': 'new memory'})
        self.assertNotEqual(snapshot['commit'], self.initial)
        self.assertEqual(snapshot['checkpointScope'], 'local')
        self.assertIsNone(snapshot['identity'])
        self.assertFalse((writer.STATE / 'pending.json').exists())

    def test_delete_and_journal_cleanup_sync_parent_directories(self):
        events = []
        original = writer.sync_directory

        def record(path):
            events.append((path, (writer.STATE / 'pending.json').exists()))
            original(path)

        with patch.object(writer, 'sync_directory', record):
            result = self.mutate('delete', path='USER.md')
        self.assertFalse((writer.ROOT / 'USER.md').exists())
        self.assertIn((writer.ROOT, True), events)
        self.assertEqual(events[-1], (writer.STATE, False))
        self.assertNotEqual(result['commit'], self.initial)

    def test_append_serializes_latest_contents_but_is_not_idempotent(self):
        invoke({'action': 'append', 'path': 'USER.md', 'content': '\nfirst'})
        invoke({'action': 'append', 'path': 'USER.md', 'content': '\nsecond'})
        self.assertEqual(writer.read('USER.md'), 'original preference\nfirst\nsecond')
        with self.assertRaisesRegex(ValueError, 'home changed'):
            self.mutate(path='USER.md', content='stale replacement')

    def test_identity_is_fixed_policy_and_must_match_both_volume_markers(self):
        identity = {'workspaceId': 'workspace-a', 'stateId': 'state-a',
                    'scope': {'kind': 'personal', 'memberId': 'member-a', 'agentId': 'agent-a'}}
        with self.assertRaisesRegex(ValueError, 'marker is missing'):
            writer.load_identity({'identity': identity})
        for directory in [writer.ROOT, writer.STATE]:
            writer.atomic(directory / writer.BINDING_FILE, json.dumps(identity))
        self.assertEqual(writer.load_identity({'identity': identity}), identity)
        self.assertNotIn(writer.BINDING_FILE, writer.paths())
        with self.assertRaisesRegex(ValueError, 'allowlist'):
            writer.checked(writer.BINDING_FILE)
        for altered in [None, {**identity, 'workspaceId': 'workspace-b'},
            {**identity, 'scope': {'kind': 'shared', 'groupId': 'group-a', 'agentId': 'agent-a'}}]:
            with self.subTest(identity=altered), self.assertRaisesRegex(ValueError, 'does not match'):
                writer.load_identity({'identity': altered})
        writer.atomic(writer.STATE / writer.BINDING_FILE, json.dumps({**identity, 'stateId': 'wrong-state'}))
        with self.assertRaisesRegex(ValueError, 'does not match'):
            writer.load_identity({'identity': identity})

    def test_request_cannot_override_identity_or_paths(self):
        for extra in [{'identity': {'workspaceId': 'other'}}, {'root': '/tmp/other'}, {'state': '/tmp/other'}]:
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'invalid home operation fields'):
                invoke({'action': 'snapshot', **extra})
        self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)

    def test_portable_skills_and_deletions_roundtrip_at_one_commit(self):
        result = self.mutate('reconcile', updates={'USER.md': None,
            'memory/2026-10-10.md': 'dated learning', 'skills/summary/SKILL.md': 'reusable skill'})
        snapshot = invoke({'action': 'snapshot', 'since': self.initial})
        self.assertEqual(snapshot['commit'], result['commit'])
        self.assertEqual(snapshot['since'], self.initial)
        self.assertEqual(result['files'], snapshot['files'])
        self.assertEqual({file['path']: file['content'] for file in snapshot['files']}, {
            'USER.md': None, 'MEMORY.md': 'original memory', 'memory/2026-10-10.md': 'dated learning',
            'skills/summary/SKILL.md': 'reusable skill'})
        self.assertEqual(writer.read('AGENTS.md'), 'platform policy')
        self.assertEqual(writer.read('SOUL.md'), 'private behavior')

    def test_never_tracked_tombstone_is_not_reported_as_persisted(self):
        with self.assertRaisesRegex(ValueError, 'never-tracked'):
            self.mutate('reconcile', updates={'MEMORY.md': 'must not land',
                                            'skills/never-existed/SKILL.md': None})
        self.assertEqual(writer.read('MEMORY.md'), 'original memory')
        self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)

    def test_deleted_paths_survive_later_commits_and_a_reconcile_retry(self):
        deletion = self.mutate('delete', path='USER.md')
        same = invoke({'action': 'reconcile', 'updates': {'USER.md': None},
                       'expectedHead': deletion['commit'], 'since': self.initial})
        self.assertEqual(same['commit'], deletion['commit'])
        invoke({'action': 'append', 'path': 'MEMORY.md', 'content': '\nafter deletion'})
        snapshot = invoke({'action': 'snapshot', 'since': self.initial})
        self.assertIn({'path': 'USER.md', 'content': None}, snapshot['files'])
        self.assertEqual(writer.git('rev-list', '--count', 'HEAD'), '3')

    def test_snapshot_returns_exact_committed_bytes_including_whitespace(self):
        body = '\n  preference with accents: caf\u00e9\r\n\r\n'
        # Simulate trusted setup updating a fixture before its checkpoint.
        writer.atomic(writer.ROOT / 'USER.md', body)
        snapshot = invoke({'action': 'snapshot'})
        file = next(file for file in snapshot['files'] if file['path'] == 'USER.md')
        self.assertEqual(file['content'], body)
        self.assertEqual(writer.read('USER.md'), body)
        self.assertNotEqual(snapshot['commit'], self.initial)
        self.assertEqual(writer.git('show', snapshot['commit'] + ':USER.md', trim=False), body)

    def test_whole_file_write_cannot_smuggle_a_delete_as_null_content(self):
        with self.assertRaisesRegex(ValueError, 'content must be text'):
            self.mutate(path='USER.md', content=None)
        self.assertEqual(writer.read('USER.md'), 'original preference')
        self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)
        with self.assertRaises(ValueError):
            self.mutate('consolidate', user=None, memory='must not partially land')
        self.assertEqual(writer.read('USER.md'), 'original preference')
        self.assertEqual(writer.read('MEMORY.md'), 'original memory')

    def test_invalid_pending_journal_is_rejected_before_any_replay(self):
        pending = writer.STATE / 'pending.json'
        for value in [[], {'MEMORY.md': 'must not land', 'AGENTS.md': 'bad policy'},
                      {'MEMORY.md': 'must not land', 'USER.md': 'x' * 4001}]:
            writer.atomic(pending, json.dumps(value), 0o600)
            with self.subTest(value=type(value).__name__), self.assertRaises(ValueError):
                invoke({'action': 'status'})
            self.assertEqual(writer.read('MEMORY.md'), 'original memory')
            self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)
        writer.atomic(pending, ' ' * (writer.MAX_PENDING_BYTES + 1), 0o600)
        with self.assertRaisesRegex(ValueError, 'journal exceeds'):
            invoke({'action': 'status'})

    def test_post_commit_pre_cleanup_retry_keeps_the_original_commit(self):
        original = pathlib.Path.unlink
        pending = writer.STATE / 'pending.json'

        def fail_cleanup(path, *args, **kwargs):
            if path == pending:
                raise OSError('injected cleanup interruption')
            return original(path, *args, **kwargs)

        with patch.object(pathlib.Path, 'unlink', fail_cleanup):
            with self.assertRaisesRegex(OSError, 'cleanup interruption'):
                self.mutate(path='USER.md', content='committed before cleanup')
        committed = writer.git('rev-parse', 'HEAD')
        self.assertNotEqual(committed, self.initial)
        self.assertTrue(pending.exists())
        recovered = invoke({'action': 'status'})
        self.assertEqual(recovered['commit'], committed)
        self.assertEqual(writer.read('USER.md'), 'committed before cleanup')
        self.assertFalse(pending.exists())
        self.assertEqual(writer.git('rev-list', '--count', 'HEAD'), '2')

    def test_history_budget_fails_closed_and_reconcile_preflights_growth(self):
        def change(action, path, **extra):
            return invoke({'action': action, 'path': path,
                           'expectedHead': writer.git('rev-parse', 'HEAD'), **extra})

        with patch.object(writer, 'MAX_FILES', 6):
            change('delete', 'USER.md')
            change('delete', 'MEMORY.md')
            for index in range(3):
                name = f'skills/history-{index}/SKILL.md'
                change('write', name, content='historical')
                change('delete', name)
            self.assertEqual(len(invoke({'action': 'snapshot', 'since': self.initial})['files']), 5)
            before = writer.git('rev-parse', 'HEAD')
            with self.assertRaisesRegex(ValueError, 'history exceeds'):
                invoke({'action': 'reconcile', 'expectedHead': before, 'since': self.initial,
                        'updates': {'skills/new-one/SKILL.md': 'one', 'skills/new-two/SKILL.md': 'two'}})
            self.assertEqual(writer.git('rev-parse', 'HEAD'), before)
            self.assertFalse((writer.ROOT / 'skills/new-one/SKILL.md').exists())
            self.assertFalse((writer.STATE / 'pending.json').exists())
            for index in range(3, 5):
                name = f'skills/history-{index}/SKILL.md'
                change('write', name, content='historical')
                change('delete', name)
            with self.assertRaisesRegex(ValueError, 'history exceeds'):
                invoke({'action': 'snapshot', 'since': self.initial})
            # Long lifetime history does not brick fresh pins. Only the old,
            # over-budget reconciliation range is refused, without truncation.
            fresh = invoke({'action': 'snapshot'})
            self.assertEqual(fresh['since'], fresh['commit'])
            self.assertEqual(fresh['files'], [])

    def test_since_retains_absent_create_delete_aba_and_rejects_divergent_history(self):
        created = self.mutate(path='skills/aba/SKILL.md', content='temporary learning')
        deleted = invoke({'action': 'delete', 'path': 'skills/aba/SKILL.md',
                          'expectedHead': created['commit']})
        scoped = invoke({'action': 'snapshot', 'since': self.initial})
        self.assertIn({'path': 'skills/aba/SKILL.md', 'content': None}, scoped['files'])
        self.assertEqual(scoped['since'], self.initial)
        # Simulate a restored Git head older than the retained pin. Do not
        # checkpoint the divergent filesystem or silently treat it as empty.
        writer.git('update-ref', 'HEAD', self.initial)
        with self.assertRaisesRegex(ValueError, 'not an ancestor'):
            invoke({'action': 'snapshot', 'since': deleted['commit']})
        self.assertEqual(writer.git('rev-parse', 'HEAD'), self.initial)
        with self.assertRaisesRegex(ValueError, 'not an ancestor'):
            invoke({'action': 'reconcile', 'expectedHead': self.initial,
                    'since': deleted['commit'], 'updates': {'USER.md': 'must not land'}})
        self.assertEqual(writer.read('USER.md'), 'original preference')
        with self.assertRaisesRegex(ValueError, 'missing or is not an ancestor'):
            invoke({'action': 'snapshot', 'since': 'f' * 40})


if __name__ == '__main__':
    unittest.main()
