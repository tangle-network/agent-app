import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  diffProfileFingerprints,
  fingerprintAgentProfile,
  formatProfileDrift,
} from './fingerprint'

const PROFILE: AgentProfile = {
  name: 'p',
  prompt: { systemPrompt: 'SYSTEM PROMPT UNDER TEST' },
  mcp: {
    delegate: { transport: 'http', url: 'https://mcp.invalid/delegate' },
    tools: { transport: 'http', url: 'https://mcp.invalid/tools' },
  },
  subagents: {
    researcher: { description: 'r' },
    writer: { description: 'w' },
  },
  resources: {
    files: [
      { path: 'doctrine/a.md', resource: { kind: 'inline', name: 'a.md', content: 'a' } },
      { path: 'doctrine/b.md', resource: { kind: 'inline', name: 'b.md', content: 'b' } },
    ],
  },
  connections: [{ connectionId: 'conn-1', capabilities: ['gmail.read'] }],
}

const CTX = { model: 'gpt-5-mini', harness: 'opencode' }

describe('fingerprintAgentProfile', () => {
  it('is deterministic and channel-complete', async () => {
    const a = await fingerprintAgentProfile(PROFILE, CTX)
    const b = await fingerprintAgentProfile(structuredClone(PROFILE), CTX)
    expect(a).toEqual(b)
    expect(a.mcpKeys).toEqual(['delegate', 'tools'])
    expect(a.subagentNames).toEqual(['researcher', 'writer'])
    expect(a.fileMountPaths).toEqual(['doctrine/a.md', 'doctrine/b.md'])
    expect(a.connectionIds).toEqual(['conn-1'])
    expect(a.promptBytes).toBe(Buffer.byteLength('SYSTEM PROMPT UNDER TEST', 'utf8'))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.promptSha).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores capability-map key order', async () => {
    const reordered: AgentProfile = {
      ...PROFILE,
      mcp: {
        tools: PROFILE.mcp!.tools!,
        delegate: PROFILE.mcp!.delegate!,
      },
    }
    const a = await fingerprintAgentProfile(PROFILE, CTX)
    const b = await fingerprintAgentProfile(reordered, CTX)
    expect(a.hash).toBe(b.hash)
  })

  it('an empty profile fingerprints without throwing, and reads as empty', async () => {
    const fp = await fingerprintAgentProfile({ name: 'stub' }, CTX)
    expect(fp.promptBytes).toBe(0)
    expect(fp.mcpKeys).toEqual([])
    expect(fp.fileMountPaths).toEqual([])
  })
})

describe('diffProfileFingerprints', () => {
  it('identical profiles: equal, and the formatter says exactly so', async () => {
    const a = await fingerprintAgentProfile(PROFILE, CTX)
    const b = await fingerprintAgentProfile(structuredClone(PROFILE), CTX)
    const drift = diffProfileFingerprints(a, b)
    expect(drift.equal).toBe(true)
    expect(formatProfileDrift(drift)).toBe('profiles identical')
  })

  it('detects drift on every channel it claims to cover', async () => {
    const base = await fingerprintAgentProfile(PROFILE, CTX)
    const perturbations: Array<[string, AgentProfile, typeof CTX]> = [
      ['promptSha', { ...PROFILE, prompt: { systemPrompt: 'DIFFERENT' } }, CTX],
      ['mcpKeys', { ...PROFILE, mcp: { delegate: PROFILE.mcp!.delegate! } }, CTX],
      ['subagentNames', { ...PROFILE, subagents: {} }, CTX],
      ['fileMountPaths', { ...PROFILE, resources: { files: [] } }, CTX],
      ['connectionIds', { ...PROFILE, connections: [] }, CTX],
      ['model', PROFILE, { ...CTX, model: 'gemini-2.5-flash' }],
      ['harness', PROFILE, { ...CTX, harness: 'claude-code' }],
    ]
    for (const [channel, profile, ctx] of perturbations) {
      const drifted = await fingerprintAgentProfile(profile, ctx)
      const drift = diffProfileFingerprints(base, drifted)
      expect(drift.equal, `expected drift on ${channel}`).toBe(false)
      expect(
        drift.drift.map((entry) => entry.channel),
        `expected channel ${channel} named in drift`,
      ).toContain(channel)
      expect(base.hash, `expected hash to move on ${channel}`).not.toBe(drifted.hash)
      expect(formatProfileDrift(drift)).toContain(channel)
    }
  })
})
