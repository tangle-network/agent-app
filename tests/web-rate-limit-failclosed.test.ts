/**
 * Fail-closed hardening for the KV-backed rate limiter. A bare `JSON.parse` on
 * the stored state throws on corrupt KV, which aborts the request handler and
 * silently DISABLES the limiter (fail-open). The hardened reader catches the
 * parse, treats unreadable state as a full window (deny = fail-closed), and
 * drops non-number array entries. These tests pin all three.
 */

import { describe, expect, it } from 'vitest'
import { checkRateLimit, type KvLike } from '../src/web'

/** In-memory KV whose stored value can be seeded with arbitrary (incl. corrupt)
 *  strings to model a poisoned key. */
function fakeKv(initial?: string): KvLike & { value: string | null } {
  const state = { value: initial ?? null }
  return {
    value: state.value,
    async get() {
      return state.value
    },
    async put(_key, value) {
      state.value = value
    },
  }
}

describe('checkRateLimit fail-closed on corrupt KV', () => {
  it('does not throw when the stored state is not valid JSON', async () => {
    const kv = fakeKv('}{ not json')
    await expect(checkRateLimit(kv, 'k', 5, 60)).resolves.toBeDefined()
  })

  it('denies (fail-closed) when the stored state is unparseable — corruption is not a bypass', async () => {
    const kv = fakeKv('totally::broken')
    const result = await checkRateLimit(kv, 'ip-1', 5, 60)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('denies when the stored state parses to a non-array (e.g. an object)', async () => {
    const kv = fakeKv('{"count": 3}')
    const result = await checkRateLimit(kv, 'ip-2', 5, 60)
    expect(result.allowed).toBe(false)
  })

  it('denies when the stored state parses to a bare number', async () => {
    const kv = fakeKv('42')
    const result = await checkRateLimit(kv, 'ip-3', 5, 60)
    expect(result.allowed).toBe(false)
  })

  it('a corrupt key cannot reset the window to admit a flood', async () => {
    const kv = fakeKv('null')
    // Every call against the poisoned key is denied — there is no path where
    // corruption opens the gate.
    for (let i = 0; i < 10; i += 1) {
      const result = await checkRateLimit(kv, 'flood', 5, 60)
      expect(result.allowed, `attempt ${i}`).toBe(false)
    }
  })

  it('ignores non-number entries inside an otherwise-valid array', async () => {
    const now = Math.floor(Date.now() / 1000)
    // Two real recent timestamps plus junk; junk must be dropped, so the window
    // counts only the 2 valid entries and a 3rd request is still allowed (limit 3).
    const kv = fakeKv(JSON.stringify([now, 'x', null, now, { a: 1 }]))
    const result = await checkRateLimit(kv, 'mixed', 3, 60)
    expect(result.allowed).toBe(true)
    // 2 valid + this request = 3 used, 0 remaining.
    expect(result.remaining).toBe(0)
  })

  it('null/absent state is a fresh window (allows), distinct from corruption', async () => {
    const kv = fakeKv()
    const result = await checkRateLimit(kv, 'fresh', 5, 60)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
  })

  it('a valid full window still denies (regression: real limiting unaffected)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const kv = fakeKv(JSON.stringify([now, now, now]))
    const result = await checkRateLimit(kv, 'full', 3, 60)
    expect(result.allowed).toBe(false)
  })
})
