/**
 * Machine-readable surfaces for a Tangle product, generated from one config.
 *
 * Every product publishes the same four things an AI agent needs to become a
 * customer without a human doing the setup:
 *
 * - `/agent-setup.md`: a SKILL.md (Claude Code and Codex skill format) that
 *   doubles as a copy-paste prompt. It takes a fresh agent from nothing to a
 *   verified first call: one owner approval, a scoped key, install, call.
 * - `/llms.txt`: the llms.txt index, pointing at the setup skill first.
 * - `/.well-known/tangle-agent.json`: the Tangle agent manifest.
 * - Markdown for `Accept: text/markdown` on the product's pages, with
 *   `Vary: Accept` on both representations so caches keep them apart.
 *
 * The signup section is rendered here, not in product config, so every
 * product describes Platform's agent signup identically and cannot drift.
 *
 * Web-standard `Request`/`Response` only: safe in Workers, Node and browsers.
 */

/** Manifest schema this module emits. Additive over the 2026-06-16 shape. */
export const AGENT_MANIFEST_SCHEMA_VERSION = '2026-10-09'

export const TANGLE_PLATFORM_ORIGIN = 'https://id.tangle.tools'

export interface AgentSurfaceStep {
  title: string
  /** Fence language for the code block. */
  language: 'bash' | 'js' | 'ts' | 'python' | 'json'
  code: string
  /** What a successful run prints or returns. */
  expect: string
}

export interface AgentSurfaceError {
  symptom: string
  cause: string
  fix: string
}

export interface AgentSurfaceLink {
  label: string
  url: string
}

/**
 * How an agent obtains a key. `device` uses Platform's agent signup: the owner
 * approves once and the agent receives its own capped, revocable key.
 */
export type AgentSignup =
  | {
      kind: 'device'
      /** Platform trusted-app id the key is minted for (`sandbox`, `router`). */
      app: string
      /** Default lifetime spend cap the skill asks for, in USD. */
      budgetUsd?: number
    }
  | {
      kind: 'manual'
      /** Numbered steps the owner performs; each one is a human input. */
      steps: string[]
    }

export interface AgentSurfaceConfig {
  /** Short id used in the skill name: `tangle-<id>-setup`. */
  id: string
  name: string
  /** Public HTTPS origin, no trailing slash. */
  origin: string
  /** What the product is for, in one to three plain sentences. */
  summary: string
  useWhen: string[]
  signup: AgentSignup
  /** Environment variable the key is exported as. */
  apiKeyEnv: string
  /** Runtime prerequisites a fresh machine needs, e.g. `Node.js 20 or newer`. */
  prerequisites: string[]
  install: AgentSurfaceStep[]
  firstCall: AgentSurfaceStep[]
  verify: AgentSurfaceStep[]
  errors: AgentSurfaceError[]
  pricing: {
    /** Plain statement of how usage is charged. */
    summary: string
    /** Public, credential-free price data an agent can quote from. */
    quoteUrl?: string
    url?: string
  }
  next: AgentSurfaceLink[]
  docs?: string
  openapi?: string
  mcp?: { url: string; auth: string }
  related?: Array<{ name: string; manifest?: string; url?: string }>
  /** Extra manifest fields a product already publishes (kept verbatim). */
  manifest?: Record<string, unknown>
}

export interface AgentSurfaceFile {
  path: string
  contentType: string
  body: string
}

const MARKDOWN = 'text/markdown; charset=utf-8'

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '')
}

function fence(step: Pick<AgentSurfaceStep, 'language' | 'code'>): string {
  return ['```' + step.language, step.code.trimEnd(), '```'].join('\n')
}

/**
 * The signup script the skill tells an agent to save and run. Node 18+ only,
 * no dependencies. It never prints the key; it writes `.tangle/api-key` with
 * mode 0600 and reports whether the owner's account can pay yet.
 */
export function agentSignupScript(platformOrigin = TANGLE_PLATFORM_ORIGIN): string {
  // The specifier is interpolated so this module's own import scan (the
  // browser-safe subpath gate) does not read script text as an import.
  return `// Requests a scoped Tangle key for this agent. The owner approves once.
import { mkdirSync, writeFileSync } from ${JSON.stringify('node:fs')}

const flag = (name) => {
  const index = process.argv.indexOf(\`--\${name}\`)
  return index > 0 ? process.argv[index + 1] : undefined
}
const platform = '${trimOrigin(platformOrigin)}'
const app = flag('app')
if (!app) throw new Error('Pass --app (for example --app sandbox)')
const request = { app, agent_name: flag('agent-name') ?? 'coding-agent' }
if (flag('owner-email')) request.owner_email = flag('owner-email')
if (flag('budget-usd')) request.budget_usd = Number(flag('budget-usd'))

async function post(path, body) {
  const response = await fetch(platform + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

const started = await post('/cross-site/device/start', request)
if (started.status !== 200) {
  console.error(\`Signup refused (HTTP \${started.status}): \${JSON.stringify(started.body)}\`)
  process.exit(1)
}
const grant = started.body.data
console.log(grant.agent?.owner_notified
  ? \`Approval email sent to \${request.owner_email}.\`
  : 'Send your owner this approval link.')
console.log(\`Approval link: \${grant.verification_uri_complete}\`)
console.log(\`Confirmation code: \${grant.user_code} (expires in \${Math.round(grant.expires_in / 60)} minutes)\`)
console.log('Waiting for approval...')

const deadline = Date.now() + grant.expires_in * 1000
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, grant.interval * 1000))
  const polled = await post('/cross-site/device/poll', { app, device_code: grant.device_code })
  if (polled.status === 428) continue
  if (polled.status !== 200) {
    console.error(\`Approval failed (HTTP \${polled.status}): \${JSON.stringify(polled.body)}\`)
    process.exit(1)
  }
  const { api_key: apiKey, key, account } = polled.body.data
  mkdirSync('.tangle', { recursive: true, mode: 0o700 })
  writeFileSync('.tangle/api-key', \`\${apiKey}\\n\`, { mode: 0o600 })
  console.log(\`Approved. Key "\${key?.name ?? app}" saved to .tangle/api-key (spend cap $\${key?.budget_usd ?? 'none'}).\`)
  if (account && !account.funded) {
    console.log(\`The owner's account has no credit yet. Ask the owner to add credits: \${account.add_credits_url}\`)
  }
  process.exit(0)
}
console.error('The approval link expired. Run this script again.')
process.exit(1)
`
}

function signupSection(config: AgentSurfaceConfig): string[] {
  const env = config.apiKeyEnv
  if (config.signup.kind === 'manual') {
    return [
      '## 1. Get a key',
      '',
      'This product does not yet support agent signup. Ask your owner to do the following, then continue:',
      '',
      ...config.signup.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      `Store the key outside version control and export it as \`${env}\`. Never print, log, or commit it.`,
    ]
  }
  const budget = config.signup.budgetUsd ?? 25
  return [
    '## 1. Get a scoped key (one owner approval)',
    '',
    'Tangle issues each agent its own key, owned by a person who approves it once.',
    `Ask your owner which email address their Tangle account uses (or should use). Nothing is charged by signing up, and there is no free credit: ${config.name} work is paid from the owner's prepaid balance.`,
    '',
    'Save this script as `tangle-signup.mjs` (Node.js 18 or newer, no dependencies):',
    '',
    fence({ language: 'js', code: agentSignupScript() }),
    '',
    'Run it with your own name and the owner\'s email:',
    '',
    fence({
      language: 'bash',
      code: `node tangle-signup.mjs --app ${config.signup.app} --agent-name "<your agent name>" --owner-email "<owner email>" --budget-usd ${budget}`,
    }),
    '',
    'What happens:',
    '',
    `1. Tangle emails the owner a one-time approval link. If you cannot give an email, omit \`--owner-email\` and send the owner the printed link yourself.`,
    '2. The owner signs in (or creates an account and verifies the email), checks the confirmation code, and approves. That is the only human step.',
    `3. The script writes the key to \`.tangle/api-key\` (mode 600). It can only be used for ${config.name}, it can spend at most the cap you requested, and the owner can revoke it under Keys at any time.`,
    '4. If the script says the account has no credit, ask the owner to add credits at the printed link before your first paid call.',
    '',
    'Then load the key without printing it, and keep it out of version control:',
    '',
    fence({
      language: 'bash',
      code: `export ${env}="$(cat .tangle/api-key)"\ngrep -qxF '.tangle/' .gitignore 2>/dev/null || echo '.tangle/' >> .gitignore`,
    }),
    '',
    'Never print, log, paste, or commit the key.',
  ]
}

function stepsSection(heading: string, steps: AgentSurfaceStep[]): string[] {
  if (steps.length === 0) return []
  const lines = [heading, '']
  for (const step of steps) {
    lines.push(`${step.title}:`, '', fence(step), '', `Expected: ${step.expect}`, '')
  }
  return lines
}

/** The agent setup skill: valid SKILL.md and a plain copy-paste prompt. */
export function renderAgentSetupSkill(config: AgentSurfaceConfig): string {
  const origin = trimOrigin(config.origin)
  const description = `Set up ${config.name} for this agent end to end: get a scoped API key with one owner approval, install the client, make the first successful call, and verify it.`
  const lines: string[] = [
    '---',
    `name: tangle-${config.id}-setup`,
    `description: ${description}`,
    '---',
    '',
    `# Set up ${config.name}`,
    '',
    config.summary,
    '',
    'Use it when:',
    '',
    ...config.useWhen.map((item) => `- ${item}`),
    '',
    'Complete every step below in order and stop at the first failure; the error table at the end names the fix.',
    'Prerequisites: ' + config.prerequisites.join('; ') + '.',
    '',
    ...signupSection(config),
    '',
    ...stepsSection('## 2. Install', config.install),
    ...stepsSection('## 3. Make the first call', config.firstCall),
    ...stepsSection('## 4. Verify it worked', config.verify),
    '## Common errors',
    '',
    '| Symptom | Cause | Fix |',
    '| --- | --- | --- |',
    ...config.errors.map(
      (error) => `| ${error.symptom.replace(/\|/g, '\\|')} | ${error.cause.replace(/\|/g, '\\|')} | ${error.fix.replace(/\|/g, '\\|')} |`,
    ),
    '',
    '## Pricing',
    '',
    config.pricing.summary,
    ...(config.pricing.quoteUrl ? ['', `Current prices, no key needed: ${config.pricing.quoteUrl}`] : []),
    ...(config.pricing.url ? [`Pricing page: ${config.pricing.url}`] : []),
    '',
    '## Next',
    '',
    ...config.next.map((link) => `- [${link.label}](${link.url})`),
    '',
    '## Machine-readable surfaces',
    '',
    `- Agent manifest: ${origin}/.well-known/tangle-agent.json`,
    `- llms.txt: ${origin}/llms.txt`,
    `- This setup skill: ${origin}/agent-setup.md`,
    ...(config.openapi ? [`- OpenAPI: ${config.openapi}`] : []),
    ...(config.mcp ? [`- MCP server: ${config.mcp.url} (${config.mcp.auth})`] : []),
    '',
  ]
  return lines.join('\n')
}

/** llms.txt index for the product. The setup skill is the first link. */
export function renderLlmsTxt(config: AgentSurfaceConfig): string {
  const origin = trimOrigin(config.origin)
  return [
    `# ${config.name}`,
    '',
    `> ${config.summary}`,
    '',
    `To set this product up from scratch, fetch ${origin}/agent-setup.md and follow it. It is a complete prompt and a SKILL.md: one owner approval, a scoped key, install, first call, verification.`,
    '',
    '## Start here',
    '',
    `- [Agent setup skill](${origin}/agent-setup.md): from nothing to a verified first call`,
    `- [Agent manifest](${origin}/.well-known/tangle-agent.json): machine-readable contract`,
    ...(config.openapi ? [`- [OpenAPI](${config.openapi}): HTTP API schema`] : []),
    ...(config.mcp ? [`- [MCP server](${config.mcp.url}): ${config.mcp.auth}`] : []),
    ...(config.docs ? [`- [Documentation](${config.docs})`] : []),
    '',
    '## Pricing',
    '',
    `- ${config.pricing.summary}`,
    ...(config.pricing.quoteUrl ? [`- [Machine-readable prices](${config.pricing.quoteUrl}): no key needed`] : []),
    '',
    '## Optional',
    '',
    ...config.next.map((link) => `- [${link.label}](${link.url})`),
    ...(config.related ?? []).map(
      (surface) => `- [${surface.name}](${surface.manifest ?? surface.url ?? ''})`,
    ),
    '',
  ].join('\n')
}

/** Markdown for the product's home page, served for `Accept: text/markdown`. */
export function renderHomeMarkdown(config: AgentSurfaceConfig): string {
  const origin = trimOrigin(config.origin)
  return [
    `# ${config.name}`,
    '',
    config.summary,
    '',
    '## Use it when',
    '',
    ...config.useWhen.map((item) => `- ${item}`),
    '',
    '## Hand this to your agent',
    '',
    `An AI agent can set ${config.name} up by itself: fetch ${origin}/agent-setup.md and follow it. The owner approves once; nothing else needs a human.`,
    '',
    '## Pricing',
    '',
    config.pricing.summary,
    ...(config.pricing.quoteUrl ? ['', `Machine-readable prices: ${config.pricing.quoteUrl}`] : []),
    '',
    '## Machine-readable surfaces',
    '',
    `- ${origin}/llms.txt`,
    `- ${origin}/.well-known/tangle-agent.json`,
    `- ${origin}/agent-setup.md`,
    ...(config.openapi ? [`- ${config.openapi}`] : []),
    ...(config.mcp ? [`- ${config.mcp.url}`] : []),
    '',
  ].join('\n')
}

/** The `/.well-known/tangle-agent.json` document. */
export function renderAgentManifest(config: AgentSurfaceConfig): Record<string, unknown> {
  const origin = trimOrigin(config.origin)
  const signup =
    config.signup.kind === 'device'
      ? {
          kind: 'device_authorization',
          app: config.signup.app,
          start: `POST ${TANGLE_PLATFORM_ORIGIN}/cross-site/device/start`,
          poll: `POST ${TANGLE_PLATFORM_ORIGIN}/cross-site/device/poll`,
          request: {
            app: config.signup.app,
            agent_name: 'string, 1-64 characters',
            owner_email: 'optional; Tangle emails this owner the approval link',
            budget_usd: `optional lifetime spend cap, 1-1000, default ${config.signup.budgetUsd ?? 25}`,
          },
          human_inputs: ['The owner approves the request once.'],
          key: {
            scope: `${config.signup.app} only`,
            revocable_at: `${TANGLE_PLATFORM_ORIGIN}/app/keys`,
          },
          payment: 'Prepaid credit on the owner account. No free credit; paid calls are refused until the owner adds credits.',
          add_credits: `${TANGLE_PLATFORM_ORIGIN}/app/billing`,
        }
      : { kind: 'manual', steps: config.signup.steps }
  return {
    ...config.manifest,
    schema_version: AGENT_MANIFEST_SCHEMA_VERSION,
    name: config.name,
    description: config.summary,
    homepage: `${origin}/`,
    llms: `${origin}/llms.txt`,
    agent_setup: `${origin}/agent-setup.md`,
    ...(config.docs ? { docs: config.docs } : {}),
    ...(config.openapi ? { openapi: config.openapi } : {}),
    ...(config.mcp ? { mcp: config.mcp } : {}),
    environment: { api_key: config.apiKeyEnv },
    signup,
    pricing: {
      summary: config.pricing.summary,
      ...(config.pricing.quoteUrl ? { quote: config.pricing.quoteUrl } : {}),
      ...(config.pricing.url ? { page: config.pricing.url } : {}),
    },
    ...(config.related?.length ? { related_surfaces: config.related } : {}),
  }
}

/** Every static surface as files, for products that ship them as assets. */
export function agentSurfaceFiles(config: AgentSurfaceConfig): AgentSurfaceFile[] {
  return [
    { path: 'agent-setup.md', contentType: MARKDOWN, body: renderAgentSetupSkill(config) },
    { path: 'llms.txt', contentType: 'text/plain; charset=utf-8', body: renderLlmsTxt(config) },
    { path: 'index.md', contentType: MARKDOWN, body: renderHomeMarkdown(config) },
    {
      path: '.well-known/tangle-agent.json',
      contentType: 'application/json; charset=utf-8',
      body: `${JSON.stringify(renderAgentManifest(config), null, 2)}\n`,
    },
  ]
}

/**
 * True when `Accept` ranks `text/markdown` strictly above `text/html` and
 * gives it a nonzero weight. A browser's default header never does.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false
  let markdown = -1
  let html = -1
  for (const part of accept.split(',')) {
    const [rawType, ...params] = part.trim().split(';')
    const type = rawType?.trim().toLowerCase()
    let quality = 1
    for (const param of params) {
      const [key, value] = param.trim().split('=')
      if (key?.trim().toLowerCase() === 'q') {
        const parsed = Number(value)
        quality = Number.isFinite(parsed) ? parsed : 0
      }
    }
    if (type === 'text/markdown') markdown = Math.max(markdown, quality)
    if (type === 'text/html') html = Math.max(html, quality)
  }
  return markdown > 0 && markdown > html
}

/** A copy of `response` whose `Vary` includes `Accept`. */
export function withVaryAccept(response: Response): Response {
  const vary = response.headers.get('vary')
  if (vary && vary.split(',').some((value) => value.trim().toLowerCase() === 'accept')) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.set('vary', vary ? `${vary}, Accept` : 'Accept')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export interface AgentSurfaceHandler {
  /**
   * Answers a surface request (`/agent-setup.md`, `/llms.txt`, the manifest,
   * or a negotiated markdown page), or `null` to let the app answer it.
   */
  handle(request: Request): Response | null
  /** Adds `Vary: Accept` when the path has a markdown representation. */
  finalize(request: Request, response: Response): Response
}

/**
 * Request handler over {@link agentSurfaceFiles}. `markdownPages` maps extra
 * HTML paths to markdown served on negotiation; `/` always maps to the home
 * markdown.
 */
export function createAgentSurfaceHandler(
  config: AgentSurfaceConfig,
  options: { markdownPages?: Record<string, string> } = {},
): AgentSurfaceHandler {
  const files = new Map(agentSurfaceFiles(config).map((file) => [`/${file.path}`, file]))
  const negotiated = new Map<string, string>([
    ['/', renderHomeMarkdown(config)],
    ...Object.entries(options.markdownPages ?? {}),
  ])

  function respond(body: string, contentType: string, method: string, vary: boolean): Response {
    const headers = new Headers({
      'content-type': contentType,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    })
    if (vary) headers.set('vary', 'Accept')
    return new Response(method === 'HEAD' ? null : body, { status: 200, headers })
  }

  return {
    handle(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return null
      const path = new URL(request.url).pathname
      const file = files.get(path)
      if (file) return respond(file.body, file.contentType, request.method, false)
      const markdown = negotiated.get(path)
      if (markdown !== undefined && prefersMarkdown(request.headers.get('accept'))) {
        return respond(markdown, MARKDOWN, request.method, true)
      }
      return null
    },
    finalize(request, response) {
      return negotiated.has(new URL(request.url).pathname) ? withVaryAccept(response) : response
    },
  }
}
