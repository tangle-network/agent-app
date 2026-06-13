/**
 * Tests for design-canvas/lint.ts — one positive and one negative case per
 * rule, exact contrast-math cases, score arithmetic, and the design_lint MCP
 * tool envelope via the handler test infrastructure.
 */

import { describe, expect, it } from 'vitest'
import {
  lintScenePage,
  lintSceneDocument,
  computeLintScore,
} from '../../src/design-canvas/lint'
import type { LintFinding } from '../../src/design-canvas/lint'
import type {
  SceneDocument,
  ScenePage,
  TextElement,
  RectElement,
} from '../../src/design-canvas/model'
import { createEmptyDocument, estimateTextHeight } from '../../src/design-canvas/model'
import type { SceneDecision, SceneDocumentRecord, SceneExportRecord, SceneStore } from '../../src/design-canvas/store'
import type { NewSceneDecision } from '../../src/design-canvas/store'
import { createDesignCanvasMcpHandler } from '../../src/design-canvas/mcp-handler'
import { CANVAS_MCP_TOOLS } from '../../src/design-canvas/mcp-tools'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let idCounter = 0
function nextId(): string {
  return `el-${++idCounter}`
}

function makeText(overrides: Partial<TextElement> & { id?: string }): TextElement {
  return {
    id: overrides.id ?? nextId(),
    kind: 'text',
    name: overrides.name ?? 'Text',
    x: overrides.x ?? 100,
    y: overrides.y ?? 100,
    width: overrides.width ?? 200,
    text: overrides.text ?? 'Hello',
    fontFamily: overrides.fontFamily ?? 'Inter',
    fontSize: overrides.fontSize ?? 16,
    fontStyle: overrides.fontStyle ?? 'normal',
    fill: overrides.fill ?? '#000000',
    align: overrides.align ?? 'left',
    lineHeight: overrides.lineHeight ?? 1.2,
    letterSpacing: overrides.letterSpacing ?? 0,
    rotation: overrides.rotation ?? 0,
    opacity: overrides.opacity ?? 1,
    locked: overrides.locked ?? false,
    visible: overrides.visible ?? true,
  }
}

function makeRect(overrides: Partial<RectElement> & { id?: string }): RectElement {
  return {
    id: overrides.id ?? nextId(),
    kind: 'rect',
    name: overrides.name ?? 'Rect',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 100,
    height: overrides.height ?? 100,
    fill: overrides.fill ?? '#cccccc',
    rotation: overrides.rotation ?? 0,
    opacity: overrides.opacity ?? 1,
    locked: overrides.locked ?? false,
    visible: overrides.visible ?? true,
  }
}

function makePage(overrides: Partial<ScenePage> & { id?: string }): ScenePage {
  return {
    id: overrides.id ?? 'page-1',
    name: overrides.name ?? 'Page',
    width: overrides.width ?? 1080,
    height: overrides.height ?? 1080,
    background: overrides.background ?? '#ffffff',
    bleed: overrides.bleed ?? null,
    guides: overrides.guides ?? { vertical: [], horizontal: [] },
    elements: overrides.elements ?? [],
  }
}

function makeDoc(page: ScenePage): SceneDocument {
  return {
    schemaVersion: 1,
    title: 'Test',
    pages: [page],
    settings: { dpi: 96 },
    metadata: {},
  }
}

// ---------------------------------------------------------------------------
// In-memory store + handler for MCP tool tests
// ---------------------------------------------------------------------------

interface MemoryState {
  document: SceneDocument
  rev: number
  decisions: SceneDecision[]
  exports: SceneExportRecord[]
}

function createMemoryStore(doc?: SceneDocument): { store: SceneStore; state: MemoryState } {
  let nextStoreId = 0
  const mintStoreId = (prefix: string) => `${prefix}-${++nextStoreId}`

  const state: MemoryState = {
    document: doc ? JSON.parse(JSON.stringify(doc)) as SceneDocument : createEmptyDocument('Test Canvas'),
    rev: 0,
    decisions: [],
    exports: [],
  }

  const store: SceneStore = {
    async getDocument(): Promise<SceneDocumentRecord> {
      return { document: JSON.parse(JSON.stringify(state.document)) as SceneDocument, rev: state.rev }
    },
    async saveDocument(document: SceneDocument, expectedRev: number): Promise<SceneDocumentRecord> {
      if (expectedRev !== state.rev) throw new Error(`stale rev: expected ${state.rev}, got ${expectedRev}`)
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

type Handler = (request: Request) => Promise<Response>

function setupHandler(doc?: SceneDocument): { handler: Handler } {
  let counter = 0
  const mintId = () => `id-${++counter}`
  const { store } = createMemoryStore(doc)
  const handler = createDesignCanvasMcpHandler({ store, mintId })
  return { handler }
}

async function callTool(handler: Handler, name: string, args?: Record<string, unknown>) {
  const res = await handler(
    new Request('http://app.test/api/canvas/doc-1/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  )
  expect(res.status).toBe(200)
  const body = await res.json() as Record<string, any>
  const result = body.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  return {
    isError: result.isError === true,
    text: result.content[0]!.text,
    json: result.isError ? undefined : (JSON.parse(result.content[0]!.text) as Record<string, any>),
  }
}

// ---------------------------------------------------------------------------
// computeLintScore
// ---------------------------------------------------------------------------

describe('computeLintScore', () => {
  it('returns 100 for no findings', () => {
    expect(computeLintScore([])).toBe(100)
  })

  it('deducts 15 per error', () => {
    const findings: LintFinding[] = [
      { rule: 'contrast', severity: 'error', elementIds: [], message: 'x' },
      { rule: 'text-overlap', severity: 'error', elementIds: [], message: 'x' },
    ]
    expect(computeLintScore(findings)).toBe(70)
  })

  it('deducts 5 per warning', () => {
    const findings: LintFinding[] = [
      { rule: 'hierarchy', severity: 'warning', elementIds: [], message: 'x' },
      { rule: 'alignment', severity: 'warning', elementIds: [], message: 'x' },
      { rule: 'spacing', severity: 'warning', elementIds: [], message: 'x' },
    ]
    expect(computeLintScore(findings)).toBe(85)
  })

  it('floors at 0 when deductions exceed 100', () => {
    const findings: LintFinding[] = Array.from({ length: 8 }, () => ({
      rule: 'contrast' as const,
      severity: 'error' as const,
      elementIds: [],
      message: 'x',
    }))
    expect(computeLintScore(findings)).toBe(0)
  })

  it('mixes errors and warnings correctly', () => {
    // 2 errors (-30) + 2 warnings (-10) = 60
    const findings: LintFinding[] = [
      { rule: 'contrast', severity: 'error', elementIds: [], message: 'x' },
      { rule: 'text-overlap', severity: 'error', elementIds: [], message: 'x' },
      { rule: 'hierarchy', severity: 'warning', elementIds: [], message: 'x' },
      { rule: 'spacing', severity: 'warning', elementIds: [], message: 'x' },
    ]
    expect(computeLintScore(findings)).toBe(60)
  })
})

// ---------------------------------------------------------------------------
// Rule: text-overlap
// ---------------------------------------------------------------------------

describe('rule: text-overlap', () => {
  it('POSITIVE — flags two overlapping text blocks with >15% overlap', () => {
    const a = makeText({ id: 'a', x: 100, y: 100, width: 200, fontSize: 20, lineHeight: 1, text: 'Line' })
    const b = makeText({ id: 'b', x: 150, y: 110, width: 200, fontSize: 20, lineHeight: 1, text: 'Line' })
    // a AABB: (100,100, 200×20)  b AABB: (150,110, 200×20)
    // overlap: x=150..300→150px wide, y=110..120→10px tall = 1500px²
    // smaller area: 200×20=4000px², 1500/4000=37.5% > 15%
    const page = makePage({ elements: [a, b] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overlap')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.elementIds).toContain('a')
    expect(findings[0]!.elementIds).toContain('b')
    expect(findings[0]!.message).toMatch(/\d+%/)
  })

  it('NEGATIVE — two adjacent but non-overlapping text blocks produce no finding', () => {
    const a = makeText({ id: 'a', x: 100, y: 100, width: 200, fontSize: 20, lineHeight: 1, text: 'Line' })
    const b = makeText({ id: 'b', x: 100, y: 130, width: 200, fontSize: 20, lineHeight: 1, text: 'Line' })
    // a AABB: y=100..120, b AABB: y=130..150 — no vertical overlap
    const page = makePage({ elements: [a, b] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overlap')
    expect(findings).toHaveLength(0)
  })

  it('POSITIVE — opaque shape above text covering >30% of text area flags overlap', () => {
    const text = makeText({ id: 'txt', x: 100, y: 100, width: 200, fontSize: 20, lineHeight: 1, text: 'Line' })
    // shape covers text fully, placed after text in element array (higher z)
    const rect = makeRect({ id: 'rect', x: 100, y: 100, width: 200, height: 20, fill: '#ff0000', opacity: 1 })
    const page = makePage({ elements: [text, rect] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overlap')
    expect(findings.some((f) => f.elementIds.includes('txt') && f.elementIds.includes('rect'))).toBe(true)
  })

  it('NEGATIVE — semi-transparent shape (opacity≤0.9) does not trigger shape-over-text', () => {
    const text = makeText({ id: 'txt', x: 100, y: 100, width: 200, fontSize: 20, lineHeight: 1, text: 'Line' })
    const rect = makeRect({ id: 'rect', x: 100, y: 100, width: 200, height: 20, fill: '#ff0000', opacity: 0.5 })
    const page = makePage({ elements: [text, rect] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const shapeFindings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'text-overlap' && f.elementIds.includes('rect'),
    )
    expect(shapeFindings).toHaveLength(0)
  })

  it('NEGATIVE — small overlap (≤15%) is not flagged', () => {
    // a: (0,0,100×100)=10000px², b: (90,0,100×100), overlap=(90..100)×(0..100)=10×100=1000px²
    // 1000/10000 = 10% ≤ 15%
    const a = makeText({ id: 'a', x: 0, y: 0, width: 100, fontSize: 100, lineHeight: 1, text: 'X' })
    const b = makeText({ id: 'b', x: 90, y: 0, width: 100, fontSize: 100, lineHeight: 1, text: 'X' })
    const page = makePage({ elements: [a, b] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overlap')
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rule: element-overflow
// ---------------------------------------------------------------------------

describe('rule: element-overflow', () => {
  it('POSITIVE — element extending past page bounds by >2px is flagged', () => {
    const rect = makeRect({ id: 'big', x: -10, y: 0, width: 100, height: 100 })
    const page = makePage({ elements: [rect] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'element-overflow')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.elementIds).toContain('big')
    expect(findings[0]!.message).toMatch(/left/)
  })

  it('NEGATIVE — element exactly at page edge (within 2px tolerance) is not flagged', () => {
    // right edge: x=980, width=100 → x+w=1080 exactly, page width=1080, overflow=0
    const rect = makeRect({ id: 'ok', x: 980, y: 0, width: 100, height: 100 })
    const page = makePage({ elements: [rect] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'element-overflow')
    expect(findings).toHaveLength(0)
  })

  it('POSITIVE bleed-aware — element exceeding bleed zone is flagged', () => {
    // bleed left=10; element at x=-15 → -10-(-15)=5 > 2 → flagged
    const rect = makeRect({ id: 'overflow', x: -15, y: 0, width: 100, height: 100 })
    const page = makePage({
      elements: [rect],
      bleed: { top: 10, right: 10, bottom: 10, left: 10 },
    })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'element-overflow')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toMatch(/bleed/)
  })

  it('NEGATIVE bleed-aware — element inside bleed zone is not flagged', () => {
    // bleed left=20; element at x=-15 → bleed left edge=-20, element left edge=-15: -20-(-15)=-5 ≤ 0 → ok
    const rect = makeRect({ id: 'ok', x: -15, y: 0, width: 100, height: 100 })
    const page = makePage({
      elements: [rect],
      bleed: { top: 20, right: 20, bottom: 20, left: 20 },
    })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'element-overflow')
    expect(findings).toHaveLength(0)
  })

  it('NEGATIVE — invisible element is not flagged', () => {
    const rect = makeRect({ id: 'hidden', x: -100, y: 0, width: 100, height: 100, visible: false })
    const page = makePage({ elements: [rect] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'element-overflow')
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rule: contrast — exact WCAG luminance math
// ---------------------------------------------------------------------------

describe('rule: contrast — exact math', () => {
  // #000000 on #ffffff: L(black)=0, L(white)=1 → (1+0.05)/(0+0.05)=21:1
  it('black text on white background has contrast ratio 21 (exact)', () => {
    const text = makeText({ id: 'txt', fill: '#000000', fontSize: 16, x: 100, y: 100 })
    const page = makePage({ background: '#ffffff', elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    // 21:1 is well above 4.5:1 — no finding
    expect(findings).toHaveLength(0)
  })

  // White text on white background: ratio = 1 → fails both thresholds
  it('white text on white background fails contrast', () => {
    const text = makeText({ id: 'txt', fill: '#ffffff', fontSize: 16, x: 100, y: 100 })
    const page = makePage({ background: '#ffffff', elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.message).toContain('1.00:1')
  })

  // Mid-gray #767676 on white is commonly cited as just meeting 4.5:1 for WCAG AA.
  // L(#767676): c=118/255≈0.4627, linear=(0.4627+0.055)/1.055^2.4 ≈ 0.2126×lum
  // Precise: actual ratio for #767676/#ffffff ≈ 4.54:1 — should NOT fire for small text
  it('#767676 on #ffffff meets small-text 4.5 threshold (≥4.5 → no finding)', () => {
    const text = makeText({ id: 'txt', fill: '#767676', fontSize: 16, x: 100, y: 100 })
    const page = makePage({ background: '#ffffff', elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    // #767676 on white ≈ 4.54:1 which is ≥ 4.5 — no finding
    expect(findings).toHaveLength(0)
  })

  // #777777 on white ≈ 4.48:1 — below 4.5:1 for small text → should fire
  it('#777777 on #ffffff fails 4.5:1 for small text (fontSize<24)', () => {
    const text = makeText({ id: 'txt', fill: '#777777', fontSize: 16, x: 100, y: 100 })
    const page = makePage({ background: '#ffffff', elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toMatch(/4\.5:1/)
  })

  // Large text (fontSize≥24) uses 3:1 threshold. #aaaaaa on white ≈ 2.32:1 — fails 3:1
  it('#aaaaaa on white fails 3:1 threshold for large text (fontSize≥24)', () => {
    const text = makeText({ id: 'txt', fill: '#aaaaaa', fontSize: 24, x: 100, y: 100 })
    const page = makePage({ background: '#ffffff', elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toMatch(/3:1/)
  })

  // #767676 on white passes 3:1 easily (4.54:1 ≥ 3) — no finding for large text
  it('#767676 on white passes 3:1 for large text (fontSize≥24)', () => {
    const text = makeText({ id: 'txt', fill: '#767676', fontSize: 24, x: 100, y: 100 })
    const page = makePage({ background: '#ffffff', elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    expect(findings).toHaveLength(0)
  })

  // Text over an opaque colored shape uses shape fill as background
  it('uses the underlying opaque shape fill as background for contrast check', () => {
    // Black shape behind text, white text — 21:1 passes
    const bg = makeRect({ id: 'bg', x: 0, y: 0, width: 500, height: 500, fill: '#000000', opacity: 1 })
    const text = makeText({ id: 'txt', fill: '#ffffff', fontSize: 16, x: 100, y: 100, width: 200 })
    const page = makePage({ background: '#ffffff', elements: [bg, text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    expect(findings).toHaveLength(0)
  })

  it('transparent text fill is skipped (no contrast finding)', () => {
    const text = makeText({ id: 'txt', fill: 'transparent', fontSize: 16, x: 100, y: 100 })
    const page = makePage({ background: '#ffffff', elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'contrast')
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rule: hierarchy
// ---------------------------------------------------------------------------

describe('rule: hierarchy', () => {
  it('POSITIVE — >3 distinct font sizes triggers a finding', () => {
    const texts = [14, 16, 18, 24].map((fs) =>
      makeText({ fontSize: fs, text: 'Sample', y: fs * 20 }),
    )
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'hierarchy')
    expect(findings.some((f) => f.message.includes('4 distinct font sizes'))).toBe(true)
  })

  it('NEGATIVE — exactly 3 distinct font sizes is fine', () => {
    const texts = [14, 20, 36].map((fs) =>
      makeText({ fontSize: fs, text: 'Sample', y: fs * 10 }),
    )
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const sizeFindings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'hierarchy' && f.message.includes('distinct font sizes'),
    )
    expect(sizeFindings).toHaveLength(0)
  })

  it('POSITIVE — max/min ratio <1.4 triggers flat hierarchy finding', () => {
    const texts = [14, 16].map((fs) => makeText({ fontSize: fs, text: 'x', y: fs * 5 }))
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const flatFindings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'hierarchy' && f.message.includes('ratio'),
    )
    expect(flatFindings).toHaveLength(1)
  })

  it('NEGATIVE — ratio ≥1.4 does not trigger flat hierarchy', () => {
    const texts = [14, 20].map((fs) => makeText({ fontSize: fs, text: 'x', y: fs * 5 }))
    // 20/14 ≈ 1.43 ≥ 1.4 → ok
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const flatFindings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'hierarchy' && f.message.includes('ratio'),
    )
    expect(flatFindings).toHaveLength(0)
  })

  it('POSITIVE — same fontSize ±1px but different fontFamily triggers finding', () => {
    const a = makeText({ id: 'a', fontSize: 16, fontFamily: 'Inter', y: 100 })
    const b = makeText({ id: 'b', fontSize: 16, fontFamily: 'Georgia', y: 150 })
    const page = makePage({ elements: [a, b] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'hierarchy' && f.elementIds.includes('a') && f.elementIds.includes('b'),
    )
    expect(findings).toHaveLength(1)
  })

  it('NEGATIVE — same fontSize, same fontFamily — no finding', () => {
    const a = makeText({ id: 'a', fontSize: 16, fontFamily: 'Inter', y: 100 })
    const b = makeText({ id: 'b', fontSize: 16, fontFamily: 'Inter', y: 150 })
    const page = makePage({ elements: [a, b] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'hierarchy' && f.elementIds.includes('a'),
    )
    // No family-conflict finding
    expect(findings.filter((f) => f.message.includes('same size but different fonts'))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rule: alignment
// ---------------------------------------------------------------------------

describe('rule: alignment', () => {
  it('POSITIVE — >4 distinct left-edge clusters among text elements triggers ragged layout', () => {
    // 5 texts at very different x positions (>4px apart)
    const xPositions = [0, 100, 200, 300, 400]
    const texts = xPositions.map((x) => makeText({ x, y: 100, width: 50 }))
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'alignment' && f.message.includes('distinct left-edge'),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toMatch(/5 distinct/)
  })

  it('NEGATIVE — ≤4 distinct left-edge clusters is fine', () => {
    const xPositions = [100, 102, 300, 302] // clusters at ~100 and ~300
    const texts = xPositions.map((x) => makeText({ x, y: 100, width: 50 }))
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'alignment' && f.message.includes('distinct left-edge'),
    )
    expect(findings).toHaveLength(0)
  })

  it('POSITIVE — element within 12px of a page edge triggers crowding finding', () => {
    const rect = makeRect({ id: 'close', x: 5, y: 100, width: 100, height: 50 })
    const page = makePage({ elements: [rect] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'alignment' && f.elementIds.includes('close'),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toMatch(/left edge/)
  })

  it('NEGATIVE — element 12px or more from all edges is not flagged for crowding', () => {
    const rect = makeRect({ id: 'safe', x: 12, y: 12, width: 100, height: 50 })
    const page = makePage({ elements: [rect] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter(
      (f) => f.rule === 'alignment' && f.elementIds.includes('safe'),
    )
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rule: spacing
// ---------------------------------------------------------------------------

describe('rule: spacing', () => {
  it('POSITIVE — highly irregular vertical gaps between text blocks trigger finding', () => {
    // gaps: 5, 5, 50 — median=5, deviation of 50: (50-5)/5=9 → 900% > 40%
    const texts = [
      makeText({ y: 0, fontSize: 20, lineHeight: 1, width: 200, text: 'A' }),
      makeText({ y: 25, fontSize: 20, lineHeight: 1, width: 200, text: 'B' }),
      makeText({ y: 50, fontSize: 20, lineHeight: 1, width: 200, text: 'C' }),
      makeText({ y: 120, fontSize: 20, lineHeight: 1, width: 200, text: 'D' }),
    ]
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'spacing')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
  })

  it('NEGATIVE — uniform vertical gaps produce no spacing finding', () => {
    const texts = [0, 30, 60, 90].map((y) =>
      makeText({ y, fontSize: 20, lineHeight: 1, width: 200, text: 'X' }),
    )
    // gaps all = 10px (30-0-20=10, etc.)
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'spacing')
    expect(findings).toHaveLength(0)
  })

  it('NEGATIVE — fewer than 3 text elements — spacing rule skipped', () => {
    const texts = [
      makeText({ y: 0, fontSize: 20, lineHeight: 1, text: 'A' }),
      makeText({ y: 100, fontSize: 20, lineHeight: 1, text: 'B' }),
    ]
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'spacing')
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rule: palette
// ---------------------------------------------------------------------------

describe('rule: palette', () => {
  it('POSITIVE — >5 distinct non-neutral fill colors document-wide triggers finding', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#ffff00', '#00ffff']
    const texts = colors.map((fill) => makeText({ fill, y: 100 }))
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintSceneDocument(doc)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'palette')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.message).toMatch(/6 distinct/)
  })

  it('NEGATIVE — ≤5 distinct non-neutral colors is fine', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#ffff00']
    const texts = colors.map((fill) => makeText({ fill, y: 100 }))
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintSceneDocument(doc)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'palette')
    expect(findings).toHaveLength(0)
  })

  it('NEGATIVE — neutral/achromatic colors are excluded from palette count', () => {
    // All near-grays: max-min < 24
    const colors = ['#111111', '#333333', '#555555', '#777777', '#999999', '#bbbbbb']
    const texts = colors.map((fill) => makeText({ fill, y: 100 }))
    const page = makePage({ elements: texts })
    const doc = makeDoc(page)
    const report = lintSceneDocument(doc)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'palette')
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// lintScenePage and lintSceneDocument integration
// ---------------------------------------------------------------------------

describe('lintScenePage', () => {
  it('returns a single-page report with correct pageId and pageName', () => {
    const page = makePage({ id: 'pg-1', name: 'Cover', elements: [] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, 'pg-1')
    expect(report.pages).toHaveLength(1)
    expect(report.pages[0]!.pageId).toBe('pg-1')
    expect(report.pages[0]!.pageName).toBe('Cover')
  })

  it('throws when pageId is not found', () => {
    const doc = createEmptyDocument('Doc')
    expect(() => lintScenePage(doc, 'ghost')).toThrow('ghost')
  })

  it('clean page returns score 100 with no findings', () => {
    const text = makeText({ x: 200, y: 200, fontSize: 16, fill: '#000000', width: 200 })
    const page = makePage({ elements: [text] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    // Only possible failure: contrast (black on white = 21:1 — fine) or crowding margin
    // 200px in from edge — fine
    const errors = report.pages[0]!.findings.filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(0)
    expect(report.pages[0]!.score).toBe(100)
  })
})

describe('lintSceneDocument', () => {
  it('returns one page result per document page', () => {
    const doc: SceneDocument = {
      schemaVersion: 1,
      title: 'Multi',
      pages: [
        makePage({ id: 'p1', name: 'Page 1' }),
        makePage({ id: 'p2', name: 'Page 2' }),
      ],
      settings: { dpi: 96 },
      metadata: {},
    }
    const report = lintSceneDocument(doc)
    expect(report.pages).toHaveLength(2)
    expect(report.pages[0]!.pageId).toBe('p1')
    expect(report.pages[1]!.pageId).toBe('p2')
  })

  it('documentScore is the average of page scores', () => {
    // Two pages: one with 1 error (score 85), one clean (score 100)
    const errText = makeText({ id: 'e1', fill: '#ffffff', fontSize: 16, x: 200, y: 200 })
    const doc: SceneDocument = {
      schemaVersion: 1,
      title: 'Multi',
      pages: [
        makePage({ id: 'p1', background: '#ffffff', elements: [errText] }),
        makePage({ id: 'p2', elements: [] }),
      ],
      settings: { dpi: 96 },
      metadata: {},
    }
    const report = lintSceneDocument(doc)
    // p1 has contrast error: score 85; p2 clean: 100 → avg 92.5
    expect(report.documentScore).toBeLessThan(100)
    expect(report.documentScore).toBeGreaterThan(0)
  })

  it('errorCount and warningCount aggregate across all pages', () => {
    // Each page will have a contrast error (white text on white bg)
    const errText1 = makeText({ id: 'e1', fill: '#ffffff', fontSize: 16, x: 200, y: 200 })
    const errText2 = makeText({ id: 'e2', fill: '#ffffff', fontSize: 16, x: 200, y: 200 })
    const doc: SceneDocument = {
      schemaVersion: 1,
      title: 'Multi',
      pages: [
        makePage({ id: 'p1', background: '#ffffff', elements: [errText1] }),
        makePage({ id: 'p2', background: '#ffffff', elements: [errText2] }),
      ],
      settings: { dpi: 96 },
      metadata: {},
    }
    const report = lintSceneDocument(doc)
    expect(report.errorCount).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// MCP tool: design_lint — envelope and read-only contract
// ---------------------------------------------------------------------------

describe('MCP tool: design_lint', () => {
  it('is listed in CANVAS_MCP_TOOLS with a non-trivial description and correct schema', () => {
    const tool = CANVAS_MCP_TOOLS.find((t) => t.name === 'design_lint')
    expect(tool).toBeDefined()
    expect(tool!.description.length).toBeGreaterThan(50)
    expect(tool!.description).toMatch(/workflow/i)
    expect(tool!.description).toMatch(/error/i)
    expect(tool!.inputSchema.type).toBe('object')
  })

  it('returns a clean report for an empty document (no findings, score 100)', async () => {
    const { handler } = setupHandler()
    const result = await callTool(handler, 'design_lint')
    expect(result.isError).toBe(false)
    expect(result.json!.documentScore).toBe(100)
    expect(result.json!.errorCount).toBe(0)
    expect(result.json!.warningCount).toBe(0)
    expect(result.json!.pages).toHaveLength(1)
  })

  it('returns findings when the document has a contrast error', async () => {
    // White text on white background → contrast error
    const errText = makeText({ id: 'bad', fill: '#ffffff', fontSize: 16, x: 200, y: 200 })
    const page = makePage({ background: '#ffffff', elements: [errText] })
    const doc = makeDoc(page)
    const { handler } = setupHandler(doc)
    const result = await callTool(handler, 'design_lint')
    expect(result.isError).toBe(false)
    expect(result.json!.errorCount).toBeGreaterThanOrEqual(1)
    const findings = result.json!.pages[0].findings as Array<{ rule: string; severity: string; message: string }>
    const contrastFindings = findings.filter((f) => f.rule === 'contrast')
    expect(contrastFindings).toHaveLength(1)
    expect(contrastFindings[0]!.severity).toBe('error')
  })

  it('accepts page_id to scope lint to a single page', async () => {
    const doc = createEmptyDocument('Test')
    const { handler } = setupHandler(doc)
    const pageId = doc.pages[0]!.id
    const result = await callTool(handler, 'design_lint', { page_id: pageId })
    expect(result.isError).toBe(false)
    expect(result.json!.pages).toHaveLength(1)
    expect(result.json!.pages[0].pageId).toBe(pageId)
  })

  it('fails loud for an unknown page_id', async () => {
    const { handler } = setupHandler()
    const result = await callTool(handler, 'design_lint', { page_id: 'ghost-page' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('ghost-page')
  })

  it('does NOT write any decisions to the store (read-only)', async () => {
    const doc = createEmptyDocument('Test')
    const { store } = createMemoryStore(doc)
    let counter = 0
    const mintId = () => `id-${++counter}`
    const handler = createDesignCanvasMcpHandler({ store, mintId })
    const callToolDirect = async (name: string, args?: Record<string, unknown>) => {
      const res = await handler(
        new Request('http://app.test/api/canvas/doc-1/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        }),
      )
      return res
    }
    await callToolDirect('design_lint')
    const decisions = await store.listDecisions()
    expect(decisions).toHaveLength(0)
  })

  it('report envelope contains required fields: documentScore, errorCount, warningCount, pages', async () => {
    const { handler } = setupHandler()
    const result = await callTool(handler, 'design_lint')
    expect(typeof result.json!.documentScore).toBe('number')
    expect(typeof result.json!.errorCount).toBe('number')
    expect(typeof result.json!.warningCount).toBe('number')
    expect(Array.isArray(result.json!.pages)).toBe(true)
  })

  it('each page entry contains pageId, pageName, score, findings array', async () => {
    const { handler } = setupHandler()
    const result = await callTool(handler, 'design_lint')
    const page = result.json!.pages[0]
    expect(typeof page.pageId).toBe('string')
    expect(typeof page.pageName).toBe('string')
    expect(typeof page.score).toBe('number')
    expect(Array.isArray(page.findings)).toBe(true)
  })

  it('each finding contains rule, severity, elementIds, message', async () => {
    // Force at least one finding via contrast
    const errText = makeText({ fill: '#ffffff', fontSize: 16, x: 200, y: 200 })
    const page = makePage({ background: '#ffffff', elements: [errText] })
    const doc = makeDoc(page)
    const { handler } = setupHandler(doc)
    const result = await callTool(handler, 'design_lint')
    const finding = result.json!.pages[0].findings[0]
    expect(typeof finding.rule).toBe('string')
    expect(['error', 'warning']).toContain(finding.severity)
    expect(Array.isArray(finding.elementIds)).toBe(true)
    expect(typeof finding.message).toBe('string')
    expect(finding.message.length).toBeGreaterThan(20)
  })
})

// ---------------------------------------------------------------------------
// Rule: text-overflow-band (ERROR)
// ---------------------------------------------------------------------------

describe('rule: text-overflow-band', () => {
  it('POSITIVE — text whose wrapped AABB bottom exceeds its containing band is flagged', () => {
    // Reproduces the email-header-600 root cause: a headline in a 200px tall
    // band whose wrap-aware height exceeds the band. The band rect is 150px tall
    // and the text at 36px in a 272px column wraps to 2 visual lines (86px)
    // which fits, but at 72px in the same column wraps to 4 lines (346px > 150px).
    const band = makeRect({ id: 'band', x: 0, y: 0, width: 400, height: 150, fill: '#ffffff', opacity: 1 })
    // Text at 72px in 272px width: charWidth ≈ 72*0.52 = 37.4px, charsPerLine ≈ 7.3
    // "Your Headline Goes Here" = 23 chars → ceil(23/7.3) = 4 lines → h = 4*72*1.2 = 345.6px > 150px
    const headline = makeText({
      id: 'headline', name: 'Headline',
      x: 50, y: 50, width: 272,
      text: 'Your Headline Goes Here',
      fontSize: 72, lineHeight: 1.2, letterSpacing: 0,
    })
    const page = makePage({ width: 600, height: 200, elements: [band, headline] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overflow-band')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.elementIds).toContain('headline')
    expect(findings[0]!.elementIds).toContain('band')
    expect(findings[0]!.message).toMatch(/exceeds its containing band/)
  })

  it('NEGATIVE — text that fits within its band produces no finding', () => {
    // Same band at 36px fontSize: charsPerLine ≈ 272/(36*0.52) ≈ 14.5
    // "Your Headline Goes Here" = 23 chars → 2 lines → h = 2*36*1.2 = 86.4px < 150px
    const band = makeRect({ id: 'band', x: 0, y: 0, width: 400, height: 150, fill: '#ffffff', opacity: 1 })
    const headline = makeText({
      id: 'headline', name: 'Headline',
      x: 50, y: 50, width: 272,
      text: 'Your Headline Goes Here',
      fontSize: 36, lineHeight: 1.2, letterSpacing: 0,
    })
    const page = makePage({ width: 600, height: 200, elements: [band, headline] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overflow-band')
    expect(findings).toHaveLength(0)
  })

  it('POSITIVE — ig-story-style oversized hook text exceeds its accent block (Gap 1 regression)', () => {
    // Reproduces the ig-story "GET 20% OFF" case: hook at fontSize=180 with
    // letterSpacing=28 in a 904px column. charWidth = 180*0.52 + 28 = 121.6px
    // charsPerLine = 904/121.6 ≈ 7.4. "GET 20% OFF" = 11 chars → ceil(11/7.4) = 2 lines
    // height = 2 * 180 * 1.05 = 378px. Accent block is only 262px tall (1024 - 762).
    const accentBlock = makeRect({
      id: 'accent', name: 'Headline Accent Block',
      x: 88, y: 762, width: 904, height: 262, fill: '#ff6600', opacity: 1,
    })
    const hook = makeText({
      id: 'hook', name: 'Hook',
      x: 88, y: 762, width: 904,
      text: 'GET 20% OFF',
      fontSize: 180, lineHeight: 1.05, letterSpacing: 28,
    })
    const page = makePage({ width: 1080, height: 1920, elements: [accentBlock, hook] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overflow-band')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.elementIds).toContain('hook')
    expect(findings[0]!.elementIds).toContain('accent')
  })

  it('NEGATIVE — thin decorative rule is not treated as a containing band', () => {
    // A 4px-tall rule with height < fontSize is not a structural band.
    const thinRule = makeRect({ id: 'rule', x: 0, y: 0, width: 600, height: 4, fill: '#000000', opacity: 1 })
    const body = makeText({
      id: 'body', name: 'Body',
      x: 50, y: 20, width: 500,
      text: 'Some body text that would overflow the thin rule if it were treated as a band.',
      fontSize: 16, lineHeight: 1.5, letterSpacing: 0,
    })
    const page = makePage({ width: 600, height: 400, elements: [thinRule, body] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overflow-band')
    expect(findings).toHaveLength(0)
  })

  it('NEGATIVE — text below a closed band (not overlapping vertically) is not flagged', () => {
    // Band ends at y=100. Text starts at y=120. Band bottom < text top → not a container.
    const band = makeRect({ id: 'band', x: 0, y: 0, width: 400, height: 100, fill: '#ffffff', opacity: 1 })
    const body = makeText({
      id: 'body', name: 'Body',
      x: 50, y: 120, width: 300,
      text: 'Text starts well below the band.',
      fontSize: 16, lineHeight: 1.5, letterSpacing: 0,
    })
    const page = makePage({ elements: [band, body] })
    const doc = makeDoc(page)
    const report = lintScenePage(doc, page.id)
    const findings = report.pages[0]!.findings.filter((f) => f.rule === 'text-overflow-band')
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// estimateTextHeight — wrap-aware height computation
// ---------------------------------------------------------------------------

describe('estimateTextHeight (wrap-aware)', () => {
  it('single line of short text at wide width produces ~1 line height', () => {
    const el = makeText({ text: 'Hello', fontSize: 20, width: 500, lineHeight: 1.2, letterSpacing: 0 })
    // "Hello" = 5 chars; charsPerLine = 500/(20*0.52) ≈ 48 → 1 line → height = 1*20*1.2 = 24
    expect(estimateTextHeight(el)).toBe(24)
  })

  it('explicit newlines are counted as line breaks', () => {
    const el = makeText({ text: 'Line 1\nLine 2\nLine 3', fontSize: 16, width: 600, lineHeight: 1.2, letterSpacing: 0 })
    // 3 explicit lines, each short enough to fit in one visual line at width=600
    expect(estimateTextHeight(el)).toBe(3 * 16 * 1.2)
  })

  it('long text wraps at narrow width producing more lines than explicit breaks', () => {
    // 30-char text, fontSize=24, width=100: charWidth=24*0.52=12.48, charsPerLine≈8
    // ceil(30/8) = 4 lines → h = 4*24*1.2 = 115.2
    const el = makeText({ text: 'A'.repeat(30), fontSize: 24, width: 100, lineHeight: 1.2, letterSpacing: 0 })
    const h = estimateTextHeight(el)
    expect(h).toBeGreaterThan(24 * 1.2) // more than 1 line
    expect(h).toBeLessThanOrEqual(6 * 24 * 1.2) // no more than 6 lines
  })

  it('large letterSpacing increases effective char width, reducing chars per line', () => {
    const elNoSpacing = makeText({ text: 'GET 20% OFF', fontSize: 180, width: 904, lineHeight: 1.05, letterSpacing: 0 })
    const elWithSpacing = makeText({ text: 'GET 20% OFF', fontSize: 180, width: 904, lineHeight: 1.05, letterSpacing: 28 })
    // With letterSpacing=28 each char takes 180*0.52+28=121.6px vs 93.6px without
    // So letterSpacing version should produce more lines (taller height)
    expect(estimateTextHeight(elWithSpacing)).toBeGreaterThanOrEqual(estimateTextHeight(elNoSpacing))
  })
})

// ---------------------------------------------------------------------------
// MCP tool: create_export — lint gate
// ---------------------------------------------------------------------------

describe('MCP tool: create_export — lint gate', () => {
  it('is blocked when the document has lint errors', async () => {
    // White text on white background → contrast error (errorCount ≥ 1)
    const errText = makeText({ id: 'bad', fill: '#ffffff', fontSize: 16, x: 200, y: 200 })
    const page = makePage({ background: '#ffffff', elements: [errText] })
    const doc = makeDoc(page)
    const { handler } = setupHandler(doc)
    const result = await callTool(handler, 'create_export', { format: 'png' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Export blocked/)
    expect(result.text).toMatch(/lint error/)
  })

  it('succeeds when the document has no lint errors', async () => {
    // Clean document: no elements that would trigger errors
    const safeText = makeText({ id: 'ok', fill: '#000000', fontSize: 16, x: 200, y: 200, width: 200 })
    const page = makePage({ background: '#ffffff', elements: [safeText] })
    const doc = makeDoc(page)
    const { handler } = setupHandler(doc)
    const result = await callTool(handler, 'create_export', { format: 'png' })
    expect(result.isError).toBe(false)
    expect(result.json!.format).toBe('png')
    expect(result.json!.status).toBe('queued')
  })

  it('error message includes the specific lint error details', async () => {
    const errText = makeText({ id: 'bad', fill: '#ffffff', fontSize: 16, x: 200, y: 200 })
    const page = makePage({ background: '#ffffff', elements: [errText] })
    const doc = makeDoc(page)
    const { handler } = setupHandler(doc)
    const result = await callTool(handler, 'create_export', { format: 'json' })
    expect(result.isError).toBe(true)
    // Message should contain the concrete lint error (contrast rule info)
    expect(result.text).toMatch(/contrast/)
  })
})
