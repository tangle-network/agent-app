import { describe, expect, it, vi } from 'vitest'
import { composeRouterTurnPrompt, placeRouterTurn, routerFunctionName, runRouterTurn, workspaceTurnCheckpoints, type RouterTurnEvent, type RouterTurnTool } from '../src/runtime/router-turn'
import { createInMemoryWorkspaceStore } from '@tangle-network/agent-runtime/workspace-store'

/** One Router chat completion streamed as OpenAI server-sent events. */
function sse(chunks: unknown[], headers: Record<string, string> = {}) {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } })
}
const text = (value: string) => ({ model: 'served/model', choices: [{ delta: { content: value } }] })
const toolCall = (id: string, name: string, args: string) => ({ model: 'served/model',
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] })

function router(...responses: Array<Response | (() => Response)>) {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    const next = responses.shift()
    if (!next) throw new Error('unexpected model call')
    return typeof next === 'function' ? next() : next
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests, calls: fetchImpl }
}

const createTask: RouterTurnTool = {
  name: 'staff.task.create',
  description: 'Create a task.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  run: vi.fn(async (args: Record<string, unknown>) => ({ taskId: 'task-1', title: args.title })),
}

describe('runRouterTurn', () => {
  it('streams words, runs an app tool in-process, and returns the answer with the served model', async () => {
    const { fetchImpl, requests } = router(
      sse([toolCall('call-1', 'staff_task_create', '{"title":"Restock towels"}')]),
      sse([text('Done: '), text('Restock towels is on the list.')]),
    )
    const events: RouterTurnEvent[] = []
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'requested/model', fetchImpl, traceId: 'trace-1',
      systemPrompt: 'You are Pablo.', userMessage: 'Create a task to restock towels', tools: [createTask],
      history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }], onEvent: event => events.push(event) })

    expect(outcome).toEqual({ text: 'Done: Restock towels is on the list.', servedModel: 'served/model',
      toolCalls: [{ callId: 'call-1', toolName: 'staff.task.create', ok: true }],
      usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 }, toolEvents: [] })
    expect(createTask.run).toHaveBeenCalledWith({ title: 'Restock towels' }, { emit: expect.any(Function) })
    expect(requests[0]!.headers.get('x-tangle-trace-id')).toBe('trace-1')
    expect(requests[0]!.body).toMatchObject({ model: 'requested/model', stream: true,
      tools: [{ type: 'function', function: { name: 'staff_task_create' } }] })
    expect(requests[0]!.body.messages).toEqual([{ role: 'system', content: 'You are Pablo.' },
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Create a task to restock towels' }])
    // The model reads its own call and the result back, keyed to the call.
    expect(requests[1]!.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: '{"taskId":"task-1","title":"Restock towels"}' })]))
    expect(events.map(event => event.type === 'text' ? `text:${event.delta}` : event.type === 'tool' ? `tool:${event.status}` : 'usage'))
      .toEqual(['tool:running', 'tool:completed', 'text:Done: ', 'text:Restock towels is on the list.'])
  })

  it('reports a domain refusal to the model and lets it answer', async () => {
    const refused: RouterTurnTool = { ...createTask, run: async () => {
      throw Object.assign(new Error('Only managers can create tasks'), { code: 'forbidden', status: 403 })
    } }
    const { fetchImpl, requests } = router(sse([toolCall('call-1', 'staff_task_create', '{"title":"x"}')]),
      sse([text('Only a manager can create that task.')]))
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'u', tools: [refused] })
    expect(outcome.failure).toBeUndefined()
    expect(outcome.toolCalls).toEqual([{ callId: 'call-1', toolName: 'staff.task.create', ok: false }])
    expect(requests[1]!.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: 'Error (forbidden): Only managers can create tasks' })]))
  })

  it('hides an unexpected tool error from the model and hands it to the app', async () => {
    const broken: RouterTurnTool = { ...createTask, run: async () => { throw new Error('D1 exploded: secret detail') } }
    const onToolFailure = vi.fn()
    const { fetchImpl, requests } = router(sse([toolCall('call-1', 'staff_task_create', '{}')]), sse([text('Sorry.')]))
    await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'u', tools: [broken], onToolFailure })
    expect(onToolFailure).toHaveBeenCalledWith('staff.task.create', expect.any(Error))
    expect(JSON.stringify(requests[1]!.body.messages)).not.toContain('secret detail')
  })

  it('repeats a turn that ended with no word and no tool, and types a still-empty answer as a failure', async () => {
    const empty = () => sse([{ model: 'served/model', choices: [{ delta: {}, finish_reason: 'stop' }] }])
    const recovered = router(empty(), sse([text('Saved: the pool closes at 9pm on Sundays.')]))
    const ok = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: recovered.fetchImpl, systemPrompt: 's', userMessage: 'u' })
    expect(ok).toMatchObject({ text: 'Saved: the pool closes at 9pm on Sundays.' })
    expect(ok.failure).toBeUndefined()
    const blank = router(empty(), empty())
    const failed = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: blank.fetchImpl, systemPrompt: 's', userMessage: 'u' })
    expect(failed).toMatchObject({ text: '', failure: { code: 'model_empty' } })
    expect(blank.calls).toHaveBeenCalledTimes(2)
    // A tool already ran, so the turn is not repeated: the empty answer is reported, the effect kept.
    const afterTool = router(sse([toolCall('call-1', 'staff_task_create', '{"title":"x"}')]), empty())
    const reported = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: afterTool.fetchImpl, systemPrompt: 's',
      userMessage: 'u', tools: [createTask] })
    expect(reported).toMatchObject({ failure: { code: 'model_empty' }, toolCalls: [{ toolName: 'staff.task.create', ok: true }] })
    expect(afterTool.calls).toHaveBeenCalledTimes(2)
  })

  it('repeats one model call that failed before any word or tool, then returns a failure without throwing', async () => {
    const down = () => new Response('upstream down', { status: 502 })
    const twice = router(down, down)
    await expect(runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: twice.fetchImpl, systemPrompt: 's', userMessage: 'u' }))
      .resolves.toMatchObject({ failure: { code: 'model_http_502', status: 502 } })
    expect(twice.calls).toHaveBeenCalledTimes(2)

    const recovers = router(down, sse([text('Hello.')]))
    await expect(runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: recovers.fetchImpl, systemPrompt: 's', userMessage: 'u' }))
      .resolves.toEqual({ text: 'Hello.', servedModel: 'served/model', toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 }, toolEvents: [] })
  })

  it('never repeats a turn after a tool ran', async () => {
    const { fetchImpl, calls } = router(sse([toolCall('call-1', 'staff_task_create', '{"title":"x"}')]),
      () => new Response('down', { status: 503 }))
    const run = vi.fn(async () => ({ ok: true }))
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'u',
      tools: [{ ...createTask, run }] })
    expect(outcome.failure).toMatchObject({ code: 'model_http_503' })
    expect(run).toHaveBeenCalledOnce()
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('echoes the thought_signature Gemini 3 attached to a tool call on the next request', async () => {
    // gemini-3.5-flash(-lite) answers HTTP 400 "Function call is missing a thought_signature"
    // when the assistant tool_calls entry in the follow-up request lacks extra_content.
    const extraContent = { google: { thought_signature: 'sig-abc' } }
    const signedCall = { model: 'served/model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1',
      function: { name: 'staff_task_create', arguments: '{"title":"Restock towels"}' }, extra_content: extraContent }] },
      finish_reason: 'tool_calls' }] }
    const { fetchImpl, requests } = router(sse([signedCall]), sse([text('Done.')]))
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'u', tools: [createTask] })
    expect(outcome.failure).toBeUndefined()
    const assistant = (requests[1]!.body.messages as Array<Record<string, unknown>>)
      .find(message => message.role === 'assistant' && message.tool_calls) as { tool_calls: Array<Record<string, unknown>> }
    expect(assistant.tool_calls[0]!.extra_content).toEqual(extraContent)
    expect(assistant.tool_calls[0]).toMatchObject({ id: 'call-1', type: 'function', function: { name: 'staff_task_create' } })
  })

  it('counts a model call once when the Router reports its usage on more than one chunk', async () => {
    // The Router repeats cumulative usage within one streamed call; summing each report
    // over-counted a one-call turn about 3x in production.
    const { fetchImpl } = router(sse([
      { ...text('Hello'), usage: { prompt_tokens: 8000, completion_tokens: 1 } },
      { ...text('!'), usage: { prompt_tokens: 8000, completion_tokens: 2 } },
      { choices: [], usage: { prompt_tokens: 8000, completion_tokens: 3 } },
    ]))
    const events: RouterTurnEvent[] = []
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'hello',
      onEvent: event => events.push(event) })
    expect(outcome.usage).toEqual({ promptTokens: 8000, completionTokens: 3, modelCalls: 1 })
    expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', promptTokens: 8000, completionTokens: 3 }])
  })

  it('returns a continuation at the budget, and a later hop finishes the same turn from it', async () => {
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const slowTask: RouterTurnTool = { ...createTask, run: vi.fn(async () => { now = 60_000; return { taskId: 'task-1' } }) }
      const first = router(sse([text('Working on it. '), toolCall('call-1', 'staff_task_create', '{"title":"Audit"}')]))
      const hop1 = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: first.fetchImpl, budgetMs: 30_000,
        systemPrompt: 's', userMessage: 'Run the audit', tools: [slowTask] })
      expect(hop1.failure).toBeUndefined()
      expect(hop1.text).toBe('Working on it.')
      expect(hop1.continuation).toMatchObject({ hops: 1, text: 'Working on it.' })
      expect(hop1.continuation!.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
      // Saved between hops in the workspace store, outside /files/.
      const workspace = createInMemoryWorkspaceStore()
      const checkpoints = workspaceTurnCheckpoints(workspace, 'ws', 'agent')
      await checkpoints.save('turn-1', hop1.continuation!)
      expect(await workspace.list('ws', '/files/')).toEqual([])
      const stored = (await checkpoints.load('turn-1'))!

      const second = router(sse([]))
      const hop2 = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: second.fetchImpl, budgetMs: 30_000,
        systemPrompt: 's', userMessage: 'ignored', continueFrom: stored, tools: [slowTask] })
      expect(second.requests[0]!.body.messages).toEqual([{ role: 'system', content: 's' }, ...stored.messages])
      // The model ended silently after the tool; the turn already spoke in hop 1, so this is not an empty reply.
      expect(hop2.failure).toBeUndefined()
      expect(hop2.text).toBe('Working on it.')
      expect(hop2.continuation).toBeUndefined()
      expect(slowTask.run).toHaveBeenCalledTimes(1)
      await checkpoints.clear('turn-1')
      expect(await checkpoints.load('turn-1')).toBeNull()
    } finally { clock.mockRestore() }
  })

  it('places the turn before any model call: tools stay in the loop, a computer need goes to the sandbox', async () => {
    const plain = { name: 'Pablo', model: { default: 'm' }, prompt: { systemPrompt: 's' }, permissions: { bash: 'deny' } }
    expect(placeRouterTurn({ profile: plain })).toMatchObject({ chosen: 'inference' })
    expect(placeRouterTurn({ profile: plain, toolNames: ['staff.task.create'] })).toMatchObject({ chosen: 'loop' })
    expect(placeRouterTurn({ profile: plain, requestedModel: 'other/model' }))
      .toMatchObject({ chosen: 'sandbox', reason: expect.stringContaining('differs from the profile model') })
    const withMcp = { ...plain, mcp: { crm: { type: 'remote', url: 'https://crm.example/mcp' } } }
    expect(placeRouterTurn({ profile: withMcp }).chosen).toBe('sandbox')

    const { fetchImpl, calls } = router()
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'u',
      tools: [createTask], placement: { profile: withMcp } })
    expect(calls).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ text: '', placement: { chosen: 'sandbox' }, failure: { code: 'placement_sandbox' } })

    const loop = router(sse([text('Hi.')]))
    const placed = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl: loop.fetchImpl, systemPrompt: 's', userMessage: 'u',
      tools: [createTask], placement: { profile: plain } })
    expect(placed).toMatchObject({ text: 'Hi.', placement: { chosen: 'loop' } })
    expect(placed.failure).toBeUndefined()
  })

  it('streams a tool\'s typed side events in order before its result, and records them with the turn', async () => {
    const graph: RouterTurnTool = {
      name: 'graph.edit', description: 'Edit the system map.', inputSchema: { type: 'object', properties: {} },
      run: async (_args, context) => {
        context.emit('graph_op', { op: 'add_node', id: 'pump' })
        context.emit('graph_op', { op: 'add_edge', from: 'pump', to: 'tank' })
        return { ok: true }
      },
    }
    const { fetchImpl } = router(sse([toolCall('call-1', 'graph_edit', '{}')]), sse([text('Added the pump.')]))
    const events: RouterTurnEvent[] = []
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'add a pump',
      tools: [graph], onEvent: event => events.push(event) })
    expect(events.filter(event => event.type !== 'usage').map(event => event.type === 'tool' ? `tool:${event.status}` : event.type === 'tool_event' ? `event:${event.kind}` : event.type))
      .toEqual(['tool:running', 'event:graph_op', 'event:graph_op', 'tool:completed', 'text'])
    expect(outcome.toolEvents).toEqual([
      { callId: 'call-1', toolName: 'graph.edit', kind: 'graph_op', data: { op: 'add_node', id: 'pump' }, at: expect.any(Number) },
      { callId: 'call-1', toolName: 'graph.edit', kind: 'graph_op', data: { op: 'add_edge', from: 'pump', to: 'tank' }, at: expect.any(Number) },
    ])
  })

  it('refuses to run without a credential', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(runRouterTurn({ apiKey: '', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'u' }))
      .resolves.toMatchObject({ failure: { code: 'router_unconfigured' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

/** One buffered Router chat completion. */
const completion = (message: Record<string, unknown>) => Response.json({ model: 'served/model',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 } })
const calls = (...names: string[]) => names.map((name, index) => ({ id: `call-${index + 1}`, type: 'function',
  function: { name, arguments: JSON.stringify({ title: `Task ${index + 1}` }) } }))

describe('runRouterTurn bounded options', () => {
  it('takes buffered completions, tool calls included, with the ceilings and reasoning effort it was given', async () => {
    const { fetchImpl, requests } = router(completion({ content: null, tool_calls: calls('staff_task_create') }),
      completion({ content: 'Created.' }))
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, stream: false, reasoningEffort: 'none',
      maxTokens: 100, maxCompletionTokens: 200, systemPrompt: 's', userMessage: 'u', tools: [createTask] })
    expect(outcome.failure).toBeUndefined()
    expect(outcome).toMatchObject({ text: 'Created.', servedModel: 'served/model',
      toolCalls: [{ callId: 'call-1', toolName: 'staff.task.create', ok: true }], usage: { promptTokens: 6, completionTokens: 4, modelCalls: 2 } })
    expect(requests[0]!.body).not.toHaveProperty('stream')
    expect(requests[0]!.body).toMatchObject({ reasoning_effort: 'none', max_tokens: 100, max_completion_tokens: 200 })
  })

  it('refuses the tool call past its cap before it runs and ends the turn there', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const { fetchImpl, calls: modelCalls } = router(completion({ content: null, tool_calls: calls('staff_task_create', 'staff_task_create') }))
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, stream: false, maxToolCalls: 1,
      systemPrompt: 's', userMessage: 'u', tools: [{ ...createTask, run }] })
    expect(run).toHaveBeenCalledOnce()
    expect(modelCalls).toHaveBeenCalledOnce()
    expect(outcome.failure?.code).toBe('turn_tool_limit')
    expect(outcome.toolCalls.map(call => call.ok)).toEqual([true, false])
  })

  it('sends nothing more once cancelled, even when the injected fetch ignores the signal', async () => {
    const controller = new AbortController()
    const run = vi.fn(async () => { controller.abort(); throw new Error('cancelled') })
    const { fetchImpl, calls: modelCalls } = router(completion({ content: null, tool_calls: calls('staff_task_create') }),
      completion({ content: 'Never read.' }))
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, stream: false, signal: controller.signal,
      systemPrompt: 's', userMessage: 'u', tools: [{ ...createTask, run }] })
    expect(modelCalls).toHaveBeenCalledOnce()
    expect(outcome.failure?.code).toBe('turn_aborted')
  })

  it('returns the first model failure as it happened when repeats are off', async () => {
    const { fetchImpl, calls: modelCalls } = router(new Response('busy', { status: 503 }), completion({ content: 'Never read.' }))
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, stream: false, repeat: false, systemPrompt: 's', userMessage: 'u' })
    expect(modelCalls).toHaveBeenCalledOnce()
    expect(outcome.failure).toMatchObject({ code: 'model_http_503', status: 503 })
  })

  it('lets the app word what the model reads for a tool result', async () => {
    const { fetchImpl, requests } = router(completion({ content: null, tool_calls: calls('staff_task_create') }), completion({ content: 'Done.' }))
    await runRouterTurn({ apiKey: 'k', model: 'm', fetchImpl, stream: false, systemPrompt: 's', userMessage: 'u', tools: [createTask],
      renderToolResult: (toolName, outcome) => `${toolName}: ${outcome.ok ? 'saved' : outcome.message}` })
    expect(requests[1]!.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: 'staff.task.create: saved' })]))
  })
})

describe('composeRouterTurnPrompt', () => {
  it('joins the profile prompt, instructions and context, naming tools as the model calls them', () => {
    expect(routerFunctionName('workspace.member.language.read')).toBe('workspace_member_language_read')
    expect(composeRouterTurnPrompt(
      { prompt: { systemPrompt: 'You are Pablo.', instructions: ['Use staff.task.create for tasks.', 'Use staff.tasks to read them.'] } },
      { context: ['Current time: Sunday.'], toolNames: ['staff.tasks', 'staff.task.create'] },
    )).toBe('You are Pablo.\n\nUse staff_task_create for tasks.\n\nUse staff_tasks to read them.\n\nCurrent time: Sunday.')
  })
})
