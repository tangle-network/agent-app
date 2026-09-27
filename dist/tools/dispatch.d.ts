import { type AppToolDefinition } from './registry';
import type { AppToolContext, AppToolHandlers, AppToolOutcome, AppToolProducedEvent, AppToolTaxonomy } from './types';
/** Define options for dispatching tools including handlers, taxonomy, custom tools, and approval policies */
export interface DispatchOptions {
    handlers: AppToolHandlers;
    taxonomy: AppToolTaxonomy;
    /** Product-registered tools beyond the four built-ins. A called name that is
     *  not a built-in is dispatched to the matching {@link AppToolDefinition.execute}
     *  through this same validation/outcome path. */
    customTools?: readonly AppToolDefinition[];
    /** Per-call approval policy. When provided it OVERRIDES the static
     *  `taxonomy.regulatedTypes` membership check, so products can gate by
     *  cost threshold, environment, or first-use instead of always/never.
     *  Fail-closed: a predicate that throws counts as "approval required". */
    needsApproval?: (type: string, args: {
        title: string;
        description: string | null;
    }, ctx: AppToolContext) => boolean | Promise<boolean>;
    /** Called at the real side-effect site for proposals (proposal_created) and
     *  generated views (artifact) so a consumer's completion oracle credits
     *  persisted state. Omit when produced state isn't tracked. */
    onProduced?: (event: AppToolProducedEvent) => void;
}
/**
 * The ONE place an app-tool call is validated, dispatched to the product's
 * handler, and turned into an {@link AppToolOutcome} + produced events. Shared
 * by the HTTP route layer and the agent-runtime executor so both paths apply
 * identical validation and identical side effects. A {@link ToolInputError}
 * (bad input the agent can correct) and any other throw both become
 * `{ ok: false }` — a tool call never silently "succeeds" without its effect.
 */
export declare function dispatchAppTool(toolName: string, rawArgs: Record<string, unknown>, ctx: AppToolContext, opts: DispatchOptions): Promise<AppToolOutcome>;
/** HTTP status for a failed outcome — the handler's `ToolInputError.status`
 *  when present, else 400 for a validation reject. */
export declare function outcomeStatus(outcome: Extract<AppToolOutcome, {
    ok: false;
}>): number;
