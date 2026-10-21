import { harnessTypeSchema } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import {
  coerceHarness,
  configuredHarness,
  isHarness,
  resolveSessionHarness,
  DEFAULT_HARNESS,
  KNOWN_HARNESSES,
  isModelCompatibleWithHarness,
  snapModelToHarness,
  snapHarnessToModel,
  assertHarnessModelCompatible,
} from './index'

describe('harness taxonomy + coercion', () => {
  it('recognizes known harnesses, rejects everything else', () => {
    expect(isHarness('opencode')).toBe(true)
    expect(isHarness('codex')).toBe(true)
    expect(isHarness('cursor')).toBe(true)
    expect(isHarness('not-a-harness')).toBe(false)
    expect(isHarness(undefined)).toBe(false)
    expect(isHarness(42)).toBe(false)
  })

  it('coerces to a known harness or the fallback', () => {
    expect(coerceHarness('codex')).toBe('codex')
    expect(coerceHarness('bogus')).toBe(DEFAULT_HARNESS) // opencode
    expect(coerceHarness('bogus', 'claude-code')).toBe('claude-code')
    expect(coerceHarness(null)).toBe('opencode')
  })

  it('DEFAULT_HARNESS is a member of the list', () => {
    expect(KNOWN_HARNESSES).toContain(DEFAULT_HARNESS)
  })

  it('derives known identities from the canonical enum, not deployment availability', () => {
    const canonical = new Set<string>(harnessTypeSchema.options)
    const known = new Set<string>(KNOWN_HARNESSES)
    expect([...canonical].filter((h) => !known.has(h))).toEqual(['gemini'])
    expect(isHarness('gemini')).toBe(false)
    for (const harness of harnessTypeSchema.options) {
      if (harness === 'gemini') continue
      expect(isHarness(harness), `${harness} should be a known harness`).toBe(true)
    }
  })

  it('includes forge and cursor from the canonical enum', () => {
    expect(harnessTypeSchema.options).toContain('forge')
    expect(harnessTypeSchema.options).toContain('cursor')
    expect(isHarness('forge')).toBe(true)
    expect(isHarness('cursor')).toBe(true)
  })
})

describe('resolveSessionHarness — the session lock', () => {
  it('fresh session: picks requested → workspaceDefault → fallback', () => {
    expect(resolveSessionHarness({ requested: 'codex' })).toEqual({ harness: 'codex', locked: false, swapAttempted: false })
    expect(resolveSessionHarness({ workspaceDefault: 'claude-code' })).toEqual({ harness: 'claude-code', locked: false, swapAttempted: false })
    expect(() => resolveSessionHarness({ requested: 'bogus', workspaceDefault: 'amp' })).toThrow('harness_unknown')
    expect(resolveSessionHarness({})).toEqual({ harness: 'opencode', locked: false, swapAttempted: false })
    expect(resolveSessionHarness({ fallback: 'codex' })).toEqual({ harness: 'codex', locked: false, swapAttempted: false })
  })

  it('locked session: the locked harness wins, model-change is irrelevant', () => {
    expect(resolveSessionHarness({ sessionHarness: 'codex' })).toEqual({ harness: 'codex', locked: true, swapAttempted: false })
    expect(resolveSessionHarness({ sessionHarness: 'codex', requested: 'codex' })).toEqual({ harness: 'codex', locked: true, swapAttempted: false })
  })

  it('locked session: a differing requested harness is a forbidden swap (lock still wins)', () => {
    const r = resolveSessionHarness({ sessionHarness: 'opencode', requested: 'codex' })
    expect(r).toEqual({ harness: 'opencode', locked: true, swapAttempted: true })
  })

  it('locked session: workspaceDefault cannot override the lock', () => {
    const r = resolveSessionHarness({ sessionHarness: 'codex', workspaceDefault: 'amp' })
    expect(r.harness).toBe('codex')
    expect(r.locked).toBe(true)
  })
})

describe('harness ↔ model compatibility (server-enforced)', () => {
  const CATALOG = ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'openai/gpt-5-mini']

  it('provider-less / sentinel ids are compatible everywhere', () => {
    expect(isModelCompatibleWithHarness('claude-code', 'default')).toBe(true)
    expect(isModelCompatibleWithHarness('codex', '')).toBe(true)
  })

  it('uses Interface compatibility for canonical multi-provider backends', () => {
    for (const harness of ['forge', 'cursor'] as const) {
      expect(isModelCompatibleWithHarness(harness, 'openai/gpt-5')).toBe(true)
      expect(isModelCompatibleWithHarness(harness, 'anthropic/claude-sonnet-4-6')).toBe(true)
      expect(snapModelToHarness(harness, 'anthropic/claude-sonnet-4-6', CATALOG)).toBe('anthropic/claude-sonnet-4-6')
      expect(snapHarnessToModel(harness, 'openai/gpt-5')).toBe(harness)
      expect(() => assertHarnessModelCompatible(harness, 'openai/gpt-5')).not.toThrow()
    }
  })

})

describe('configured harness', () => {
  it('defaults to opencode when nothing is configured', () => {
    expect(configuredHarness({})).toBe(DEFAULT_HARNESS)
    expect(configuredHarness({ default: ' ', workspaces: '' }, 'ws-a')).toBe(DEFAULT_HARNESS)
  })

  it('applies the app default, then a workspace choice over it', () => {
    const config = { default: 'pi', workspaces: JSON.stringify({ 'ws-a': 'opencode' }) }
    expect(configuredHarness(config, 'ws-a')).toBe('opencode')
    expect(configuredHarness(config, 'ws-b')).toBe('pi')
    expect(configuredHarness(config)).toBe('pi')
  })

  it('feeds a fresh session but never moves a session that already ran', () => {
    const workspaceDefault = configuredHarness({ workspaces: JSON.stringify({ 'ws-a': 'pi' }) }, 'ws-a')
    expect(resolveSessionHarness({ workspaceDefault }).harness).toBe('pi')
    expect(resolveSessionHarness({ sessionHarness: 'opencode', workspaceDefault }).harness).toBe('opencode')
  })

  it('refuses a configuration that names an unknown harness or is malformed', () => {
    expect(() => configuredHarness({ default: 'pie' })).toThrow('unknown harness: pie')
    expect(() => configuredHarness({ workspaces: JSON.stringify({ 'ws-a': 'pi', 'ws-b': 'pie' }) }, 'ws-a')).toThrow('workspace ws-b')
    expect(() => configuredHarness({ workspaces: '{' })).toThrow('not JSON')
    expect(() => configuredHarness({ workspaces: '["pi"]' })).toThrow('must map workspace ids')
  })
})

describe('harnessCapabilities', () => {
  it('covers every known harness exhaustively', async () => {
    const { KNOWN_HARNESSES, harnessCapabilities } = await import('./index')
    for (const harness of KNOWN_HARNESSES) {
      expect(() => harnessCapabilities(harness)).not.toThrow()
    }
  })

  it('names the platform-verified facts', async () => {
    const { harnessCapabilities } = await import('./index')
    expect(harnessCapabilities('pi')).toEqual({ subagents: false, mcp: 'extension', toolControls: 'startup', skillsDir: '.pi/skills' })
    expect(harnessCapabilities('opencode').skillsDir).toBe('.opencode/skills')
    expect(harnessCapabilities('hermes').skillsDir).toBeNull()
  })
})
