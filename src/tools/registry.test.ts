import { describe, expect, it } from 'vitest'

import { ToolInputError } from './errors'
import { dispatchAppTool } from './dispatch'
import { buildAppToolOpenAITools } from './openai'
import { buildAppToolMcpServer } from './mcp'
import { handleAppToolRequest } from './http'
import { defineAppTool } from './registry'
import type { AppToolHandlers, AppToolTaxonomy } from './types'

const taxonomy: AppToolTaxonomy = { proposalTypes: ['other'], regulatedTypes: [] }
const ctx = { userId: 'u', workspaceId: 'w', threadId: 't' }

// The four built-ins are unused by a custom-tool call but DispatchOptions still
// requires them (consumers that register a fifth tool also have the built-ins).
function noopHandlers(): AppToolHandlers {
  return {
    async submitProposal() {
      return { proposalId: 'p', deduped: false }
    },
    async scheduleFollowup() {
      return { id: 'f', dueDate: '2026-01-01', deduped: false }
    },
    async renderUi() {
      return { path: 'ui/x.json', content: '{}' }
    },
    async addCitation() {
      return { citationId: 'c', path: 'v/x.md' }
    },
  }
}

const setConfig = defineAppTool<{ stage?: string }>({
  name: 'set_config',
  description: 'Update workspace settings.',
  path: '/api/tools/set-config',
  parameters: {
    type: 'object',
    properties: { stage: { type: 'string' } },
  },
  execute: async (args) => {
    if (args.stage === 'bad') throw new ToolInputError('invalid_stage', 'stage is invalid')
    return { saved: true, stage: args.stage ?? null }
  },
})

describe('defineAppTool', () => {
  it('rejects a name that collides with a built-in', () => {
    expect(() => defineAppTool({ name: 'submit_proposal', description: 'x', parameters: {}, execute: () => null })).toThrow(
      /built-in/,
    )
  })
  it('rejects an empty name', () => {
    expect(() => defineAppTool({ name: '  ', description: 'x', parameters: {}, execute: () => null })).toThrow(/name is required/)
  })
})

describe('dispatchAppTool — custom tools', () => {
  it('routes an unknown-to-built-ins name to the registered tool and returns its result', async () => {
    const outcome = await dispatchAppTool('set_config', { stage: 'launch' }, ctx, {
      handlers: noopHandlers(),
      taxonomy,
      customTools: [setConfig],
    })
    expect(outcome).toEqual({ ok: true, result: { saved: true, stage: 'launch' } })
  })

  it('maps a ToolInputError from execute to a correctable failure (never a silent success)', async () => {
    const outcome = await dispatchAppTool('set_config', { stage: 'bad' }, ctx, {
      handlers: noopHandlers(),
      taxonomy,
      customTools: [setConfig],
    })
    expect(outcome).toEqual({ ok: false, code: 'invalid_stage', message: 'stage is invalid', status: 400 })
  })

  it('still rejects a genuinely unknown tool', async () => {
    const outcome = await dispatchAppTool('nope', {}, ctx, { handlers: noopHandlers(), taxonomy, customTools: [setConfig] })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('unknown_tool')
  })

  it('does not disturb the built-ins', async () => {
    const outcome = await dispatchAppTool('add_citation', { path: 'v/a.md', quote: 'q' }, ctx, {
      handlers: noopHandlers(),
      taxonomy,
      customTools: [setConfig],
    })
    // dispatch returns the handler's result path, not the input path.
    expect(outcome).toEqual({ ok: true, result: { citationId: 'c', path: 'v/x.md' } })
  })
})

describe('buildAppToolOpenAITools — custom tools appended', () => {
  it('keeps the four built-ins first and adds the custom def last', () => {
    const tools = buildAppToolOpenAITools(taxonomy, { customTools: [setConfig] })
    expect(tools.map((t) => t.function.name)).toEqual([
      'submit_proposal',
      'schedule_followup',
      'render_ui',
      'add_citation',
      'set_config',
    ])
  })
  it('is unchanged when no custom tools are passed', () => {
    expect(buildAppToolOpenAITools(taxonomy)).toHaveLength(4)
  })
})

describe('buildAppToolMcpServer — custom tools', () => {
  it('builds the entry at the tool’s own path', () => {
    const server = buildAppToolMcpServer({
      tool: setConfig,
      baseUrl: 'https://app.example.com/',
      token: 'tok',
      ctx,
      description: 'd',
    })
    expect(server.url).toBe('https://app.example.com/api/tools/set-config')
    expect(server.headers.Authorization).toBe('Bearer tok')
  })
  it('throws when a custom tool has no path', () => {
    const noPath = defineAppTool({ name: 'no_path', description: 'd', parameters: {}, execute: () => null })
    expect(() => buildAppToolMcpServer({ tool: noPath, baseUrl: 'https://x', token: 't', ctx, description: 'd' })).toThrow(
      /no route path/,
    )
  })
})

describe('handleAppToolRequest — custom tool end to end', () => {
  it('authenticates, dispatches the custom tool, and returns its result (one-liner route)', async () => {
    const request = new Request('https://app.example.com/api/tools/set-config', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok',
        'X-Agent-App-User-Id': 'u',
        'X-Agent-App-Workspace-Id': 'w',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: { stage: 'scale' } }),
    })
    const res = await handleAppToolRequest(request, {
      tool: setConfig,
      verifyToken: async () => true,
      handlers: noopHandlers(),
      taxonomy,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, saved: true, stage: 'scale' })
  })
})
