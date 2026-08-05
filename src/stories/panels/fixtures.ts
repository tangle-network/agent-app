/**
 * Fixtures for the panels area (teams / intakes / work-product). Local to this
 * area: the shared `src/stories/fixtures` barrel covers chat, catalog, canvas,
 * and sequences — none of which these surfaces consume.
 *
 * Shapes mirror the API seams: `MemberView` / `InvitationView` are what
 * `teams/members-api` and `teams/invitations-api` return, `IntakeView` is what
 * `intakes/api` returns, and `WorkProductRecord` is the durable review row.
 */

import type { IntakeAnswers, IntakeGraph } from '../../intakes/model'
import { intakeProgress, nextQuestion } from '../../intakes/model'
import type { IntakeView } from '../../intakes-react'
import type { InviteAcceptDetails, InvitationView, MemberView } from '../../teams-react'
import type { ProfileBacktestSummary, WorkProductRecord } from '../../work-product/types'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const NOW = Date.now()

// ── teams: members ───────────────────────────────────────────────────────────

/** A realistic workspace roster: an explicit owner, an inherited org owner
 *  (not editable here), one of each assignable role, and a pending invite. */
export const MEMBERS: MemberView[] = [
  {
    id: 'mem-dana',
    userId: 'usr-dana',
    role: 'owner',
    name: 'Dana Whitfield',
    email: 'dana@acme.com',
    acceptedAt: NOW - 84 * DAY,
  },
  {
    id: 'mem-morgan',
    userId: 'usr-morgan',
    role: 'owner',
    name: 'Morgan Hale',
    email: 'morgan@tangle.network',
    acceptedAt: NOW - 80 * DAY,
    inherited: true,
  },
  {
    id: 'mem-amir',
    userId: 'usr-amir',
    role: 'admin',
    name: 'Amir Chen',
    email: 'amir@acme.com',
    acceptedAt: NOW - 61 * DAY,
  },
  {
    id: 'mem-sofia',
    userId: 'usr-sofia',
    role: 'editor',
    name: 'Sofia Reyes',
    email: 'sofia@acme.com',
    acceptedAt: NOW - 40 * DAY,
  },
  {
    id: 'mem-theo',
    userId: 'usr-theo',
    role: 'viewer',
    name: null,
    email: 'theo@acme.com',
    acceptedAt: NOW - 12 * DAY,
  },
  {
    id: 'mem-jules',
    userId: null,
    role: 'editor',
    name: null,
    email: 'jules@acme.com',
    acceptedAt: null,
  },
]

// ── teams: invitations ───────────────────────────────────────────────────────

function inviteUrl(token: string): string {
  return `https://app.tangle.example/invite/${token}`
}

/** Every lifecycle status × every email-delivery status a history list shows. */
export const INVITATIONS: InvitationView[] = [
  {
    id: 'inv-jules',
    email: 'jules@acme.com',
    permissions: 'editor',
    status: 'pending',
    emailStatus: 'sent',
    expiresAt: NOW + 6 * DAY,
    inviteUrl: inviteUrl('inv_9f2c7a41b3d8e6f0a1c2b3d4e5f6a7b8'),
  },
  {
    id: 'inv-priya',
    email: 'priya@acme.com',
    permissions: 'admin',
    status: 'pending',
    emailStatus: 'not_sent',
    expiresAt: NOW + 7 * DAY,
    inviteUrl: inviteUrl('inv_1a2b3c4d5e6f708192a3b4c5d6e7f809'),
  },
  {
    id: 'inv-bounced',
    email: 'old-address@vendor.example',
    permissions: 'viewer',
    status: 'pending',
    emailStatus: 'failed',
    expiresAt: NOW + 5 * DAY,
    inviteUrl: inviteUrl('inv_a8b7c6d5e4f309182736455647382910'),
  },
  {
    id: 'inv-sofia',
    email: 'sofia@acme.com',
    permissions: 'editor',
    status: 'accepted',
    emailStatus: 'sent',
    expiresAt: NOW - 33 * DAY,
    inviteUrl: inviteUrl('inv_0011223344556677889900aabbccddee'),
  },
  {
    id: 'inv-lapsed',
    email: 'lapsed@partner.example',
    permissions: 'viewer',
    status: 'expired',
    emailStatus: 'sent',
    expiresAt: NOW - 2 * DAY,
    inviteUrl: inviteUrl('inv_ffeeddccbbaa99887766554433221100'),
  },
  {
    id: 'inv-revoked',
    email: 'contractor@acme.com',
    permissions: 'admin',
    status: 'revoked',
    emailStatus: 'sent',
    expiresAt: NOW + 3 * DAY,
    inviteUrl: inviteUrl('inv_13579bdf02468ace13579bdf02468ace'),
  },
]

// ── teams: invite accept page ────────────────────────────────────────────────

/** The valid, signed-out invite — the landing state of `/invite/:token`. */
export const INVITE_SIGNED_OUT: InviteAcceptDetails = {
  status: 'pending',
  workspaceName: 'Acme Tax',
  inviterName: 'Dana Whitfield',
  role: 'editor',
  inviteEmail: 'jules@acme.com',
  currentUserEmail: null,
  expiresAt: NOW + 6 * DAY,
}

/** Signed in as the invited address — the accept action is live. */
export const INVITE_READY: InviteAcceptDetails = {
  ...INVITE_SIGNED_OUT,
  currentUserEmail: 'jules@acme.com',
}

/** Signed in as someone else — the switch-account branch. */
export const INVITE_EMAIL_MISMATCH: InviteAcceptDetails = {
  ...INVITE_SIGNED_OUT,
  currentUserEmail: 'jules@personal.example',
}

/** Right address, unverified — the resend-verification branch. */
export const INVITE_NEEDS_VERIFICATION: InviteAcceptDetails = {
  ...INVITE_READY,
  needsEmailVerification: true,
}

// ── intakes: onboarding interview ────────────────────────────────────────────

/** A small linear graph with one of the common field types. The optional
 *  multi-select demonstrates that optional questions don't count toward the
 *  progress denominator (3 required of 4 questions). */
const ONBOARDING_INTAKE: IntakeGraph = {
  id: 'user-onboarding-v1',
  title: 'Welcome to Tangle',
  description: 'A few quick questions so your agent knows how to work with you.',
  questions: [
    {
      id: 'name',
      prompt: 'What should we call you?',
      type: 'text',
      required: true,
      help: 'Your display name across workspaces.',
    },
    {
      id: 'role',
      prompt: 'What best describes your role?',
      type: 'single-select',
      required: true,
      options: [
        { value: 'founder', label: 'Founder / owner' },
        { value: 'finance', label: 'Finance / accounting' },
        { value: 'legal', label: 'Legal / counsel' },
        { value: 'marketing', label: 'Marketing / growth' },
      ],
    },
    {
      id: 'stack',
      prompt: 'Which tools does your team already use?',
      type: 'multi-select',
      help: 'Optional — pick any that apply.',
      options: [
        { value: 'quickbooks', label: 'QuickBooks' },
        { value: 'netsuite', label: 'NetSuite' },
        { value: 'salesforce', label: 'Salesforce' },
        { value: 'hubspot', label: 'HubSpot' },
        { value: 'notion', label: 'Notion' },
      ],
    },
    {
      id: 'briefings',
      prompt: 'Do you want a Monday-morning agent briefing?',
      type: 'boolean',
      required: true,
    },
  ],
}

/** Derive a view from the graph the same way `intakes/api` does — the server
 *  re-derives next question + progress after every persisted answer. */
export function intakeViewFor(answers: IntakeAnswers, completed = false): IntakeView {
  return {
    title: ONBOARDING_INTAKE.title,
    description: ONBOARDING_INTAKE.description,
    answers,
    nextQuestion: completed ? null : nextQuestion(ONBOARDING_INTAKE, answers),
    completed,
    progress: intakeProgress(ONBOARDING_INTAKE, answers),
  }
}

/** Answer snapshots at each step of the flow, for the static step stories. */
export const INTAKE_STEPS = {
  /** Nothing answered — the text question, progress 0/3. */
  start: {},
  /** Name answered — the single-select question, progress 1/3. */
  role: { name: 'Dana Whitfield' },
  /** Role answered — the boolean question (optional multi-select skipped), 2/3. */
  briefings: { name: 'Dana Whitfield', role: 'finance' },
  /** All required answered — nextQuestion is null, the Finish action shows. */
  ready: { name: 'Dana Whitfield', role: 'finance', stack: ['quickbooks', 'notion'], briefings: true },
} satisfies Record<string, IntakeAnswers>

// ── work product: legal redline (rich record) ────────────────────────────────

const MSA_BASELINE = `# Master Services Agreement

**Parties.** Acme Corp ("Client") and Tangle Labs ("Provider").

## 1. Services
Provider shall deliver the services described in each statement of work.

## 2. Fees
Client shall pay the fees set forth in each SOW within thirty (30) days of invoice.

## 3. Indemnification
Client shall indemnify Provider against all claims, without limit.

## 4. Limitation of Liability
Provider's aggregate liability is unlimited for gross negligence.

## 5. Governing Law
This Agreement is governed by the laws of the State of Delaware.

## 6. Term
This Agreement begins on the Effective Date and continues for one (1) year.
`

const MSA_V2 = `# Master Services Agreement

**Parties.** Acme Corp ("Client") and Tangle Labs ("Provider").

## 1. Services
Provider shall deliver the services described in each statement of work.

## 2. Fees
Client shall pay the fees set forth in each SOW within forty-five (45) days of invoice.
Late amounts accrue interest at 1% per month.

## 3. Indemnification
Each party shall indemnify the other against third-party claims arising from
its breach of this Agreement. Liability under this Section 3 is capped at
$250,000.

## 4. Limitation of Liability
Neither party's aggregate liability exceeds $250,000, except for gross
negligence or willful misconduct.

## 5. Governing Law
This Agreement is governed by the laws of the State of California.

## 6. Term
This Agreement begins on the Effective Date and continues for one (1) year.
`

const MSA_CURRENT = `# Master Services Agreement

**Parties.** Acme Corp ("Client") and Tangle Labs ("Provider").

## 1. Services
Provider shall deliver the services described in each statement of work.

## 2. Fees
Client shall pay the fees set forth in each SOW within forty-five (45) days of invoice.
Late amounts accrue interest at 1% per month.

## 3. Indemnification
Each party shall indemnify the other against third-party claims arising from
its breach of this Agreement. Liability under this Section 3 is capped at the
fees paid in the trailing twelve (12) months.

## 4. Limitation of Liability
Neither party's aggregate liability exceeds the fees paid in the trailing
twelve (12) months, except for gross negligence or willful misconduct.

## 5. Governing Law
This Agreement is governed by the laws of the State of California.

## 6. Term
This Agreement begins on the Effective Date and continues for one (1) year,
renewing automatically for successive one-year terms unless either party gives
sixty (60) days' notice.

## 7. Confidentiality
Each party shall hold the other's Confidential Information in confidence for
three (3) years following disclosure.
`

const MSA_V1 = `# Master Services Agreement

**Parties.** Acme Corp ("Client") and Tangle Labs ("Provider").

## 1. Services
Provider shall deliver the services described in each statement of work.

## 2. Fees
Client shall pay the fees set forth in each SOW within thirty (30) days of invoice.

## 3. Indemnification
Client shall indemnify Provider against all claims, capped at $100,000.

## 4. Limitation of Liability
Provider's aggregate liability is unlimited for gross negligence.

## 5. Governing Law
This Agreement is governed by the laws of the State of Delaware.

## 6. Term
This Agreement begins on the Effective Date and continues for one (1) year.
`

/** Bodies behind `history[].artifactPath`, for the version-compare seam. */
export const VERSION_BODIES: Record<string, string> = {
  'snapshots/acme-msa/v1.md': MSA_V1,
  'snapshots/acme-msa/v2.md': MSA_V2,
  'snapshots/acme-msa/v3.md': MSA_CURRENT,
}

/** A ready-for-review legal redline: baseline diff, span/model evidence,
 *  one exception per severity, mixed-verdict checks, and a 3-version history. */
export const REDLINE_RECORD: WorkProductRecord = {
  id: 'wp-acme-msa',
  workspaceId: 'ws-acme',
  threadId: 'thr-msa-review',
  scopeKey: 'contract:acme-msa',
  status: 'ready',
  version: 3,
  artifact: {
    kind: 'redline',
    title: 'Acme MSA — Redline',
    path: 'workspaces/ws-acme/out/acme-msa-redline.md',
    content: MSA_CURRENT,
    baseline: {
      path: 'workspaces/ws-acme/corpus/acme-msa-original.md',
      content: MSA_BASELINE,
    },
  },
  evidence: [
    {
      id: 'ev-indemnity-statute',
      sourceRef: 'corpus/ca-civ-code-2782.md',
      locator: {
        range: '¶2',
        quote: 'construction contracts may not require one-way indemnity',
        quoteBasis: 'model',
      },
      target: 'clause:indemnification',
      claim: 'One-way indemnity is unenforceable — made mutual with a trailing-12-month fee cap',
      confidence: 0.92,
    },
    {
      id: 'ev-governing-law',
      sourceRef: 'corpus/acme-vendor-policy.pdf',
      locator: {
        page: 4,
        quote: 'All vendor agreements must be governed by California law',
        span: { start: 812, end: 870 },
        quoteBasis: 'span',
      },
      target: 'clause:governing-law',
      claim: 'Governing law switched Delaware → California per vendor policy',
    },
    {
      id: 'ev-payment-terms',
      sourceRef: 'corpus/acme-ap-playbook.md',
      locator: { range: 'L41-L44' },
      target: 'clause:fees',
      claim: 'AP policy requires net-45 minimum — payment term moved 30 → 45 days',
      confidence: 0.88,
    },
  ],
  exceptions: [
    {
      id: 'exc-signature-page',
      severity: 'blocking',
      kind: 'missing_document',
      message: 'Signature page for the MSA is not in the corpus — cannot verify execution authority.',
      targets: ['clause:term'],
      resolved: false,
    },
    {
      id: 'exc-gov-law-conflict',
      severity: 'material',
      kind: 'inconsistent_source',
      message: 'The 2024 NDA between the parties names Delaware law — confirm the MSA should diverge.',
      targets: ['clause:governing-law'],
      resolved: false,
    },
    {
      id: 'exc-renewal-notice',
      severity: 'advisory',
      kind: 'style_drift',
      message: 'Renewal notice period standardized to sixty days across vendor agreements.',
      resolved: true,
      resolvedBy: 'agent',
      resolutionNote: 'Aligned with the vendor-agreement style guide.',
    },
  ],
  checks: [
    {
      id: 'chk-coverage',
      name: 'evidence_coverage',
      passed: true,
      source: 'platform',
      detail: '3 of 3 material changes trace to corpus evidence.',
    },
    {
      id: 'chk-consistency',
      name: 'clause_consistency',
      passed: false,
      source: 'judge',
      detail: 'Section 4 references the trailing-twelve-month cap before Section 3 defines it.',
    },
    {
      id: 'chk-style',
      name: 'style_guide',
      passed: true,
      source: 'agent',
      detail: 'Defined terms are capitalized consistently.',
    },
  ],
  provenance: {
    profileHash: 'sha256-9f2c7a41b3d8e6f0a1c2',
    runId: 'run-acme-msa-v3',
    servingModels: ['gpt-5', 'claude-sonnet-4-5'],
    costUsd: 0.4182,
    producedAt: NOW - 2 * HOUR,
  },
  history: [
    {
      version: 1,
      status: 'superseded',
      provenance: {
        profileHash: 'sha256-9f2c7a41b3d8e6f0a1c2',
        runId: 'run-acme-msa-v1',
        servingModels: ['gpt-5'],
        costUsd: 0.1904,
        producedAt: NOW - 8 * DAY,
      },
      artifactPath: 'snapshots/acme-msa/v1.md',
      at: NOW - 8 * DAY,
    },
    {
      version: 2,
      status: 'changes_requested',
      provenance: {
        profileHash: 'sha256-9f2c7a41b3d8e6f0a1c2',
        runId: 'run-acme-msa-v2',
        servingModels: ['gpt-5'],
        costUsd: 0.2763,
        producedAt: NOW - 3 * DAY,
      },
      artifactPath: 'snapshots/acme-msa/v2.md',
      reviewedBy: 'Dana Whitfield',
      reviewNote: 'Indemnity cap should track fees paid, not a fixed dollar amount.',
      at: NOW - 3 * DAY,
    },
    {
      version: 3,
      status: 'ready',
      provenance: {
        profileHash: 'sha256-9f2c7a41b3d8e6f0a1c2',
        runId: 'run-acme-msa-v3',
        servingModels: ['gpt-5', 'claude-sonnet-4-5'],
        costUsd: 0.4182,
        producedAt: NOW - 2 * HOUR,
      },
      artifactPath: 'snapshots/acme-msa/v3.md',
      at: NOW - 2 * HOUR,
    },
  ],
  createdAt: NOW - 9 * DAY,
  updatedAt: NOW - 2 * HOUR,
}

/** The trust-gate-passing backtest summary for the redline record's profile. */
export const BACKTEST_PASS: ProfileBacktestSummary = {
  profileHash: 'sha256-9f2c7a41b3d8e6f0a1c2',
  cases: 182,
  composite: 0.81,
  trust: 'pass',
  trustReasons: [],
}

// ── work product: other record shapes ────────────────────────────────────────

/** An accumulating draft: artifact null, every list empty — the "nothing to
 *  review yet" pane (artifact tab renders its empty copy). */
export const DRAFT_RECORD: WorkProductRecord = {
  id: 'wp-q3-launch',
  workspaceId: 'ws-acme',
  threadId: 'thr-q3-launch',
  scopeKey: 'campaign:q3-launch',
  status: 'draft',
  version: 1,
  artifact: null,
  evidence: [],
  exceptions: [],
  checks: [],
  provenance: {
    profileHash: 'sha256-71aa0c44d2e9b1f80342',
    runId: 'run-q3-launch-v1',
    servingModels: [],
    producedAt: NOW - 15 * 60 * 1000,
  },
  history: [],
  createdAt: NOW - 15 * 60 * 1000,
  updatedAt: NOW - 15 * 60 * 1000,
}

/** A tax-style fields package: no markdown body — the artifact is a structured
 *  field map (rendered as JSON) and lineage anchors to form-line ids. */
export const FIELDS_RECORD: WorkProductRecord = {
  id: 'wp-acme-1040',
  workspaceId: 'ws-acme',
  threadId: 'thr-acme-2025-return',
  scopeKey: 'return:acme:2025',
  status: 'approved',
  version: 1,
  artifact: {
    kind: 'return_package',
    title: 'Acme 2025 — Form 1040 Package',
    fields: {
      '1040.line_1a': 182400,
      '1040.line_2b': 3140,
      '1040.line_9': 196120,
      '1040.line_15': 141870,
      '1040.line_24': 31280,
      '1040.line_33': 37400,
      '1040.line_37': 0,
      '1040.line_38': 6120,
    },
  },
  evidence: [
    {
      id: 'ev-w2-wages',
      sourceRef: 'vault/2025/w2-acme.pdf',
      locator: {
        page: 1,
        quote: 'Box 1 — Wages, tips, other compensation: 182,400.00',
        span: { start: 1204, end: 1256 },
        quoteBasis: 'span',
      },
      target: '1040.line_1a',
      claim: 'Wages per W-2 Box 1',
    },
    {
      id: 'ev-1099-int',
      sourceRef: 'vault/2025/1099-int-firstbank.pdf',
      locator: { page: 1, range: 'Box 1' },
      target: '1040.line_2b',
      claim: 'Taxable interest per 1099-INT',
      confidence: 0.97,
    },
  ],
  exceptions: [],
  checks: [
    {
      id: 'chk-totals',
      name: 'totals_reconcile',
      passed: true,
      source: 'platform',
      detail: 'Line 9 equals the sum of lines 1a–8.',
    },
    {
      id: 'chk-coverage-1040',
      name: 'evidence_coverage',
      passed: true,
      source: 'judge',
      detail: 'Every material line traces to a source document.',
    },
  ],
  provenance: {
    profileHash: 'sha256-71aa0c44d2e9b1f80342',
    runId: 'run-acme-1040-v1',
    servingModels: ['gpt-5'],
    costUsd: 0.2311,
    producedAt: NOW - 26 * HOUR,
  },
  history: [
    {
      version: 1,
      status: 'approved',
      provenance: {
        profileHash: 'sha256-71aa0c44d2e9b1f80342',
        runId: 'run-acme-1040-v1',
        servingModels: ['gpt-5'],
        costUsd: 0.2311,
        producedAt: NOW - 26 * HOUR,
      },
      reviewedBy: 'Dana Whitfield',
      reviewNote: 'Matches the W-2 and the 1099-INT — approved.',
      at: NOW - 20 * HOUR,
    },
  ],
  createdAt: NOW - 30 * HOUR,
  updatedAt: NOW - 20 * HOUR,
}
