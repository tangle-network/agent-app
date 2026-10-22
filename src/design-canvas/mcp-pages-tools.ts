import type { McpToolDefinition } from '../tools/mcp-rpc'
import { type DesignCanvasMcpToolEnv, applyPlan } from './mcp-context'
import { objectSchema, requireMcpString, isRecord } from '../tools/mcp-arguments'
import { colorProp, optionalString, optionalNumber, optionalNonNegativeInteger, requireNumber } from './mcp-input'

export const CANVAS_PAGES_TOOLS: McpToolDefinition<DesignCanvasMcpToolEnv>[] = [
// ─── page management ──────────────────────────────────────────────────────

  {
    name: 'add_page',
    description: 'Add a new blank page to the document. Returns the new page\'s id.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'Page name.' },
        width: { type: 'number', description: 'Width in px. Default 1080.' },
        height: { type: 'number', description: 'Height in px. Default 1080.' },
        background: colorProp('Page background. Default "#ffffff".'),
        index: { type: 'number', description: 'Position in the page list (0-based). Omit to append.' },
      },
      [],
    ),
    async run(args, env) {
      const pageId = env.mintId()
      const result = await applyPlan(env.store, env.mintId, 'add page', [
        {
          type: 'add_page',
          pageId,
          options: {
            name: optionalString(args, 'name'),
            width: optionalNumber(args, 'width'),
            height: optionalNumber(args, 'height'),
            background: optionalString(args, 'background'),
          },
          index: optionalNonNegativeInteger(args, 'index'),
        },
      ])
      return { page_id: pageId, ...result }
    },
  },

{
    name: 'duplicate_page',
    description:
      'Duplicate an existing page including all its elements. Element ids are re-minted server-side to avoid conflicts. Returns the new page\'s id.',
    inputSchema: objectSchema(
      {
        source_page_id: { type: 'string', description: 'Page id to copy.' },
      },
      ['source_page_id'],
    ),
    async run(args, env) {
      const sourcePageId = requireMcpString(args, 'source_page_id')
      const pageId = env.mintId()
      const result = await applyPlan(env.store, env.mintId, `duplicate page ${sourcePageId}`, [
        { type: 'duplicate_page', sourcePageId, pageId },
      ])
      return { page_id: pageId, ...result }
    },
  },

{
    name: 'delete_page',
    description: 'Delete a page. Fails if the document has only one page.',
    inputSchema: objectSchema(
      { page_id: { type: 'string', description: 'Page id to delete.' } },
      ['page_id'],
    ),
    async run(args, env) {
      const pageId = requireMcpString(args, 'page_id')
      const result = await applyPlan(env.store, env.mintId, `delete page ${pageId}`, [
        { type: 'delete_page', pageId },
      ])
      return result
    },
  },

{
    name: 'set_page_props',
    description: 'Update a page\'s name, dimensions, background color, or bleed. Pass null for bleed to clear it. Omit fields you don\'t want to change.',
    inputSchema: objectSchema(
      {
        page_id: { type: 'string', description: 'Page id to update.' },
        name: { type: 'string', description: 'New page name.' },
        width: { type: 'number', description: 'New width in px.' },
        height: { type: 'number', description: 'New height in px.' },
        background: colorProp('New background color.'),
        bleed: {
          type: 'object',
          description: 'Bleed extents in px drawn OUTSIDE the page trim edge. Pass null to clear bleed.',
          properties: {
            top: { type: 'number' },
            right: { type: 'number' },
            bottom: { type: 'number' },
            left: { type: 'number' },
          },
          required: ['top', 'right', 'bottom', 'left'],
          nullable: true,
        },
      },
      ['page_id'],
    ),
    async run(args, env) {
      const pageId = requireMcpString(args, 'page_id')
      let bleed: { top: number; right: number; bottom: number; left: number } | null | undefined
      if ('bleed' in args) {
        if (args['bleed'] === null) {
          bleed = null
        } else if (isRecord(args['bleed'])) {
          const b = args['bleed']
          bleed = {
            top: requireNumber(b, 'top'),
            right: requireNumber(b, 'right'),
            bottom: requireNumber(b, 'bottom'),
            left: requireNumber(b, 'left'),
          }
        } else {
          throw new Error('bleed must be an object with top/right/bottom/left or null to clear')
        }
      }
      const result = await applyPlan(env.store, env.mintId, `set props on page ${pageId}`, [
        {
          type: 'set_page_props',
          pageId,
          name: optionalString(args, 'name'),
          width: optionalNumber(args, 'width'),
          height: optionalNumber(args, 'height'),
          background: optionalString(args, 'background'),
          ...(bleed !== undefined ? { bleed } : {}),
        },
      ])
      return result
    },
  },

{
    name: 'set_page_guides',
    description: 'Set ruler guides on a page. Replaces ALL existing guides for that axis — pass the full updated arrays.',
    inputSchema: objectSchema(
      {
        page_id: { type: 'string', description: 'Page id to update.' },
        vertical: { type: 'array', items: { type: 'number' }, description: 'Vertical guide positions in page-coordinate px.' },
        horizontal: { type: 'array', items: { type: 'number' }, description: 'Horizontal guide positions in page-coordinate px.' },
      },
      ['page_id', 'vertical', 'horizontal'],
    ),
    async run(args, env) {
      const pageId = requireMcpString(args, 'page_id')
      if (!Array.isArray(args['vertical'])) throw new Error('vertical must be an array of numbers')
      if (!Array.isArray(args['horizontal'])) throw new Error('horizontal must be an array of numbers')
      const vertical = args['vertical'] as number[]
      const horizontal = args['horizontal'] as number[]
      const result = await applyPlan(env.store, env.mintId, `set guides on page ${pageId}`, [
        { type: 'set_page_guides', pageId, guides: { vertical, horizontal } },
      ])
      return result
    },
  }
]
