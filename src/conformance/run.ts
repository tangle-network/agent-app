import { readRevision } from './revision.js'
import { Failure, signIn, type MemberSession, type SignInMode } from './session.js'
import { computerTurn, mintKey, openOperatorAccess, plainTurn, revokeKey, type ComputerProof, type OperatorAccess } from './turns.js'

export type CheckName = 'sign-in' | 'revision' | 'operator-access' | 'plain-turn' | 'computer-turn' | 'key-revoke'

/**
 * One check's verdict. `blocked` means an earlier check it depends on failed, so nothing was measured; a blocked
 * check fails the run like a failed one, and its cause names the check that blocked it.
 */
export interface CheckResult {
  /** When the check started, ISO 8601. */
  at: string
  app: string
  url: string
  check: CheckName
  status: 'pass' | 'fail' | 'blocked'
  ms: number
  /** Why a failed or blocked check is not a pass. */
  cause?: string
  /** What a passing check observed: the revision read, the thread a turn ran in. */
  detail?: string
}

export interface ConformanceOptions {
  /** A label for the result lines, e.g. `gtm`. */
  app: string
  /** The deployed origin, e.g. `https://gtm.tangle.tools`. */
  origin: string
  /** The member that signs in. Required: sign-in is the first thing a customer does. */
  member?: { mode: SignInMode; email: string; password: string }
  /** A key that already has `operator:read` and `operator:run`; without one, the signed-in member mints a one-hour key. */
  operatorKey?: string
  /** Id or exact name of the workspace the turns run in: the app's canary or smoke workspace, never a customer's. */
  workspace?: string
  /** `digest` hashes a fresh nonce on the workspace computer; `file` has the computer save a file the app serves back. */
  computer?: ComputerProof
  /** The computer turn's model. The plain turn keeps the app's own model, so the served model is still checked once. */
  computerModel?: string
  /** Where the `file` proof is saved, relative to the workspace root. */
  fileDir?: string
  /** The budget of each turn, a cold box included. */
  turnMs?: number
  /** Fail unless the served revision starts with, or is a prefix of, this. */
  expectRevision?: string
  /** Called with each result as it lands. */
  onResult?(result: CheckResult): void
}

const DEFAULT_TURN_MS = 300_000
// Company spend rule: checks run on the flat-rate plan; per-token models are for product serving with real users.
const DEFAULT_COMPUTER_MODEL = 'glm-5.3'

/** Why an unexpected error is not a pass, in a line. */
function describe(error: unknown): string {
  if (error instanceof Failure) return error.message
  if (error instanceof Error) {
    const cause = error.cause as { code?: unknown } | undefined
    return `${error.name}: ${error.message}${typeof cause?.code === 'string' ? ` (${cause.code})` : ''}`
  }
  return String(error)
}

/** Runs the checks against one deployed app and returns every result, in the order they ran. */
export async function checkDeployedApp(options: ConformanceOptions): Promise<CheckResult[]> {
  const origin = options.origin.replace(/\/+$/, '')
  const turnMs = options.turnMs ?? DEFAULT_TURN_MS
  const secrets = [options.member?.password, options.operatorKey].filter((value): value is string => Boolean(value && value.length >= 6))
  const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text)
  const results: CheckResult[] = []

  const record = (result: CheckResult) => {
    const clean = { ...result, ...(result.cause ? { cause: redact(result.cause) } : {}), ...(result.detail ? { detail: redact(result.detail) } : {}) }
    results.push(clean)
    options.onResult?.(clean)
  }
  /** Runs `body`; whatever it returns is the passing detail, whatever it throws is the cause. */
  async function check<T>(name: CheckName, body: () => Promise<{ value: T; detail?: string }>): Promise<T | undefined> {
    const at = new Date().toISOString()
    const started = Date.now()
    const base = { at, app: options.app, url: origin, check: name }
    try {
      const { value, detail } = await body()
      record({ ...base, status: 'pass', ms: Date.now() - started, ...(detail ? { detail } : {}) })
      return value
    } catch (error) {
      record({ ...base, status: 'fail', ms: Date.now() - started, cause: describe(error) })
      return undefined
    }
  }
  const blocked = (name: CheckName, because: string) =>
    record({ at: new Date().toISOString(), app: options.app, url: origin, check: name, status: 'blocked', ms: 0, cause: because })

  let session: MemberSession | undefined
  if (!options.member) {
    const at = new Date().toISOString()
    record({ at, app: options.app, url: origin, check: 'sign-in', status: 'fail', ms: 0, cause: 'no member is configured: give the canary member email and password' })
  } else {
    const member = options.member
    session = await check('sign-in', async () => {
      const signedIn = await signIn({ origin, ...member })
      return { value: signedIn.session, detail: signedIn.detail }
    })
  }

  await check('revision', async () => {
    const served = await readRevision(origin, options.expectRevision)
    return { value: served, detail: `${served.revision} (${served.source})` }
  })

  let minted: { id: string } | null = null
  let access: OperatorAccess | undefined
  if (!options.operatorKey && !session) {
    blocked('operator-access', 'blocked by sign-in: no operator key is configured, and the member did not sign in to mint one')
  } else {
    access = await check('operator-access', async () => {
      let secret = options.operatorKey
      if (!secret) {
        const created = await mintKey(session!)
        secrets.push(created.key)
        secret = created.key
        minted = { id: created.id }
      }
      const opened = await openOperatorAccess({ origin, key: secret, workspace: options.workspace, requestMs: turnMs + 60_000 })
      return {
        value: opened,
        detail: `${minted ? 'a minted one-hour key' : 'the configured operator key'} reaches "${opened.workspace.name}" with ${opened.scopes.join(', ')}`,
      }
    })
  }

  if (access) {
    const open = access
    await check('plain-turn', async () => ({ value: true, detail: await plainTurn(open, turnMs) }))
    await check('computer-turn', async () => ({
      value: true, detail: await computerTurn(open, turnMs, options.computer ?? 'digest', options.fileDir ?? 'proof', options.computerModel ?? DEFAULT_COMPUTER_MODEL),
    }))
  } else {
    blocked('plain-turn', 'blocked by operator-access')
    blocked('computer-turn', 'blocked by operator-access')
  }

  // A key this run minted is revoked whether or not the turns ran: it names the member and would outlive the run.
  const mintedKey = minted as { id: string } | null
  if (mintedKey && session) {
    const member = session
    await check('key-revoke', async () => {
      await revokeKey(member, mintedKey.id)
      return { value: true, detail: 'the minted key was revoked' }
    })
  }
  return results
}
