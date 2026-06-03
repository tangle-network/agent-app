import { ToolInputError } from './errors'
import { isAppToolName } from './openai'
import type {
  AppToolContext,
  AppToolHandlers,
  AppToolOutcome,
  AppToolProducedEvent,
  AppToolTaxonomy,
} from './types'

export interface DispatchOptions {
  handlers: AppToolHandlers
  taxonomy: AppToolTaxonomy
  /** Called at the real side-effect site for proposals (proposal_created) and
   *  generated views (artifact) so a consumer's completion oracle credits
   *  persisted state. Omit when produced state isn't tracked. */
  onProduced?: (event: AppToolProducedEvent) => void
}

/**
 * The ONE place an app-tool call is validated, dispatched to the product's
 * handler, and turned into an {@link AppToolOutcome} + produced events. Shared
 * by the HTTP route layer and the agent-runtime executor so both paths apply
 * identical validation and identical side effects. A {@link ToolInputError}
 * (bad input the agent can correct) and any other throw both become
 * `{ ok: false }` — a tool call never silently "succeeds" without its effect.
 */
export async function dispatchAppTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  ctx: AppToolContext,
  opts: DispatchOptions,
): Promise<AppToolOutcome> {
  try {
    if (!isAppToolName(toolName)) {
      return { ok: false, code: 'unknown_tool', message: `${toolName} is not an app tool.` }
    }

    if (toolName === 'submit_proposal') {
      const type = String(rawArgs.type ?? '').trim()
      const title = String(rawArgs.title ?? '').trim()
      if (!type || !opts.taxonomy.proposalTypes.includes(type)) {
        return { ok: false, code: 'invalid_type', message: `type must be one of: ${opts.taxonomy.proposalTypes.join(', ')}.` }
      }
      if (!title) return { ok: false, code: 'missing_title', message: 'title is required.' }
      const description = rawArgs.description == null ? null : String(rawArgs.description)
      const r = await opts.handlers.submitProposal({ type, title, description }, ctx)
      const regulated = opts.taxonomy.regulatedTypes.includes(type)
      opts.onProduced?.({ type: 'proposal_created', proposalId: r.proposalId, title, status: 'pending' })
      return { ok: true, result: { status: 'queued_for_approval', proposalId: r.proposalId, deduped: r.deduped, regulated } }
    }

    if (toolName === 'schedule_followup') {
      const r = await opts.handlers.scheduleFollowup(
        { title: String(rawArgs.title ?? ''), dueDate: String(rawArgs.dueDate ?? ''), priority: rawArgs.priority as string | undefined },
        ctx,
      )
      return { ok: true, result: { followupId: r.id, dueDate: r.dueDate, deduped: r.deduped } }
    }

    if (toolName === 'render_ui') {
      const r = await opts.handlers.renderUi({ title: String(rawArgs.title ?? ''), schema: rawArgs.schema }, ctx)
      opts.onProduced?.({ type: 'artifact', path: r.path, content: r.content })
      return { ok: true, result: { path: r.path } }
    }

    // add_citation
    const r = await opts.handlers.addCitation(
      { path: String(rawArgs.path ?? ''), quote: String(rawArgs.quote ?? ''), label: rawArgs.label as string | undefined },
      ctx,
    )
    return { ok: true, result: { citationId: r.citationId, path: r.path } }
  } catch (err) {
    if (err instanceof ToolInputError) return { ok: false, code: err.code, message: err.message, status: err.status }
    return { ok: false, code: 'app_tool_error', message: err instanceof Error ? err.message : String(err), status: 500 }
  }
}

/** HTTP status for a failed outcome — the handler's `ToolInputError.status`
 *  when present, else 400 for a validation reject. */
export function outcomeStatus(outcome: Extract<AppToolOutcome, { ok: false }>): number {
  return outcome.status ?? 400
}
