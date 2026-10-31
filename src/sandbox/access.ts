import type { SandboxInstance, ScopedTokenScope, MintScopedTokenOptions } from '@tangle-network/sandbox'
import { type Outcome, ok, fail } from './outcome'
import type { SandboxRuntimeConfig } from './configuration'
import { getClient } from './runtime-cache'

// Mirrors the SDK's PermissionLevel union (not re-exported by
// @tangle-network/sandbox). The product's role-mapping seam must produce one of
// these; binding the seam's return type to the union makes a wrong mapping a
// compile error rather than a runtime 400 from the orchestrator.
/** Define permission levels for sandbox access and control */
export type SandboxPermissionLevel = 'owner' | 'admin' | 'developer' | 'viewer'

/** Map workspace roles to corresponding sandbox permission levels */
export interface MemberSyncSeam {
  roleToSandboxRole: (workspaceRole: string) => SandboxPermissionLevel
}

/**
 * Sandbox member permissions are not served. The SDK's `box.permissions` called `/permissions/users*` on the
 * sidecar, which never served it, so every add, update and remove failed with 404; `@tangle-network/sandbox` 0.64
 * removed the API (agent-container b9c65980). These keep their signatures so callers compile, and fail with
 * an error whose `code` is `sandbox_member_permissions_unsupported`, without a network call: the outcome callers already saw,
 * now named. Access to a workspace box is decided by the product's own authorization, not per-box member rows.
 */
class SandboxMemberPermissionsUnsupportedError extends Error {
  readonly code = 'sandbox_member_permissions_unsupported'
  constructor() {
    super('Sandbox member permissions are not served by the platform; @tangle-network/sandbox 0.64 removed box.permissions.')
    this.name = 'SandboxMemberPermissionsUnsupportedError'
  }
}

/** Always fails with {@link SandboxMemberPermissionsUnsupportedError}; see its note. */
export async function syncSandboxMemberAdd(
  _box: SandboxInstance,
  _seam: MemberSyncSeam,
  _userId: string,
  _role: string,
): Promise<Outcome<void>> {
  return fail(new SandboxMemberPermissionsUnsupportedError())
}

/** Always fails with {@link SandboxMemberPermissionsUnsupportedError}; see its note. */
export async function syncSandboxMemberRemove(
  _box: SandboxInstance,
  _userId: string,
): Promise<Outcome<void>> {
  return fail(new SandboxMemberPermissionsUnsupportedError())
}

/** Always fails with {@link SandboxMemberPermissionsUnsupportedError}; see its note. */
export async function syncSandboxMemberRole(
  _box: SandboxInstance,
  _seam: MemberSyncSeam,
  _userId: string,
  _role: string,
): Promise<Outcome<void>> {
  return fail(new SandboxMemberPermissionsUnsupportedError())
}

/**
 * Write-only secret port: create, replace, and delete a secret by name.
 *
 * There is no read method. The platform's secrets API returns names and
 * timestamps only — a stored value is never served back, it is injected into
 * the sandbox as an environment variable. A `get` here could only ever return
 * a value this process already held, so the port does not offer one.
 */
export interface SecretStore {
  create: (name: string, value: string) => Promise<void>
  update: (name: string, value: string) => Promise<void>
  delete: (name: string) => Promise<void>
}

/** Resolve a SecretStore interface using the provided SandboxRuntimeConfig shell */
export function secretStoreFromClient(shell: SandboxRuntimeConfig): SecretStore {
  const client = getClient(shell)
  return {
    create: async (name, value) => {
      await client.secrets.create(name, value)
    },
    // Replace in place, guarded by the row's updatedAt: a concurrent writer
    // cannot clobber a successor, and a failure leaves the PREVIOUS value
    // live (the platform re-keys matching boxes on the update).
    update: async (name, value) => {
      const current = await client.secrets.list().then(rows => rows.find(row => row.name === name))
      if (!current) {
        await client.secrets.create(name, value)
        return
      }
      await client.secrets.update(name, value, {
        expectedUpdatedAt: current.updatedAt.toISOString(),
      })
    },
    delete: async (name) => {
      await client.secrets.delete(name)
    },
  }
}

/** Resolve storing a secret by creating it, or replacing it when it exists */
export async function storeSecret(
  store: SecretStore,
  name: string,
  value: string,
): Promise<Outcome<void>> {
  try {
    await store.create(name, value)
    return ok(undefined)
  } catch {
    try {
      await store.update(name, value)
      return ok(undefined)
    } catch (err) {
      return fail(
        new Error(
          `Failed to store sandbox secret ${name}. The previous value remains live; a concurrent writer may have replaced it first (retry resolves by expectedUpdatedAt).`,
          { cause: err },
        ),
      )
    }
  }
}

/** Delete a secret by name from the given secret store and return the operation outcome */
export async function deleteSecret(store: SecretStore, name: string): Promise<Outcome<void>> {
  try {
    await store.delete(name)
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

/** Represent a token with its expiration date and associated scope */
export interface ScopedTokenResult {
  token: string
  expiresAt: Date
  scope: ScopedTokenScope
}

/**
 * Mint a scoped token for an already-provisioned box (e.g. to hand a terminal
 * proxy a narrowed credential). Uses the SDK's native `box.mintScopedToken`,
 * which normalizes `expiresAt` to a Date — no hand-rolled wire call.
 */
export async function mintSandboxScopedToken(
  box: SandboxInstance,
  options: MintScopedTokenOptions,
): Promise<Outcome<ScopedTokenResult>> {
  try {
    const token = await box.mintScopedToken(options)
    return ok({ token: token.token, expiresAt: token.expiresAt, scope: token.scope })
  } catch (err) {
    return fail(err)
  }
}
