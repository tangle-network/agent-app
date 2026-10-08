import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { AgentProfile, AgentProfileFileMount, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'
import { REASONING_EFFORTS } from '@tangle-network/agent-interface/profile'
import { reasoningEffortsFor } from '@tangle-network/agent-interface/harness-capabilities'
import { agentProfileSchema } from '@tangle-network/agent-interface/profile-schema'
import { Button, Input, Textarea, Switch, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tangle-network/sandbox-ui/primitives'
import { TooltipProvider } from '@tangle-network/ui/primitives'
import { isModelCompatibleWithHarness, snapModelToHarness, type Harness } from '../harness'
import type { CatalogModel } from '../runtime/model-catalog'
import { publicHttpsUrlProblem, readSkillFrontmatter, type GitHubSourceCheck, type ProfileEditorGitHubPort, type ProfileEditorMcpPort } from '../profile-editor'
import { EffortPicker, effortLevelsFromIds, ModelPicker, type EffortLevel } from './controls'
import { HarnessPicker } from './agent-session-controls'
import type { AgentProfileRegistryPort } from './agent-profile-registry'
import { AgentProfileRegistrySkillSearch } from './agent-profile-registry-search'
import { Field, fieldMessageId, formRow, formText, listRow, noAutofill, Notice, rowActions as rowActionsClass, Section, StatusLine } from './agent-profile-form-kit'
import { GitHubSourcePicker } from './agent-profile-github-source'
import { McpServersEditor } from './agent-profile-mcp-servers'
import { ResourceFileDrop, type ResourceFileLimits } from './agent-profile-files'

export type AgentProfileResourceKind = 'files' | 'skills' | 'tools' | 'agents' | 'commands' | 'instructions'

/** Editor sections a product can offer, in display order. */
export type AgentProfileEditorSection = 'identity' | 'prompts' | 'model' | 'tools' | 'skills' | 'toolFiles' | 'mcp' | 'files' | 'advanced'

export const AGENT_PROFILE_EDITOR_SECTIONS: readonly AgentProfileEditorSection[] =
  ['identity', 'prompts', 'model', 'tools', 'skills', 'toolFiles', 'mcp', 'files', 'advanced']

export interface AgentProfileEditorSaveState {
  /** Internal JSON, resource, or tool edits have not been applied to the profile. */
  pending: boolean
  /** Validation failed or stored values violate this editor's constraints. */
  invalid: boolean
}

/** The model catalog the selectors offer: the same list the product's chat composer uses. */
export interface AgentProfileEditorModelCatalog {
  models: CatalogModel[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  /** Label for an empty model setting, for example "Product default". */
  defaultLabel?: string
}

/**
 * What a product offers in the editor. Every part is optional; an omitted part
 * falls back to the plain control or hides the section.
 */
export interface AgentProfileEditorConfig {
  /** Sections to show, in the editor's fixed order. Defaults to every section the other props allow. */
  sections?: readonly AgentProfileEditorSection[]
  identity?: {
    /** False when the product fixes the profile name. Defaults to true. */
    nameEditable?: boolean
  }
  /** Catalog-backed model selectors. Without it, model fields are plain text inputs. */
  models?: AgentProfileEditorModelCatalog
  /** Harnesses the product runs. Omit to hide the harness selector. */
  harnesses?: readonly Harness[]
  /** Thinking levels for a harness and model. Defaults to the levels that harness applies, plus Auto. */
  thinkingLevels?: (input: { harness?: Harness; model?: CatalogModel }) => readonly EffortLevel[]
  /** GitHub sources through the product's checks. Without it, GitHub sources are typed by hand. */
  github?: {
    port: ProfileEditorGitHubPort
    /**
     * `reference` stores `{ kind: 'github', repository, path, ref }` pinned to the
     * checked commit. `inline` stores the checked file's text, for products that
     * do not fetch GitHub at run time.
     */
    storage: 'reference' | 'inline'
    /** Where the person connects GitHub, shown when the workspace has no connection. */
    connectHref?: string
  }
  mcp?: {
    /** Health checks; each enabled remote server is checked automatically. */
    port?: ProfileEditorMcpPort
    /** Explain why servers are read-only here. Presence locks toggles and edits. */
    lockReason?: string
    /** Offer local command servers. Defaults to true unless `publicHttpsMcpOnly` is set. */
    allowLocalCommand?: boolean
  }
  /** Limits for uploaded resource files. */
  files?: ResourceFileLimits
}

export interface AgentProfileEditorProps {
  value: AgentProfile
  onChange: (value: AgentProfile) => void
  /** Disable the host's save action while edits are pending or invalid. */
  onSaveStateChange?: (state: AgentProfileEditorSaveState) => void
  disabled?: boolean
  className?: string
  /** Product configuration: sections, model catalog, harnesses, and source checks. */
  config?: AgentProfileEditorConfig
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
  /** Offer only public HTTPS MCP endpoints while retaining existing servers for review. Defaults to false. */
  publicHttpsMcpOnly?: boolean
  /** Host-supplied registry discovery (agent-app#776). Omit to hide catalog search entirely. */
  registry?: AgentProfileRegistryPort
}

const RESOURCE_KIND_LABELS: Record<AgentProfileResourceKind, string> = {
  files: 'Resource files', skills: 'Skills', tools: 'Tool files',
  agents: 'Agent files', commands: 'Command files', instructions: 'Resource instructions',
}

function configuredResourceCount(profile: AgentProfile, kind: AgentProfileResourceKind): number {
  const resource = profile.resources?.[kind]
  return Array.isArray(resource) ? resource.length : resource ? 1 : 0
}

function issueMessage(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0]
  return issue ? (issue.path.map(String).join('.') || 'Profile') + ': ' + issue.message : 'Invalid profile'
}

function validRelativePath(path: string): boolean {
  return path.length <= 240 && !path.startsWith('/') && !path.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(path) && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function normalizedFilePathPrefix(prefix?: string): string | undefined {
  const folder = prefix?.trim().replace(/\/+$/, '')
  return folder ? folder + '/' : undefined
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Problems with a stored or drafted GitHub reference under the product's constraints. */
function githubRefIssue(ref: AgentProfileResourceRef, requireGitHubCommitSha: boolean): string | null {
  if (ref.kind !== 'github') return null
  const repository = ref.repository ?? ''
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) {
    return 'Choose the GitHub repository for this file.'
  }
  if (!ref.path) return 'Choose a file in the repository.'
  if (requireGitHubCommitSha) {
    if (!/^[0-9a-f]{40}$/i.test(ref.ref ?? '')) return 'Pin this source to a 40-character GitHub commit SHA.'
    if (!validRelativePath(ref.path) || /[?#%]/.test(ref.path)) return 'Use a relative repository path without traversal or URL characters.'
  }
  return null
}

function inlineSkillSummary(content: string): string | null {
  const frontmatter = readSkillFrontmatter(content)
  if (frontmatter.ok) return frontmatter.description
  const line = content.split('\n').map(text => text.replace(/^#+\s*/, '').trim()).find(Boolean)
  return line ? line.slice(0, 160) : null
}

function sourceLine(ref: AgentProfileResourceRef): string {
  if (ref.kind === 'inline') return `Written here · ${Math.max(1, Math.round(new TextEncoder().encode(ref.content).byteLength / 1024))} KB`
  return ['GitHub', ref.repository ? `${ref.repository}/${ref.path}` : ref.path, ref.ref ? `@ ${ref.ref.slice(0, 7)}` : null].filter(Boolean).join(' · ')
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** A suggested skill name from frontmatter or the skill folder. */
function suggestedSkillName(check: GitHubSourceCheck): string {
  const fromFrontmatter = check.skill?.name ?? ''
  const folder = check.path.split('/').slice(-2, -1)[0] ?? ''
  const raw = fromFrontmatter || folder || basename(check.path).replace(/\.md$/i, '')
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64)
}

function defaultThinkingLevels({ harness, model }: { harness?: Harness; model?: CatalogModel }): readonly EffortLevel[] {
  const efforts = harness ? reasoningEffortsFor(harness, { supportsReasoning: model?.supportsReasoning !== false }) : REASONING_EFFORTS
  return [{ id: 'auto', label: 'Auto' }, ...effortLevelsFromIds(efforts)]
}

type Panel =
  | { kind: 'add-github' | 'add-inline'; section: 'skills' | 'tools' | 'files' }
  | { kind: 'edit'; section: 'skills' | 'tools' | 'files'; index: number }

interface InlineDraft { name: string; content: string; path: string; executable: boolean }

/** Controlled editor for the canonical profile. The product owns save and execution authority. */
export function AgentProfileEditor({ value, onChange, disabled = false, className, config, allowedResourceKinds,
  filePathPrefix, allowExecutableFiles = true, requireGitHubCommitSha = false, requireUniqueSkillNames = false,
  showToolsAndPermissions = true, publicHttpsMcpOnly = false, registry, onSaveStateChange }: AgentProfileEditorProps) {
  const id = useId()
  const workspaceFilePrefix = normalizedFilePathPrefix(filePathPrefix)
  const [error, setError] = useState<string | null>(null)
  const [newTool, setNewTool] = useState('')
  const [showAllTools, setShowAllTools] = useState(false)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [inlineDraft, setInlineDraft] = useState<InlineDraft>({ name: '', content: '', path: '', executable: false })
  const [githubName, setGithubName] = useState<{ value: string; touched: boolean }>({ value: '', touched: false })
  const [mcpPending, setMcpPending] = useState(false)
  const [modelNotice, setModelNotice] = useState<string | null>(null)
  const [json, setJson] = useState(() => JSON.stringify(value, null, 2))
  const [jsonDirty, setJsonDirty] = useState(false)
  useEffect(() => { if (!jsonDirty) setJson(JSON.stringify(value, null, 2)) }, [value, jsonDirty])
  const editingDisabled = disabled || jsonDirty

  const sectionAllowed = (section: AgentProfileEditorSection) => !config?.sections || config.sections.includes(section)
  const allowsResource = (kind: AgentProfileResourceKind) => !allowedResourceKinds || allowedResourceKinds.includes(kind)
  const show = {
    identity: sectionAllowed('identity'),
    prompts: sectionAllowed('prompts'),
    model: sectionAllowed('model'),
    tools: sectionAllowed('tools') && showToolsAndPermissions,
    skills: sectionAllowed('skills') && allowsResource('skills'),
    toolFiles: sectionAllowed('toolFiles') && allowsResource('tools'),
    mcp: sectionAllowed('mcp'),
    files: sectionAllowed('files') && allowsResource('files'),
    advanced: sectionAllowed('advanced'),
  }
  const unsupportedResources = (Object.keys(RESOURCE_KIND_LABELS) as AgentProfileResourceKind[])
    .filter(kind => configuredResourceCount(value, kind) > 0 && !(
      (kind === 'skills' && show.skills) || (kind === 'tools' && show.toolFiles) || (kind === 'files' && show.files) ||
      (allowsResource(kind) && kind !== 'skills' && kind !== 'tools' && kind !== 'files')))
  const skills = value.resources?.skills ?? []
  const toolFiles = value.resources?.tools ?? []
  const files = value.resources?.files ?? []
  const instructions = value.resources?.instructions

  function skillIssue(ref: AgentProfileResourceRef, refs: readonly AgentProfileResourceRef[], index?: number): string | null {
    if (requireUniqueSkillNames) {
      const name = ref.name ?? ''
      if (!SKILL_NAME.test(name)) return 'Use a lowercase name of up to 64 letters, numbers, dots, dashes, or underscores.'
      if (refs.some((other, item) => item !== index && other.name === name)) return 'Another skill already uses this name.'
    }
    if (ref.kind === 'inline' && !ref.name.trim()) return 'Name this skill.'
    return githubRefIssue(ref, requireGitHubCommitSha)
  }
  function fileIssue(mount: AgentProfileFileMount, index?: number): string | null {
    const path = mount.path
    if (!path.trim()) return 'Enter a workspace path for the file.'
    if (!validRelativePath(path)) return 'Use a relative workspace path without traversal.'
    if (workspaceFilePrefix && !path.startsWith(workspaceFilePrefix)) return `Place this file under ${workspaceFilePrefix}.`
    if (files.some((other, item) => item !== index && other.path === path)) return 'Another file already uses this path.'
    if (!allowExecutableFiles && mount.executable) return 'Executable files are not allowed in this product.'
    if (mount.resource.kind === 'inline' && !mount.resource.name.trim()) return 'Name this file.'
    return githubRefIssue(mount.resource, requireGitHubCommitSha)
  }
  const constrainedEntryCount = workspaceFilePrefix || !allowExecutableFiles || requireGitHubCommitSha || requireUniqueSkillNames
    ? files.filter((mount, index) => fileIssue(mount, index)).length +
      skills.filter((ref, index) => skillIssue(ref, skills, index)).length +
      toolFiles.filter(ref => requireGitHubCommitSha && githubRefIssue(ref, true)).length +
      Number(Boolean(requireGitHubCommitSha && instructions && typeof instructions === 'object' && githubRefIssue(instructions, true)))
    : 0
  const invalidMcpCount = publicHttpsMcpOnly
    ? Object.values(value.mcp ?? {}).filter(server => server.enabled !== false &&
      (!('url' in server) || !server.url || publicHttpsUrlProblem(server.url) !== null)).length : 0

  const pending = jsonDirty || panel !== null || mcpPending || Boolean(newTool.trim())
  const invalid = Boolean(error || unsupportedResources.length || constrainedEntryCount || invalidMcpCount)
  useEffect(() => { onSaveStateChange?.({ pending, invalid }) }, [onSaveStateChange, pending, invalid])
  useEffect(() => () => { onSaveStateChange?.({ pending: false, invalid: false }) }, [onSaveStateChange])

  function emit(next: AgentProfile) {
    if (jsonDirty) { setError('Apply or discard JSON edits first.'); return false }
    const result = agentProfileSchema.safeParse(next)
    if (!result.success) { setError(issueMessage(result.error)); return false }
    setError(null)
    onChange(result.data)
    return true
  }
  function prompt(next: NonNullable<AgentProfile['prompt']>) { emit({ ...value, prompt: next }) }
  function model(next: NonNullable<AgentProfile['model']>) {
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, item]) => item !== undefined && item !== '')) as NonNullable<AgentProfile['model']>
    const { model: _model, ...rest } = value
    emit(Object.keys(cleaned).length ? { ...rest, model: cleaned } : rest)
  }
  function resources(key: 'skills' | 'tools', refs: AgentProfileResourceRef[]) {
    return emit({ ...value, resources: { ...value.resources, [key]: refs } })
  }
  function setFiles(next: AgentProfileFileMount[]) {
    return emit({ ...value, resources: { ...value.resources, files: next } })
  }
  function openPanel(next: Panel | null) {
    setPanel(next)
    setError(null)
    setGithubName({ value: '', touched: false })
    if (next?.kind === 'edit') {
      const ref = next.section === 'files' ? files[next.index]?.resource : (next.section === 'skills' ? skills : toolFiles)[next.index]
      const mount = next.section === 'files' ? files[next.index] : undefined
      setInlineDraft({ name: ref?.kind === 'inline' ? ref.name : ref?.name ?? '', content: ref?.kind === 'inline' ? ref.content : '',
        path: mount?.path ?? '', executable: mount?.executable ?? false })
    } else {
      setInlineDraft({ name: '', content: '', path: next?.section === 'files' ? workspaceFilePrefix ?? '' : '', executable: false })
    }
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

  // ── Model and runtime ─────────────────────────────────────────────────────
  const catalog = config?.models
  // The stored harness, even when the product's list omits it, so the selector reports what will run.
  const harness = value.harness as Harness | undefined
  const offeredModels = useMemo(() => !catalog ? [] : harness
    ? catalog.models.filter(item => isModelCompatibleWithHarness(harness, item.id))
    : catalog.models, [catalog, harness])
  const selectedModel = catalog?.models.find(item => item.id === value.model?.default)
  const thinkingLevels = (config?.thinkingLevels ?? defaultThinkingLevels)({ harness, model: selectedModel })
  function changeHarness(next: Harness | '') {
    setModelNotice(null)
    const { harness: _harness, ...rest } = value
    let nextModel = value.model
    if (next && catalog && value.model?.default && !isModelCompatibleWithHarness(next, value.model.default)) {
      const ids = catalog.models.map(item => item.id)
      const snapped = snapModelToHarness(next, value.model.default, ids)
      if (snapped !== value.model.default) {
        nextModel = { ...value.model, default: snapped }
        const name = catalog.models.find(item => item.id === snapped)?.name ?? snapped
        setModelNotice(`Default model changed to ${name}, which runs on this harness.`)
      }
    }
    emit({ ...rest, ...(next ? { harness: next } : {}), ...(nextModel ? { model: nextModel } : {}) })
  }
  function modelField(label: string, field: 'default' | 'small', info: ReactNode) {
    const fieldId = `${id}-model-${field}`
    const current = value.model?.[field] ?? ''
    return <Field label={label} htmlFor={fieldId} info={info}>
      {catalog
        ? <ModelPicker id={fieldId} variant="field" value={current} onChange={next => model({ ...value.model, [field]: next || undefined })}
          models={offeredModels} loading={catalog.loading} error={catalog.error} onRetry={catalog.onRetry} disabled={editingDisabled}
          defaultOption={{ label: catalog.defaultLabel ?? 'Product default' }} />
        : <Input id={fieldId} size="compact" value={current} disabled={editingDisabled} placeholder="provider/model" {...noAutofill}
          onChange={event => model({ ...value.model, [field]: event.target.value || undefined })} />}
    </Field>
  }

  // ── Resource rows and panels ─────────────────────────────────────────────
  const github = config?.github
  function refFromCheck(check: GitHubSourceCheck, name: string): AgentProfileResourceRef {
    return github?.storage === 'inline'
      ? { kind: 'inline', name, content: check.content }
      : { kind: 'github', repository: check.repository, path: check.path, ref: check.commit.sha, ...(name ? { name } : {}) }
  }
  function addRef(section: 'skills' | 'tools', ref: AgentProfileResourceRef, index?: number): boolean {
    const refs = section === 'skills' ? skills : toolFiles
    const issue = section === 'skills' ? skillIssue(ref, refs, index ?? refs.length) : githubRefIssue(ref, requireGitHubCommitSha)
    if (issue) { setError(issue); return false }
    const next = index === undefined ? [...refs, ref] : refs.map((item, position) => position === index ? ref : item)
    return resources(section, next)
  }
  function addFile(mount: AgentProfileFileMount, index?: number): boolean {
    const issue = fileIssue(mount, index ?? files.length)
    if (issue) { setError(issue); return false }
    return setFiles(index === undefined ? [...files, mount] : files.map((item, position) => position === index ? mount : item))
  }

  function nameField(check: GitHubSourceCheck | null, section: 'skills' | 'tools') {
    const fieldId = `${id}-${section}-github-name`
    const suggested = check ? (section === 'skills' ? suggestedSkillName(check) : basename(check.path)) : ''
    const name = githubName.touched ? githubName.value : suggested
    const problem = section === 'skills' && requireUniqueSkillNames && name
      ? skillIssue({ kind: 'inline', name, content: '' }, skills) : null
    return <Field label={section === 'skills' ? 'Skill name' : 'File name'} htmlFor={fieldId} error={problem}
      hint={section === 'skills' && !problem ? 'Shown to the agent in its skill list.' : undefined}>
      <Input id={fieldId} size="compact" value={name} disabled={editingDisabled || !check} {...noAutofill}
        aria-invalid={problem ? true : undefined} aria-describedby={fieldMessageId(fieldId)}
        onChange={event => setGithubName({ value: event.target.value, touched: true })} />
    </Field>
  }
  function githubNameValue(check: GitHubSourceCheck, section: 'skills' | 'tools'): string {
    return (githubName.touched ? githubName.value : section === 'skills' ? suggestedSkillName(check) : basename(check.path)).trim()
  }

  function inlineEditor(section: 'skills' | 'tools' | 'files', index?: number) {
    const prefix = `${id}-${section}-inline`
    const isSkill = section === 'skills'
    const isFile = section === 'files'
    const name = inlineDraft.name.trim()
    const frontmatter = isSkill && inlineDraft.content.trim() ? readSkillFrontmatter(inlineDraft.content) : null
    const mount: AgentProfileFileMount | null = isFile ? { path: inlineDraft.path.trim(),
      resource: { kind: 'inline', name: name || basename(inlineDraft.path.trim()), content: inlineDraft.content },
      ...(inlineDraft.executable ? { executable: true } : {}) } : null
    const problem = isFile ? (inlineDraft.path.trim() ? fileIssue(mount!, index ?? files.length) : null)
      : isSkill && name ? skillIssue({ kind: 'inline', name, content: inlineDraft.content }, skills, index ?? skills.length) : null
    const ready = !editingDisabled && !problem && (isFile ? inlineDraft.path.trim() !== '' : name !== '')
    return <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
      {isFile
        ? <Field label="Workspace path" htmlFor={`${prefix}-path`} error={problem}
          hint={!problem && workspaceFilePrefix ? `Files go under ${workspaceFilePrefix}` : undefined}>
          <Input id={`${prefix}-path`} size="compact" value={inlineDraft.path} disabled={editingDisabled} {...noAutofill}
            placeholder={(workspaceFilePrefix ?? '') + 'guide.md'} aria-invalid={problem ? true : undefined} aria-describedby={fieldMessageId(`${prefix}-path`)}
            onChange={event => setInlineDraft({ ...inlineDraft, path: event.target.value })} />
        </Field>
        : <Field label={isSkill ? 'Skill name' : 'File name'} htmlFor={`${prefix}-name`} error={problem}>
          <Input id={`${prefix}-name`} size="compact" value={inlineDraft.name} disabled={editingDisabled} {...noAutofill}
            placeholder={isSkill ? 'research' : 'search.ts'} aria-invalid={problem ? true : undefined} aria-describedby={fieldMessageId(`${prefix}-name`)}
            onChange={event => setInlineDraft({ ...inlineDraft, name: event.target.value })} />
        </Field>}
      <Field label="Content" htmlFor={`${prefix}-content`}
        hint={frontmatter && !frontmatter.ok ? 'Start the skill with frontmatter that sets name and description, so the agent knows when to use it.' : undefined}>
        <Textarea id={`${prefix}-content`} className="min-h-40 font-mono text-sm leading-6" disabled={editingDisabled} value={inlineDraft.content}
          onChange={event => setInlineDraft({ ...inlineDraft, content: event.target.value })} />
      </Field>
      {isFile && (allowExecutableFiles || inlineDraft.executable) && <label className={`flex items-center gap-3 ${formText.body}`}>
        <Switch disabled={editingDisabled || (!allowExecutableFiles && !inlineDraft.executable)} checked={inlineDraft.executable}
          onCheckedChange={executable => setInlineDraft({ ...inlineDraft, executable })} />Executable</label>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="compact" disabled={!ready} onClick={() => {
          const saved = isFile ? addFile(mount!, index)
            : addRef(section as 'skills' | 'tools', { kind: 'inline', name, content: inlineDraft.content }, index)
          if (saved) openPanel(null)
        }}>{index === undefined ? (isSkill ? 'Add skill' : 'Add file') : 'Save'}</Button>
        <Button type="button" size="compact" variant="ghost" onClick={() => openPanel(null)}>Cancel</Button>
      </div>
    </div>
  }

  function githubEditor(section: 'skills' | 'tools' | 'files', index?: number) {
    if (!github) return null
    const existing = index === undefined ? undefined
      : section === 'files' ? files[index]?.resource : (section === 'skills' ? skills : toolFiles)[index]
    const initial = existing?.kind === 'github' ? { repository: existing.repository, path: existing.path, ref: existing.ref } : undefined
    const isFile = section === 'files'
    const pathId = `${id}-${section}-github-path`
    return <div className="rounded-lg border border-border bg-muted/30 p-4">
      <GitHubSourcePicker port={github.port} purpose={section === 'skills' ? 'skill' : 'file'} disabled={editingDisabled}
        connectHref={github.connectHref} initial={initial} onCancel={() => openPanel(null)}
        actionLabel={index !== undefined ? 'Save' : section === 'skills' ? 'Add skill' : 'Add file'}
        blocked={isFile && inlineDraft.path.trim() === '' ? 'Enter a workspace path.' : null}
        onChoose={({ check }) => {
          if (isFile) {
            const path = (inlineDraft.path.trim() || (workspaceFilePrefix ?? '') + basename(check.path))
            if (addFile({ path, resource: refFromCheck(check, basename(check.path)) }, index)) openPanel(null)
            return
          }
          const name = githubNameValue(check, section as 'skills' | 'tools')
          if (addRef(section as 'skills' | 'tools', refFromCheck(check, name), index)) openPanel(null)
        }}>
        {check => isFile
          ? <GitHubFilePath check={check} id={pathId} value={inlineDraft.path} prefix={workspaceFilePrefix ?? ''} disabled={editingDisabled}
            onChange={path => setInlineDraft(current => ({ ...current, path }))} issue={inlineDraft.path.trim() && check
              ? fileIssue({ path: inlineDraft.path.trim(), resource: refFromCheck(check, basename(check.path)) }, index ?? files.length) : null} />
          : nameField(check, section as 'skills' | 'tools')}
      </GitHubSourcePicker>
    </div>
  }

  function rowActions(label: string, section: 'skills' | 'tools' | 'files', index: number, ref: AgentProfileResourceRef) {
    const canEdit = ref.kind === 'inline' || Boolean(github)
    return <div className={rowActionsClass}>
      {canEdit && <Button type="button" size="compact" variant="ghost" disabled={editingDisabled} aria-label={`Edit ${label}`}
        onClick={() => openPanel({ kind: 'edit', section, index })}>Edit</Button>}
      <Button type="button" size="compact" variant="ghost" className="text-destructive hover:text-destructive" disabled={editingDisabled}
        aria-label={`Remove ${label}`} onClick={() => {
          const removed = section === 'files' ? setFiles(files.filter((_, item) => item !== index))
            : resources(section, (section === 'skills' ? skills : toolFiles).filter((_, item) => item !== index))
          if (removed && panel?.kind === 'edit' && panel.section === section) openPanel(null)
        }}>Remove</Button>
    </div>
  }

  function refList(section: 'skills' | 'tools', refs: readonly AgentProfileResourceRef[], noun: string) {
    if (refs.length === 0) return <p className={formText.muted}>No {noun}s yet.</p>
    return <ul className="divide-y divide-border rounded-lg border border-border">{refs.map((ref, index) => {
      const title = ref.name || (ref.kind === 'github' ? basename(ref.path) : `${noun} ${index + 1}`)
      const issue = section === 'skills' ? skillIssue(ref, refs, index) : githubRefIssue(ref, requireGitHubCommitSha)
      const described = ref.kind === 'inline' && section === 'skills' ? inlineSkillSummary(ref.content) : null
      const words = (text: string) => text.toLowerCase().replace(/[-_\s]+/g, ' ').trim()
      const summary = described && words(described) !== words(title) ? described : null
      const editing = panel?.kind === 'edit' && panel.section === section && panel.index === index
      return <li key={`${section}-${index}`} className="space-y-3 p-3" aria-label={`${noun} ${title}`}>
        <div className={listRow}>
          <div className="min-w-0">
            <p className={`break-words ${formText.label}`}>{title}</p>
            {summary && <p className={`line-clamp-2 ${formText.muted}`}>{summary}</p>}
            {(ref.kind === 'github' || !summary) && <p className={`break-words ${formText.muted}`}>{sourceLine(ref)}</p>}
            {issue && <p className={formText.error}>{issue}</p>}
          </div>
          {rowActions(title, section, index, ref)}
        </div>
        {editing && (ref.kind === 'github' && github ? githubEditor(section, index) : inlineEditor(section, index))}
      </li>
    })}</ul>
  }

  function addButtons(section: 'skills' | 'tools' | 'files', writeLabel: string) {
    if (panel && panel.kind !== 'edit' && panel.section === section) {
      return panel.kind === 'add-github' ? githubEditor(section) : inlineEditor(section)
    }
    return <div className="flex flex-wrap gap-2">
      {github && <Button type="button" size="compact" variant="outline" disabled={editingDisabled}
        onClick={() => openPanel({ kind: 'add-github', section })}>Add from GitHub</Button>}
      <Button type="button" size="compact" variant="outline" disabled={editingDisabled}
        onClick={() => openPanel({ kind: 'add-inline', section })}>{writeLabel}</Button>
    </div>
  }

  const countLabel = (count: number, noun: string) => count ? `${count} ${noun}${count === 1 ? '' : 's'}` : undefined
  const toolNames = Object.keys(value.tools ?? {})

  return <TooltipProvider delayDuration={150}>
    <div className={`@container/profile-editor min-w-0 space-y-4 ${className ?? ''}`} aria-label="Agent profile editor">
      {error && <Notice tone="error">{error}</Notice>}
      {jsonDirty && <Notice tone="info">Apply or discard your Advanced JSON edits before changing other fields.</Notice>}
      {unsupportedResources.length > 0 && <Notice tone="error">
        This profile has resources this product does not use: {unsupportedResources.map(kind => `${RESOURCE_KIND_LABELS[kind]} (${configuredResourceCount(value, kind)})`).join(', ')}.
        Remove them in Advanced JSON before saving.
      </Notice>}
      {constrainedEntryCount > 0 && <Notice tone="error">
        {constrainedEntryCount === 1 ? 'One resource needs' : `${constrainedEntryCount} resources need`} a fix before this profile can be saved. The affected rows say what to change.
      </Notice>}
      {invalidMcpCount > 0 && <Notice tone="error">
        {invalidMcpCount === 1 ? 'One MCP server needs' : `${invalidMcpCount} MCP servers need`} a public HTTPS address before this profile can be saved.
      </Notice>}

      {show.identity && <Section title="Identity">
        <div className={formRow}>
          {config?.identity?.nameEditable !== false && <Field label="Name" htmlFor={`${id}-name`}>
            <Input id={`${id}-name`} size="compact" disabled={editingDisabled} value={value.name ?? ''} {...noAutofill}
              onChange={event => emit({ ...value, name: event.target.value })} />
          </Field>}
          <Field label="Description" htmlFor={`${id}-description`}>
            <Input id={`${id}-description`} size="compact" disabled={editingDisabled} value={value.description ?? ''} {...noAutofill}
              onChange={event => emit({ ...value, description: event.target.value })} />
          </Field>
        </div>
      </Section>}

      {show.prompts && <Section title="Instructions" description="What the agent is told before every conversation.">
        <Field label="System prompt" htmlFor={`${id}-system`}
          info="Replaces the harness's built-in system prompt. Leave it empty to keep the built-in prompt.">
          <Textarea id={`${id}-system`} className="min-h-52 text-sm leading-6" disabled={editingDisabled} value={value.prompt?.systemPrompt ?? ''}
            onChange={event => prompt({ ...value.prompt, systemPrompt: event.target.value })} />
        </Field>
        <details className="group/more" open={Boolean(value.prompt?.appendSystemPrompt || value.prompt?.instructions?.length) || undefined}>
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 transition-transform group-open/more:rotate-90" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            More instructions
          </summary>
          <div className="mt-4 space-y-4">
            <Field label="Appended prompt" htmlFor={`${id}-append`}
              info="Added after the system prompt, or after the built-in prompt when the system prompt is empty.">
              <Textarea id={`${id}-append`} size="compact" className="min-h-24 text-sm leading-6" disabled={editingDisabled} value={value.prompt?.appendSystemPrompt ?? ''}
                onChange={event => prompt({ ...value.prompt, appendSystemPrompt: event.target.value })} />
            </Field>
            <div role="group" aria-labelledby={`${id}-instructions-label`} className="space-y-2">
              <div className="flex items-center gap-1.5">
                <span id={`${id}-instructions-label`} className={formText.label}>Project instructions</span>
              </div>
              <p className={formText.muted}>Lower-priority guidance the agent reads like a project file.</p>
              {(value.prompt?.instructions ?? []).map((instruction, index) =>
                <div key={index} className="flex items-start gap-2">
                  <Textarea aria-label={`Instruction ${index + 1}`} size="compact" className="min-h-20 text-sm leading-6" disabled={editingDisabled} value={instruction}
                    onChange={event => prompt({ ...value.prompt, instructions: (value.prompt?.instructions ?? []).map((item, i) => i === index ? event.target.value : item) })} />
                  <Button type="button" size="compact" variant="ghost" className="text-destructive hover:text-destructive" disabled={editingDisabled}
                    aria-label={`Remove instruction ${index + 1}`}
                    onClick={() => prompt({ ...value.prompt, instructions: (value.prompt?.instructions ?? []).filter((_, i) => i !== index) })}>Remove</Button>
                </div>)}
              <Button type="button" size="compact" variant="outline" disabled={editingDisabled}
                onClick={() => prompt({ ...value.prompt, instructions: [...(value.prompt?.instructions ?? []), ''] })}>Add instruction</Button>
            </div>
          </div>
        </details>
      </Section>}

      {show.model && <Section title="Model and runtime" description="Defaults for conversations and automations that do not choose their own.">
        <div className={formRow}>
          {modelField('Default model', 'default', 'Runs when a conversation or automation does not pick a model.')}
          {config?.harnesses && config.harnesses.length > 0 && <Field label="Harness" htmlFor={`${id}-harness`}
            info="The agent runtime that runs this profile, such as OpenCode or Codex.">
            <HarnessPicker id={`${id}-harness`} variant="field" value={harness ?? ''} onChange={changeHarness}
              available={config.harnesses} defaultOption={{ label: catalog?.defaultLabel ?? 'Product default' }} disabled={editingDisabled} />
          </Field>}
          <Field label="Thinking" htmlFor={`${id}-thinking`} info="How hard the agent reasons before answering. Auto lets the harness decide.">
            <EffortPicker id={`${id}-thinking`} variant="field" label="" value={value.model?.reasoningEffort ?? 'auto'} levels={thinkingLevels}
              disabled={editingDisabled}
              onChange={level => model({ ...value.model, reasoningEffort: level === 'auto' ? undefined : level as NonNullable<AgentProfile['model']>['reasoningEffort'] })} />
          </Field>
          {modelField('Small model', 'small', 'A faster model for short tasks such as titles and summaries.')}
        </div>
        {modelNotice && <StatusLine tone="neutral">{modelNotice}</StatusLine>}
      </Section>}

      {show.tools && <Section title="Tools and permissions" description="Which tools the agent may use, and when it must ask first."
        collapsible summary={countLabel(toolNames.length, 'rule')}>
        {toolNames.length === 0 && <p className={formText.muted}>No tool rules yet.</p>}
        {toolNames.length > 0 && <ul className="divide-y divide-border rounded-lg border border-border">
          {Object.entries(value.tools ?? {}).slice(0, showAllTools ? undefined : 6).map(([name, enabled]) => {
            const switchId = `${id}-tool-${name}`
            return <li key={name} className="flex flex-wrap items-center gap-3 p-3">
              <Switch id={switchId} disabled={editingDisabled} checked={enabled} aria-label={`Allow ${name}`}
                onCheckedChange={checked => emit({ ...value, tools: { ...value.tools, [name]: checked } })} />
              <label htmlFor={switchId} className={`min-w-24 flex-1 break-words ${formText.label}`}>{name}</label>
              <Select disabled={editingDisabled} value={typeof value.permissions?.[name] === 'string' ? value.permissions[name] as string : 'default'}
                onValueChange={permission => { const permissions = { ...value.permissions }; if (permission !== 'default') permissions[name] = permission as 'allow' | 'ask' | 'deny'; else delete permissions[name]; emit({ ...value, permissions }) }}>
                <SelectTrigger size="compact" aria-label={`Permission for ${name}`} className="w-36 shadow-none"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem><SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="ask">Ask first</SelectItem><SelectItem value="deny">Deny</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" size="compact" variant="ghost" className="text-destructive hover:text-destructive" disabled={editingDisabled}
                aria-label={`Remove ${name}`} onClick={() => { const tools = { ...value.tools }; delete tools[name]; emit({ ...value, tools }) }}>Remove</Button>
            </li>
          })}
        </ul>}
        {toolNames.length > 6 && <Button type="button" size="compact" variant="ghost" onClick={() => setShowAllTools(current => !current)}>
          {showAllTools ? 'Show fewer' : `Show ${toolNames.length - 6} more`}
        </Button>}
        <div className="flex gap-2">
          <Input aria-label="New tool name" size="compact" disabled={editingDisabled} value={newTool} placeholder="Tool name" {...noAutofill}
            onChange={event => setNewTool(event.target.value)} />
          <Button type="button" size="compact" variant="outline" disabled={editingDisabled || !newTool.trim()} onClick={() => {
            const name = newTool.trim()
            if (name in (value.tools ?? {})) { setError('A rule for this tool already exists.'); return }
            if (emit({ ...value, tools: { ...value.tools, [name]: true } })) setNewTool('')
          }}>Add tool</Button>
        </div>
        <p className={formText.muted}>Nested permission rules are edited in Advanced JSON.</p>
      </Section>}

      {show.skills && <Section title="Skills" description="Instructions the agent loads when a task calls for them."
        collapsible defaultOpen={skills.length > 0 || panel?.section === 'skills'} summary={countLabel(skills.length, 'skill')}>
        {refList('skills', skills, 'Skill')}
        {addButtons('skills', 'Write a skill')}
        {registry && <AgentProfileRegistrySkillSearch registry={registry} disabled={editingDisabled} existing={skills}
          validate={ref => skillIssue(ref, skills, skills.length)}
          onAdd={ref => resources('skills', [...skills, ref])} />}
      </Section>}

      {show.toolFiles && <Section title="Tool files" description="Files that define custom tools."
        collapsible defaultOpen={toolFiles.length > 0} summary={countLabel(toolFiles.length, 'file')}>
        {refList('tools', toolFiles, 'Tool file')}
        {addButtons('tools', 'Write a tool file')}
      </Section>}

      {show.mcp && <Section title="MCP servers" description="Tool servers the agent connects to."
        collapsible defaultOpen={Object.keys(value.mcp ?? {}).length > 0} summary={countLabel(Object.keys(value.mcp ?? {}).length, 'server')}>
        <McpServersEditor servers={value.mcp ?? {}} disabled={editingDisabled} port={config?.mcp?.port} lockReason={config?.mcp?.lockReason}
          publicHttpsOnly={publicHttpsMcpOnly} allowLocalCommand={config?.mcp?.allowLocalCommand ?? !publicHttpsMcpOnly}
          registry={registry} onPendingChange={setMcpPending}
          onChange={next => { const { mcp: _mcp, ...rest } = value; return emit(Object.keys(next).length ? { ...value, mcp: next } : rest) }} />
      </Section>}

      {show.files && <Section title="Resource files" description="Reference files placed in the agent's workspace."
        collapsible defaultOpen={files.length > 0 || panel?.section === 'files'} summary={countLabel(files.length, 'file')}>
        {files.length === 0 && <p className={formText.muted}>No resource files yet.</p>}
        {files.length > 0 && <ul className="divide-y divide-border rounded-lg border border-border">{files.map((mount, index) => {
          const issue = fileIssue(mount, index)
          const editing = panel?.kind === 'edit' && panel.section === 'files' && panel.index === index
          return <li key={`${mount.path}-${index}`} className="space-y-3 p-3" aria-label={`Resource file ${mount.path}`}>
            <div className={listRow}>
              <div className="min-w-0">
                <p className={`break-words [overflow-wrap:anywhere] ${formText.label}`}>{mount.path}</p>
                <p className={`break-words ${formText.muted}`}>{sourceLine(mount.resource)}{mount.executable ? ' · Executable' : ''}</p>
                {issue && <p className={formText.error}>{issue}</p>}
              </div>
              {rowActions(mount.path, 'files', index, mount.resource)}
            </div>
            {editing && (mount.resource.kind === 'github' && github ? githubEditor('files', index) : inlineEditor('files', index))}
          </li>
        })}</ul>}
        {panel && panel.kind !== 'edit' && panel.section === 'files' && addButtons('files', 'Write a file')}
        <ResourceFileDrop existingPaths={files.map(mount => mount.path)} pathPrefix={workspaceFilePrefix} limits={config?.files}
          disabled={editingDisabled} actions={!(panel && panel.kind !== 'edit' && panel.section === 'files') && <>
            {github && <Button type="button" size="compact" variant="outline" disabled={editingDisabled}
              onClick={() => openPanel({ kind: 'add-github', section: 'files' })}>Add from GitHub</Button>}
            <Button type="button" size="compact" variant="outline" disabled={editingDisabled}
              onClick={() => openPanel({ kind: 'add-inline', section: 'files' })}>Write a file</Button>
          </>} onAdd={added => {
            const mounts = added.map(({ path, file }) => ({ path, resource: { kind: 'inline' as const, name: file.name, content: file.content } }))
            const next = [...files, ...mounts]
            const issue = mounts.map((mount, offset) => fileIssue(mount, files.length + offset)).find(Boolean)
            if (issue) return issue
            return setFiles(next) ? null : 'The profile did not accept these files.'
          }} />
      </Section>}

      {show.advanced && <Section title="Advanced JSON" description="The complete profile, including hooks, modes, connections, and extensions." collapsible>
        <label htmlFor={`${id}-json`} className="sr-only">Full profile JSON</label>
        <Textarea id={`${id}-json`} className="min-h-72 font-mono text-sm leading-6" spellCheck={false} disabled={disabled} value={json}
          onChange={event => { setJson(event.target.value); setJsonDirty(true) }} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="compact" variant="outline" disabled={disabled || !jsonDirty} onClick={applyJson}>Apply JSON</Button>
          {jsonDirty && <Button type="button" size="compact" variant="ghost" className="text-destructive hover:text-destructive" disabled={disabled}
            onClick={() => { setJson(JSON.stringify(value, null, 2)); setJsonDirty(false); setError(null) }}>Discard JSON edits</Button>}
        </div>
        <p className={formText.muted}>Reference credentials by secret name; never paste them into a profile.</p>
      </Section>}
    </div>
  </TooltipProvider>
}

function GitHubFilePath({ check, id, value, prefix, disabled, onChange, issue }: {
  check: GitHubSourceCheck | null
  id: string
  value: string
  prefix: string
  disabled: boolean
  onChange: (path: string) => void
  issue: string | null
}) {
  const suggested = check ? prefix + basename(check.path) : ''
  // Suggest a path when a new source is checked; the person's own path stays.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (suggested && !value) onChange(suggested) }, [suggested])
  return <Field label="Workspace path" htmlFor={id} error={issue} hint={!issue && prefix ? `Files go under ${prefix}` : undefined}>
    <Input id={id} size="compact" value={value} disabled={disabled || !check} placeholder={prefix + 'guide.md'} {...noAutofill}
      aria-invalid={issue ? true : undefined} aria-describedby={fieldMessageId(id)} onChange={event => onChange(event.target.value)} />
  </Field>
}

