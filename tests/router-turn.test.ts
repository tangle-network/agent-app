import { describe, expect, it, vi } from 'vitest'
import { composeRouterTurnPrompt, placeRouterTurn, routerFunctionName, runRouterTurn, type RouterTurnEvent, type RouterTurnTool } from '../src/runtime/router-turn'

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
      usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 } })
    expect(createTask.run).toHaveBeenCalledWith({ title: 'Restock towels' })
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
        usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 } })
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

  it('refuses to run without a credential', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(runRouterTurn({ apiKey: '', model: 'm', fetchImpl, systemPrompt: 's', userMessage: 'u' }))
      .resolves.toMatchObject({ failure: { code: 'router_unconfigured' } })
    expect(fetchImpl).not.toHaveBeenCalled()
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
