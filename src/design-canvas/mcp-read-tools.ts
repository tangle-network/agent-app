import type { McpToolDefinition } from '../tools/mcp-rpc'
import { type DesignCanvasMcpToolEnv, pageSnapshot, elementAabbRecord } from './mcp-context'
import { objectSchema, requireMcpString } from '../tools/mcp-arguments'
import { pageIdProp, optionalNumber } from './mcp-input'
import { requirePage } from './model'

export const CANVAS_READ_TOOLS: McpToolDefinition<DesignCanvasMcpToolEnv>[] = [
// ─── read ────────────────────────────────────────────────────────────────

  {
    name: 'get_scene_state',
    description:
      'Read the full scene document: title, settings, all pages with dimensions and background, and every element with its axis-aligned bounding box (so you can reason about layout and overlap without rendering). Call this before editing to get real page and element ids.',
    inputSchema: objectSchema({}, []),
    async run(_args, env) {
      const { document, rev } = await env.store.getDocument()
      return {
        rev,
        title: document.title,
        schema_version: document.schemaVersion,
        settings: document.settings,
        pages: document.pages.map(pageSnapshot),
      }
    },
  },

{
    name: 'describe_page',
    description:
      'Read one page in detail: name, dimensions, background, bleed, guides, and every element with geometry, attributes, and slot bindings. Use this when you need attribute values (fill, font, src) the compact get_scene_state summary omits.',
    inputSchema: objectSchema(
      { page_id: pageIdProp },
      ['page_id'],
    ),
    async run(args, env) {
      const pageId = requireMcpString(args, 'page_id')
      const { document, rev } = await env.store.getDocument()
      const page = requirePage(document, pageId)
      return {
        rev,
        id: page.id,
        name: page.name,
        width: page.width,
        height: page.height,
        background: page.background,
        bleed: page.bleed,
        guides: page.guides,
        elements: page.elements.map((el) => ({ ...el, aabb: elementAabbRecord(el) })),
      }
    },
  },

{
    name: 'list_decisions',
    description: 'List recent agent decisions recorded against this document. Useful to audit what the agent has already done this session.',
    inputSchema: objectSchema(
      { limit: { type: 'number', description: 'Max decisions to return (default 20, max 100).' } },
      [],
    ),
    async run(args, env) {
      const limitRaw = optionalNumber(args, 'limit') ?? 20
      const limit = Math.min(100, Math.max(1, Math.round(limitRaw)))
      const decisions = await env.store.listDecisions(limit)
      return { decisions }
    },
  }
]
