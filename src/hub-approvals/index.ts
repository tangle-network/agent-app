/**
 * `./hub-approvals` — Hub actions that wait on a person, in the owner's words.
 *
 * Pure and browser-safe: a host maps its held calls into {@link HubApprovalItem}s
 * and every surface — the approval dock above the composer, the Approvals list
 * beside the conversation, and the receipts in the transcript — renders the
 * same presentation from them. Servers use {@link summarizeHubResult} to store
 * a bounded result with the decision.
 */

import type { HubApprovalPhase } from './types'

export * from './types'
export {
  formatMinorAmount,
  formatWhen,
  hubActionFiles,
  hubActionReceipt,
  hubProviderName,
  pastTense,
  presentHubAction,
  splitHubActionPath,
} from './present'
export { summarizeHubResult, unwrapHubResult } from './result'

/** A phase as a status label. */
export const HUB_APPROVAL_PHASE_LABELS: Record<HubApprovalPhase, string> = {
  waiting: 'Waiting for you',
  blocked: 'Waiting for the owner',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  unknown: 'May have run',
  denied: 'Denied',
  expired: 'Expired',
}

/**
 * The part type marking a user message that resumes the agent after a
 * decision. The message's text goes to the agent unchanged; a transcript
 * renders the decided actions' receipts in its place, never a chat bubble.
 */
export const HUB_APPROVAL_RESUME_PART = 'hub-approval-resume'

export interface HubApprovalResumePart {
  type: typeof HUB_APPROVAL_RESUME_PART
  /** The assistant message whose held calls this resume reports. */
  messageId: string
}

/** The resume marker among a message's parts, if it carries one. */
export function hubApprovalResumePart(parts: ReadonlyArray<Record<string, unknown>> | null | undefined): HubApprovalResumePart | null {
  for (const part of parts ?? []) {
    if (part?.type === HUB_APPROVAL_RESUME_PART && typeof part.messageId === 'string' && part.messageId) {
      return { type: HUB_APPROVAL_RESUME_PART, messageId: part.messageId }
    }
  }
  return null
}
