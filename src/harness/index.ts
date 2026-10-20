/**
 * Coding-agent harness selection, model compatibility, and the session lock.
 *
 * Known identities are not a deployment's available runners. Products supply
 * server-owned availability to resolveSessionHarness. Historical session IDs
 * remain intact when their runner is unavailable; a harness change requires an
 * explicit transfer, not a fallback or a rewritten session lock.
 *
 * Model compatibility is owned by @tangle-network/agent-interface. The shell
 * owns session selection; the consumer owns storage and deployment policy.
 */

import {
  harnessProviders,
  harnessSupportsModel,
  harnessTypeSchema,
  modelProvider,
  preferredHarnessForModel,
  snapHarnessToModel as aiSnapHarnessToModel,
  snapModelToHarness as aiSnapModelToHarness,
  type HarnessType,
} from '@tangle-network/agent-interface'
import {
  selectSessionHarness,
  type HarnessAvailability as SelectionAvailability,
  type SessionHarnessSelection,
  type SessionHarnessSelectionInput,
} from './session-selection'

export { HarnessSelectionError } from './session-selection'

/** Canonical identities that have no direct Sandbox backend. */
const NON_BACKEND_HARNESSES = ['gemini'] as const satisfies readonly HarnessType[]
const nonBackendHarnesses = new Set<string>(NON_BACKEND_HARNESSES)

/** A recognized coding-agent backend, not a promise that it is installed. */
export type Harness = Exclude<HarnessType, (typeof NON_BACKEND_HARNESSES)[number]>

/**
 * Recognized backend identities, including IDs needed by historical sessions.
 * Use deployment availability, not membership here, to offer or admit new runs.
 */
export const KNOWN_HARNESSES: readonly Harness[] = [
  ...harnessTypeSchema.options.filter(
    (harness): harness is Exclude<HarnessType, (typeof NON_BACKEND_HARNESSES)[number]> =>
      !nonBackendHarnesses.has(harness),
  ),
]

/** Default for an absent choice; never a replacement for an invalid explicit ID. */
export const DEFAULT_HARNESS: Harness = 'opencode'
const HARNESS_SET: ReadonlySet<string> = new Set(KNOWN_HARNESSES)

/** Determine whether a value is a recognized identity, independently of availability. */
export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_SET.has(value)
}

/** Display/config convenience only. Never use coercion to admit an execution or restore a lock. */
export function coerceHarness(value: unknown, fallback: Harness = DEFAULT_HARNESS): Harness {
  return isHarness(value) ? value : fallback
}

/** Server-owned start and resume sets. Existing-only entries are draining. */
export type HarnessAvailability = SelectionAvailability<Harness>

/** A saved lock, explicit choice, workspace default, and optional deployment availability. */
export type ResolveSessionHarnessInput = SessionHarnessSelectionInput<Harness>

/** The selected identity and the existing session-lock/swap-attempt result. */
export type ResolvedSessionHarness = SessionHarnessSelection<Harness>

/**
 * Resolve requested → workspaceDefault → fallback only for a genuinely new session.
 * A non-null saved identity always takes the lock path. Unknown/retired identities
 * and invalid explicit requests throw HarnessSelectionError instead of falling back.
 * A known different request still reports swapAttempted while preserving the lock.
 * The caller must reject that attempt before execution, as in the existing contract.
 */
export function resolveSessionHarness(input: ResolveSessionHarnessInput = {}): ResolvedSessionHarness {
  return selectSessionHarness(input, KNOWN_HARNESSES, DEFAULT_HARNESS)
}

/**
 * An app's harness configuration, read from its deploy configuration (for example the env vars
 * `AGENT_HARNESS` and `AGENT_HARNESS_WORKSPACES`), so no product hard-codes `backend.type`.
 */
export interface HarnessConfig {
  /** The app default for new sessions. Unset or blank means {@link DEFAULT_HARNESS}. */
  default?: string
  /** Per-workspace choices: a JSON object mapping a workspace id to a harness. */
  workspaces?: string
}

function configHarness(value: unknown, where: string): Harness {
  if (!isHarness(value)) throw new Error(`${where} names an unknown harness: ${String(value)}`)
  return value
}

/**
 * The harness a workspace's new sessions start on: its own choice, else the app default, else
 * {@link DEFAULT_HARNESS}. Pass the result to {@link resolveSessionHarness} as `workspaceDefault`
 * so a session that already ran keeps its harness. A value naming an unknown harness throws:
 * a configuration typo must fail loudly, never run a different harness than the one configured.
 */
export function configuredHarness(config: HarnessConfig, workspaceId?: string): Harness {
  const appDefault = config.default?.trim()
    ? configHarness(config.default.trim(), 'The harness default') : DEFAULT_HARNESS
  const raw = config.workspaces?.trim()
  if (!raw) return appDefault
  let choices: unknown
  try {
    choices = JSON.parse(raw)
  } catch {
    throw new Error('The per-workspace harness configuration is not JSON')
  }
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) {
    throw new Error('The per-workspace harness configuration must map workspace ids to harnesses')
  }
  // Every entry is checked, not only the caller's, so one bad entry fails every workspace's
  // first turn after the deploy instead of hiding until that workspace sends a message.
  const parsed = new Map(Object.entries(choices).map(([id, value]) =>
    [id, configHarness(value, `The harness for workspace ${id}`)]))
  return (workspaceId === undefined ? undefined : parsed.get(workspaceId)) ?? appDefault
}

/** Harness-model compatibility is delegated to the Interface owner. */
export { modelProvider }

/** A resolved model and the transport provider that will execute it. */
export interface HarnessModelSelection {
  model: string
  provider?: string
}

/** Provider-less ids (sentinels like "default", or a session's own config) are
 *  compatible everywhere — every harness honors its own configuration. */
export function isModelCompatibleWithHarness(harness: Harness, modelId: string): boolean {
  return harnessSupportsModel(harness, modelId)
}

/** Keep `modelId` when the harness can run it; else the harness's best compatible
 *  catalog id (preferred patterns in order, highest version). When nothing in the
 *  catalog fits, return the original so the caller sees the incompatibility. */
export function snapModelToHarness(harness: Harness, modelId: string, canonicalIds: readonly string[]): string {
  return aiSnapModelToHarness(harness, modelId, canonicalIds)
}

/** Keep the harness when it can run `modelId`; else the model's native harness
 *  (anthropic → claude-code, openai → codex, moonshot → kimi-code), falling back to opencode. */
export function snapHarnessToModel(harness: Harness, modelId: string): Harness {
  const snapped = aiSnapHarnessToModel(harness, modelId)
  if (!isHarness(snapped)) {
    throw new Error(
      `Harness "${harness}" snapped to "${snapped}" for model "${modelId}", which this platform has no backend for.`,
    )
  }
  return snapped
}

/** Fail-loud server guard: throw when a harness is asked to run a model it can't.
 *  A resolved model tuple supplies provider evidence when its id is unqualified.
 *  Call before dispatching a sandbox turn so a bypassed UI cannot reach the
 *  sidecar with an incompatible or unproven pair. */
export function assertHarnessModelCompatible(
  harness: Harness,
  selection: string | HarnessModelSelection,
): void {
  const modelId = typeof selection === 'string' ? selection : selection.model
  const transportProvider = typeof selection === 'string' ? undefined : selection.provider
  const providers = harnessProviders(harness)
  const provider = modelProvider(modelId) ?? transportProvider ?? null
  // An omitted/default model is deliberately left to the harness. Once a
  // caller names a model, however, a vendor-locked harness must have provider
  // evidence. Interface owns which harnesses are locked: since 5.7 Claude Code
  // and Codex run any Router-served model, and kimi-code stays Moonshot-only.
  const isDefaultSentinel = modelId.trim() === '' || modelId.trim() === 'default'
  const compatible = isDefaultSentinel
    || providers === null
    || (provider !== null && providers.includes(provider))
  if (!compatible) {
    const native = preferredHarnessForModel(modelId)
    const providerDescription = provider ?? 'unqualified'
    throw new Error(
      `Harness "${harness}" cannot run model "${modelId}" (provider "${providerDescription}"). ` +
        `Use ${native ?? 'a router-backed harness (opencode)'} or an allowed model.`,
    )
  }
}

// Profile-support facts remain here until the materializer supplies its owned descriptor.
// Do not confuse these facts with deployment availability.

/** What a harness can express, for profile assembly. */
export interface HarnessCapabilities {
  /** Lower profile.subagents into native cwd files; false means materialization refuses them. */
  subagents: boolean
  /** How profile.mcp reaches the harness. */
  mcp: 'native' | 'config-file' | 'extension' | 'none'
  /** Whether tool controls are checked before MCP tools register. */
  toolControls: 'startup' | 'runtime'
  /** cwd-relative skill directory, or null when skills must be inlined. */
  skillsDir: string | null
}

const HARNESS_CAPABILITIES: Record<Harness, HarnessCapabilities> = {
  'claude-code': { subagents: true, mcp: 'native', toolControls: 'runtime', skillsDir: '.claude/skills' },
  nanoclaw: { subagents: true, mcp: 'native', toolControls: 'runtime', skillsDir: '.claude/skills' },
  opencode: { subagents: true, mcp: 'config-file', toolControls: 'runtime', skillsDir: '.opencode/skills' },
  codex: { subagents: true, mcp: 'config-file', toolControls: 'runtime', skillsDir: '.codex/skills' },
  'kimi-code': { subagents: false, mcp: 'config-file', toolControls: 'runtime', skillsDir: '.kimi/skills' },
  pi: { subagents: false, mcp: 'extension', toolControls: 'startup', skillsDir: '.pi/skills' },
  prime: { subagents: true, mcp: 'native', toolControls: 'runtime', skillsDir: '.prime/agent/skills' },
  hermes: { subagents: false, mcp: 'native', toolControls: 'runtime', skillsDir: null },
  openclaw: { subagents: false, mcp: 'config-file', toolControls: 'runtime', skillsDir: 'skills' },
  acp: { subagents: false, mcp: 'native', toolControls: 'runtime', skillsDir: null },
  amp: { subagents: false, mcp: 'native', toolControls: 'runtime', skillsDir: null },
  'factory-droids': { subagents: false, mcp: 'native', toolControls: 'runtime', skillsDir: null },
  forge: { subagents: false, mcp: 'native', toolControls: 'runtime', skillsDir: null },
  cursor: { subagents: false, mcp: 'native', toolControls: 'runtime', skillsDir: null },
  'cli-base': { subagents: false, mcp: 'native', toolControls: 'runtime', skillsDir: null },
}

/** Profile-support facts, independent of whether this deployment enables the harness. */
export function harnessCapabilities(harness: Harness): HarnessCapabilities {
  const caps = HARNESS_CAPABILITIES[harness]
  if (!caps) throw new Error(`harnessCapabilities: no capability facts for "${harness}"`)
  return caps
}

// ── Session presets ────────────────────────────────────────────────────────
//
// Named (model, harness, effort) pins applied with catalog coherence through
// the snap helpers above. The contract is semantics; the visual surface stays
// with the picker canon.
export {
  applySessionPreset,
  createInMemorySessionPresetStore,
  validateSessionPreset,
  type AppliedSessionPreset,
  type SessionPreset,
  type SessionPresetCatalogContext,
  type SessionPresetStore,
} from './presets'
