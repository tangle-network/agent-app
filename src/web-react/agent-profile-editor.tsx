import { useEffect, useId, useState, type ReactNode } from 'react'
import type { AgentProfile, AgentProfileFileMount, AgentProfileMcpServer, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'
import { agentProfileSchema } from '@tangle-network/agent-interface/profile-schema'
import { Button, Input, Textarea, Switch, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tangle-network/sandbox-ui/primitives'

export type AgentProfileResourceKind = 'files' | 'skills' | 'tools' | 'agents' | 'commands' | 'instructions'

export interface AgentProfileEditorProps {
  value: AgentProfile
  onChange: (value: AgentProfile) => void
  disabled?: boolean
  className?: string
  /** Hide unsupported resource controls. Existing entries remain in the profile and are flagged for review. */
  allowedResourceKinds?: readonly AgentProfileResourceKind[]
  /** Require resource file workspace paths under this relative folder, for example `reference/`. */
  filePathPrefix?: string
  /** Disable new executable resource files while retaining existing values for review. Defaults to true. */
  allowExecutableFiles?: boolean
  /** Require a 40-character commit SHA for GitHub resource refs. Defaults to false. */
  requireGitHubCommitSha?: boolean
  /** Require unique skill names matching `[a-z0-9][a-z0-9._-]{0,63}`. Defaults to false. */
  requireUniqueSkillNames?: boolean
  /** Hide the generic tool and permission controls without removing stored values. Defaults to true. */
  showToolsAndPermissions?: boolean
}

const RESOURCE_KIND_LABELS: Record<AgentProfileResourceKind, string> = {
  files: 'Resource files', skills: 'Skills', tools: 'Tool files',
  agents: 'Agent files', commands: 'Command files', instructions: 'Resource instructions',
}

function configuredResourceCount(profile: AgentProfile, kind: AgentProfileResourceKind): number {
  const resource = profile.resources?.[kind]
  return Array.isArray(resource) ? resource.length : resource ? 1 : 0
}

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

function Disclosure({ title, description, detail, children }: {
  title: string; description?: string; detail?: string; children: ReactNode
}) {
  return <details className="group rounded-xl border border-border bg-card">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl p-4 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
      <span><span className="block text-base font-semibold text-foreground">{title}</span>
        {description && <span className="mt-1 block text-sm text-muted-foreground">{description}</span>}</span>
      <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
        {detail}<span aria-hidden="true" className="transition-transform group-open:rotate-180">⌄</span></span>
    </summary>
    <div className="space-y-4 border-t border-border p-4 sm:p-5">{children}</div>
  </details>
}

function issueMessage(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0]
  return issue ? (issue.path.map(String).join('.') || 'Profile') + ': ' + issue.message : 'Invalid profile'
}

interface ResourceDraft {
  kind: 'github' | 'inline'
  repository: string
  path: string
  ref: string
  name: string
  content: string
}

interface FileDraft {
  path: string
  resource: ResourceDraft
  executable: boolean
}

function emptyResourceDraft(): ResourceDraft {
  return { kind: 'github', repository: '', path: '', ref: '', name: '', content: '' }
}

function resourceDraft(ref: AgentProfileResourceRef): ResourceDraft {
  return ref.kind === 'github'
    ? { ...emptyResourceDraft(), kind: 'github', repository: ref.repository ?? '', path: ref.path, ref: ref.ref ?? '', name: ref.name ?? '' }
    : { ...emptyResourceDraft(), kind: 'inline', name: ref.name, content: ref.content }
}

function resourceRef(draft: ResourceDraft): AgentProfileResourceRef {
  return draft.kind === 'inline'
    ? { kind: 'inline', name: draft.name.trim(), content: draft.content }
    : {
      kind: 'github', repository: draft.repository.trim(), path: draft.path.trim(),
      ...(draft.ref.trim() ? { ref: draft.ref.trim() } : {}),
      ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    }
}

function validRelativePath(path: string): boolean {
  return path.length <= 240 && !path.startsWith('/') && !path.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(path) && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function normalizedFilePathPrefix(prefix?: string): string | undefined {
  const folder = prefix?.trim().replace(/\/+$/, '')
  return folder ? folder + '/' : undefined
}

function resourceError(draft: ResourceDraft, requireGitHubCommitSha = false): string | null {
  if (draft.kind === 'inline') return draft.name.trim() ? null : 'Enter a name for the inline file.'
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(draft.repository.trim())) return 'Enter a GitHub repository as owner/repo.'
  if (!draft.path.trim()) return 'Enter a path within the GitHub repository.'
  if (requireGitHubCommitSha) {
    if (draft.repository.trim().length > 200 || draft.repository.trim().split('/').some(segment => segment === '.' || segment === '..')) {
      return 'Enter a GitHub repository as owner/repo.'
    }
    if (!/^[0-9a-f]{40}$/i.test(draft.ref.trim())) return 'Enter a 40-character GitHub commit SHA.'
    if (!validRelativePath(draft.path.trim()) || /[?#%]/.test(draft.path.trim())) return 'Enter a relative repository path without traversal or URL characters.'
    if (draft.name && (!draft.name.trim() || draft.name.length > 160 || /[\u0000-\u001f\u007f]/.test(draft.name))) {
      return 'Enter a short file name without control characters.'
    }
  }
  return null
}

function skillNameError(draft: ResourceDraft, refs: readonly AgentProfileResourceRef[], index?: number): string | null {
  const name = draft.name.trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    return 'Enter a lowercase skill name of up to 64 letters, numbers, dots, dashes, or underscores.'
  }
  if (refs.some((ref, item) => item !== index && ref.name === name)) return 'A skill with that name already exists.'
  return null
}

function ResourceFields({ draft, onChange, disabled, pathPlaceholder, requireGitHubCommitSha, requireSkillName }: {
  draft: ResourceDraft
  onChange: (draft: ResourceDraft) => void
  disabled: boolean
  pathPlaceholder: string
  requireGitHubCommitSha: boolean
  requireSkillName?: boolean
}) {
  function change(field: keyof ResourceDraft, text: string) { onChange({ ...draft, [field]: text }) }
  return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Source"><Select disabled={disabled} value={draft.kind} onValueChange={kind => change('kind', kind)}>
      <SelectTrigger aria-label="Source"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="github">GitHub file</SelectItem><SelectItem value="inline">Inline content</SelectItem>
      </SelectContent></Select></Field>
    {draft.kind === 'github' ? <>
      <Field label="Repository" hint="GitHub owner/repo"><Input disabled={disabled} value={draft.repository}
        onChange={event => change('repository', event.target.value)} placeholder="owner/repo" /></Field>
      <Field label="Repository path" hint="Relative to the repository root"><Input disabled={disabled} value={draft.path}
        onChange={event => change('path', event.target.value)} placeholder={pathPlaceholder} /></Field>
      <Field label={requireGitHubCommitSha ? 'Commit SHA' : 'Ref'} hint={requireGitHubCommitSha ? 'Use the full 40-character SHA of a fixed commit.' : 'Defaults to the main branch'}>
        <Input disabled={disabled} value={draft.ref} onChange={event => change('ref', event.target.value)}
          placeholder={requireGitHubCommitSha ? '40-character commit SHA' : 'main'} /></Field>
      <Field label={requireSkillName ? 'Skill name' : 'Name'}
        hint={requireSkillName ? 'Unique lowercase name, up to 64 letters, numbers, dots, dashes, or underscores.' : 'Defaults to the source filename'}>
        <Input disabled={disabled} value={draft.name} onChange={event => change('name', event.target.value)}
          placeholder={requireSkillName ? 'research' : undefined} /></Field>
    </> : <>
      <Field label={requireSkillName ? 'Skill name' : 'File name'}
        hint={requireSkillName ? 'Unique lowercase name, up to 64 letters, numbers, dots, dashes, or underscores.' : undefined}>
        <Input disabled={disabled} value={draft.name} onChange={event => change('name', event.target.value)}
          placeholder={requireSkillName ? 'research' : 'guide.md'} /></Field>
      <div className="sm:col-span-2"><Field label="Content"><Textarea className="min-h-32 font-mono text-sm" disabled={disabled}
        value={draft.content} onChange={event => change('content', event.target.value)} /></Field></div>
    </>}
  </div>
}

function fileDraft(mount: AgentProfileFileMount): FileDraft {
  return { path: mount.path, resource: resourceDraft(mount.resource), executable: mount.executable ?? false }
}

function fileMount(draft: FileDraft): AgentProfileFileMount {
  return { path: draft.path.trim(), resource: resourceRef(draft.resource), ...(draft.executable ? { executable: true } : {}) }
}

function fileIssues(draft: FileDraft, filePathPrefix: string | undefined, allowExecutableFiles: boolean,
  requireGitHubCommitSha: boolean): string[] {
  const issues: string[] = []
  const path = draft.path.trim()
  if (!path) issues.push('Enter a workspace path for the file.')
  else if (filePathPrefix && (!path.startsWith(filePathPrefix) || !validRelativePath(path))) {
    issues.push('Enter a relative workspace path under ' + filePathPrefix + ' without traversal.')
  }
  if (!allowExecutableFiles && draft.executable) issues.push('Executable resource files are not allowed.')
  const resourceIssue = resourceError(draft.resource, requireGitHubCommitSha)
  if (resourceIssue) issues.push(resourceIssue)
  return issues
}

/** Controlled editor for the canonical profile. The product owns save and execution authority. */
export function AgentProfileEditor({ value, onChange, disabled = false, className, allowedResourceKinds,
  filePathPrefix, allowExecutableFiles = true, requireGitHubCommitSha = false, requireUniqueSkillNames = false,
  showToolsAndPermissions = true }: AgentProfileEditorProps) {
  const id = useId()
  const workspaceFilePrefix = normalizedFilePathPrefix(filePathPrefix)
  const [error, setError] = useState<string | null>(null)
  const [newTool, setNewTool] = useState('')
  const [showAllTools, setShowAllTools] = useState(false)
  const [mcpName, setMcpName] = useState('')
  const [mcpKind, setMcpKind] = useState<'http' | 'sse' | 'stdio'>('http')
  const [mcpTarget, setMcpTarget] = useState('')
  const [resourceDrafts, setResourceDrafts] = useState<Record<'skills' | 'tools', ResourceDraft>>({ skills: emptyResourceDraft(), tools: emptyResourceDraft() })
  const [resourceEdit, setResourceEdit] = useState<{ key: 'skills' | 'tools'; index: number; draft: ResourceDraft } | null>(null)
  const [newFile, setNewFile] = useState<FileDraft>(() => ({ path: normalizedFilePathPrefix(filePathPrefix) ?? '',
    resource: { ...emptyResourceDraft(), kind: 'inline' }, executable: false }))
  const [addingFile, setAddingFile] = useState(false)
  const [fileEdit, setFileEdit] = useState<{ index: number; draft: FileDraft } | null>(null)
  const [json, setJson] = useState(() => JSON.stringify(value, null, 2))
  const [jsonDirty, setJsonDirty] = useState(false)
  useEffect(() => { if (!jsonDirty) setJson(JSON.stringify(value, null, 2)) }, [value, jsonDirty])
  const editingDisabled = disabled || jsonDirty
  const allowsResource = (kind: AgentProfileResourceKind) => !allowedResourceKinds || allowedResourceKinds.includes(kind)
  const unsupportedResources = (Object.keys(RESOURCE_KIND_LABELS) as AgentProfileResourceKind[])
    .filter(kind => !allowsResource(kind) && configuredResourceCount(value, kind) > 0)
  const skills = value.resources?.skills ?? []
  const toolFiles = value.resources?.tools ?? []
  const instructions = value.resources?.instructions
  const constrainedEntryCount = workspaceFilePrefix || !allowExecutableFiles || requireGitHubCommitSha || requireUniqueSkillNames
    ? (value.resources?.files ?? []).filter(mount => fileIssues(fileDraft(mount), workspaceFilePrefix, allowExecutableFiles, requireGitHubCommitSha).length > 0).length +
      skills.filter((ref, index) => resourceIssue('skills', resourceDraft(ref), skills, index)).length +
      toolFiles.filter((ref, index) => requireGitHubCommitSha && resourceIssue('tools', resourceDraft(ref), toolFiles, index)).length +
      Number(Boolean(requireGitHubCommitSha && instructions && typeof instructions === 'object' && resourceError(resourceDraft(instructions), true)))
    : 0

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
  function resourceIssue(key: 'skills' | 'tools', draft: ResourceDraft,
    refs: readonly AgentProfileResourceRef[], index?: number): string | null {
    if (key === 'skills' && requireUniqueSkillNames) {
      const issue = skillNameError(draft, refs, index)
      if (issue) return issue
    }
    return resourceError(draft, requireGitHubCommitSha)
  }
  function addResource(key: 'skills' | 'tools') {
    const draft = resourceDrafts[key]
    const refs = value.resources?.[key] ?? []
    const issue = resourceIssue(key, draft, refs)
    if (issue) { setError(issue); return }
    if (!resources(key, [...refs, resourceRef(draft)])) return
    setResourceDrafts(current => ({ ...current, [key]: emptyResourceDraft() }))
  }
  function applyResourceEdit() {
    if (!resourceEdit) return
    const { key, index, draft } = resourceEdit
    const refs = value.resources?.[key] ?? []
    if (!refs[index]) { setError('This resource changed. Reopen it to edit.'); setResourceEdit(null); return }
    const issue = resourceIssue(key, draft, refs, index)
    if (issue) { setError(issue); return }
    if (resources(key, refs.map((ref, item) => item === index ? resourceRef(draft) : ref))) setResourceEdit(null)
  }
  function saveFile(draft: FileDraft, index?: number) {
    const path = draft.path.trim()
    const issue = fileIssues(draft, workspaceFilePrefix, allowExecutableFiles, requireGitHubCommitSha)[0]
    if (issue) { setError(issue); return false }
    const files = value.resources?.files ?? []
    if (files.some((file, item) => file.path === path && item !== index)) {
      setError('A resource file already uses that workspace path.')
      return false
    }
    const next = index === undefined ? [...files, fileMount(draft)] : files.map((file, item) => item === index ? fileMount(draft) : file)
    return emit({ ...value, resources: { ...value.resources, files: next } })
  }
  function fileFields(draft: FileDraft, onChange: (draft: FileDraft) => void) {
    return <div className="space-y-3">
      <Field label="Workspace path" hint={workspaceFilePrefix ? 'Place this file under ' + workspaceFilePrefix : 'Relative to the agent workspace'}>
        <Input disabled={editingDisabled} value={draft.path} onChange={event => onChange({ ...draft, path: event.target.value })}
          placeholder={workspaceFilePrefix ? workspaceFilePrefix + 'guide.md' : 'docs/guide.md'} /></Field>
      <ResourceFields draft={draft.resource} disabled={editingDisabled} pathPlaceholder="docs/guide.md" requireGitHubCommitSha={requireGitHubCommitSha}
        onChange={resource => onChange({ ...draft, resource })} />
      {allowExecutableFiles || draft.executable ? <label className="flex items-center gap-2 text-sm text-foreground">
        <Switch disabled={editingDisabled || (!allowExecutableFiles && !draft.executable)} checked={draft.executable}
          onCheckedChange={executable => { if (allowExecutableFiles || !executable) onChange({ ...draft, executable }) }} />Executable file</label>
        : <p className="text-xs text-muted-foreground">Executable files are unavailable for this profile.</p>}
    </div>
  }
  function resourceSection(key: 'skills' | 'tools', title: string, description: string) {
    const refs = value.resources?.[key] ?? []
    const draft = resourceDrafts[key]
    return <Disclosure title={title} description={description} detail={refs.length ? refs.length + ' configured' : 'Optional'}>
      {refs.length === 0 && <p className="text-sm text-muted-foreground">None configured.</p>}
      <ul className="space-y-2">{refs.map((ref, index) => {
        const issue = resourceIssue(key, resourceDraft(ref), refs, index)
        return <li key={index} className="space-y-3 rounded-lg border border-border p-3 text-sm" aria-label={title + ' ' + (index + 1)}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><span className="block break-words font-medium text-foreground">{ref.name || (ref.kind === 'github' ? ref.path : 'Inline resource')}</span>
              <span className={'block break-words text-xs ' + (ref.kind === 'github' && !ref.repository ? 'text-destructive' : 'text-muted-foreground')}>{ref.kind === 'github'
                ? (ref.repository ? ref.repository + ' / ' : 'Repository required · ') + ref.path + (ref.ref ? ' @ ' + ref.ref : '')
                : 'Inline content'}</span></div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" disabled={editingDisabled} aria-label={'Edit ' + title.toLowerCase() + ' ' + (index + 1)}
                onClick={() => setResourceEdit({ key, index, draft: resourceDraft(ref) })}>Edit</Button>
              <Button type="button" variant="ghost" className="text-destructive" disabled={editingDisabled} aria-label={'Remove ' + title.toLowerCase() + ' ' + (index + 1)}
                onClick={() => { if (resources(key, refs.filter((_, item) => item !== index))) setResourceEdit(null) }}>Remove</Button>
            </div>
          </div>
          {(requireGitHubCommitSha || (key === 'skills' && requireUniqueSkillNames)) && issue &&
            <p className="text-xs text-destructive">{issue} Edit this resource before saving.</p>}
          {resourceEdit?.key === key && resourceEdit.index === index && <div className="space-y-3 border-t border-border pt-3">
            <ResourceFields draft={resourceEdit.draft} disabled={editingDisabled} requireGitHubCommitSha={requireGitHubCommitSha}
              requireSkillName={key === 'skills' && requireUniqueSkillNames} pathPlaceholder={key === 'skills' ? 'research/SKILL.md' : 'tools/search.ts'}
              onChange={next => setResourceEdit({ key, index, draft: next })} />
            <div className="flex gap-2"><Button type="button" variant="outline" disabled={editingDisabled} onClick={applyResourceEdit}>Apply changes</Button>
              <Button type="button" variant="ghost" onClick={() => setResourceEdit(null)}>Cancel</Button></div>
          </div>}
        </li>})}</ul>
      <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
        <ResourceFields draft={draft} disabled={editingDisabled} requireGitHubCommitSha={requireGitHubCommitSha}
          requireSkillName={key === 'skills' && requireUniqueSkillNames} pathPlaceholder={key === 'skills' ? 'research/SKILL.md' : 'tools/search.ts'}
          onChange={next => setResourceDrafts(current => ({ ...current, [key]: next }))} />
        <Button type="button" variant="outline" disabled={editingDisabled} onClick={() => addResource(key)}>Add {key === 'skills' ? 'skill' : 'tool file'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">GitHub files are fetched when the profile runs. Saving does not verify their contents or availability.</p>
    </Disclosure>
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
    {jsonDirty && <p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">Apply or discard edits in Advanced JSON before using the other fields.</p>}
    {unsupportedResources.length > 0 && <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
      This profile contains resources this product does not support: {unsupportedResources.map(kind => RESOURCE_KIND_LABELS[kind] + ' (' + configuredResourceCount(value, kind) + ')').join(', ')}.
      They remain in the profile. Review or remove them in Advanced JSON before saving.
    </p>}
    {constrainedEntryCount > 0 && <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
      {constrainedEntryCount} configured resource {constrainedEntryCount === 1 ? 'entry needs' : 'entries need'} repair before this product can save the profile.
      Review the resource sections or Advanced JSON. Existing values remain unchanged until you edit them.
    </p>}
    <Section title="Profile" description="Name the agent and set its instructions.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><Input disabled={editingDisabled} value={value.name ?? ''} onChange={event => emit({ ...value, name: event.target.value })} /></Field>
        <Field label="Description"><Input disabled={editingDisabled} value={value.description ?? ''} onChange={event => emit({ ...value, description: event.target.value })} /></Field>
      </div>
      <div role="group" aria-label="Agent instructions" className="space-y-2">
        <p className="text-sm font-medium text-foreground">Agent instructions</p>
        <p className="text-xs text-muted-foreground">Project-level instructions. Each entry remains separate.</p>
        <div className="space-y-2">{(value.prompt?.instructions ?? []).map((instruction, index) =>
          <div key={index} className="flex items-start gap-2">
            <Textarea aria-label={'Instruction ' + (index + 1)} className="min-h-20" disabled={editingDisabled} value={instruction}
              onChange={event => prompt({ ...value.prompt, instructions: (value.prompt?.instructions ?? []).map((item, i) => i === index ? event.target.value : item) })} />
            <Button type="button" variant="ghost" className="pt-2 text-destructive" disabled={editingDisabled} aria-label={'Remove instruction ' + (index + 1)}
              onClick={() => prompt({ ...value.prompt, instructions: (value.prompt?.instructions ?? []).filter((_, i) => i !== index) })}>Remove</Button>
          </div>)}
          <Button type="button" variant="outline" disabled={editingDisabled} onClick={() => prompt({ ...value.prompt, instructions: [...(value.prompt?.instructions ?? []), ''] })}>Add instruction</Button>
        </div>
      </div>
      <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer font-medium text-foreground">System prompt overrides</summary>
        <div className="mt-4 space-y-4">
          <Field label="Append to system prompt" hint="Keeps the harness system prompt and adds this text."><Textarea className="min-h-24" disabled={editingDisabled} value={value.prompt?.appendSystemPrompt ?? ''} onChange={event => prompt({ ...value.prompt, appendSystemPrompt: event.target.value })} /></Field>
          <Field label="Replace system prompt" hint="Only use when the harness supports full replacement."><Textarea className="min-h-24" disabled={editingDisabled} value={value.prompt?.systemPrompt ?? ''} onChange={event => prompt({ ...value.prompt, systemPrompt: event.target.value })} /></Field>
        </div>
      </details>
    </Section>
    <Section title="Model" description="Set model preferences. The host decides which models can run.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Default model"><Input disabled={editingDisabled} value={value.model?.default ?? ''} onChange={event => model({ ...value.model, default: event.target.value })} placeholder="provider/model" /></Field>
      </div>
      <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer font-medium text-foreground">More model settings</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Small model"><Input disabled={editingDisabled} value={value.model?.small ?? ''} onChange={event => model({ ...value.model, small: event.target.value })} placeholder="provider/model" /></Field>
        <Field label="Provider hint"><Input disabled={editingDisabled} value={value.model?.provider ?? ''} onChange={event => model({ ...value.model, provider: event.target.value })} /></Field>
        <Field label="Thinking level"><Select disabled={editingDisabled} value={value.model?.reasoningEffort ?? 'default'}
          onValueChange={level => model({ ...value.model, reasoningEffort: level === 'default' ? undefined : level as NonNullable<AgentProfile['model']>['reasoningEffort'] })}>
          <SelectTrigger aria-label="Thinking level"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="default">Harness default</SelectItem>
            {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultracode'].map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}
          </SelectContent></Select></Field>
        </div>
      </details>
    </Section>
    {showToolsAndPermissions && <Disclosure title="Tools and permissions" description="Choose which tools are available and when each needs approval." detail={Object.keys(value.tools ?? {}).length + ' configured'}>
      {Object.keys(value.tools ?? {}).length === 0 && <p className="text-sm text-muted-foreground">No tool rules added.</p>}
      <div className="space-y-2">{Object.entries(value.tools ?? {}).slice(0, showAllTools ? undefined : 4).map(([name, enabled]) =>
        <div key={name} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
          <label className="flex min-w-32 flex-1 items-center gap-2"><Switch disabled={editingDisabled} checked={enabled}
            onCheckedChange={checked => emit({ ...value, tools: { ...value.tools, [name]: checked } })} />{name}</label>
          <div className="flex min-w-36 items-center gap-2 text-muted-foreground"><span>Permission</span>
            <Select disabled={editingDisabled} value={typeof value.permissions?.[name] === 'string' ? value.permissions[name] as string : 'default'}
              onValueChange={permission => { const permissions = { ...value.permissions }; if (permission !== 'default') permissions[name] = permission as 'allow' | 'ask' | 'deny'; else delete permissions[name]; emit({ ...value, permissions }) }}>
              <SelectTrigger aria-label={'Permission for ' + name}><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="default">Default</SelectItem><SelectItem value="allow">Allow</SelectItem>
                <SelectItem value="ask">Ask</SelectItem><SelectItem value="deny">Deny</SelectItem>
              </SelectContent></Select>
          </div>
          <Button type="button" variant="ghost" className="text-destructive" disabled={editingDisabled} onClick={() => { const tools = { ...value.tools }; delete tools[name]; emit({ ...value, tools }) }}>Remove</Button>
        </div>)}</div>
      {Object.keys(value.tools ?? {}).length > 4 && <Button type="button" variant="ghost" onClick={() => setShowAllTools(current => !current)}>
        {showAllTools ? 'Show fewer rules' : 'Show ' + (Object.keys(value.tools ?? {}).length - 4) + ' more rules'}
      </Button>}
      <div className="flex gap-2"><Input aria-label="New tool name" disabled={editingDisabled} value={newTool} onChange={event => setNewTool(event.target.value)} placeholder="Tool name" />
        <Button type="button" variant="outline" disabled={editingDisabled} onClick={() => { const name = newTool.trim(); if (!name || name in (value.tools ?? {})) { setError('Enter a unique tool name.'); return } if (emit({ ...value, tools: { ...value.tools, [name]: true } })) setNewTool('') }}>Add tool</Button></div>
      <p className="text-xs text-muted-foreground">Nested permission rules remain in Advanced JSON.</p>
    </Disclosure>}
    {allowsResource('skills') && resourceSection('skills', 'Skills', 'Add skill packages from a repository or inline content.')}
    {allowsResource('tools') && resourceSection('tools', 'Tool files', 'Provide files that a supported harness can discover as tools.')}
    <Disclosure title="MCP servers" description="Configure remote or local servers. Use secret references for credentials." detail={Object.keys(value.mcp ?? {}).length + ' configured'}>
      {Object.keys(value.mcp ?? {}).length === 0 && <p className="text-sm text-muted-foreground">No servers configured.</p>}
      <ul className="space-y-2">{Object.entries(value.mcp ?? {}).map(([name, server]) =>
        <li key={name} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <div className="min-w-0"><span className="font-medium">{name}</span>
            <span className="ml-2 text-xs text-muted-foreground">{server.enabled === false ? 'Disabled' : 'command' in server ? 'Local' : 'Remote'}</span>
            {server.enabled !== false && <p className="truncate text-xs text-muted-foreground">{'command' in server ? server.command : server.url}</p>}
          </div>
          <Button type="button" variant="ghost" className="text-destructive" disabled={editingDisabled} onClick={() => { const mcp = { ...value.mcp }; delete mcp[name]; emit({ ...value, mcp }) }}>Remove</Button>
        </li>)}</ul>
      <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_10rem]">
        <Field label="Server name"><Input disabled={editingDisabled} value={mcpName} onChange={event => setMcpName(event.target.value)} placeholder="search" /></Field>
        <Field label="Transport"><Select disabled={editingDisabled} value={mcpKind} onValueChange={kind => setMcpKind(kind as typeof mcpKind)}>
          <SelectTrigger aria-label="Transport"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="http">HTTP</SelectItem><SelectItem value="sse">SSE</SelectItem>
            <SelectItem value="stdio">Local command</SelectItem>
          </SelectContent></Select></Field>
        <div className="sm:col-span-2"><Field label={mcpKind === 'stdio' ? 'Command' : 'URL'}><Input disabled={editingDisabled} value={mcpTarget} onChange={event => setMcpTarget(event.target.value)} placeholder={mcpKind === 'stdio' ? 'mcp-server' : 'https://example.com/mcp'} /></Field></div>
        <div className="sm:col-span-2"><Button type="button" variant="outline" disabled={editingDisabled} onClick={addMcp}>Add server</Button></div>
      </div>
      <p className="text-xs text-muted-foreground">Arguments, headers, environment, and secret references remain in Advanced JSON.</p>
    </Disclosure>
    {allowsResource('files') && <Disclosure title="Resource files" description="Configure files for the agent workspace. The runtime determines whether it can place them." detail={(value.resources?.files ?? []).length + ' configured'}>
      {(value.resources?.files ?? []).length === 0 && <p className="text-sm text-muted-foreground">No resource files configured.</p>}
      <ul className="space-y-2">{(value.resources?.files ?? []).map((mount, index) => {
        const issues = fileIssues(fileDraft(mount), workspaceFilePrefix, allowExecutableFiles, requireGitHubCommitSha)
        return <li key={index} className="space-y-3 rounded-lg border border-border p-3 text-sm" aria-label={'Resource file ' + (index + 1)}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><span className="block break-words font-medium text-foreground">{mount.path}</span>
              <span className={'block break-words text-xs ' + (mount.resource.kind === 'github' && !mount.resource.repository ? 'text-destructive' : 'text-muted-foreground')}>{mount.resource.kind === 'github'
                ? (mount.resource.repository ? mount.resource.repository + ' / ' : 'Repository required · ') + mount.resource.path + (mount.resource.ref ? ' @ ' + mount.resource.ref : '')
                : 'Inline · ' + mount.resource.name}{mount.executable ? ' · executable' : ''}</span></div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" disabled={editingDisabled} aria-label={'Edit resource file ' + (index + 1)}
                onClick={() => setFileEdit({ index, draft: fileDraft(mount) })}>Edit</Button>
              <Button type="button" variant="ghost" className="text-destructive" disabled={editingDisabled} aria-label={'Remove resource file ' + (index + 1)}
                onClick={() => { if (emit({ ...value, resources: { ...value.resources, files: (value.resources?.files ?? []).filter((_, item) => item !== index) } })) setFileEdit(null) }}>Remove</Button>
            </div>
          </div>
          {issues.length > 0 && <div className="space-y-1 text-xs text-destructive">
            {issues.map(issue => <p key={issue}>{issue} Edit this file before saving.</p>)}
          </div>}
          {mount.resource.kind === 'inline' && fileEdit?.index !== index && <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs text-muted-foreground">{mount.resource.content || '(Empty file)'}</pre>}
          {fileEdit?.index === index && <div className="space-y-3 border-t border-border pt-3">
            {fileFields(fileEdit.draft, draft => setFileEdit({ index, draft }))}
            <div className="flex gap-2"><Button type="button" variant="outline" disabled={editingDisabled}
              onClick={() => { if (saveFile(fileEdit.draft, index)) setFileEdit(null) }}>Apply changes</Button>
              <Button type="button" variant="ghost" onClick={() => setFileEdit(null)}>Cancel</Button></div>
          </div>}
        </li>})}</ul>
      {addingFile ? <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
        {fileFields(newFile, setNewFile)}
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={editingDisabled}
          onClick={() => { if (saveFile(newFile)) { setNewFile({ path: workspaceFilePrefix ?? '', resource: { ...emptyResourceDraft(), kind: 'inline' }, executable: false }); setAddingFile(false) } }}>Add file</Button>
          <Button type="button" variant="ghost" onClick={() => setAddingFile(false)}>Cancel</Button></div>
      </div> : <Button type="button" variant="outline" disabled={editingDisabled} onClick={() => setAddingFile(true)}>Add file</Button>}
    </Disclosure>}
    <Disclosure title="Advanced JSON" description="Edit the full canonical profile, including hooks, modes, connections, and extensions.">
      <label htmlFor={id + '-json'} className="sr-only">Full profile JSON</label>
      <Textarea id={id + '-json'} className="min-h-72 font-mono text-xs" spellCheck={false} disabled={disabled} value={json} onChange={event => { setJson(event.target.value); setJsonDirty(true) }} />
      <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={disabled || !jsonDirty} onClick={applyJson}>Apply JSON</Button>
        {jsonDirty && <Button type="button" variant="ghost" className="text-destructive" disabled={disabled} onClick={() => { setJson(JSON.stringify(value, null, 2)); setJsonDirty(false); setError(null) }}>Discard JSON edits</Button>}</div>
      <p className="text-xs text-muted-foreground">Profiles are public configuration. Store credentials in a vault and reference them by secret key.</p>
    </Disclosure>
  </div>
}
