/**
 * The vocabulary check's whole value is what it does NOT report. A gate that
 * flags an import specifier gets deleted, and then the copy defect ships
 * anyway — so most of these tests assert silence on code that merely contains
 * the word.
 */
import { describe, expect, it } from 'vitest'
import { buildScannedFile } from '../scan'
import { checkVocabulary } from './vocabulary'

const run = (source: string, options = {}) => checkVocabulary(buildScannedFile('/app/screen.tsx', source), options)

describe('engineering vocabulary — what reaches the reader', () => {
  it('reports a banned word in rendered JSX text', () => {
    const findings = run('export const P = () => <p>No artifact yet</p>')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('"artifact"')
    expect(findings[0]?.message).toContain('rendered text')
    expect(findings[0]?.remedy).toContain('name the deliverable')
  })

  it('reports a banned word in a copy attribute', () => {
    const findings = run('export const P = () => <Field label="Workspace name" />')
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('"Workspace" is a word from the codebase, on screen in the label attribute.'),
    ])
  })

  it('reports the flagship defect: an engineering word inside a thrown error', () => {
    const findings = run("if (!ok) throw new Error('Attachment materialization failed')")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('Error(…)')
  })

  it('points at the word, not the start of the file', () => {
    const source = 'const a = 1\nconst b = 2\nexport const P = () => <p>The record is ready</p>'
    const file = buildScannedFile('/app/screen.tsx', source)
    const finding = checkVocabulary(file)[0]
    expect(finding).toBeDefined()
    expect(file.positionAt(finding?.offset ?? 0).line).toBe(3)
  })
})

describe('engineering vocabulary — silence on code', () => {
  it.each([
    ['an import specifier', "import { artifactDocument } from '@/lib/work-product-document'"],
    ['an identifier', 'const artifactLabel = record.artifact'],
    ['a line comment', '// the artifact row is superseded by the newer version'],
    ['a block comment', '/** returns the workspace record payload */'],
    ['an aria attribute', 'export const P = () => <div aria-label="artifact list" />'],
    ['a class name', 'export const P = () => <div className="record-row" />'],
    ['a test id', 'export const P = () => <div data-testid="workspace-panel" />'],
    ['an href', 'export const P = () => <a href="/workspace/records">Home</a>'],
    ['a bare string in code', "const key = 'sourceKind'"],
    ['a type', 'type Payload = { record: string }'],
  ])('does not report %s', (_label, source) => {
    expect(run(source)).toEqual([])
  })

  it('does not read an object key by default, because that tier is prompts and catalogues', () => {
    const source = "export const profile = { prompt: 'Cite every fact you rely on', description: 'the workspace goal' }"
    expect(run(source)).toEqual([])
  })

  it('reads object keys when the product opts in', () => {
    const source = "export const empty = { description: 'No records found' }"
    expect(run(source, { includeObjectCopy: true }).map((f) => f.message)).toEqual([
      expect.stringContaining('the description value'),
    ])
  })
})

describe('engineering vocabulary — the list is a product parameter', () => {
  it('drops a term the product legitimately uses', () => {
    const source = 'export const P = () => <p>Conflict check cleared</p>'
    expect(run(source)).toHaveLength(1)
    expect(run(source, { allowTerms: ['conflict'] })).toEqual([])
  })

  it('adds a product term with its own replacement', () => {
    const findings = run('export const P = () => <p>Reconciliation pending</p>', {
      extraTerms: [{ term: 'reconciliation', instead: '"we are checking your numbers"' }],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.remedy).toContain('we are checking your numbers')
  })

  it('matches a two-word term across a wrapped line of JSX', () => {
    const findings = run('export const P = () => (\n  <p>\n    Your work\n    product is ready\n  </p>\n)')
    expect(findings.map((f) => f.message)).toEqual([expect.stringContaining('work\n    product')])
  })
})
