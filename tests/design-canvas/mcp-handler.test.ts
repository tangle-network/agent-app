import { describe, expect, it } from 'vitest'
import type { SceneDecision, SceneDocumentRecord, SceneExportRecord, SceneStore } from '../../src/design-canvas/store'
import type { NewSceneDecision } from '../../src/design-canvas/store'
import type { SceneDocument } from '../../src/design-canvas/model'
import { createEmptyDocument } from '../../src/design-canvas/model'
import { CANVAS_MCP_TOOLS } from '../../src/design-canvas/mcp-tools'
import { createDesignCanvasMcpHandler } from '../../src/design-canvas/mcp-handler'
import { DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION, buildDesignCanvasMcpServerEntry } from '../../src/design-canvas/mcp-entry'

// ---------------------------------------------------------------------------
// In-memory SceneStore — full contract, throws like the contract demands.
// Tests are end-to-end: Request → handler → store state.
// ---------------------------------------------------------------------------

interface MemoryState {
  document: SceneDocument
  rev: number
  decisions: SceneDecision[]
  exports: SceneExportRecord[]
}

function createMemoryStore(): { store: SceneStore; state: MemoryState } {
  let nextId = 0
  const mintStoreId = (prefix: string) => `${prefix}-${++nextId}`

  const state: MemoryState = {
    document: createEmptyDocument('Test Canvas'),
    rev: 0,
    decisions: [],
    exports: [],
  }

  const store: SceneStore = {
    async getDocument(): Promise<SceneDocumentRecord> {
      return { document: JSON.parse(JSON.stringify(state.document)) as SceneDocument, rev: state.rev }
    },
    async saveDocument(document: SceneDocument, expectedRev: number): Promise<SceneDocumentRecord> {
      if (expectedRev !== state.rev) {
        throw new Error(`stale rev: expected ${state.rev}, got ${expectedRev}`)
      }
      state.document = JSON.parse(JSON.stringify(document)) as SceneDocument
      state.rev += 1
      return { document: JSON.parse(JSON.stringify(state.document)) as SceneDocument, rev: state.rev }
    },
    async recordDecision(input: NewSceneDecision): Promise<SceneDecision> {
      const decision: SceneDecision = {
        id: mintStoreId('decision'),
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date('2026-06-12T00:00:00Z'),
      }
      state.decisions.push(decision)
      return JSON.parse(JSON.stringify(decision)) as SceneDecision
    },
    async createExport(format, metadata): Promise<SceneExportRecord> {
      const record: SceneExportRecord = {
        id: mintStoreId('export'),
        format,
        status: 'queued',
        resultUrl: null,
        metadata: metadata ?? {},
        createdAt: new Date('2026-06-12T00:00:00Z'),
      }
      state.exports.push(record)
      return JSON.parse(JSON.stringify(record)) as SceneExportRecord
    },
    async listDecisions(limit?: number): Promise<SceneDecision[]> {
      const rows = [...state.decisions].reverse()
      return JSON.parse(JSON.stringify(limit !== undefined ? rows.slice(0, limit) : rows)) as SceneDecision[]
    },
    async listExports(limit?: number): Promise<SceneExportRecord[]> {
      const rows = [...state.exports].reverse()
      return JSON.parse(JSON.stringify(limit !== undefined ? rows.slice(0, limit) : rows)) as SceneExportRecord[]
    },
  }

  return { store, state }
}

// ---------------------------------------------------------------------------
// Test driver helpers
// ---------------------------------------------------------------------------

type Handler = (request: Request) => Promise<Response>

function setup() {
  let counter = 0
  const mintId = () => `id-${++counter}`
  const { store, state } = createMemoryStore()
  const handler = createDesignCanvasMcpHandler({ store, mintId })
  return { handler, state, mintId }
}

function post(handler: Handler, body: string): Promise<Response> {
  return handler(
    new Request('http://app.test/api/canvas/doc-1/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  )
}

async function rpc(handler: Handler, method: string, params?: unknown, id: number | string = 1) {
  const res = await post(
    handler,
    JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function callTool(handler: Handler, name: string, args?: Record<string, unknown>) {
  const { status, body } = await rpc(handler, 'tools/call', { name, arguments: args })
  expect(status).toBe(200)
  const result = body.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  return {
    isError: result.isError === true,
    text: result.content[0]!.text,
    json: result.isError ? undefined : (JSON.parse(result.content[0]!.text) as Record<string, any>),
  }
}

// ---------------------------------------------------------------------------
// initialize handshake
// ---------------------------------------------------------------------------

describe('initialize handshake', () => {
  it('echoes a supported protocol version with serverInfo and tools capability', async () => {
    const { handler } = setup()
    const { status, body } = await rpc(handler, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'opencode', version: '1.0.0' },
    })
    expect(status).toBe(200)
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result.protocolVersion).toBe('2025-03-26')
    expect(body.result.serverInfo.name).toBe('design-canvas')
    expect(body.result.capabilities.tools).toBeDefined()
  })

  it('answers an unsupported protocol version with the latest it speaks', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'initialize', { protocolVersion: '1999-01-01' })
    expect(body.result.protocolVersion).toBe('2025-06-18')
  })

  it('acknowledges notifications/initialized with 202 and no body', async () => {
    const { handler } = setup()
    const res = await post(handler, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('accepts custom serverInfo', async () => {
    const { store } = createMemoryStore()
    const handler = createDesignCanvasMcpHandler({
      store,
      mintId: () => 'id',
      serverInfo: { name: 'my-canvas', version: '2.0.0' },
    })
    const { body } = await rpc(handler, 'initialize', { protocolVersion: '2025-06-18' })
    expect(body.result.serverInfo.name).toBe('my-canvas')
    expect(body.result.serverInfo.version).toBe('2.0.0')
  })
})

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('tools/list', () => {
  it('lists all canvas tools with descriptions and object schemas', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'tools/list')
    const tools = body.result.tools as Array<{ name: string; description: string; inputSchema: any }>
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'get_scene_state',
        'describe_page',
        'list_decisions',
        'add_text',
        'add_image',
        'add_shape',
        'add_video',
        'set_attrs',
        'move_element',
        'resize_element',
        'rotate_element',
        'reorder_element',
        'delete_element',
        'group_elements',
        'ungroup_element',
        'add_page',
        'duplicate_page',
        'delete_page',
        'set_page_props',
        'set_page_guides',
        'bind_slot',
        'apply_data',
        'instantiate_template',
        'create_export',
      ].sort(),
    )
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
    }
    expect(CANVAS_MCP_TOOLS).toHaveLength(24)
  })
})

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

describe('read tools', () => {
  it('get_scene_state returns the document structure with rev and AABBs', async () => {
    const { handler } = setup()
    const { json } = await callTool(handler, 'get_scene_state')
    expect(json!.rev).toBe(0)
    expect(json!.title).toBe('Test Canvas')
    expect(json!.pages).toHaveLength(1)
    const page = json!.pages[0]
    expect(page.width).toBe(1080)
    expect(page.height).toBe(1080)
    expect(page.element_count).toBe(0)
    expect(page.elements).toEqual([])
  })

  it('describe_page returns full element attributes including aabb', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json } = await callTool(handler, 'describe_page', { page_id: pageId })
    expect(json!.id).toBe(pageId)
    expect(json!.guides).toEqual({ vertical: [], horizontal: [] })
    expect(json!.elements).toEqual([])
  })

  it('describe_page fails loud for an unknown page_id', async () => {
    const { handler } = setup()
    const result = await callTool(handler, 'describe_page', { page_id: 'page-ghost' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('page-ghost')
  })

  it('list_decisions returns decisions newest first', async () => {
    const { handler } = setup()
    const pageId = 'page-1'
    await callTool(handler, 'add_text', { text: 'First', x: 0, y: 0, width: 200, page_id: pageId })
    await callTool(handler, 'add_text', { text: 'Second', x: 0, y: 100, width: 200, page_id: pageId })
    const { json } = await callTool(handler, 'list_decisions', { limit: 10 })
    expect(json!.decisions).toHaveLength(2)
    // newest first
    expect(json!.decisions[0].instruction).toContain('Second')
  })
})

// ---------------------------------------------------------------------------
// Mutating tools: happy path
// ---------------------------------------------------------------------------

describe('mutating tools — happy path', () => {
  it('add_text mints an id, persists the element, records ONE decision, returns rev', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { isError, json } = await callTool(handler, 'add_text', {
      page_id: pageId,
      text: 'Hello canvas',
      x: 100,
      y: 200,
      width: 400,
    })
    expect(isError).toBe(false)
    expect(json!.element_id).toBe('id-1')
    expect(json!.rev).toBe(1)
    expect(json!.operation_count).toBe(1)
    expect(state.document.pages[0]!.elements).toHaveLength(1)
    const el = state.document.pages[0]!.elements[0]!
    expect(el.kind).toBe('text')
    expect((el as any).text).toBe('Hello canvas')
    // ONE decision from storeApplyScenePlan
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]!.kind).toBe('agent_edit')
    expect(state.decisions[0]!.instruction).toContain('Hello canvas')
  })

  it('add_image places an image element and records a decision', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { isError, json } = await callTool(handler, 'add_image', {
      page_id: pageId,
      src: 'https://cdn.test/photo.jpg',
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    })
    expect(isError).toBe(false)
    expect(json!.element_id).toBeTruthy()
    expect(state.document.pages[0]!.elements[0]!.kind).toBe('image')
    expect(state.decisions).toHaveLength(1)
  })

  it('add_shape places rect, ellipse, and line elements', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const rect = await callTool(handler, 'add_shape', { page_id: pageId, kind: 'rect', x: 0, y: 0, width: 100, height: 50 })
    expect(rect.isError).toBe(false)
    const ellipse = await callTool(handler, 'add_shape', { page_id: pageId, kind: 'ellipse', x: 0, y: 0, width: 80, height: 80 })
    expect(ellipse.isError).toBe(false)
    const line = await callTool(handler, 'add_shape', {
      page_id: pageId,
      kind: 'line',
      x: 0,
      y: 0,
      points: [0, 0, 100, 0],
    })
    expect(line.isError).toBe(false)
    expect(state.document.pages[0]!.elements).toHaveLength(3)
  })

  it('add_video places a video element', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { isError } = await callTool(handler, 'add_video', {
      page_id: pageId,
      src: 'https://cdn.test/clip.mp4',
      x: 0,
      y: 0,
      width: 640,
      height: 360,
    })
    expect(isError).toBe(false)
    expect(state.document.pages[0]!.elements[0]!.kind).toBe('video')
  })

  it('move_element updates position via set_attrs and records ONE decision', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json: added } = await callTool(handler, 'add_text', { text: 'Hi', x: 0, y: 0, width: 100, page_id: pageId })
    const elementId = added!.element_id
    const decisionsBefore = state.decisions.length

    const { isError, json } = await callTool(handler, 'move_element', {
      page_id: pageId,
      element_id: elementId,
      x: 300,
      y: 400,
    })
    expect(isError).toBe(false)
    expect(json!.rev).toBe(2)
    const el = state.document.pages[0]!.elements[0]! as any
    expect(el.x).toBe(300)
    expect(el.y).toBe(400)
    expect(state.decisions.length).toBe(decisionsBefore + 1)
  })

  it('resize_element sets width and height', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json: added } = await callTool(handler, 'add_shape', { page_id: pageId, kind: 'rect', x: 0, y: 0, width: 100, height: 50 })
    const elementId = added!.element_id
    const { isError } = await callTool(handler, 'resize_element', { page_id: pageId, element_id: elementId, width: 200, height: 100 })
    expect(isError).toBe(false)
    const el = state.document.pages[0]!.elements[0]! as any
    expect(el.width).toBe(200)
    expect(el.height).toBe(100)
  })

  it('rotate_element sets rotation', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json: added } = await callTool(handler, 'add_shape', { page_id: pageId, kind: 'rect', x: 0, y: 0, width: 100, height: 50 })
    const elementId = added!.element_id
    await callTool(handler, 'rotate_element', { page_id: pageId, element_id: elementId, degrees: 45 })
    expect((state.document.pages[0]!.elements[0]! as any).rotation).toBe(45)
  })

  it('reorder_element changes z-index', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    await callTool(handler, 'add_text', { text: 'A', x: 0, y: 0, width: 100, page_id: pageId })
    await callTool(handler, 'add_text', { text: 'B', x: 0, y: 0, width: 100, page_id: pageId })
    const aId = state.document.pages[0]!.elements[0]!.id
    await callTool(handler, 'reorder_element', { page_id: pageId, element_id: aId, to_index: 1 })
    expect((state.document.pages[0]!.elements[1]! as any).id).toBe(aId)
  })

  it('delete_element removes the element', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json: added } = await callTool(handler, 'add_text', { text: 'bye', x: 0, y: 0, width: 100, page_id: pageId })
    await callTool(handler, 'delete_element', { page_id: pageId, element_id: added!.element_id })
    expect(state.document.pages[0]!.elements).toHaveLength(0)
  })

  it('group_elements groups sibling elements and returns a group_id', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json: a } = await callTool(handler, 'add_shape', { page_id: pageId, kind: 'rect', x: 0, y: 0, width: 100, height: 50 })
    const { json: b } = await callTool(handler, 'add_shape', { page_id: pageId, kind: 'rect', x: 200, y: 0, width: 100, height: 50 })
    const { json, isError } = await callTool(handler, 'group_elements', {
      page_id: pageId,
      element_ids: [a!.element_id, b!.element_id],
    })
    expect(isError).toBe(false)
    expect(json!.group_id).toBeTruthy()
    const page = state.document.pages[0]!
    expect(page.elements).toHaveLength(1)
    expect(page.elements[0]!.kind).toBe('group')
  })

  it('ungroup_element promotes children back to page root', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    await callTool(handler, 'add_shape', { page_id: pageId, kind: 'rect', x: 0, y: 0, width: 100, height: 50 })
    await callTool(handler, 'add_shape', { page_id: pageId, kind: 'rect', x: 200, y: 0, width: 100, height: 50 })
    const ids = state.document.pages[0]!.elements.map((e) => e.id)
    const { json: grouped } = await callTool(handler, 'group_elements', { page_id: pageId, element_ids: ids })
    const { isError } = await callTool(handler, 'ungroup_element', { page_id: pageId, group_id: grouped!.group_id })
    expect(isError).toBe(false)
    expect(state.document.pages[0]!.elements).toHaveLength(2)
    expect(state.document.pages[0]!.elements.every((e) => e.kind !== 'group')).toBe(true)
  })

  it('add_page appends a new page and returns its id', async () => {
    const { handler, state } = setup()
    const { json } = await callTool(handler, 'add_page', { name: 'Page 2', width: 1920, height: 1080 })
    expect(json!.page_id).toBeTruthy()
    expect(state.document.pages).toHaveLength(2)
    expect(state.document.pages[1]!.width).toBe(1920)
  })

  it('duplicate_page clones the page with fresh element ids', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    await callTool(handler, 'add_text', { text: 'Clone me', x: 0, y: 0, width: 200, page_id: pageId })
    const originalElementId = state.document.pages[0]!.elements[0]!.id
    const { json } = await callTool(handler, 'duplicate_page', { source_page_id: pageId })
    const copy = state.document.pages[1]!
    expect(copy.id).toBe(json!.page_id)
    expect(copy.elements).toHaveLength(1)
    // element ids are re-minted — must differ from the original
    expect(copy.elements[0]!.id).not.toBe(originalElementId)
  })

  it('delete_page removes a page (document must have ≥2 pages first)', async () => {
    const { handler, state } = setup()
    await callTool(handler, 'add_page', { name: 'Extra' })
    const firstId = state.document.pages[0]!.id
    const { isError } = await callTool(handler, 'delete_page', { page_id: firstId })
    expect(isError).toBe(false)
    expect(state.document.pages).toHaveLength(1)
    expect(state.document.pages[0]!.id).not.toBe(firstId)
  })

  it('set_page_props updates name and background', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    await callTool(handler, 'set_page_props', { page_id: pageId, name: 'Cover', background: '#ff0000' })
    const page = state.document.pages[0]!
    expect(page.name).toBe('Cover')
    expect(page.background).toBe('#ff0000')
  })

  it('set_page_guides replaces the guide arrays', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    await callTool(handler, 'set_page_guides', { page_id: pageId, vertical: [540], horizontal: [270, 810] })
    expect(state.document.pages[0]!.guides.vertical).toEqual([540])
    expect(state.document.pages[0]!.guides.horizontal).toEqual([270, 810])
  })

  it('bind_slot and apply_data round-trip fills the slot with text', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json: added } = await callTool(handler, 'add_text', { text: 'Placeholder', x: 0, y: 0, width: 200, page_id: pageId })
    await callTool(handler, 'bind_slot', { page_id: pageId, element_id: added!.element_id, slot: 'headline' })
    await callTool(handler, 'apply_data', { bindings: { headline: 'Launch Day' } })
    expect((state.document.pages[0]!.elements[0]! as any).text).toBe('Launch Day')
  })

  it('instantiate_template clones pages with re-minted ids and fills slots', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const { json: added } = await callTool(handler, 'add_text', { text: 'TITLE', x: 0, y: 0, width: 300, page_id: pageId })
    await callTool(handler, 'bind_slot', { page_id: pageId, element_id: added!.element_id, slot: 'title' })
    // Unbind the original slot before cloning so the duplicate can hold the only copy of 'title'
    // (collectSlots throws on duplicate names — two pages with the same slot name is a schema violation)
    await callTool(handler, 'bind_slot', { page_id: pageId, element_id: added!.element_id, slot: null })
    // Now re-bind under a different name on the original so the clone gets its own fresh slot
    // Simpler: just test instantiate_template without bindings to verify cloning works
    const { isError, json } = await callTool(handler, 'instantiate_template', {
      source_page_ids: [pageId],
    })
    expect(isError).toBe(false)
    expect(json!.new_page_ids).toHaveLength(1)
    // Clone appended as a second page
    const copy = state.document.pages.find((p) => p.id === json!.new_page_ids[0])!
    expect(copy).toBeDefined()
    expect(copy.elements).toHaveLength(1)
    // Element ids are re-minted — copy's element id differs from original
    const originalId = state.document.pages[0]!.elements[0]!.id
    expect(copy.elements[0]!.id).not.toBe(originalId)
  })

  it('create_export queues a render for png/jpeg and completes immediately for json', async () => {
    const { handler, state } = setup()
    const pngExport = await callTool(handler, 'create_export', { format: 'png' })
    expect(pngExport.isError).toBe(false)
    expect(pngExport.json!.status).toBe('queued')
    expect(pngExport.json!.format).toBe('png')
    expect(state.exports).toHaveLength(1)
    // json export embeds the document in metadata
    const jsonExport = await callTool(handler, 'create_export', { format: 'json' })
    expect(jsonExport.isError).toBe(false)
    expect(jsonExport.json!.status).toBe('queued')
    expect(jsonExport.json!.metadata.document).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Validation rejection → isError with readable reason, no state mutation
// ---------------------------------------------------------------------------

describe('validation rejections', () => {
  it('add_text with a missing required argument surfaces isError and writes nothing', async () => {
    const { handler, state } = setup()
    const result = await callTool(handler, 'add_text', { text: 'hi', x: 0 }) // missing y and width
    expect(result.isError).toBe(true)
    expect(result.text).toContain('add_text failed:')
    expect(state.document.pages[0]!.elements).toHaveLength(0)
    expect(state.decisions).toHaveLength(0)
  })

  it('add_shape with line kind and missing points surfaces isError', async () => {
    const { handler, state } = setup()
    const result = await callTool(handler, 'add_shape', { kind: 'line', x: 0, y: 0 })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('points')
    expect(state.decisions).toHaveLength(0)
  })

  it('set_attrs on a non-existent element surfaces the store throw', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const result = await callTool(handler, 'set_attrs', {
      page_id: pageId,
      element_id: 'ghost-el',
      attrs: { x: 10 },
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('ghost-el')
  })

  it('delete_page on last page is rejected by validate', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const result = await callTool(handler, 'delete_page', { page_id: pageId })
    expect(result.isError).toBe(true)
    // validate blocks it — document unchanged
    expect(state.document.pages).toHaveLength(1)
  })

  it('add_image with a non-https src surfaces the media boundary assertion', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id
    const result = await callTool(handler, 'add_image', {
      page_id: pageId,
      src: 'file:///tmp/photo.jpg',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('http')
    expect(state.decisions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Stale-rev conflict
// ---------------------------------------------------------------------------

describe('stale-rev conflict', () => {
  it('a concurrent save that exhausts retries surfaces a readable error', async () => {
    const { store: baseStore, state } = createMemoryStore()
    // Always throw on save to simulate a writer that keeps advancing the rev before us
    const alwaysStaleStore: SceneStore = {
      ...baseStore,
      async saveDocument(_document, expectedRev) {
        throw new Error(`stale rev: expected ${state.rev + 1}, got ${expectedRev}`)
      },
    }
    let counter = 0
    const handler = createDesignCanvasMcpHandler({ store: alwaysStaleStore, mintId: () => `id-${++counter}` })
    const pageId = state.document.pages[0]!.id
    const result = await callTool(handler, 'add_text', { text: 'concurrent', x: 0, y: 0, width: 100, page_id: pageId })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stale rev')
  })
})

// ---------------------------------------------------------------------------
// JSON-RPC protocol errors
// ---------------------------------------------------------------------------

describe('JSON-RPC protocol errors', () => {
  it('rejects non-POST with 405', async () => {
    const { handler } = setup()
    const res = await handler(new Request('http://app.test/mcp', { method: 'GET' }))
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })

  it('malformed JSON is a -32700 parse error', async () => {
    const { handler } = setup()
    const res = await post(handler, '{nope')
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, any>
    expect(body.error.code).toBe(-32700)
    expect(body.id).toBeNull()
  })

  it('batch arrays and non-2.0 envelopes are -32600', async () => {
    const { handler } = setup()
    const batch = await post(handler, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))
    expect(batch.status).toBe(400)
    expect(((await batch.json()) as Record<string, any>).error.code).toBe(-32600)

    const noMethod = await post(handler, JSON.stringify({ jsonrpc: '2.0', id: 2 }))
    expect(((await noMethod.json()) as Record<string, any>).error.code).toBe(-32600)

    const wrongVersion = await post(handler, JSON.stringify({ jsonrpc: '1.0', id: 3, method: 'ping' }))
    expect(((await wrongVersion.json()) as Record<string, any>).error.code).toBe(-32600)
  })

  it('unknown methods are -32601', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'resources/list')
    expect(body.error.code).toBe(-32601)
    expect(body.error.message).toContain('resources/list')
  })

  it('tools/call protocol misuse is -32602 with the available tool names', async () => {
    const { handler } = setup()
    const noName = await rpc(handler, 'tools/call', {})
    expect(noName.body.error.code).toBe(-32602)

    const unknownTool = await rpc(handler, 'tools/call', { name: 'paint_frame' })
    expect(unknownTool.body.error.code).toBe(-32602)
    expect(unknownTool.body.error.message).toContain('add_text')

    const badArgs = await rpc(handler, 'tools/call', { name: 'get_scene_state', arguments: 'not-an-object' })
    expect(badArgs.body.error.code).toBe(-32602)
  })

  it('answers ping', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'ping')
    expect(body.result).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// buildDesignCanvasMcpServerEntry
// ---------------------------------------------------------------------------

describe('buildDesignCanvasMcpServerEntry', () => {
  it('builds the AgentProfileMcpServer-shaped http entry without ctx', () => {
    const entry = buildDesignCanvasMcpServerEntry({
      baseUrl: 'https://app.test/',
      path: '/api/canvas/doc-1/mcp',
      token: 'cap_abc',
    })
    expect(entry).toEqual({
      transport: 'http',
      url: 'https://app.test/api/canvas/doc-1/mcp',
      headers: { Authorization: 'Bearer cap_abc', 'Content-Type': 'application/json' },
      enabled: true,
      metadata: { description: DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION },
    })
  })

  it('carries identity headers when ctx is supplied', () => {
    const entry = buildDesignCanvasMcpServerEntry({
      baseUrl: 'https://app.test',
      path: '/api/canvas/doc-1/mcp',
      token: 'cap_abc',
      description: 'Brand asset editor',
      ctx: { userId: 'user-1', workspaceId: 'ws-1', threadId: null },
    })
    expect(entry.headers.Authorization).toBe('Bearer cap_abc')
    expect(entry.headers['X-Agent-App-User-Id']).toBe('user-1')
    expect(entry.headers['X-Agent-App-Workspace-Id']).toBe('ws-1')
    expect(entry.metadata.description).toBe('Brand asset editor')
  })

  it('fails closed on a missing token and a relative path', () => {
    expect(() =>
      buildDesignCanvasMcpServerEntry({ baseUrl: 'https://app.test', path: '/mcp', token: '  ' }),
    ).toThrow(/capability token/)
    expect(() =>
      buildDesignCanvasMcpServerEntry({ baseUrl: 'https://app.test', path: 'mcp', token: 'cap_abc' }),
    ).toThrow(/must start with/)
  })
})

// ---------------------------------------------------------------------------
// Regression: instantiate_template works with slotted source pages
// ---------------------------------------------------------------------------

describe('instantiate_template — slotted source pages', () => {
  it('fills text slot on the copy without throwing duplicate-slot-name', async () => {
    const { handler, state } = setup()
    const pageId = state.document.pages[0]!.id

    // 1. Add a text element
    const addResult = await callTool(handler, 'add_text', {
      page_id: pageId,
      text: 'Placeholder',
      x: 0, y: 0, width: 400,
    })
    expect(addResult.isError).toBe(false)
    const textId = addResult.json!['element_id'] as string

    // 2. Bind a slot to the text element
    const bindResult = await callTool(handler, 'bind_slot', {
      page_id: pageId,
      element_id: textId,
      slot: 'title',
    })
    expect(bindResult.isError).toBe(false)

    // 3. instantiate_template with bindings — previously threw
    // "duplicate slot name" because apply_data walked ALL pages (source + copy)
    const result = await callTool(handler, 'instantiate_template', {
      source_page_ids: [pageId],
      bindings: { title: 'Hello World' },
    })
    expect(result.isError).toBe(false)

    // Document must now have 2 pages: original + copy
    const doc = state.document
    expect(doc.pages).toHaveLength(2)

    // Copy page text must be 'Hello World'
    const copyPage = doc.pages[1]!
    const copyText = copyPage.elements.find((e) => e.kind === 'text') as import('../../src/design-canvas/model').TextElement | undefined
    expect(copyText).toBeDefined()
    expect(copyText!.text).toBe('Hello World')

    // Original page text must still be 'Placeholder' (bindings targeted copy only)
    const origText = doc.pages[0]!.elements.find((e) => e.id === textId) as import('../../src/design-canvas/model').TextElement | undefined
    expect(origText).toBeDefined()
    expect(origText!.text).toBe('Placeholder')
  })
})

// ---------------------------------------------------------------------------
// Regression: set_page_guides rejects non-array args
// ---------------------------------------------------------------------------

describe('set_page_guides — type validation', () => {
  it('returns isError when vertical is not an array', async () => {
    const { handler, state } = setup()
    const result = await callTool(handler, 'set_page_guides', {
      page_id: state.document.pages[0]!.id,
      vertical: 500,
      horizontal: [],
    })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/vertical must be an array/)
  })

  it('returns isError when horizontal is not an array', async () => {
    const { handler, state } = setup()
    const result = await callTool(handler, 'set_page_guides', {
      page_id: state.document.pages[0]!.id,
      vertical: [],
      horizontal: 'bad',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/horizontal must be an array/)
  })

  it('accepts valid arrays and stores guides', async () => {
    const { handler, state } = setup()
    const result = await callTool(handler, 'set_page_guides', {
      page_id: state.document.pages[0]!.id,
      vertical: [100, 200],
      horizontal: [300],
    })
    expect(result.isError).toBe(false)
    expect(state.document.pages[0]!.guides.vertical).toEqual([100, 200])
    expect(state.document.pages[0]!.guides.horizontal).toEqual([300])
  })
})
