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
    /**
     * Models to try, in order, when the chosen model's upstream is DEAD
     * (quota wall, 502, provider outage). Failover is reactive — zero cost
     * until the preferred model actually fails — and every fallback is
     * surfaced: the persisted row and billing receipt name the model that
     * actually served, and the transcript gets a visible notice. Keep this
     * list cross-provider (an outage usually takes a whole provider down)
     * and review it with your default: a stale ladder degrades to today's
     * behavior (the turn fails), never to a silent wrong-model answer.
     */
    fallbacks: ['gemini-3.7-flash', 'glm-5.3'],
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

  /** API-key access to this workspace agent. The browser and API share one
   *  thread store and one sandbox turn path. */
  gateway: {
    enabled: true,
    description: '__PROJECT_NAME__ workspace agent',
    pricePerTokenUsd: 0.00002,
    platformFeePercent: 0.20,
    /** Maximum provider input for the configured model. Include retained
     *  sidecar history and tool output that is absent from the transcript. */
    maxProviderInputTokens: 1_000_000,
    defaultOutputTokens: 1024,
    maxOutputTokens: 4096,
  },
} as const satisfies {
  name: string
  systemPrompt: string
  model: { default: string; fallbacks: readonly string[]; effort: 'auto' | 'low' | 'medium' | 'high' }
  harness: Harness
  interactions: { question?: boolean; permission?: boolean; plan?: boolean }
  gateway: {
    enabled: boolean
    description: string
    pricePerTokenUsd: number
    platformFeePercent: number
    maxProviderInputTokens: number
    defaultOutputTokens: number
    maxOutputTokens: number
  }
}

export type Config = typeof config
