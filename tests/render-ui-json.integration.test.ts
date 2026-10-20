import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createExpiringCapabilityToken,
  handleAppToolRequest,
  verifyExpiringCapabilityToken,
  type AppToolHandlers,
} from '../src/tools/index'

/** A real authenticated HTTP/MCP endpoint with filesystem-backed artifacts. */
describe('render_ui JSON transport and artifact persistence', () => {
  let directory: string
  let server: Server
  let origin: string
  let token: string
  const secret = 'integration-only-render-ui-capability'
  const workspaceId = 'render-workspace'

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'render-ui-json-'))
    token = (await createExpiringCapabilityToken(workspaceId, { secret, expiresInMs: 60_000 }))!
    const unavailable = async (): Promise<never> => { throw new Error('This artifact endpoint serves render_ui only') }
    const handlers: AppToolHandlers = {
      submitProposal: unavailable,
      scheduleFollowup: unavailable,
      addCitation: unavailable,
      async renderUi(args, ctx) {
        if (ctx.workspaceId !== workspaceId || ctx.userId !== workspaceId) throw new Error('Wrong authenticated owner')
        if (!/^[a-z-]+$/.test(args.title)) throw new Error('Invalid artifact filename')
        const path = args.title + '.json'
        const content = JSON.stringify(args.schema)
        await writeFile(join(directory, path), content, { flag: 'wx' })
        return { path, content }
      },
    }
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const response = await handleAppToolRequest(new Request('http://localhost/render-ui', {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        }), {
          tool: 'render_ui',
          taxonomy: { proposalTypes: [], regulatedTypes: [] },
          handlers,
          headerNames: { userId: 'X-Workspace-Id', workspaceId: 'X-Workspace-Id', threadId: 'X-Thread-Id' },
          verifyToken: (owner, bearer) => verifyExpiringCapabilityToken(owner, bearer, { secret }),
        })
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) {
        outgoing.writeHead(500)
        outgoing.end(String(error))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No HTTP listener')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  })

  async function post(body: unknown, authorized = true) {
    return fetch(origin, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (authorized ? token : 'invalid'), 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
      body: JSON.stringify(body),
    })
  }

  it('persists identical validated objects from direct HTTP and MCP single-encoded JSON', async () => {
    const node = { type: 'stack', children: [{ type: 'heading', level: 2, text: 'Ready' }] }
    const direct = await post({ title: 'direct-object', schema: node })
    expect(direct.status).toBe(200)
    const mcp = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'render_ui', arguments: { title: 'mcp-text', schema: JSON.stringify(node) },
    } })
    expect(mcp.status).toBe(200)
    expect((await mcp.json()).result.isError).toBeUndefined()
    const directContent = await readFile(join(directory, 'direct-object.json'), 'utf8')
    const mcpContent = await readFile(join(directory, 'mcp-text.json'), 'utf8')
    expect(mcpContent).toBe(directContent)
    expect(JSON.parse(mcpContent)).toEqual(node)
  })

  it('refuses malformed, double-encoded and unsupported nodes before writing an artifact', async () => {
    const before = await readdir(directory)
    const inputs = [
      '{"type":"heading",',
      JSON.stringify(JSON.stringify({ type: 'heading', text: 'Ready' })),
      JSON.stringify({ type: 'stack', title: 'Unknown field', children: [] }),
      JSON.stringify([{ type: 'heading', text: 'Array' }]),
      JSON.stringify({ type: 'script', content: 'Unsupported' }),
    ]
    for (const schema of inputs) {
      const direct = await post({ title: 'refused', schema })
      expect(direct.status).toBe(400)
      expect((await direct.json()).error).toBe('invalid_schema')
      const mcp = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'render_ui', arguments: { title: 'refused', schema },
      } })
      expect((await mcp.json()).result).toMatchObject({ isError: true })
    }
    expect(await readdir(directory)).toEqual(before)
    expect((await post({ title: 'unauthorized', schema: { type: 'heading', text: 'Ready' } }, false)).status).toBe(401)
    expect(await readdir(directory)).toEqual(before)
  })
})
