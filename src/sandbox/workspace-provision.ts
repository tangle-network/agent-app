import { Sandbox } from '@tangle-network/sandbox/core'
import {
  type StoppedSandboxResumeFailure,
  type StoppedSandboxResumeRecovery,
  type SandboxRuntimeConfig,
  type MissingSandboxFailure,
  type EnsureWorkspaceSandboxOptions,
  type SandboxRestoreSpec,
  DEFAULT_SANDBOX_RESOURCES,
  type SandboxBuildContext,
} from './configuration'
import { type Outcome, ok } from './outcome'
import { SandboxRecoveryFailedError } from './lifecycle-errors'
import { serializeSandboxProvisioningError, isSandboxApiSandboxMissingFailure } from './diagnostics'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { resolveWorkspaceSandboxClient, getRunningBox, listRunning, listStopped, deleteBox } from './workspace-boxes'
import {
  DEFAULT_PROVISION_TIMEOUT_MS,
  assertEnvWithinLimits,
  SHELL_PROMPT_BUDGET_HINT,
  assertProvisionPayloadWithinCap,
} from './payload-limits'
import { runningBoxIds, forgetBox, trustedBoxes, rememberRunningBox } from './runtime-cache'
import { resolveWorkspaceRuntimeEnv, prefetchExistingBoxReads, finalizeExistingBox } from './existing-box'
import { refreshRuntimeConnection } from './runtime-connection'
import { isReusableBox, recoverUnresponsiveBox, resumeStoppedBox } from './box-health'
import { splitDeferredProfileFiles, writeProfileFilesToBox } from './profile-files'
import type { AgentProfileFileMount } from '@tangle-network/agent-interface'
import { requireTransportableModel, resolveModelSelection, backendModelFields } from './model'
import { DEFERRED_CORPUS_HASH_KEY, deferredCorpusHash, deferredProfileWriteFailed } from './profile-corpus'
import { assertProfilePromptWithinBudget } from '../profile/budget'

// The SDK narrows `backend.type` to its own BackendType union and
// `initialUsers[].role` to PermissionLevel — neither symbol is exported. The
// create payload is assembled with the product's Harness/role strings, which
// are a superset surface; the localized cast at the boundary is the only place
// this widening is allowed, and the runtime contract (the sidecar boots the
// named harness) is what enforces correctness.
type CreatePayload = Parameters<Sandbox['create']>[0]

async function requestSandboxReplacement<TFailure extends StoppedSandboxResumeFailure>(
  recover: ((failure: TFailure) => Promise<Outcome<StoppedSandboxResumeRecovery | null>>) | undefined,
  failure: TFailure,
  label: string,
): Promise<StoppedSandboxResumeRecovery> {
  if (!recover) throw failure.error
  const recovery = await recover(failure)
  if (!recovery.succeeded) throw recovery.error
  if (!recovery.value) throw failure.error

  const replacementBoxKey = recovery.value.replacementBoxKey.trim()
  if (!replacementBoxKey || replacementBoxKey === failure.boxKey) {
    throw new Error(
      `${label} must return a fresh replacement box key for ${failure.boxKey}`,
      { cause: failure.error },
    )
  }
  return { ...recovery.value, replacementBoxKey }
}

async function requestMissingSandboxReplacement(
  shell: SandboxRuntimeConfig,
  failure: MissingSandboxFailure,
): Promise<StoppedSandboxResumeRecovery> {
  // Probe causes diagnose failed liveness; they do not authorize replacement.
  if (failure.error instanceof SandboxRecoveryFailedError && failure.error.phase === 'probe') {
    throw failure.error
  }
  const diagnostics = serializeSandboxProvisioningError(failure.error)
  if (!isSandboxApiSandboxMissingFailure(diagnostics)) throw failure.error
  return requestSandboxReplacement(
    shell.recoverMissingSandbox,
    failure,
    'missing sandbox recovery',
  )
}

/**
 * `reuseOnly` stops before any step that creates, resumes, restarts, replaces or
 * deletes a box and returns undefined there; every other step is a read or the
 * idempotent renewal a reuse always made. `gate` is the spend gate: it runs
 * before the first such step, and before a reuse whose probe was not trusted.
 */
export async function provisionWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
  gate: () => Promise<void>,
  reuseOnly: boolean,
): Promise<SandboxInstance | undefined> {
  const execTimeoutMs = shell.livenessProbe?.execTimeoutMs
  // Match the supported SDK command-timeout range before any lifecycle mutation.
  if (execTimeoutMs !== undefined && (
    !Number.isInteger(execTimeoutMs) || execTimeoutMs < 100 || execTimeoutMs > 600_000
  )) {
    throw new Error('livenessProbe.execTimeoutMs must be an integer between 100 and 600000')
  }
  const { workspaceId, userId, harness, forceNew, onProgress, billingOwnerId } = options
  const measure = <T>(stage: string, operation: () => Promise<T>): Promise<T> =>
    options.measure ? options.measure(`sandbox.ensure.${stage}`, operation) : operation()
  const resolved = await measure('credentials', () => resolveWorkspaceSandboxClient(shell, workspaceId, userId))
  const { scope, client } = resolved
  let name = resolved.name
  let recoveryRestore: SandboxRestoreSpec | null | undefined
  let replacementRequested = false
  const resources = shell.resources ?? DEFAULT_SANDBOX_RESOURCES
  const resumeTimeout = shell.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS

  // Stage 1 — running-box reuse (skipped on forceNew). The box this isolate used
  // last is read by id; only when that misses is every running box listed.
  let existing: Outcome<SandboxInstance | null> = ok(null)
  const knownId = forceNew ? undefined : runningBoxIds.get(name)
  if (knownId) {
    const known = await measure('get_running', () => getRunningBox(client, knownId, name))
    if (known) {
      existing = ok(known)
    } else {
      runningBoxIds.delete(name)
      forgetBox(knownId)
    }
  }
  if (reuseOnly && !(existing.succeeded && existing.value)) return undefined
  if (!(existing.succeeded && existing.value)) {
    existing = await measure('list_running', () => listRunning(client, name))
  }
  if (forceNew && existing.succeeded && !existing.value) {
    existing = await listStopped(client, name)
  }
  if (forceNew && !existing.succeeded) throw existing.error
  if (existing.succeeded && existing.value) {
    const found = existing.value
    if (forceNew) {
      const dropped = await deleteBox(found)
      if (!dropped.succeeded) {
        throw new Error(`forceNew: sandbox ${name} could not be deleted`, { cause: dropped.error })
      }
    } else if (found.metadata?.harness === harness) {
      // Resolve app credentials before any restart so a mint failure leaves the
      // existing sandbox running and intact. Reading the runtime connection
      // restarts nothing, so it runs alongside the mint.
      const runtimeEnvMint = measure('runtime_env', () => resolveWorkspaceRuntimeEnv(shell, scope))
      const prefetch = prefetchExistingBoxReads(shell, found, runtimeEnvMint, measure)
      const [envResult, readyResult] = await Promise.allSettled([
        runtimeEnvMint,
        measure('refresh', () => refreshRuntimeConnection(client, found)),
      ])
      if (envResult.status === 'rejected') throw envResult.reason
      await prefetch.decided
      const runtimeEnv = envResult.value
      // A refusal from the spend gate is the caller's answer, not a box fault to recover from.
      const refusal: { error?: unknown; refused: boolean } = { refused: false }
      const gateBeforeUse = async (): Promise<void> => {
        try {
          await gate()
        } catch (error) {
          refusal.refused = true
          refusal.error = error
          throw error
        }
      }
      try {
        if (readyResult.status === 'rejected') throw readyResult.reason
        const ready = readyResult.value
        if ((await measure('liveness', () => isReusableBox(ready, shell.livenessProbe))).succeeded) {
          if (!trustedBoxes.has(ready)) await gateBeforeUse()
          const finalBox = await measure('finalize', () => finalizeExistingBox(shell, client, ready, 'reused', name, workspaceId, userId, harness, scope, runtimeEnv, prefetch))
          if (trustedBoxes.has(ready)) trustedBoxes.add(finalBox)
          return rememberRunningBox(name, finalBox)
        }
        if (reuseOnly) return undefined
        await gateBeforeUse()
        // The prefetched reads never reject; a recovered box is read again in finalize.
        // Unresponsive (or never-connectable) box with the RIGHT harness: recover
        // in place — stop→resume preserves the workspace — and fail loud if the
        // box is still dead. Deleting here wiped user workspaces (#299); delete
        // is reachable only via forceNew now.
        const recovered = await recoverUnresponsiveBox(
          client,
          ready,
          shell.livenessProbe,
          'reused',
          name,
          resumeTimeout,
          runtimeEnv,
          onProgress,
        )
        return rememberRunningBox(name, await finalizeExistingBox(shell, client, recovered, 'reused', name, workspaceId, userId, harness, scope, runtimeEnv))
      } catch (cause) {
        if (refusal.refused) throw refusal.error
        if (reuseOnly) return undefined
        const error = cause instanceof Error ? cause : new Error(String(cause))
        const recovery = await requestMissingSandboxReplacement(shell, {
          box: found,
          error,
          scope,
          boxKey: name,
          stage: 'reused',
        })
        name = recovery.replacementBoxKey
        recoveryRestore = recovery.restore
        replacementRequested = true
      }
    } else {
      if (reuseOnly) return undefined
      await gate()
      const dropped = await deleteBox(found)
      if (!dropped.succeeded) {
        throw new Error(
          `sandbox ${name} ` +
            `(was ${String(found.metadata?.harness ?? 'unknown')}, want ${harness}) ` +
            `could not be deleted`,
          { cause: dropped.error },
        )
      }
    }
  }

  // Stage 2 — stopped-box resume (skipped on forceNew or resumeStopped===false).
  if (reuseOnly) return undefined
  await gate()
  if (!replacementRequested && !forceNew && shell.resumeStopped !== false) {
    const stopped = await measure('list_stopped', () => listStopped(client, name))
    if (!stopped.succeeded) throw stopped.error
    if (stopped.value) {
      const stoppedBox = stopped.value
      const runtimeEnv = await measure('runtime_env', () => resolveWorkspaceRuntimeEnv(shell, scope))
      const resumed = await measure('resume', () => resumeStoppedBox(stoppedBox, resumeTimeout, runtimeEnv, onProgress))
      if (!resumed.succeeded) {
        const recovery = await requestSandboxReplacement(
          shell.recoverStoppedSandbox,
          { box: stopped.value, error: resumed.error, scope, boxKey: name },
          'stopped sandbox recovery',
        )
        name = recovery.replacementBoxKey
        recoveryRestore = recovery.restore
      } else {
        try {
          const box = await refreshRuntimeConnection(client, resumed.value)
          if ((await isReusableBox(box, shell.livenessProbe)).succeeded) {
            return rememberRunningBox(name, await finalizeExistingBox(shell, client, box, 'resumed', name, workspaceId, userId, harness, scope, runtimeEnv))
          }
          // The box resumed but is unresponsive: one full stop→resume cycle is
          // the state-preserving recovery; still-dead fails loud. Never delete —
          // that wipes the workspace (#299).
          const recovered = await recoverUnresponsiveBox(
            client,
            box,
            shell.livenessProbe,
            'resumed',
            name,
            resumeTimeout,
            runtimeEnv,
            onProgress,
          )
          return rememberRunningBox(name, await finalizeExistingBox(shell, client, recovered, 'resumed', name, workspaceId, userId, harness, scope, runtimeEnv))
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          const recovery = await requestMissingSandboxReplacement(shell, {
            box: stopped.value,
            error,
            scope,
            boxKey: name,
            stage: 'resumed',
          })
          name = recovery.replacementBoxKey
          recoveryRestore = recovery.restore
        }
      }
    }
  }

  // Stage 3 — create fresh.
  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId)
  const buildCtx: SandboxBuildContext = {
    workspaceId,
    connectedIntegrationIds,
    ...(userId ? { userId } : {}),
  }
  const [secrets, creationEnv, runtimeEnv, files] = await Promise.all([
    shell.secrets(workspaceId),
    shell.env(buildCtx),
    resolveWorkspaceRuntimeEnv(shell, scope),
    shell.files(buildCtx),
  ])
  const env = { ...creationEnv, ...runtimeEnv }
  const fullProfile = shell.profile({ extraFiles: files, harness })
  // When deferring, strip inline files from the create payload and write them
  // into the box after it reaches running. Keeps the provision body under the
  // orchestrator's 256 KiB cap and lands real files on disk.
  const { leanProfile, deferredFiles } = shell.deferProfileFiles
    ? splitDeferredProfileFiles(fullProfile)
    : { leanProfile: fullProfile, deferredFiles: [] as AgentProfileFileMount[] }
  const profile = leanProfile

  const role = userId && shell.permissionRole ? shell.permissionRole('developer') : undefined

  // Bake the model at create when opted in. childKeyMint overrides the apiKey
  // per-workspace; a typed mint failure falls through to the parent key (logged).
  let model = shell.backendModelAtCreate
    ? requireTransportableModel(resolveModelSelection(shell.provider), `backendModelAtCreate for ${name}`)
    : undefined
  if (model && shell.childKeyMint && model.provider === 'openai-compat') {
    const minted = await shell.childKeyMint(scope)
    if (minted.succeeded) model = { ...model, apiKey: minted.value }
    else {
      console.error(
        `[sandbox] childKeyMint failed for ${workspaceId}; using parent key:`,
        minted.error.message,
      )
    }
  }

  const storage = shell.storage?.(buildCtx)
  const restore = recoveryRestore === undefined ? await shell.restore?.(buildCtx) : recoveryRestore

  const payload = {
    name,
    image: resources.image,
    // Stamp the deferred-corpus hash so a later REUSE can skip re-writing an
    // unchanged skill corpus (materializeDeferredFilesForExistingBox reads it).
    metadata: {
      ...shell.metadata(harness),
      ...(deferredFiles.length > 0 ? { [DEFERRED_CORPUS_HASH_KEY]: deferredCorpusHash(deferredFiles) } : {}),
    },
    idempotencyKey: name,
    // Passed through untyped (the SDK payload type predates it); the platform
    // authz-gates it server-side and ignores it when unsupported.
    ...(billingOwnerId ? { billingOwnerId } : {}),
    ...(userId ? { permissions: { initialUsers: [{ userId, role }] } } : {}),
    env,
    secrets,
    backend: { type: harness, profile, ...(model ? backendModelFields(model) : {}) },
    ...(storage ? { storage } : {}),
    ...(restore ? restore : {}),
    ...(shell.egressPolicy ? { egressPolicy: shell.egressPolicy } : {}),
    ...(shell.cwd !== undefined ? { cwd: shell.cwd } : {}),
    ...(shell.webTerminalEnabled ? { webTerminalEnabled: true } : {}),
    maxLifetimeSeconds: resources.maxLifetimeSeconds,
    idleTimeoutSeconds: resources.idleTimeoutSeconds,
    resources: {
      cpuCores: resources.cpuCores,
      memoryMB: resources.memoryMB,
      diskGB: resources.diskGB,
      ...(resources.advisory !== undefined ? { advisory: resources.advisory } : {}),
    },
  } as CreatePayload

  // S-cost gates: an oversized env entry (E2BIG class), an over-cap provision
  // body, or a system prompt past the degradation cliff — fail loud here,
  // before the POST, with the offending section named. The prompt gate is
  // separate from the payload gate on purpose: the 122,659-byte prompt that
  // produced empty answers is a THIRD of the 240 KB payload cap, so the
  // payload gate never sees it.
  assertEnvWithinLimits(env)
  assertProfilePromptWithinBudget(
    profile,
    shell.promptBudget ?? {},
    `provision profile systemPrompt for ${name}`,
    SHELL_PROMPT_BUDGET_HINT,
  )
  // `?? {}` only narrows the SDK parameter's `| undefined`; the literal above
  // is always defined. The structural sections type needs no cast.
  assertProvisionPayloadWithinCap(payload ?? {})

  let box = await measure('create', () => client.create(payload))

  await measure('wait_running', () => box.waitFor('running', {
    timeoutMs: shell.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS,
    ...(onProgress ? { onProgress } : {}),
  }))
  box = await measure('refresh_connection', () => refreshRuntimeConnection(client, box))

  if (deferredFiles.length > 0) {
    const written = await writeProfileFilesToBox(box, deferredFiles)
    if (!written.succeeded) {
      throw deferredProfileWriteFailed('new', name, written.error)
    }
  }

  if (shell.bootstrap) {
    const bootstrap = shell.bootstrap.bind(shell)
    const boot = await measure('bootstrap', () => bootstrap(box, scope))
    if (!boot.succeeded) {
      throw new Error(`bootstrap failed on new box ${name}`, { cause: boot.error })
    }
  }
  return rememberRunningBox(name, box)
}
