/**
 * agent.config.ts — the DATA surface of this chat product.
 *
 * This is the ONE file (plus `prompts/system.md`) you fill to define who the
 * agent is and how its turns execute. It is plain data consumed by
 * `@tangle-network/agent-app`'s modules through typed seams — NOT behavior.
 * Control flow lives in `src/` (the assembled chat vertical). See CUSTOMIZE.md
 * for the ordered fill-checklist and AGENTS.md for the layering contract.
 *
 * Every field below is stubbed with a placeholder. Replace the placeholders;
 * keep the shape. `pnpm typecheck` proves the shape; `pnpm test` proves the
 * wiring end to end (fake sandbox producer → turn → persisted transcript).
 */

import type { Harness } from '@tangle-network/agent-app/harness'
// Imported as a Text module: wrangler's `[[rules]]` and the vitest plugin in
// `vitest.config.ts` both load `.md` files as strings (see declarations.d.ts).
import systemPrompt from './prompts/system.md'

export const config = {
  /** Product/agent name — cookie prefix, sandbox box names, email subjects. */
  name: '__PROJECT_NAME__',

  /**
   * The system prompt, verbatim from `prompts/system.md`. State intents and
   * hard rules, never implementations — the executing agent chooses its own
   * tools at execution time (see AGENTS.md "prompts state intents").
   */
  systemPrompt,

  model: {
    /**
     * Model used when the client doesn't pick one and the `MODEL_NAME` env
     * var is unset. Any model your Tangle Router key can reach.
     */
    default: 'REPLACE_WITH_MODEL',
    /** Default reasoning effort for turns that don't specify one. */
    effort: 'auto',
  },

  /**
   * The agent harness the sandbox runs (`opencode`, `claude-code`, `codex`,
   * …). Vendor-locked harnesses reject foreign-provider models — the sandbox
   * lane enforces that pairing server-side.
   */
  harness: 'opencode',

  /**
   * Which sidecar ask kinds this app renders as cards. Anything the agent
   * asks outside this set is auto-declined so a turn never hangs waiting on
   * a card no client will show.
   */
  interactions: { question: true, plan: true },
} as const satisfies {
  name: string
  systemPrompt: string
  model: { default: string; effort: 'auto' | 'low' | 'medium' | 'high' }
  harness: Harness
  interactions: { question?: boolean; permission?: boolean; plan?: boolean }
}

export type Config = typeof config
