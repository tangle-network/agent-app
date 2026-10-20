import type { SandboxInstance } from '@tangle-network/sandbox'
import {
  type AgentProfileMcpServer,
  type AgentProfile,
  type ReasoningEffort,
  mergeAgentProfiles,
} from '@tangle-network/agent-interface'
import { type Harness, DEFAULT_HARNESS, isHarness, assertHarnessModelCompatible } from '../harness/index'
import type { SandboxRuntimeConfig } from './configuration'
import type { StreamSandboxPromptOptions } from './prompt-options'
import { trimOrNull } from '../runtime/model'
import { requireTransportableModel, resolveModelSelection, backendModelFields } from './model'
import { splitDeferredProfileFiles } from './profile-files'
import { assertProfilePromptWithinBudget } from '../profile/budget'
import { SHELL_PROMPT_BUDGET_HINT } from './payload-limits'
import { fingerprintAgentProfile } from '../profile/fingerprint'

// The SDK's SandboxInstance.streamPrompt/.prompt accept `string | PromptInputPart[]`
// but the published package does not re-export the PromptInputPart type by name from
// any of its entry points, so it's derived structurally off the method signature
// itself — this stays in lockstep with the SDK's actual accepted shape.
/** Extract a single element type from the array parameter of SandboxInstance's streamPrompt method */
export type PromptInputPart = Extract<
  Parameters<SandboxInstance['streamPrompt']>[0],
  readonly unknown[]
>[number]

function historyTranscript(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  return history
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content}`)
    .join('\n\n')
}

/** Build a single string combining conversation history and the current user message */
export function flattenHistory(
  message: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history?.length) return message
  return `${historyTranscript(history)}\n\nUser: ${message}`
}

/**
 * History-aware equivalent of flattenHistory for multimodal prompt parts: the
 * transcript is folded into the first text part (image/file parts carry no
 * text to prepend to) rather than replacing the message wholesale.
 */
export function mergeHistoryIntoParts(
  parts: PromptInputPart[],
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): PromptInputPart[] {
  if (!history?.length) return parts
  const textIndex = parts.findIndex((part) => part.type === 'text')
  if (textIndex === -1) {
    throw new Error('mergeHistoryIntoParts requires at least one text part to carry the history')
  }
  const textPart = parts[textIndex] as Extract<PromptInputPart, { type: 'text' }>
  const merged = [...parts]
  merged[textIndex] = { ...textPart, text: `${historyTranscript(history)}\n\nUser: ${textPart.text}` }
  return merged
}

/** Resolve conflicts and merge extra MCP profiles into the app tool MCP without overwriting existing keys */
export function mergeExtraMcp(
  appToolMcp: Record<string, AgentProfileMcpServer>,
  baseProfileMcp: Record<string, AgentProfileMcpServer>,
  extra: Record<string, AgentProfileMcpServer> | undefined,
): Record<string, AgentProfileMcpServer> {
  for (const key of Object.keys(extra ?? {})) {
    if (key in appToolMcp || key in baseProfileMcp) {
      throw new Error(`extraMcp key '${key}' collides with an existing profile MCP server`)
    }
  }
  return { ...appToolMcp, ...(extra ?? {}) }
}

/** Attach explicit effort through the portable model contract consumed by providers. */
export function attachReasoningEffort(
  profile: AgentProfile,
  _harness: Harness,
  effort: 'auto' | ReasoningEffort | undefined,
): AgentProfile {
  if (!effort || effort === 'auto') return profile
  return {
    ...profile,
    model: {
      ...profile.model,
      reasoningEffort: effort,
    },
  }
}

export interface SandboxPromptTokenLimits {
  maxVisibleOutputTokens?: number
  maxReasoningTokens?: number
  maxTotalOutputTokens?: number
}

function positiveSafeInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

function lowerCeiling(current: number | undefined, requested: number | undefined): number | undefined {
  if (current === undefined) return requested
  if (requested === undefined) return current
  return Math.min(current, requested)
}

/** Tighten the profile's provider-enforced token ceilings for one prompt. */
export function applyPromptTokenLimits(
  profile: AgentProfile,
  limits: SandboxPromptTokenLimits,
): AgentProfile {
  const requestedVisible = positiveSafeInteger(
    limits.maxVisibleOutputTokens,
    'maxVisibleOutputTokens',
  )
  const requestedReasoning = positiveSafeInteger(
    limits.maxReasoningTokens,
    'maxReasoningTokens',
  )
  const requestedTotal = positiveSafeInteger(
    limits.maxTotalOutputTokens,
    'maxTotalOutputTokens',
  )
  if (
    requestedVisible === undefined
    && requestedReasoning === undefined
    && requestedTotal === undefined
  ) return profile

  const maxTotalOutputTokens = lowerCeiling(
    profile.model?.maxTotalOutputTokens,
    requestedTotal,
  )
  let maxVisibleOutputTokens = lowerCeiling(
    profile.model?.maxVisibleOutputTokens,
    requestedVisible,
  )
  let maxReasoningTokens = lowerCeiling(
    profile.model?.maxReasoningTokens,
    requestedReasoning,
  )
  if (maxTotalOutputTokens !== undefined) {
    if (maxVisibleOutputTokens !== undefined) {
      maxVisibleOutputTokens = Math.min(maxVisibleOutputTokens, maxTotalOutputTokens)
    }
    if (maxReasoningTokens !== undefined) {
      maxReasoningTokens = Math.min(maxReasoningTokens, maxTotalOutputTokens)
    }
  }

  return {
    ...profile,
    model: {
      ...(profile.model ?? {}),
      ...(maxVisibleOutputTokens !== undefined ? { maxVisibleOutputTokens } : {}),
      ...(maxReasoningTokens !== undefined ? { maxReasoningTokens } : {}),
      ...(maxTotalOutputTokens !== undefined ? { maxTotalOutputTokens } : {}),
    },
  }
}

/** Configuration needed to prepare a turn without provisioning a workspace. */
export type SandboxPromptConfig = Pick<SandboxRuntimeConfig, 'provider' | 'deferProfileFiles' | 'promptBudget'>
  & Partial<Pick<SandboxRuntimeConfig, 'profile'>>

/** Prepare one effective backend for SDK dispatch or product-specific transport.
 * Supply a server-owned profile, or a shell composer for the default profile.
 * Reuse the returned backend for preflight and dispatch so they inspect identical configuration.
 */
export async function resolveSandboxPromptBackend(
  shell: SandboxPromptConfig,
  options: StreamSandboxPromptOptions,
  operation = 'sandbox prompt',
) {
  const initialHarness = options.harness ?? options.profile?.harness ?? DEFAULT_HARNESS
  if (!isHarness(initialHarness)) throw new Error(`Unsupported sandbox harness: ${initialHarness}`)
  const extraMcp = mergeExtraMcp(
    options.appToolMcp ?? {},
    options.profile?.mcp ?? options.baseProfileMcp ?? {},
    options.extraMcp,
  )
  const compose = (harness: Harness) => {
    if (!shell.profile) throw new Error(`${operation}: supply a profile or a shell profile composer`)
    return shell.profile({ systemPrompt: options.systemPrompt, extraMcp, harness })
  }
  let fullProfile = options.profile
    ? mergeAgentProfiles(options.profile, {
        ...(options.systemPrompt !== undefined ? { prompt: { systemPrompt: options.systemPrompt } } : {}),
        ...(Object.keys(extraMcp).length > 0 ? { mcp: extraMcp } : {}),
      })!
    : compose(initialHarness)
  const harness = options.harness ?? fullProfile.harness ?? DEFAULT_HARNESS
  if (!isHarness(harness)) throw new Error(`Unsupported sandbox harness: ${harness}`)
  // Older composers may place harness-native files. Recompose if their authored
  // preference differs from the default used to discover that preference.
  if (!options.profile && harness !== initialHarness) fullProfile = compose(harness)

  const explicitModel = trimOrNull(options.model)
  const profileModel = trimOrNull(fullProfile.model?.default)
  const profileProvider = profileModel && (!explicitModel || explicitModel === profileModel)
    ? trimOrNull(fullProfile.model?.provider)
    : null
  const model = requireTransportableModel(
    resolveModelSelection({
      ...shell.provider,
      providerName: trimOrNull(shell.provider?.providerName) ?? profileProvider ?? undefined,
    }, {
      model: explicitModel ?? profileModel ?? undefined,
      modelApiKey: options.modelApiKey,
    }),
    operation,
  )
  // Profile provider evidence belongs only to its own selected model; the
  // transport provider may instead identify a router serving that vendor.
  if (model) assertHarnessModelCompatible(harness, {
    ...model,
    provider: profileProvider ?? model.provider,
  })

  const selectedProfile: AgentProfile = {
    ...fullProfile,
    harness,
    // The materializer compares the profile and transport as provider-qualified
    // identities. Authored provider evidence has already served preflight above.
    ...(model ? { model: { ...fullProfile.model, provider: model.provider, default: model.model } } : {}),
  }
  // The deferred writer owns shell-composed files only. Supplied profiles
  // must retain their resources for the SDK to materialize this turn.
  const executionProfile = shell.deferProfileFiles && !options.profile
    ? splitDeferredProfileFiles(selectedProfile).leanProfile
    : selectedProfile
  const profile = applyPromptTokenLimits(
    attachReasoningEffort(executionProfile, harness, options.effort),
    {
      maxVisibleOutputTokens: options.maxOutputTokens,
      maxReasoningTokens: options.maxReasoningTokens,
      maxTotalOutputTokens: options.maxTotalOutputTokens,
    },
  )
  assertProfilePromptWithinBudget(
    profile, shell.promptBudget ?? {}, `${operation} profile systemPrompt`, SHELL_PROMPT_BUDGET_HINT,
  )
  if (options.onProfileResolved) {
    options.onProfileResolved(await fingerprintAgentProfile(profile, { model: model?.model, harness }))
  }
  return {
    type: harness,
    profile,
    ...(model ? backendModelFields(model) : {}),
    ...(options.runtimeAttachments ? { runtimeAttachments: options.runtimeAttachments } : {}),
    ...(options.runtimeSecrets ? { runtimeSecrets: options.runtimeSecrets } : {}),
    ...(options.secretProfileIsolation ? { metadata: { profileSecretIsolation: true as const } } : {}),
    ...(options.interactions ? { interactions: options.interactions } : {}),
  }
}
