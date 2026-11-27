/**
 * A skill directory mounted for `.claude/skills` keeps its relative links on
 * whichever harness a workspace turn runs. The skill is read from a real Git
 * commit and mounted with Agent Interface's `mountSkillDirectory`, beside one
 * ordinary inline file. The shell defers inline files, provisions through
 * `ensureWorkspaceSandbox` and runs a turn through `streamSandboxPrompt`, both
 * on the Sandbox SDK, against a peer that answers as the API and the sidecar
 * do: it writes the deferred batch into a real directory, and lowers each
 * turn's profile for the turn's harness with the materializer the sidecar
 * runs, into the same directory. The files on disk are the ones those two
 * writers place.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mountSkillDirectory, type AgentProfile, type AgentProfileFileMount, type MountedSkillDirectory } from '@tangle-network/agent-interface'
import { applyWorkspacePlan, materializeProfile, skillDirForHarness, type HarnessId } from '@tangle-network/agent-profile-materialize'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ensureWorkspaceSandbox, streamSandboxPrompt, type SandboxRuntimeConfig } from '../src/sandbox/index'

const SKILL = 'release-notes'
const DIRECTORY = `skills/${SKILL}`
const MOUNTED_FOR = '.claude/skills'

const SKILL_MD = `---
name: ${SKILL}
description: Write release notes from merged changes. Use when a release is cut.
---

# Release notes

Group changes as [the format](references/format.md) says.
A breaking change follows [the breaking example](references/examples/breaking.md).
Run [the entry check](./scripts/check-entry.sh) on each entry.
The [published guide](https://example.invalid/guide) and [this section](#release-notes) are not files.
`

const TREE: Record<string, { content: string; executable?: boolean }> = {
  [`${DIRECTORY}/SKILL.md`]: { content: SKILL_MD },
  [`${DIRECTORY}/references/format.md`]: { content: '# Format\n\nOne line per change, newest first.\n' },
  [`${DIRECTORY}/references/examples/breaking.md`]: {
    content: '# Breaking\n\n- Removed `legacyMode`; pass `mode` instead. Ünïcode stays exact: ✓\n',
  },
  [`${DIRECTORY}/scripts/check-entry.sh`]: { content: '#!/bin/sh\ntest -n "$1"\n', executable: true },
}

// An inline file outside any skill directory: the shell writes it at its declared path.
const BRIEF_CONTENT = '# Brief\n\nShip on Thursday.\n'
const BRIEF: AgentProfileFileMount = {
  path: 'notes/brief.md',
  resource: { kind: 'inline', name: 'brief.md', content: BRIEF_CONTENT },
}

const BOX_ID = 'sb_skill_directory'
const RUNTIME = `/v1/sandboxes/${BOX_ID}/runtime`

let root: string
let repo: string
let ref: string
let mounted: MountedSkillDirectory

// A throwaway fixture repository: its commits carry a fixture identity and run no host hooks.
const FIXTURE_GIT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...FIXTURE_GIT, ...args])

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'app-skill-directory-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  git('init', '-q')
  for (const [path, file] of Object.entries(TREE)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true })
    writeFileSync(join(repo, path), file.content, { mode: file.executable ? 0o755 : 0o644 })
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  ref = git('rev-parse', 'HEAD').toString('utf8').trim()
  // The directory as Git lists it at the commit, with its bytes and modes.
  const files = git('ls-tree', '-r', ref, '--', `${DIRECTORY}/`).toString('utf8').trim().split('\n').map((line) => {
    const [meta, path] = line.split('\t') as [string, string]
    return {
      path: path.slice(DIRECTORY.length + 1),
      content: git('show', `${ref}:${path}`).toString('utf8'),
      ...(meta.startsWith('100755') ? { executable: true } : {}),
    }
  })
  mounted = mountSkillDirectory(
    { repository: 'example/skills', ref, directory: DIRECTORY, name: SKILL },
    files,
    { skillsDirectory: MOUNTED_FOR },
  )
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const composeProfile = (): AgentProfile => ({
  name: 'release-notes-app',
  resources: { skills: [mounted.skill], files: [...mounted.files, BRIEF] },
})

interface PeerRequest { method: string; path: string; body: Record<string, unknown> | undefined }

/** Answers as the API and the sidecar; deferred writes and each turn's lowering land in `workspace`. */
async function startPeer(workspace: string, agentDir: string) {
  const requests: PeerRequest[] = []
  const unanswered: string[] = []
  const primed = new Map<string, AgentProfile>()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    const method = request.method ?? 'GET'
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    requests.push({ method, path, body })
    response.setHeader('content-type', 'application/json')
    const box = {
      id: BOX_ID,
      name: (requests.find(r => r.method === 'POST' && r.path === '/v1/sandboxes')?.body?.name as string | undefined) ?? 'box',
      status: 'running',
      filesystemIncarnationId: '11111111-1111-4111-8111-111111111111',
      filesystemIncarnationProvenance: 'fresh',
      filesystemIncarnationReadiness: 'ready',
      createdAt: '2026-11-27T00:00:00.000Z',
      connection: {
        runtimeUrl: `${origin}${RUNTIME}`,
        authToken: 'runtime-proof',
        authTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      },
    }
    if (method === 'GET' && path === '/v1/sandboxes') return void response.end(JSON.stringify([]))
    if ((method === 'POST' && path === '/v1/sandboxes') || (method === 'GET' && path === `/v1/sandboxes/${BOX_ID}`)) {
      return void response.end(JSON.stringify(box))
    }
    if (method === 'POST' && path === `${RUNTIME}/files/write-batch`) {
      const files: Record<string, unknown> = {}
      for (const file of (body?.files ?? []) as { path: string; content: string; mode?: number }[]) {
        const target = join(workspace, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content, { mode: file.mode ?? 0o644 })
        files[file.path] = {
          success: true,
          path: file.path,
          hash: createHash('sha256').update(file.content).digest('hex'),
          size: Buffer.byteLength(file.content),
          mtime: Date.now(),
        }
      }
      return void response.end(JSON.stringify({ success: true, data: { files } }))
    }
    if (method === 'POST' && path === `${RUNTIME}/agents/profiles`) {
      const profile = body?.profile as AgentProfile
      const sha256 = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
      primed.set(sha256, profile)
      return void response.end(JSON.stringify({ sha256 }))
    }
    if (method === 'POST' && path === `${RUNTIME}/agents/run/stream`) {
      const backend = body?.backend as { type: HarnessId; profile?: AgentProfile; profileSha256?: string }
      const turnProfile = backend.profileSha256 === undefined ? backend.profile : primed.get(backend.profileSha256)
      if (turnProfile === undefined) return void response.writeHead(409).end(JSON.stringify({ code: 'PROFILE_NOT_CACHED' }))
      // The sidecar lowers the turn's profile for the turn's harness.
      try {
        const receipt = applyWorkspacePlan(materializeProfile(turnProfile, backend.type), workspace, { existingFiles: 'reject', agentDir })
        if (receipt.unsupported.length > 0) throw new Error(`unsupported: ${JSON.stringify(receipt.unsupported)}`)
      } catch (error) {
        return void response.writeHead(422).end(JSON.stringify({ code: 'MATERIALIZE_FAILED', message: String(error) }))
      }
      response.setHeader('content-type', 'text/event-stream')
      const sessionId = 'session_skill_directory'
      const executionId = 'execution_skill_directory'
      for (const [type, data] of [
        ['execution.started', { executionId, sessionId }],
        ['result', { success: true, status: 'completed', response: 'done' }],
        ['done', { success: true, status: 'completed', outcome: { type: 'completed' }, sessionId, executionId }],
      ] as const) response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      return void response.end()
    }
    unanswered.push(`${method} ${path}`)
    response.writeHead(404).end(JSON.stringify({ code: 'NOT_FOUND' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    requests,
    unanswered,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** Relative file links in a markdown document; URLs and in-page anchors are not files. */
function relativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map(match => match[1] as string)
    .filter(target => !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .filter(target => !target.startsWith('#'))
}

const sourceBytes = (relative: string) => git('show', `${ref}:${DIRECTORY}/${relative}`)

it.each<'codex' | 'opencode' | 'claude-code'>(['codex', 'opencode', 'claude-code'])('a %s workspace turn finds every file SKILL.md links beside it', async (harness) => {
  const workspace = join(root, `workspace-${harness}`)
  const agentDir = join(root, `agent-${harness}`)
  mkdirSync(workspace)
  mkdirSync(agentDir)
  const peer = await startPeer(workspace, agentDir)
  try {
    const shell: SandboxRuntimeConfig = {
      credentials: () => ({ apiKey: 'app-skill-directory-proof', baseUrl: peer.origin }),
      name: (workspaceId) => `skill-directory-${workspaceId}`,
      metadata: (h) => ({ harness: h }),
      connectedIntegrationIds: async () => [],
      env: async () => ({}),
      files: async () => [],
      secrets: async () => [],
      profile: composeProfile,
      deferProfileFiles: true,
      // An explicit model key keeps the SDK from reading this host's CLI login.
      provider: { providerName: 'openai-compat', apiKey: 'app-skill-directory-proof', defaultModel: 'openai/gpt-5', routerBaseUrl: 'https://router.invalid' },
      backendModelAtCreate: true,
    }
    const box = await ensureWorkspaceSandbox(shell, { workspaceId: `w-${harness}`, harness })
    const events: unknown[] = []
    for await (const event of streamSandboxPrompt(shell, box, 'Write the release notes.', { harness })) events.push(event)
    expect(events.map(event => (event as { type?: unknown }).type), `unanswered: ${peer.unanswered.join(', ')}`).toContain('done')

    const skillsDirectory = skillDirForHarness(harness)
    if (skillsDirectory === null) throw new Error(`${harness}: no skills`)
    const skillDir = join(workspace, skillsDirectory, SKILL)
    const links = relativeLinks(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'))
    expect(links).toEqual(['references/format.md', 'references/examples/breaking.md', './scripts/check-entry.sh'])
    for (const link of links) {
      const relative = link.replace(/^\.\//, '')
      expect(existsSync(join(skillDir, relative)), `${link} beside ${skillsDirectory}/${SKILL}/SKILL.md`).toBe(true)
      expect(readFileSync(join(skillDir, relative)), link).toEqual(sourceBytes(relative))
    }
    const mode = (path: string) => statSync(join(skillDir, path)).mode & 0o777
    expect(mode('scripts/check-entry.sh')).toBe(0o755)
    expect(mode('references/format.md')).toBe(0o644)
    // Written once, beside the skill: the declared directory exists only where
    // the harness discovers skills in it.
    expect(existsSync(join(workspace, MOUNTED_FOR))).toBe(skillsDirectory === MOUNTED_FOR)

    // The shell wrote only the ordinary file, at its declared path; the skill's
    // files rode with the turn's profile.
    const written = peer.requests
      .filter(request => request.path === `${RUNTIME}/files/write-batch`)
      .flatMap(request => ((request.body?.files ?? []) as { path: string }[]).map(file => file.path))
    expect(written).toEqual([BRIEF.path])
    expect(readFileSync(join(workspace, BRIEF.path), 'utf8')).toBe(BRIEF_CONTENT)
  } finally {
    await peer.close()
  }
})
