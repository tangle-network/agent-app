/**
 * Assistant-story fixtures: a fully-stubbed `AssistantClient` (no network — the
 * panel's hooks fetch models/threads on mount, and the dock's real
 * `useAssistantChat` streams through it), a controlled `AssistantChat` handle
 * for the panel stories (the same fake the panel's own tests build), and the
 * transcript/proposal data those stories render.
 *
 * The shared `src/stories/fixtures/` chat fixtures model web-react's
 * `ChatUiMessage`; the assistant transcript consumes the FLAT wire
 * `ChatMessage[]` shape (user/assistant/tool/status rows the reducer emits), so
 * this area keeps its own fixtures rather than bending the shared ones.
 */

import {
  type AssistantClient,
  type AssistantModels,
  type AssistantThreadSummary,
} from '../../assistant'
import { type AssistantState, initialAssistantState } from '../../assistant/reducer'
import type {
  AssistantStreamEvent,
  ChatMessage,
  PendingProposal,
  UsageInfo,
} from '../../assistant/types'
import type { AssistantChat } from '../../assistant/useAssistantChat'
import { useCallback, useRef, useState } from 'react'
import type { ComposerFile } from '../../web-react'

const STORY_USER_ID = 'u-story'

// ── Models + threads (the client's read surface) ─────────────────────────────

/** A catalog realistic enough to exercise the picker's provider grouping,
 *  price, and context-window rows. */
const storyModels: AssistantModels = {
  default: 'anthropic/claude-sonnet-4-6',
  models: [
    {
      slug: 'anthropic/claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      promptUsdPerMillion: 3,
      contextTokens: 400_000,
    },
    {
      slug: 'anthropic/claude-opus-4-6',
      label: 'Claude Opus 4.6',
      promptUsdPerMillion: 15,
      contextTokens: 400_000,
    },
    {
      slug: 'openai/gpt-5.4',
      label: 'GPT-5.4',
      promptUsdPerMillion: 2.5,
      contextTokens: 272_000,
    },
    {
      slug: 'google/gemini-3-pro',
      label: 'Gemini 3 Pro',
      promptUsdPerMillion: 1.25,
      contextTokens: 1_000_000,
    },
  ],
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** Past conversations for the history view, newest activity first. */
export const threadSummaries: AssistantThreadSummary[] = [
  {
    id: 't-poster',
    title: 'Render the launch poster and queue it for review',
    createdAt: isoHoursAgo(30),
    updatedAt: isoHoursAgo(2),
  },
  {
    id: 't-budget',
    title: 'What did my workflows cost this week?',
    createdAt: isoHoursAgo(50),
    updatedAt: isoHoursAgo(26),
  },
  {
    id: 't-key',
    title: 'Create an API key for the CI runner',
    createdAt: isoHoursAgo(80),
    updatedAt: isoHoursAgo(76),
  },
  {
    id: 't-untitled',
    title: null,
    createdAt: isoHoursAgo(120),
    updatedAt: isoHoursAgo(119),
  },
]

// ── Transcript data (the flat wire ChatMessage shape) ────────────────────────

/** A settled two-turn conversation: tool chips with args + outcomes, a status
 *  line, and enough prose to judge bubble spacing. */
export const populatedMessages: ChatMessage[] = [
  { id: 'u1', role: 'user', text: 'What did my workflows cost this week?' },
  {
    id: 'a1',
    role: 'assistant',
    text: 'Let me pull your usage for the past 7 days.',
  },
  {
    id: 'tool-usage',
    role: 'tool',
    text: '',
    tool: {
      name: 'get_usage',
      status: 'ok',
      args: { range: '7d' },
      outcome: {
        ok: true,
        result: {
          promptTokens: 412_300,
          completionTokens: 58_900,
          costUsd: 1.83,
          runs: 12,
        },
      },
    },
  },
  {
    id: 'a2',
    role: 'assistant',
    text: [
      'This week your workflows spent $1.83 across 12 runs — 412k prompt and 59k completion tokens.',
      '',
      'The render workflow dominates: the reasoning passes before each export cost more than the exports themselves.',
    ].join('\n'),
  },
  { id: 'u2', role: 'user', text: 'Which single workflow ran the most?' },
  {
    id: 'a3',
    role: 'assistant',
    text: '"Launch-poster render" — 7 of the 12 runs, about $1.07 of the total. Everything else ran once or twice.',
  },
]

/** A settled confirmed action: the proposal flow ended in the quiet status
 *  line ("Created workflow …") rather than an assistant-labeled turn. */
export const confirmedMessages: ChatMessage[] = [
  { id: 'cu1', role: 'user', text: 'Create the Monday poster workflow.' },
  {
    id: 'ca1',
    role: 'assistant',
    text: 'Here’s the draft — confirm it above and I’ll create it.',
  },
  { id: 'cs1', role: 'status', text: 'Created workflow "launch-poster-monday".' },
]

/** A turn mid-stream: preamble text, a running tool chip, and an open (still
 *  empty) bubble the deltas are accumulating into. */
export const streamingMessages: ChatMessage[] = [
  { id: 'u1', role: 'user', text: 'Draft a workflow that posts the poster every Monday.' },
  {
    id: 'a1',
    role: 'assistant',
    text: 'I’ll check which integrations this needs first.',
  },
  {
    id: 'tool-check',
    role: 'tool',
    text: '',
    tool: { name: 'list_integrations', status: 'running' },
  },
  { id: 'a-stream', role: 'assistant', text: '' },
]

export const streamingReasoning =
  'The user wants a scheduled post. A cron trigger plus the Slack send step covers it — checking the workspace connections before proposing anything mutating.'

/** The turn-level metrics a settled turn leaves behind. */
export const settledUsage: UsageInfo = {
  costUsd: 0.0174,
  balanceUsd: 12.38,
  promptTokens: 4_120,
  completionTokens: 386,
  durationMs: 3_400,
  replayed: false,
}

// ── Proposals ────────────────────────────────────────────────────────────────

export const workflowYaml = `name: launch-poster-monday
trigger:
  type: schedule
  cron: "0 9 * * MON"
steps:
  - id: render
    uses: canvas/export
    with:
      page: page-1
      format: png
      dpi: 144
  - id: post
    uses: slack/send-message
    with:
      channel: "#launch"
      text: "This week's poster: {{ steps.render.outputs.url }}"
`

/** A workflow-authoring proposal awaiting confirmation, with one unconnected
 *  requirement (the connect affordance renders) and one satisfied. */
export const workflowProposal: PendingProposal = {
  proposalId: 'prop-1',
  callId: 'call-1',
  name: 'create_workflow',
  args: { yaml: workflowYaml },
  requirements: [
    {
      provider: 'slack',
      kind: 'integration',
      connected: false,
      connectUrl: '/app/integrations/slack',
    },
    { provider: 'github', kind: 'integration', connected: true },
  ],
}

/** A create-key proposal — the scalar-fields card (no body preview). */
export const apiKeyProposal: PendingProposal = {
  proposalId: 'prop-2',
  callId: 'call-2',
  name: 'create_api_key',
  args: { name: 'ci-runner', product: 'sandbox', budgetUsd: 25 },
}

// ── Long history (scroll rhythm) ─────────────────────────────────────────────

const LONG_THREAD_TURNS: ReadonlyArray<readonly [string, string]> = [
  [
    'List my active workflows.',
    'You have 4 active workflows: launch-poster render, weekly metrics digest, churn-risk sweep, and the docs link checker.',
  ],
  [
    'Disable the docs link checker.',
    'Done — the docs link checker is disabled. Its schedule is cleared; run history is kept.',
  ],
  [
    'What did the metrics digest produce last week?',
    'Five chart renders and one summary post to #metrics. The slowest step was the warehouse query at 41s.',
  ],
  [
    'Move it to Sundays at 18:00.',
    'Rescheduled — the digest now runs Sundays at 18:00 UTC. Next run is in 3 days.',
  ],
  [
    'Add a step that posts failures to #alerts.',
    'I can add a notify step on failure. It needs the Slack connection, which is already active — want me to propose the update?',
  ],
  [
    'Yes, go ahead.',
    'The update is drafted and waiting on your confirmation above.',
  ],
  [
    'How much would ten extra runs a month cost?',
    'At the digest’s average of $0.14 per run, ten extra runs add about $1.40 a month.',
  ],
  [
    'And if I switch it to the cheaper model?',
    'On the budget model the same run averages $0.03 — ten extra runs would be roughly $0.30.',
  ],
  [
    'Switch it, then.',
    'Switched — the digest now runs on the budget model. I left the render workflow on the default.',
  ],
  [
    'Summarize where things stand.',
    'Digest: Sundays 18:00, budget model, failure alerts pending your confirmation. Poster render: unchanged. Link checker: disabled.',
  ],
]

/** Twenty messages of ordinary back-and-forth — long enough that the transcript
 *  scrolls, so spacing and typography evaluate under real rhythm. */
export const longHistoryMessages: ChatMessage[] = LONG_THREAD_TURNS.flatMap(
  ([question, answer], i) => [
    { id: `lu-${i}`, role: 'user' as const, text: question },
    { id: `la-${i}`, role: 'assistant' as const, text: answer },
  ],
)

// ── The stub transport ───────────────────────────────────────────────────────

const EVENT_GAP_MS = 140

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let turnSeq = 0

/**
 * One scripted turn, emitted by the stub `streamChat` in order: reasoning, a
 * preamble, a read-only tool call + result, the answer, a workflow proposal
 * (so the confirm card appears live), usage, and a `done` that leaves the
 * conversation in `awaiting_confirm`. Covers every transcript feature in a
 * single send — reasoning box, tool chip, proposal card, and the cost line.
 */
function scriptedTurnEvents(): AssistantStreamEvent[] {
  turnSeq += 1
  const turnId = `turn-${turnSeq}`
  return [
    {
      type: 'thread',
      data: {
        threadId: 't-story',
        turnId,
        model: 'anthropic/claude-sonnet-4-6',
      },
    },
    {
      type: 'reasoning',
      data: {
        text: 'A scheduled post needs a cron trigger plus the Slack step. Checking the workspace connections before proposing anything mutating. ',
      },
    },
    {
      type: 'reasoning',
      data: { text: 'Slack is not connected — the proposal must list it as a requirement.' },
    },
    {
      type: 'delta',
      data: { text: 'On it. First a quick check of your connected integrations.' },
    },
    {
      type: 'tool_call',
      data: { callId: 'call-check', name: 'list_integrations' },
    },
    {
      type: 'tool_result',
      data: {
        callId: 'call-check',
        name: 'list_integrations',
        ok: true,
        output: { connected: ['github'], missing: ['slack'] },
      },
    },
    {
      type: 'delta',
      data: {
        text: 'GitHub is connected; Slack is not. I’ve drafted the workflow anyway — connect Slack from the card below, then confirm.',
      },
    },
    {
      type: 'tool_proposal',
      data: {
        proposalId: 'prop-live',
        callId: 'call-live',
        name: 'create_workflow',
        args: { yaml: workflowYaml },
        requirements: workflowProposal.requirements,
      },
    },
    {
      type: 'usage',
      data: {
        promptTokens: 4_120,
        completionTokens: 386,
        costUsd: 0.0174,
        balanceUsd: 12.36,
        replayed: false,
      },
    },
    {
      type: 'done',
      data: { turnId, status: 'done', proposed: true, capped: false },
    },
  ]
}

export interface StubClientOptions {
  /** Replace the scripted turn (e.g. an erroring stream). */
  streamEvents?: (req: { message: string }) => AssistantStreamEvent[]
}

/**
 * An `AssistantClient` with every method stubbed — the panel's background
 * fetches (models, threads, history) resolve from fixtures and the chat stream
 * replays a scripted turn with realistic pacing, so stories never touch the
 * network. Mirrors the fakes in `AssistantPanel.test.tsx`, but stubs ALL
 * methods (the tests let the real client's same-origin fetches fail harmlessly;
 * in a browser that would be console noise).
 */
function makeStubClient(options: StubClientOptions = {}): AssistantClient {
  return {
    async fetchModels() {
      return { ok: true, data: storyModels }
    },
    async fetchThreads() {
      console.log('[assistant stub] fetchThreads')
      return threadSummaries
    },
    async fetchThreadHistory(threadId) {
      // "gone" (not a transcript) so a thread id persisted by an earlier story
      // view never hydrates stale messages into a fresh mount.
      console.log('[assistant stub] fetchThreadHistory', threadId)
      return { status: 'gone' }
    },
    async streamChat(req, onEvent, signal) {
      console.log('[assistant stub] streamChat', req)
      const events = options.streamEvents
        ? options.streamEvents(req)
        : scriptedTurnEvents()
      for (const event of events) {
        if (signal.aborted) return
        await sleep(EVENT_GAP_MS)
        if (signal.aborted) return
        onEvent(event)
      }
    },
    async confirmProposal(proposalId) {
      console.log('[assistant stub] confirmProposal', proposalId)
      await sleep(700)
      return {
        ok: true,
        output: { workflow: { name: 'launch-poster-monday' } },
      }
    },
    async deleteThread(threadId) {
      console.log('[assistant stub] deleteThread', threadId)
      return { ok: true }
    },
  }
}

/** Shared instance for stories that don't customize the transport. The model
 *  catalog is cached per client (WeakMap in `useAssistantModels`), so sharing
 *  one avoids a refetch on every story mount. */
export const stubClient = makeStubClient()

// ── The controlled chat handle (panel stories) ───────────────────────────────

/**
 * A minimal `AssistantChat` over a controlled state slice — the same fake the
 * panel's tests build, with `console.log` callbacks instead of spies. The
 * panel reads `state` and binds the handlers; the transport is never involved.
 */
export function makeFakeChat(over: Partial<AssistantState> = {}): AssistantChat {
  return {
    state: { ...initialAssistantState(), ownerId: STORY_USER_ID, ...over },
    confirmingIds: new Set<string>(),
    selectedModel: null,
    setModel: (model) => console.log('[story] setModel', model),
    send: (message) => console.log('[story] send', message),
    stop: () => console.log('[story] stop'),
    confirm: async (proposal) => {
      console.log('[story] confirm', proposal.callId)
    },
    cancel: (proposal) => console.log('[story] cancel', proposal.callId),
    canConnectRequirement: true,
    connectRequirement: async (_proposal, requirement) => {
      console.log('[story] connectRequirement', requirement.provider)
    },
    reset: () => console.log('[story] reset'),
    switchThread: (threadId) => console.log('[story] switchThread', threadId),
    restoring: false,
  }
}

export { STORY_USER_ID }

// ── Composer attachments stub ────────────────────────────────────────────────

const STUB_UPLOAD_MS = 700

/**
 * A story-level stand-in for the host attachment pipeline (web-react's
 * `useComposerAttachments` + an upload route): each picked/dropped file stages
 * as an 'uploading' chip and flips to 'ready' after a beat, so stories exercise
 * the composer's chip lifecycle with no network. `onSend` clears the staged
 * set — wire it to the panel/dock `onComposerSend`.
 */
export function useStubAttachments(): {
  attachments: {
    onAttach: (files: FileList) => void
    pendingFiles: ComposerFile[]
    onRemoveFile: (id: string) => void
  }
  onSend: () => void
} {
  const [pendingFiles, setPendingFiles] = useState<ComposerFile[]>([])
  const seq = useRef(0)

  const onAttach = useCallback((files: FileList) => {
    for (const file of Array.from(files)) {
      const id = `att-${(seq.current += 1)}`
      setPendingFiles((prev) => [
        ...prev,
        { id, name: file.name, size: file.size, kind: 'file', status: 'uploading' },
      ])
      setTimeout(() => {
        setPendingFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, status: 'ready' } : f)),
        )
      }, STUB_UPLOAD_MS)
    }
  }, [])

  const onRemoveFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const onSend = useCallback(() => setPendingFiles([]), [])

  return { attachments: { onAttach, pendingFiles, onRemoveFile }, onSend }
}
