import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChatComposer, ChatMessages, InteractionPlanCard, InteractionQuestionCard,
  chatTurnRequestInit, createInteractionAnswerSubmitter, persistedPartToInteraction,
  streamChatTurn, useChatInteractions,
  type ChatUiMessage, type ChatStreamCallbacks, type ComposerFilePart,
} from '@tangle-network/agent-app/web-react'
import { json, post, threadHref, toUiMessage, type Message, type Thread } from './api'
import { useInlineUploads } from './uploads'

export function Conversation({ initialThreadId, onThread, onChanged }: {
  initialThreadId: string | null
  onThread: (id: string) => void
  onChanged: () => Promise<void>
}) {
  const [threadId, setThreadId] = useState(initialThreadId)
  const [messages, setMessages] = useState<ChatUiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(Boolean(initialThreadId))
  const [error, setError] = useState<string | null>(null)
  const [needsReload, setNeedsReload] = useState(false)
  const locked = useRef(Boolean(initialThreadId))
  const lifetime = useRef<AbortController | null>(null)
  const snapshot = useRef(0)
  const productName = useRef(document.title)
  const asks = useChatInteractions({ mode: 'durable' })
  const uploads = useInlineUploads()
  const submitAnswer = useMemo(() => createInteractionAnswerSubmitter({
    url: '/api/chat/interactions', body: { threadId },
  }), [threadId])

  async function refresh(id: string, signal: AbortSignal) {
    const sequence = ++snapshot.current
    const data = await json<{ thread: Thread; messages: Message[] }>(
      `/api/threads/${encodeURIComponent(id)}/messages`, { signal },
    )
    if (signal.aborted || sequence !== snapshot.current) return
    const next = data.messages.map(toUiMessage)
    setMessages(next)
    asks.hydrate(next.flatMap((message) => (message.parts ?? []).flatMap((part) => {
      const interaction = persistedPartToInteraction(part)
      return interaction ? [interaction] : []
    })))
    document.title = `${data.thread.title || 'New thread'} · ${productName.current}`
  }

  const replay = (id: string, fromSeq: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    return fetch(`/api/chat/replay/${encodeURIComponent(id)}?fromSeq=${fromSeq}`, { credentials: 'same-origin', signal })
  }
  const interactionCallbacks: ChatStreamCallbacks = {
    onInteraction: asks.upsert,
    onInteractionCancel: asks.applyCancel,
    onErrorEvent: (message) => setError(message),
    onNotice: (notice) => setError(notice.text),
  }

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const { signal } = controller
    let poll: ReturnType<typeof setInterval> | undefined
    let refreshing = false
    async function open() {
      if (!initialThreadId) return
      try {
        await refresh(initialThreadId, signal)
        const { running } = await json<{ running: string[] }>(
          `/api/chat/running?threadId=${encodeURIComponent(initialThreadId)}`, { signal },
        )
        if (running.length) {
          setBusy(true)
          // Replay is an event view, not a second transcript. On reload, keep
          // refreshing the durable rows instead of appending replay deltas to
          // a partly persisted assistant message (which would duplicate it).
          poll = setInterval(() => {
            if (refreshing) return
            refreshing = true
            void refresh(initialThreadId, signal).catch((cause) => {
              if (!signal.aborted) setError(String(cause))
            }).finally(() => { refreshing = false })
          }, 1000)
          await Promise.all(running.map((id) => streamChatTurn({
            start: () => replay(id, 0, signal),
            resume: (turn, from) => replay(turn, from, signal),
            callbacks: interactionCallbacks,
          })))
          clearInterval(poll)
          await refresh(initialThreadId, signal)
        }
      } catch (cause) {
        if (!signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); setNeedsReload(true) }
      } finally {
        clearInterval(poll)
        if (!signal.aborted) { locked.current = false; setBusy(false); setOpening(false) }
      }
    }
    void open()
    return () => { clearInterval(poll); controller.abort() }
    // Native links remount the document; this boot runs once for its URL.
  }, [])

  async function send(content: string, parts: ComposerFilePart[]) {
    if (locked.current || needsReload) return { ok: false as const, error: 'Reload the thread before sending again.' }
    if (uploads.files.some((file) => file.status !== 'ready')) {
      return { ok: false as const, error: 'Finish, retry, or remove the uploads before sending.' }
    }
    const signal = lifetime.current!.signal
    locked.current = true; setBusy(true); setError(null)
    const before = messages
    let accepted = false
    let id = threadId
    let requestStarted = false
    let responseReceived = false
    try {
      if (!id) {
        const { thread } = await json<{ thread: Thread }>('/api/threads', { ...post({ firstMessage: content || 'New thread' }), signal })
        id = thread.id
        setThreadId(id); onThread(id)
        history.replaceState(null, '', threadHref(id))
      }
      const liveId = crypto.randomUUID()
      let live: ChatUiMessage = { id: liveId, role: 'assistant', content: '', toolCalls: [] }
      const user: ChatUiMessage = { id: crypto.randomUUID(), role: 'user', content, parts: parts.map((part) => ({ ...part })) }
      const paint = () => { if (!signal.aborted) setMessages([...before, user, { ...live }]) }
      paint()
      await streamChatTurn({
        start: async () => {
          requestStarted = true
          const response = await fetch('/api/chat', {
            ...chatTurnRequestInit({ threadId: id!, content, parts }), credentials: 'same-origin', signal,
          })
          responseReceived = true
          accepted = response.ok
          if (accepted) uploads.clear()
          return response
        },
        resume: (turn, from) => replay(turn, from, signal),
        onResetForResume: () => { live = { id: liveId, role: 'assistant', content: '', toolCalls: [] }; paint() },
        callbacks: {
          ...interactionCallbacks,
          onText: (text) => { live.content += text; paint() },
          onReasoning: (text) => { live.reasoning = (live.reasoning ?? '') + text; paint() },
          onToolCall: (call) => {
            live.toolCalls = [...(live.toolCalls ?? []), { id: call.toolCallId ?? crypto.randomUUID(), name: call.toolName, status: 'running', args: call.args }]
            paint()
          },
          onToolResult: (result) => {
            live.toolCalls = live.toolCalls?.map((call) => call.id === result.toolCallId
              ? { ...call, status: result.outcome.ok ? 'done' : 'error', result: result.outcome } : call)
            paint()
          },
          onUsage: (usage) => { live.promptTokens = usage.promptTokens; live.completionTokens = usage.completionTokens; paint() },
        },
      })
      await refresh(id, signal)
      await onChanged()
      return { ok: true as const }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!signal.aborted) {
        setError(message)
        if (accepted || (requestStarted && !responseReceived)) {
          // An accepted/ambiguous POST must never be retried automatically.
          // The Worker may still be running; reload discovers its replay id.
          setNeedsReload(true)
          setError(`${message}. Reload this thread to check the saved result before sending again.`)
        }
        if (!accepted) setMessages(before)
      }
      // Only a known refusal restores the draft. Ambiguous admission keeps
      // it visible in ChatComposer, but the reload gate prevents a duplicate.
      return accepted ? { ok: true as const } : { ok: false as const, error: message }
    } finally {
      if (!signal.aborted) { locked.current = false; setBusy(false); setOpening(false) }
    }
  }

  const empty = !threadId && messages.length === 0
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!empty && <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4" aria-label="Conversation">
        <div className="mx-auto w-full max-w-[820px]">
          <>{opening && <p role="status" className="text-sm text-muted-foreground">Loading conversation…</p>}</>
          <ChatMessages messages={messages} loading={busy && asks.pending.length === 0} error={error} renderExtras={(message) => {
            const names = (message.parts ?? []).filter((part) => part.type === 'file' || part.type === 'image')
              .map((part) => String(part.filename ?? part.name ?? 'Attachment'))
            return names.length ? <p className="mt-2 text-xs text-muted-foreground">Attachments: {names.join(', ')}</p> : null
          }} onRetry={() => location.reload()} chrome="quiet" renderEmpty={() => busy || opening ? null : <p className="text-muted-foreground">Send a message to continue this thread.</p>} />
          {asks.interactions.map((interaction) => interaction.kind === 'plan'
            ? <InteractionPlanCard key={interaction.id} interaction={interaction} canWrite={!needsReload} submitAnswer={submitAnswer} onResolved={asks.markResolved} />
            : <InteractionQuestionCard key={interaction.id} interaction={interaction} canWrite={!needsReload} submitAnswer={submitAnswer} onResolved={asks.markResolved} />)}
        </div>
      </div>}
      <div className={empty ? 'flex flex-1 flex-col items-center justify-center px-5' : 'shrink-0 px-4 pb-4'}>
        <div className="mx-auto w-full max-w-[820px]">
          {empty && <h1 className="mb-7 text-center text-3xl font-medium tracking-tight">What can we work on?</h1>}
          {empty && error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
          <ChatComposer value={draft} onValueChange={setDraft} onSendParts={send}
            placeholder="Message the agent…" sendLabel="Send" sendVariant="icon" autoFocus={empty}
            disabled={busy || opening || needsReload} canSubmitAttachmentsOnly accept="*/*"
            pendingFiles={uploads.files} onAttach={uploads.add} onRemoveFile={uploads.remove} onRetryFile={uploads.retry}
            onRejectFiles={(rejections) => setError(rejections.map((item) => item.reason).join('; '))} />
          {empty && <p className="mt-4 text-center text-sm text-muted-foreground">Your conversations are saved in History.</p>}
        </div>
      </div>
    </div>
  )
}
