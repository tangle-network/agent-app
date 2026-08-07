// @vitest-environment jsdom
/**
 * Red→green guard for `chatToolCallPart` — the adapter that maps agent-app's
 * `ChatToolCallInfo` onto the canonical `@tangle-network/ui` `ToolPart` so tool
 * rows render through ui's `InlineToolItem` (one run-row grammar, zero drift).
 * The mapping decisions that must not drift:
 *
 *  - status: agent-app's `done`+`ok:false` outcome is an ERROR row, matching
 *    `ToolCallCard`'s own `failed` predicate and `isImportantTool`.
 *  - error text comes from the outcome envelope's `message`, with a fixed
 *    fallback so an error row never renders blank.
 *  - `sandbox_run_command` adapts to ui's canonical `bash` name so the row gets
 *    the command category (terminal icon); every other tool keeps its real name.
 */
import { describe, expect, it } from 'vitest'

import { chatToolCallPart, type ChatToolCallInfo } from './index'

function call(over: Partial<ChatToolCallInfo>): ChatToolCallInfo {
  return { id: 'tc-1', name: 'list_workflows', status: 'done', ...over }
}

describe('chatToolCallPart', () => {
  it('maps a settled ok call to a completed part carrying id, args and result', () => {
    const part = chatToolCallPart(
      call({ args: { scope: 'thread' }, result: { ok: true, result: { n: 1 } } }),
    )
    expect(part.type).toBe('tool')
    expect(part.id).toBe('tc-1')
    expect(part.tool).toBe('list_workflows')
    expect(part.state.status).toBe('completed')
    expect(part.state.input).toEqual({ scope: 'thread' })
    expect(part.state.output).toEqual({ ok: true, result: { n: 1 } })
    expect(part.state.error).toBeUndefined()
  })

  it('maps a running call to the running row status', () => {
    expect(chatToolCallPart(call({ status: 'running' })).state.status).toBe('running')
  })

  it('maps status error to an error part with the outcome message', () => {
    const part = chatToolCallPart(
      call({ status: 'error', result: { ok: false, message: 'upstream 503' } }),
    )
    expect(part.state.status).toBe('error')
    expect(part.state.error).toBe('upstream 503')
  })

  it('maps a done call with an ok:false outcome to an error part (the failed predicate)', () => {
    const part = chatToolCallPart(
      call({ status: 'done', result: { ok: false, message: 'bad' } }),
    )
    expect(part.state.status).toBe('error')
    expect(part.state.error).toBe('bad')
  })

  it('falls back to a fixed error line when a failed call carries no message', () => {
    const part = chatToolCallPart(call({ status: 'error' }))
    expect(part.state.status).toBe('error')
    expect(part.state.error).toBe('Tool failed')
  })

  it('adapts sandbox_run_command to the canonical bash tool name (command category)', () => {
    const part = chatToolCallPart(
      call({ name: 'sandbox_run_command', args: { command: 'ls' } }),
    )
    expect(part.tool).toBe('bash')
  })
})
