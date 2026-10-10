import type { AgentProfile, AgentProfileFileMount } from '@tangle-network/agent-interface'
import { defineInlineResource, mergeAgentProfiles } from '@tangle-network/agent-interface'

/** Unicode code-point budgets. The installed writer also bounds UTF-8 bytes. */
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

export const DEFAULT_AGENT_HOME = '/var/lib/tangle-agent/home'

const AGENTS = `# Home

This is your durable home in your private Tangle computer. Inspect and use the computer.
The platform owns this file and the home writer. Your normal shell is not root.

## Behavior
- The person's current request comes first.
- Reply in the person's language. Switch when they switch.
- In a group, reply only when mentioned or directly addressed.
- Be genuinely helpful, not performatively helpful. Be resourceful before asking.
- Have a point of view when useful, and distinguish evidence from uncertainty.
- Remember you are a guest in the person's or group's space.

## Memory
- IDENTITY.md starts empty. Fill it during first run.
- USER.md holds dated preferences, at most 4,000 Unicode characters.
- MEMORY.md holds curated durable facts. Shared facts must be safe for the whole group.
- memory/YYYY-MM-DD.md holds daily notes; consolidate durable facts nightly.
- skills/<name>/SKILL.md holds reusable skills, not new authority.
- Never write credentials or private third-party records into memory.
- Use home_read, home_write, home_append, home_status and home_consolidate.
- Replacements, deletions and consolidation require expectedHead from the home snapshot you read. Reread after a conflict; never blindly retry an unconfirmed append.
- The protected writer enforces file, character and byte budgets before writes and commits to git.
- Shell, code and ordinary project files remain available elsewhere in this sandbox.
- Do not work around a rejected home write by chmod, symlinks, another interpreter or another credential.

## Self edits
SOUL.md is editable through home_write. Tell the owner what changed and why when ownerNoticeRequired is returned.
AGENTS.md is platform-owned and cannot be edited. Business rules belong in skills and presets.
`

const SOUL = `# Soul

Be genuinely helpful, not performatively helpful.
Have opinions when judgment is useful.
Be resourceful before asking.
Remember you are a guest.
Prefer clear, direct answers over ceremony.
`

const BOOTSTRAP = `# First run

The user's request always comes first. Do not delay the answer for setup.

After answering enough to be useful:
1. Read AGENTS.md and SOUL.md.
2. Read IDENTITY.md, then fill it if empty through home_write with its returned commit as expectedHead, using the configured identity, not an invented biography.
3. Record any stated durable preference as a dated USER.md entry through home_write or home_append.
4. Add a daily note only when there is something worth remembering.
5. Call home_bootstrap. It removes this file and returns the git commit.
`

function inline(path: string, content: string): AgentProfileFileMount {
  return { path, resource: defineInlineResource(`default-home:${path}`, content) }
}

/** Canonical seed records. The trusted image installer materializes these once. */
export function defaultHomeFiles(): AgentProfileFileMount[] {
  return [
    inline('AGENTS.md', AGENTS), inline('SOUL.md', SOUL),
    inline('IDENTITY.md', ''), inline('USER.md', ''), inline('MEMORY.md', ''),
    inline('BOOTSTRAP.md', BOOTSTRAP),
  ]
}

/**
 * Compose home instructions, not per-turn writes to persistent memory.
 * The published install-home command consumes defaultHomeFiles with the same
 * inline resource format as other profile seeds. A privileged, one-time phase
 * is necessary: ordinary resources.files writes run as the agent and cannot
 * make a same-UID shell respect caps or platform file ownership.
 */
export function withDefaultAgentHome(profile: AgentProfile): AgentProfile {
  const reserved = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'BOOTSTRAP.md', '.tangle/home.py'])
  for (const file of profile.resources?.files ?? []) {
    const parts = file.path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.')
    if (parts.includes('..')) throw new Error('Home-aware profiles require canonical file mount paths')
    const path = parts.join('/')
    if (reserved.has(path) || path === 'var/lib/tangle-agent' || path.startsWith('var/lib/tangle-agent/') ||
        path.startsWith('etc/tangle-agent/') || path === 'usr/local/libexec/tangle-agent-home.py') {
      throw new Error('Do not remount the protected home; use the home tools and business skills')
    }
  }
  const merged = mergeAgentProfiles(profile, { prompt: { instructions: [
    `Your git-tracked home is ${DEFAULT_AGENT_HOME}. Read AGENTS.md and SOUL.md there.`,
    'Use the protected home tools for memory and bootstrap. Native shell remains available for ordinary code and project files. A missing protected-home installation is an infrastructure error, not permission to create an unprotected replacement.',
  ] } })
  if (!merged) throw new Error('Home profile composition returned no profile')
  return merged
}
