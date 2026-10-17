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

describe('proxy secret authority fingerprints', () => {
  const binding = {
    envName: 'REPORTS_TOKEN',
    secretRef: { kind: 'secret-ref', key: 'reporting-api' },
    hosts: ['reports.example.com'],
    presentation: { type: 'bearer' },
    methods: ['POST'],
    paths: ['/v1/events'],
    ttlSeconds: 300,
  } satisfies NonNullable<AgentProfile['proxySecrets']>[number]

  it('detects authority changes without publishing references or destinations', async () => {
    const base = await fingerprintAgentProfile({ ...PROFILE, proxySecrets: [binding] }, CTX)
    const changes = [
      { secretRef: { kind: 'secret-ref', key: 'other-api' } },
      { hosts: ['other.example.com'] },
      { presentation: { type: 'header', name: 'X-Reports-Key' } },
      { methods: ['GET'] },
      { paths: ['/v1/accounts'] },
      { ttlSeconds: 60 },
    ] satisfies Partial<NonNullable<AgentProfile['proxySecrets']>[number]>[]
    for (const change of changes) {
      const updated = await fingerprintAgentProfile({
        ...PROFILE, proxySecrets: [{ ...binding, ...change }],
      }, CTX)
      expect(updated.hash).not.toBe(base.hash)
      const drift = diffProfileFingerprints(base, updated)
      expect(drift.equal).toBe(false)
      expect(drift.drift.map(({ channel }) => channel)).toContain('proxySecretAuthoritySha')
      const publicEvidence = JSON.stringify([base, updated, formatProfileDrift(drift)])
      expect(publicEvidence).not.toContain(binding.secretRef.key)
      expect(publicEvidence).not.toContain(binding.hosts[0])
    }
  })

  it('binds protected MCP endpoints and tagged references into authority identity', async () => {
    const server = {
      transport: 'http',
      url: 'https://reports.example.com/mcp',
      headers: { Authorization: { kind: 'secret-ref', key: 'reports-mcp' } },
    } satisfies NonNullable<AgentProfile['mcp']>[string]
    const protectedProfile: AgentProfile = {
      ...PROFILE, proxySecrets: [binding], mcp: { reports: server },
    }
    const base = await fingerprintAgentProfile(protectedProfile, CTX)
    for (const changed of [
      { ...server, url: 'https://reports.example.com/other-mcp' },
      { ...server, headers: { Authorization: { kind: 'secret-ref', key: 'other-mcp' } } },
    ] satisfies (typeof server)[]) {
      const updated = await fingerprintAgentProfile({
        ...protectedProfile, mcp: { reports: changed },
      }, CTX)
      expect(updated.mcpKeys).toEqual(base.mcpKeys)
      expect(updated.hash).not.toBe(base.hash)
      expect(diffProfileFingerprints(base, updated).drift.map(({ channel }) => channel))
        .toContain('proxySecretAuthoritySha')
    }
  })

  it('preserves absent legacy identity and distinguishes explicit binding revocation', async () => {
    const absent = await fingerprintAgentProfile(PROFILE, CTX)
    const empty = await fingerprintAgentProfile({ ...PROFILE, proxySecrets: [] }, CTX)
    expect(empty.hash).not.toBe(absent.hash)
    expect(diffProfileFingerprints(absent, empty).drift.map(({ channel }) => channel))
      .toContain('proxySecretAuthoritySha')
    // Golden identity from the pre-proxy public profile fixture.
    expect(absent.hash).toBe('705678a7c2407968d5725669fbcf95580be4cf75994a2ae8361d66ed6285b133')
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
