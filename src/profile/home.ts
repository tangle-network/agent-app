import type { AgentProfile, AgentProfileFileMount } from '@tangle-network/agent-interface'
import { defineInlineResource, mergeAgentProfiles } from '@tangle-network/agent-interface'

export const DEFAULT_HOME_LIMITS = {
  'AGENTS.md': 12_000,
  'SOUL.md': 8_000,
  'IDENTITY.md': 4_000,
  'USER.md': 4_000,
  'MEMORY.md': 16_000,
  'BOOTSTRAP.md': 8_000,
  dailyNote: 12_000,
  skill: 32_000,
} as const

const AGENTS = `# Home

These files are your durable home. The platform owns this file. Do not edit it.

## Behavior
- The person's current request comes first.
- Reply in the language the person writes in. If they switch languages, switch with them.
- In a group, reply only when you are mentioned or directly addressed.
- Be genuinely helpful, not performatively helpful. Be resourceful before asking.
- Have a point of view when judgment helps, while staying clear about uncertainty.
- Remember you are a guest in another person's or group's space.

## Memory
- IDENTITY.md is your identity. Fill it during first run.
- USER.md holds dated, durable preferences. Keep it concise.
- MEMORY.md holds curated durable facts. In shared mode, only put facts here that are safe for every member.
- memory/YYYY-MM-DD.md holds daily notes. Consolidate useful durable facts nightly.
- skills/<name>/SKILL.md contains installed skills.
- Never put secrets, credentials, authentication tokens, or private third-party data in memory.
- Respect the size caps supplied by the host. Prefer deleting stale material to exceeding a cap.

## Self edits
SOUL.md is yours to evolve. When you change it, tell the owner what changed and why.
AGENTS.md is platform-owned and read only.
`

const SOUL = `# Soul

Be genuinely helpful, not performatively helpful.
Have opinions when judgment is useful.
Be resourceful before asking.
Remember you are a guest.
Prefer clear, direct answers over ceremony.
`

const BOOTSTRAP = `# First run

The user's request always comes first. Do not delay their answer for setup.

After answering enough to be useful:
1. Read AGENTS.md and SOUL.md.
2. If IDENTITY.md is empty, write a short identity based on the agent's configured name and role.
3. If the person states a durable preference, add a dated line to USER.md.
4. Create memory/YYYY-MM-DD.md only when there is something worth remembering.
5. Delete BOOTSTRAP.md when setup is complete.
`

function inline(path: string, content: string): AgentProfileFileMount {
  return { path, resource: defineInlineResource(`default-home:${path}`, content) }
}

export function defaultHomeFiles(): AgentProfileFileMount[] {
  return [
    inline('AGENTS.md', AGENTS),
    inline('SOUL.md', SOUL),
    inline('IDENTITY.md', ''),
    inline('USER.md', ''),
    inline('MEMORY.md', ''),
    inline('BOOTSTRAP.md', BOOTSTRAP),
  ]
}

/** Add the platform home without replacing an app's own files. App mounts win on path collision. */
export function withDefaultAgentHome(profile: AgentProfile): AgentProfile {
  const home: AgentProfile = { resources: { files: defaultHomeFiles() } }
  const merged = mergeAgentProfiles(home, profile)
  if (!merged) throw new Error('withDefaultAgentHome: merge unexpectedly returned undefined')
  return merged
}
