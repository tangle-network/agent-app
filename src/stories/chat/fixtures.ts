import { catalogModels } from '../fixtures/catalog'
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
export const chatCatalogModels: CatalogModel[] = structuredClone(catalogModels.slice(0, 2))

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

/** Participants of a thread a client, an attorney and the agent share. */
export const multiPartyAuthors = {
  client: { id: 'client-maria-lopez', name: 'Maria Lopez', role: 'Client' },
  attorney: { id: 'attorney-jane-doe', name: 'Jane Doe', role: 'Attorney' },
  agent: { id: 'agent-intake', name: 'Intake assistant', role: 'AI' },
} as const

/** A legal intake that the agent hands to an attorney, who joins the thread. */
export const multiPartyThread: ChatUiMessage[] = [
  {
    id: 'mp-1',
    role: 'user',
    author: multiPartyAuthors.client,
    content:
      'My landlord kept my $2,400 security deposit and never sent an itemized list. I moved out on August 31. What can I do?',
  },
  {
    id: 'mp-2',
    role: 'assistant',
    author: multiPartyAuthors.agent,
    modelUsed: 'anthropic/claude-opus-4',
    content:
      'In California a landlord has 21 days after move-out to return the deposit or send an itemized statement of deductions. That window closed on September 21.\n\nThis looks like a case an attorney should review, so I have shared your summary with Jane Doe.',
  },
  {
    id: 'mp-3',
    role: 'user',
    author: multiPartyAuthors.attorney,
    content: 'Hi Maria, I am Jane. Did you give the landlord a forwarding address in writing?',
  },
  {
    id: 'mp-4',
    role: 'user',
    author: multiPartyAuthors.client,
    content: 'Yes, I emailed it to the property manager on August 28.',
  },
  {
    id: 'mp-5',
    role: 'assistant',
    author: multiPartyAuthors.agent,
    modelUsed: 'anthropic/claude-opus-4',
    content: 'I added the August 28 email to the case file.',
  },
  {
    id: 'mp-6',
    role: 'user',
    author: multiPartyAuthors.attorney,
    content: 'Thanks. I will draft a demand letter today, and you will have it to review by 5pm.',
  },
]

/** One turn addressed to two agents: ONE stored assistant row whose parts carry
 *  a speaker part before each answer. `ChatMessages` draws it as two answers
 *  under two authors, in the order the person typed the mentions. */
export const twoAgentsThread: ChatUiMessage[] = [
  {
    id: 'ta-1',
    role: 'user',
    content: '@writer @research-lead plan the launch announcement for the roster feature.',
    parts: [
      { type: 'mention', mentionKind: 'agent', path: 'writer', name: 'Writer', agentId: 'ap_writer' },
      { type: 'mention', mentionKind: 'agent', path: 'research-lead', name: 'Research Lead', agentId: 'ap_research' },
    ],
  },
  {
    id: 'ta-2',
    role: 'assistant',
    modelUsed: 'anthropic/claude-opus-4',
    content: 'Draft headline: "Every agent in your workspace, one @ away."\n\nThree risks: the roster is empty on day one for new workspaces; handles collide after a rename; routines post while nobody is watching.',
    parts: [
      { type: 'speaker', id: 'ap_writer', name: 'Writer', handle: 'writer' },
      { type: 'text', text: 'Draft headline: "Every agent in your workspace, one @ away."\n\nSubhead: address any agent from any thread, and let it run on a schedule while you sleep.' },
      { type: 'speaker', id: 'ap_research', name: 'Research Lead', handle: 'research-lead' },
      { type: 'reasoning', text: 'Check what shipped and what is still open before naming risks.' },
      { type: 'text', text: 'Checking the roster and the mention routes first.' },
      { type: 'tool', id: 'tool-1', callID: 'call_search', tool: 'search_repo', state: { status: 'completed', input: { query: 'agent mention roster' }, output: { files: 3 } } },
      { type: 'text', text: 'Three risks to name in the copy: the roster is empty on day one for a new workspace; a renamed agent keeps its old handle reserved, so say so; a routine posts while nobody is watching, so the thread must show who ran it.' },
    ],
  },
]
