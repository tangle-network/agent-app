import type { ChatMessageRow, ChatThreadRow } from '@tangle-network/agent-app/chat-store'
import type { ChatUiMessage, ChatToolCallInfo } from '@tangle-network/agent-app/web-react'

// JSON dates, not a competing storage schema. These are read-only projections
// of the public store types; identity and authorization stay in src/chat.ts.
type Json<T> = T extends Date ? string : T extends Array<infer U> ? Json<U>[]
  : T extends object ? { [K in keyof T]: Json<T[K]> } : T
export type Thread = Json<ChatThreadRow>
export type Message = Json<ChatMessageRow>
export interface Session { user: { id: string; name: string; email: string; image?: string | null } }
export const threadHref = (id: string) => `/?threadId=${encodeURIComponent(id)}`
export const historyHref = '/?view=history'

export async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message
    throw new Error(detail || `Request failed (${response.status})`)
  }
  return body as T
}
export const post = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

// The existing API supports offset/limit, not server-side search or sorting.
// Load its pages before filtering History so older matches are not hidden.
export async function listThreads(signal?: AbortSignal): Promise<Thread[]> {
  const items = new Map<string, Thread>()
  let offset = 0
  for (;;) {
    const page = await json<{ threads: Thread[]; total: number }>(
      `/api/threads?limit=200&offset=${offset}`, { signal },
    )
    for (const thread of page.threads) items.set(thread.id, thread)
    offset += page.threads.length
    if (offset >= page.total) return [...items.values()]
    if (!page.threads.length) throw new Error('Thread list changed while loading. Reload History.')
  }
}

export function toUiMessage(row: Message): ChatUiMessage {
  const parts = (row.parts ?? []) as Array<Record<string, unknown>>
  const toolCalls: ChatToolCallInfo[] = parts.filter((part) => part.type === 'tool').map((part, index) => {
    const state = part.state as { status?: string; input?: Record<string, unknown>; output?: unknown; error?: unknown } | undefined
    return {
      id: String(part.callID ?? part.id ?? `${row.id}:tool:${index}`),
      name: String(part.tool ?? 'tool'),
      status: state?.status === 'error' || state?.status === 'failed' ? 'error' : state?.status === 'completed' ? 'done' : 'running',
      args: state?.input,
      result: state?.status === 'completed' ? { ok: true, result: state.output }
        : state?.status === 'error' || state?.status === 'failed' ? { ok: false, message: state.error } : undefined,
    }
  })
  return {
    id: row.id, role: row.role === 'tool' ? 'assistant' : row.role,
    content: row.content, parts, toolCalls,
    reasoning: parts.filter((part) => part.type === 'reasoning').map((part) => String(part.text ?? '')).join(''),
    modelUsed: row.model ?? undefined,
    promptTokens: row.inputTokens ?? undefined, completionTokens: row.outputTokens ?? undefined,
  }
}
