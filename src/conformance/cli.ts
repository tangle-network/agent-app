#!/usr/bin/env node
/**
 * `agent-app-conformance` — the basics every deployed agent app must do, checked against its production origin:
 * sign in, read the served revision, answer a plain turn, and answer a turn only the workspace computer can.
 * It prints one JSON line per check as the check ends: app, url, check, status, ms, and the cause of a failure.
 *
 *   agent-app-conformance --app-url https://gtm.tangle.tools --auth password --workspace "GTM release canary"
 *
 * The member comes from the environment so it never reaches a process listing:
 *   CONFORMANCE_EMAIL, CONFORMANCE_PASSWORD   the canary member (--email / --password are accepted but visible to `ps`)
 *   CONFORMANCE_OPERATOR_KEY                  optional: an operator key with operator:read and operator:run;
 *                                             without one the signed-in member mints an hour-long key and revokes it
 *
 * Options:
 *   --app-url <origin>        required
 *   --app <label>             names the app in each line (default: the origin's first host label)
 *   --auth password|sso       how the member signs in (default password); sso goes through Tangle Platform
 *   --workspace <id|name>     the canary or smoke workspace the turns run in (default: the key's only workspace)
 *   --computer digest|file    digest: hash a fresh nonce on the computer; file: the computer saves a file the app serves back
 *   --file-dir <dir>          where the file proof is saved (default proof)
 *   --turn-ms <ms>            the budget of each turn, a cold box included (default 300000)
 *   --expect-revision <sha>   fail unless the served revision matches
 *
 * Exits 0 when every check passes, 1 when any fails or is blocked, 2 on a usage error.
 */
import { invokedAsScript } from '../signoff/invoked-as-script.js'
import { checkDeployedApp, type ConformanceOptions } from './run.js'
import type { ComputerProof } from './turns.js'
import type { SignInMode } from './session.js'

const VALUE_FLAGS = new Set(['--app-url', '--app', '--auth', '--email', '--password', '--workspace', '--computer', '--file-dir', '--turn-ms', '--expect-revision'])

function parseConformanceArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ConformanceOptions {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const [flag = '', inline] = argv[index]!.split(/=(.*)/s, 2)
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown option ${argv[index]}`)
    const value = inline ?? argv[++index]
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`)
    flags.set(flag, value)
  }
  const url = flags.get('--app-url')
  if (!url) throw new Error('--app-url is required')
  let origin: URL
  try { origin = new URL(url) } catch { throw new Error(`--app-url is not a URL: ${url}`) }
  if (origin.protocol !== 'https:') throw new Error('--app-url must be an https origin')
  const mode = flags.get('--auth') ?? 'password'
  if (mode !== 'password' && mode !== 'sso') throw new Error('--auth is password or sso')
  const computer = flags.get('--computer') ?? 'digest'
  if (computer !== 'digest' && computer !== 'file') throw new Error('--computer is digest or file')
  const turnMs = Number(flags.get('--turn-ms') ?? 300_000)
  if (!Number.isFinite(turnMs) || turnMs < 1_000) throw new Error('--turn-ms is a number of milliseconds, at least 1000')
  const email = flags.get('--email') ?? env.CONFORMANCE_EMAIL?.trim()
  const password = flags.get('--password') ?? env.CONFORMANCE_PASSWORD
  const operatorKey = env.CONFORMANCE_OPERATOR_KEY?.trim()
  return {
    app: flags.get('--app') ?? origin.hostname.split('.')[0]!,
    origin: origin.origin,
    ...(email && password ? { member: { mode: mode as SignInMode, email, password } } : {}),
    ...(operatorKey ? { operatorKey } : {}),
    ...(flags.has('--workspace') ? { workspace: flags.get('--workspace')! } : {}),
    computer: computer as ComputerProof,
    ...(flags.has('--file-dir') ? { fileDir: flags.get('--file-dir')! } : {}),
    turnMs,
    ...(flags.has('--expect-revision') ? { expectRevision: flags.get('--expect-revision')! } : {}),
  }
}

async function main(): Promise<number> {
  let options: ConformanceOptions
  try {
    options = parseConformanceArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`agent-app-conformance: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const results = await checkDeployedApp({ ...options, onResult: result => process.stdout.write(`${JSON.stringify(result)}\n`) })
  return results.every(result => result.status === 'pass') ? 0 : 1
}

if (invokedAsScript(import.meta.url, process.argv[1])) {
  main().then(code => process.stdout.write('', () => process.exit(code)))
}
