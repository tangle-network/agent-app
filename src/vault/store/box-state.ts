/**
 * What the workspace Vault coordinator knows about its box's copy of the Vault.
 *
 * Every chat turn used to re-prove that the box holds the Vault: read the
 * baseline, list every head, diff, commit the baseline again, and `test -f`
 * the bootstrap marker. On an unchanged Vault that was about 2 s of GTM's warm
 * path (sandbox.vault.hydration p50 1211 ms, n=943; loss probe 387 ms, n=954;
 * bootstrap 332 ms, n=952; 2026-10-09..11). This record lets a turn skip that
 * work when nothing it would act on has changed.
 *
 * The workspace DO is the only writer of Vault heads (`/vault/mutate`), so it
 * can count them. `generation` moves after every mutation that did not come
 * from the synced box's own reconcile, and `inFlight` is set while one is being
 * applied. A complete hydration records `sync` with the generation it read
 * before it listed the heads; a later turn trusts it only while the generation
 * is the same, no mutation is in flight, and the box is the same sandbox and
 * filesystem incarnation. Anything else, including a failed read of this
 * record, takes the full hydration path.
 *
 * Each record also names the contract it was written under: a sync names the
 * hydration contract, and a bootstrap record names the marker it confirmed. A
 * turn trusts a record only under its own contract, so a release that changes
 * what hydration writes, or bumps the bootstrap marker, reaches every box on
 * its next turn instead of waiting for the box to be recreated.
 */

export const VAULT_BOX_STATE_KEY = 'vaultBoxState'
export const VAULT_BOX_STATE_SCHEMA = 'vault-box-state-v1'

/** A mutation in flight longer than this cannot still be running: its request
 *  died with the object. Reading the state then moves the generation, so the
 *  next hydration records against a value no partial write predates. */
export const VAULT_BOX_MUTATION_STALE_MS = 10 * 60_000

/** A Vault file that hydration left off the box for its size; the agent reads it through the Vault API. */
export interface VaultBoxSyncSkip {
  path: string
  reason: 'too_large'
  detail: string
}

/** A hydration that left more files off the box than this records no sync. */
export const VAULT_BOX_SYNC_MAX_SKIPS = 50

/** The box and filesystem whose Vault copy a complete hydration proved current. */
export interface VaultBoxSync {
  sandboxId: string
  filesystemIncarnationId: string
  /** The hydration contract the copy was written under (the sync engine's `contract`). */
  contract: string
  /** The generation read before that hydration listed the heads. */
  generation: number
  /** What that hydration left off the box, so a turn that skips hydration still tells the agent. */
  skipped: VaultBoxSyncSkip[]
  syncedAt: string
}

/** The box and filesystem whose product bootstrap marker was confirmed. */
export interface SandboxBootstrapRecord {
  sandboxId: string
  filesystemIncarnationId: string
  /** The bootstrap marker the box confirmed. */
  marker: string
  at: string
}

export interface StoredVaultBoxState {
  schema: typeof VAULT_BOX_STATE_SCHEMA
  generation: number
  inFlight: { operationId: string; startedAt: number } | null
  sync: VaultBoxSync | null
  bootstrap: SandboxBootstrapRecord | null
}

/** What a turn reads. */
export interface VaultBoxStateView {
  generation: number
  inFlight: boolean
  sync: VaultBoxSync | null
  bootstrap: SandboxBootstrapRecord | null
}

export interface VaultBoxIdentity {
  sandboxId: string
  filesystemIncarnationId: string
}

/** What a complete hydration asks the coordinator to record. */
export interface VaultBoxSyncRecord extends VaultBoxIdentity {
  contract: string
  generation: number
  skipped: readonly VaultBoxSyncSkip[]
}

/** What a confirmed bootstrap asks the coordinator to record. */
export interface SandboxBootstrapConfirmation extends VaultBoxIdentity {
  marker: string
}

export function emptyVaultBoxState(): StoredVaultBoxState {
  return { schema: VAULT_BOX_STATE_SCHEMA, generation: 0, inFlight: null, sync: null, bootstrap: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseIdentityRecord(value: unknown): VaultBoxIdentity | null {
  if (!isRecord(value)) return null
  if (typeof value.sandboxId !== 'string' || !value.sandboxId) return null
  if (typeof value.filesystemIncarnationId !== 'string' || !value.filesystemIncarnationId) return null
  return { sandboxId: value.sandboxId, filesystemIncarnationId: value.filesystemIncarnationId }
}

/**
 * The stored state, or a fresh one. A value that does not parse starts over at
 * a generation above anything it could have held, so no sync recorded against
 * the unreadable value can match.
 */
export function parseVaultBoxState(value: unknown): StoredVaultBoxState {
  if (value === undefined || value === null) return emptyVaultBoxState()
  if (!isRecord(value) || value.schema !== VAULT_BOX_STATE_SCHEMA
    || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    return { ...emptyVaultBoxState(), generation: Date.now() }
  }
  const inFlight = isRecord(value.inFlight)
    && typeof value.inFlight.operationId === 'string'
    && typeof value.inFlight.startedAt === 'number'
    ? { operationId: value.inFlight.operationId, startedAt: value.inFlight.startedAt }
    : null
  const sync = parseSync(value.sync)
  const bootstrap = parseBootstrap(value.bootstrap)
  return { schema: VAULT_BOX_STATE_SCHEMA, generation: value.generation, inFlight, sync, bootstrap }
}

/**
 * Whether a mutation leaves the synced box's copy current without moving the
 * generation: only the reconcile of that same box writes what the box already
 * holds. Every other writer (the app, a tool, another box) moves it.
 */
export function isSyncedBoxWriter(
  state: StoredVaultBoxState,
  writer: { kind?: unknown; id?: unknown } | undefined,
): boolean {
  return writer?.kind === 'sandbox'
    && typeof writer.id === 'string'
    && state.sync !== null
    && writer.id === state.sync.sandboxId
}

export function withMutationStarted(state: StoredVaultBoxState, operationId: string, now: number): StoredVaultBoxState {
  return { ...state, inFlight: { operationId, startedAt: now } }
}

/** Runs whether the mutation applied, conflicted or threw: any of them may have reached KV. */
export function withMutationFinished(state: StoredVaultBoxState): StoredVaultBoxState {
  return { ...state, generation: state.generation + 1, inFlight: null }
}

/** A reconcile that left the box and the Vault apart. The generation moves too, so a
 *  hydration that started before it cannot record a sync after it. */
export function withSyncInvalidated(state: StoredVaultBoxState): StoredVaultBoxState {
  return { ...state, generation: state.generation + 1, sync: null }
}

export function withSync(state: StoredVaultBoxState, sync: VaultBoxSync): StoredVaultBoxState {
  return { ...state, sync }
}

export function withBootstrap(state: StoredVaultBoxState, bootstrap: SandboxBootstrapRecord): StoredVaultBoxState {
  return { ...state, bootstrap }
}

/** Clears an in-flight marker whose request cannot still be running, moving the generation. */
export function healStaleMutation(state: StoredVaultBoxState, now: number): StoredVaultBoxState | null {
  if (!state.inFlight || now - state.inFlight.startedAt < VAULT_BOX_MUTATION_STALE_MS) return null
  return withMutationFinished(state)
}

export function viewOfVaultBoxState(state: StoredVaultBoxState): VaultBoxStateView {
  return { generation: state.generation, inFlight: state.inFlight !== null, sync: state.sync, bootstrap: state.bootstrap }
}

/** Parses a view returned by the coordinator; anything else is unknown (null). */
export function parseVaultBoxStateView(value: unknown): VaultBoxStateView | null {
  if (!isRecord(value) || typeof value.generation !== 'number' || typeof value.inFlight !== 'boolean') return null
  const sync = parseSync(value.sync)
  const bootstrap = parseBootstrap(value.bootstrap)
  return { generation: value.generation, inFlight: value.inFlight, sync, bootstrap }
}

/** The skips a sync may carry, or null when the value is not a bounded list of them. */
export function parseVaultBoxSyncSkips(value: unknown): VaultBoxSyncSkip[] | null {
  if (!Array.isArray(value) || value.length > VAULT_BOX_SYNC_MAX_SKIPS) return null
  const skips: VaultBoxSyncSkip[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !entry.path
      || entry.reason !== 'too_large' || typeof entry.detail !== 'string') return null
    skips.push({ path: entry.path, reason: 'too_large', detail: entry.detail.slice(0, 500) })
  }
  return skips
}

/** A record without its contract predates contracts and is never trusted. */
function parseSync(value: unknown): VaultBoxSync | null {
  const identity = parseIdentityRecord(value)
  if (!identity || !isRecord(value) || typeof value.contract !== 'string' || !value.contract
    || typeof value.generation !== 'number' || typeof value.syncedAt !== 'string') return null
  const skipped = parseVaultBoxSyncSkips(value.skipped ?? [])
  return skipped
    ? { ...identity, contract: value.contract, generation: value.generation, skipped, syncedAt: value.syncedAt }
    : null
}

function parseBootstrap(value: unknown): SandboxBootstrapRecord | null {
  const identity = parseIdentityRecord(value)
  if (!identity || !isRecord(value) || typeof value.marker !== 'string' || !value.marker || typeof value.at !== 'string') return null
  return { ...identity, marker: value.marker, at: value.at }
}

function sameBox(record: VaultBoxIdentity | null, box: VaultBoxIdentity): boolean {
  return record !== null
    && record.sandboxId === box.sandboxId
    && record.filesystemIncarnationId === box.filesystemIncarnationId
}

/** Whether a complete hydration of this exact box, under this contract, saw the Vault as it is now. */
export function vaultBoxInSync(view: VaultBoxStateView | null, box: VaultBoxIdentity, contract: string): boolean {
  return view !== null
    && !view.inFlight
    && view.sync !== null
    && view.sync.contract === contract
    && view.sync.generation === view.generation
    && sameBox(view.sync, box)
}

/** Whether this exact box's filesystem already holds the product bootstrap this marker names. */
export function sandboxBootstrapRecorded(view: VaultBoxStateView | null, box: VaultBoxIdentity, marker: string): boolean {
  return view !== null && view.bootstrap !== null && view.bootstrap.marker === marker && sameBox(view.bootstrap, box)
}
