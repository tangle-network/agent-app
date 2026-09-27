/**
 * Work-product review surfaces — the sandbox-ui-FREE half of the vertical:
 *
 *  - {@link ReviewQueuePanel}: the practice/matters/campaign review queue over
 *    a `fetchQueue(cursor)` data port (the `AgentActivityPanel` shape).
 *  - {@link WorkProductCard}: the persisted `type:'work_product'` transcript
 *    anchor rendered inside `ChatMessages` — chat stays the driver surface.
 *  - {@link EvidenceLineageTable}: target → claim → source rows with
 *    click-through via an injected `resolveSourceUrl` (the
 *    `MessageAttachments.resolveFileUrl` pattern).
 *  - {@link ExceptionList} / {@link QualityCheckList}: severity-badged
 *    exception rows and pass/fail check rows.
 *  - {@link ProvenanceStamp}: profileHash prefix + runId + serving-model
 *    chips + the optional backtest slot ("182 cases · composite 0.81 ·
 *    trust PASS" — or "quality: unverified" when the trust gate failed).
 *
 * Anything hosting sandbox-ui (DiffView, CodeView, PillTabs) lives in
 * `./work-product-react` instead — this module must stay importable without
 * the optional sandbox-ui peer.
 */
import { parseReviewQueueItem, type ReviewQueueItem, type ReviewQueueState } from '../work-product/queue';
import type { EvidenceEntry, ExceptionEntry, ProfileBacktestSummary, QualityCheck, WorkProductPersistedPart, WorkProductProvenance, WorkProductStatus } from '../work-product/types';
export { parseReviewQueueItem };
export type { ReviewQueueItem, ReviewQueueState };
/** Human label for a queue state. */
export declare function reviewQueueStateLabel(state: ReviewQueueState): string;
/** Human label for a work-product status. */
export declare function workProductStatusLabel(status: WorkProductStatus): string;
/** Every persisted work-product anchor on one message, re-validated. */
export declare function workProductPartsFromMessageParts(parts: ReadonlyArray<Record<string, unknown>> | null | undefined): WorkProductPersistedPart[];
/** Properties for the transcript anchor card rendered in chat */
export interface WorkProductCardProps {
    part: WorkProductPersistedPart;
    /** Open the work product (queue detail / pane) — the card's only action. */
    onOpen?: (part: WorkProductPersistedPart) => void;
    className?: string;
}
/** The chat transcript anchor card for one work-product version — a compact,
 *  system-authored pointer, not a parallel review surface. */
export declare function WorkProductCard({ part, onOpen, className }: WorkProductCardProps): import("react").JSX.Element;
/** One fetched page of queue items with an optional continuation cursor */
export interface ReviewQueuePage {
    items: ReviewQueueItem[];
    /** Opaque continuation token; absent ⇒ no further pages. */
    nextCursor?: string;
}
/** Properties for the review queue panel over a fetch data port */
export interface ReviewQueuePanelProps {
    /** Data port — fetch one page of queue items (the projection's output,
     *  re-validated here at the JSON boundary). */
    fetchQueue: (cursor?: string) => Promise<ReviewQueuePage>;
    /** Open one queue item (navigate to its thread / detail pane). */
    onSelect?: (item: ReviewQueueItem) => void;
    title?: string;
    emptyLabel?: string;
    className?: string;
}
/** Merge a fetched page into held rows: dedupe by scopeKey, incoming wins,
 *  newest updatedAt first. Exported for tests. */
export declare function mergeReviewQueuePages(existing: ReviewQueueItem[], incoming: ReviewQueueItem[]): ReviewQueueItem[];
/** The workspace review queue — cursor-paged, refreshable, selection via
 *  callback. States, counts, and provenance render from the projection; the
 *  panel holds no domain logic. */
export declare function ReviewQueuePanel({ fetchQueue, onSelect, title, emptyLabel, className, }: ReviewQueuePanelProps): import("react").JSX.Element;
/** Properties for the evidence lineage table with source click-through */
export interface EvidenceLineageTableProps {
    evidence: readonly EvidenceEntry[];
    /** Resolve one entry's source document to an openable URL (signed
     *  object-store/vault download) — the `resolveFileUrl` pattern. Absent →
     *  sources render as plain refs without links. */
    resolveSourceUrl?: (entry: EvidenceEntry) => string;
    className?: string;
}
/** Target → claim → source lineage rows: the "every material value traceable
 *  to source evidence" surface. Each row names the artifact target, the
 *  claim, and the source document location supporting it. */
export declare function EvidenceLineageTable({ evidence, resolveSourceUrl, className }: EvidenceLineageTableProps): import("react").JSX.Element;
/** Properties for the severity-badged exception list */
export interface ExceptionListProps {
    exceptions: readonly ExceptionEntry[];
    className?: string;
}
/** Severity-badged exception rows with resolution state. */
export declare function ExceptionList({ exceptions, className }: ExceptionListProps): import("react").JSX.Element;
/** Properties for the pass/fail quality check list */
export interface QualityCheckListProps {
    checks: readonly QualityCheck[];
    className?: string;
}
/** Pass/fail quality-check rows tagged with their source (agent self-report,
 *  platform gate, judge ensemble). */
export declare function QualityCheckList({ checks, className }: QualityCheckListProps): import("react").JSX.Element;
/** Properties for the provenance stamp with the optional backtest slot */
export interface ProvenanceStampProps {
    provenance: Pick<WorkProductProvenance, 'profileHash' | 'runId' | 'servingModels'> & Partial<Pick<WorkProductProvenance, 'costUsd' | 'producedAt'>>;
    /** The product-resolved backtest summary for this profile hash. When its
     *  trust gate failed, the composite renders as "quality: unverified" —
     *  never a naked number. */
    backtest?: ProfileBacktestSummary;
    className?: string;
}
/** The audit line a reviewer approves against: which configuration produced
 *  this document, what served it, and how that configuration measured on its
 *  backtest. */
export declare function ProvenanceStamp({ provenance, backtest, className }: ProvenanceStampProps): import("react").JSX.Element;
