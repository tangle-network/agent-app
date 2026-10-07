import { canonicalCandidateBytes, snapshotAgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import { bindProfileText } from './index'

const baseline = snapshotAgentProfile({
  name: 'GTM Agent', harness: 'opencode', prompt: { systemPrompt: 'base' },
  model: { default: 'deepseek/deepseek-v4.1-flash' },
})

function undefinedKeys(value: object | undefined): string[] {
  return Object.entries(value ?? {}).filter(([, entry]) => entry === undefined).map(([key]) => key)
}

describe('bindProfileText', () => {
  it('returns canonical JSON when the selected profile omits text fields', () => {
    const bound = bindProfileText(baseline, baseline)
    expect(undefinedKeys(bound)).toEqual([])
    expect(undefinedKeys(bound.prompt)).toEqual([])
    // Hosts digest a profile derived from the bound one before dispatch.
    expect(() => canonicalCandidateBytes({ profile: { ...bound, prompt: { ...bound.prompt, systemPrompt: 'composed' } } })).not.toThrow()
  })

  it('overlays selected text and clears baseline text the selection removes', () => {
    const withText = snapshotAgentProfile({ ...baseline, description: 'old', prompt: { systemPrompt: 'base', instructions: ['old'] } })
    const selected = snapshotAgentProfile({ ...baseline, description: 'new', prompt: { systemPrompt: 'next' } })
    const bound = bindProfileText(withText, selected)
    expect(bound.description).toBe('new')
    expect(bound.prompt).toEqual({ systemPrompt: 'next' })
    expect('instructions' in (bound.prompt ?? {})).toBe(false)
  })

  it('removes the prompt when no text remains', () => {
    const bare = snapshotAgentProfile({ name: 'GTM Agent', harness: 'opencode', model: { default: 'deepseek/deepseek-v4.1-flash' } })
    const bound = bindProfileText(bare, bare)
    expect('prompt' in bound).toBe(false)
    expect('description' in bound).toBe(false)
  })
})
