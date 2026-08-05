#!/usr/bin/env node
/**
 * `agent-app-verify-proof` — the command a reader runs to decide whether a
 * commit was signed off, by what, and whether it passed.
 *
 *     agent-app-verify-proof <sha|rev>            # look the proof up by commit
 *     agent-app-verify-proof --file proof.json    # check a proof document
 *
 * Exits 0 only when every check passes. Exits 1 on any failure, and on a commit
 * with no proof at all — "nobody signed this off" is a rejection, not a pass.
 */
import { formatSignoffSummary, readSignoffKey } from './proof-record'
import { formatSignoffVerification, verifySignoffAtRev, verifySignoffProofFile, type SignoffVerification } from './proof-verify'

interface CliOptions {
  readonly rev: string
  readonly file: string | null
  readonly dir: string
  readonly keyPath: string | null
  readonly repo: string | null
  readonly json: boolean
}

function parseArgs(argv: readonly string[]): CliOptions {
  let rev = 'HEAD'
  let file: string | null = null
  let dir = process.cwd()
  let keyPath: string | null = null
  let repo: string | null = null
  let json = false
  let sawRev = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    if (arg === '--file') file = next()
    else if (arg === '--dir') dir = next()
    else if (arg === '--key') keyPath = next()
    else if (arg === '--repo') repo = next()
    else if (arg === '--json') json = true
    else if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`)
    else {
      if (sawRev) throw new Error(`unexpected second revision ${arg}`)
      rev = arg
      sawRev = true
    }
  }
  return { rev, file, dir, keyPath, repo, json }
}

function report(result: SignoffVerification, options: CliOptions): number {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          commitBinding: result.commitBinding,
          macChecked: result.macChecked,
          failures: result.failures,
          requiredSteps: result.requiredSteps,
          summary: formatSignoffSummary(result.proof),
          proof: result.proof,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(`${formatSignoffVerification(result)}\n${formatSignoffSummary(result.proof)}\n`)
  }
  return result.ok ? 0 : 1
}

function main(): number {
  const options = parseArgs(process.argv.slice(2))
  const key = options.keyPath === null ? undefined : readSignoffKey(options.keyPath)

  if (options.file !== null) {
    return report(verifySignoffProofFile({ repoDir: options.dir, file: options.file, rev: options.rev, key, expectRepo: options.repo ?? undefined }), options)
  }

  const outcome = verifySignoffAtRev({ repoDir: options.dir, rev: options.rev, key, expectRepo: options.repo ?? undefined })
  if (!outcome.found) {
    process.stdout.write(
      `NO PROOF ${outcome.commit}\n  nothing is attached under refs/notes/signoff, and no proof covers this commit's tree\n  if notes exist upstream, this repo may not fetch them:\n${outcome.hint.map((line) => `    ${line}`).join('\n')}\n`,
    )
    return 1
  }
  return report(outcome, options)
}

try {
  process.exit(main())
} catch (error) {
  process.stderr.write(`agent-app-verify-proof failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
