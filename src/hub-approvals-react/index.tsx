/**
 * `./hub-approvals-react` — the approval surfaces every agent app shares:
 *
 * - {@link HubApprovalDock}, pinned above the composer, holds the calls waiting
 *   on the owner with their preview, decision and in-place progress;
 * - {@link HubApprovalsList}, beside the conversation, lists every call by
 *   where it stands;
 * - {@link HubApprovalRow} marks a call where the agent made it;
 * - {@link HubApprovalReceipts} stands in for the message that resumes the
 *   agent, as receipts instead of a chat bubble.
 *
 * The components never fetch: a host maps its held calls into
 * `HubApprovalItem`s (`./hub-approvals`) and supplies the decision transport.
 * Logos come from Sandbox UI's provider icon set; file changes render with
 * `ui/run`'s `ApprovalDiffSummary`.
 */
export { HubApprovalDock, type HubApprovalDecision, type HubApprovalDockProps, type HubApprovalPermissions } from './dock'
export { HubApprovalsList, type HubApprovalsListProps } from './list'
export { HubApprovalRow, type HubApprovalRowProps } from './row'
export { HubActionReceiptCard, HubApprovalReceipts, type HubActionReceiptCardProps, type HubApprovalReceiptsProps } from './receipt'
export { HubActionPreviewView } from './preview'
export { HubApprovalPhasePill, HubProviderMark } from './parts'
