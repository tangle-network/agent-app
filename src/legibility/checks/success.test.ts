/**
 * "Saved" over a 404. The fixtures below are the two production handlers this
 * check found, reduced: a tax settings page that awaits a PUT and sets
 * `saved`, and a legal approvals screen that awaits a PATCH and toasts
 * "Approved" — neither reads the response.
 */
import { describe, expect, it } from 'vitest'
import { buildScannedFile } from '../scan'
import { checkUncheckedSuccess } from './success'

const run = (source: string, options = {}) =>
  checkUncheckedSuccess(buildScannedFile('/app/settings.tsx', source), options)

describe('success reported without reading the response', () => {
  it('reports a save handler that awaits a request and then says Saved', () => {
    const findings = run(`
      const handleSave = async () => {
        setSaving(true)
        try {
          await fetch('/api/settings', { method: 'PUT', body: JSON.stringify(settings) })
          setSaved(true)
        } catch (err) {
          console.warn('[settings] save failed:', err)
        }
        setSaving(false)
      }
    `)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('setSaved')
    expect(findings[0]?.message).toContain('404')
    expect(findings[0]?.remedy).toContain('res.ok')
  })

  it('reports a toast.success on an unchecked mutation', () => {
    const findings = run(`
      const executeAction = async (id: string, status: string) => {
        await fetch('/api/approvals', { method: 'PATCH', body: JSON.stringify({ id, status }) })
        toast.success(status === 'approved' ? 'Approved' : 'Rejected')
      }
    `)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('toast.success')
  })

  it('passes when the response is inspected', () => {
    expect(
      run(`
      const save = async () => {
        const res = await fetch('/api/settings', { method: 'PUT' })
        if (res.ok) toast.success('Settings saved')
        else toast.error('Could not save')
      }
    `),
    ).toEqual([])
  })

  it.each([
    ['a destructured ok', 'const { ok } = await fetch(url); if (ok) setSaved(true)'],
    ['a status read', 'const res = await fetch(url); if (res.status === 200) setSaved(true)'],
    ['a then-guard', "fetch(url).then((r) => { if (!r.ok) throw new Error('failed'); setSaved(true) })"],
  ])('passes on %s', (_label, body) => {
    expect(run(`const save = async () => { ${body} }`)).toEqual([])
  })

  it('passes when a product guard throws on a bad status', () => {
    const source = `const save = async () => { const res = await fetch(url); assertOk(res); setSaved(true) }`
    expect(run(source)).toHaveLength(1)
    expect(run(source, { okGuards: ['assertOk'] })).toEqual([])
  })

  it('reports success declared before the request has settled', () => {
    const findings = run(`const save = () => { fetch('/api/settings', { method: 'PUT' }); setSubmitted(true) }`)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('before')
    expect(findings[0]?.remedy).toContain('Await the request')
  })

  it('does not join a request in one handler to a success in another', () => {
    // Neither handler inspects anything, so only the SCOPE keeps this quiet:
    // widen it to the file and the loader's fetch pairs with the other
    // handler's setSaved, reporting a defect that is not there.
    expect(
      run(`
      const load = async () => { const rows = await fetch('/api/settings'); setRows(rows) }
      const markDone = () => { setSaved(true) }
    `),
    ).toEqual([])
  })

  it('says nothing about a request with no success signal at all', () => {
    expect(run(`const load = async () => { const data = await fetch('/api/settings'); setRows(data) }`)).toEqual([])
  })

  it('does not treat a status setter as success unless the status says so', () => {
    expect(run(`const save = async () => { await fetch(url, { method: 'PUT' }); setStatus('pending') }`)).toEqual([])
    expect(run(`const save = async () => { await fetch(url, { method: 'PUT' }); setStatus('saved') }`)).toHaveLength(1)
  })

  it('takes a product own success signal', () => {
    const source = `const save = async () => { await fetch(url, { method: 'PUT' }); flashOk('Filed') }`
    expect(run(source)).toEqual([])
    expect(run(source, { extraSuccessSignals: ['flashOk'] })).toHaveLength(1)
  })

  it('only reads calls the product declares as HTTP', () => {
    const source = `const save = async () => { await api.put('/settings', body); setSaved(true) }`
    expect(run(source)).toEqual([])
    expect(run(source, { httpCalls: ['api.put'] })).toHaveLength(1)
  })
})
