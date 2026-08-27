import { describe, it, expect } from 'vitest'
import {
  createSurfaceRegistry,
  defineSurfaceKind,
  mergeSurfaceOverlay,
  type SurfaceOverlay,
} from '../../src/runtime/surface-profile'
import { buildHttpMcpServer, type AppToolMcpServer } from '../../src/tools/mcp'
import { createCapabilityToken } from '../../src/tools/capability'

const SECRET = 'surface-test-secret'

function server(url = 'https://app.example.com/api/tools/x'): AppToolMcpServer {
  return {
    transport: 'http',
    url,
    headers: { Authorization: 'Bearer cap_x', 'Content-Type': 'application/json' },
    enabled: true,
    metadata: { description: 'test server' },
  }
}

/** The worked example, in the per-request shape the module doc prescribes:
 *  the request handler builds the registry closing over server-trusted state
 *  (the capability secret and the AUTHENTICATED user/workspace) — the client
 *  ctx carries ONLY routing data (which sequence is open), never identity. */
function sequencesRegistryFor(server: { secret: string; userId: string; workspaceId: string }) {
  return createSurfaceRegistry([
    defineSurfaceKind<{ sequenceId: string }>({
      kind: 'sequences',
      build: async (ctx) => {
        const token = await createCapabilityToken(server.userId, { secret: server.secret })
        if (!token) throw new Error('capability secret unconfigured — refusing to mount the sequence MCP server')
        return {
          mcp: {
            sequence_edit: buildHttpMcpServer({
              path: '/api/tools/sequence-edit',
              baseUrl: 'https://app.example.com',
              token,
              ctx: { userId: server.userId, workspaceId: server.workspaceId, threadId: null },
              description: 'Apply timeline operations to the active sequence.',
            }),
          },
          promptAddendum: `The user has sequence ${ctx.sequenceId} open in the timeline editor.`,
          permissions: { 'vault.purge': 'deny' },
        }
      },
    }),
  ])
}

describe('surface registry', () => {
  it('resolves a registered kind: identity from the request closure, routing from ctx', async () => {
    const registry = sequencesRegistryFor({ secret: SECRET, userId: 'user-1', workspaceId: 'ws-1' })
    const overlay = await registry.resolve('sequences', { sequenceId: 'seq-1' })

    const entry = overlay.mcp!.sequence_edit!
    expect(entry.url).toBe('https://app.example.com/api/tools/sequence-edit')
    // The Authorization header carries a real minted capability token bound to
    // the acting user — not anything the client request could have supplied.
    const expected = await createCapabilityToken('user-1', { secret: SECRET })
    expect(entry.headers.Authorization).toBe(`Bearer ${expected}`)
    expect(entry.headers['X-Agent-App-User-Id']).toBe('user-1')
    expect(entry.headers['X-Agent-App-Workspace-Id']).toBe('ws-1')
    expect(overlay.promptAddendum).toContain('seq-1')
  })

  it('throws on an unknown kind and names the registered kinds', async () => {
    const registry = sequencesRegistryFor({ secret: SECRET, userId: 'user-1', workspaceId: 'ws-1' })
    await expect(registry.resolve('briefs', {})).rejects.toThrow(
      /unknown surface kind 'briefs' — registered kinds: sequences/,
    )
  })

  it('throws on duplicate kind registration', () => {
    const duplicate = defineSurfaceKind<Record<string, never>>({ kind: 'sequences', build: () => ({}) })
    expect(() => createSurfaceRegistry([duplicate, duplicate])).toThrow(
      /duplicate surface kind 'sequences'/,
    )
  })

  it('rejects a malformed kind at definition time', () => {
    expect(() => defineSurfaceKind({ kind: '', build: () => ({}) })).toThrow(/non-empty string/)
    expect(() => defineSurfaceKind({ kind: 'two words', build: () => ({}) })).toThrow(/without whitespace/)
  })

  it('rejects a built overlay carrying a non-absolute MCP url', async () => {
    const broken = defineSurfaceKind<Record<string, never>>({
      kind: 'broken',
      build: () => ({ mcp: { bad: { ...server(), url: '/api/relative' } } }),
    })
    const registry = createSurfaceRegistry([broken])
    await expect(registry.resolve('broken', {})).rejects.toThrow(/'bad' url must be an absolute URL/)
  })

  it('rejects a built overlay carrying a blank promptAddendum', async () => {
    const blank = defineSurfaceKind<Record<string, never>>({
      kind: 'blank',
      build: () => ({ promptAddendum: '   ' }),
    })
    const registry = createSurfaceRegistry([blank])
    await expect(registry.resolve('blank', {})).rejects.toThrow(/promptAddendum must be a non-blank string/)
  })
})

describe('mergeSurfaceOverlay', () => {
  it('adds overlay mcp under new names and preserves unrelated base fields', () => {
    const base = {
      name: 'workspace-agent',
      mcp: { submit_proposal: server('https://app.example.com/api/tools/propose') },
      systemPromptAddendum: 'Workspace baseline guidance.',
    }
    const overlay: SurfaceOverlay = {
      mcp: { sequence_edit: server() },
      promptAddendum: 'Surface guidance.',
    }

    const merged = mergeSurfaceOverlay(base, overlay)
    expect(Object.keys(merged.mcp!)).toEqual(['submit_proposal', 'sequence_edit'])
    expect(merged.name).toBe('workspace-agent')
    // Merged copy: the base object is untouched.
    expect(Object.keys(base.mcp)).toEqual(['submit_proposal'])
    expect(base.systemPromptAddendum).toBe('Workspace baseline guidance.')
  })

  it('throws on an mcp name collision and names every colliding key', () => {
    const base = { mcp: { sequence_edit: server(), submit_proposal: server() } }
    const overlay: SurfaceOverlay = { mcp: { sequence_edit: server(), submit_proposal: server() } }
    expect(() => mergeSurfaceOverlay(base, overlay)).toThrow(
      /collision: 'sequence_edit', 'submit_proposal' already exist/,
    )
  })

  it('appends the prompt addendum with a blank-line separator', () => {
    const merged = mergeSurfaceOverlay(
      { systemPromptAddendum: 'Base addendum.' },
      { promptAddendum: 'Surface addendum.' },
    )
    expect(merged.systemPromptAddendum).toBe('Base addendum.\n\nSurface addendum.')
  })

  it('uses the overlay addendum verbatim when the base has none', () => {
    expect(mergeSurfaceOverlay({}, { promptAddendum: 'Only surface.' }).systemPromptAddendum).toBe('Only surface.')
    expect(
      mergeSurfaceOverlay({ systemPromptAddendum: '' }, { promptAddendum: 'Only surface.' }).systemPromptAddendum,
    ).toBe('Only surface.')
  })

  it('leaves the base addendum unchanged when the overlay has none', () => {
    const merged = mergeSurfaceOverlay({ systemPromptAddendum: 'Base only.' }, { mcp: { extra: server() } })
    expect(merged.systemPromptAddendum).toBe('Base only.')
  })

  it('merges permissions with stricter-wins: a surface tightens, never relaxes', () => {
    const base = { permissions: { 'network.send': 'ask' as const, bash: 'allow' as const } }
    const merged = mergeSurfaceOverlay(base, {
      permissions: {
        'network.send': 'allow', // attempt to relax — base 'ask' survives
        bash: 'deny', // tighten — overlay wins
        'generation.video': 'ask', // new key — overlay applies
      },
    })
    expect(merged.permissions).toEqual({ 'network.send': 'ask', bash: 'deny', 'generation.video': 'ask' })
    expect(base.permissions).toEqual({ 'network.send': 'ask', bash: 'allow' })
  })

  it('rejects an off-vocabulary permission value', () => {
    expect(() =>
      mergeSurfaceOverlay({}, { permissions: { bash: 'always' as unknown as 'allow' } }),
    ).toThrow(/permission 'bash' must be 'allow' \| 'ask' \| 'deny'/)
  })
})
