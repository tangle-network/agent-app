

import { DISPATCH_REQUEST_MAX_BYTES } from '../chat-routes/wire'

// ---------------------------------------------------------------------------
// Provision-time S-cost gates. Both run immediately before `client.create` —
// each catches an input class that can NEVER produce a working sandbox, so
// failing at POST-time with actionable detail beats a platform 4xx (or a box
// that boots and then E2BIGs on every exec).

/** Appended to a prompt-budget throw from any of this module's three choke
 *  points. A product that already raised the cap at compose time
 *  (`composeAgentProfile(base, channels, overlay, { maxSystemPromptBytes })` —
 *  gtm-agent uses 50_000) has to declare the SAME decision on the shell, or the
 *  shell's default reads as a contradiction instead of a missing declaration. */
export const SHELL_PROMPT_BUDGET_HINT =
  'If this prompt size is a decision you already made at compose time, mirror it on the shell as ' +
  '`promptBudget: { maxSystemPromptBytes, overBudgetReason }` — the shell gate is the one that sees the profile actually sent.'

/** Gate on the provision body: the platform orchestrator caps the create
 *  payload at 256 KiB; 240 KB leaves headroom for transport framing. An
 *  over-cap payload fails provisioning 100% of the time (a 282 KB payload
 *  shipped once and no sandbox could ever be created). */
export const PROVISION_PAYLOAD_MAX_BYTES = 240_000

/** Per-variable env gate: the kernel rejects any single `NAME=value` env entry
 *  over MAX_ARG_STRLEN (131072 bytes) with E2BIG, killing every exec inside
 *  the box. 120 KB leaves headroom for the name and framing. */
export const ENV_VALUE_MAX_BYTES = 120_000

/** Default wait for a box to reach `running`. Overridable per shell via
 *  {@link SandboxRuntimeConfig.provisionTimeoutMs}. */
export const DEFAULT_PROVISION_TIMEOUT_MS = 120_000

/** Total env gate: the whole environment block shares the payload budget with
 *  the profile; past 200 KB the provision body cannot stay under the cap. */
export const ENV_TOTAL_MAX_BYTES = 200_000

function utf8ByteLength(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value ?? null))
    .byteLength
}

/** Structural slice of the profile the payload gate reads: it only measures
 *  the profile's serialized size and names `resources.files` in the breakdown,
 *  so callers composing a payload outside the SDK (products, tests) can pass a
 *  plain object without casting through `AgentProfile`. */
export interface ProvisionProfileSection {
  resources?: { files?: readonly unknown[] }
}

/** The provision-payload sections the size gates need to see. Structural so
 *  the gate is testable without the SDK's (unexported) create-payload type. */
export interface ProvisionPayloadSections {
  env?: Record<string, string>
  /** Secret names, or Sandbox 0.63 host-scoped `SecretBinding` objects; the gate only measures bytes. */
  secrets?: readonly unknown[] | 'all'
  /** `profile` may also be a named-profile string ref (the SDK's
   *  `BackendConfig` union) — a string ref is tiny and has no files channel. */
  backend?: { profile?: string | ProvisionProfileSection }
}

/**
 * Throw when the serialized provision payload exceeds
 * {@link PROVISION_PAYLOAD_MAX_BYTES}. The error carries a per-section byte
 * breakdown (profile/files/env/secrets) so the offending channel is named, not
 * guessed.
 */
export function assertProvisionPayloadWithinCap(payload: ProvisionPayloadSections): void {
  const total = utf8ByteLength(payload)
  if (total <= PROVISION_PAYLOAD_MAX_BYTES) return
  const profile = payload.backend?.profile
  const files = (typeof profile === 'string' ? undefined : profile?.resources?.files) ?? []
  const breakdown =
    `profile=${utf8ByteLength(profile ?? null)}B ` +
    `(files=${utf8ByteLength(files)}B), ` +
    `env=${utf8ByteLength(payload.env ?? {})}B, ` +
    `secrets=${utf8ByteLength(payload.secrets ?? [])}B`
  throw new Error(
    `sandbox provision payload is ${total} bytes — over the ${PROVISION_PAYLOAD_MAX_BYTES}-byte gate ` +
      `(the platform caps the create body at 256 KiB; an over-cap payload can never create a sandbox). ` +
      `Breakdown: ${breakdown}. ` +
      `Hint: set deferProfileFiles: true or move content to resources.`,
  )
}

/**
 * Throw when any single env value exceeds {@link ENV_VALUE_MAX_BYTES} or the
 * whole env block exceeds {@link ENV_TOTAL_MAX_BYTES}, naming the offending
 * variable. This is the E2BIG incident class: the box may even provision, but
 * every exec inside it dies on the oversized entry.
 */
export function assertEnvWithinLimits(env: Record<string, string>): void {
  let total = 0
  let largest: { name: string; bytes: number } | null = null
  for (const [name, value] of Object.entries(env)) {
    const bytes = utf8ByteLength(`${name}=${value}`)
    total += bytes
    if (!largest || bytes > largest.bytes) largest = { name, bytes }
    if (bytes > ENV_VALUE_MAX_BYTES) {
      throw new Error(
        `sandbox env var ${name} is ${bytes} bytes — over the ${ENV_VALUE_MAX_BYTES}-byte gate ` +
          `(kernel MAX_ARG_STRLEN is 131072 bytes per env entry; anything larger E2BIGs every exec). ` +
          `Write large content to a file mount or resource instead of an env var.`,
      )
    }
  }
  if (total > ENV_TOTAL_MAX_BYTES) {
    const worst = largest ? ` Largest: ${largest.name} (${largest.bytes}B).` : ''
    throw new Error(
      `sandbox env block is ${total} bytes total — over the ${ENV_TOTAL_MAX_BYTES}-byte gate.${worst} ` +
        `Write large content to a file mount or resource instead of env vars.`,
    )
  }
}

/**
 * Throw when a dispatch into a secret-isolated session cannot fit the sandbox gateway's
 * {@link DISPATCH_REQUEST_MAX_BYTES} request cap. An isolated dispatch carries its whole profile inline, every file
 * mount's content included, to the profile preparation and to the run; a shared session's file mounts are written
 * to the box separately, so a shared dispatch is not measured here. The measure (prompt plus backend) is a lower
 * bound of what the SDK sends, so a refusal is never a request that could have passed. The error names the
 * largest mounts.
 *
 * GTM, 2026-10-24: one 342 KB program mounted under five names made a 2,065,490-byte isolated profile, and every
 * computer child failed at the gateway with a cause only `console.error` saw.
 */
export function assertIsolatedDispatchWithinCap(input: {
  prompt: unknown
  /** The profile sent inline, and the isolation mark `resolveSandboxPromptBackend` sets from `secretProfileIsolation`. */
  backend: {
    profile?: string | { resources?: { files?: ReadonlyArray<{ path?: unknown }> } }
    metadata?: { profileSecretIsolation?: unknown }
  }
  /** A prepared secret revision's receipt; the SDK then sends the full profile too. */
  expectedSecretProfileReceipt?: string
}): void {
  const isolated = input.backend.metadata?.profileSecretIsolation === true || Boolean(input.expectedSecretProfileReceipt)
  if (!isolated) return
  const total = utf8ByteLength({ parts: input.prompt, backend: input.backend })
  if (total <= DISPATCH_REQUEST_MAX_BYTES) return
  const profile = input.backend.profile
  const files = (typeof profile === 'string' ? undefined : profile?.resources?.files) ?? []
  const largest = files
    .map(file => ({ path: typeof file.path === 'string' ? file.path : '(unnamed)', bytes: utf8ByteLength(file) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .map(file => `${file.path}=${file.bytes}B`)
  throw new Error(
    `The isolated computer dispatch is ${total} bytes, over the sandbox gateway's ${DISPATCH_REQUEST_MAX_BYTES}-byte ` +
      `request cap, so it was not sent. An isolated session sends every file mount inline. ` +
      `prompt=${utf8ByteLength(input.prompt)}B, profile files=${utf8ByteLength(files)}B` +
      (largest.length ? `; largest: ${largest.join(', ')}` : '') + '. ' +
      'Mount one program under several names with `aliasOf` in buildSandboxToolFileMounts, or move large content ' +
      'out of the isolated profile.',
  )
}
