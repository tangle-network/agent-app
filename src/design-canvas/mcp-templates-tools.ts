import type { McpToolDefinition } from '../tools/mcp-rpc'
import { type DesignCanvasMcpToolEnv, applyPlan, collectPageSlotAttrs } from './mcp-context'
import { objectSchema, requireMcpString, isRecord, requireEnum } from '../tools/mcp-arguments'
import { pageIdProp, elementIdProp, optionalRecord, optionalString, optionalNumber } from './mcp-input'
import type { SceneOperation } from './operations'
import { requirePage } from './model'

export const CANVAS_TEMPLATES_TOOLS: McpToolDefinition<DesignCanvasMcpToolEnv>[] = [
// ─── template / data binding ──────────────────────────────────────────────

  {
    name: 'bind_slot',
    description:
      'Bind or unbind a template slot name to an element. Slot names are unique document-wide. Text elements accept string data; image/video elements accept src URLs. Pass null for slot to unbind.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        slot: { type: ['string', 'null'], description: 'Slot name to bind, or null to unbind.' },
      },
      ['page_id', 'element_id', 'slot'],
    ),
    async run(args, env) {
      const pageId = requireMcpString(args, 'page_id')
      const elementId = requireMcpString(args, 'element_id')
      const slot = args['slot'] === null ? null : requireMcpString(args, 'slot')
      const result = await applyPlan(env.store, env.mintId, `bind slot "${slot}" to ${elementId}`, [
        { type: 'bind_slot', pageId, elementId, slot },
      ])
      return result
    },
  },

{
    name: 'apply_data',
    description:
      'Fill template slots with data. bindings is a {slot_name: value} map. Text slots accept any string; image/video slots accept http(s) URLs or /api/ paths; unknown slot names throw. Partial application is allowed.',
    inputSchema: objectSchema(
      {
        bindings: {
          type: 'object',
          description: 'Map of slot name → value. Text slots: string. Image/video slots: URL.',
          additionalProperties: { type: 'string' },
        },
      },
      ['bindings'],
    ),
    async run(args, env) {
      if (!isRecord(args['bindings'])) throw new Error('bindings must be an object')
      const bindings = args['bindings'] as Record<string, string>
      const result = await applyPlan(env.store, env.mintId, `apply data to ${Object.keys(bindings).length} slots`, [
        { type: 'apply_data', bindings },
      ])
      return result
    },
  },

{
    name: 'instantiate_template',
    description:
      'Clone this document\'s page(s) with freshly minted element ids and fill the declared slots with the provided data bindings in one atomic call. Use this to produce personalized copies of a template document without modifying the original. Returns the new page ids in order. Note: this mutates the SAME document by appending copies of the requested pages with re-minted ids and applying data — it does NOT create a separate document. After calling, the document contains both the original pages and the new copies.',
    inputSchema: objectSchema(
      {
        source_page_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Page ids to clone. Omit to clone all pages.',
        },
        bindings: {
          type: 'object',
          description: 'Slot name → value map applied after cloning.',
          additionalProperties: { type: 'string' },
        },
      },
      [],
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument()
      const rawSourceIds = Array.isArray(args['source_page_ids'])
        ? (args['source_page_ids'] as string[])
        : document.pages.map((p) => p.id)
      const bindings = optionalRecord(args, 'bindings') ?? {}
      if (rawSourceIds.length === 0) throw new Error('source_page_ids must not be empty')

      // Phase 1: for each source page, collect any slots to temporarily unbind
      // from the source before duplicating. apply_data's collectSlots() walks ALL
      // pages, so it throws on duplicate slot names when source and copy share the
      // same slot attribute. The strategy: unbind source slots → duplicate →
      // apply_data (only copy pages carry slots now) → re-bind source slots. All
      // four phases are one atomic applyPlan call.
      const unbindOps: SceneOperation[] = []
      const rebindOps: SceneOperation[] = []
      const dupOps: SceneOperation[] = []
      const newPageIds: string[] = []

      for (const sourcePageId of rawSourceIds) {
        const sourcePage = requirePage(document, sourcePageId)
        // Collect slots on the source page (single-page walk, no collision check).
        const sourceSlots = collectPageSlotAttrs(sourcePage)
        for (const [slotName, { elementId }] of sourceSlots) {
          unbindOps.push({ type: 'bind_slot', pageId: sourcePageId, elementId, slot: null })
          rebindOps.push({ type: 'bind_slot', pageId: sourcePageId, elementId, slot: slotName })
        }
        const pageId = env.mintId()
        newPageIds.push(pageId)
        dupOps.push({ type: 'duplicate_page', sourcePageId, pageId })
      }

      const applyDataOps: SceneOperation[] = Object.keys(bindings).length > 0
        ? [{ type: 'apply_data', bindings }]
        : []

      // Op ordering is critical: duplicate FIRST (copies inherit source slots),
      // then unbind source slots (sources now have no slots, copies still do),
      // then apply_data (only copy pages carry slots — no duplicate names),
      // then re-bind source slots (restore original state of source pages).
      const allOps: SceneOperation[] = [
        ...dupOps,
        ...unbindOps,
        ...applyDataOps,
        ...rebindOps,
      ]

      const result = await applyPlan(
        env.store,
        env.mintId,
        `instantiate template (${rawSourceIds.length} pages)`,
        allOps,
      )
      return { new_page_ids: newPageIds, ...result }
    },
  },

// ─── exports ──────────────────────────────────────────────────────────────

  {
    name: 'create_export',
    description:
      'Queue a document export. For "png" and "jpeg", a render job is queued and status starts as "queued" — the host renders the Konva canvas and uploads the result. For "json", the export completes immediately with the full document JSON in metadata. Returns the export record id and initial status.',
    inputSchema: objectSchema(
      {
        format: { type: 'string', enum: ['png', 'jpeg', 'json'], description: 'Export format.' },
        page_id: { type: 'string', description: 'Page to export. Omit to export all pages (first page for images).' },
        pixel_ratio: { type: 'number', description: 'Device pixel ratio for raster exports. Default 1.' },
      },
      ['format'],
    ),
    async run(args, env) {
      const format = requireEnum(args, 'format', ['png', 'jpeg', 'json'] as const)
      const pageId = optionalString(args, 'page_id')
      const pixelRatio = optionalNumber(args, 'pixel_ratio') ?? 1

      let metadata: Record<string, unknown> = {
        pageId: pageId ?? null,
        pixelRatio,
      }

      if (format === 'json') {
        const { document, rev } = await env.store.getDocument()
        metadata = { ...metadata, document, rev }
      }

      const exportRecord = await env.store.createExport(format, metadata)
      await env.store.recordDecision({
        kind: 'export',
        instruction: `create ${format} export${pageId ? ` for page ${pageId}` : ''}`,
        metadata: { tool: 'create_export', export_id: exportRecord.id, format },
      })
      return {
        export_id: exportRecord.id,
        format: exportRecord.format,
        status: exportRecord.status,
        metadata: exportRecord.metadata,
        created_at: exportRecord.createdAt,
      }
    },
  }
]
