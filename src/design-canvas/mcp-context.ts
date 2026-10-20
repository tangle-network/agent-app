import type { SceneStore } from './store'
import { type SceneDocument, requirePage, type SceneElement, elementAabb, type ScenePage } from './model'
import { optionalString } from './mcp-input'
import type { SceneOperation, ScenePlan } from './operations'
import { storeApplyScenePlan } from './apply'

// ---------------------------------------------------------------------------
// Tool env
// ---------------------------------------------------------------------------

/** Define the environment for MCP tool with a scene store and ID minting function */
export interface DesignCanvasMcpToolEnv {
  store: SceneStore
  mintId: () => string
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pick the first page id when the caller omits page_id. */
export function resolvePageId(document: SceneDocument, args: Record<string, unknown>): string {
  const pageId = optionalString(args, 'page_id')
  if (pageId) {
    requirePage(document, pageId)
    return pageId
  }
  const first = document.pages[0]
  if (!first) throw new Error('document has no pages')
  return first.id
}

export function elementAabbRecord(el: SceneElement) {
  const aabb = elementAabb(el)
  return { x: aabb.x, y: aabb.y, width: aabb.width, height: aabb.height }
}

export function pageSnapshot(page: ScenePage) {
  return {
    id: page.id,
    name: page.name,
    width: page.width,
    height: page.height,
    background: page.background,
    bleed: page.bleed,
    element_count: page.elements.length,
    elements: page.elements.map((el) => ({
      id: el.id,
      kind: el.kind,
      name: el.name,
      aabb: elementAabbRecord(el),
      rotation: el.rotation,
      opacity: el.opacity,
      locked: el.locked,
      visible: el.visible,
      ...(el.slot ? { slot: el.slot } : {}),
    })),
  }
}

export async function applyPlan(
  store: SceneStore,
  mintId: () => string,
  summary: string,
  operations: SceneOperation[],
): Promise<{ rev: number; operation_count: number }> {
  const plan: ScenePlan = { summary, operations }
  const { record } = await storeApplyScenePlan(store, plan, { actorKind: 'agent_edit', mintId })
  return { rev: record.rev, operation_count: operations.length }
}

/** Collect slot→elementId mapping for a SINGLE page (no cross-page slot walk,
 *  so duplicate slot names across different pages don't cause an error). */
export function collectPageSlotAttrs(page: ScenePage): Map<string, { elementId: string; kind: SceneElement['kind'] }> {
  const slots = new Map<string, { elementId: string; kind: SceneElement['kind'] }>()
  const stack = [...page.elements]
  while (stack.length > 0) {
    const el = stack.pop()!
    if (el.slot) {
      if (slots.has(el.slot)) {
        throw new Error(`duplicate slot name "${el.slot}" on page ${page.id}`)
      }
      slots.set(el.slot, { elementId: el.id, kind: el.kind })
    }
    if (el.kind === 'group') stack.push(...el.children)
  }
  return slots
}
