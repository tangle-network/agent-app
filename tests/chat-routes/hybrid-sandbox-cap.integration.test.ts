/** A `sandbox_run` stopped at its cap gives the Router model what the box produced, not nothing.
 * Production turn gtm-agent:3a233fe1f5a9e9c050d78e52b261b0b6:0 (2026-11-22): the second `sandbox_run` printed fourteen
 * providers' rates in its tool output, hit its 240 s cap, and the model received only "did not return an answer within
 * 240 s": 0 characters of that output. Real HTTP Router -> hybrid producer -> engine tool loop -> sandbox_run -> the
 * product's computer step (`computer.run`, as GTM's), fed box events shaped as that run streamed them.
 * `failed`: the run fails before its cap (gtm-agent thread 40d4131a, 2026-11-22: two `sandbox_failed` runs had fetched
 * and extracted pricing pages, and the model, given only "That answer stopped before it finished", said none were read). */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { createHybridTurnProducer } from '../../src/chat-routes/hybrid-producer'
import { createComputerOutput } from '../../src/sandbox/computer-output'
import { SandboxRunError } from '../../src/sandbox/sandbox-run-error'

const ANSWER = 'The box priced Northflank and Koyeb before its cap; the rest is not confirmed.'
const FAILED = 'That answer stopped before it finished. Please send your question again.'
const text = (id: string, delta: string) => ({ type: 'message.part.updated', data: { delta, part: { type: 'text', id } } })
const bash = (id: string, command: string, output: string) => ({ type: 'message.part.updated',
  data: { part: { type: 'tool', id, tool: 'bash', state: { status: 'completed', input: { command, timeout: 120000 }, output } } } })

it.each(['produced', 'bounded', 'nothing', 'failed'] as const)('a capped or failed sandbox_run returns the box output to the model: %s', async mode => {
  const toolMessages: string[] = []
  let calls = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> }
      toolMessages.push(...payload.messages.filter(message => message.role === 'tool').map(message => String(message.content)))
      const delta = ++calls === 1
        ? { tool_calls: [{ index: 0, id: 'box-call', function: { name: 'sandbox_run', arguments: JSON.stringify({ task: 'Extract each provider\'s rates from /tmp/pricing.' }) } }] }
        : { content: ANSWER }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const recorded: SandboxRunError[] = []
  let sentTask = ''
  try {
    const producer = createHybridTurnProducer({
      apiKey: 'test-key', model: 'test-model', systemPrompt: 'Answer the member.',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, userMessage: 'Price every provider.',
      box: {
        acquire: async () => ({ id: 'test-box' }) as unknown as SandboxInstance,
        timeoutMs: 1_000,
        onFailure: error => { recorded.push(error) },
        computer: {
          session: { id: 'box-session' }, parentExecutionId: 'cap-turn', runWitnessesDispatch: true,
          run: async (_box, task, step) => {
            sentTask = task
            const output = createComputerOutput({ isPromptEcho: value => value === task.trim() })
            step.produced?.(output.read)
            step.onDispatch()
            const events = mode === 'nothing' ? [] : [
              text('echo', task),
              text('narration', 'Extracting the saved pages '), text('narration', 'in four batches.'),
              bash('rates-1', 'python3 /tmp/opencode/rates.py northflank civo', '== northflank ==\n$0.01667/ vCPU / hour\n$0.00833/ GB / hour'),
              ...(mode === 'bounded' ? Array.from({ length: 30 }, (_, index) => bash(`filler-${index}`, `python3 rates.py batch-${index}`, `batch-${index} `.repeat(400))) : []),
              bash('rates-9', 'python3 /tmp/opencode/rates.py koyeb', '== koyeb ==\nRTX-4000-SFF-ADA $ 0.50 /hr vCPU 6 RAM 44GB'),
            ]
            for (const event of events) output.observe(event)
            if (mode === 'failed') throw new SandboxRunError('sandbox_failed', FAILED)
            // The box keeps working until the call's cap stops it, as the production run did.
            return new Promise<string>((_, reject) => step.signal.addEventListener('abort',
              () => reject(new SandboxRunError('sandbox_failed', 'The computer step was stopped.')), { once: true }))
          },
        },
      },
    })
    const notices: Array<{ code?: unknown }> = []
    for await (const event of producer.stream) if ((event as { type?: string }).type === 'notice') notices.push(event as { code?: unknown })

    expect(calls).toBe(2)
    expect(producer.finalText()).toBe(ANSWER)
    expect(toolMessages).toHaveLength(1)
    const result = toolMessages[0]!
    if (mode === 'failed') {
      // The failure keeps its own code and cause; the model also reads what the box produced before it.
      expect(notices.map(notice => notice.code)).toContain('sandbox_failed')
      expect(recorded.map(error => [error.code, error.message])).toEqual([['sandbox_failed', FAILED]])
      expect(result.startsWith(`Error (sandbox_failed): ${FAILED} What it had produced by then, which may be incomplete:\n`)).toBe(true)
      expect(result).toContain('== northflank ==\n$0.01667/ vCPU / hour')
      expect(result).toContain('== koyeb ==\nRTX-4000-SFF-ADA $ 0.50 /hr')
      return
    }
    // The call stays unconfirmed: the warning notice and the recorded failure are unchanged.
    expect(notices.map(notice => notice.code)).toContain('sandbox_unconfirmed')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.code).toBe('sandbox_unconfirmed')
    expect(recorded[0]!.message).not.toContain('northflank')
    if (mode === 'nothing') {
      expect(result).toBe('Error (sandbox_unconfirmed): The computer step did not return an answer within 1 s. Its completion could not be confirmed.')
      return
    }
    const header = 'Error (sandbox_unconfirmed): The computer step stopped at its 1 s cap before it finished. Its completion could not be confirmed. What it had produced by then, which may be incomplete:\n'
    expect(result.startsWith(header)).toBe(true)
    // The box's latest work reaches the model; the bound keeps it inside the engine's 12,000-character view.
    expect(result).toContain('[bash completed] {"command":"python3 /tmp/opencode/rates.py koyeb","timeout":120000}\n== koyeb ==\nRTX-4000-SFF-ADA $ 0.50 /hr')
    expect(result.length).toBeLessThanOrEqual(header.length + 8_001)
    if (mode === 'produced') {
      expect(result).toContain('Extracting the saved pages in four batches.')
      expect(result).toContain('== northflank ==\n$0.01667/ vCPU / hour')
      expect(result).not.toContain(sentTask.slice(0, 60))
    } else {
      expect(result).toContain('batch-29')
      expect(result).not.toContain('northflank')
      expect(result.slice(header.length).startsWith('…')).toBe(true)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}, 20_000)
