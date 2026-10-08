/**
 * MCP servers in the profile: turn each on or off, see whether it answers and
 * which tools it offers, and add or edit a server by its address. Headers,
 * environment, and secret references stay in Advanced JSON.
 *
 * Turning a server off keeps its address in `metadata.enabledConfig`, because
 * the canonical schema does not let a disabled entry carry a URL or command;
 * turning it back on restores that configuration.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentProfileMcpServer } from '@tangle-network/agent-interface/profile'
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@tangle-network/sandbox-ui/primitives'
import { publicHttpsUrlProblem, type McpHealth, type ProfileEditorMcpPort } from '../profile-editor'
import { Field, fieldMessageId, formRow, formText, noAutofill, StatusPill, type StatusTone } from './agent-profile-form-kit'
import type { AgentProfileRegistryPort } from './agent-profile-registry'
import { AgentProfileRegistryMcpSearch } from './agent-profile-registry-search'

type Transport = 'http' | 'sse' | 'stdio'
type Servers = Record<string, AgentProfileMcpServer>

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The configuration a disabled server keeps so it can be turned back on. */
function enabledConfig(server: AgentProfileMcpServer): AgentProfileMcpServer | null {
  if (server.enabled !== false) return server
  const stored = server.metadata?.enabledConfig
  if (!stored || typeof stored !== 'object') return null
  const config = stored as Record<string, unknown>
  if (typeof config.url !== 'string' && typeof config.command !== 'string') return null
  return config as unknown as AgentProfileMcpServer
}

function withoutKeys<T extends object>(value: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

/** Disable a server and keep the configuration it needs to come back on. */
function disableMcpServer(server: AgentProfileMcpServer): AgentProfileMcpServer {
  if (server.enabled === false) return server
  const config = withoutKeys(server, ['enabled', 'metadata'])
  return { enabled: false, metadata: { ...(server.metadata ?? {}), enabledConfig: config } }
}

/** Enable a server from its stored configuration, or null when it has none. */
function enableMcpServer(server: AgentProfileMcpServer): AgentProfileMcpServer | null {
  if (server.enabled !== false) return server
  const config = enabledConfig(server)
  if (!config) return null
  const metadata = withoutKeys(server.metadata ?? {}, ['enabledConfig'])
  return { ...(config as object), ...(Object.keys(metadata).length ? { metadata } : {}) } as AgentProfileMcpServer
}

function serverTransport(server: AgentProfileMcpServer | null): Transport {
  if (!server) return 'http'
  if ('command' in server && server.command) return 'stdio'
  return 'transport' in server && server.transport === 'sse' ? 'sse' : 'http'
}

function serverTarget(server: AgentProfileMcpServer | null): string {
  if (!server) return ''
  if ('command' in server && server.command) return server.command
  return 'url' in server && server.url ? server.url : ''
}

function healthKey(server: AgentProfileMcpServer): string {
  return JSON.stringify(['url' in server ? server.url : null, 'transport' in server ? server.transport : null, 'headers' in server ? server.headers : null])
}

function healthStatus(health: McpHealth | 'checking' | undefined): { tone: StatusTone; label: string } {
  if (health === 'checking') return { tone: 'pending', label: 'Checking' }
  if (!health) return { tone: 'neutral', label: 'Not checked' }
  if (health.ok) return { tone: 'success', label: `Connected · ${health.tools.length} ${health.tools.length === 1 ? 'tool' : 'tools'}` }
  const labels: Record<Exclude<McpHealth, { ok: true }>['problem'], [StatusTone, string]> = {
    'auth-required': ['warning', 'Needs credentials'],
    'invalid-url': ['error', 'Invalid address'],
    'blocked-url': ['error', 'Address not allowed'],
    'not-checkable': ['neutral', 'Checked at run time'],
    unreachable: ['error', 'Unreachable'],
    timeout: ['error', 'Timed out'],
    'protocol-error': ['error', 'Not an MCP server'],
    unavailable: ['warning', 'Check unavailable'],
  }
  const [tone, label] = labels[health.problem]
  return { tone, label }
}

export interface McpServersEditorProps {
  servers: Servers
  /** Apply the next server map to the profile. Returns false when the profile rejected it. */
  onChange: (next: Servers) => boolean
  port?: ProfileEditorMcpPort
  disabled: boolean
  /** Explain why servers cannot be changed here, for example a missing role. */
  lockReason?: string
  publicHttpsOnly: boolean
  allowLocalCommand: boolean
  registry?: AgentProfileRegistryPort
  /** Report an open add or edit form, so the host can hold its save. */
  onPendingChange?: (pending: boolean) => void
}

interface Draft { name: string; transport: Transport; target: string }

function targetProblem(draft: Draft, publicHttpsOnly: boolean): string | null {
  const target = draft.target.trim()
  if (!target) return null
  if (draft.transport === 'stdio') return /[\u0000-\u001f\u007f]/.test(target) ? 'Remove control characters from the command.' : null
  if (publicHttpsOnly) return publicHttpsUrlProblem(target)
  try {
    const url = new URL(target)
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'Use an http:// or https:// address.'
  } catch { return 'Enter a full URL, such as https://example.com/mcp.' }
}

function serverFromDraft(draft: Draft, previous?: AgentProfileMcpServer): AgentProfileMcpServer {
  const target = draft.target.trim()
  const metadata = previous?.metadata ? withoutKeys(previous.metadata, ['enabledConfig']) : undefined
  const keep = metadata && Object.keys(metadata).length ? { metadata } : {}
  const prior = previous ? enabledConfig(previous) : null
  if (draft.transport === 'stdio') {
    const extras = prior && 'command' in prior ? withoutKeys(prior, ['command', 'transport', 'enabled', 'metadata', 'url', 'headers']) : {}
    return { ...extras, command: target, ...keep } as AgentProfileMcpServer
  }
  const headers = prior && 'headers' in prior && prior.headers ? { headers: prior.headers } : {}
  return { transport: draft.transport, url: target, ...headers, ...keep }
}

function ServerForm({ draft, onDraft, existingNames, nameEditable, publicHttpsOnly, allowLocalCommand, disabled, submitLabel, onSubmit, onCancel }: {
  draft: Draft
  onDraft: (draft: Draft) => void
  existingNames: readonly string[]
  nameEditable: boolean
  publicHttpsOnly: boolean
  allowLocalCommand: boolean
  disabled: boolean
  submitLabel: string
  onSubmit: () => void
  onCancel: () => void
}) {
  const id = useId()
  const name = draft.name.trim()
  const nameProblem = !nameEditable || !name ? null
    : !NAME_PATTERN.test(name) ? 'Use up to 64 letters, numbers, dots, dashes, or underscores.'
    : existingNames.includes(name) ? 'A server with this name already exists.' : null
  const problem = targetProblem(draft, publicHttpsOnly)
  const ready = !disabled && (!nameEditable || (name && !nameProblem)) && draft.target.trim() && !problem
  return <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
    <div className={formRow}>
      {nameEditable && <Field label="Name" htmlFor={`${id}-name`} error={nameProblem}>
        <Input id={`${id}-name`} size="compact" value={draft.name} disabled={disabled} placeholder="search" {...noAutofill}
          aria-invalid={nameProblem ? true : undefined} aria-describedby={nameProblem ? fieldMessageId(`${id}-name`) : undefined}
          onChange={event => onDraft({ ...draft, name: event.target.value })} />
      </Field>}
      <Field label="Connection" htmlFor={`${id}-transport`}>
        <Select disabled={disabled} value={draft.transport} onValueChange={value => onDraft({ ...draft, transport: value as Transport })}>
          <SelectTrigger id={`${id}-transport`} size="compact" className="shadow-none"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="http">Streamable HTTP</SelectItem>
            <SelectItem value="sse">Server-sent events</SelectItem>
            {(allowLocalCommand || draft.transport === 'stdio') && <SelectItem value="stdio">Local command</SelectItem>}
          </SelectContent>
        </Select>
      </Field>
    </div>
    <Field label={draft.transport === 'stdio' ? 'Command' : 'URL'} htmlFor={`${id}-target`} error={problem}
      hint={draft.transport === 'stdio' ? 'Runs inside the agent workspace.' : undefined}>
      <Input id={`${id}-target`} size="compact" value={draft.target} disabled={disabled} {...noAutofill}
        inputMode={draft.transport === 'stdio' ? 'text' : 'url'}
        placeholder={draft.transport === 'stdio' ? 'npx -y @modelcontextprotocol/server-memory' : 'https://example.com/mcp'}
        aria-invalid={problem ? true : undefined} aria-describedby={fieldMessageId(`${id}-target`)}
        onChange={event => onDraft({ ...draft, target: event.target.value })}
        onKeyDown={event => { if (event.key === 'Enter' && ready) { event.preventDefault(); onSubmit() } }} />
    </Field>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="compact" disabled={!ready} onClick={onSubmit}>{submitLabel}</Button>
      <Button type="button" size="compact" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  </div>
}

export function McpServersEditor({ servers, onChange, port, disabled, lockReason, publicHttpsOnly, allowLocalCommand, registry, onPendingChange }: McpServersEditorProps) {
  const [health, setHealth] = useState<Record<string, { key: string; result: McpHealth | 'checking' }>>({})
  const [recheck, setRecheck] = useState<Record<string, number>>({})
  const [editing, setEditing] = useState<{ name: string; draft: Draft; reason?: string } | null>(null)
  const [adding, setAdding] = useState<Draft | null>(null)
  const controllers = useRef(new Map<string, AbortController>())
  const locked = lockReason !== undefined
  const entries = useMemo(() => Object.entries(servers), [servers])

  // Check every enabled remote server once per configuration, and again on request.
  useEffect(() => {
    if (!port) return
    for (const [name, server] of entries) {
      if (server.enabled === false || ('command' in server && server.command)) continue
      const key = `${healthKey(server)}#${recheck[name] ?? 0}`
      if (health[name]?.key === key) continue
      controllers.current.get(name)?.abort()
      const controller = new AbortController()
      controllers.current.set(name, controller)
      setHealth(current => ({ ...current, [name]: { key, result: 'checking' } }))
      port.check(server, controller.signal).then(result => {
        if (!controller.signal.aborted) setHealth(current => ({ ...current, [name]: { key, result } }))
      }, () => {
        if (!controller.signal.aborted) {
          setHealth(current => ({ ...current, [name]: { key, result: { ok: false, problem: 'unavailable', message: 'The check could not run.', checkedAt: new Date().toISOString() } } }))
        }
      })
    }
  }, [entries, port, recheck, health])
  useEffect(() => () => { for (const controller of controllers.current.values()) controller.abort() }, [])
  const pending = editing !== null || adding !== null
  useEffect(() => { onPendingChange?.(pending) }, [pending, onPendingChange])

  function setServer(name: string, server: AgentProfileMcpServer | null) {
    const next = { ...servers }
    if (server) next[name] = server
    else delete next[name]
    return onChange(next)
  }

  function toggle(name: string, server: AgentProfileMcpServer, on: boolean) {
    if (!on) { setServer(name, disableMcpServer(server)); return }
    const enabled = enableMcpServer(server)
    if (enabled) { setServer(name, enabled); return }
    setEditing({ name, draft: { name, transport: 'http', target: '' }, reason: 'Add the server address to turn it on.' })
  }

  return <div className="space-y-4">
    {entries.length === 0 && <p className={formText.muted}>No MCP servers yet.</p>}
    {entries.length > 0 && <ul className="divide-y divide-border rounded-lg border border-border">
      {entries.map(([name, server]) => {
        const on = server.enabled !== false
        const config = enabledConfig(server)
        const local = serverTransport(config) === 'stdio'
        const target = serverTarget(config)
        const result = health[name]?.result
        const status = !on ? { tone: 'neutral' as const, label: 'Off' }
          : local ? { tone: 'neutral' as const, label: 'Checked at run time' }
          : port ? healthStatus(result) : { tone: 'neutral' as const, label: 'Not checked' }
        const description = typeof server.metadata?.description === 'string' ? server.metadata.description : null
        const policyProblem = on && !local && publicHttpsOnly && target ? publicHttpsUrlProblem(target) : null
        const toggleId = `mcp-${name}-toggle`
        return <li key={name} className="space-y-3 p-3" aria-label={`MCP server ${name}`}>
          <div className="flex items-start gap-3">
            <span className="flex h-6 items-center">
              <Switch id={toggleId} checked={on} disabled={disabled || locked} aria-label={`${on ? 'Turn off' : 'Turn on'} ${name}`}
                title={lockReason} onCheckedChange={checked => toggle(name, server, checked)} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <label htmlFor={toggleId} className={`min-w-0 break-words ${formText.label}`}>{name}</label>
                <StatusPill tone={status.tone}>{status.label}</StatusPill>
              </div>
              <p className={`truncate ${formText.muted}`} title={target || undefined}>{target || 'No address yet'}</p>
              {description && <p className={formText.muted}>{description}</p>}
              {policyProblem && <p className={formText.error}>{policyProblem}</p>}
              {on && !local && result && result !== 'checking' && !result.ok && result.problem !== 'not-checkable' &&
                <p className={result.problem === 'auth-required' || result.problem === 'unavailable' ? formText.muted : formText.error}>{result.message}</p>}
              {on && result && result !== 'checking' && result.ok && result.tools.length > 0 &&
                <p className={`line-clamp-2 ${formText.muted}`}>Tools: {result.tools.map(tool => tool.name).join(', ')}</p>}
            </div>
          </div>
          {!locked && <div className="flex flex-wrap gap-1 pl-9">
            {port && on && !local && <Button type="button" size="compact" variant="ghost" disabled={disabled || result === 'checking'}
              onClick={() => setRecheck(current => ({ ...current, [name]: (current[name] ?? 0) + 1 }))}>Check again</Button>}
            <Button type="button" size="compact" variant="ghost" disabled={disabled} aria-label={`Edit ${name}`}
              onClick={() => setEditing({ name, draft: { name, transport: serverTransport(config), target } })}>Edit</Button>
            <Button type="button" size="compact" variant="ghost" className="text-destructive hover:text-destructive" disabled={disabled}
              aria-label={`Remove ${name}`} onClick={() => { if (setServer(name, null) && editing?.name === name) setEditing(null) }}>Remove</Button>
          </div>}
          {editing?.name === name && <div className="space-y-2 @lg/profile-editor:pl-12">
            {editing.reason && <p className={formText.muted}>{editing.reason}</p>}
            <ServerForm draft={editing.draft} onDraft={draft => setEditing({ ...editing, draft })} existingNames={[]} nameEditable={false}
              publicHttpsOnly={publicHttpsOnly} allowLocalCommand={allowLocalCommand} disabled={disabled} submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={() => { if (setServer(name, serverFromDraft(editing.draft, server))) setEditing(null) }} />
          </div>}
        </li>
      })}
    </ul>}
    {locked && <p className={formText.muted}>{lockReason}</p>}
    {!locked && (adding
      ? <ServerForm draft={adding} onDraft={setAdding} existingNames={Object.keys(servers)} nameEditable publicHttpsOnly={publicHttpsOnly}
        allowLocalCommand={allowLocalCommand} disabled={disabled} submitLabel="Add server" onCancel={() => setAdding(null)}
        onSubmit={() => { if (setServer(adding.name.trim(), serverFromDraft(adding))) setAdding(null) }} />
      : <Button type="button" size="compact" variant="outline" disabled={disabled} onClick={() => setAdding({ name: '', transport: 'http', target: '' })}>Add server</Button>)}
    {registry && !locked && <AgentProfileRegistryMcpSearch registry={registry} disabled={disabled} existingNames={Object.keys(servers)}
      validate={(name, server) => {
        if (!name.trim()) return 'The registry returned a server without a usable name.'
        if (name in servers) return 'A server with that name already exists.'
        return publicHttpsOnly && 'url' in server && server.url ? publicHttpsUrlProblem(server.url)
          : publicHttpsOnly ? 'Use a public HTTPS MCP endpoint.' : null
      }}
      onAdd={(name, server) => setServer(name, server)} />}
    <p className={formText.muted}>Headers, environment variables, and secret references are edited in Advanced JSON.</p>
  </div>
}
