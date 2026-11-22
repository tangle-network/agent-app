/**
 * `createComputerOutput`: what a box run has produced so far, as text the Router model can read. It folds the run's
 * raw prompt events: the box agent's text and each tool call with its input and output, in the order they started.
 *
 * A `sandbox_run` that stops at its cap returns this to the model instead of nothing (`createSandboxRunTool`). On
 * 2026-11-22 a GTM research turn's second `sandbox_run` printed fourteen providers' rates in its tool output, hit its
 * 240 s cap, and the model received 0 characters of it.
 *
 * agent-app's shell path (`createComputerStep` with `shell`) folds its own stream. A product's own prompt path (`run`)
 * creates one, passes it each raw event it consumes, and hands `read` to the step's `produced`.
 */
import { textPartId } from './prompt-result'

const TEXT_LIMIT = 2_000
const TOOL_INPUT_LIMIT = 300
const TOOL_OUTPUT_LIMIT = 1_500

export interface ComputerOutput {
  /** Fold one raw prompt event; anything but a `message.part.updated` text or tool part is ignored. */
  observe(event: unknown): void
  /** The output so far, oldest first; empty before the run produced anything. */
  read(): string
}

type Entry = { kind: 'text'; text: string } | { kind: 'tool'; part: Record<string, unknown> }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function show(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  try { return JSON.stringify(value) } catch { return String(value) }
}

const head = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text

function toolText(part: Record<string, unknown>): string {
  const state = record(part.state) ?? {}
  const status = typeof state.status === 'string' ? state.status : 'running'
  const result = head(show(status === 'error' ? state.error : state.output), TOOL_OUTPUT_LIMIT)
  return `[${show(part.tool) || 'tool'} ${status}] ${head(show(state.input), TOOL_INPUT_LIMIT)}${result ? `\n${result}` : ''}`
}

/** @param options.isPromptEcho drops a text part that replays the task the box was sent. */
export function createComputerOutput(options: { isPromptEcho?(text: string): boolean } = {}): ComputerOutput {
  const entries = new Map<string, Entry>()
  let anonymous = 0
  return {
    observe(raw) {
      const event = record(raw)
      if (event?.type !== 'message.part.updated') return
      const data = record(event.data)
      const part = record(data?.part)
      if (!part) return
      const delta = typeof data?.delta === 'string' ? data.delta : undefined
      if (part.type === 'text') {
        const key = `text:${textPartId(part, delta === undefined ? `text-${anonymous++}` : 'delta')}`
        const previous = entries.get(key)
        const text = delta === undefined ? show(part.text) : `${previous?.kind === 'text' ? previous.text : ''}${delta}`
        entries.set(key, { kind: 'text', text })
      } else if (part.type === 'tool') {
        const id = show(part.id) || show(part.callID) || `tool-${anonymous++}`
        entries.set(`tool:${id}`, { kind: 'tool', part })
      }
    },
    read() {
      return [...entries.values()].map(entry => {
        if (entry.kind === 'tool') return toolText(entry.part)
        const text = entry.text.trim()
        if (!text || options.isPromptEcho?.(text)) return ''
        return text.length > TEXT_LIMIT ? `…${text.slice(-TEXT_LIMIT)}` : text
      }).filter(Boolean).join('\n\n')
    },
  }
}
