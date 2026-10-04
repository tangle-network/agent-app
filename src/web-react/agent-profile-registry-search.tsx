import { useRef, useState } from 'react'
import type { AgentProfileMcpServer, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'
import { Button, Input } from '@tangle-network/sandbox-ui/primitives'
import { AgentProfileRegistryError, type AgentProfileRegistryMcpServer, type AgentProfileRegistryPort,
  type AgentProfileRegistrySkill } from './agent-profile-registry'

interface SearchState<T> {
  status: 'idle' | 'searching' | 'done'
  results: readonly T[]
  unavailable: readonly string[]
  failure: { kind: 'authorization-required' | 'unavailable' | 'failed'; message: string } | null
}

const idle: SearchState<never> = { status: 'idle', results: [], unavailable: [], failure: null }

function failureOf(cause: unknown): SearchState<never>['failure'] {
  if (cause instanceof AgentProfileRegistryError) return { kind: cause.kind, message: cause.message }
  return { kind: 'failed', message: cause instanceof Error ? cause.message : 'Registry search failed.' }
}

function failureText(failure: NonNullable<SearchState<never>['failure']>): string {
  if (failure.kind === 'authorization-required') {
    return 'Registry search needs authorization. Sign in again or ask a workspace owner.'
  }
  if (failure.kind === 'unavailable') return failure.message || 'Registry search is unavailable right now.'
  return failure.message || 'Registry search failed.'
}

function useRegistrySearch<T>(search: (query: string, signal: AbortSignal) => Promise<{ items: readonly T[]; unavailable?: readonly string[] }>) {
  const [state, setState] = useState<SearchState<T>>(idle as SearchState<T>)
  const request = useRef(0)

  async function run(query: string) {
    const text = query.trim()
    if (!text) return
    const epoch = ++request.current
    const controller = new AbortController()
    setState(current => ({ ...current, status: 'searching', failure: null }))
    try {
      const result = await search(text, controller.signal)
      if (request.current !== epoch) return
      setState({ status: 'done', results: result.items, unavailable: result.unavailable ?? [], failure: null })
    } catch (cause) {
      if (request.current !== epoch) return
      setState({ status: 'done', results: [], unavailable: [], failure: failureOf(cause) })
    }
  }

  return { state, run }
}

function SearchBox({ label, placeholder, disabled, onSearch }: {
  label: string
  placeholder: string
  disabled: boolean
  onSearch: (query: string) => void
}) {
  const [query, setQuery] = useState('')
  return <div className="flex gap-2">
    <Input aria-label={label} disabled={disabled} value={query} placeholder={placeholder}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onSearch(query) } }} />
    <Button type="button" variant="outline" disabled={disabled || !query.trim()} onClick={() => onSearch(query)}>Search</Button>
  </div>
}

function SearchStatus<T>({ state, empty }: { state: SearchState<T>; empty: string }) {
  return <>
    {state.status === 'searching' && <p role="status" className="text-xs text-muted-foreground">Searching…</p>}
    {state.failure && <p role="alert" className="text-xs text-destructive">{failureText(state.failure)}</p>}
    {!state.failure && state.unavailable.length > 0 && <p role="status" className="text-xs text-muted-foreground">
      Some catalogs could not answer: {state.unavailable.join(', ')}.</p>}
    {state.status === 'done' && !state.failure && state.results.length === 0 &&
      <p className="text-xs text-muted-foreground">{empty}</p>}
  </>
}

export function AgentProfileRegistrySkillSearch({ registry, disabled, existing, validate, onAdd }: {
  registry: AgentProfileRegistryPort
  disabled: boolean
  existing: readonly AgentProfileResourceRef[]
  /** Product constraints; returns the reason a result cannot be added, or null when it can. */
  validate: (ref: AgentProfileResourceRef) => string | null
  onAdd: (ref: AgentProfileResourceRef) => boolean
}) {
  const { state, run } = useRegistrySearch<AgentProfileRegistrySkill>(async (query, signal) => {
    const result = await registry.searchSkills(query, signal)
    return { items: result.skills, unavailable: result.unavailable }
  })
  const [added, setAdded] = useState<readonly string[]>([])

  return <div className="space-y-2 rounded-lg border border-border p-3">
    <p className="text-sm font-medium text-foreground">Find skills in maintained catalogs</p>
    <p className="text-xs text-muted-foreground">Search shows each skill's source and declared permissions. Adding a skill saves a reference; nothing is installed until the profile runs.</p>
    <SearchBox label="Search skill catalogs" placeholder="Search skills" disabled={disabled || state.status === 'searching'}
      onSearch={query => void run(query)} />
    <SearchStatus state={state} empty="No skills matched that search." />
    {state.results.length > 0 && <ul className="space-y-2">{state.results.map((skill, index) => {
      const configured = existing.some(ref => ref.name === skill.name) || added.includes(skill.name)
      const issue = configured ? null : validate(skill.ref)
      return <li key={`${skill.catalog}:${skill.name}:${index}`} className="space-y-1 rounded-lg border border-border p-3 text-sm"
        aria-label={`Catalog skill ${skill.name}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="block break-words font-medium text-foreground">{skill.name}</span>
            <span className="block text-xs text-muted-foreground">{skill.catalog}</span>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={disabled || configured || Boolean(issue)}
            aria-label={`Add skill ${skill.name}`}
            onClick={() => { if (onAdd(skill.ref)) setAdded(current => [...current, skill.name]) }}>
            {configured ? 'Added' : 'Add skill'}</Button>
        </div>
        {skill.description && <p className="text-xs text-muted-foreground">{skill.description}</p>}
        {skill.ref.kind === 'github' && <p className="break-words text-xs text-muted-foreground">
          Source: {skill.ref.repository} / {skill.ref.path}{skill.ref.ref ? ` @ ${skill.ref.ref}` : ''}</p>}
        {skill.permissions && skill.permissions.length > 0 &&
          <p className="text-xs text-muted-foreground">Requests: {skill.permissions.join(', ')}</p>}
        {issue && <p className="text-xs text-destructive">{issue}</p>}
      </li> })}</ul>}
  </div>
}

export function AgentProfileRegistryMcpSearch({ registry, disabled, existingNames, validate, onAdd }: {
  registry: AgentProfileRegistryPort
  disabled: boolean
  existingNames: readonly string[]
  validate: (name: string, server: AgentProfileMcpServer) => string | null
  onAdd: (name: string, server: AgentProfileMcpServer) => boolean
}) {
  const { state, run } = useRegistrySearch<AgentProfileRegistryMcpServer>(async (query, signal) => {
    const result = await registry.searchMcpServers(query, signal)
    return { items: result.mcpServers, unavailable: result.unavailable }
  })
  const [added, setAdded] = useState<readonly string[]>([])

  return <div className="space-y-2 rounded-lg border border-border p-3">
    <p className="text-sm font-medium text-foreground">Find MCP servers in registries</p>
    <p className="text-xs text-muted-foreground">Results come from the official MCP Registry and configured custom registries. Listing does not imply trust or authorize installation.</p>
    <SearchBox label="Search MCP registries" placeholder="Search MCP servers" disabled={disabled || state.status === 'searching'}
      onSearch={query => void run(query)} />
    <SearchStatus state={state} empty="No MCP servers matched that search." />
    {state.results.length > 0 && <ul className="space-y-2">{state.results.map((item, index) => {
      const configured = existingNames.includes(item.name) || added.includes(item.name)
      const issue = configured ? null : validate(item.name, item.server)
      return <li key={`${item.catalog}:${item.name}:${index}`} className="space-y-1 rounded-lg border border-border p-3 text-sm"
        aria-label={`Registry server ${item.name}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="block break-words font-medium text-foreground">{item.name}</span>
            <span className="block text-xs text-muted-foreground">{item.catalog}</span>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={disabled || configured || Boolean(issue)}
            aria-label={`Add server ${item.name}`}
            onClick={() => { if (onAdd(item.name, item.server)) setAdded(current => [...current, item.name]) }}>
            {configured ? 'Added' : 'Add server'}</Button>
        </div>
        {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
        <p className="break-words text-xs text-muted-foreground">{'command' in item.server ? `Command: ${item.server.command}` : `URL: ${item.server.url}`}</p>
        {issue && <p className="text-xs text-destructive">{issue}</p>}
      </li> })}</ul>}
  </div>
}
