import type { ReactNode } from 'react'
import type { AgentProfile, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'

export interface AgentProfileViewerProps {
  profile: AgentProfile
  className?: string
  defaultExpanded?: boolean
  /** Hide the identity when the surrounding workspace already names the agent. */
  showIdentity?: boolean
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

function PromptDetail({ label, note, value }: { label?: string; note?: string; value: string }) {
  return <div className="min-w-0 space-y-2">
    {label && <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h4 className="font-medium text-foreground">{label}</h4>
      {note && <span className="text-sm text-muted-foreground">{note}</span>}
    </div>}
    <div className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{value}</div>
  </div>
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="grid min-w-0 gap-3 border-t border-border py-6 first:border-t-0 first:pt-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6" aria-label={title}>
    <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
    <div className="min-w-0">{children}</div>
  </section>
}

function ProfileConfiguration({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  if (expanded) return <div>{children}</div>
  return <details className="group/config border-t border-border pt-4">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      Profile configuration <span aria-hidden="true" className="text-muted-foreground group-open/config:rotate-90">›</span>
    </summary>
    <div className="pt-4">{children}</div>
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
export function AgentProfileViewer({ profile, className = '', defaultExpanded = true, showIdentity = true }: AgentProfileViewerProps) {
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
    <section className={`min-w-0 text-sm text-foreground ${className}`.trim()} aria-label="Agent profile">
      {(showIdentity || nonempty(profile.description)) && <header className="mb-6 min-w-0">
        {showIdentity && <h2 className="break-words text-lg font-semibold leading-tight text-foreground">
          {nonempty(profile.name) ? profile.name : 'Unnamed profile'}
        </h2>}
        {nonempty(profile.description) && <p className="mt-2 whitespace-pre-wrap break-words leading-6 text-muted-foreground">{profile.description}</p>}
      </header>}
      {!hasProfileDetails && <p className="text-muted-foreground">No profile details are configured.</p>}
      {(hasConfiguration || profile.model || profile.harness || profile.version || profile.tags?.length) && <ProfileConfiguration expanded={defaultExpanded}>
        {hasBehavior && (
          <ProfileSection title="Instructions">
            <div className="space-y-6">
              {nonempty(prompt?.systemPrompt) && (
                <PromptDetail label={nonempty(prompt.appendSystemPrompt) || instructions.length ? "System instructions" : undefined} note="Replaces default instructions" value={prompt.systemPrompt} />
              )}
              {nonempty(prompt?.appendSystemPrompt) && (
                <PromptDetail
                  label="Added system prompt"
                  note={nonempty(prompt.systemPrompt) ? 'Supplements the system prompt above' : 'Supplements the harness default'}
                  value={prompt.appendSystemPrompt}
                />
              )}
              {instructions.length > 0 && (
                <div className="space-y-1.5">
                  <h4 className="font-medium text-foreground">Project instructions <span className="ml-1 font-normal text-sm text-muted-foreground">Lower-privilege workspace guidance</span></h4>
                  <ul className="space-y-2">
                    {instructions.map((instruction, index) => (
                      <li key={`${index}:${instruction}`}>
                        <PromptDetail label={`Instruction ${index + 1}`} value={instruction} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {typeof resourceInstructions === 'string' && nonempty(resourceInstructions) && (
                <PromptDetail label="Resource instructions" note="Configured in resources" value={resourceInstructions} />
              )}
              {resourceInstructions && typeof resourceInstructions !== 'string' && (
                <ul><ResourceRow label="Instruction resource" resource={resourceInstructions} /></ul>
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
    </section>
  )
}
