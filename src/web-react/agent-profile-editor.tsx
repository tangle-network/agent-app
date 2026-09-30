import { useEffect, useId, useState, type ReactNode } from 'react'
import type { AgentProfile, AgentProfileMcpServer, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'
import { agentProfileSchema } from '@tangle-network/agent-interface/profile-schema'

export interface AgentProfileEditorProps {
  value: AgentProfile
  onChange: (value: AgentProfile) => void
  disabled?: boolean
  className?: string
}

const input = 'min-h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const button = 'rounded-lg border border-input bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50'
const remove = 'text-destructive hover:underline disabled:opacity-50'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-sm font-medium text-foreground">
    <span>{label}</span>{children}
    {hint && <span className="block text-xs font-normal text-muted-foreground">{hint}</span>}
  </label>
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
    <div><h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}</div>
    {children}
  </section>
}

function issueMessage(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0]
  return issue ? (issue.path.map(String).join('.') || 'Profile') + ': ' + issue.message : 'Invalid profile'
}

/** Controlled editor for the canonical profile. The product owns save and execution authority. */
export function AgentProfileEditor({ value, onChange, disabled = false, className }: AgentProfileEditorProps) {
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const [newTool, setNewTool] = useState('')
  const [mcpName, setMcpName] = useState('')
  const [mcpKind, setMcpKind] = useState<'http' | 'sse' | 'stdio'>('http')
  const [mcpTarget, setMcpTarget] = useState('')
  const [resourceDrafts, setResourceDrafts] = useState<Record<string, { kind: 'github' | 'inline'; path: string; name: string; content: string }>>({})
  const [json, setJson] = useState(() => JSON.stringify(value, null, 2))
  const [jsonDirty, setJsonDirty] = useState(false)
  useEffect(() => { if (!jsonDirty) setJson(JSON.stringify(value, null, 2)) }, [value, jsonDirty])
  const editingDisabled = disabled || jsonDirty

  function emit(next: AgentProfile) {
    if (jsonDirty) { setError('Apply or discard JSON edits first.'); return false }
    const result = agentProfileSchema.safeParse(next)
    if (!result.success) { setError(issueMessage(result.error)); return false }
    setError(null)
    onChange(result.data)
    return true
  }
  function prompt(next: NonNullable<AgentProfile['prompt']>) { emit({ ...value, prompt: next }) }
  function model(next: NonNullable<AgentProfile['model']>) { emit({ ...value, model: next }) }
  function resources(key: 'skills' | 'tools', refs: AgentProfileResourceRef[]) {
    return emit({ ...value, resources: { ...value.resources, [key]: refs } })
  }
  function addResource(key: 'skills' | 'tools') {
    const draft = resourceDrafts[key] ?? { kind: 'github', path: '', name: '', content: '' }
    const ref: AgentProfileResourceRef = draft.kind === 'github'
      ? { kind: 'github', path: draft.path.trim(), ...(draft.name.trim() ? { name: draft.name.trim() } : {}) }
      : { kind: 'inline', name: draft.name.trim(), content: draft.content }
    if (draft.kind === 'github' && !draft.path.trim() || draft.kind === 'inline' && !draft.name.trim()) {
      setError(draft.kind === 'github' ? 'Enter a resource path.' : 'Enter a resource name.')
      return
    }
    if (!resources(key, [...(value.resources?.[key] ?? []), ref])) return
    setResourceDrafts(current => ({ ...current, [key]: { ...draft, path: '', name: '', content: '' } }))
  }
  function resourceSection(key: 'skills' | 'tools', title: string, description: string) {
    const refs = value.resources?.[key] ?? []
    const draft = resourceDrafts[key] ?? { kind: 'github', path: '', name: '', content: '' }
    function change(field: keyof typeof draft, text: string) {
      setResourceDrafts(current => ({ ...current, [key]: { ...draft, [field]: text } }))
    }
    return <Section title={title} description={description}>
      {refs.length === 0 && <p className="text-sm text-muted-foreground">None added.</p>}
      <ul className="space-y-2">{refs.map((ref, index) =>
        <li key={index} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <div className="min-w-0"><span className="font-medium">{ref.name || (ref.kind === 'github' ? ref.path : 'Inline resource')}</span>
            <span className="ml-2 text-xs text-muted-foreground">{ref.kind === 'github' ? 'GitHub · ' + ref.path : 'Inline'}</span>
            {ref.kind === 'github' && ref.repository && <span className="block text-xs text-muted-foreground">{ref.repository}</span>}
          </div>
          <button type="button" className={remove} disabled={editingDisabled} aria-label={'Remove ' + title.toLowerCase() + ' ' + (index + 1)}
            onClick={() => resources(key, refs.filter((_, item) => item !== index))}>Remove</button>
        </li>)}</ul>
      <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Source"><select className={input} disabled={editingDisabled} value={draft.kind}
          onChange={event => change('kind', event.target.value)}><option value="github">GitHub path</option><option value="inline">Inline content</option></select></Field>
        <Field label={draft.kind === 'github' ? 'Path' : 'Name'}><input className={input} disabled={editingDisabled}
          value={draft.kind === 'github' ? draft.path : draft.name}
          onChange={event => change(draft.kind === 'github' ? 'path' : 'name', event.target.value)}
          placeholder={draft.kind === 'github' ? 'skills/research/SKILL.md' : 'Research skill'} /></Field>
        {draft.kind === 'inline' && <div className="sm:col-span-2"><Field label="Content"><textarea className={input + ' min-h-28'} disabled={editingDisabled} value={draft.content}
          onChange={event => change('content', event.target.value)} /></Field></div>}
        <div className="sm:col-span-2"><button type="button" className={button} disabled={editingDisabled} onClick={() => addResource(key)}>Add {key === 'skills' ? 'skill' : 'tool file'}</button></div>
      </div>
      <p className="text-xs text-muted-foreground">Repository, ref, and other options are available in Advanced JSON.</p>
    </Section>
  }
  function addMcp() {
    const name = mcpName.trim()
    const target = mcpTarget.trim()
    if (!name || !target) { setError('Enter a server name and URL or command.'); return }
    if (name in (value.mcp ?? {})) { setError('A server with that name already exists.'); return }
    const server: AgentProfileMcpServer = mcpKind === 'stdio' ? { command: target } : { transport: mcpKind, url: target }
    if (emit({ ...value, mcp: { ...value.mcp, [name]: server } })) { setMcpName(''); setMcpTarget('') }
  }
  function applyJson() {
    try {
      const result = agentProfileSchema.safeParse(JSON.parse(json))
      if (!result.success) { setError(issueMessage(result.error)); return }
      setError(null)
      setJsonDirty(false)
      onChange(result.data)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid JSON') }
  }

  return <div className={'space-y-5 ' + (className ?? '')} aria-label="Agent profile editor">
    {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <Section title="Profile" description="Name the agent and set its instructions. Replacing a system prompt changes how its harness behaves.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><input className={input} disabled={editingDisabled} value={value.name ?? ''} onChange={event => emit({ ...value, name: event.target.value })} /></Field>
        <Field label="Description"><input className={input} disabled={editingDisabled} value={value.description ?? ''} onChange={event => emit({ ...value, description: event.target.value })} /></Field>
      </div>
      <Field label="Agent instructions" hint="Project-level instructions. Each entry remains separate.">
        <div className="space-y-2">{(value.prompt?.instructions ?? []).map((instruction, index) =>
          <div key={index} className="flex items-start gap-2">
            <textarea className={input + ' min-h-20'} disabled={editingDisabled} value={instruction}
              onChange={event => prompt({ ...value.prompt, instructions: (value.prompt?.instructions ?? []).map((item, i) => i === index ? event.target.value : item) })} />
            <button type="button" className={remove + ' pt-2'} disabled={editingDisabled} aria-label={'Remove instruction ' + (index + 1)}
              onClick={() => prompt({ ...value.prompt, instructions: (value.prompt?.instructions ?? []).filter((_, i) => i !== index) })}>Remove</button>
          </div>)}
          <button type="button" className={button} disabled={editingDisabled} onClick={() => prompt({ ...value.prompt, instructions: [...(value.prompt?.instructions ?? []), ''] })}>Add instruction</button>
        </div>
      </Field>
      <Field label="Append to system prompt" hint="Keeps the harness system prompt and adds this text."><textarea className={input + ' min-h-24'} disabled={editingDisabled} value={value.prompt?.appendSystemPrompt ?? ''} onChange={event => prompt({ ...value.prompt, appendSystemPrompt: event.target.value })} /></Field>
      <Field label="Replace system prompt" hint="Only use when the harness supports full replacement."><textarea className={input + ' min-h-24'} disabled={editingDisabled} value={value.prompt?.systemPrompt ?? ''} onChange={event => prompt({ ...value.prompt, systemPrompt: event.target.value })} /></Field>
    </Section>
    <Section title="Model" description="Set model preferences. The host decides which models can run.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Default model"><input className={input} disabled={editingDisabled} value={value.model?.default ?? ''} onChange={event => model({ ...value.model, default: event.target.value })} placeholder="provider/model" /></Field>
        <Field label="Small model"><input className={input} disabled={editingDisabled} value={value.model?.small ?? ''} onChange={event => model({ ...value.model, small: event.target.value })} placeholder="provider/model" /></Field>
        <Field label="Provider hint"><input className={input} disabled={editingDisabled} value={value.model?.provider ?? ''} onChange={event => model({ ...value.model, provider: event.target.value })} /></Field>
        <Field label="Thinking level"><select className={input} disabled={editingDisabled} value={value.model?.reasoningEffort ?? ''}
          onChange={event => model({ ...value.model, reasoningEffort: event.target.value ? event.target.value as NonNullable<AgentProfile['model']>['reasoningEffort'] : undefined })}>
          <option value="">Harness default</option>{['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultracode'].map(level => <option key={level} value={level}>{level}</option>)}
        </select></Field>
      </div>
    </Section>
    <Section title="Tools and permissions" description="Choose which tools are available and when each needs approval.">
      {Object.keys(value.tools ?? {}).length === 0 && <p className="text-sm text-muted-foreground">No tool rules added.</p>}
      <div className="space-y-2">{Object.entries(value.tools ?? {}).map(([name, enabled]) =>
        <div key={name} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
          <label className="flex min-w-32 flex-1 items-center gap-2"><input type="checkbox" disabled={editingDisabled} checked={enabled}
            onChange={event => emit({ ...value, tools: { ...value.tools, [name]: event.target.checked } })} />{name}</label>
          <label className="flex items-center gap-2 text-muted-foreground">Permission
            <select className="rounded-md border border-input bg-background px-2 py-1 text-foreground" disabled={editingDisabled}
              value={typeof value.permissions?.[name] === 'string' ? value.permissions[name] : ''}
              onChange={event => { const permissions = { ...value.permissions }; if (event.target.value) permissions[name] = event.target.value as 'allow' | 'ask' | 'deny'; else delete permissions[name]; emit({ ...value, permissions }) }}>
              <option value="">Default</option><option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option>
            </select>
          </label>
          <button type="button" className={remove} disabled={editingDisabled} onClick={() => { const tools = { ...value.tools }; delete tools[name]; emit({ ...value, tools }) }}>Remove</button>
        </div>)}</div>
      <div className="flex gap-2"><input aria-label="New tool name" className={input} disabled={editingDisabled} value={newTool} onChange={event => setNewTool(event.target.value)} placeholder="Tool name" />
        <button type="button" className={button} disabled={editingDisabled} onClick={() => { const name = newTool.trim(); if (!name || name in (value.tools ?? {})) { setError('Enter a unique tool name.'); return } if (emit({ ...value, tools: { ...value.tools, [name]: true } })) setNewTool('') }}>Add tool</button></div>
      <p className="text-xs text-muted-foreground">Nested permission rules remain in Advanced JSON.</p>
    </Section>
    {resourceSection('skills', 'Skills', 'Add skill packages from a repository or inline content.')}
    {resourceSection('tools', 'Tool files', 'Provide files that a supported harness can discover as tools.')}
    <Section title="MCP servers" description="Connect remote or local servers. Use secret references for credentials.">
      {Object.keys(value.mcp ?? {}).length === 0 && <p className="text-sm text-muted-foreground">No servers added.</p>}
      <ul className="space-y-2">{Object.entries(value.mcp ?? {}).map(([name, server]) =>
        <li key={name} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <div className="min-w-0"><span className="font-medium">{name}</span>
            <span className="ml-2 text-xs text-muted-foreground">{server.enabled === false ? 'Disabled' : 'command' in server ? 'Local' : 'Remote'}</span>
            {server.enabled !== false && <p className="truncate text-xs text-muted-foreground">{'command' in server ? server.command : server.url}</p>}
          </div>
          <button type="button" className={remove} disabled={editingDisabled} onClick={() => { const mcp = { ...value.mcp }; delete mcp[name]; emit({ ...value, mcp }) }}>Remove</button>
        </li>)}</ul>
      <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_10rem]">
        <Field label="Server name"><input className={input} disabled={editingDisabled} value={mcpName} onChange={event => setMcpName(event.target.value)} placeholder="search" /></Field>
        <Field label="Transport"><select className={input} disabled={editingDisabled} value={mcpKind} onChange={event => setMcpKind(event.target.value as typeof mcpKind)}><option value="http">HTTP</option><option value="sse">SSE</option><option value="stdio">Local command</option></select></Field>
        <div className="sm:col-span-2"><Field label={mcpKind === 'stdio' ? 'Command' : 'URL'}><input className={input} disabled={editingDisabled} value={mcpTarget} onChange={event => setMcpTarget(event.target.value)} placeholder={mcpKind === 'stdio' ? 'mcp-server' : 'https://example.com/mcp'} /></Field></div>
        <div className="sm:col-span-2"><button type="button" className={button} disabled={editingDisabled} onClick={addMcp}>Add server</button></div>
      </div>
      <p className="text-xs text-muted-foreground">Arguments, headers, environment, and secret references remain in Advanced JSON.</p>
    </Section>
    <Section title="Resource files" description="Mount files in the agent workspace. Edit paths and content in Advanced JSON.">
      {(value.resources?.files ?? []).length === 0 && <p className="text-sm text-muted-foreground">No files mounted.</p>}
      <ul className="space-y-2">{(value.resources?.files ?? []).map((mount, index) =>
        <li key={index} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <span className="truncate">{mount.path} <span className="text-muted-foreground">← {mount.resource.kind === 'github' ? mount.resource.path : mount.resource.name}</span></span>
          <button type="button" className={remove} disabled={editingDisabled} onClick={() => emit({ ...value, resources: { ...value.resources, files: (value.resources?.files ?? []).filter((_, i) => i !== index) } })}>Remove</button>
        </li>)}</ul>
      <button type="button" className={button} disabled={editingDisabled} onClick={() => emit({ ...value, resources: { ...value.resources, files: [...(value.resources?.files ?? []), { path: 'new-file.md', resource: { kind: 'inline', name: 'New file', content: '' } }] } })}>Add file</button>
    </Section>
    <Section title="Advanced JSON" description="Edit the full canonical profile, including hooks, modes, connections, and extensions.">
      <label htmlFor={id + '-json'} className="sr-only">Full profile JSON</label>
      <textarea id={id + '-json'} className={input + ' min-h-72 font-mono text-xs'} spellCheck={false} disabled={disabled} value={json} onChange={event => { setJson(event.target.value); setJsonDirty(true) }} />
      <div className="flex flex-wrap items-center gap-3"><button type="button" className={button} disabled={disabled || !jsonDirty} onClick={applyJson}>Apply JSON</button>
        {jsonDirty && <button type="button" className={remove} disabled={disabled} onClick={() => { setJson(JSON.stringify(value, null, 2)); setJsonDirty(false); setError(null) }}>Discard JSON edits</button>}</div>
      <p className="text-xs text-muted-foreground">Profiles are public configuration. Store credentials in a vault and reference them by secret key.</p>
    </Section>
  </div>
}
