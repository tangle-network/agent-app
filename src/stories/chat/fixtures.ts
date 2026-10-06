/** Chat story fixtures plus area-specific catalog, follow-up, and derived threads. */

import type { CatalogModel, ChatToolCallInfo, ChatUiMessage } from '../../web-react'
import {
  chatThread,
  doneShellToolCall,
  erroredToolCall,
  erroredToolCallMessage,
  proposalAwaitingApprovalMessage,
  proposalToolCall,
  runningToolCall,
  streamingAssistantMessage,
} from '../fixtures/chat'
export {
  chatThread,
  doneShellToolCall,
  erroredToolCall,
  erroredToolCallMessage,
  proposalAwaitingApprovalMessage,
  proposalToolCall,
  runningToolCall,
  streamingAssistantMessage,
}

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

/**
 * A settled `schedule_followup` — NOT a decision and not a failure, so it
 * renders as the quiet follow-up row (its own visual kind).
 */
export const scheduledFollowupToolCall: ChatToolCallInfo = {
  id: 'tc-followup-2',
  name: 'schedule_followup',
  status: 'done',
  args: { title: 'Post launch poster', when: '2026-06-22T09:00:00Z' },
  result: { ok: true, result: { followupId: 'fu-7', scheduledFor: '2026-06-22T09:00:00Z' } },
}

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
