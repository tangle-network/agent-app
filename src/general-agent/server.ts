import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HubClient, resolveHubAuth } from '@tangle-network/hub-sdk'
import { TCloudClient } from '@tangle-network/tcloud'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { initializeGeneralHome, inspectGeneralHome } from './home'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const router = 'https://router.tangle.tools/v1'
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error('Missing sandbox Router proxy credential; refusing owner-key fallback')
const credentialFile = process.env.TANGLE_API_KEY_FILE
if (!credentialFile) throw new Error('Missing refreshable sandbox Hub credential file')
const cloud = new TCloudClient({ apiKey, baseURL: router, model: process.env.TANGLE_GENERAL_MODEL, retry: false, timeout: 180_000 })
const hub = new HubClient({ baseUrl: 'https://id.tangle.tools', authHeaders: async () => ({
  Authorization: 'Bearer ' + resolveHubAuth({ TANGLE_API_KEY: (await readFile(credentialFile, 'utf8')).trim() }),
}) })
const home = await initializeGeneralHome()
const server = new McpServer({ name: 'tangle-general-agent', version: '1.0.0' })
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

server.registerTool('home_status', { description: 'Read the persistent home path, git revision and memory byte caps.', inputSchema: {} }, async () => text(await inspectGeneralHome(home)))
server.registerTool('image_generate', {
  description: 'Generate an image through Tangle Router. Return the actual provider artifact, not an invented link. Paid; requires owner approval.',
  inputSchema: { prompt: z.string().min(1).max(16_000), model: z.string().min(1), size: z.string().optional() },
}, async ({ prompt, model, size }) => {
  const response = await cloud.imageGenerate({ prompt, model, size, n: 1, response_format: 'url' })
  const image = response.data[0]
  if (!image?.b64_json && !image?.url) throw new Error('Router returned no image')
  if (!image.b64_json) return text(response)
  const bytes = Buffer.from(image.b64_json, 'base64')
  if (bytes.length === 0 || bytes.length > 30_000_000) throw new Error('Image outside the supported size bound')
  const filename = join(home, 'artifacts', `${randomUUID()}.png`)
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 })
  return { content: [{ type: 'text' as const, text: JSON.stringify({ created: response.created, filename, bytes: bytes.length, revisedPrompt: image.revised_prompt }) },
    { type: 'image' as const, data: image.b64_json, mimeType: 'image/png' }] }
})
server.registerTool('video_generate', {
  description: 'Submit video generation through Tangle Router. A queued job is NOT a finished video. Return the actual job ID/status; paid and owner-approved.',
  inputSchema: { prompt: z.string().min(1).max(16_000), model: z.string().min(1), duration: z.number().int().min(1).max(30).optional() },
}, async args => text(await cloud.videoGenerate(args)))
server.registerTool('router_models', { description: 'Discover currently available Router models before choosing image, video or reasoning models.', inputSchema: {} }, async () => text(await cloud.models()))
server.registerTool('browser_task', {
  description: 'Run the published browser-agent-driver on a real site through the operator allowlist proxy. Returns its real result/trajectory. Requires owner approval.',
  inputSchema: { url: z.string().url(), goal: z.string().min(1).max(16_000), maxTurns: z.number().int().min(1).max(30).default(15) },
}, async ({ url, goal, maxTurns }) => {
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Only HTTP(S) sites are supported')
  const proxy = process.env.TANGLE_BROWSER_PROXY
  if (!proxy) throw new Error('Browser proxy not configured; refusing open internet fallback')
  const proxyUrl = new URL(proxy)
  if (!['http:', 'https:'].includes(proxyUrl.protocol) || proxyUrl.username || proxyUrl.password) throw new Error('Invalid browser proxy')
  const dir = join(home, 'artifacts', `browser-${randomUUID()}`)
  await mkdir(dir, { mode: 0o700 })
  const cli = join(dirname(require.resolve('@tangle-network/browser-agent-driver')), 'cli.js')
  const { stdout, stderr } = await exec(process.execPath, [cli, 'run', '--url', url, '--goal', goal,
    '--provider', 'openai', '--base-url', router, '--model', process.env.TANGLE_GENERAL_MODEL ?? 'openai/gpt-5.6-luna',
    '--proxy', proxy, '--observation-mode', 'hybrid', '--max-turns', String(maxTurns), '--json', '--quiet'], {
    cwd: dir, timeout: 240_000, maxBuffer: 4_000_000,
    env: { ...process.env, OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: router },
  })
  await writeFile(join(dir, 'result.json'), stdout, { mode: 0o600 })
  await writeFile(join(dir, 'driver.log'), stderr, { mode: 0o600 })
  return text({ artifacts: dir, result: JSON.parse(stdout) })
})
server.registerTool('hub_search', { description: 'Discover published tools on Hub connections: email, calendar, ph0ny and others. Never invent action paths.',
  inputSchema: { query: z.string().min(1).max(1000), provider: z.string().optional() },
}, async ({ query, provider }) => text(await hub.tools.search(query, { provider, limit: 30 })))
server.registerTool('hub_describe', { description: 'Read the exact Hub action schema, required connection and policy before invoking it.',
  inputSchema: { path: z.string().min(1).max(512) },
}, async ({ path }) => text(await hub.tools.describe(path)))
server.registerTool('hub_invoke', { description: 'Execute a discovered Hub action. Calls use ph0ny on the Hub line; email/calendar stay on Hub. Approval-required is pending, not success. Reuse requestId for retries. This tool cannot grant approval.',
  inputSchema: { path: z.string().min(1).max(512), connectionId: z.string().min(1).max(128), requestId: z.string().min(8).max(128), input: z.record(z.string(), z.unknown()) },
}, async ({ path, connectionId, requestId, input }) => text(await hub.tools.invoke(path, input, { connectionId, idempotencyKey: requestId })))
await server.connect(new StdioServerTransport())
