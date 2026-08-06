/**
 * Chat fixtures: a long, realistic `ChatUiMessage` thread for story spacing
 * evaluation, plus the individual edge-state messages (proposal awaiting
 * approval, errored tool call, streaming in progress) exported on their own
 * so stories can render a single state in isolation.
 *
 * Types come from the package source (`../../web-react`) — the same types the
 * chat components consume — so a drift in `ChatUiMessage` fails typecheck here.
 */

import type { ChatToolCallInfo, ChatUiMessage } from '../../web-react'

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
 * `result.status === 'queued_for_approval'` + a proposalId, so the chip renders
 * the Approve/Reject affordance when the story passes `approval` handlers.
 */
export const proposalToolCall: ChatToolCallInfo = {
  id: 'tc-proposal',
  name: 'submit_proposal',
  status: 'done',
  args: { type: 'asset_publish', title: 'Launch poster' },
  result: { ok: true, result: { status: 'queued_for_approval', proposalId: 'prop-42' } },
}

/** A tool call whose run failed — the chip renders the error state + message. */
export const erroredToolCall: ChatToolCallInfo = {
  id: 'tc-followup',
  name: 'schedule_followup',
  status: 'error',
  args: { title: 'Post launch poster', when: '2026-06-22T09:00:00Z' },
  result: { ok: false, message: 'scheduler unavailable: upstream 503' },
}

/** A tool call still executing — no `result` yet, chip shows the spinner. */
export const runningToolCall: ChatToolCallInfo = {
  id: 'tc-export',
  name: 'canvas_export',
  status: 'running',
  args: { page: 'page-1', format: 'png', dpi: 144 },
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
  content: 'Exporting the poster at print resolution now. Once the file lands I\u2019ll',
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
      'Retry the scheduling — the 503 looked transient. And while you\u2019re at it, break down what this render cost us in tokens so I can sanity-check the campaign budget before we scale beyond the poster.',
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
      {
        kind: 'tool',
        call: {
          id: 'tc-followup-2',
          name: 'schedule_followup',
          status: 'done',
          args: { title: 'Post launch poster', when: '2026-06-22T09:00:00Z' },
          result: { ok: true, result: { followupId: 'fu-7', scheduledFor: '2026-06-22T09:00:00Z' } },
        },
      },
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
      'Proposal approved — the poster is cleared to publish. I\u2019m exporting the print-resolution file now.',
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
    content: 'Exporting the poster at print resolution now. Once the file lands I\u2019ll',
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
      'Here\u2019s a draft:',
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
