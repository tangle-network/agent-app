import { describe, it, expect } from 'vitest'
import {
  ToolInputError,
  buildAppToolOpenAITools,
  isAppToolName,
  createAppToolRuntimeExecutor,
  handleAppToolRequest,
  buildHttpMcpServer,
  buildAppToolMcpServer,
  type AppToolHandlers,
  type AppToolTaxonomy,
  type AppToolProducedEvent,
} from '../src/tools/index'

const taxonomy: AppToolTaxonomy = {
  proposalTypes: ['propose_swap', 'contact_lead', 'research', 'other'],
  regulatedTypes: ['propose_swap', 'contact_lead'],
}

/** In-memory handlers — a fake "product" so the generic layer is exercised
 *  with no DB. Records every call so assertions check the real dispatch. */
interface CallLog {
  submitProposal: Array<{ args: { type: string; title: string; description?: string | null }; ctx: unknown }>
  scheduleFollowup: Array<{ args: { dueDate: string }; ctx: unknown }>
  renderUi: Array<{ args: unknown; ctx: unknown }>
  addCitation: Array<{ args: unknown; ctx: unknown }>
}
function fakeHandlers(): { handlers: AppToolHandlers; calls: CallLog } {
  const calls: CallLog = { submitProposal: [], scheduleFollowup: [], renderUi: [], addCitation: [] }
  let n = 0
  const handlers: AppToolHandlers = {
    async submitProposal(args, ctx) {
      calls.submitProposal.push({ args, ctx })
      return { proposalId: `prop-${++n}`, deduped: args.title === 'dup' }
    },
    async scheduleFollowup(args, ctx) {
      calls.scheduleFollowup.push({ args, ctx })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate)) throw new ToolInputError('invalid_due_date', 'bad date')
      return { id: `fu-${++n}`, dueDate: args.dueDate, deduped: false }
    },
    async renderUi(args, ctx) {
      calls.renderUi.push({ args, ctx })
      if (typeof args.schema !== 'object' || args.schema === null || Array.isArray(args.schema)) {
        throw new ToolInputError('invalid_schema', 'schema must be an object')
      }
      const content = JSON.stringify({ title: args.title, schema: args.schema })
      return { path: `ui/${args.title}.json`, content }
    },
    async addCitation(args, ctx) {
      calls.addCitation.push({ args, ctx })
      if (args.quote === 'missing') throw new ToolInputError('quote_not_in_source', 'not found', 400)
      if (args.path === 'ghost') throw new ToolInputError('missing_vault_file', 'no file', 404)
      return { citationId: `cite-${++n}`, path: args.path }
    },
  }
  return { handlers, calls }
}

const okToken = async (userId: string, bearer: string) => bearer === `tok:${userId}`

describe('buildAppToolOpenAITools', () => {
  it('emits the four tools and parameterizes submit_proposal.type with the taxonomy', () => {
    const tools = buildAppToolOpenAITools(taxonomy)
    expect(tools.map((t) => t.function.name)).toEqual(['submit_proposal', 'schedule_followup', 'render_ui', 'add_citation'])
    const proposal = tools[0]!.function.parameters as { properties: { type: { enum: string[] } } }
    expect(proposal.properties.type.enum).toEqual(['propose_swap', 'contact_lead', 'research', 'other'])
  })
})

describe('isAppToolName', () => {
  it('recognizes the four tools and rejects others', () => {
    expect(isAppToolName('submit_proposal')).toBe(true)
    expect(isAppToolName('render_ui')).toBe(true)
    expect(isAppToolName('integration_invoke')).toBe(false)
    expect(isAppToolName('delete_everything')).toBe(false)
  })
})

describe('createAppToolRuntimeExecutor', () => {
  const ctx = { userId: 'u1', workspaceId: 'ws1', threadId: 't1' }

  it('dispatches submit_proposal to the handler and emits a proposal_created produced event', async () => {
    const { handlers, calls } = fakeHandlers()
    const produced: AppToolProducedEvent[] = []
    const exec = createAppToolRuntimeExecutor({ handlers, taxonomy, ctx, onProduced: (e) => produced.push(e) })

    const out = await exec({ toolName: 'submit_proposal', args: { type: 'propose_swap', title: 'Swap A', description: 'body' } })

    expect(out).toEqual({ ok: true, result: { status: 'queued_for_approval', proposalId: 'prop-1', deduped: false, regulated: true } })
    expect(calls.submitProposal).toHaveLength(1)
    expect((calls.submitProposal[0] as { ctx: unknown }).ctx).toEqual(ctx)
    expect(produced).toEqual([{ type: 'proposal_created', proposalId: 'prop-1', title: 'Swap A', status: 'pending' }])
  })

  it('labels a non-regulated proposal type as regulated:false', async () => {
    const { handlers } = fakeHandlers()
    const exec = createAppToolRuntimeExecutor({ handlers, taxonomy, ctx })
    const out = await exec({ toolName: 'submit_proposal', args: { type: 'research', title: 'R' } })
    expect(out).toMatchObject({ ok: true, result: { regulated: false } })
  })

  it('rejects an invalid proposal type and a missing title before calling the handler', async () => {
    const { handlers, calls } = fakeHandlers()
    const exec = createAppToolRuntimeExecutor({ handlers, taxonomy, ctx })
    expect(await exec({ toolName: 'submit_proposal', args: { type: 'nope', title: 'x' } })).toMatchObject({ ok: false, code: 'invalid_type' })
    expect(await exec({ toolName: 'submit_proposal', args: { type: 'research' } })).toMatchObject({ ok: false, code: 'missing_title' })
    expect(calls.submitProposal).toHaveLength(0)
  })

  it('emits an artifact produced event for render_ui and surfaces a ToolInputError as a failed outcome', async () => {
    const { handlers } = fakeHandlers()
    const produced: AppToolProducedEvent[] = []
    const exec = createAppToolRuntimeExecutor({ handlers, taxonomy, ctx, onProduced: (e) => produced.push(e) })

    const ok = await exec({ toolName: 'render_ui', args: { title: 'View', schema: { type: 'card' } } })
    expect(ok).toMatchObject({ ok: true, result: { path: 'ui/View.json' } })
    expect(produced).toEqual([{ type: 'artifact', path: 'ui/View.json', content: JSON.stringify({ title: 'View', schema: { type: 'card' } }) }])

    const bad = await exec({ toolName: 'render_ui', args: { title: 'View', schema: 'not-an-object' } })
    expect(bad).toMatchObject({ ok: false, code: 'invalid_schema' })
  })

  it('rejects an unknown tool name', async () => {
    const { handlers } = fakeHandlers()
    const exec = createAppToolRuntimeExecutor({ handlers, taxonomy, ctx })
    expect(await exec({ toolName: 'rm_rf', args: {} })).toMatchObject({ ok: false, code: 'unknown_tool' })
  })
})

describe('handleAppToolRequest', () => {
  function req(headers: Record<string, string>, body: unknown, method = 'POST'): Request {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...headers } }
    if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body)
    return new Request('https://app.example/api/tools/propose', init)
  }
  const goodHeaders = { Authorization: 'Bearer tok:u1', 'X-Agent-App-User-Id': 'u1', 'X-Agent-App-Workspace-Id': 'ws1' }

  it('authenticates, dispatches, and returns a structured success', async () => {
    const { handlers } = fakeHandlers()
    const res = await handleAppToolRequest(req(goodHeaders, { args: { type: 'propose_swap', title: 'Swap A' } }), {
      tool: 'submit_proposal', handlers, taxonomy, verifyToken: okToken, message: (r) => `queued ${(r as { proposalId: string }).proposalId}`,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, proposalId: 'prop-1', regulated: true, message: 'queued prop-1' })
  })

  it('rejects a token minted for another user (anti-impersonation)', async () => {
    const { handlers, calls } = fakeHandlers()
    const res = await handleAppToolRequest(req({ ...goodHeaders, Authorization: 'Bearer tok:attacker' }, { args: { type: 'propose_swap', title: 'x' } }), {
      tool: 'submit_proposal', handlers, taxonomy, verifyToken: okToken,
    })
    expect(res.status).toBe(401)
    expect(calls.submitProposal).toHaveLength(0)
  })

  it('rejects a missing workspace header with 400, a non-POST with 405', async () => {
    const { handlers } = fakeHandlers()
    const noWs = await handleAppToolRequest(req({ Authorization: 'Bearer tok:u1', 'X-Agent-App-User-Id': 'u1' }, { args: {} }), { tool: 'submit_proposal', handlers, taxonomy, verifyToken: okToken })
    expect(noWs.status).toBe(400)
    const get = await handleAppToolRequest(req(goodHeaders, {}, 'GET'), { tool: 'submit_proposal', handlers, taxonomy, verifyToken: okToken })
    expect(get.status).toBe(405)
  })

  it('maps a handler ToolInputError status through (e.g. 404 for a missing file)', async () => {
    const { handlers } = fakeHandlers()
    const res = await handleAppToolRequest(req(goodHeaders, { args: { path: 'ghost', quote: 'q' } }), { tool: 'add_citation', handlers, taxonomy, verifyToken: okToken })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'missing_vault_file' })
  })

  it('reads bare-body and `arguments` aliases, not just `args`', async () => {
    const { handlers, calls } = fakeHandlers()
    await handleAppToolRequest(req(goodHeaders, { type: 'research', title: 'bare' }), { tool: 'submit_proposal', handlers, taxonomy, verifyToken: okToken })
    await handleAppToolRequest(req(goodHeaders, { arguments: { type: 'research', title: 'aliased' } }), { tool: 'submit_proposal', handlers, taxonomy, verifyToken: okToken })
    expect((calls.submitProposal as Array<{ args: { title: string } }>).map((c) => c.args.title)).toEqual(['bare', 'aliased'])
  })
})

describe('buildAppToolMcpServer', () => {
  it('builds an http MCP entry with server-set identity headers; omits thread when null', () => {
    const withThread = buildAppToolMcpServer({
      tool: 'submit_proposal', baseUrl: 'https://app.example/', token: 'tok:u1',
      ctx: { userId: 'u1', workspaceId: 'ws1', threadId: 't1' }, description: 'd',
    })
    expect(withThread.transport).toBe('http')
    expect((withThread as { type?: string }).type).toBeUndefined()
    expect(withThread.url).toBe('https://app.example/api/tools/propose')
    expect(withThread.headers['X-Agent-App-User-Id']).toBe('u1')
    expect(withThread.headers['X-Agent-App-Workspace-Id']).toBe('ws1')
    expect(withThread.headers['X-Agent-App-Thread-Id']).toBe('t1')
    expect(withThread.headers.Authorization).toBe('Bearer tok:u1')

    const noThread = buildAppToolMcpServer({
      tool: 'render_ui', baseUrl: 'https://app.example', token: 't',
      ctx: { userId: 'u1', workspaceId: 'ws1', threadId: null }, description: 'd',
    })
    expect(noThread.url).toBe('https://app.example/api/tools/render-ui')
    expect(noThread.headers['X-Agent-App-Thread-Id']).toBeUndefined()
  })

  it('buildHttpMcpServer omits workspace/thread headers when empty (user-scoped bridge like integration_invoke)', () => {
    const s = buildHttpMcpServer({
      path: '/api/tools/integration-invoke', baseUrl: 'https://app.example/', token: 'tok',
      ctx: { userId: 'u1', workspaceId: '', threadId: null }, description: 'hub bridge',
      headerNames: { userId: 'X-Insurance-User-Id', workspaceId: 'X-Insurance-Workspace-Id', threadId: 'X-Insurance-Thread-Id' },
    })
    expect(s.url).toBe('https://app.example/api/tools/integration-invoke')
    expect(s.headers['X-Insurance-User-Id']).toBe('u1')
    expect(s.headers['X-Insurance-Workspace-Id']).toBeUndefined()
    expect(s.headers['X-Insurance-Thread-Id']).toBeUndefined()
  })

  it('honors custom header names + paths', () => {
    const s = buildAppToolMcpServer({
      tool: 'submit_proposal', baseUrl: 'https://x', token: 't',
      ctx: { userId: 'u', workspaceId: 'w', threadId: null }, description: 'd',
      headerNames: { userId: 'X-Insurance-User-Id', workspaceId: 'X-Insurance-Workspace-Id', threadId: 'X-Insurance-Thread-Id' },
      paths: { submit_proposal: '/api/tools/propose' },
    })
    expect(s.headers['X-Insurance-User-Id']).toBe('u')
    expect(s.url).toBe('https://x/api/tools/propose')
  })
})
