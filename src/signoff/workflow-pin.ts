import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read the Node pin out of the workflows that gate a merge.
 *
 * This exists because of a measured false PASS. legal-agent `4c0d688` was red
 * in CI on two test files — `Cannot bundle Node.js built-in "node:sqlite"` —
 * and the sign-off gate signed it off. Same bytes, same lockfile, same
 * hermetic tree: on Node 22 both files fail, on Node 24 both pass, 100% of the
 * time. The runtime was the whole difference, and the gate never saw it because
 * it looked for a pin in exactly two places the fleet does not keep one.
 *
 * At measurement time, none of tax-agent, legal-agent, or agent-app had an
 * `.nvmrc`.
 * All three pinned Node 22 in the merge workflow.
 * Agent App now pins Node 24.18.0 in `.nvmrc`.
 *
 * The workflow fallback reads only `pull_request` checks because those checks
 * can block a merge.
 * Agent App uses `.nvmrc` instead of this fallback.
 * Its publish workflow uses Node 24.18.0 for source checks and npm, with a
 * separate clean-runner Node 22 compatibility job.
 *
 * Nothing here guesses. An expression (`${{ matrix.node }}`) is not a version,
 * a `node-version-file` that does not exist is not a pin, and two merge-gate
 * workflows on different majors is a question this module cannot answer.
 * Each one refuses and names the config key that settles it.
 */

export interface WorkflowNodePin {
  /** Repo-relative workflow path, for the proof. */
  readonly file: string
  /** The version as written: `22`, `24.18.0`, `v20`. */
  readonly value: string
  /** `node-version`, or the `node-version-file` path it was read through. */
  readonly via: string
}

const WORKFLOW_DIR = join('.github', 'workflows')

/** Everything after an unquoted ` #`, plus surrounding quotes, is not the value. */
function scalarValue(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim()
  const quoted = /^(['"])(.*)\1$/.exec(withoutComment)
  return (quoted?.[2] ?? withoutComment).trim()
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isBlank(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

/**
 * Does this workflow run on `pull_request`?
 *
 * Both spellings the fleet uses are handled: the block form every workflow here
 * writes, and the inline form (`on: [push, pull_request]`). `on` is quoted in
 * some repos because YAML 1.1 reads a bare `on` as the boolean true, so the
 * quoted keys are matched too.
 */
export function triggersOnPullRequest(source: string): boolean {
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const header = /^(?:on|"on"|'on')\s*:(.*)$/.exec(line)
    if (!header) continue

    const inline = scalarValue(header[1] ?? '')
    if (inline.length > 0) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((token) => token.trim())
        .includes('pull_request')
    }

    // Block form: the trigger names sit at the first nesting level under `on:`.
    // Anything deeper belongs to a trigger's own options (`branches`, `paths`).
    let nesting: number | null = null
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const body = lines[cursor] as string
      if (isBlank(body)) continue
      const bodyIndent = indentOf(body)
      if (bodyIndent === 0) break
      if (nesting === null) nesting = bodyIndent
      if (bodyIndent !== nesting) continue
      const key = /^\s*(?:-\s*)?([A-Za-z_][\w-]*)\s*:?\s*$/.exec(body)
      if (key?.[1] === 'pull_request') return true
    }
    return false
  }
  return false
}

/** Every Node pin an `actions/setup-node` step declares in one workflow. */
function pinsInWorkflow(repoRoot: string, file: string, source: string): WorkflowNodePin[] {
  const pins: WorkflowNodePin[] = []
  for (const line of source.split('\n')) {
    const match = /^\s*(node-version|node-version-file)\s*:\s*(\S.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as string
    const value = scalarValue(match[2] as string)
    // A matrix expression is several runtimes, not one. Refusing to guess is
    // the point; `resolveWorkflowNodePin` turns an all-expression repo into a
    // named refusal rather than a silent "unpinned".
    if (value.includes('${{')) continue

    if (key === 'node-version') {
      pins.push({ file, value, via: 'node-version' })
      continue
    }

    const target = join(repoRoot, value)
    if (!existsSync(target)) {
      throw new Error(
        `signoff: ${file} reads its Node pin from "${value}" (node-version-file) and that file does not exist. ` +
          'The workflow this gate replaces cannot itself run, so there is nothing to verify against.',
      )
    }
    const declared = readFileSync(target, 'utf8')
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !entry.startsWith('#'))
    if (declared !== undefined) pins.push({ file, value: declared, via: `node-version-file ${value}` })
  }
  return pins
}

/** Node pins declared by every workflow that gates a merge, in filename order. */
export function scanMergeGateNodePins(repoRoot: string): WorkflowNodePin[] {
  const dir = join(repoRoot, WORKFLOW_DIR)
  if (!existsSync(dir)) return []

  const pins: WorkflowNodePin[] = []
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8')
    if (!triggersOnPullRequest(source)) continue
    pins.push(...pinsInWorkflow(repoRoot, `${WORKFLOW_DIR}/${name}`, source))
  }
  return pins
}

export interface ResolvedWorkflowPin {
  readonly major: number
  readonly declared: string
  readonly source: string
}

/**
 * One Node major for the whole merge gate, or a refusal that names why not.
 *
 * `majorOf` is injected rather than imported to keep the direction of the
 * dependency one-way: `node-version.ts` owns what a version string means, this
 * module owns where the string lives.
 */
export function resolveWorkflowNodePin(
  repoRoot: string,
  majorOf: (raw: string) => number | null,
): ResolvedWorkflowPin | null {
  const pins = scanMergeGateNodePins(repoRoot)
  if (pins.length === 0) return null

  const byMajor = new Map<number, WorkflowNodePin[]>()
  for (const pin of pins) {
    const major = majorOf(pin.value)
    // An alias (`lts/*`) is a pin this module cannot resolve without a network
    // call — the same treatment `.nvmrc` gives one.
    if (major === null) continue
    const bucket = byMajor.get(major)
    if (bucket) bucket.push(pin)
    else byMajor.set(major, [pin])
  }

  if (byMajor.size === 0) return null
  if (byMajor.size > 1) {
    const detail = [...byMajor.values()]
      .flat()
      .map((pin) => `  ${pin.file} (${pin.via}): ${pin.value}`)
      .join('\n')
    throw new Error(
      'signoff: the workflows that gate a merge here pin different Node majors, so there is no single ' +
        `runtime to verify:\n${detail}\n` +
        'Declare `nodeVersion` in the signoff config to say which one a sign-off means.',
    )
  }

  const [entry] = [...byMajor.entries()]
  if (entry === undefined) return null
  const [major, matched] = entry
  const first = matched[0] as WorkflowNodePin
  const files = [...new Set(matched.map((pin: WorkflowNodePin) => pin.file))].join(', ')
  return { major, declared: first.value, source: `${files} (${first.via})` }
}
