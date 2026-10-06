/** App-shell story fixtures: the shared chat thread without its opening system message, plus shell-specific sessions and models. */

import type { CatalogModel, ChatUiMessage } from '../../web-react'
import {
  chatThread as fullChatThread,
  proposalAwaitingApprovalMessage,
  streamingAssistantMessage,
} from '../fixtures/chat'
import type { SessionStatus, ShellSessionSection } from './shell'

export { proposalAwaitingApprovalMessage, streamingAssistantMessage }

/** The app shell begins with the first user turn; the shared thread also includes a system preface. */
export const chatThread: ChatUiMessage[] = fullChatThread.slice(1)

// ── Model catalog (drives the per-message cost line) ─────────────────────────

/**
 * Minimal catalog. `anthropic/claude-opus-4` matches every `modelUsed` in the
 * thread, so `formatModelCost` renders the per-message cost line; the second
 * entry gives the composer's model chip somewhere to go.
 */
export const shellModels: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-4',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    description: 'Frontier reasoning model used for the launch-poster workspace.',
    pricing: { prompt: '0.000015', completion: '0.000075' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'openai/gpt-5.2',
    name: 'GPT-5.2',
    provider: 'openai',
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
]

// ── Sidebar sessions ──────────────────────────────────────────────────────────

/**
 * The session list a production agent shell shows: recency-grouped sections,
 * one live turn elsewhere (`running`), and titles that read like real work.
 * The active session (`launch-poster`) is the thread in `chatThread`.
 */
export const shellSections: ShellSessionSection[] = [
  {
    id: 'today',
    label: 'Today',
    sessions: [
      { id: 'launch-poster', title: 'Launch poster review' },
      { id: 'pricing-rewrite', title: 'Q3 pricing page rewrite', status: 'running' },
      { id: 'lifecycle-email', title: 'Lifecycle email sequence' },
    ],
  },
  {
    id: 'week',
    label: 'Previous 7 days',
    sessions: [
      { id: 'egress-audit', title: 'Sandbox egress audit' },
      { id: 'conductor-teardown', title: 'Competitor teardown: Conductor' },
      { id: 'approvals-ux', title: 'Blog draft: approvals UX' },
      { id: 'vault-onboarding', title: 'Vault onboarding flow' },
    ],
  },
  {
    id: 'earlier',
    label: 'Earlier',
    sessions: [
      { id: 'failover-runbook', title: 'Model failover runbook' },
      { id: 'cost-report', title: 'Token cost report — July' },
    ],
  },
]

/** Return a copy of `sections` with one session's status changed (story args
 *  are frozen, so derive rather than mutate). */
export function withSessionStatus(
  sections: ShellSessionSection[],
  sessionId: string,
  status: SessionStatus,
): ShellSessionSection[] {
  return sections.map((section) => ({
    ...section,
    sessions: section.sessions.map((s) => (s.id === sessionId ? { ...s, status } : s)),
  }))
}
