/**
 * Chat-story fixtures: a long, realistic `ChatUiMessage` thread for spacing and
 * density evaluation, plus the individual edge-state messages (proposal
 * awaiting approval, errored tool call, streaming in progress) exported on
 * their own so stories can render a single state in isolation.
 *
 * NOTE: this duplicates what the shared `src/stories/fixtures/chat.ts` barrel
 * is meant to provide. The shared fixtures directory did not exist in the
 * working tree when these stories were written, so — per house rules — the
 * chat area carries its own copy. If the shared fixtures return, this file can
 * be swapped for barrel imports without touching the stories.
 *
 * Types come from the package source (`../../web-react`) — the same types the
 * chat components consume — so a drift in `ChatUiMessage` fails typecheck here.
 */

import type { CatalogModel, ChatToolCallInfo, ChatUiMessage } from '../../web-react'

// ── Model catalogue (for per-message cost) ───────────────────────────────────

/** The catalogue the thread prices against. Every fixture message runs Opus. */
export const chatCatalogModels: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-4',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    description: 'Most capable Anthropic model',
    contextLength: 1_000_000,
    pricing: { prompt: '0.000015', completion: '0.000075' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    description: 'OpenAI flagship',
    contextLength: 400_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
]

// ── Individual tool calls ─────────────────────────────────────────────────────

/** A completed sandbox command, args + result captured for the expanded card. */
export const doneShellToolCall: ChatToolCallInfo = {
  id: 'tc-shell',
  name: 'sandbox_run_command',
  status: 'done',
  args: { command: 'render --page page-1 --format png' },
  result: { ok: true, result: { stdout: 'Rendered page-1 → out/poster.png (1080x1080)', exitCode: 0 } },
}

/**
 * A proposal the human has not ruled on yet: `pendingApprovalOf` keys on
 * `result.status === 'queued_for_approval'` + a proposalId, so the card renders
 * the Approve/Reject affordance when the story passes `approval` handlers.
 */
export const proposalToolCall: ChatToolCallInfo = {
  id: 'tc-proposal',
  name: 'submit_proposal',
  status: 'done',
  args: { type: 'asset_publish', title: 'Launch poster' },
  result: { ok: true, result: { status: 'queued_for_approval', proposalId: 'prop-42' } },
}

/** A tool call whose run failed — the card renders the error state + message. */
export const erroredToolCall: ChatToolCallInfo = {
  id: 'tc-followup',
  name: 'schedule_followup',
  status: 'error',
  args: { title: 'Post launch poster', when: '2026-06-22T09:00:00Z' },
  result: { ok: false, message: 'scheduler unavailable: upstream 503' },
}

/** A tool call still executing — no `result` yet, card shows the running dot. */
export const runningToolCall: ChatToolCallInfo = {
  id: 'tc-export',
  name: 'canvas_export',
  status: 'running',
  args: { page: 'page-1', format: 'png', dpi: 144 },
}

/**
 * A settled `schedule_followup` — NOT a decision and not a failure, so the card
 * renders as the quiet left-rule follow-up variant (its own visual kind).
 */
export const scheduledFollowupToolCall: ChatToolCallInfo = {
  id: 'tc-followup-2',
  name: 'schedule_followup',
  status: 'done',
  args: { title: 'Post launch poster', when: '2026-06-22T09:00:00Z' },
  result: { ok: true, result: { followupId: 'fu-7', scheduledFor: '2026-06-22T09:00:00Z' } },
}

// ── Edge-state messages ───────────────────────────────────────────────────────

/** Assistant turn whose proposal is still awaiting human approval. */
export const proposalAwaitingApprovalMessage: ChatUiMessage = {
  id: 'm-proposal',
  role: 'assistant',
  content:
    'The poster is rendered and I submitted the publish proposal. It needs your approval before anything goes out.',
  modelUsed: 'anthropic/claude-opus-4',
  promptTokens: 1820,
  completionTokens: 340,
  durationMs: 4200,
  toolCalls: [doneShellToolCall, proposalToolCall],
}

/** Assistant turn whose only tool call failed. */
export const erroredToolCallMessage: ChatUiMessage = {
  id: 'm-error',
  role: 'assistant',
  content: 'I tried to schedule the follow-up but the scheduler rejected the request.',
  modelUsed: 'anthropic/claude-opus-4',
  promptTokens: 2100,
  completionTokens: 90,
  durationMs: 1800,
  toolCalls: [erroredToolCall],
}

/**
 * A turn still streaming: partial answer text, a tool call in flight, and no
 * completion metrics yet (no `completionTokens`/`durationMs` — producers only
 * stamp those when the turn settles).
 */
export const streamingAssistantMessage: ChatUiMessage = {
  id: 'm-streaming',
  role: 'assistant',
  content: 'Exporting the poster at print resolution now. Once the file lands I’ll',
  modelUsed: 'anthropic/claude-opus-4',
  promptTokens: 2450,
  toolCalls: [runningToolCall],
}

// ── The long thread ───────────────────────────────────────────────────────────

/**
 * ~16 messages covering every rendered state: plain exchanges, reasoning,
 * per-message metrics, interleaved `segments`, a proposal awaiting approval,
 * an errored tool call, and a trailing in-flight turn. Long enough that the
 * thread scrolls, so spacing/typography stories evaluate real rhythm.
 */
export const chatThread: ChatUiMessage[] = [
  {
    id: 'm1',
    role: 'system',
    content: 'Workspace: launch-poster. Approvals required for: asset_publish.',
  },
  {
    id: 'm2',
    role: 'user',
    content: 'Render the launch poster and queue it for review.',
  },
  {
    id: 'm3',
    role: 'assistant',
    content:
      'On it. I rendered the poster from the current scene and submitted it for approval. Here is what I ran:',
    reasoning:
      'The user wants a render + an approval gate. I will call the canvas export tool, then submit_proposal so a human signs off before anything publishes.',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 1820,
    completionTokens: 340,
    durationMs: 4200,
    toolCalls: [doneShellToolCall, proposalToolCall],
  },
  {
    id: 'm4',
    role: 'user',
    content: 'Also schedule a follow-up to post it on Monday.',
  },
  {
    id: 'm5',
    role: 'assistant',
    content: 'I tried to schedule the follow-up but the scheduler rejected the request.',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 2100,
    completionTokens: 90,
    durationMs: 1800,
    toolCalls: [erroredToolCall],
  },
  {
    id: 'm6',
    role: 'user',
    content:
      'Retry the scheduling — the 503 looked transient. And while you’re at it, break down what this render cost us in tokens so I can sanity-check the campaign budget before we scale beyond the poster.',
  },
  {
    id: 'm7',
    role: 'assistant',
    content: '',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 3200,
    completionTokens: 512,
    durationMs: 6100,
    segments: [
      { kind: 'text', content: 'Retrying the scheduler with the same Monday slot.' },
      { kind: 'tool', call: scheduledFollowupToolCall },
      { kind: 'text', content: 'Scheduled. Now the cost breakdown for this turn chain:' },
      {
        kind: 'tool',
        call: {
          id: 'tc-usage',
          name: 'usage_report',
          status: 'done',
          args: { scope: 'thread', threadId: 'launch-poster' },
          result: {
            ok: true,
            result: { promptTokens: 7120, completionTokens: 942, estimatedCostUsd: 0.1774 },
          },
        },
      },
      {
        kind: 'text',
        content:
          'All-in so far: 7,120 prompt + 942 completion tokens, about $0.18 at Opus rates. The render itself is cheap; the reasoning passes dominate.',
      },
    ],
  },
  {
    id: 'm8',
    role: 'user',
    content: 'Good. What still needs a human before launch?',
  },
  {
    id: 'm9',
    role: 'assistant',
    content: [
      'Two things:',
      '',
      '1. **The publish proposal** (`prop-42`) is still waiting on your approval — nothing ships until you rule on it.',
      '2. **The Monday follow-up** is scheduled but unreviewed; if the copy should change, edit it before 09:00 Monday.',
      '',
      'Everything else — render, export, scheduling — is done.',
    ].join('\n'),
    reasoning:
      'Inventory open loops: proposal pending, follow-up scheduled-but-unreviewed. No tool calls needed; this is a summary turn.',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 4100,
    completionTokens: 260,
    durationMs: 2900,
  },
  {
    id: 'm10',
    role: 'user',
    content: 'Approve prop-42. Then export a print-resolution PNG for the record.',
  },
  {
    id: 'm11',
    role: 'assistant',
    content:
      'Proposal approved — the poster is cleared to publish. I’m exporting the print-resolution file now.',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 4600,
    completionTokens: 120,
    durationMs: 1500,
    toolCalls: [
      {
        id: 'tc-approve',
        name: 'resolve_proposal',
        status: 'done',
        args: { proposalId: 'prop-42', resolution: 'approved' },
        result: { ok: true, result: { proposalId: 'prop-42', status: 'approved' } },
      },
    ],
  },
  {
    id: 'm12',
    role: 'assistant',
    content: 'Exporting the poster at print resolution now. Once the file lands I’ll',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 4750,
    toolCalls: [runningToolCall],
  },
  {
    id: 'm13',
    role: 'user',
    content:
      'While that runs: draft the announcement post. Two paragraphs, no hashtags, tone consistent with the last launch — measured, technical, no exclamation points.',
  },
  {
    id: 'm14',
    role: 'assistant',
    content: [
      'Here’s a draft:',
      '',
      '> The launch poster is out. It came from the same scene document the canvas has been carrying all week — no fork, no export-branch gymnastics — and the agent rendered, queued, and scheduled it behind a single approval gate.',
      '>',
      '> The interesting part is not the poster. It is that every irreversible step paused for a human, and every reversible one did not. That is the shape we want for agent-driven production work.',
      '',
      'Want it shorter, or should I queue it as a proposal for the Monday slot?',
    ].join('\n'),
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 5300,
    completionTokens: 480,
    durationMs: 5400,
  },
  {
    id: 'm15',
    role: 'user',
    content: 'Queue it for Monday alongside the poster follow-up.',
  },
  {
    id: 'm16',
    role: 'assistant',
    content: 'Draft queued with the Monday batch. Summary of the open board:',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 5900,
    completionTokens: 150,
    durationMs: 2200,
    toolCalls: [
      {
        id: 'tc-queue-draft',
        name: 'schedule_followup',
        status: 'done',
        args: { title: 'Announcement post draft', when: '2026-06-22T09:00:00Z' },
        result: { ok: true, result: { followupId: 'fu-8', scheduledFor: '2026-06-22T09:00:00Z' } },
      },
    ],
  },
]

// ── Derived threads ───────────────────────────────────────────────────────────

/** Three turns — the smallest thread that still shows bubble/answer rhythm. */
export const shortThread: ChatUiMessage[] = chatThread.slice(1, 4)

/**
 * Six representative turns (user bubble, assistant + approval card, errored
 * tool, long user message, segmented assistant) for side-by-side density
 * comparisons — compact enough to judge rhythm within one viewport.
 */
export const densityThread: ChatUiMessage[] = chatThread.slice(1, 7)

/** The segmented `usage_report` turn on its own (custom-renderer demos). */
export const usageReportMessage: ChatUiMessage[] = chatThread.slice(6, 7)

// ── Reasoning / tool-heavy thread ─────────────────────────────────────────────

/**
 * A workflow-authoring session: both assistant turns carry `reasoning`, the
 * first emits four consecutive settled tool calls (past the collapse threshold,
 * so they fold into one "Worked through 4 steps" disclosure), the second
 * interleaves text and tools via `segments` (under the threshold, so the cards
 * render inline, chronologically).
 */
export const reasoningToolThread: ChatUiMessage[] = [
  {
    id: 'r1',
    role: 'user',
    content:
      'Author the weekly metrics workflow: pull the numbers, draft the report, file it, and ping the channel.',
  },
  {
    id: 'r2',
    role: 'assistant',
    content: '',
    reasoning:
      'Four ordered steps: fetch the workflow schema so the definition validates, validate the draft, create it, then schedule it for Monday mornings. Each step depends on the previous one succeeding, so run them sequentially and stop on the first failure.',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 6200,
    completionTokens: 810,
    durationMs: 12400,
    segments: [
      {
        kind: 'text',
        content:
          'Setting up the weekly metrics workflow. I need the schema first, then validate, create, and schedule in order.',
      },
      {
        kind: 'tool',
        call: {
          id: 'rt-schema',
          name: 'get_workflow_schema',
          status: 'done',
          args: { version: 'v3' },
          result: { ok: true, result: { version: 'v3', fields: 14 } },
        },
      },
      {
        kind: 'tool',
        call: {
          id: 'rt-validate',
          name: 'validate_workflow',
          status: 'done',
          args: { definition: 'weekly-metrics.yaml' },
          result: { ok: true, result: { valid: true, warnings: 0 } },
        },
      },
      {
        kind: 'tool',
        call: {
          id: 'rt-create',
          name: 'create_workflow',
          status: 'done',
          args: { name: 'weekly-metrics', definition: 'weekly-metrics.yaml' },
          result: { ok: true, result: { workflowId: 'wf-1042' } },
        },
      },
      {
        kind: 'tool',
        call: {
          id: 'rt-schedule',
          name: 'schedule_workflow',
          status: 'done',
          args: { workflowId: 'wf-1042', cron: '0 8 * * MON' },
          result: { ok: true, result: { workflowId: 'wf-1042', nextRun: '2026-06-22T08:00:00Z' } },
        },
      },
      {
        kind: 'text',
        content:
          'Workflow `wf-1042` created and scheduled for Mondays at 08:00. The four settled steps collapsed into one disclosure above — expand it to audit each call.',
      },
    ],
  },
  {
    id: 'r3',
    role: 'user',
    content: 'What did each step actually do?',
  },
  {
    id: 'r4',
    role: 'assistant',
    content: '',
    reasoning:
      'The user wants an audit of the run, not new work. Pull the workflow detail and the run log, then summarize step by step.',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 7800,
    completionTokens: 420,
    durationMs: 6800,
    segments: [
      { kind: 'text', content: 'Pulling the workflow definition and its first run log.' },
      {
        kind: 'tool',
        call: {
          id: 'rt-detail',
          name: 'get_workflow',
          status: 'done',
          args: { workflowId: 'wf-1042' },
          result: { ok: true, result: { workflowId: 'wf-1042', steps: 4, enabled: true } },
        },
      },
      { kind: 'text', content: 'Four steps, all enabled. Checking the dry-run output:' },
      {
        kind: 'tool',
        call: {
          id: 'rt-dryrun',
          name: 'sandbox_run_command',
          status: 'done',
          args: { command: 'workflow run wf-1042 --dry-run' },
          result: {
            ok: true,
            result: { stdout: 'dry-run ok: 4 steps, 0 side effects, est. 38s', exitCode: 0 },
          },
        },
      },
      {
        kind: 'text',
        content:
          'In order: fetch last week’s numbers from the metrics store, draft the report markdown, file it to the vault, and post a one-line summary to the channel. The dry run passed with no side effects.',
      },
    ],
  },
]
