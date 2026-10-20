/**
 * The toolbelt parity gate — one manifest, every target, enforced at build time.
 *
 * A product with an embedded tool program (a stdio MCP the sandbox spawns)
 * has two representations of its tool surface: the manifest it authors and
 * the program that actually answers `tools/list`. Every hour of pain in the
 * fleet's toolbelt history was those two lists disagreeing — a verb present
 * in one target and absent from the other shipped green and failed in
 * production (hardware-agent #10155 class). This module turns that drift
 * class into a red test: spawn the program, read its real surface, diff it
 * against the manifest, and name every disagreement.
 *
 * Substrate-free by design: Node builtins only, no test-framework
 * dependency, no MCP SDK. `probeStdioToolProgram` speaks just enough
 * JSON-RPC (initialize → initialized → tools/list, replies matched by id,
 * notifications ignored) for a zero-dependency embedded program; the diff
 * and the assert are pure functions any runner (vitest, node:test, a tsx
 * script) can call.
 *
 * Canonical consumer shape:
 *
 * ```ts
 * import { assertToolbeltParity, probeStdioToolProgram } from '@tangle-network/agent-app/toolbelt'
 *
 * const probed = await probeStdioToolProgram({ program: programPath, env })
 * assertToolbeltParity(TOOLBELT, probed.tools) // throws with the named diff
 * ```
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** One authored tool in the product's manifest — the ONE source of truth the
 *  generated program and every derived surface (allowlists, prompt tool
 *  tables, dashboards) must agree with. */
export interface ToolbeltManifestTool {
  readonly name: string
  /** AAA-standard description (what / example / when NOT). Parity requires the
   *  program to serve it byte-identical — truncation at a bundle boundary is
   *  drift, not formatting. */
  readonly description: string
  /** JSON Schema for the tool's input. Compared structurally (key order
   *  insensitive) when either side declares one. */
  readonly inputSchema?: unknown
  /** MCP tool annotations (readOnlyHint, …). Compared structurally when the
   *  manifest declares them. */
  readonly annotations?: unknown
  /** Product-defined transport tag (`pure` | `http` | …). Not part of the
   *  wire surface; carried so derived surfaces can key off the manifest. */
  readonly transport?: string
}

/** A tool as the spawned program actually listed it. */
export interface ProbedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
  readonly annotations?: unknown
}

/** What `probeStdioToolProgram` saw. `serverInfo`/`raw` are included so a
 *  failed probe can name the layer (the diagnosability rule: never swallow). */
export interface ToolProgramProbe {
  readonly tools: readonly ProbedTool[]
  readonly initializeReply: Record<string, unknown> | null
}

export interface ProbeStdioToolProgramOptions {
  /** Path to the program to spawn. Spawned with the current Node executable. */
  readonly program: string
  /** Extra argv after the program path. */
  readonly args?: readonly string[]
  /** Environment for the child. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Working directory for the child. */
  readonly cwd?: string
  /** Wall-clock ceiling for the whole probe. Default 15s. */
  readonly timeoutMs?: number
}

/** Spawn the embedded tool program and read its REAL tool surface. */
export function probeStdioToolProgram(options: ProbeStdioToolProgramOptions): Promise<ToolProgramProbe> {
  const timeoutMs = options.timeoutMs ?? 15_000
  return new Promise<ToolProgramProbe>((resolve, reject) => {
    const child = spawn(process.execPath, [options.program, ...(options.args ?? [])], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Diagnostics only: the last 2 KB each side ever emitted, so a failed
    // probe names the layer instead of an unprocessed tail.
    const recent = (text: string) => text.slice(-2000).trim() || '(empty)'
    let stderr = ''
    let stdoutSeen = ''
    let settled = false
    let initializeReply: Record<string, unknown> | null = null

    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.close()
      try { child.kill() } catch { /* already gone */ }
      run()
    }

    const timer = setTimeout(
      () => finish(() => reject(new Error(
        `tool program probe timed out after ${timeoutMs}ms waiting for tools/list. ` +
        `stderr so far: ${recent(stderr)}; stdout so far: ${recent(stdoutSeen)}`,
      ))),
      timeoutMs,
    )

    // Line-delimited JSON-RPC over stdio: readline owns the buffering (no
    // manual byte scanning), and every line seen is also diagnostics.
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      stdoutSeen = (stdoutSeen + trimmed + '\n').slice(-2000)
      let message: Record<string, unknown>
      try {
        message = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        return // a banner line, not JSON-RPC
      }
      if (message.method !== undefined) return // notification from server
      if (message.id === 1) initializeReply = message.result as Record<string, unknown> ?? null
      if (message.id === 2 && message.result !== undefined && message.error === undefined) {
        const rawTools = (message.result as { tools?: unknown }).tools
        const tools: ProbedTool[] = Array.isArray(rawTools)
          ? rawTools.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string')
            .map((t) => {
              const tool = t as unknown as { name: string; description?: string; inputSchema?: unknown; annotations?: unknown }
              return {
                name: tool.name,
                ...(tool.description !== undefined ? { description: tool.description } : {}),
                ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
                ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
              }
            })
          : []
        finish(() => resolve({ tools, initializeReply }))
      } else if (message.id === 2 && message.error !== undefined) {
        finish(() => reject(new Error(
          `tool program refused tools/list: ${JSON.stringify(message.error)}`,
        )))
      }
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', (error) => finish(() => reject(new Error(
      `tool program probe failed to spawn ${options.program}: ${error.message}`,
    ))))
    child.on('exit', (code, signal) => finish(() => reject(new Error(
      `tool program exited before answering tools/list (code ${code}${signal ? `, signal ${signal}` : ''}). ` +
      `stderr: ${recent(stderr)}`,
    ))))

    // Minimal MCP handshake: initialize → initialized → tools/list. Replies
    // are matched by id; a program that never replies to initialize still
    // resolves the probe when its tools/list reply arrives.
    const send = (payload: unknown) => { try { child.stdin.write(JSON.stringify(payload) + '\n') } catch { /* closed; exit handler reports */ } }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'toolbelt-parity', version: '0.0.0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  })
}

/** Structural equality with sorted keys — two JSON schemas are the same
 *  contract regardless of key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** Field-level drift between the manifest and the program's real surface. */
export interface ToolbeltFieldDrift {
  readonly name: string
  readonly manifest: unknown
  readonly program: unknown
}

/** The named diff. Every array is sorted; empty arrays mean agreement. */
export interface ToolbeltParityDiff {
  readonly ok: boolean
  /** Manifest tools the program did not list (the #10155 class: the verb
   *  exists in the manifest, absent from the running surface). */
  readonly missingFromProgram: readonly string[]
  /** Tools the program listed that no manifest entry owns. */
  readonly unknownToManifest: readonly string[]
  /** Tools whose served description is not byte-identical to the manifest. */
  readonly descriptionDrift: readonly ToolbeltFieldDrift[]
  /** Tools whose served input schema differs structurally from the manifest. */
  readonly schemaDrift: readonly ToolbeltFieldDrift[]
  /** Tools whose served annotations differ structurally from the manifest. */
  readonly annotationDrift: readonly ToolbeltFieldDrift[]
}

/** Diff a spawned program's real surface against the authored manifest. */
export function toolbeltParityDiff(
  manifest: readonly ToolbeltManifestTool[],
  listed: readonly ProbedTool[],
): ToolbeltParityDiff {
  const byName = new Map(manifest.map((tool) => [tool.name, tool]))
  const listedByName = new Map(listed.map((tool) => [tool.name, tool]))
  const missingFromProgram = manifest
    .filter((tool) => !listedByName.has(tool.name))
    .map((tool) => tool.name)
    .sort()
  const unknownToManifest = listed
    .filter((tool) => !byName.has(tool.name))
    .map((tool) => tool.name)
    .sort()
  const descriptionDrift: ToolbeltFieldDrift[] = []
  const schemaDrift: ToolbeltFieldDrift[] = []
  const annotationDrift: ToolbeltFieldDrift[] = []
  for (const tool of manifest) {
    const served = listedByName.get(tool.name)
    if (!served) continue
    if (served.description !== tool.description) {
      descriptionDrift.push({ name: tool.name, manifest: tool.description, program: served.description ?? null })
    }
    const manifestSchema = tool.inputSchema
    if (manifestSchema !== undefined || served.inputSchema !== undefined) {
      if (stableStringify(manifestSchema) !== stableStringify(served.inputSchema)) {
        schemaDrift.push({ name: tool.name, manifest: manifestSchema ?? null, program: served.inputSchema ?? null })
      }
    }
    const manifestAnnotations = tool.annotations
    if (manifestAnnotations !== undefined || served.annotations !== undefined) {
      if (stableStringify(manifestAnnotations) !== stableStringify(served.annotations)) {
        annotationDrift.push({ name: tool.name, manifest: manifestAnnotations ?? null, program: served.annotations ?? null })
      }
    }
  }
  const ok = missingFromProgram.length === 0
    && unknownToManifest.length === 0
    && descriptionDrift.length === 0
    && schemaDrift.length === 0
    && annotationDrift.length === 0
  return {
    ok,
    missingFromProgram,
    unknownToManifest,
    descriptionDrift,
    schemaDrift,
    annotationDrift,
  }
}

/** Render a diff as one actionable report — every drift named, never a bare count. */
export function formatToolbeltParityDiff(diff: ToolbeltParityDiff): string {
  if (diff.ok) return 'toolbelt parity: the program is the manifest'
  const lines = ['toolbelt parity FAILED — the program and the manifest disagree:']
  if (diff.missingFromProgram.length > 0) {
    lines.push(`  missing from the program (in the manifest, NOT served): ${diff.missingFromProgram.join(', ')}`)
  }
  if (diff.unknownToManifest.length > 0) {
    lines.push(`  unknown to the manifest (served, NOT authored): ${diff.unknownToManifest.join(', ')}`)
  }
  for (const drift of diff.descriptionDrift) {
    lines.push(`  description drift on "${drift.name}":`)
    lines.push(`    manifest: ${JSON.stringify(drift.manifest)}`)
    lines.push(`    program:  ${JSON.stringify(drift.program)}`)
  }
  for (const drift of diff.schemaDrift) {
    lines.push(`  input-schema drift on "${drift.name}":`)
    lines.push(`    manifest: ${stableStringify(drift.manifest)}`)
    lines.push(`    program:  ${stableStringify(drift.program)}`)
  }
  for (const drift of diff.annotationDrift) {
    lines.push(`  annotation drift on "${drift.name}":`)
    lines.push(`    manifest: ${stableStringify(drift.manifest)}`)
    lines.push(`    program:  ${stableStringify(drift.program)}`)
  }
  lines.push('  Fix the ONE manifest (or the generator that derives the program from it) — never patch a second list.')
  return lines.join('\n')
}

/** Thrown by {@link assertToolbeltParity} with the full formatted diff. */
export class ToolbeltParityError extends Error {
  readonly diff: ToolbeltParityDiff
  constructor(diff: ToolbeltParityDiff) {
    super(formatToolbeltParityDiff(diff))
    this.name = 'ToolbeltParityError'
    this.diff = diff
  }
}

/** Assert parity: same names, byte-identical descriptions, structurally equal
 *  schemas and annotations. Throws {@link ToolbeltParityError} with every
 *  disagreement named — a red build, not a production silence. */
export function assertToolbeltParity(
  manifest: readonly ToolbeltManifestTool[],
  listed: readonly ProbedTool[],
): void {
  const diff = toolbeltParityDiff(manifest, listed)
  if (!diff.ok) throw new ToolbeltParityError(diff)
}
