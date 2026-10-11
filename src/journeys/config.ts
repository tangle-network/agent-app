/**
 * What an app tells the journeys kit about itself: where it is served, which
 * test identities may sign in, and the chat DOM a turn is measured on.
 *
 * It lives at the app root as `journeys.config.mjs`, beside
 * `launch-invariants.config.mjs`:
 *
 *     import { defineJourneys } from '@tangle-network/agent-app/journeys'
 *     export default defineJourneys({
 *       app: 'gtm',
 *       baseUrl: 'https://gtm.tangle.tools',
 *       identities: {
 *         member: { emailEnv: 'SMOKE_EMAIL', passwordEnv: 'SMOKE_PASSWORD', signIn: 'tangle' },
 *       },
 *       chat: { assistant: '.gtm-assistant-markdown', failureText: [/stopped before finishing/i] },
 *     })
 *
 * Credentials are named, never stored: the config holds environment variable
 * names, and the values reach the process from the host's vault.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_FAILURE_TEXT, DEFAULT_STOPPED_TEXT } from './score.js'

export type SignInMethod = 'password' | 'tangle'

export interface JourneyIdentity {
  /** Environment variable that holds the account's email. */
  readonly emailEnv: string
  /** Environment variable that holds the account's password. */
  readonly passwordEnv: string
  /**
   * `password`: the app's own email sign-in (better-auth `sign-in/email`).
   * `tangle`: "Log in with Tangle": the app's SSO start, the Platform's email
   * sign-in, then the app's callback.
   */
  readonly signIn: SignInMethod
}

/** The ids a thread URL carries. */
export interface ThreadRoute {
  readonly threadId: string
  readonly workspaceId?: string
}

/**
 * The chat DOM a turn is read from. Defaults are agent-app's own components:
 * `ChatComposer` (the composer card, "Message input", "Send", "Stop response")
 * and the transcript's failure rows (`role="alert"`, `data-notice-tone="error"`).
 */
export interface ChatContract {
  /** Region whose text decides a turn's outcome. */
  readonly transcript: string
  /** Assistant reply blocks. `null` measures reply text as transcript growth beyond the prompt. */
  readonly assistant: string | null
  /** Progress lines inside the transcript ("Sending…", "Searching the web"). */
  readonly status: string
  /** Elements that mark a failed turn. */
  readonly failureNodes: string
  /** Failure lines this app shows in plain text, added to the package defaults. */
  readonly failureText: readonly RegExp[]
  /** Lines meaning the person stopped the turn, added to the package defaults. */
  readonly stoppedText: readonly RegExp[]
  /** The card holding the composer's input and action row. */
  readonly composer: string
  /** Accessible names inside the composer card. */
  readonly inputName: string
  readonly sendName: string
  readonly stopName: string
  /** Accessible name of a failed turn's retry control. */
  readonly retryName: RegExp
  /** A created thread's path. Named groups `threadId` (required) and `workspaceId`. */
  readonly threadPath: RegExp | null
  /** Path that lists a thread's running turns as JSON `{ running: string[] }`; the server's word on completion. */
  readonly runningTurns: ((route: ThreadRoute) => string) | null
  /** POST paths that mean the composer submitted, besides the page's own route. */
  readonly sendPaths: readonly RegExp[]
}

export interface AuthPaths {
  readonly session: string
  readonly passwordSignIn: string
  readonly tangleStart: string
}

export interface JourneysConfig {
  /** Short name, used for state and output folders. */
  readonly app: string
  /** Origin the journeys drive. `JOURNEYS_BASE_URL` overrides it, for a local stack. */
  readonly baseUrl: string
  readonly identities: Readonly<Record<string, JourneyIdentity>>
  readonly chat?: Partial<ChatContract>
  readonly auth?: Partial<AuthPaths>
  /** Chat turns one journey may send. Default 6. */
  readonly maxTurns?: number
  /** Sessions and raw recordings. Default `~/.local/state/agent-app-journeys/<app>`. */
  readonly stateDir?: string
  /** Files safe to copy off the host. Default `<stateDir>/out`. */
  readonly outDir?: string
}

export interface ResolvedJourneysConfig {
  /** Marks a config whose defaults are filled; resolving it again returns it unchanged. */
  readonly resolved: true
  readonly app: string
  readonly baseUrl: string
  readonly identities: Readonly<Record<string, JourneyIdentity>>
  readonly chat: ChatContract
  readonly auth: AuthPaths
  readonly maxTurns: number
  readonly stateDir: string
  readonly outDir: string
}

export const DEFAULT_CHAT_CONTRACT: ChatContract = {
  transcript: 'main',
  assistant: null,
  status: '[role="status"]',
  failureNodes: '[role="alert"], [data-notice-tone="error"]',
  failureText: [],
  stoppedText: [],
  composer: '[data-testid="composer-card"]',
  inputName: 'Message input',
  sendName: 'Send',
  stopName: 'Stop response',
  retryName: /^Retry$/,
  threadPath: null,
  runningTurns: null,
  sendPaths: [/^\/api\/(?:[^/]+\/)*chat$/],
}

export const DEFAULT_AUTH_PATHS: AuthPaths = {
  session: '/api/auth/get-session',
  passwordSignIn: '/api/auth/sign-in/email',
  tangleStart: '/auth/tangle/start',
}

export const CONFIG_FILE_NAMES = ['journeys.config.mjs', 'journeys.config.js'] as const

/** Identity for a typed config; also validates it. */
export function defineJourneys(config: JourneysConfig): JourneysConfig {
  resolveJourneysConfig(config)
  return config
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/** Fill defaults and refuse a config that cannot drive a journey. */
export function resolveJourneysConfig(config: JourneysConfig | ResolvedJourneysConfig, env: Record<string, string | undefined> = process.env): ResolvedJourneysConfig {
  if ('resolved' in config && config.resolved === true) return config
  const problems: string[] = []
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(config.app ?? '')) problems.push('app must be a short lowercase name such as "gtm"')
  const base = (env.JOURNEYS_BASE_URL ?? config.baseUrl ?? '').replace(/\/$/, '')
  if (!/^https?:\/\/[^/]+$/.test(base)) problems.push(`baseUrl must be an origin such as https://app.example.com, got "${base}"`)
  const identities = config.identities ?? {}
  if (Object.keys(identities).length === 0) problems.push('identities must name at least one test identity')
  for (const [name, identity] of Object.entries(identities)) {
    if (name === 'anon') problems.push('"anon" is reserved for a signed-out context')
    if (!/^[a-z][a-z0-9-]*$/.test(name)) problems.push(`identity "${name}": use a lowercase name`)
    for (const key of ['emailEnv', 'passwordEnv'] as const) {
      if (!ENV_NAME.test(identity[key] ?? '')) problems.push(`identity "${name}": ${key} must be an environment variable NAME, not a value`)
    }
    if (identity.signIn !== 'password' && identity.signIn !== 'tangle') problems.push(`identity "${name}": signIn must be "password" or "tangle"`)
  }
  const chat: ChatContract = {
    ...DEFAULT_CHAT_CONTRACT,
    ...config.chat,
    failureText: [...DEFAULT_FAILURE_TEXT, ...(config.chat?.failureText ?? [])],
    stoppedText: [...DEFAULT_STOPPED_TEXT, ...(config.chat?.stoppedText ?? [])],
  }
  if (chat.threadPath && !/\(\?<threadId>/.test(chat.threadPath.source)) problems.push('chat.threadPath needs a named group (?<threadId>…)')
  const maxTurns = config.maxTurns ?? 6
  if (!Number.isInteger(maxTurns) || maxTurns < 0) problems.push('maxTurns must be a whole number')
  if (problems.length) throw new Error(`journeys config: ${problems.join('; ')}`)
  const stateDir = resolve(env.JOURNEYS_STATE_DIR ?? config.stateDir ?? join(homedir(), '.local/state/agent-app-journeys', config.app))
  return {
    resolved: true,
    app: config.app,
    baseUrl: base,
    identities,
    chat,
    auth: { ...DEFAULT_AUTH_PATHS, ...config.auth },
    maxTurns,
    stateDir,
    outDir: resolve(env.JOURNEYS_OUT ?? config.outDir ?? join(stateDir, 'out')),
  }
}

/** The ids in a thread URL, or null when the URL is not a thread on this origin. */
export function threadRouteIn(url: string, config: Pick<ResolvedJourneysConfig, 'baseUrl' | 'chat'>): ThreadRoute | null {
  if (!config.chat.threadPath) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.origin !== new URL(config.baseUrl).origin) return null
  const match = config.chat.threadPath.exec(parsed.pathname)
  const threadId = match?.groups?.threadId
  if (!threadId) return null
  const workspaceId = match.groups?.workspaceId
  return workspaceId ? { threadId, workspaceId } : { threadId }
}

/** Environment variable names the config needs, for a vault loader. */
export function credentialNames(config: Pick<JourneysConfig, 'identities'>): string[] {
  return [...new Set(Object.values(config.identities).flatMap((identity) => [identity.emailEnv, identity.passwordEnv]))]
}

/** `JOURNEYS_CONFIG`, else the first config file in `dir`. */
export async function loadJourneysConfig(dir = process.cwd(), env: Record<string, string | undefined> = process.env): Promise<ResolvedJourneysConfig> {
  const file = env.JOURNEYS_CONFIG
    ? resolve(dir, env.JOURNEYS_CONFIG)
    : CONFIG_FILE_NAMES.map((name) => join(dir, name)).find((path) => existsSync(path))
  if (!file || !existsSync(file)) {
    throw new Error(`no ${CONFIG_FILE_NAMES[0]} in ${dir}; add one at the app root or set JOURNEYS_CONFIG`)
  }
  const loaded = (await import(pathToFileURL(file).href)) as { default?: JourneysConfig }
  if (!loaded.default) throw new Error(`${file} must export default defineJourneys({ … })`)
  return resolveJourneysConfig(loaded.default, env)
}
