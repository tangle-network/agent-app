/**
 * The structured agent→app tool side channel, domain-seamed.
 *
 * Every Tangle agent product needs the same thing: a way for the in-sandbox
 * agent to reach the host app with a STRUCTURED, validated tool call (not a
 * fenced `:::` block scraped from prose). Four canonical tools cover it:
 *
 *   - `submit_proposal`   — route a regulated/state-changing action to a human
 *                           approval queue (the human-in-the-loop gate).
 *   - `schedule_followup` — register a dated cadence step (executes immediately).
 *   - `render_ui`         — persist a generated view as an artifact (immediate).
 *   - `add_citation`      — anchor a grounding reference (immediate).
 *
 * The shapes, validation, OpenAI tool definitions, MCP-server wiring, HTTP
 * route handling, and runtime-loop executor are GENERIC and live here. The
 * persistence (which DB, which tables) and the product's proposal taxonomy are
 * the DOMAIN SEAM: each product supplies {@link AppToolHandlers} +
 * {@link AppToolTaxonomy}. This package imports no product code and no agent
 * runtime — it depends only on the Web `Request`/`Response` types.
 */

/** Server-set, trusted per-turn context. Recovered from request headers (HTTP
 *  path) or supplied directly (runtime path) — never from model tool args, so
 *  the model cannot forge identity or target another workspace. */
export interface AppToolContext {
  userId: string
  workspaceId: string
  threadId: string | null
}

/** The product's proposal taxonomy — the only domain-specific vocabulary the
 *  generic layer needs (to validate `submit_proposal.type` and label the
 *  regulated subset). */
export interface AppToolTaxonomy {
  /** Every accepted proposal type. */
  proposalTypes: readonly string[]
  /** The subset that cannot execute without a named certified human (regulated
   *  steps). Used only to label the tool result; enforcement is the product's
   *  approval executor. */
  regulatedTypes: readonly string[]
}

export interface SubmitProposalArgs {
  type: string
  title: string
  description?: string | null
  /** Stamped by dispatch from the approval policy (needsApproval predicate or
   *  taxonomy.regulatedTypes). Handlers MUST queue (never auto-execute) when
   *  true. Products don't set this; dispatch owns it — fail-closed. */
  regulated?: boolean
}
export interface SubmitProposalResult {
  proposalId: string
  /** True when an identical (workspace, title) proposal already existed. */
  deduped: boolean
  /** Handlers that execute a proposal type immediately (an unregulated
   *  generate-style action) return 'executed'; omitted/'queued_for_approval'
   *  means a human gate. Dispatch reports this verbatim to the model. */
  status?: 'queued_for_approval' | 'executed'
  /** Product-specific result fields (e.g. datasetId) — passed through to the
   *  tool outcome so the model and UI see what the handler actually did. */
  [extra: string]: unknown
}

export interface ScheduleFollowupArgs {
  title: string
  dueDate: string
  priority?: string
}
export interface ScheduleFollowupResult {
  id: string
  dueDate: string
  deduped: boolean
}

export interface RenderUiArgs {
  title: string
  schema: unknown
}
export interface RenderUiResult {
  /** The persisted artifact path. */
  path: string
  /** The exact persisted body — surfaced as the `artifact` produced event so a
   *  consumer's completion oracle sees the real content. */
  content: string
}

export interface AddCitationArgs {
  path: string
  quote: string
  label?: string
}
export interface AddCitationResult {
  citationId: string
  path: string
}

/**
 * The domain seam. Each product implements these against its own D1/KV/vault.
 * A handler MAY throw {@link ToolInputError} for correctable bad input (mapped
 * to a 4xx / failed tool_result); any other throw is an internal error.
 * `submitProposal` is the only handler whose result feeds the approval queue;
 * the others execute immediately.
 */
export interface AppToolHandlers {
  submitProposal(args: SubmitProposalArgs, ctx: AppToolContext): Promise<SubmitProposalResult>
  scheduleFollowup(args: ScheduleFollowupArgs, ctx: AppToolContext): Promise<ScheduleFollowupResult>
  renderUi(args: RenderUiArgs, ctx: AppToolContext): Promise<RenderUiResult>
  addCitation(args: AddCitationArgs, ctx: AppToolContext): Promise<AddCitationResult>
}

/** Produced-state events the runtime executor emits at the real side-effect
 *  site, so a consumer's eval/completion oracle credits a persisted proposal or
 *  artifact. Deliberately substrate-free (no RuntimeStreamEvent import); the
 *  consumer maps these onto its own telemetry shape. */
export type AppToolProducedEvent =
  | { type: 'proposal_created'; proposalId: string; title: string; status: 'pending' | 'executed' }
  | { type: 'artifact'; path: string; content: string }

/** Outcome of one tool dispatch — structurally identical to the agent-runtime
 *  tool-loop's `ToolCallOutcome`, so a dispatched outcome folds straight into
 *  the loop's `role: 'tool'` result message. Defined here (not imported) to keep
 *  the `tools/` module substrate-free: it depends only on Web `Request`/
 *  `Response`, never on the agent runtime. */
export type AppToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string; status?: number }
