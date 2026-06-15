import { describe, it, expect, vi } from 'vitest'
import {
  resolveExecutionMode,
  executionModeForProfile,
  isKnownSandboxHarness,
  runAgent,
  ROUTER_HARNESS,
} from './index'

describe('resolveExecutionMode', () => {
  it('routes absent/null/router to the router tool loop', () => {
    expect(resolveExecutionMode(undefined)).toBe('router')
    expect(resolveExecutionMode(null)).toBe('router')
    expect(resolveExecutionMode(ROUTER_HARNESS)).toBe('router')
  })

  it('routes a known sandbox harness to sandbox', () => {
    expect(resolveExecutionMode('opencode')).toBe('sandbox')
    expect(resolveExecutionMode('claude-code')).toBe('sandbox')
  })

  it('treats an unrecognized non-null harness as sandbox', () => {
    expect(resolveExecutionMode('some-future-harness' as never)).toBe('sandbox')
  })
})

describe('isKnownSandboxHarness', () => {
  it('is true only for KNOWN_HARNESSES members', () => {
    expect(isKnownSandboxHarness('opencode')).toBe(true)
    expect(isKnownSandboxHarness(null)).toBe(false)
    expect(isKnownSandboxHarness(ROUTER_HARNESS)).toBe(false)
    expect(isKnownSandboxHarness('nope' as never)).toBe(false)
  })
})

describe('executionModeForProfile', () => {
  it('infers from the profile harness field', () => {
    expect(executionModeForProfile({})).toBe('router')
    expect(executionModeForProfile({ harness: null })).toBe('router')
    expect(executionModeForProfile({ harness: 'opencode' })).toBe('sandbox')
  })
})

describe('runAgent', () => {
  async function* gen(...items: string[]) {
    for (const i of items) yield i
  }

  it('streams the router branch and never invokes sandbox when harness is null', async () => {
    const sandbox = vi.fn(() => gen('SHOULD-NOT-RUN'))
    const router = vi.fn(() => gen('a', 'b'))
    const out: string[] = []
    for await (const e of runAgent(null, { router, sandbox })) out.push(e)
    expect(out).toEqual(['a', 'b'])
    expect(router).toHaveBeenCalledTimes(1)
    expect(sandbox).not.toHaveBeenCalled()
  })

  it('streams the sandbox branch and never invokes router when harness is set', async () => {
    const router = vi.fn(() => gen('SHOULD-NOT-RUN'))
    const sandbox = vi.fn(() => gen('x', 'y'))
    const out: string[] = []
    for await (const e of runAgent('opencode', { router, sandbox })) out.push(e)
    expect(out).toEqual(['x', 'y'])
    expect(sandbox).toHaveBeenCalledTimes(1)
    expect(router).not.toHaveBeenCalled()
  })

  it('awaits a branch that returns a promise of an iterable', async () => {
    const router = () => Promise.resolve(gen('p1', 'p2'))
    const sandbox = () => gen('no')
    const out: string[] = []
    for await (const e of runAgent(ROUTER_HARNESS, { router, sandbox })) out.push(e)
    expect(out).toEqual(['p1', 'p2'])
  })
})
