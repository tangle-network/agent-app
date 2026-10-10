/**
 * The vocabulary of a Hub action that waits on a person: where it stands, what
 * it will do in the owner's words, and what it did once it ran.
 */

/** Where one held action stands, as the dock, the list and the transcript show it. */
export type HubApprovalPhase =
  /** Held by Hub; the viewer can decide it. */
  | 'waiting'
  /** Held by Hub; someone else (the workspace owner) decides it. */
  | 'blocked'
  /** Approved here; the run has not started. */
  | 'queued'
  /** Approved; Hub is running the call. */
  | 'running'
  | 'done'
  /** Approved, but Hub could not run it. */
  | 'failed'
  /** The provider may have acted; verify there before requesting it again. */
  | 'unknown'
  | 'denied'
  | 'expired'

/** Phases that still need someone's decision. */
export const HUB_APPROVAL_OPEN_PHASES: ReadonlySet<HubApprovalPhase> = new Set(['waiting', 'blocked'])
/** Phases between a decision and its result. */
export const HUB_APPROVAL_ACTIVE_PHASES: ReadonlySet<HubApprovalPhase> = new Set(['queued', 'running'])

/** A file a held write changes. Counts stay undefined until someone has read them. */
export interface HubActionFile {
  path: string
  /** A rename reads as a modification of its new path. */
  change: 'added' | 'modified' | 'deleted'
  additions?: number
  deletions?: number
}

/**
 * The change a held call serves, when it is one step of a larger change such
 * as a pull request. The dock then names the change rather than the step.
 */
export interface HubActionBundle {
  /** What the whole change does, e.g. `Open PR: Fix the hero on acme/site`. */
  title: string
  steps?: ReadonlyArray<{ label: string; state: 'done' | 'current' | 'upcoming' }>
}

/** Whether an open call waits for the owner, in the owner's words. */
export interface HubApprovalWait {
  /** True when nothing runs until the owner decides; false when a permission runs it. */
  owner: boolean
  /** One sentence: `Publishing always needs your approval.` or `Runs under this conversation’s auto-approve.` */
  reason: string
  /** A stable cause the host can test, e.g. `never_grantable`, `loop_guard`, `daily_cap`. */
  code?: string
}

/** One held Hub action and its decision, in the form every surface renders. */
export interface HubApprovalItem {
  /** Stable within a conversation, such as `<messageId>:<partId>`. */
  id: string
  /** `provider.action`, e.g. `github.pulls.propose`. */
  actionPath: string
  providerId: string
  /** The call's input as Hub received it. */
  input: unknown
  phase: HubApprovalPhase
  /** The connected account the action runs as, e.g. `octocat` or `ops@acme.com`. */
  account?: string | null
  requestedAt?: string | null
  /** When the decision window closes. */
  expiresAt?: string | null
  /** Hub's result, or a bounded projection of it from {@link summarizeHubResult}. */
  result?: unknown
  error?: string | null
  /** The standing permission granted with the approval. */
  grant?: { scope: string; expiresAt: string | null } | null
  /** Set when a permissions mode, not a person, approved it. */
  autoApproved?: string | null
  /**
   * For an open call, what happens next without the viewer: it waits for the
   * owner, and why, or it runs on its own once the agent's reply finishes.
   */
  wait?: HubApprovalWait | null
  /** Files with line counts read by the host, replacing those the input declares. */
  files?: readonly HubActionFile[]
  bundle?: HubActionBundle | null
}

/** A labelled value on a preview or a receipt. */
export interface HubActionField {
  label: string
  value: string
  href?: string
  /** Render in the monospace face: shas, ids, paths. */
  mono?: boolean
}

/** What a held call will do, shaped for its integration's renderer. */
export type HubActionPreview =
  | {
      kind: 'pull-request'
      repository?: string
      title?: string
      body?: string
      head?: string
      base?: string
      draft?: boolean
      files: readonly HubActionFile[]
    }
  | { kind: 'commit'; repository?: string; message?: string; tree?: string; parents: readonly string[] }
  | { kind: 'branch'; repository?: string; branch?: string; sha?: string }
  | { kind: 'files'; repository?: string; files: readonly HubActionFile[] }
  | { kind: 'issue'; repository?: string; number?: number; title?: string; body?: string; verdict?: string }
  | {
      kind: 'email'
      to: readonly string[]
      cc: readonly string[]
      bcc: readonly string[]
      subject?: string
      body?: string
      html: boolean
      reply: boolean
    }
  | {
      kind: 'post'
      channel: 'x' | 'linkedin' | 'slack'
      text: string
      /** The post's place, such as a Slack channel. */
      where?: string
      link?: { url: string; title?: string; description?: string }
    }
  | { kind: 'payment'; label: string; amount?: number; currency?: string; customer?: string; description?: string }
  | { kind: 'speech'; text: string; voice?: string; seconds?: number }
  | { kind: 'call'; to?: string; from?: string; purpose?: string }
  | {
      kind: 'event'
      title?: string
      start?: string
      end?: string
      location?: string
      attendees: readonly string[]
      description?: string
    }
  | { kind: 'fields'; fields: readonly HubActionField[] }

/** A held call in the owner's words. */
export interface HubActionPresentation {
  provider: { id: string; name: string }
  /** The imperative, e.g. `Open pull request`. */
  action: string
  /** One line naming the action and its object, e.g. `Open PR: Fix the hero on acme/site`. */
  title: string
  /** Where it acts: a repository, recipients, a channel or a customer. */
  target?: string
  preview: HubActionPreview
}

/** What a decided call did, as its receipt shows it. */
export interface HubActionReceipt {
  provider: { id: string; name: string }
  /** The result in past tense, e.g. `Opened PR #123` or `Sent email to ada@acme.com`. */
  title: string
  /** The result's own page, when it has one: the pull request, the post, the event. */
  href?: string
  status: 'done' | 'unknown' | 'failed' | 'denied' | 'expired' | 'running' | 'waiting'
  fields: readonly HubActionField[]
  files?: readonly HubActionFile[]
  media?: { kind: 'audio'; src: string; seconds?: number }
  error?: string
  /** Guidance for an uncertain outcome, separate from a confirmed failure. */
  warning?: string
}
