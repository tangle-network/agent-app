import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AgentSurfaceConfig,
  agentSignupScript,
  agentSurfaceFiles,
  createAgentSurfaceHandler,
  prefersMarkdown,
  renderAgentManifest,
  renderAgentSetupSkill,
} from '../src/agent-surfaces/index'
import { runAgentSurfacesCli } from '../src/agent-surfaces/generate'

const run = promisify(execFile)

const product: AgentSurfaceConfig = {
  id: 'widget',
  name: 'Tangle Widget',
  origin: 'https://widget.tangle.tools/',
  summary: 'Widgets for agents.',
  useWhen: ['You need a widget.'],
  signup: { kind: 'device', app: 'sandbox', budgetUsd: 10 },
  apiKeyEnv: 'TANGLE_API_KEY',
  prerequisites: ['Node.js 20 or newer'],
  install: [{ title: 'Install', language: 'bash', code: 'npm install widget', expect: 'added 1 package' }],
  firstCall: [{ title: 'Call', language: 'bash', code: 'node call.mjs', expect: 'ok' }],
  verify: [{ title: 'Check', language: 'bash', code: 'node check.mjs', expect: 'verified' }],
  errors: [{ symptom: 'HTTP 402', cause: 'No credit | none', fix: 'Add credits' }],
  pricing: { summary: 'Billed per use.', quoteUrl: 'https://widget.tangle.tools/v1/pricing' },
  next: [{ label: 'Docs', url: 'https://widget.tangle.tools/docs' }],
  manifest: { safe_discovery_calls: ['GET /health'] },
}

const tempDirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-surfaces-'))
  tempDirs.push(dir)
  return dir
}

describe('agent setup skill', () => {
  it('is a SKILL.md with name and description frontmatter that walks signup, install, call, verify', () => {
    const skill = renderAgentSetupSkill(product)
    const frontmatter = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill)
    expect(frontmatter?.[1]).toBe('tangle-widget-setup')
    expect(frontmatter?.[2]).toContain('Tangle Widget')
    const order = [
      '## 1. Get a scoped key (one owner approval)',
      '## 2. Install',
      '## 3. Make the first call',
      '## 4. Verify it worked',
      '## Common errors',
    ].map((heading) => skill.indexOf(heading))
    expect(order.every((index) => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(skill).toContain('node tangle-signup.mjs start --app sandbox')
    expect(skill).toContain('node tangle-signup.mjs wait')
    expect(skill).toContain('--budget-usd 10')
    // A pipe inside a table cell is escaped so the row keeps three columns.
    expect(skill).toContain('| HTTP 402 | No credit \\| none | Add credits |')
    expect(skill).toContain('https://widget.tangle.tools/agent-setup.md')
  })

  it('lists the owner steps when a product has no agent signup', () => {
    const skill = renderAgentSetupSkill({
      ...product,
      signup: { kind: 'manual', steps: ['Open Settings and create a key.'] },
    })
    expect(skill).toContain('## 1. Get a key')
    expect(skill).toContain('1. Open Settings and create a key.')
    expect(skill).not.toContain('tangle-signup.mjs')
    expect(renderAgentManifest({ ...product, signup: { kind: 'manual', steps: ['x'] } }).signup).toEqual({
      kind: 'manual',
      steps: ['x'],
    })
  })
})

describe('agent signup script', () => {
  it('starts at once, waits in short re-runnable steps, stores the key with mode 0600, and never prints it', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    let approved = false
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>
        calls.push({ path: request.url ?? '', body })
        response.setHeader('content-type', 'application/json')
        if (request.url === '/cross-site/device/start') {
          response.end(
            JSON.stringify({
              success: true,
              data: {
                device_code: 'dvc_test',
                user_code: 'ABCD-EFGH',
                verification_uri_complete: 'https://id.example/cross-site/device?app=sandbox&user_code=ABCD-EFGH',
                expires_in: 600,
                interval: 0.05,
                agent: { owner_notified: true },
              },
            }),
          )
          return
        }
        if (!approved) {
          response.statusCode = 428
          response.end(JSON.stringify({ success: false, error: { code: 'AUTHORIZATION_PENDING' } }))
          return
        }
        response.end(
          JSON.stringify({
            success: true,
            data: {
              api_key: 'sk-tan-secretvalue',
              key: { name: 'Agent: bot (sandbox, ABCD-EFGH)', budget_usd: 10 },
              account: { funded: false, add_credits_url: 'https://id.example/app/billing' },
            },
          }),
        )
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const dir = tempDir()
    writeFileSync(join(dir, 'tangle-signup.mjs'), agentSignupScript(origin))
    const node = (args: string[]) =>
      run(process.execPath, ['tangle-signup.mjs', ...args], { cwd: dir }).then(
        (result) => ({ code: 0, ...result }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      )

    const started = await node(['start', '--app', 'sandbox', '--agent-name', 'bot', '--owner-email', 'owner@example.com', '--budget-usd', '10'])
    expect(started.code).toBe(0)
    expect(calls[0]).toEqual({
      path: '/cross-site/device/start',
      body: { app: 'sandbox', agent_name: 'bot', owner_email: 'owner@example.com', budget_usd: 10 },
    })
    expect(started.stdout).toContain('Approval email sent to owner@example.com.')
    expect(started.stdout).toContain('Confirmation code: ABCD-EFGH')

    const pending = await node(['wait', '--seconds', '0.2'])
    expect(pending.code).toBe(3)
    expect(pending.stdout).toContain('Still waiting')

    approved = true
    const done = await node(['wait'])
    expect(done.code).toBe(0)
    expect(calls.slice(1).every((call) => call.path === '/cross-site/device/poll' && call.body.device_code === 'dvc_test')).toBe(true)
    expect(done.stdout).toContain('Ask the owner to add credits: https://id.example/app/billing')
    for (const output of [started.stdout, pending.stdout, done.stdout]) {
      expect(output).not.toContain('sk-tan-secretvalue')
    }
    const keyPath = join(dir, '.tangle', 'api-key')
    expect(readFileSync(keyPath, 'utf8')).toBe('sk-tan-secretvalue\n')
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
  })

  it('exits non-zero with the server reason when signup is refused', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 429
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: 'owner_notification_throttled' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const dir = tempDir()
    writeFileSync(
      join(dir, 'tangle-signup.mjs'),
      agentSignupScript(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    )
    const failure = await run(process.execPath, ['tangle-signup.mjs', 'start', '--app', 'sandbox'], { cwd: dir }).catch(
      (error: { code: number; stderr: string }) => error,
    )
    expect(failure).toMatchObject({ code: 1 })
    expect((failure as { stderr: string }).stderr).toContain('owner_notification_throttled')
  })
})

describe('agent surface handler', () => {
  const handler = createAgentSurfaceHandler(product, { markdownPages: { '/docs': '# Docs' } })

  it('serves the setup skill, llms.txt and manifest from one config', async () => {
    const skill = handler.handle(new Request('https://widget.tangle.tools/agent-setup.md'))
    expect(skill?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await skill?.text()).toBe(renderAgentSetupSkill(product))

    const llms = await handler.handle(new Request('https://widget.tangle.tools/llms.txt'))?.text()
    expect(llms?.split('\n')[0]).toBe('# Tangle Widget')
    expect(llms).toContain('[Agent setup skill](https://widget.tangle.tools/agent-setup.md)')

    const manifest = (await handler
      .handle(new Request('https://widget.tangle.tools/.well-known/tangle-agent.json'))
      ?.json()) as Record<string, unknown>
    expect(manifest).toMatchObject({
      agent_setup: 'https://widget.tangle.tools/agent-setup.md',
      safe_discovery_calls: ['GET /health'],
      signup: { kind: 'device_authorization', app: 'sandbox' },
      pricing: { quote: 'https://widget.tangle.tools/v1/pricing' },
    })
  })

  it('negotiates markdown only when the caller ranks it above HTML, and varies on Accept', async () => {
    const markdown = handler.handle(
      new Request('https://widget.tangle.tools/', { headers: { accept: 'text/markdown, text/html;q=0.5' } }),
    )
    expect(markdown?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(markdown?.headers.get('vary')).toBe('Accept')
    expect(await markdown?.text()).toContain('## Hand this to your agent')
    expect(await handler.handle(new Request('https://widget.tangle.tools/docs', { headers: { accept: 'text/markdown' } }))?.text()).toBe('# Docs')

    const browser = new Request('https://widget.tangle.tools/', {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    })
    expect(handler.handle(browser)).toBeNull()
    const html = handler.finalize(browser, new Response('<html>', { headers: { vary: 'Accept-Encoding' } }))
    expect(html.headers.get('vary')).toBe('Accept-Encoding, Accept')
    const unrelated = new Request('https://widget.tangle.tools/app')
    expect(handler.finalize(unrelated, new Response('x')).headers.get('vary')).toBeNull()
    expect(handler.handle(new Request('https://widget.tangle.tools/agent-setup.md', { method: 'POST' }))).toBeNull()
  })

  it('reads Accept weights rather than substring matches', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true)
    expect(prefersMarkdown('text/html, text/markdown')).toBe(false)
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false)
    expect(prefersMarkdown('text/html;q=0.4, text/markdown;q=0.9')).toBe(true)
    expect(prefersMarkdown('*/*')).toBe(false)
    expect(prefersMarkdown(null)).toBe(false)
  })
})

describe('static generation', () => {
  it('writes every surface and its check fails once a committed file drifts', () => {
    const dir = tempDir()
    const configPath = join(dir, 'agent-surfaces.json')
    writeFileSync(configPath, JSON.stringify(product))
    const out = join(dir, 'public')

    expect(runAgentSurfacesCli([configPath, '--out', out, '--check'])).toBe(1)
    expect(runAgentSurfacesCli([configPath, '--out', out])).toBe(0)
    for (const file of agentSurfaceFiles(product)) {
      expect(readFileSync(join(out, file.path), 'utf8')).toBe(file.body)
    }
    expect(runAgentSurfacesCli([configPath, '--out', out, '--check'])).toBe(0)

    writeFileSync(join(out, 'agent-setup.md'), 'edited by hand')
    expect(runAgentSurfacesCli([configPath, '--out', out, '--check'])).toBe(1)
    expect(runAgentSurfacesCli([configPath])).toBe(2)
  })
})
