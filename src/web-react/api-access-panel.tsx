import { useEffect, useRef, useState, type FormEvent } from 'react'
import { PageHeader } from '@tangle-network/ui/primitives'

export interface ApiAccessKey {
  id: string
  name: string
  scopes: string[]
  expiresAt: string | Date | null
  /** Workspaces the key is limited to. Empty or absent: every workspace the account can open. */
  workspaceIds?: readonly string[] | null
}

/** A workspace a key can be limited to. */
export interface ApiAccessWorkspace {
  id: string
  name: string
}

export interface ApiAccessScope {
  scope: string
  label: string
  description: string
  requires?: readonly string[]
}

export interface ApiAccessPanelProps {
  keys: readonly ApiAccessKey[]
  access: readonly ApiAccessScope[]
  defaultScopes: readonly string[]
  baseUrl: string
  expiryDays?: readonly number[]
  defaultExpiryDays?: number
  accountHref?: string
  description?: string
  limitsDescription?: string
  /**
   * Workspaces a new key may be limited to. Supply it when the backend can bind
   * a key to workspaces; the form then offers "all" or one of them, and each
   * key says which it reaches. Omit it and every key reaches every workspace.
   */
  workspaces?: readonly ApiAccessWorkspace[]
  /** The product's words for one workspace and several. Defaults to workspace / workspaces. */
  workspaceNoun?: { singular: string; plural: string }
  /** `workspaceIds` is empty for a key that reaches every workspace. */
  onCreate: (input: { name: string; scopes: string[]; expiresAt: string; workspaceIds: string[] }) => Promise<{ id: string; key: string }>
  onRevoke: (id: string) => Promise<void>
  onChanged: () => void
}

const defaultExpiryChoices = [1, 7, 30] as const

const inputClass = 'h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground'
const buttonClass = 'inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50'
const outlineClass = 'inline-flex items-center justify-center rounded-lg border border-input bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50'

function pruneScopes(scopes: readonly string[], access: readonly ApiAccessScope[]): string[] {
  const offered = new Map(access.map(option => [option.scope, option]))
  const selected = new Set(scopes.filter(scope => offered.has(scope)))
  let changed = true
  while (changed) {
    changed = false
    for (const scope of selected) {
      if (offered.get(scope)?.requires?.some(required => !selected.has(required))) {
        selected.delete(scope)
        changed = true
      }
    }
  }
  return [...selected]
}

function expandScopes(scopes: readonly string[], access: readonly ApiAccessScope[]): string[] {
  const offered = new Map(access.map(option => [option.scope, option]))
  const selected = new Set<string>()
  for (const scope of scopes) {
    const closure = new Set([scope])
    let available = true
    for (const required of closure) {
      const option = offered.get(required)
      if (!option) {
        available = false
        break
      }
      for (const dependency of option.requires ?? []) closure.add(dependency)
    }
    if (available) for (const required of closure) selected.add(required)
  }
  return [...selected]
}

export function ApiAccessPanel({ keys, access, defaultScopes, baseUrl, accountHref, description,
  limitsDescription, expiryDays = defaultExpiryChoices, defaultExpiryDays = 7,
  workspaces, workspaceNoun = { singular: 'workspace', plural: 'workspaces' },
  onCreate, onRevoke, onChanged }: ApiAccessPanelProps) {
  const [name, setName] = useState('')
  const [reach, setReach] = useState('')
  // A workspace that is no longer offered falls back to "all" rather than minting a key for it.
  const selectedWorkspace = workspaces?.some(workspace => workspace.id === reach) ? reach : ''
  const workspaceName = (id: string) => workspaces?.find(workspace => workspace.id === id)?.name ?? `A removed ${workspaceNoun.singular}`
  const allowedDays = [...new Set(expiryDays)].filter(days => days > 0
    && Number.isFinite(new Date(Date.now() + days * 86_400_000).getTime()))
  const fallbackDays = allowedDays.includes(defaultExpiryDays) ? defaultExpiryDays : allowedDays[0]
  const [days, setDays] = useState<number | undefined>(fallbackDays)
  const selectedDays = days !== undefined && allowedDays.includes(days) ? days : fallbackDays
  const [scopes, setScopes] = useState<string[]>(() => expandScopes(defaultScopes, access))
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const keyHeading = useRef<HTMLHeadingElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const keyWasShown = useRef(false)
  const selectedScopes = pruneScopes(scopes, access)

  useEffect(() => {
    setScopes(current => {
      const next = pruneScopes(current, access)
      return next.length === current.length ? current : next
    })
  }, [access])

  useEffect(() => {
    if (created) {
      keyHeading.current?.focus()
      keyWasShown.current = true
    } else if (keyWasShown.current) {
      nameInput.current?.focus()
      keyWasShown.current = false
    }
  }, [created])

  async function createKey(event: FormEvent) {
    event.preventDefault()
    const requestedScopes = pruneScopes(scopes, access)
    if (!name.trim() || !requestedScopes.length || selectedDays === undefined || creating || created) return
    setCreating(true)
    setError(null)
    try {
      const result = await onCreate({ name: name.trim(), scopes: requestedScopes,
        expiresAt: new Date(Date.now() + selectedDays * 86_400_000).toISOString(),
        workspaceIds: selectedWorkspace ? [selectedWorkspace] : [] })
      if (!result.id || !result.key) throw new Error('Could not create key')
      setCreated({ id: result.id, key: result.key })
      setName('')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create key')
    } finally {
      setCreating(false)
    }
  }

  async function revokeKey(id: string) {
    setRevoking(id)
    setError(null)
    try {
      await onRevoke(id)
      if (created?.id === id) setCreated(null)
      onChanged()
      setNotice('Key revoked')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke key')
    } finally {
      setRevoking(null)
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-8 px-4 py-8 sm:px-8">
        <div className="space-y-2">
          {accountHref && <a href={accountHref} className="text-sm text-muted-foreground hover:text-foreground">Account</a>}
          <PageHeader
            className="mb-0"
            title="API access"
            description={description ?? 'Connect a client to your account. Each key acts with your permissions and only the access you choose.'}
          />
        </div>

        {error && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}

        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}

        {created ? (
          <section aria-labelledby="save-api-key" className="space-y-4 rounded-xl border border-border bg-card p-5">
            <h2 ref={keyHeading} tabIndex={-1} id="save-api-key" className="font-medium outline-none">Save your key</h2>
            <p className="text-sm text-muted-foreground">
              Copy it directly into your client’s secret storage. It is shown only now.
              Keep it out of chat messages and prompts.
            </p>
            <div className="flex gap-2">
              <input aria-label="New API key" type="password" value={created.key} readOnly autoComplete="off" className={`${inputClass} min-w-0 font-mono`} />
              <button className={buttonClass} onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.key)
                  setNotice('Key copied')
                } catch {
                  setError('Clipboard unavailable. Select the key field and copy it manually.')
                }
              }}>Copy key</button>
            </div>
            <button className={outlineClass} onClick={() => { setCreated(null); setNotice(null) }}>I’ve saved it</button>
          </section>
        ) : (
          <form onSubmit={createKey} className="space-y-5 rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium">Create a key</h2>
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="key-name">Name</label>
                <input ref={nameInput} id="key-name" className={inputClass} value={name} onChange={event => setName(event.target.value)} placeholder="Client on my server" maxLength={100} required autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="key-expiry">Expires in</label>
                <select id="key-expiry" value={selectedDays ?? ''} onChange={event => setDays(Number(event.target.value))} className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  {allowedDays.map(days => <option key={days} value={days}>{days} {days === 1 ? 'day' : 'days'}</option>)}
                </select>
              </div>
            </div>
            {workspaces && workspaces.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="key-reach">Reaches</label>
                <select id="key-reach" value={selectedWorkspace} onChange={event => setReach(event.target.value)} className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">All {workspaceNoun.plural}, including new ones</option>
                  {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>Only {workspace.name}</option>)}
                </select>
              </div>
            )}
            <fieldset className="space-y-3">
              <legend className="mb-3 text-sm font-medium">Permissions</legend>
              {access.map(option => {
                const unavailable = !expandScopes([option.scope], access).includes(option.scope)
                return (
                  <label key={option.scope} className="flex cursor-pointer items-start gap-3">
                    <input type="checkbox" className="mt-1 size-4 accent-primary" checked={selectedScopes.includes(option.scope)}
                      disabled={unavailable}
                      onChange={event => setScopes(current => event.target.checked
                        ? expandScopes([...current, option.scope], access)
                        : pruneScopes(current.filter(scope => scope !== option.scope), access))} />
                    <span className="text-sm">
                      <span className="block font-medium">{option.label}</span>
                      <span className="text-muted-foreground">{option.description}</span>
                      {unavailable && <span className="block text-muted-foreground">Required permission unavailable.</span>}
                    </span>
                  </label>
                )
              })}
            </fieldset>
            {limitsDescription && <p className="text-sm text-muted-foreground">{limitsDescription}</p>}
            <button className={buttonClass} type="submit" disabled={creating || !name.trim() || !selectedScopes.length || selectedDays === undefined}>{creating ? 'Creating…' : 'Create key'}</button>
          </form>
        )}

        <section aria-labelledby="existing-keys" className="space-y-3">
          <h2 id="existing-keys" className="font-medium">Your keys</h2>
          {keys.length === 0 ? <p className="text-sm text-muted-foreground">No keys yet.</p> : (
            <ul className="divide-y divide-border rounded-xl border border-border bg-card">
              {keys.map(key => (
                <li key={key.id} className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-1">
                    <p className="break-words text-sm font-medium">{key.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {key.expiresAt ? `${new Date(key.expiresAt).getTime() <= Date.now() ? 'Expired' : 'Expires'} ${new Date(key.expiresAt).toLocaleDateString()}` : 'No expiry'}
                    </p>
                    <p className="text-sm text-muted-foreground">{key.scopes.map(scope => access.find(access => access.scope === scope)?.label ?? scope).join(' · ')}</p>
                    {workspaces && (
                      <p className="text-sm text-muted-foreground">
                        {key.workspaceIds?.length ? `Only ${key.workspaceIds.map(workspaceName).join(', ')}` : `All ${workspaceNoun.plural}`}
                      </p>
                    )}
                  </div>
                  <button className={outlineClass} disabled={revoking !== null} onClick={() => revokeKey(key.id)} aria-label={`Revoke ${key.name}`}>
                    {revoking === key.id ? 'Revoking…' : 'Revoke'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-sm text-muted-foreground">
          Use <code className="text-sm">{baseUrl}</code> as the API base and send the key as a Bearer credential.
        </p>
      </div>
    </main>
  )
}
