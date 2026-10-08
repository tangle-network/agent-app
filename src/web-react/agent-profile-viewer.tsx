import { useState, type ReactNode } from 'react'
import { Button, CodeBlock, Tabs, TabsContent, TabsList, TabsTrigger } from '@tangle-network/sandbox-ui/primitives'
import { CopyButton } from '@tangle-network/sandbox-ui/markdown'
import { ProfileCard, ProfileSectionHeading } from './agent-profile-layout'
import type { AgentProfile, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'

export interface AgentProfileViewerProps {
  profile: AgentProfile
  className?: string
  defaultExpanded?: boolean
  /** Hide the identity when the surrounding workspace already names the agent. */
  showIdentity?: boolean
  /** Offer the complete supplied profile in an owner-authorized context. Contains MCP configuration and connection references. */
  showFullProfile?: boolean
}

function nonempty(value: string | undefined): value is string {
  return Boolean(value?.trim())
}

function resourceName(resource: AgentProfileResourceRef): string {
  if (resource.kind === 'inline') return resource.name
  return [resource.repository, resource.path].filter(Boolean).join(':') || resource.path
}

function ResourceRow({ label, resource, path }: {
  label: string
  resource: AgentProfileResourceRef
  path?: string
}) {
  const name = resourceName(resource)

  return (
    <li className="min-w-0 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="shrink-0 text-sm font-medium text-muted-foreground">{label}</span>
        {path && <code className="break-all font-mono text-sm text-foreground">{path}</code>}
        <span className="min-w-0 break-all text-sm text-foreground">{name}</span>
        {resource.kind === 'github' && resource.ref && (
          <span className="shrink-0 text-sm text-muted-foreground">at {resource.ref}</span>
        )}
      </div>
      {resource.kind === 'inline' && nonempty(resource.content) && (
        <details className="mt-1.5">
          <summary className="w-fit cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            View inline content
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm leading-relaxed text-foreground">
            {resource.content}
          </pre>
        </details>
      )}
    </li>
  )
}

function PromptDetail({ label, path, note, value }: { label: string; path: string; note: string; value: string }) {
  return <div className="min-w-0 space-y-3">
    <div className="space-y-1">
      <h4 className="text-sm font-semibold text-foreground">{label}</h4>
      <code className="block break-all font-mono text-xs text-primary">{path}</code>
      <p className="text-sm leading-6 text-muted-foreground">{note}</p>
    </div>
    <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/35 p-4 text-sm leading-7 text-foreground">{value}</div>
  </div>
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return <ProfileCard title={title}>{children}</ProfileCard>
}

function ProfileConfiguration({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  if (expanded) return <div className="space-y-4">{children}</div>
  return <details className="group/config border-t border-border pt-4">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      Profile configuration <span aria-hidden="true" className="text-muted-foreground group-open/config:rotate-90">›</span>
    </summary>
    <div className="space-y-4 pt-4">{children}</div>
  </details>
}

function permissionRows(profile: AgentProfile): Array<[string, string]> {
  return Object.entries(profile.permissions ?? {}).flatMap(([name, value]) => {
    if (typeof value === 'string') return [[name, value] as [string, string]]
    return Object.entries(value).map(([scope, policy]) => [`${name}.${scope}`, policy] as [string, string])
  }).sort(([a], [b]) => a.localeCompare(b))
}

function configuredResources(profile: AgentProfile) {
  const resources = profile.resources
  if (!resources) return []

  return [
    ...(resources.files ?? []).map((mount, index) => ({
      key: `file:${mount.path}:${index}`, label: 'File', resource: mount.resource, path: mount.path,
    })),
    ...(resources.skills ?? []).map((resource, index) => ({
      key: `skill:${index}`, label: 'Skill', resource,
    })),
    ...(resources.tools ?? []).map((resource, index) => ({
      key: `tool:${index}`, label: 'Tool file', resource,
    })),
    ...(resources.agents ?? []).map((resource, index) => ({
      key: `agent:${index}`, label: 'Subagent file', resource,
    })),
    ...(resources.commands ?? []).map((resource, index) => ({
      key: `command:${index}`, label: 'Command file', resource,
    })),
  ]
}

/** Read-only view of configured profile data. It does not imply runtime materialization. */
function ProfileOverview({ profile, defaultExpanded = true, showIdentity = true }: AgentProfileViewerProps) {
  const permissions = permissionRows(profile)
  const resources = configuredResources(profile)
  const prompt = profile.prompt
  const instructions = prompt?.instructions?.filter(nonempty) ?? []
  const resourceInstructions = profile.resources?.instructions
  const mcp = Object.entries(profile.mcp ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const tools = Object.entries(profile.tools ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const hasBehavior = Boolean(nonempty(prompt?.systemPrompt) || nonempty(prompt?.appendSystemPrompt) ||
    instructions.length || (typeof resourceInstructions === 'string'
      ? nonempty(resourceInstructions) : resourceInstructions))
  const hasConfiguration = Boolean(hasBehavior || tools.length ||
    permissions.length || mcp.length || profile.connections?.length || resources.length || profile.resources?.failOnError ||
    profile.subagents && Object.keys(profile.subagents).length ||
    profile.hooks && Object.keys(profile.hooks).length || profile.modes && Object.keys(profile.modes).length)
  const hasProfileDetails = Boolean(profile.model?.default || profile.model?.small || profile.model?.reasoningEffort ||
    profile.model?.provider || profile.harness || profile.description || profile.version || profile.tags?.length || hasConfiguration)

  return (
    <div className="min-w-0 text-sm text-foreground">
      {(showIdentity || nonempty(profile.description)) && <header className="mb-6 min-w-0">
        {showIdentity && <h2 className="break-words text-lg font-semibold leading-tight text-foreground">
          {nonempty(profile.name) ? profile.name : 'Unnamed profile'}
        </h2>}
        {nonempty(profile.description) && <p className="mt-2 whitespace-pre-wrap break-words leading-6 text-muted-foreground">{profile.description}</p>}
      </header>}
      {!hasProfileDetails && <p className="text-muted-foreground">No profile details are configured.</p>}
      {(hasConfiguration || profile.model || profile.harness || profile.version || profile.tags?.length) && <ProfileConfiguration expanded={defaultExpanded}>
        {hasBehavior && (
          <ProfileSection title="Prompts and instructions">
            <div className="space-y-6">
              {!nonempty(prompt?.systemPrompt) && <div className="space-y-1"><h4 className="text-sm font-semibold">System prompt</h4><code className="block font-mono text-xs text-primary">prompt.systemPrompt</code><p className="text-sm leading-6 text-muted-foreground">No override configured. The runtime supplies its default system prompt.</p></div>}
              {nonempty(prompt?.systemPrompt) && (
                <PromptDetail label="System prompt" path="prompt.systemPrompt" note="The profile’s system prompt override. Replaces the harness default where supported." value={prompt.systemPrompt} />
              )}
              {nonempty(prompt?.appendSystemPrompt) && (
                <PromptDetail
                  label="Appended system prompt" path="prompt.appendSystemPrompt"
                  note="Appended after the system prompt, or after the harness default when no override is set."
                  value={prompt.appendSystemPrompt}
                />
              )}
              {instructions.length > 0 && (
                <div className="space-y-1.5">
                  <h4 className="text-sm font-semibold text-foreground">Project instructions</h4>
                  <code className="block break-all font-mono text-xs text-primary">prompt.instructions</code>
                  <p className="pb-2 text-sm leading-6 text-muted-foreground">Lower-priority workspace guidance. These entries are separate from the system prompt.</p>
                  <ul className="space-y-2">
                    {instructions.map((instruction, index) => (
                      <li key={`${index}:${instruction}`}>
                        <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/35 p-4 text-sm leading-7">{instruction}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {typeof resourceInstructions === 'string' && nonempty(resourceInstructions) && (
                <PromptDetail label="Resource instructions" path="resources.instructions" note="Instructions declared with workspace resources. Their loading is controlled by the runtime." value={resourceInstructions} />
              )}
              {resourceInstructions && typeof resourceInstructions !== 'string' && (
                <ul><ResourceRow label="resources.instructions" resource={resourceInstructions} /></ul>
              )}
            </div>
          </ProfileSection>
        )}

        {(profile.model?.default || profile.model?.small || profile.model?.provider || profile.model?.reasoningEffort || profile.harness) && <ProfileSection title="Model and runtime">
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {([
              ['Default model', profile.model?.default], ['Provider', profile.model?.provider],
              ['Preferred harness', profile.harness], ['Reasoning', profile.model?.reasoningEffort],
              ['Small model', profile.model?.small],
            ] as const).filter(([, value]) => value).map(([label, value]) => <div key={label} className="min-w-0">
              <dt className="mb-1 text-sm text-muted-foreground">{label}</dt>
              <dd className="break-words font-medium">{value}</dd>
            </div>)}
          </dl>
        </ProfileSection>}

        {(tools.length > 0 || permissions.length > 0) && (
          <ProfileSection title="Tools and permissions">
            <div>
              <ul className="divide-y divide-border/70">
                {[...new Set([...tools.map(([name]) => name), ...permissions.map(([name]) => name)])].sort().map(name => {
                  const enabled = tools.find(([tool]) => tool === name)?.[1]
                  const policy = permissions.find(([permission]) => permission === name)?.[1]
                  return (
                    <li key={name} className="flex min-w-0 items-center justify-between gap-4 py-1.5 first:pt-0 last:pb-0">
                      <code className="min-w-0 break-all font-mono text-sm text-foreground">{name}</code>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {[enabled === undefined ? undefined : enabled ? 'Enabled' : 'Disabled', policy].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </ProfileSection>
        )}

        {mcp.length > 0 && (
          <ProfileSection title="MCP servers">
            <ul className="divide-y divide-border/70">
              {mcp.map(([name, server]) => (
                <li key={name} className="flex min-w-0 items-center justify-between gap-4 py-1.5 first:pt-0 last:pb-0">
                  <span className="min-w-0 break-words font-medium text-foreground">{name}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">{server.enabled === false ? 'Disabled in profile' : 'Enabled in profile'}</span>
                </li>
              ))}
            </ul>
          </ProfileSection>
        )}

        {Boolean(profile.connections?.length) && (
          <ProfileSection title="Hub capabilities">
            <ul className="space-y-2">
              {profile.connections?.map((connection, index) => (
                <li key={`${connection.alias ?? 'connection'}:${index}`} className="min-w-0">
                  <p className="font-medium text-foreground">{connection.alias || 'Hub connection'}</p>
                  {connection.capabilities.length > 0 && (
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {connection.capabilities.map((capability, capabilityIndex) => (
                        <li key={`${capability}:${capabilityIndex}`} className="rounded-full bg-muted px-2 py-0.5 text-sm text-muted-foreground">{capability}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </ProfileSection>
        )}

        {(resources.length > 0 || profile.resources?.failOnError) && (
          <ProfileSection title="Declared resources">
            <ul className="divide-y divide-border/70">
              {resources.map(({ key, ...item }) => <ResourceRow key={key} {...item} />)}
            </ul>
            {profile.resources?.failOnError && (
              <p className="mt-2 text-sm text-muted-foreground">Profile configuration requires declared resources to load successfully.</p>
            )}
          </ProfileSection>
        )}

        {Boolean(profile.subagents && Object.keys(profile.subagents).length) && (
          <ProfileSection title="Subagents">
            <ul className="divide-y divide-border/70">
              {Object.entries(profile.subagents ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, subagent]) => (
                <li key={name} className="py-1.5 first:pt-0 last:pb-0">
                  <p className="font-medium text-foreground">{name}</p>
                  {nonempty(subagent.description) && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{subagent.description}</p>}
                </li>
              ))}
            </ul>
          </ProfileSection>
        )}

        {Boolean(profile.hooks && Object.keys(profile.hooks).length) && (
          <ProfileSection title="Lifecycle hooks">
            <ul className="space-y-1">
              {Object.entries(profile.hooks ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([event, commands]) => (
                <li key={event} className="flex min-w-0 justify-between gap-4">
                  <code className="font-mono text-sm text-foreground">{event}</code>
                  <span className="text-sm text-muted-foreground">{commands.length} configured</span>
                </li>
              ))}
            </ul>
          </ProfileSection>
        )}

        {Boolean(profile.modes && Object.keys(profile.modes).length) && (
          <ProfileSection title="Modes">
            <ul className="flex flex-wrap gap-1.5">
              {Object.keys(profile.modes ?? {}).sort().map(mode => (
                <li key={mode} className="rounded-full bg-muted px-2 py-0.5 text-sm text-muted-foreground">{mode}</li>
              ))}
            </ul>
          </ProfileSection>
        )}
        {(profile.version || profile.tags?.length) && <ProfileSection title="Metadata">
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-muted-foreground">
            {profile.version && <span>Version {profile.version}</span>}
            {profile.tags?.map(tag => <span key={tag}>{tag}</span>)}
          </div>
        </ProfileSection>}
      </ProfileConfiguration>}
    </div>
  )
}

function JsonValue({ value, name }: { value: unknown; name: string }) {
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    return <li className="min-w-0 list-none"><details open>
      <summary className="cursor-pointer break-all rounded px-2 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium text-primary">{name}</span>
        <span className="ml-2 text-xs text-muted-foreground">{Array.isArray(value) ? `Array · ${entries.length}` : `Object · ${entries.length}`}</span>
      </summary>
      <ul className="ml-3 min-w-0 border-l border-border pl-3">
        {entries.map(([key, child]) => <JsonValue key={key} name={key} value={child} />)}
        {entries.length === 0 && <li className="block px-2 py-1 font-mono text-sm text-muted-foreground">{Array.isArray(value) ? '[]' : '{}'}</li>}
      </ul>
    </details></li>
  }
  return <li className="min-w-0 list-none px-2 py-2">
    <span className="block break-all font-mono text-xs font-medium text-primary">{name}<span className="ml-2 font-normal text-muted-foreground">{value === null ? 'null' : typeof value}</span></span>
    <span className="mt-1 block whitespace-pre-wrap break-words font-mono text-sm leading-6 text-foreground">{typeof value === 'string' ? value || '""' : JSON.stringify(value)}</span>
  </li>
}

/** The JSON views use the original supplied object, including fields the overview does not summarize. */
export function AgentProfileViewer({ profile, className = '', showFullProfile = false, ...overview }: AgentProfileViewerProps) {
  const [view, setView] = useState('overview')
  const json = showFullProfile ? JSON.stringify(profile, null, 2) : ''
  return <section className={`min-w-0 text-sm text-foreground ${className}`.trim()} aria-label="Agent profile">
    {showFullProfile ? <Tabs value={view} onValueChange={setView}>
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-2">
        <TabsList aria-label="Profile view" className="h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="json">JSON tree</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-2">
          <CopyButton text={json} />
          <Button asChild variant="outline" size="sm"><a href={`data:application/json;charset=utf-8,${encodeURIComponent(json)}`} download="agent-profile.json">Download</a></Button>
        </div>
      </div>
      <TabsContent value="overview" className="mt-0"><ProfileOverview profile={profile} {...overview} /></TabsContent>
      <TabsContent value="json" className="mt-0">
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border bg-muted/35 p-4"><ProfileSectionHeading title="Full profile JSON" />
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Every configured field, including extensions. Expand or collapse any object.</p></div>
          <ul className="min-w-0 p-2 sm:p-4">{Object.entries(profile).map(([key, value]) => <JsonValue key={key} name={key} value={value} />)}</ul>
        </div>
      </TabsContent>
      <TabsContent value="raw" className="min-w-0 mt-0">
        <CodeBlock code={json} language="json" label="agent-profile.json" showLineNumbers className="max-w-full" />
      </TabsContent>
    </Tabs> : <ProfileOverview profile={profile} {...overview} />}
  </section>
}
