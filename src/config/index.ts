/**
 * `@tangle-network/agent-app/config` — the typed `AgentAppConfig` contract.
 *
 * This is the single declarative DATA surface a coding agent fills to stand up a
 * new agent product. Everything an agent product otherwise hand-rolls as
 * imperative wiring — who the agent is, which proposal types exist and which are
 * approval-gated, what knowledge the control loop requires, which integrations
 * are connectable, how the model resolves — is expressed here as plain data the
 * rest of agent-app's modules consume through their typed seams:
 *
 *  - `identity`     → the system-prompt + disclaimer surface the chat pipeline reads.
 *  - `taxonomy`     → which `submit_proposal` types the `./tools` side channel
 *                     accepts, and which the approval queue treats as regulated
 *                     (certified-human-gated).
 *  - `knowledge`    → the `./knowledge` requirement specs that gate the loop, plus
 *                     the acquisition-loop goal/threshold the researcher pursues.
 *  - `integrations` → which `@tangle-network/agent-integrations` catalog kinds the
 *                     product enables.
 *  - `ui`           → whether the agent may emit generated UI (`render_ui`).
 *  - `model`        → the `./runtime` `TangleModelConfig` (or null to resolve from env).
 *
 * Layering: this module is the CONTRACT only — pure types + an identity helper.
 * It introduces no behavior and no engine dependency; it REUSES the existing
 * `KnowledgeRequirementSpec`/`SatisfiedByRule` (from `../knowledge`) and
 * `TangleModelConfig` (from `../runtime`) rather than redefining them, so the
 * config a product authors is the exact shape those modules already consume.
 * Steps that build the composer/loader read this file as the schema floor.
 */

import type {
  KnowledgeRequirementSpec,
  SatisfiedByRule,
} from '../knowledge/index'
import type { TangleModelConfig } from '../runtime/index'

// Re-export the borrowed types so a config author has a single import surface
// (`@tangle-network/agent-app/config`) and never has to reach into `../knowledge`
// or `../runtime` to spell out a field's type. These are the SAME types the
// knowledge gate and runtime model resolver consume — not parallel copies.
export type { KnowledgeRequirementSpec, SatisfiedByRule, TangleModelConfig }

/**
 * Who the agent is, as data. Composed into the chat pipeline's system prompt;
 * never baked into agent-app (a domain value, per the layering contract).
 */
export interface AgentIdentityConfig {
  /** Product/agent name, e.g. `"WinFinance Ops Partner"`. Shown to the user and
   *  available to the system-prompt builder. */
  name: string
  /** One-paragraph persona statement — the agent's role, voice, and remit. The
   *  spine of the system prompt. */
  persona: string
  /** Additional system-prompt fragments appended verbatim after the persona
   *  (standing workflows, hard rules, tone). Order is preserved. Optional. */
  systemPromptFragments?: string[]
  /** Named disclaimers the product surfaces (e.g. a regulatory human-in-the-loop
   *  notice). Keyed by a stable id (`compliance`, `not-advice`, …) so the chat
   *  pipeline / UI can select one by name. Values are the literal text. Optional. */
  disclaimers?: Record<string, string>
}

/**
 * The proposal taxonomy, as data. `proposalTypes` is the closed set of
 * `submit_proposal` types the `./tools` side channel accepts; `regulatedTypes`
 * is the subset that is approval-gated — the executor refuses to run one without
 * a certified human approver. `regulatedTypes` MUST be a subset of
 * `proposalTypes` (validated by the loader step; not enforced at the type level).
 */
export interface AgentTaxonomyConfig {
  /** Every proposal type this product can emit, e.g.
   *  `['propose_swap', 'contact_lead', 'policy_change']`. The closed allow-list
   *  the tool layer validates a `submit_proposal` call against. */
  proposalTypes: string[]
  /** The subset of `proposalTypes` that is regulated → cannot execute without a
   *  certified-human approver. The approval executor reads this to decide which
   *  proposals are fail-loud certified-gated. */
  regulatedTypes: string[]
}

/** A knowledge source the acquisition loop / researcher may draw on. */
export interface KnowledgeSourceSpec {
  /** Where the source lives — a URL, a `vault://` path, an integration ref, etc.
   *  Opaque to agent-app; the consumer's loader resolves it. */
  uri: string
  /** Optional source classifier the researcher uses to pick a fetch strategy,
   *  e.g. `'web'`, `'vault'`, `'regulation'`, `'integration'`. Free-form. */
  kind?: string
}

/**
 * The knowledge-acquisition loop config — the goal the researcher pursues and
 * the gate it must clear before the loop is considered satisfied. All optional;
 * a product with only static requirement specs omits it.
 */
export interface KnowledgeLoopConfig {
  /** The acquisition goal in natural language, e.g.
   *  `"ground every quoted premium against a real policy record"`. */
  goal?: string
  /** The minimum aggregate confidence [0, 1] the loop must reach to pass its
   *  gate. The runtime control loop blocks below this. Default decided by the
   *  consumer's loop wiring when omitted. */
  minConfidence?: number
  /** How fresh acquired knowledge must be, e.g. `'static'`, `'7d'`, `'session'`.
   *  Free-form; the consumer's loop interprets it. */
  freshness?: string
}

/**
 * The knowledge surface, as data. `sources` are what the researcher may read;
 * `requirements` are the declarative `./knowledge` specs that gate the control
 * loop (reused verbatim — the same `KnowledgeRequirementSpec` the gate scores);
 * `loop` configures the acquisition pass.
 */
export interface AgentKnowledgeConfig {
  /** Sources the acquisition loop / researcher may draw on. */
  sources: KnowledgeSourceSpec[]
  /** The declarative requirement specs that gate the loop. Reuses
   *  `KnowledgeRequirementSpec` from `../knowledge` — `buildKnowledgeRequirements`
   *  + `deriveSignals` consume these directly. */
  requirements: KnowledgeRequirementSpec[]
  /** Optional acquisition-loop config (goal + confidence gate + freshness). */
  loop?: KnowledgeLoopConfig
}

/**
 * Which integrations the product enables, as data. `enabled` lists
 * `@tangle-network/agent-integrations` catalog kinds the product connects
 * (e.g. `['shurens', 'lead-crm', 'whatsapp']`); the integration hub resolves
 * each to a connector. Strings, not connector objects — agent-app bakes no
 * catalog value.
 */
export interface AgentIntegrationsConfig {
  /** Catalog kinds this product enables. */
  enabled: string[]
}

/** UI capability flags, as data. */
export interface AgentUiConfig {
  /** Whether the agent may emit generated UI (the `render_ui` / OpenUI side
   *  channel). When false/omitted, the tool layer can omit/refuse the tool.
   *  Default behavior decided by the consumer; omit to leave unset. */
  generatedUi?: boolean
}

/**
 * The declarative domain surface of a Tangle agent product.
 *
 * A coding agent fills THIS object and nothing else to define a product's
 * identity, proposal taxonomy, knowledge gate, integrations, UI capability, and
 * model. Every field is DATA consumed by an agent-app module through its typed
 * seam — no field is behavior. Author it through {@link defineAgentApp} for
 * autocomplete and a single import.
 */
export interface AgentAppConfig {
  /** Who the agent is — name, persona, system-prompt fragments, disclaimers. */
  identity: AgentIdentityConfig
  /** Proposal types + which are regulated/approval-gated. */
  taxonomy: AgentTaxonomyConfig
  /** Knowledge sources, requirement specs (the loop gate), and loop config. */
  knowledge: AgentKnowledgeConfig
  /** Enabled integration catalog kinds. */
  integrations: AgentIntegrationsConfig
  /** UI capability flags. Optional. */
  ui?: AgentUiConfig
  /** The resolved model config (`../runtime`'s `TangleModelConfig`). Omit to
   *  resolve from env at boot via `resolveTangleModelConfig`. */
  model?: TangleModelConfig
}

/**
 * Identity helper: returns its argument unchanged, but anchors inference so a
 * coding agent authoring a config gets full autocomplete + type-checking from a
 * single import. The canonical way to declare a product config:
 *
 * ```ts
 * import { defineAgentApp } from '@tangle-network/agent-app/config'
 *
 * export const config = defineAgentApp({
 *   identity: { name: 'WinFinance', persona: '…' },
 *   taxonomy: { proposalTypes: ['propose_swap'], regulatedTypes: ['propose_swap'] },
 *   knowledge: { sources: [], requirements: [] },
 *   integrations: { enabled: ['shurens'] },
 * })
 * ```
 */
export function defineAgentApp<const T extends AgentAppConfig>(config: T): T {
  return config
}

/**
 * Machine-readable JSON Schema (draft 2020-12) for {@link AgentAppConfig}.
 *
 * The schema FLOOR a non-TypeScript coding agent (or a config validator/UI) reads
 * to know the shape without parsing the `.d.ts`. Kept in lockstep with the
 * interfaces above by the config test, which asserts the documented fields are
 * present. `KnowledgeRequirementSpec`'s full sub-shape is intentionally left
 * `additionalProperties: true` here — its authoritative definition lives in
 * `../knowledge`; this floor pins only the fields the config contract owns.
 */
export const agentAppConfigJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://tangle.tools/schemas/agent-app-config.json',
  title: 'AgentAppConfig',
  description: 'The declarative domain surface of a Tangle agent product.',
  type: 'object',
  additionalProperties: false,
  required: ['identity', 'taxonomy', 'knowledge', 'integrations'],
  properties: {
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'persona'],
      properties: {
        name: { type: 'string', description: 'Product/agent name.' },
        persona: { type: 'string', description: 'One-paragraph persona — the system-prompt spine.' },
        systemPromptFragments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Verbatim system-prompt fragments appended after the persona, in order.',
        },
        disclaimers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Named disclaimers keyed by stable id; values are literal text.',
        },
      },
    },
    taxonomy: {
      type: 'object',
      additionalProperties: false,
      required: ['proposalTypes', 'regulatedTypes'],
      properties: {
        proposalTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Closed allow-list of proposal types the product can emit.',
        },
        regulatedTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subset of proposalTypes that is approval-gated (certified-human required).',
        },
      },
    },
    knowledge: {
      type: 'object',
      additionalProperties: false,
      required: ['sources', 'requirements'],
      properties: {
        sources: {
          type: 'array',
          description: 'Sources the acquisition loop may draw on.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['uri'],
            properties: {
              uri: { type: 'string', description: 'Where the source lives (opaque to agent-app).' },
              kind: { type: 'string', description: 'Optional source classifier (web/vault/regulation/…).' },
            },
          },
        },
        requirements: {
          type: 'array',
          description: "Declarative KnowledgeRequirementSpec[] (../knowledge) that gate the loop.",
          items: { type: 'object', additionalProperties: true },
        },
        loop: {
          type: 'object',
          additionalProperties: false,
          description: 'Acquisition-loop config.',
          properties: {
            goal: { type: 'string', description: 'Acquisition goal in natural language.' },
            minConfidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Minimum aggregate confidence the loop must reach.',
            },
            freshness: { type: 'string', description: 'How fresh acquired knowledge must be.' },
          },
        },
      },
    },
    integrations: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: {
        enabled: {
          type: 'array',
          items: { type: 'string' },
          description: 'Enabled agent-integrations catalog kinds.',
        },
      },
    },
    ui: {
      type: 'object',
      additionalProperties: false,
      description: 'UI capability flags.',
      properties: {
        generatedUi: { type: 'boolean', description: 'Whether the agent may emit generated UI.' },
      },
    },
    model: {
      type: 'object',
      additionalProperties: false,
      description: "Resolved TangleModelConfig (../runtime). Omit to resolve from env.",
      required: ['provider', 'model', 'apiKey', 'baseUrl'],
      properties: {
        provider: { type: 'string', enum: ['openai-compat', 'anthropic'] },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
      },
    },
  },
} as const
