import { describe, it, expect } from 'vitest'
import { createAgentRuntime } from './agent'
import type { AppToolHandlers, AppToolProducedEvent } from '../tools/types'

// Build an OpenAI-compat SSE Response from scripted chunks.
function sseResponse(chunks: object[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n`))
      controller.enqueue(enc.encode('data: [DONE]\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

// A fetch that returns each scripted turn in sequence.
function scriptedFetch(turns: object[][]): typeof fetch {
  let i = 0
  return (async () => sseResponse(turns[i++] ?? [])) as unknown as typeof fetch
}

function recordingHandlers() {
  const calls: { tool: string; args: unknown }[] = []
  const handlers: AppToolHandlers = {
    async submitProposal(args) {
      calls.push({ tool: 'submit_proposal', args })
      return { proposalId: 'p-1', deduped: false }
    },
    async scheduleFollowup(args) {
      calls.push({ tool: 'schedule_followup', args })
      return { id: 'd-1', dueDate: args.dueDate, deduped: false }
    },
    async renderUi(args) {
      calls.push({ tool: 'render_ui', args })
      return { path: 'ui/x.json', content: '{}' }
    },
    async addCitation(args) {
      calls.push({ tool: 'add_citation', args })
      return { citationId: 'c-1', path: args.path }
    },
  }
  return { handlers, calls }
}

const taxonomy = { proposalTypes: ['propose_swap'], regulatedTypes: ['propose_swap'] }
const ctx = { userId: 'u1', workspaceId: 'w1', threadId: 't1' }

describe('createAgentRuntime', () => {
  it('advertises tools, fires the handler on a tool_call, folds the result, returns final text', async () => {
    const { handlers, calls } = recordingHandlers()
    const produced: AppToolProducedEvent[] = []

    const fetchImpl = scriptedFetch([
      // Turn 1: model emits a submit_proposal tool_call (args fragmented like real OpenAI).
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'submit_proposal' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"type":"propose_swap",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"title":"Swap A→B"}' } }] } }] },
      ],
      // Turn 2: after the tool result is folded back, model answers.
      [{ choices: [{ delta: { content: 'Queued the swap for approval.' } }] }],
    ])

    const runtime = createAgentRuntime({
      model: { baseUrl: 'https://router.test/v1', apiKey: 'k', model: 'test-model', fetchImpl },
      taxonomy,
      handlers,
      systemPrompt: 'You are a test agent.',
    })

    const result = await runtime.run('Swap my policy.', { ctx, onProduced: (e) => produced.push(e) })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ tool: 'submit_proposal', args: { type: 'propose_swap', title: 'Swap A→B', description: null } })
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0]!.outcome).toEqual({
      ok: true,
      result: { proposalId: 'p-1', deduped: false, regulated: true, status: 'queued_for_approval' },
    })
    expect(result.finalText).toBe('Queued the swap for approval.')
    expect(result.turns).toBe(2)
    expect(produced).toEqual([{ type: 'proposal_created', proposalId: 'p-1', title: 'Swap A→B', status: 'pending' }])
  })

  it('rejects a proposal type outside the taxonomy without calling the handler', async () => {
    const { handlers, calls } = recordingHandlers()
    const fetchImpl = scriptedFetch([
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c', function: { name: 'submit_proposal', arguments: '{"type":"not_a_type","title":"X"}' } },
                ],
              },
            },
          ],
        },
      ],
      [{ choices: [{ delta: { content: 'ok' } }] }],
    ])
    const runtime = createAgentRuntime({
      model: { baseUrl: 'https://router.test/v1', apiKey: 'k', model: 'm', fetchImpl },
      taxonomy,
      handlers,
      systemPrompt: 's',
    })
    const result = await runtime.run('go', { ctx })
    expect(calls).toHaveLength(0)
    expect(result.toolResults[0]!.outcome).toMatchObject({ ok: false, code: 'invalid_type' })
  })

  it('routes a non-app tool to executeOtherTool', async () => {
    const { handlers } = recordingHandlers()
    const other: string[] = []
    const fetchImpl = scriptedFetch([
      [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'integration_invoke', arguments: '{"action":"crm.read"}' } }] } }] }],
      [{ choices: [{ delta: { content: 'fetched' } }] }],
    ])
    const runtime = createAgentRuntime({
      model: { baseUrl: 'https://router.test/v1', apiKey: 'k', model: 'm', fetchImpl },
      taxonomy,
      handlers,
      systemPrompt: 's',
      extraTools: [{ type: 'function', function: { name: 'integration_invoke', description: 'd', parameters: { type: 'object' } } }],
      isOtherExecutableTool: (n) => n === 'integration_invoke',
      executeOtherTool: async (call) => {
        other.push(call.toolName)
        return { ok: true, result: { rows: 0 } }
      },
    })
    const result = await runtime.run('read crm', { ctx })
    expect(other).toEqual(['integration_invoke'])
    expect(result.finalText).toBe('fetched')
  })

  it('throws if executeOtherTool is set without isOtherExecutableTool', () => {
    const { handlers } = recordingHandlers()
    expect(() =>
      createAgentRuntime({
        model: { baseUrl: 'b', apiKey: 'k', model: 'm' },
        taxonomy,
        handlers,
        systemPrompt: 's',
        executeOtherTool: async () => ({ ok: true, result: {} }),
      }),
    ).toThrow(/isOtherExecutableTool/)
  })

  it('streams raw events and tool results in order', async () => {
    const { handlers } = recordingHandlers()
    const fetchImpl = scriptedFetch([
      [
        { choices: [{ delta: { content: 'Working… ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'add_citation', arguments: '{"path":"a.md","quote":"q"}' } }] } }] },
      ],
      [{ choices: [{ delta: { content: 'done' } }] }],
    ])
    const runtime = createAgentRuntime({
      model: { baseUrl: 'b', apiKey: 'k', model: 'm', fetchImpl },
      taxonomy,
      handlers,
      systemPrompt: 's',
    })
    const kinds: string[] = []
    for await (const y of runtime.stream('go', { ctx })) kinds.push(y.kind)
    // event(text) + event(tool_call) for turn 1, tool_result, then event(text) for turn 2.
    expect(kinds).toContain('tool_result')
    expect(kinds.filter((k) => k === 'event').length).toBeGreaterThanOrEqual(2)
  })
})
