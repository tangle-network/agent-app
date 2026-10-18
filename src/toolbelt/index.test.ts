import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertToolbeltParity,
  formatToolbeltParityDiff,
  probeStdioToolProgram,
  toolbeltParityDiff,
  type ProbedTool,
  type ToolbeltManifestTool,
} from './index'

/**
 * A fixture embedded-MCP program: full handshake, tools/list from a literal
 * table — the same shape the platform's consumers bundle (zero-dependency,
 * line-delimited JSON-RPC on stdio).
 */
const PARITY_PROGRAM = `
const readline = require("node:readline");
const TOOLS = ${JSON.stringify([
  {
    name: 'get_state',
    description: 'Read state. Example: call once. When NOT to use: twice.',
    inputSchema: { type: 'object', properties: { deep: { type: 'object', properties: { a: { type: 'number' }, z: { type: 'string' } } } }, required: ['deep'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'submit',
    description: 'Finish the turn. Example: {final:"ans"}. When NOT to use: mid-work.',
    inputSchema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
])};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.0.0" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } }) + "\\n");
  }
});
`

const MANIFEST: readonly ToolbeltManifestTool[] = [
  {
    name: 'get_state',
    description: 'Read state. Example: call once. When NOT to use: twice.',
    inputSchema: { type: 'object', properties: { deep: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } } }, required: ['deep'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    transport: 'pure',
  },
  {
    name: 'submit',
    description: 'Finish the turn. Example: {final:"ans"}. When NOT to use: mid-work.',
    inputSchema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    transport: 'pure',
  },
]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolbelt-parity-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('probeStdioToolProgram', () => {
  it('reads the real surface through a full MCP handshake', async () => {
    const program = join(dir, 'fixture.cjs')
    writeFileSync(program, PARITY_PROGRAM)
    const probe = await probeStdioToolProgram({ program })
    expect(probe.tools.map((t) => t.name).sort()).toEqual(['get_state', 'submit'])
    expect(probe.initializeReply).toMatchObject({ serverInfo: { name: 'fixture' } })
  })

  it('resolves even when the program skips the initialize reply', async () => {
    const program = join(dir, 'minimal.cjs')
    writeFileSync(program, `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "only" }] } }) + "\\n");
        }
      });
    `)
    const probe = await probeStdioToolProgram({ program })
    expect(probe.tools).toEqual([{ name: 'only' }])
    expect(probe.initializeReply).toBeNull()
  })

  it('names stderr and exit code when the program dies before answering', async () => {
    const program = join(dir, 'dies.cjs')
    writeFileSync(program, 'console.error("boom: missing PHYSIM_THING"); process.exit(3);')
    await expect(probeStdioToolProgram({ program })).rejects.toThrow(/exited before answering tools\/list.*boom: missing PHYSIM_THING/s)
  })

  it('times out with the collected output named (stdout diagnostics include lines already processed)', async () => {
    const program = join(dir, 'hangs.cjs')
    writeFileSync(program, [`
      const readline = require("node:readline");
      // A banner, then a reply to initialize but never to tools/list: the
      // probe must name BOTH streams in the timeout, including stdout lines
      // it already consumed while line-splitting.
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "stalls" } } }) + "\\n");
      console.error("waiting forever");
      setInterval(() => {}, 1000);
    `].join("\n"))
    await expect(probeStdioToolProgram({ program, timeoutMs: 750 })).rejects.toThrow(
      /timed out after 750ms.*stderr so far: waiting forever.*stdout so far: .*stalls/s,
    )
  })
})

describe('toolbeltParityDiff', () => {
  it('passes when the program is the manifest (key order insensitive)', () => {
    const listed: readonly ProbedTool[] = [
      {
        name: 'submit',
        description: 'Finish the turn. Example: {final:"ans"}. When NOT to use: mid-work.',
        inputSchema: { required: ['final'], type: 'object', properties: { final: { type: 'string' } } },
        annotations: { idempotentHint: false, openWorldHint: false, destructiveHint: false, readOnlyHint: false },
      },
      {
        name: 'get_state',
        description: 'Read state. Example: call once. When NOT to use: twice.',
        inputSchema: { type: 'object', properties: { deep: { type: 'object', properties: { a: { type: 'number' }, z: { type: 'string' } } } }, required: ['deep'] },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ]
    expect(toolbeltParityDiff(MANIFEST, listed).ok).toBe(true)
    expect(assertToolbeltParity(MANIFEST, listed)).toBeUndefined()
  })

  it('names a manifest tool the program no longer serves (#10155 class)', () => {
    const listed = MANIFEST.map((t) => ({ name: t.name, description: t.description })).filter((t) => t.name !== 'submit')
    const diff = toolbeltParityDiff(MANIFEST, listed)
    expect(diff.ok).toBe(false)
    expect(diff.missingFromProgram).toEqual(['submit'])
    expect(formatToolbeltParityDiff(diff)).toMatch(/missing from the program.*submit/)
  })

  it('names a served tool no manifest entry owns', () => {
    const listed = [
      ...MANIFEST.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      { name: 'mystery' },
    ]
    const diff = toolbeltParityDiff(MANIFEST, listed)
    expect(diff.unknownToManifest).toEqual(['mystery'])
    expect(formatToolbeltParityDiff(diff)).toMatch(/unknown to the manifest.*mystery/)
  })

  it('names byte-level description drift (bundle truncation)', () => {
    const listed = MANIFEST.map((t) => ({
      name: t.name,
      description: t.name === 'get_state' ? 'Read state. Example: call once.' : t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }))
    const diff = toolbeltParityDiff(MANIFEST, listed)
    expect(diff.descriptionDrift.map((d) => d.name)).toEqual(['get_state'])
    expect(formatToolbeltParityDiff(diff)).toMatch(/description drift on "get_state"/)
  })

  it('names structural schema and annotation drift', () => {
    const listed = MANIFEST.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.name === 'submit'
        ? { type: 'object', properties: { final: { type: 'number' } }, required: ['final'] }
        : t.inputSchema,
      annotations: t.name === 'submit' ? { readOnlyHint: true } : t.annotations,
    }))
    const diff = toolbeltParityDiff(MANIFEST, listed)
    expect(diff.schemaDrift.map((d) => d.name)).toEqual(['submit'])
    expect(diff.annotationDrift.map((d) => d.name)).toEqual(['submit'])
  })

  it('assert throws a ToolbeltParityError carrying the diff', () => {
    expect(() => assertToolbeltParity(MANIFEST, [{ name: 'mystery' }])).toThrowError(/missing from the program.*unknown to the manifest/s)
  })
})
