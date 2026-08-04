/**
 * A failure the reader never learns about renders as an empty screen, which
 * they believe. The precision half of these tests is the important half: the
 * dominant `.catch` in this fleet is a JSON-parse fallback, and reporting those
 * would bury the ones that hide a network failure.
 */
import { describe, expect, it } from 'vitest'
import { buildScannedFile } from '../scan'
import { checkSilentFailure } from './silent-failure'

const run = (source: string, options = {}) => checkSilentFailure(buildScannedFile('/app/panel.tsx', source), options)

describe('silent failure — reported', () => {
  it('reports a catch that swallows the failure entirely', () => {
    const findings = run(`
      const load = async () => {
        try {
          const res = await fetch('/api/filings')
          setRows(await res.json())
        } catch {}
      }
    `)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('swallows the failure entirely')
  })

  it('reports a catch that only clears the loading flag', () => {
    const findings = run(`
      const load = async () => {
        try {
          const res = await fetch('/api/filings')
          setRows(await res.json())
        } catch (err) {
          setLoading(false)
        }
      }
    `)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.remedy).toContain('rethrow')
  })

  it('reports a catch that returns empty data — the shape that renders as "nothing here"', () => {
    expect(run(`async function list() { try { return await fetch(url).then((r) => r.json()) } catch { return [] } }`)).toHaveLength(1)
  })

  it('does not accept a console line as telling the reader anything', () => {
    const findings = run(`
      const upload = async () => {
        try { await fetch('/api/upload', { method: 'POST' }) }
        catch (error) { console.error('[upload] Failed:', error) }
      }
    `)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.remedy).toContain('console')
  })

  it('reports a .catch that discards a request failure', () => {
    expect(run(`const rows = await fetch('/api/rows').then((r) => r.json()).catch(() => null)`)).toHaveLength(1)
  })
})

describe('silent failure — silence', () => {
  it.each([
    ['an error state is set', 'catch (err) { setError(String(err)) }'],
    ['a toast is shown', "catch { toast.error('Could not load filings') }"],
    ['it rethrows', 'catch (err) { throw err }'],
    ['a failure value is returned', "catch (err) { return failOutcome(`load failed: ${err}`) }"],
    ['the error is carried outward', 'catch (err) { return { error: err } }'],
    ['the error goes to a product sink', 'catch (err) { reportToBanner(err) }'],
  ])('passes when %s', (_label, handler) => {
    expect(run(`const load = async () => { try { await fetch('/api/filings') } ${handler} }`)).toEqual([])
  })

  it('ignores a try block that does no I/O — a parse fallback is not a hidden failure', () => {
    expect(run(`function parse(raw: string) { try { return JSON.parse(raw) } catch { return {} } }`)).toEqual([])
  })

  it('ignores a body-parse fallback on a response whose status the caller already read', () => {
    expect(
      run(`
      const save = async () => {
        const res = await fetch('/api/settings', { method: 'PUT' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) setError(body.message ?? 'Could not save')
      }
    `),
    ).toEqual([])
  })

  it('ignores a .catch that hands the failure to a named handler', () => {
    expect(run(`fetch('/api/rows').then(setRows).catch(handleLoadFailure)`)).toEqual([])
  })

  it('takes a product-specific sink whose name says nothing about failure', () => {
    const source = `const load = async () => { try { await fetch('/api/x') } catch { flashChip() } }`
    expect(run(source)).toHaveLength(1)
    expect(run(source, { extraErrorSinks: ['flashChip'] })).toEqual([])
  })

  it('never matches a catch written inside a string', () => {
    expect(run(`const sample = "try { go() } catch { }"`)).toEqual([])
  })
})
