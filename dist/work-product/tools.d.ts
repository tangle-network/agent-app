/**
 * The agent-facing work-product side channel — three registry `customTools`
 * built on `/tools`' `defineAppTool`, dispatched through `dispatchAppTool`'s
 * single validation/outcome path (a thrown `ToolInputError` → correctable 4xx
 * back to the model; any other throw → internal error; a call never silently
 * succeeds without its effect). Deliberately NOT new `/tools` built-ins:
 * extending `AppToolHandlers` would break every existing consumer, and the
 * registry seam exists precisely for a product tool family like this.
 *
 * Partial-emission contract across a long turn: the draft ROW is the
 * accumulator. Evidence and exceptions stream in as found via small batched
 * calls; the artifact arrives once at the end. The agent addresses everything
 * by `scopeKey` — the server mints row ids, the model never invents them, and
 * identity (userId/workspaceId/threadId) rides the trusted `AppToolContext`
 * from headers, never model args. A turn that dies mid-emission leaves a
 * consistent draft the next turn resumes by the same scopeKey.
 */
import { type AppToolDefinition } from '../tools/registry';
import type { AppToolContext } from '../tools/types';
import { type WorkProductProvenanceBase } from './provenance';
import { type ConfusableTargetGroup } from './claim-support';
import { type WorkProductArtifact, type WorkProductRecord, type WorkProductStorePort } from './types';
/** Max entries per `upsert_evidence`/`flag_exception` call — keeps each call a
 *  small batch the model can correct precisely on a named-index failure. */
export declare const MAX_WORK_PRODUCT_BATCH = 50;
/** Platform check: every material target has ≥1 evidence row. Recorded as
 *  `QualityCheck{source:'platform'}`. */
export declare const EVIDENCE_COVERAGE_CHECK = "evidence_coverage";
/** Platform check: how many evidence entries carry a quote the shell PROVED
 *  occurs in the source it names. Recorded when `readSourceText` is wired, so
 *  a reviewer reads the strength of the lineage off the row itself rather than
 *  trusting that a quote was checked. */
export declare const QUOTE_VERIFICATION_CHECK = "quote_verification";
/** Numeric-only platform check, omitted when no entries are checkable.
 *  Reports how many quoted evidence entries anchor to text that
 *  actually CARRIES the figure the entry claims. Distinct from
 *  `quote_verification`, which only proves the text came from the document —
 *  production row `7256ef49` passed that one on all four entries while
 *  supporting none of them. */
export declare const CLAIM_SUPPORT_CHECK = "claim_support";
/** Platform check: how many citations anchor to a line that belongs to the
 *  TARGET they are attached to, rather than to a sibling target's line.
 *  Recorded when the product declares `confusableTargets`; `claim_support`
 *  passes a crossed pair by construction, because the figure really is on the
 *  line — the wrong one. */
export declare const TARGET_CORRECTNESS_CHECK = "target_correctness";
/** Platform check: how many evidence claims agree with the artifact field they
 *  decorate. A package whose evidence reports one figure on a line and whose
 *  artifact reports another contradicts itself; every other gate on this row
 *  reads only one of the two halves. */
export declare const ARTIFACT_AGREEMENT_CHECK = "artifact_agreement";
/** Domain seams for the three work-product tools — every domain word is a
 *  parameter; the shell bakes none. */
export interface WorkProductToolConfig {
    store: WorkProductStorePort;
    /** PARAMETER — accepted `artifact.kind` values, validated on submit. */
    artifactKinds: readonly string[];
    /** PARAMETER — accepted exception `kind` values. */
    exceptionKinds: readonly string[];
    /** Fail-loud source check: resolve an evidence `sourceRef` to existence
     *  (vault stat / attachment lookup). A dangling ref is a `ToolInputError`
     *  naming the entry index — lineage can never point at nothing. */
    resolveSourceRef: (ref: string, ctx: AppToolContext) => Promise<boolean>;
    /** Fail-loud QUOTE verification: return the source document's TEXT for a
     *  ref so the shell can prove each `locator.quote` occurs in it verbatim.
     *  Wiring this turns the gate ON — a quote that does not occur is a
     *  `ToolInputError` naming the entry index, so the model re-extracts from
     *  the document instead of persisting invented lineage.
     *
     *  Return `null` ONLY when the ref genuinely has no extractable text (an
     *  image scan, an opaque blob). The gate is fail-CLOSED on `null`: a quote
     *  that cannot be checked is refused, because "unverifiable" and "verified"
     *  must never look the same to a reviewer. Such an entry is still recordable
     *  without `locator.quote` — `claim` carries the assertion.
     *
     *  Omit the seam entirely and no quote is checked. */
    readSourceText?: (ref: string, ctx: AppToolContext) => Promise<string | null>;
    /** The material targets the platform coverage check requires evidence for.
     *  Product-owned vocabulary; omit to skip the coverage gate.
     *
     *  Return ONLY targets a source document can actually evidence. A gate that
     *  demands document lineage for a value the session COMPUTED is not
     *  satisfiable by any honest answer, and an unsatisfiable gate does not stop
     *  a submit — it selects for an invented one. Computed values belong to a
     *  product's own computation check, where "matches what we already
     *  calculated" is satisfiable by construction. */
    materialTargets?: (artifact: WorkProductArtifact) => string[];
    /** Require every material target to carry a SOURCE ANCHOR — a span-sliced or
     *  verified quote — not merely an evidence row. Off by default (a bare
     *  `claim` is legitimate lineage for products with no readable sources);
     *  turn it ON once `readSourceText` is wired and `materialTargets` names only
     *  document-derived targets, and coverage stops being satisfiable by
     *  assertion. */
    requireAnchoredEvidence?: boolean;
    /** Verify that each anchored quote CARRIES the figure its entry claims.
     *  ON by default — an anchor that does not support its claim is the one
     *  failure mode every other gate here passes, and it reads to a reviewer as
     *  the most authoritative citation on the row.
     *
     *  Only claims that assert a figure are checked, so a filing status, a name
     *  or a date is unaffected; see `./claim-support` for exactly where the line
     *  is drawn and why it is drawn to stay satisfiable. Set `false` only for a
     *  product whose claims are figures the source states in a form no numeric
     *  comparison can reach. */
    verifyClaimSupport?: boolean;
    /** Fold an evidence `target` (and every `materialTargets` name) to the
     *  product's ONE canonical spelling.
     *
     *  Without it a target namespace forks and every check that joins evidence
     *  to the artifact by name silently half-works. Measured on production row
     *  `95105c8a`: the same seven form lines arrived as `line_3a` and
     *  `f1040.line_3a` in one turn, so coverage, deduplication and artifact
     *  agreement each saw two unrelated targets where the return has one line.
     *
     *  Pure and total — it runs on every ingested entry and on the coverage
     *  target list, so a target it does not recognize must come back unchanged
     *  rather than throw. */
    normalizeTarget?: (target: string) => string;
    /** Targets whose SOURCE LINES are mistakable for each other, with the
     *  phrases that tell them apart — the product's vocabulary, compared by the
     *  shell. Omit and no target-correctness check runs.
     *
     *  Read negatively: an entry is refused only when the line it cites carries
     *  a sibling target's label and none of its own, so an unusually-labelled
     *  document never costs an honest citation. See `./claim-support` for why
     *  the positive form ("the line must say X") is the wrong shape. */
    confusableTargets?: readonly ConfusableTargetGroup[];
    /** Refuse an evidence claim that asserts a figure the artifact reports on a
     *  DIFFERENT target. ON by default and domain-free — it compares the package
     *  to itself. Set `false` only for a product whose evidence claims are not
     *  the artifact's own figures. */
    verifyArtifactAgreement?: boolean;
    /** Per-turn provenance closure the ROUTE supplies (profileHash + runId are
     *  known at dispatch; trusted, never read from model args). */
    provenance: (ctx: AppToolContext) => WorkProductProvenanceBase;
    /** Called on the draft→ready commit so the route persists the transcript
     *  anchor part and the queue projection updates. */
    onReady?: (record: WorkProductRecord, ctx: AppToolContext) => void | Promise<void>;
    /** Injectable clock / id generator (tests, deterministic ids). */
    now?: () => number;
    generateId?: () => string;
}
/** Build the three work-product tools for `customTools` registration on the
 *  MCP server / HTTP handler / runtime executor. */
export declare function buildWorkProductTools(config: WorkProductToolConfig): AppToolDefinition[];
