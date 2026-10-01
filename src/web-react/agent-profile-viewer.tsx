import type { ReactNode } from 'react'
import type { AgentProfile, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'

export interface AgentProfileViewerProps {
  profile: AgentProfile
  className?: string
  defaultExpanded?: boolean
}

function nonempty(value: string | undefined): value is string {
  return Boolean(value?.trim())
}

function preview(value: string, limit = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
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
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
        {path && <code className="break-all font-mono text-xs text-foreground">{path}</code>}
        <span className="min-w-0 break-all text-sm text-foreground">{name}</span>
        {resource.kind === 'github' && resource.ref && (
          <span className="shrink-0 text-xs text-muted-foreground">at {resource.ref}</span>
        )}
      </div>
      {resource.kind === 'inline' && nonempty(resource.content) && (
        <details className="mt-1.5">
          <summary className="w-fit cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            View inline content
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs leading-relaxed text-foreground">
            {resource.content}
          </pre>
        </details>
      )}
    </li>
  )
}

function PromptDetail({ label, note, value }: { label: string; note?: string; value: string }) {
  return (
    <details className="group min-w-0">
      <summary className="flex min-w-0 cursor-pointer list-none items-start gap-2 rounded-md py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mt-1 shrink-0 text-muted-foreground transition-transform group-open:rotate-90">›</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">{label}</span>
          {note && <span className="ml-2 text-xs text-muted-foreground">{note}</span>}
          <span className="mt-1 block truncate text-xs text-muted-foreground">{preview(value)}</span>
        </span>
      </summary>
      <pre className="mb-2 ml-4 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm leading-relaxed text-foreground">
        {value}
      </pre>
    </details>
  )
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 py-3 first:pt-0 last:pb-0" aria-label={title}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
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
export function AgentProfileViewer({ profile, className = '', defaultExpanded = true }: AgentProfileViewerProps) {
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
    profile.harness || profile.description || profile.version || profile.tags?.length || hasConfiguration)

  return (
    <section className={`min-w-0 text-sm ${className}`.trim()} aria-label="Agent profile">
      <header className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="break-words text-lg font-semibold leading-tight text-foreground">
          {nonempty(profile.name) ? profile.name : 'Unnamed profile'}
        </h2>
        {nonempty(profile.description) && (
          <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{profile.description}</p>
        )}
        {(profile.model?.default || profile.model?.small || profile.model?.reasoningEffort || profile.harness || profile.version || profile.tags?.length) && (
          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {profile.model?.default && <div className="flex gap-1"><dt className="text-muted-foreground">Default model</dt><dd className="font-medium text-foreground">{profile.model.default}</dd></div>}
            {profile.model?.small && <div className="flex gap-1"><dt className="text-muted-foreground">Small model</dt><dd className="font-medium text-foreground">{profile.model.small}</dd></div>}
            {profile.model?.reasoningEffort && <div className="flex gap-1"><dt className="text-muted-foreground">Reasoning</dt><dd className="font-medium text-foreground">{profile.model.reasoningEffort}</dd></div>}
            {profile.harness && <div className="flex gap-1"><dt className="text-muted-foreground">Preferred harness</dt><dd className="font-medium text-foreground">{profile.harness}</dd></div>}
            {profile.version && <div className="flex gap-1"><dt className="text-muted-foreground">Version</dt><dd className="font-medium text-foreground">{profile.version}</dd></div>}
            {profile.tags?.map(tag => <div key={tag} className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{tag}</div>)}
          </dl>
        )}
      </header>

      {!hasProfileDetails && (
        <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">No profile details are configured.</p>
      )}

      {hasConfiguration && <details open={defaultExpanded} className="group mt-4 rounded-xl border border-border bg-card p-4 shadow-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
          <span className="font-medium text-foreground">Profile configuration</span>
          <span className="text-xs text-muted-foreground">
            {[hasBehavior && 'Instructions', (tools.length || permissions.length) > 0 && 'Tools', mcp.length > 0 && 'MCP', (resources.length || profile.resources?.failOnError) && 'Resources', profile.connections?.length && 'Connections', profile.subagents && Object.keys(profile.subagents).length > 0 && 'Subagents', profile.hooks && Object.keys(profile.hooks).length > 0 && 'Hooks', profile.modes && Object.keys(profile.modes).length > 0 && 'Modes'].filter(Boolean).join(' · ')}
          </span>
        </summary>
      <div className="divide-y divide-border border-t border-border">
        {hasBehavior && (
          <ProfileSection title="Instructions">
            <div className="space-y-2">
              {nonempty(prompt?.systemPrompt) && (
                <PromptDetail label="System prompt" note="Replaces the harness default" value={prompt.systemPrompt} />
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
                  <h4 className="font-medium text-foreground">Project instructions <span className="ml-1 font-normal text-xs text-muted-foreground">Lower-privilege workspace guidance</span></h4>
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

        {(tools.length > 0 || permissions.length > 0) && (
          <ProfileSection title="Tool policy">
            <div>
              <ul className="divide-y divide-border/70">
                {[...new Set([...tools.map(([name]) => name), ...permissions.map(([name]) => name)])].sort().map(name => {
                  const enabled = tools.find(([tool]) => tool === name)?.[1]
                  const policy = permissions.find(([permission]) => permission === name)?.[1]
                  return (
                    <li key={name} className="flex min-w-0 items-center justify-between gap-4 py-1.5 first:pt-0 last:pb-0">
                      <code className="min-w-0 break-all font-mono text-xs text-foreground">{name}</code>
                      <span className="shrink-0 text-xs text-muted-foreground">
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
                  <span className="shrink-0 text-xs text-muted-foreground">{server.enabled === false ? 'Disabled in profile' : 'Enabled in profile'}</span>
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
                        <li key={`${capability}:${capabilityIndex}`} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{capability}</li>
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
              <p className="mt-2 text-xs text-muted-foreground">Profile configuration requires declared resources to load successfully.</p>
            )}
          </ProfileSection>
        )}

        {Boolean(profile.subagents && Object.keys(profile.subagents).length ||
    profile.hooks && Object.keys(profile.hooks).length || profile.modes && Object.keys(profile.modes).length) && (
          <ProfileSection title="Subagents">
            <ul className="divide-y divide-border/70">
              {Object.entries(profile.subagents ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, subagent]) => (
                <li key={name} className="py-1.5 first:pt-0 last:pb-0">
                  <p className="font-medium text-foreground">{name}</p>
                  {nonempty(subagent.description) && <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{subagent.description}</p>}
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
                  <code className="font-mono text-xs text-foreground">{event}</code>
                  <span className="text-xs text-muted-foreground">{commands.length} configured</span>
                </li>
              ))}
            </ul>
          </ProfileSection>
        )}

        {Boolean(profile.modes && Object.keys(profile.modes).length) && (
          <ProfileSection title="Modes">
            <ul className="flex flex-wrap gap-1.5">
              {Object.keys(profile.modes ?? {}).sort().map(mode => (
                <li key={mode} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{mode}</li>
              ))}
            </ul>
          </ProfileSection>
        )}
      </div>
      </details>}
    </section>
  )
}
