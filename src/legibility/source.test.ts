import { describe, expect, it } from 'vitest'
import { elementAt, enclosingBlock, lineIndex, positionAt, scanSource } from './source'

/**
 * The scanner is the precision floor for every check above it: if it cannot
 * tell copy from code, every check inherits the false positives that get a lint
 * gate switched off. So these tests are mostly about what it must NOT report.
 */
describe('scanSource — copy vs code', () => {
  it('reports JSX text as copy and identifiers/imports/comments as code', () => {
    const scan = scanSource(`
import { artifactDocument } from '@/lib/work-product-document'
// the artifact row is superseded by the newer version
const artifactLabel = record.artifact
export const Panel = () => <p title="Saved">No artifact yet</p>
`)
    const visible = scan.segments.filter((s) => s.kind === 'jsx-text' || s.kind === 'jsx-attribute')
    expect(visible.map((s) => s.value.trim())).toEqual(['Saved', 'No artifact yet'])
    expect(visible.find((s) => s.kind === 'jsx-attribute')?.attribute).toBe('title')
  })

  it('does not mistake a comparison or a type argument for JSX', () => {
    const scan = scanSource(`
const [items, setItems] = useState<string[]>([])
const isLate = daysLeft < threshold && other > 1
`)
    expect(scan.elements).toEqual([])
  })

  it('keeps a template literal chunk, and names the attribute it fills', () => {
    const scan = scanSource('const El = () => <Row title={`No records for ${year}`} />')
    const tpl = scan.segments.find((s) => s.kind === 'template')
    expect(tpl?.value).toBe('No records for ')
    expect(tpl?.attribute).toBe('title')
  })

  it('carries the attribute across every chunk, including the ones after a hole', () => {
    // Resolving the attribute per chunk sees only the one next to `title=`,
    // so the half of the copy that follows the interpolation reads as code.
    const scan = scanSource('const El = () => <Row title={`${count} filings, 0 records found`} />')
    const chunks = scan.segments.filter((s) => s.kind === 'template')
    expect(chunks.map((c) => c.value)).toEqual([' filings, 0 records found'])
    expect(chunks.map((c) => c.attribute)).toEqual(['title'])
  })

  it('masks comments and string bodies so structural regexes cannot match inside them', () => {
    const scan = scanSource(`const sql = "catch { }"\n// catch { }\ntry { go() } catch { setError('x') }`)
    expect([...scan.masked.matchAll(/catch\s*\{/g)]).toHaveLength(1)
    expect(scan.masked.split('\n')).toHaveLength(3)
  })
})

describe('scanSource — element tree', () => {
  const source = `
export function Page({ rows }: { rows: Row[] }) {
  return (
    <main>
      {rows.map((r) => (
        <article key={r.id}>{r.title}</article>
      ))}
      {rows.length === 0 && (
        <div className="empty">
          <p>No deadlines tracked yet</p>
        </div>
      )}
    </main>
  )
}
`
  const scan = scanSource(source)

  it('nests children under the element that contains them', () => {
    const main = scan.elements.find((e) => e.tag === 'main')
    expect(main).toBeDefined()
    expect(main?.children.map((c) => c.tag).sort()).toEqual(['article', 'div'])
  })

  it('scopes a conditional branch by its expression container, not by the page', () => {
    const empty = scan.elements.find((e) => e.tag === 'div')
    const paragraph = scan.elements.find((e) => e.tag === 'p')
    const main = scan.elements.find((e) => e.tag === 'main')
    // The div and its p share one container; `main` sits outside every container.
    expect(empty?.containerStart).toBe(paragraph?.containerStart)
    expect(main?.containerStart).toBeNull()
    expect(empty?.containerStart).not.toBeNull()
  })

  it('gives each element a span that contains its own text', () => {
    const empty = scan.elements.find((e) => e.tag === 'div')
    expect(source.slice(empty?.start ?? 0, empty?.end ?? 0)).toContain('No deadlines tracked yet')
  })

  it('records attribute values and marks expression attributes as code', () => {
    const article = scan.elements.find((e) => e.tag === 'article')
    expect(article?.attributes[0]).toEqual({ name: 'key', start: expect.any(Number), value: null, expression: true })
    const div = scan.elements.find((e) => e.tag === 'div')
    expect(div?.attributes[0]?.value).toBe('empty')
  })

  it('finds the innermost element containing an offset', () => {
    const textOffset = source.indexOf('No deadlines')
    expect(elementAt(scan.elements, textOffset)?.tag).toBe('p')
  })
})

describe('offset helpers', () => {
  it('maps an offset to a 1-based line and column', () => {
    const text = 'a\nbb\nccc'
    const starts = lineIndex(text)
    expect(positionAt(starts, 0)).toEqual({ line: 1, column: 1 })
    expect(positionAt(starts, text.indexOf('ccc'))).toEqual({ line: 3, column: 1 })
  })

  it('returns the innermost block around an offset', () => {
    const masked = 'function f() { try { go() } catch { } }'
    const block = enclosingBlock(masked, masked.indexOf('go'))
    expect(masked.slice(block?.start ?? 0, block?.end ?? 0)).toBe('{ go() }')
  })
})
