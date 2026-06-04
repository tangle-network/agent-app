/**
 * src/agent-app.ts — the COMPOSER. Code, not data.
 *
 * Turns the declarative `agent.config.ts` + your Cloudflare bindings into the
 * wired runtime surfaces:
 *   - tool handlers (the agent→app side channel) over the house D1 + KV preset,
 *   - the proposal taxonomy (from config.taxonomy — including the regulated set),
 *   - the knowledge gate accessor (scores config.knowledge.requirements from D1),
 *   - the resolved model config.
 *
 * This is the seam between DATA (config) and ENGINE (agent-app modules). You do
 * NOT edit `@tangle-network/agent-app` to change behavior; you edit this file to
 * compose its seams differently, or override a single handler. Default to the
 * preset — drop down to a custom handler only when the house stack genuinely
 * cannot express your persistence. See AGENTS.md "DATA vs CODE".
 */

import { config } from '../agent.config'
import {
  createPresetToolHandlers,
  createD1KnowledgeStateAccessor,
  type D1Like,
  type VaultKv,
} from '@tangle-network/agent-app/preset-cloudflare'
import { resolveTangleModelConfig } from '@tangle-network/agent-app/runtime'
import {
  buildKnowledgeRequirements,
  deriveSignals,
} from '@tangle-network/agent-app/knowledge'
import type { AppToolHandlers, AppToolTaxonomy } from '@tangle-network/agent-app/tools'

/** The Cloudflare bindings the worker hands the composer. */
export interface AppBindings {
  /** D1 database — satisfies the preset's structural {@link D1Like}. */
  DB: D1Like
  /** KV namespace used as the artifact vault — satisfies {@link VaultKv}. */
  VAULT: VaultKv
}

export interface ComposedAgentApp {
  handlers: AppToolHandlers
  taxonomy: AppToolTaxonomy
  /** Score the config's knowledge requirements against live workspace state. */
  knowledgeGate: (workspaceId: string) => Promise<ReturnType<typeof buildKnowledgeRequirements>>
  /** Resolve the model config from env. Lazy + fail-loud: composing the app does
   *  NOT require model env; only the chat path that actually streams does. */
  resolveModel: () => ReturnType<typeof resolveTangleModelConfig>
}

/**
 * Compose the agent app from config + bindings. No domain value is hard-coded:
 * the taxonomy comes from `config.taxonomy`, the gate from
 * `config.knowledge.requirements`. Swap a handler here if (and only if) the
 * preset cannot express your persistence.
 */
export function createAgentApp(bindings: AppBindings): ComposedAgentApp {
  const handlers = createPresetToolHandlers({ db: bindings.DB, vault: bindings.VAULT })

  const taxonomy: AppToolTaxonomy = {
    proposalTypes: config.taxonomy.proposalTypes,
    regulatedTypes: config.taxonomy.regulatedTypes,
  }

  async function knowledgeGate(workspaceId: string) {
    const accessor = createD1KnowledgeStateAccessor({
      db: bindings.DB,
      workspaceId,
      // Resolve workspace config however your app stores it; stub returns nothing
      // until you wire real workspace config (see CUSTOMIZE.md ③).
      config: () => undefined,
    })
    const signals = await deriveSignals(config.knowledge.requirements, accessor)
    return buildKnowledgeRequirements(config.knowledge.requirements, signals)
  }

  return { handlers, taxonomy, knowledgeGate, resolveModel: () => resolveTangleModelConfig() }
}
