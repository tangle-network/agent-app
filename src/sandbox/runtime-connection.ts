import type { SandboxConnection, SandboxInstance } from '@tangle-network/sandbox'
import { Sandbox } from '@tangle-network/sandbox/core'
import { type SandboxExistingBoxStage, SandboxRuntimeAuthRefreshError } from './lifecycle-errors'
import { type Outcome, ok, fail } from './outcome'
import { isRuntimeAuthRefreshDenied, isRuntimeExecAuthError } from './exec-failure'
import type { AgentProfileFileMount } from '@tangle-network/agent-interface'
import { writeProfileFilesToBox } from './profile-files'

const RUNTIME_AUTH_REFRESH_SKEW_MS = 60_000

const RUNTIME_CONNECTION_WAIT_MS = 30_000

const RUNTIME_CONNECTION_POLL_MS = 1_000

// `sidecarUrl` is a product/forward-compat field the orchestrator may set on
// the connection ahead of the SDK declaring it — the v0.6 `SandboxConnection`
// exposes only `runtimeUrl`. Read it through a typed augmentation rather than an
// ad-hoc cast (a plain `SandboxConnection` satisfies the optional field), and
// fall back to the SDK runtime URL. The product-facing `WorkspaceSandboxInstanceLike`
// carries the same field for consumers driving their own box types.
type RuntimeConnectionFields = SandboxConnection & {
  sidecarUrl?: string
  authToken?: string
  sidecarToken?: string
  authTokenExpiresAt?: string | number | Date
  sidecarTokenExpiresAt?: string | number | Date
}

export function sandboxRuntimeUrl(box: SandboxInstance): string | undefined {
  const connection: RuntimeConnectionFields | undefined = box.connection
  return connection?.sidecarUrl ?? connection?.runtimeUrl
}

function runtimeAuthExpiresAtMs(value: string | number | Date | undefined): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function hasFreshRuntimeExecAuth(box: SandboxInstance, now = Date.now()): boolean {
  const connection: RuntimeConnectionFields | undefined = box.connection
  const token = connection?.authToken ?? connection?.sidecarToken
  if (!sandboxRuntimeUrl(box) || !token) return false
  const expiresAt = runtimeAuthExpiresAtMs(
    connection?.authTokenExpiresAt ?? connection?.sidecarTokenExpiresAt,
  )
  return expiresAt === undefined || expiresAt > now + RUNTIME_AUTH_REFRESH_SKEW_MS
}

export function sandboxEdgeFailed(box: SandboxInstance): boolean {
  // `edgeStatus`/`edgeError` are declared on the SDK's `SandboxConnection`, so no cast.
  const connection = box.connection
  return connection?.edgeStatus === 'failed' || Boolean(connection?.edgeError)
}

export async function refreshRuntimeConnection(
  client: Sandbox,
  box: SandboxInstance,
): Promise<SandboxInstance> {
  let current = box
  if (sandboxRuntimeUrl(current)) return current

  const deadline = Date.now() + RUNTIME_CONNECTION_WAIT_MS
  while (Date.now() < deadline) {
    // Tolerate transient refresh/get failures (5xx, network blips) while the
    // orchestrator is still attaching the connection: swallow and retry. A box
    // that never surfaces a runtime URL is returned as-is so the caller's
    // readiness gate (isReusableBox) sends it into state-preserving recovery
    // (or fails loud) — rather than this poll throwing a hard provisioning
    // failure on a recoverable hiccup.
    try {
      await current.refresh()
      if (sandboxRuntimeUrl(current)) return current

      const latest = await client.get(current.id)
      if (latest) current = latest
      if (sandboxRuntimeUrl(current)) return current
    } catch {
      // transient — fall through to the poll delay and retry
    }

    await new Promise((resolve) => setTimeout(resolve, RUNTIME_CONNECTION_POLL_MS))
  }

  return current
}

async function bestEffortRefreshRuntimeExecAuth(
  client: Sandbox,
  box: SandboxInstance,
  stage: SandboxExistingBoxStage,
  name: string,
): Promise<Outcome<SandboxInstance>> {
  let current = box

  try {
    await current.refresh()
    if (hasFreshRuntimeExecAuth(current)) return ok(current)
  } catch (err) {
    if (isRuntimeAuthRefreshDenied(err)) {
      return fail(
        new SandboxRuntimeAuthRefreshError(
          stage,
          name,
          'runtime exec auth refresh was unauthorized',
          err,
        ),
      )
    }
  }

  try {
    const latest = await client.get(current.id)
    if (latest) current = latest
    if (hasFreshRuntimeExecAuth(current)) return ok(current)
  } catch (err) {
    if (isRuntimeAuthRefreshDenied(err)) {
      return fail(
        new SandboxRuntimeAuthRefreshError(
          stage,
          name,
          'runtime exec auth re-fetch was unauthorized',
          err,
        ),
      )
    }
  }

  return ok(current)
}

async function refreshRuntimeExecAuth(
  client: Sandbox,
  box: SandboxInstance,
  stage: SandboxExistingBoxStage,
  name: string,
): Promise<Outcome<SandboxInstance>> {
  let current = box
  let lastError: unknown
  const deadline = Date.now() + RUNTIME_CONNECTION_WAIT_MS

  while (Date.now() < deadline) {
    try {
      await current.refresh()
      if (hasFreshRuntimeExecAuth(current)) return ok(current)

      const latest = await client.get(current.id)
      if (latest) current = latest
      if (hasFreshRuntimeExecAuth(current)) return ok(current)
    } catch (err) {
      lastError = err
    }

    await new Promise((resolve) => setTimeout(resolve, RUNTIME_CONNECTION_POLL_MS))
  }

  const detail = sandboxRuntimeUrl(current)
    ? 'runtime exec credentials are missing or expired after refresh'
    : 'runtime connection is missing after refresh'
  return fail(new SandboxRuntimeAuthRefreshError(stage, name, detail, lastError))
}

export async function writeDeferredFilesWithRuntimeAuthRefresh(
  client: Sandbox,
  box: SandboxInstance,
  files: AgentProfileFileMount[],
  stage: SandboxExistingBoxStage,
  name: string,
): Promise<Outcome<SandboxInstance>> {
  let writeBox = box

  if (!hasFreshRuntimeExecAuth(writeBox)) {
    const refreshed = await bestEffortRefreshRuntimeExecAuth(client, writeBox, stage, name)
    if (!refreshed.succeeded) return fail(refreshed.error)
    writeBox = refreshed.value
  }

  const first = await writeProfileFilesToBox(writeBox, files)
  if (first.succeeded) return ok(writeBox)
  if (!isRuntimeExecAuthError(first.error)) return fail(first.error)

  const refreshed = await refreshRuntimeExecAuth(client, writeBox, stage, name)
  if (!refreshed.succeeded) return fail(refreshed.error)

  const second = await writeProfileFilesToBox(refreshed.value, files)
  if (second.succeeded) return ok(refreshed.value)
  if (!isRuntimeExecAuthError(second.error)) return fail(second.error)

  return fail(
    new SandboxRuntimeAuthRefreshError(
      stage,
      name,
      'runtime exec remained unauthorized after auth refresh',
      second.error,
    ),
  )
}
