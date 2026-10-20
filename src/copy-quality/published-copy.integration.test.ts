import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scanCopy, type CopyTellCategory } from './index'

// Frozen campaign excerpts, with source/date/provenance per row. No model-written controls.
const published = JSON.parse(readFileSync(new URL('./fixtures/published.json', import.meta.url), 'utf8')) as Array<{ id: string; text: string }>
const audited = JSON.parse(readFileSync(new URL('./fixtures/audited.json', import.meta.url), 'utf8')) as Array<{ id: string; text: string }>
const expansions: CopyTellCategory[] = ['colon-reveal', 'contrast-reveal', 'opener-closer']
const findings = (text: string) => scanCopy(text, { surface: 'short' }).findings

// The same copy-quality entrypoint consumed by GTM and other applications, with actual campaign copy.
describe('structural copy checks on published and audited campaigns', () => {
  it('catches the audited reveals, contrasts and permission closers', () => {
    const expected: Array<[string, CopyTellCategory]> = [
      ['linkedin-sandbox', 'colon-reveal'], ['linkedin-agent-builder', 'colon-reveal'],
      ['linkedin-router', 'contrast-reveal'], ['linkedin-gtm-agent', 'contrast-reveal'],
      ['email-1', 'opener-closer'], ['email-2', 'opener-closer'],
      ['email-4', 'opener-closer'], ['email-5', 'opener-closer'],
    ]
    for (const [id, category] of expected) {
      const row = audited.find((row) => row.id === id)!
      expect(findings(row.text).some((finding) => finding.category === category), `${id}: ${category}`).toBe(true)
    }
  })

  it('keeps each expanded category at five percent or less on published human copy', () => {
    expect(published.length).toBe(106)
    for (const category of expansions) {
      const hits = published.filter((row) => findings(row.text).some((finding) => finding.category === category))
      expect(hits.length / published.length, `${category}: ${hits.map((row) => row.id).join(', ')}`).toBeLessThanOrEqual(0.05)
    }
  })
})
