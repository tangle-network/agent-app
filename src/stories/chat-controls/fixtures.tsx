/**
 * Chat-controls story fixtures — area-local because the shared
 * `src/stories/fixtures/` barrel is absent from this checkout (the storybook
 * scaffolding was never committed; see the chat-controls handoff note). The
 * catalog list mirrors the documented shared `catalogModels` fixture
 * 1:1 so a later dedupe pass is a pure import swap.
 *
 * Everything here is typed against package source (`../../web-react` and the
 * leaf modules the components themselves import from), so a drift in any of
 * these shapes fails typecheck in this file.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import type { Decorator } from '@storybook/react'

import type {
  AgentActivityPage,
  AgentActivityRecord,
  CatalogModel,
  ChatAttachmentPart,
  ChatEmptyDoor,
  ChatInteraction,
  ComposerFile,
  SubmitInteractionAnswer,
  ToolRunRecord,
  WorkProductCardProps,
} from '../../web-react'
import type { StepAgentActivity } from '../../missions/agent-activity'
import type { FlowTrace } from '../../trace'
import type { ChatPlan } from '../../plans'
import type { WorkProductPersistedPart } from '../../work-product/types'
import type { ProductSeatOffer } from '../../platform/billing'

// ── model catalog ───────────────────────────────────────────────────────────

/** Current five-model catalogue used across the chat-control stories. */
export const catalogModels: CatalogModel[] = [
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    provider: 'anthropic',
    description: 'Most capable Anthropic model',
    contextLength: 1_000_000,
    pricing: { prompt: '0.00001', completion: '0.00005' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    description: 'Frontier Anthropic model',
    contextLength: 1_000_000,
    pricing: { prompt: '0.000005', completion: '0.000025' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT 5.6 Luna',
    provider: 'openai',
    description: 'Current efficient OpenAI model',
    contextLength: 400_000,
    pricing: { prompt: '0.0000002', completion: '0.0000012' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    provider: 'google',
    contextLength: 2_000_000,
    pricing: { prompt: '0.00000075', completion: '0.00000375' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'deepseek',
    contextLength: 128_000,
    pricing: { prompt: '0.00000027', completion: '0.0000011' },
    supportsTools: false,
    supportsReasoning: false,
    featured: false,
  },
]

export const DEFAULT_MODEL_ID = catalogModels[0]?.id ?? 'claude-fable-5-1'
/** A model with `supportsReasoning: false` — the effort picker hides for it. */
export const NON_REASONING_MODEL_ID = 'deepseek/deepseek-chat'

// ── composer ────────────────────────────────────────────────────────────────

/** The exact pending-file pair the playground's ComposerRoute ships. */
export const pendingComposerFiles: ComposerFile[] = [
  { id: 'f1', name: 'q3-metrics.csv', kind: 'file', status: 'ready' },
  { id: 'f2', name: 'design-assets', kind: 'folder', fileCount: 12, status: 'uploading' },
]

/** Adds an errored chip so the destructive tone and its reason are covered. */
export const pendingComposerFilesWithError: ComposerFile[] = [
  ...pendingComposerFiles,
  {
    id: 'f3',
    name: 'brand-guide.pdf',
    kind: 'file',
    status: 'error',
    errorMessage: 'Upload failed (413)',
  },
]

/** A staged image whose thumbnail identifies it — the shape a pasted
 *  screenshot arrives in, where the auto-generated name says nothing. A data
 *  URL keeps the story free of an object URL nobody would revoke. */
export const pendingComposerImageFiles: ComposerFile[] = [
  {
    id: 'i1',
    name: 'pasted-image-1.png',
    kind: 'file',
    status: 'ready',
    previewUrl:
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="%236366f1"/><circle cx="32" cy="26" r="12" fill="%23fbbf24"/></svg>',
  },
  { id: 'i2', name: 'pasted-image-2.png', kind: 'file', status: 'uploading' },
]

// ── message attachments ─────────────────────────────────────────────────────

export const fileAttachmentParts: ChatAttachmentPart[] = [
  { type: 'file', path: 'vault/q3-metrics.csv', name: 'q3-metrics.csv', size: 48_211, mediaType: 'text/csv' },
  { type: 'file', path: 'vault/brand-guide.pdf', name: 'brand-guide.pdf', size: 1_204_224, mediaType: 'application/pdf' },
  { type: 'file', path: 'vault/launch-notes.txt', name: 'launch-notes.txt', size: 3_106 },
]

export const imageAttachmentParts: ChatAttachmentPart[] = [
  { type: 'image', path: 'vault/poster-hero.png', name: 'poster-hero.png', size: 812_400, mediaType: 'image/png' },
  { type: 'image', path: 'vault/poster-alt.png', name: 'poster-alt.png', size: 790_112, mediaType: 'image/png' },
]

export const mixedAttachmentParts: ChatAttachmentPart[] = [
  ...imageAttachmentParts,
  fileAttachmentParts[0] ?? { type: 'file', path: 'vault/q3-metrics.csv', name: 'q3-metrics.csv' },
]

/** Two tiny inline SVGs stand in for uploaded images — distinct gradients so
 *  a row of thumbnails reads as real content in both themes. */
const THUMB_SVGS = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e293b"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="66" cy="30" r="16" fill="#f59e0b"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22c55e"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><rect x="18" y="52" width="60" height="10" rx="5" fill="#f8fafc"/></svg>',
]

function svgResponse(index: number): Response {
  const svg = THUMB_SVGS[index % THUMB_SVGS.length] ?? THUMB_SVGS[0] ?? ''
  return new Response(new Blob([svg], { type: 'image/svg+xml' }), { status: 200 })
}

/** Serves real bytes for every attachment URL — thumbnails render. */
export const fetchAttachmentOk = async (url: string): Promise<Response> =>
  svgResponse(url.includes('alt') ? 1 : 0)

/** 404s every URL — thumbnails flip to the error tile, chips error on click. */
export const fetchAttachmentMissing = async (): Promise<Response> =>
  new Response('not found', { status: 404 })

/** Never settles — thumbnails hold the loading skeleton. */
export const fetchAttachmentHangs = (): Promise<Response> => new Promise<Response>(() => {})

export const resolveAttachmentUrl = (part: ChatAttachmentPart): string => `/attachments/${part.path}`

// ── empty-state doors ───────────────────────────────────────────────────────

export const emptyStateDoors: ChatEmptyDoor[] = [
  {
    label: 'Start from the launch template',
    description: 'A pre-filled campaign workspace with the poster scene loaded.',
    onSelect: () => console.log('door: template'),
  },
  {
    label: 'Upload brand assets',
    description: 'Drop a logo pack or brand guide; the agent works from your files.',
    onSelect: () => console.log('door: upload'),
  },
  {
    label: 'Ask the agent directly',
    description: 'Describe the outcome in one message; skip the setup.',
    onSelect: () => console.log('door: ask'),
  },
]

// ── run drill-in ────────────────────────────────────────────────────────────

export const completedToolRun: ToolRunRecord = {
  toolCallId: 'tc-shell',
  toolName: 'sandbox_run_command',
  title: 'Render launch poster at print resolution',
  status: 'complete',
  steps: [
    {
      at: '2026-06-20T14:02:11Z',
      label: 'render --page page-1 --format png --dpi 300',
      detail: 'Rendered page-1 → out/poster-print.png (3600×3600, 8.2 MB)',
      status: 'ok',
    },
    {
      at: '2026-06-20T14:02:14Z',
      label: 'sha256sum out/poster-print.png',
      detail: '9f2c1ab4d6e84f0aa1b2c3d4e5f60718  out/poster-print.png',
      status: 'ok',
    },
    {
      at: '2026-06-20T14:02:19Z',
      label: 'store put out/poster-print.png vault/poster-print.png',
      detail: 'uploaded 8.2 MB · vault/poster-print.png',
      status: 'ok',
    },
  ],
}

export const erroredToolRun: ToolRunRecord = {
  toolCallId: 'tc-followup',
  toolName: 'schedule_followup',
  title: 'Schedule the Monday announcement post',
  status: 'error',
  steps: [
    {
      at: '2026-06-20T14:05:02Z',
      label: 'scheduler create --when 2026-06-22T09:00:00Z',
      detail: 'POST /scheduler/v1/followups → 503 Service Unavailable\nretry 1/3 in 2s…',
      status: 'ok',
    },
    {
      at: '2026-06-20T14:05:10Z',
      label: 'scheduler create --when 2026-06-22T09:00:00Z',
      detail: 'POST /scheduler/v1/followups → 503 Service Unavailable\nscheduler unavailable: upstream 503',
      status: 'error',
    },
  ],
}

export const runningToolRun: ToolRunRecord = {
  toolCallId: 'tc-export',
  toolName: 'canvas_export',
  title: 'Export print-resolution PNG',
  status: 'running',
  steps: [],
}

// ── work-product cards ──────────────────────────────────────────────────────

function workProductPart(status: WorkProductPersistedPart['status']): WorkProductPersistedPart {
  return {
    type: 'work_product',
    ref: { id: `wp-${status}`, version: status === 'superseded' ? 1 : 3 },
    kind: 'campaign.brief',
    title: 'Launch poster — campaign brief',
    status,
  }
}

/** One part per `WorkProductStatus` — every pill tone the card can render. */
export const workProductParts: WorkProductPersistedPart[] = [
  workProductPart('draft'),
  workProductPart('ready'),
  workProductPart('changes_requested'),
  workProductPart('approved'),
  workProductPart('blocked'),
  workProductPart('superseded'),
]

export const openWorkProduct: WorkProductCardProps['onOpen'] = (part) =>
  console.log('open work product', part.ref.id, `v${part.ref.version}`)

// ── interaction cards ───────────────────────────────────────────────────────

/** The plan-approval ask, waiting on the human. */
export const pendingPlanInteraction: ChatInteraction = {
  id: 'plan-1',
  kind: 'plan',
  title: 'Launch poster — implementation plan',
  body: [
    '## Steps',
    '1. Render the poster from the current scene at print resolution.',
    '2. Upload the PNG to the asset store as `vault/poster-print.png`.',
    '3. Submit the publish proposal so a human signs off.',
    '',
    'Nothing is published before your approval.',
  ].join('\n'),
  fields: [
    {
      type: 'text',
      name: 'feedback',
      label: 'Feedback for the agent',
      required: false,
      placeholder: 'Optional — what should change?',
    },
  ],
  status: 'pending',
}

/** Long enough (>320px) that the body collapses behind "Show full plan". */
export const longPlanInteraction: ChatInteraction = {
  ...pendingPlanInteraction,
  id: 'plan-long',
  title: 'Launch campaign — full rollout plan',
  body: [
    '## Phase 1 — assets',
    '1. Render the poster at print and social resolutions.',
    '2. Export the motion cut from the timeline track.',
    '3. Upload both to the asset store.',
    '',
    '## Phase 2 — copy',
    '1. Draft the announcement post (two paragraphs, measured tone).',
    '2. Draft the changelog entry.',
    '3. Route both past the style checklist.',
    '',
    '## Phase 3 — scheduling',
    '1. Queue the announcement for Monday 09:00.',
    '2. Queue the follow-up reminder for Wednesday.',
    '3. Submit the publish proposal for approval.',
    '',
    '## Rollback',
    'Every step is reversible except the publish itself; that one waits for a human.',
  ].join('\n'),
}

export const approvedPlanInteraction: ChatInteraction = { ...pendingPlanInteraction, id: 'plan-2', status: 'answered' }
export const declinedPlanInteraction: ChatInteraction = { ...pendingPlanInteraction, id: 'plan-3', status: 'declined' }
export const expiredPlanInteraction: ChatInteraction = { ...pendingPlanInteraction, id: 'plan-4', status: 'expired' }

/** Single-select ask with per-option descriptions. */
export const selectQuestionInteraction: ChatInteraction = {
  id: 'q-model',
  kind: 'question',
  title: 'Which model should draft the announcement post?',
  body: 'The draft is long-form copy, so the model choice changes both cost and tone.',
  fields: [
    {
      type: 'select',
      name: 'model',
      label: 'Draft model',
      required: true,
      options: [
        { value: 'anthropic/claude-opus-4', label: 'Claude Opus 4', description: 'Best tone match; about $0.04 per draft' },
        { value: 'openai/gpt-5', label: 'GPT-5', description: 'Close second; slightly cheaper' },
        { value: 'anthropic/claude-haiku-4', label: 'Claude Haiku 4', description: 'Fast and cheap; flatter tone' },
      ],
    },
  ],
  status: 'pending',
}

/** Multi-select with a granted write-in row (`allowCustom`). */
export const channelsQuestionInteraction: ChatInteraction = {
  id: 'q-channels',
  kind: 'question',
  title: 'Where should the launch announcement go?',
  fields: [
    {
      type: 'select',
      name: 'channels',
      label: 'Channels',
      required: true,
      multi: true,
      allowCustom: true,
      options: [
        { value: 'blog', label: 'Blog', description: 'Long-form post on the changelog' },
        { value: 'mastodon', label: 'Mastodon', description: 'Primary social channel' },
        { value: 'newsletter', label: 'Newsletter', description: 'Goes out Tuesdays' },
      ],
    },
  ],
  status: 'pending',
}

/** Free-text ask with a length cap. */
export const freeTextQuestionInteraction: ChatInteraction = {
  id: 'q-tagline',
  kind: 'question',
  title: 'What tagline should the poster carry?',
  body: 'One line. It sits under the headline at 36px, so shorter reads better.',
  fields: [
    {
      type: 'text',
      name: 'tagline',
      label: 'Tagline',
      required: true,
      placeholder: 'Ship the agent.',
      maxLength: 80,
    },
  ],
  status: 'pending',
}

/** One of each open input kind: boolean, number, secret. */
export const credentialsQuestionInteraction: ChatInteraction = {
  id: 'q-deploy',
  kind: 'question',
  title: 'Confirm the deployment target',
  fields: [
    { type: 'boolean', name: 'production', label: 'Deploy to production?', required: true },
    { type: 'number', name: 'replicas', label: 'Replica count', required: true, min: 1, max: 8 },
    { type: 'secret', name: 'deployKey', label: 'Deploy key', required: true, placeholder: 'paste the key' },
  ],
  status: 'pending',
}

export const answeredQuestionInteraction: ChatInteraction = {
  ...selectQuestionInteraction,
  id: 'q-answered',
  status: 'answered',
  answers: { model: ['anthropic/claude-opus-4'] },
}

export const expiredQuestionInteraction: ChatInteraction = {
  ...selectQuestionInteraction,
  id: 'q-expired',
  status: 'expired',
}

// ── interaction submit + late-answer fakes ──────────────────────────────────

export const okSubmitAnswer: SubmitInteractionAnswer = async (submission) => {
  console.log('submitAnswer', submission)
  return { ok: true }
}

const failingSubmitAnswer: SubmitInteractionAnswer = async (submission) => {
  console.log('submitAnswer (fails)', submission)
  return { ok: false, expired: false, message: 'Could not reach the agent. Try again.' }
}

export const logResolved = (id: string, status: string, answers?: unknown) =>
  console.log('interaction resolved', { id, status, answers })

export const okLateAnswer = (message: string) => {
  console.log('late answer sent as new message:', message)
  return true
}

export const okReRequest = (interaction: ChatInteraction) => {
  console.log('re-request submitted for', interaction.id)
  return true
}

// ── durable plan card ───────────────────────────────────────────────────────

export const pendingDurablePlan: ChatPlan = {
  planId: 'dplan-1',
  revision: 2,
  title: 'Launch poster — publish rollout',
  body: [
    '## Rollout',
    '1. Publish the poster asset Monday 09:00 with the announcement post.',
    '2. Hold the newsletter slot for Tuesday.',
    '3. Collect first-week metrics before the follow-up.',
    '',
    'Revision 2 folds in the feedback from the first review: the newsletter now trails the social post by a day.',
  ].join('\n'),
  submittedAt: '2026-06-20T13:58:00Z',
  status: 'pending',
}

export const approvedDurablePlan: ChatPlan = {
  ...pendingDurablePlan,
  status: 'approved',
  decidedAt: '2026-06-20T14:10:00Z',
  decidedBy: 'drew',
}

export const rejectedDurablePlan: ChatPlan = {
  ...pendingDurablePlan,
  status: 'rejected',
  decidedAt: '2026-06-20T14:06:00Z',
  feedback: 'Move the newsletter to Wednesday and re-submit.',
  decidedBy: 'drew',
}

export const withdrawnDurablePlan: ChatPlan = {
  ...pendingDurablePlan,
  status: 'withdrawn',
  withdrawnAt: '2026-06-20T14:12:00Z',
  withdrawnReason: 'Superseded by the revised campaign plan',
}

// ── seat paywall ────────────────────────────────────────────────────────────

/** Seat offer with a discounted first month — the `offer` prop's render path. */
export const seatOffer: ProductSeatOffer = {
  currency: 'usd',
  interval: 'month',
  recurring: { priceCents: 10_000, includedCreditsCents: 5_000 },
  introductory: { priceCents: 4_900, includedCreditsCents: 2_500 },
}

// ── mission activity ────────────────────────────────────────────────────────

export const activityLaneRuns: StepAgentActivity[] = [
  {
    taskId: 'task-render',
    tool: 'coder',
    status: 'completed',
    detail: 'Render the launch poster at print resolution',
    startedAt: '2026-06-20T14:02:00Z',
    costUsd: 0.0421,
    durationMs: 48_000,
    traceId: '9f2c1ab4d6e84f0aa1b2c3d4e5f60718',
    spanId: 'a1b2c3d4e5f60718',
  },
  {
    taskId: 'task-research',
    tool: 'researcher',
    status: 'running',
    detail: 'Pull competitor launch posts for tone reference',
    startedAt: '2026-06-20T14:03:10Z',
    iteration: 3,
    phase: 'drafting',
    traceId: '9f2c1ab4d6e84f0aa1b2c3d4e5f60718',
    spanId: 'b2c3d4e5f6071829',
  },
  {
    taskId: 'task-audit',
    tool: 'ui-auditor',
    status: 'failed',
    detail: 'Audit the poster page for contrast regressions',
    startedAt: '2026-06-20T14:04:22Z',
    durationMs: 12_000,
  },
]

const activityRecords: AgentActivityRecord[] = [
  ...activityLaneRuns,
  {
    taskId: 'task-copy',
    tool: 'copywriter',
    status: 'completed',
    detail: 'Draft the two-paragraph announcement post',
    startedAt: '2026-06-20T13:41:00Z',
    costUsd: 0.0062,
    durationMs: 21_000,
    traceId: '7d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a',
    missionRef: { missionId: 'mission-launch', stepId: 'step-copy', label: 'Launch campaign · copy' },
  },
]

const olderActivityRecords: AgentActivityRecord[] = [
  {
    taskId: 'task-moodboard',
    tool: 'researcher',
    status: 'completed',
    detail: 'Assemble the moodboard references for the poster scene',
    startedAt: '2026-06-19T16:20:00Z',
    costUsd: 0.0189,
    durationMs: 66_000,
  },
  {
    taskId: 'task-palette',
    tool: 'coder',
    status: 'cancelled',
    detail: 'Extract the palette from the brand guide',
    startedAt: '2026-06-19T15:58:00Z',
    durationMs: 9_000,
  },
]

/** Cursor-paged data port: first page carries `nextCursor`, the second ends. */
export const fetchActivityPopulated = async (cursor?: string): Promise<AgentActivityPage> => {
  console.log('fetchActivity', cursor ?? '(head)')
  if (cursor) return { items: olderActivityRecords }
  return { items: activityRecords, nextCursor: 'older' }
}

export const fetchActivityEmpty = async (): Promise<AgentActivityPage> => ({ items: [] })

export const fetchActivityError = async (): Promise<AgentActivityPage> => {
  throw new Error('activity journal unavailable (503)')
}

/** Never settles — the refresh spinner holds. */
export const fetchActivityHangs = (): Promise<AgentActivityPage> =>
  new Promise<AgentActivityPage>(() => {})

// ── flow waterfall ──────────────────────────────────────────────────────────

export const posterFlowTrace: FlowTrace = {
  spans: [
    { kind: 'pipeline', name: 'mission.launch-poster', startMs: 0, endMs: 48_000 },
    { kind: 'model', name: 'claude-opus-4 · plan', startMs: 400, endMs: 8_200 },
    { kind: 'tool', name: 'sandbox_run_command', startMs: 8_400, endMs: 30_200 },
    { kind: 'tool', name: 'canvas_export', startMs: 30_600, endMs: 44_100, approx: true },
    { kind: 'model', name: 'claude-opus-4 · summarize', startMs: 44_300, endMs: 47_800 },
  ],
  totalMs: 48_000,
  promptTokens: 7_120,
  completionTokens: 942,
  costUsd: 0.1774,
  toolCalls: 2,
}

export const failedFlowTrace: FlowTrace = {
  ...posterFlowTrace,
  spans: [
    ...(posterFlowTrace.spans.slice(0, 3)),
    { kind: 'tool', name: 'schedule_followup', startMs: 30_600, endMs: 39_900, meta: { status: 'failed' } },
    { kind: 'model', name: 'claude-opus-4 · summarize', startMs: 44_300, endMs: 47_800 },
  ],
}

// ── story helpers ───────────────────────────────────────────────────────────

/**
 * Clicks the first button inside its subtree on mount — the trick that renders
 * a popover-driven control (ModelPicker, EffortPicker, the lane's "timeline"
 * toggle) in its OPEN state for a static story. Programmatic `click()` fires
 * no `mousedown`, so `usePopover`'s outside-click closer does not immediately
 * re-close it.
 */
export function AutoClick({ children, selector }: { children: ReactNode; selector?: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const button = selector
      ? host.querySelector<HTMLButtonElement>(selector)
      : host.querySelector('button')
    button?.click()
  }, [selector])
  return <div ref={hostRef}>{children}</div>
}

/**
 * Real positive-Y headroom for upward-opening popovers. ModelPicker,
 * EffortPicker, and AgentSessionControls' menus are inline-absolute
 * `bottom-full` popovers: opened near the canvas top they extend into
 * negative-Y space, which the iframe cannot scroll to — the popover reads as
 * clipped no matter the layout. (The old `pt-[NNNpx]` wrappers only pushed
 * the trigger down a fixed amount; the popover still overflowed whenever the
 * canvas was shorter than the pad plus the popover.)
 *
 * This decorator anchors the story to the BOTTOM of a 520px-tall block
 * (`flex items-end`), so the popover opens into canvas space above the
 * trigger. 520px covers the tallest popover (ModelPicker ~470px; the gear
 * menu ~260px and EffortPicker ~210px fit with room to spare). Works under
 * both `centered` and `padded` layouts.
 *
 *   decorators: [withPopoverHeadroom]
 */
export const withPopoverHeadroom: Decorator = (Story) => (
  <div className="flex min-h-[520px] items-end">
    <Story />
  </div>
)

/**
 * Minimal line-based markdown renderer for the plan/question cards'
 * `renderMarkdown` slot — just enough structure (headings, lists, quotes) for
 * the card stories to show formatted copy instead of the pre-wrap fallback.
 */
export function renderStoryMarkdown(markdown: string): ReactNode {
  return (
    <div className="space-y-1.5">
      {markdown.split('\n').map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <p key={i} className="pt-1 text-sm font-semibold text-foreground">
              {line.slice(3)}
            </p>
          )
        }
        if (line.startsWith('# ')) {
          return (
            <p key={i} className="pt-1 text-base font-semibold text-foreground">
              {line.slice(2)}
            </p>
          )
        }
        if (/^[-\d]/.test(line) && (line.startsWith('- ') || /^\d+\.\s/.test(line))) {
          return (
            <p key={i} className="pl-3 text-sm leading-5 text-foreground">
              {line.startsWith('- ') ? `• ${line.slice(2)}` : line}
            </p>
          )
        }
        if (line.startsWith('> ')) {
          return (
            <p key={i} className="border-l-2 border-border pl-2 text-sm italic text-muted-foreground">
              {line.slice(2)}
            </p>
          )
        }
        if (line.trim() === '') return null
        return (
          <p key={i} className="text-sm leading-5 text-foreground">
            {line}
          </p>
        )
      })}
    </div>
  )
}
