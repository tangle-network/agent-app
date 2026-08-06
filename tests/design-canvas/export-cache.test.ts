// @vitest-environment jsdom
/**
 * exportPageDataUrl must rasterize VECTORS, not the screen-resolution bitmap
 * caches that ElementNode's useNodeCache attaches for pan/zoom snappiness.
 * Those caches are rasterized at zoom × devicePixelRatio for the screen; a
 * 2x/3x export would upscale them and ship blurry text. The export must clear
 * every cached node BEFORE stage.toDataURL and re-cache it AFTER at the same
 * screen pixel ratio (absolute scale × devicePixelRatio — the shared policy in
 * export-math.resolveNodeCachePixelRatio).
 *
 * export.ts compiles against a minimal structural Konva interface precisely so
 * it can be exercised with plain fakes — no canvas context needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScenePage } from '../../src/design-canvas/model'
import { exportPageDataUrl } from '../../src/design-canvas-react/export'

// ---------------------------------------------------------------------------
// Structural fakes matching export.ts's KonvaNodeLike / KonvaStageLike
// ---------------------------------------------------------------------------

const ORIGINAL_DPR = window.devicePixelRatio

interface FakeNodeOptions {
  name: string
  cached?: boolean
  scale?: number
  children?: FakeNode[]
  label?: string
}

interface FakeNode {
  name(): string
  visible(): boolean
  visible(v: boolean): void
  getAttr(key: string): unknown
  isCached(): boolean
  clearCache(): void
  cache(config?: { pixelRatio?: number }): void
  getAbsoluteScale(): { x: number; y: number }
  getChildren?(): FakeNode[]
}

function makeNode(opts: FakeNodeOptions, calls: string[]): FakeNode {
  const label = opts.label ?? opts.name
  let visible = true
  const node: FakeNode = {
    name: () => opts.name,
    visible: ((v?: boolean) => {
      if (v === undefined) return visible
      visible = v
      calls.push(`${label}:visible:${v}`)
    }) as FakeNode['visible'],
    getAttr: () => undefined,
    isCached: () => opts.cached === true,
    clearCache: () => {
      calls.push(`${label}:clearCache`)
    },
    cache: (config) => {
      calls.push(`${label}:cache:${String(config?.pixelRatio)}`)
    },
    getAbsoluteScale: () => ({ x: opts.scale ?? 1, y: opts.scale ?? 1 }),
  }
  if (opts.children) node.getChildren = () => opts.children!
  return node
}

function makeStage(children: FakeNode[], calls: string[], toDataURLImpl?: () => string) {
  let params: Record<string, unknown> | null = null
  return {
    stage: {
      scaleX: () => 1,
      scaleY: () => 1,
      x: () => 0,
      y: () => 0,
      getLayers: () => [{ getChildren: () => children }],
      toDataURL: (p: Record<string, unknown>) => {
        params = p
        calls.push('stage:toDataURL')
        if (toDataURLImpl) return toDataURLImpl()
        return 'data:image/png;base64,x'
      },
    },
    toDataURLParams: () => params,
  }
}

function page(): ScenePage {
  return {
    id: 'p1',
    name: 'Page',
    width: 1080,
    height: 1080,
    background: '#ffffff',
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements: [],
  }
}

beforeEach(() => {
  // Prove the restore ratio is wired to the device pixel ratio, not hardcoded.
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
})

afterEach(() => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ORIGINAL_DPR })
})

// ---------------------------------------------------------------------------
// Cache clearing around toDataURL
// ---------------------------------------------------------------------------

describe('exportPageDataUrl node-cache handling', () => {
  it('clears a cached node (found through nested groups) BEFORE toDataURL and re-caches it AFTER at absoluteScale × dpr', async () => {
    const calls: string[] = []
    // Cached element at fit-page zoom 0.47, nested inside an uncached group —
    // the walk must recurse to find it.
    const cachedEl = makeNode({ name: 'el-1', cached: true, scale: 0.47, label: 'el' }, calls)
    const group = makeNode({ name: 'content', label: 'grp', children: [cachedEl] }, calls)
    const { stage } = makeStage([group], calls)

    await exportPageDataUrl(stage, page(), { format: 'png', pixelRatio: 2 })

    expect(calls).toEqual([
      'el:clearCache',
      'stage:toDataURL',
      // 0.47 absolute scale × 2 dpr — the same screen-resolution policy
      // ElementNode applies when it caches for the current view.
      'el:cache:0.94',
    ])
  })

  it('does not touch nodes that were never cached', async () => {
    const calls: string[] = []
    const plain = makeNode({ name: 'el-1', label: 'el' }, calls)
    const { stage } = makeStage([plain], calls)

    await exportPageDataUrl(stage, page(), { format: 'png', pixelRatio: 2 })

    expect(calls).toEqual(['stage:toDataURL'])
  })

  it('passes the resolved export params through to toDataURL unchanged', async () => {
    const calls: string[] = []
    const cachedEl = makeNode({ name: 'el-1', cached: true, scale: 1, label: 'el' }, calls)
    const { stage, toDataURLParams } = makeStage([cachedEl], calls)

    await exportPageDataUrl(stage, page(), { format: 'png', pixelRatio: 2 })

    const params = toDataURLParams()
    expect(params).toMatchObject({ mimeType: 'image/png', pixelRatio: 2, width: 1080, height: 1080 })
  })

  it('restores caches and overlay visibility when toDataURL throws, before rethrowing', async () => {
    const calls: string[] = []
    const cachedEl = makeNode({ name: 'el-1', cached: true, scale: 0.5, label: 'el' }, calls)
    const overlay = makeNode({ name: 'overlay:grid', label: 'ovl' }, calls)
    const securityError = new Error('tainted')
    securityError.name = 'SecurityError'
    const { stage } = makeStage([cachedEl, overlay], calls, () => {
      throw securityError
    })

    await expect(exportPageDataUrl(stage, page(), { format: 'png' })).rejects.toThrow(/SecurityError/)

    expect(calls).toEqual([
      'ovl:visible:false',
      'el:clearCache',
      'stage:toDataURL',
      'ovl:visible:true',
      // 0.5 × 2 dpr — cache restored even on the failure path.
      'el:cache:1',
    ])
  })
})
