/**
 * Suppression is the reason this gate can survive contact with a deadline. The
 * rule under test: a suppression WITHOUT a written reason suppresses nothing
 * and is itself reported — otherwise "silence the line" and "delete the check"
 * become the same act, six months apart, with no record of either.
 */
import { describe, expect, it } from 'vitest'
import { buildScannedFile } from './scan'
import { buildSuppressionIndex } from './suppress'

const index = (source: string) => buildSuppressionIndex(buildScannedFile('/app/screen.tsx', source))

describe('suppression directives', () => {
  it('honours a reasoned directive on the following line', () => {
    const source = [
      '// legibility-ignore engineering-vocabulary — "conflict" is the term of art a litigator uses',
      'export const P = () => <p>Conflict check cleared</p>',
    ].join('\n')
    expect(index(source).reasonFor('engineering-vocabulary', 2)).toContain('term of art')
  })

  it('honours a trailing directive on its own line', () => {
    const source = 'export const P = () => <p>Conflict</p> // legibility-ignore engineering-vocabulary: the docket calls it a conflict'
    expect(index(source).reasonFor('engineering-vocabulary', 1)).toContain('docket')
  })

  it('governs one line, not the rest of the file', () => {
    const source = [
      '// legibility-ignore engineering-vocabulary — this heading is the schema browser',
      'export const A = () => <h1>sourceKind</h1>',
      'const gap = 1',
      'export const B = () => <p>No artifact yet</p>',
    ].join('\n')
    const built = index(source)
    expect(built.reasonFor('engineering-vocabulary', 2)).toContain('schema browser')
    expect(built.reasonFor('engineering-vocabulary', 4)).toBeNull()
  })

  it('does not suppress a check the directive did not name', () => {
    const source = ['// legibility-ignore silent-failure — the retry timer already tells the reader', 'const x = 1'].join(
      '\n',
    )
    expect(index(source).reasonFor('engineering-vocabulary', 2)).toBeNull()
  })

  it('suppresses a whole file when asked, and says so', () => {
    const source = ['/* legibility-ignore-file dead-end-empty-state — this is a print stylesheet preview */', 'const x = 1'].join('\n')
    const built = index(source)
    expect(built.reasonFor('dead-end-empty-state', 99)).toContain('print stylesheet')
    expect(built.selfFindings).toEqual([])
  })

  it('accepts several checks in one directive', () => {
    const source = [
      '// legibility-ignore engineering-vocabulary, silent-failure — vendor snippet we cannot edit',
      'const x = 1',
    ].join('\n')
    const built = index(source)
    expect(built.reasonFor('engineering-vocabulary', 2)).toContain('vendor')
    expect(built.reasonFor('silent-failure', 2)).toContain('vendor')
  })

  it('works from a JSX comment, where a component author actually writes', () => {
    const source = [
      'export const P = () => (',
      '  <div>',
      '    {/* legibility-ignore engineering-vocabulary — the schema column is literally named this */}',
      '    <th>sourceKind</th>',
      '  </div>',
      ')',
    ].join('\n')
    expect(index(source).reasonFor('engineering-vocabulary', 4)).toContain('schema column')
  })
})

describe('suppressions that suppress nothing', () => {
  it('reports a directive with no reason, and does not honour it', () => {
    const source = ['// legibility-ignore engineering-vocabulary', 'export const P = () => <p>No artifact</p>'].join('\n')
    const built = index(source)
    expect(built.reasonFor('engineering-vocabulary', 2)).toBeNull()
    expect(built.selfFindings).toHaveLength(1)
    expect(built.selfFindings[0]?.check).toBe('suppression-without-reason')
    expect(built.selfFindings[0]?.message).toContain('gives no reason')
  })

  it('reports a reason too short to be one', () => {
    const source = ['// legibility-ignore silent-failure — ok', 'const x = 1'].join('\n')
    const built = index(source)
    expect(built.reasonFor('silent-failure', 2)).toBeNull()
    expect(built.selfFindings).toHaveLength(1)
  })

  it('reports a directive naming a check that does not exist', () => {
    const source = ['// legibility-ignore vocabulary — the check is called something else entirely', 'const x = 1'].join(
      '\n',
    )
    const built = index(source)
    expect(built.selfFindings[0]?.message).toContain('is not a check')
    expect(built.selfFindings[0]?.remedy).toContain('engineering-vocabulary')
  })

  it('reports a directive that names nothing at all', () => {
    const built = index(['// legibility-ignore — this whole file is fine, trust me', 'const x = 1'].join('\n'))
    expect(built.selfFindings[0]?.message).toContain('names no check')
  })
})
