import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDurabilityOwners, formatDurabilityOwnerReport } from './durability-owners'

function product(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'durability-owners-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

describe('checkDurabilityOwners', () => {
  it('names each product-local turn store write, replay loop and follow-up identity', () => {
    const fixture = product({
      'src/chat/plan-follow-up.ts': [
        "db.prepare('INSERT INTO turn_status (turnId, status) VALUES (?, ?)')",
        "await env.DB.prepare('DELETE FROM turn_events WHERE turnId = ?').bind(id).run()",
        'const iterator = box.session(sessionId).events({ executionId, since: "0" })',
        'return `plan-followup-${digest}`',
      ].join('\n'),
    })
    try {
      const report = checkDurabilityOwners({ repoDir: fixture.root })
      expect(report.ok).toBe(false)
      expect(report.violations.map((violation) => [violation.line, violation.rule])).toEqual([
        [1, 'turn-tables'],
        [2, 'turn-tables'],
        [3, 'session-replay'],
        [4, 'execution-identity'],
      ])
      expect(formatDurabilityOwnerReport(report)).toContain('src/chat/plan-follow-up.ts:3 [session-replay]')
    } finally {
      fixture.done()
    }
  })

  it('passes shared-owner use, tests, migrations and a named exception', () => {
    const fixture = product({
      'src/chat/turns.ts': [
        "import { createD1TurnEventStore } from '@tangle-network/agent-app/stream'",
        'await createD1TurnEventStore(env.DB).resetEvents(turnId)',
        '// agent-app-durability-owner: deleting a project removes its turns with its sessions',
        'await db.run(sql`',
        '  DELETE FROM turn_events WHERE turnId IN (SELECT turnId FROM turn_status WHERE scopeId = ${id})',
        '`)',
      ].join('\n'),
      'src/chat/turns.test.ts': "db.prepare('UPDATE turn_status SET status = ?')",
      'tests/support/d1.ts': "db.prepare('INSERT INTO turn_events VALUES (?)')",
      'drizzle/0004.sql': 'ALTER TABLE turn_status ADD leaseToken text;',
      'node_modules/@tangle-network/agent-app/dist/stream.js': "prepare('DELETE FROM turn_events')",
    })
    try {
      const report = checkDurabilityOwners({ repoDir: fixture.root })
      expect(report).toMatchObject({ ok: true, scannedFiles: 1, waived: 1, violations: [] })
      expect(formatDurabilityOwnerReport(report)).toContain('1 named exceptions')
    } finally {
      fixture.done()
    }
  })

  it('honors the peer-check exclude prefixes', () => {
    const fixture = product({ 'vendor/copied.ts': "prepare('UPDATE turn_status SET status = ?')" })
    try {
      expect(checkDurabilityOwners({ repoDir: fixture.root, exclude: ['vendor'] }).ok).toBe(true)
      expect(checkDurabilityOwners({ repoDir: fixture.root }).ok).toBe(false)
    } finally {
      fixture.done()
    }
  })
})
