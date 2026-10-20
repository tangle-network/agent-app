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

/** Resolve adding a user with a specific role to a sandbox and return the operation outcome */
export async function syncSandboxMemberAdd(
  box: SandboxInstance,
  seam: MemberSyncSeam,
  userId: string,
  role: string,
): Promise<Outcome<void>> {
  try {
    await box.permissions.add({ userId, role: seam.roleToSandboxRole(role) })
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

/** Remove a member from the sandbox while preserving their home directory and handle the outcome */
export async function syncSandboxMemberRemove(
  box: SandboxInstance,
  userId: string,
): Promise<Outcome<void>> {
  try {
    await box.permissions.remove(userId, { preserveHomeDir: true })
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

/** Synchronize a sandbox member's role by updating permissions based on the provided role mapping */
export async function syncSandboxMemberRole(
  box: SandboxInstance,
  seam: MemberSyncSeam,
  userId: string,
  role: string,
): Promise<Outcome<void>> {
  try {
    await box.permissions.update(userId, { role: seam.roleToSandboxRole(role) })
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
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
    // The API has no replace route, so a replacement is a delete followed by a
    // create. That pair is NOT atomic: if the create fails, the secret is left
    // deleted rather than at its previous value. `storeSecret` reports that
    // state instead of reporting a generic write failure, because a caller
    // retrying a lost secret needs to know it is now absent.
    update: async (name, value) => {
      await client.secrets.delete(name)
      await client.secrets.create(name, value)
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
          `Failed to store sandbox secret ${name}. A replacement deletes before it creates, so ${name} may now be absent rather than holding its previous value.`,
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
