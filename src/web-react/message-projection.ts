/**
 * One projection from a message's stored parts to what the transcript draws:
 * the ordered text and tool segments, the tool calls, and the reasoning. A
 * product's history loader and a split speaker row (`expandSpeakerRows`)
 * read the same parts the same way, so an agent's tool timeline renders
 * under that agent whether the row was written by one responder or several.
 * Pure: no React, no DOM.
 */
import type { ChatMessageSegment, ChatToolCallInfo } from './chat-message-types'

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

/** A stored `tool` part as the card the transcript draws. */
export function toolCallFromPart(part: unknown): ChatToolCallInfo | null {
  const p = record(part)
  if (!p || p.type !== 'tool' || typeof p.id !== 'string' || typeof p.tool !== 'string') return null
  const state = record(p.state) ?? {}
  const status = state.status
  return {
    id: typeof p.callID === 'string' ? p.callID : p.id,
    name: p.tool,
    status: status === 'completed' ? 'done' : status === 'error' || status === 'failed' ? 'error' : 'running',
    ...(record(state.input) ? { args: record(state.input)! } : {}),
    ...(state.output !== undefined ? { result: state.output } : {}),
  }
}

/** Every tool call on a message, in stored order. */
export function toolCallsFromParts(parts: ReadonlyArray<unknown> | null | undefined): ChatToolCallInfo[] {
  return (parts ?? []).map(toolCallFromPart).filter((call): call is ChatToolCallInfo => call !== null)
}

/** The ordered text, tool and notice runs of a message, as the transcript
 *  interleaves them. Adjacent text parts fold into one run; reasoning,
 *  speaker, mention and file parts are not segments (they have their own
 *  rows). Returns an empty list for a message with no tool or notice, so a
 *  caller can keep the plain body for the common case. */
export function segmentsFromParts(parts: ReadonlyArray<unknown> | null | undefined): ChatMessageSegment[] {
  const segments: ChatMessageSegment[] = []
  let interleaved = false
  for (const raw of parts ?? []) {
    const part = record(raw)
    if (!part) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      const last = segments[segments.length - 1]
      if (last && last.kind === 'text') segments[segments.length - 1] = { kind: 'text', content: last.content + part.text }
      else segments.push({ kind: 'text', content: part.text })
      continue
    }
    const call = toolCallFromPart(part)
    if (call) { segments.push({ kind: 'tool', call }); interleaved = true; continue }
    if (part.type === 'notice' && typeof part.text === 'string' && (part.noticeKind === 'error' || part.noticeKind === 'warning')) {
      segments.push({ kind: 'notice', tone: part.noticeKind, content: part.text })
      interleaved = true
    }
  }
  return interleaved ? segments : []
}
