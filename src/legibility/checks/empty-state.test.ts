/**
 * The 11-of-21 defect. The hard part is scope: the check must look inside the
 * empty BRANCH, not the page — a page always has some button somewhere, and a
 * checker that finds it reports nothing forever.
 */
import { describe, expect, it } from 'vitest'
import { buildScannedFile } from '../scan'
import { checkEmptyStates } from './empty-state'

const run = (source: string, options = {}) => checkEmptyStates(buildScannedFile('/app/screen.tsx', source), options)

const page = (branch: string): string => `
export function Page({ rows }: { rows: Row[] }) {
  return (
    <main>
      <button onClick={openHelp}>Help</button>
      {rows.map((row) => <Row key={row.id} />)}
      {rows.length === 0 && (
${branch}
      )}
    </main>
  )
}
`

describe('dead-end empty states', () => {
  it('reports an empty branch whose subtree offers nothing to do', () => {
    const findings = run(page('        <div className="empty">\n          <p>No deadlines tracked yet</p>\n        </div>'))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('No deadlines tracked yet')
    expect(findings[0]?.remedy).toContain('button')
  })

  it('does not count a button OUTSIDE the empty branch as the next action', () => {
    // The page's Help button sits in <main>, one container up. If the scope
    // walked to the page root this test would report nothing.
    const findings = run(page('        <div className="empty"><p>No filings</p></div>'))
    expect(findings).toHaveLength(1)
  })

  it.each([
    ['a button', '<div><p>No filings yet</p><button onClick={create}>Add a filing</button></div>'],
    ['a link', '<div><p>No filings yet</p><Link to="/new">Start one</Link></div>'],
    ['an anchor', '<div><p>No filings yet</p><a href="/new">Start one</a></div>'],
    ['a form control', '<div><p>No filings yet</p><input onChange={onPick} /></div>'],
    ['a renamed component', '<div><p>No filings yet</p><PrimaryCta>Upload</PrimaryCta></div>'],
  ])('passes when the branch contains %s', (_label, branch) => {
    expect(run(page(`        ${branch}`))).toEqual([])
  })

  it('reads empty copy handed to a component as a prop', () => {
    const findings = run('export const P = () => <List emptyTitle="No conversations yet" />')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('via emptyTitle')
  })

  it('passes when that same component also takes the next action as a prop', () => {
    // Measured false positive: the panel ships a "New chat" button, handed in
    // as `newSessionHref`, which an exact-name prop list did not recognise.
    expect(run('export const P = () => <List emptyTitle="No conversations yet" newSessionHref="/chat/new" />')).toEqual(
      [],
    )
  })

  it('ignores prose that merely contains "no"', () => {
    expect(run(page('        <div><p>There is no charge for this review</p></div>'))).toEqual([])
  })

  it('takes extra empty-copy patterns from the product', () => {
    const source = page('        <div><p>Nichts gefunden</p></div>')
    expect(run(source)).toEqual([])
    expect(run(source, { extraEmptyPatterns: ['^nichts\\b'] })).toHaveLength(1)
  })
})
