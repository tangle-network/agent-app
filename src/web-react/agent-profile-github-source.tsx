/**
 * Choose a file from GitHub for a skill or a resource file. Repositories and
 * paths autocomplete from the workspace's GitHub connection, the version is the
 * default branch's latest commit unless the person pins a SHA, and the chosen
 * file is read and checked before it can be added.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@tangle-network/sandbox-ui/primitives'
import { SegmentedControl } from '@tangle-network/ui/primitives'
import {
  isCommitSha, parseGitHubLocation,
  type GitHubCommitSummary, type GitHubFileList, type GitHubRepositorySummary, type GitHubSourceCheck,
  type GitHubSourceFailure, type GitHubSourceOutcome, type GitHubSourcePurpose, type ProfileEditorGitHubPort,
} from '../profile-editor'
import { Field, fieldMessageId, formRow, formText, noAutofill, StatusLine } from './agent-profile-form-kit'
import { SuggestInput, type Suggestion } from './agent-profile-suggest-input'

type Load<T> = { state: 'idle' } | { state: 'loading' } | { state: 'done'; value: T } | { state: 'failed'; failure: GitHubSourceFailure }

/** Run a lookup whenever its key changes, cancelling the previous one. */
function useLookup<T>(key: string | null, run: (signal: AbortSignal) => Promise<GitHubSourceOutcome<T>>, delayMs = 0): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'idle' })
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    if (key === null) { setLoad({ state: 'idle' }); return }
    const controller = new AbortController()
    setLoad({ state: 'loading' })
    const timer = setTimeout(() => {
      runRef.current(controller.signal).then(outcome => {
        if (controller.signal.aborted) return
        setLoad(outcome.ok ? { state: 'done', value: outcome.value } : { state: 'failed', failure: outcome })
      }, (cause: unknown) => {
        if (controller.signal.aborted) return
        setLoad({ state: 'failed', failure: { ok: false, problem: 'unavailable', message: cause instanceof Error ? cause.message : 'The lookup failed.' } })
      })
    }, delayMs)
    return () => { clearTimeout(timer); controller.abort() }
  }, [key, delayMs])
  return load
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function relativeDate(iso?: string): string | null {
  if (!iso) return null
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return null
  const days = Math.floor((Date.now() - time) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function describeCommit(commit: GitHubCommitSummary): string {
  const when = relativeDate(commit.committedAt)
  return [shortSha(commit.sha), commit.message, when].filter(Boolean).join(' · ')
}

function rankPaths(files: GitHubFileList['files'], query: string, purpose: GitHubSourcePurpose): Suggestion[] {
  const needle = query.trim().toLowerCase()
  const candidates = purpose === 'skill' ? files.filter(file => /(^|\/)SKILL\.md$/i.test(file.path)) : files
  const pool = candidates.length || purpose !== 'skill' ? candidates : files
  return pool
    .filter(file => !needle || file.path.toLowerCase().includes(needle))
    .sort((left, right) => {
      const leftStarts = needle && left.path.toLowerCase().startsWith(needle) ? 0 : 1
      const rightStarts = needle && right.path.toLowerCase().startsWith(needle) ? 0 : 1
      return leftStarts - rightStarts || left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path)
    })
    .slice(0, 50)
    .map(file => ({ value: file.path, label: file.path }))
}

interface GitHubSourceSelection {
  check: GitHubSourceCheck
}

export interface GitHubSourcePickerProps {
  port: ProfileEditorGitHubPort
  purpose: GitHubSourcePurpose
  disabled?: boolean
  /** Where the person connects GitHub, shown when the workspace has no connection. */
  connectHref?: string
  /** Called with the checked source. The caller adds it to the profile and closes the picker. */
  onChoose: (selection: GitHubSourceSelection) => void
  /** The label for the add action, for example "Add skill". */
  actionLabel: string
  /** Fields the caller needs beside the source, such as the skill name; rendered above the action. */
  children?: (check: GitHubSourceCheck | null) => ReactNode
  /** The reason the caller's fields block adding, or null. */
  blocked?: string | null
  /** Initial values, for editing an existing GitHub source. */
  initial?: { repository?: string; path?: string; ref?: string }
  onCancel: () => void
}

export function GitHubSourcePicker({ port, purpose, disabled = false, connectHref, onChoose, actionLabel, children, blocked = null, initial, onCancel }: GitHubSourcePickerProps) {
  const uid = useId()
  const fieldId = (name: 'repository' | 'version' | 'sha' | 'path') => `github-${name}${uid}`

  const [repositoryText, setRepositoryText] = useState(initial?.repository ?? '')
  const [repository, setRepository] = useState(initial?.repository ?? '')
  const [version, setVersion] = useState<'latest' | 'pinned'>(initial?.ref && isCommitSha(initial.ref) ? 'pinned' : 'latest')
  const [shaText, setShaText] = useState(initial?.ref && isCommitSha(initial.ref) ? initial.ref : '')
  const [pathText, setPathText] = useState(initial?.path ?? '')
  const [path, setPath] = useState(initial?.path ?? '')

  const repositories = useLookup('repositories', signal => port.repositories(signal))
  const latest = useLookup(repository || null, signal => port.latest(repository, signal))
  const pinnedSha = version === 'pinned' && isCommitSha(shaText.trim()) ? shaText.trim().toLowerCase() : null
  const pinned = useLookup(repository && pinnedSha ? `${repository}@${pinnedSha}` : null,
    signal => port.commit(repository, pinnedSha!, signal), 300)
  const commit: GitHubCommitSummary | null = version === 'latest'
    ? latest.state === 'done' ? latest.value.commit : null
    : pinned.state === 'done' ? pinned.value : null
  const files = useLookup(repository && commit ? `${repository}@${commit.sha}` : null,
    signal => port.files(repository, commit!.sha, signal))
  const check = useLookup(repository && commit && path ? `${repository}@${commit.sha}:${path}:${purpose}` : null,
    signal => port.check({ repository, path, commit: commit!.sha, purpose }, signal), 150)

  const notConnected = repositories.state === 'failed' && repositories.failure.problem === 'not-connected'
    ? repositories.failure
    : latest.state === 'failed' && latest.failure.problem === 'not-connected' ? latest.failure : null

  const repositorySuggestions = useMemo<Suggestion[]>(() => {
    if (repositories.state !== 'done') return []
    const needle = repositoryText.trim().toLowerCase()
    return repositories.value.repositories
      .filter((item: GitHubRepositorySummary) => !needle || item.fullName.toLowerCase().includes(needle))
      .slice(0, 50)
      .map(item => ({ value: item.fullName, label: item.fullName,
        detail: [item.private ? 'Private' : 'Public', item.description].filter(Boolean).join(' · ') }))
  }, [repositories, repositoryText])

  const pathSuggestions = useMemo(() => files.state === 'done' ? rankPaths(files.value.files, pathText, purpose) : [],
    [files, pathText, purpose])

  function commitRepository(text: string) {
    const location = parseGitHubLocation(text)
    if (!location) { setRepository(''); return }
    setRepositoryText(location.repository)
    setRepository(location.repository)
    if (location.ref && isCommitSha(location.ref)) { setVersion('pinned'); setShaText(location.ref) }
    if (location.path) { setPathText(location.path); setPath(location.path) }
  }

  if (notConnected) {
    return <div className="space-y-3">
      <StatusLine tone="neutral">{notConnected.message}</StatusLine>
      <div className="flex flex-wrap gap-2">
        {connectHref && <Button asChild size="compact"><a href={connectHref}>Connect GitHub</a></Button>}
        <Button type="button" size="compact" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  }

  const repositoryInvalid = repositoryText.trim() !== '' && repository === '' && !parseGitHubLocation(repositoryText)
  const repositoryMessage = repositoryInvalid
    ? <span className={formText.error}>Enter a repository as owner/repo, or paste its GitHub link.</span>
    : latest.state === 'failed' ? <span className={formText.error}>{latest.failure.message}</span>
    : latest.state === 'loading' ? <StatusLine tone="pending">Checking {repository}…</StatusLine>
    : latest.state === 'done' ? <StatusLine tone="success">{latest.value.repository.private ? 'Private' : 'Public'} · default branch {latest.value.repository.defaultBranch}</StatusLine>
    : repositories.state === 'failed' ? <span className={formText.muted}>{repositories.failure.message}</span>
    : undefined
  const shaInvalid = version === 'pinned' && shaText.trim() !== '' && !isCommitSha(shaText.trim())
  const versionMessage = version === 'latest'
    ? latest.state === 'done' ? <span className={formText.muted}>{describeCommit(latest.value.commit)}</span> : undefined
    : shaInvalid ? <span className={formText.error}>Enter the full 40-character commit SHA.</span>
    : pinned.state === 'failed' ? <span className={formText.error}>{pinned.failure.message}</span>
    : pinned.state === 'loading' ? <StatusLine tone="pending">Looking up the commit…</StatusLine>
    : pinned.state === 'done' ? <StatusLine tone="success">{describeCommit(pinned.value)}</StatusLine>
    : undefined
  const checked = check.state === 'done' ? check.value : null
  const pathMessage = !commit ? undefined
    : files.state === 'failed' ? <span className={formText.error}>{files.failure.message}</span>
    : check.state === 'loading' ? <StatusLine tone="pending">Reading {path}…</StatusLine>
    : check.state === 'failed' ? <span className={formText.error}>{check.failure.message}</span>
    : checked ? <StatusLine tone="success">{checked.skill
      ? <>Skill <span className="font-medium">{checked.skill.name}</span>: {checked.skill.description}</>
      : <>{checked.path} · {Math.max(1, Math.round(checked.size / 1024))} KB</>}</StatusLine>
    : files.state === 'done' && files.value.truncated ? <span className={formText.muted}>This repository is large; type the full path if it is not suggested.</span>
    : undefined
  const ready = checked !== null && !blocked && !disabled

  return <div className="space-y-4">
    <Field label="Repository" htmlFor={fieldId('repository')} error={undefined} hint={repositoryMessage}>
      <SuggestInput id={fieldId('repository')} value={repositoryText} disabled={disabled}
        placeholder={repositories.state === 'done' ? 'Search your repositories' : 'owner/repo'}
        onChange={setRepositoryText} onCommit={commitRepository}
        suggestions={repositorySuggestions} loading={repositories.state === 'loading' && repositoryText === ''}
        emptyText={repositories.state === 'done' ? 'No matching repositories. Press Enter to use what you typed.' : undefined}
        invalid={repositoryInvalid || latest.state === 'failed'} describedBy={fieldMessageId(fieldId('repository'))} />
    </Field>
    <div className={formRow}>
      <Field label="Version" htmlFor={fieldId('version')} hint={versionMessage}>
        <SegmentedControl id={fieldId('version')} aria-label="Version" value={version}
          onValueChange={next => setVersion(next)}
          options={[{ value: 'latest', label: 'Latest commit' }, { value: 'pinned', label: 'Pin a commit' }]}
          className="h-[var(--control-height)] w-full flex-nowrap p-0.5 [&_button]:h-full [&_button]:flex-1 [&_button]:justify-center [&_button]:py-0" />
      </Field>
      {version === 'pinned' && <Field label="Commit SHA" htmlFor={fieldId('sha')}>
        <Input id={fieldId('sha')} size="compact" value={shaText} disabled={disabled} placeholder="40-character SHA"
          aria-invalid={shaInvalid || pinned.state === 'failed' || undefined} {...noAutofill}
          className="font-mono" onChange={event => setShaText(event.target.value)} />
      </Field>}
    </div>
    <Field label={purpose === 'skill' ? 'Skill file' : 'File'} htmlFor={fieldId('path')} hint={pathMessage}>
      <SuggestInput id={fieldId('path')} value={pathText} disabled={disabled || !commit}
        placeholder={purpose === 'skill' ? 'skills/research/SKILL.md' : 'docs/guide.md'}
        onChange={setPathText} onCommit={next => setPath(next)}
        suggestions={pathSuggestions} loading={files.state === 'loading'}
        emptyText={files.state === 'done' ? (purpose === 'skill' ? 'No SKILL.md files match.' : 'No files match.') : undefined}
        invalid={check.state === 'failed'} describedBy={fieldMessageId(fieldId('path'))} />
    </Field>
    {children?.(checked)}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="compact" disabled={!ready} onClick={() => { if (checked) onChoose({ check: checked }) }}>{actionLabel}</Button>
      <Button type="button" size="compact" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  </div>
}
