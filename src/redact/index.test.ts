import { describe, expect, it, vi } from 'vitest'
import {
  redactForIngestion,
  detectSpans,
  maskSpans,
  buildRedactedDocument,
  revealSpan,
  type RedactionPattern,
} from './index'

// Reversible fake crypto for the document tests (NOT real crypto — base64 so it
// actually obscures the plaintext, like a real cipher would, and round-trips).
const enc = (s: string) => btoa(s)
const dec = (c: string) => atob(c)
const CARD: RedactionPattern = { kind: 'credit-card', pattern: /\d{4}-\d{4}-\d{4}-\d{4}/ }

// A Luhn-validated card candidate (13–19 digits, optional separators) — the
// shape tax-agent uses, exercising the `validate` predicate seam.
const luhn = (s: string): boolean => {
  const d = s.replace(/[^0-9]/g, '')
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}
const LUHN_CARD: RedactionPattern = { kind: 'cc', pattern: /\b(?:\d[ -]?){13,19}\b/, validate: luhn }

describe('redactForIngestion (one-way) — unchanged behavior', () => {
  it('scrubs SSN/EIN strings + sensitive object keys, recurses, passes through the rest', () => {
    expect(redactForIngestion('123-45-6789')).toBe('[REDACTED:ssn]')
    expect(redactForIngestion('12-3456789')).toBe('[REDACTED:ein]')
    expect(redactForIngestion('hello')).toBe('hello')
    expect(redactForIngestion(42)).toBe(42)
    expect(redactForIngestion({ email: 'a@b.com', note: 'ok', n: 1 })).toEqual({
      email: '[REDACTED:field]',
      note: 'ok',
      n: 1,
    })
    expect(redactForIngestion({ nested: ['123-45-6789', 'fine'] })).toEqual({
      nested: ['[REDACTED:ssn]', 'fine'],
    })
  })

  it('extraPatterns extends the scrub without forking (the de-fork seam)', () => {
    expect(redactForIngestion('4111-1111-1111-1111')).toBe('4111-1111-1111-1111') // not a default pattern
    expect(redactForIngestion('4111-1111-1111-1111', { extraPatterns: [CARD] })).toBe('[REDACTED:credit-card]')
  })

  it('validate predicate fires only on matches that pass (Luhn card) — tax-agent contract', () => {
    const opts = { extraPatterns: [LUHN_CARD] }
    // Luhn-valid Visa test number, dashed and spaced → collapses.
    expect(redactForIngestion('Card: 4111-1111-1111-1111', opts)).toBe('[REDACTED:cc]')
    expect(redactForIngestion('Card: 4111 1111 1111 1111 expiry...', opts)).toBe('[REDACTED:cc]')
    // 16-digit Luhn-INVALID sequence must pass through (no false positive).
    expect(redactForIngestion('orderId: 1234567890123456', opts)).toBe('orderId: 1234567890123456')
  })

  it('extraSensitiveKeys adds key names the defaults miss (snake_case api_key)', () => {
    expect(
      redactForIngestion(
        { api_key: 'sk-snake', apiKey: 'sk-camel', safe: 'kept' },
        { extraSensitiveKeys: ['api_key'] },
      ),
    ).toEqual({ api_key: '[REDACTED:field]', apiKey: '[REDACTED:field]', safe: 'kept' })
  })

  it("stringMode 'mask-spans' preserves surrounding text (analyst-loop path)", () => {
    // Default collapses the whole string; mask-spans replaces only the match.
    expect(redactForIngestion('ssn 123-45-6789 on file')).toBe('[REDACTED:ssn]')
    expect(redactForIngestion('ssn 123-45-6789 on file', { stringMode: 'mask-spans' })).toBe(
      'ssn [REDACTED:ssn] on file',
    )
    // Two spans of different kinds in one string, both masked in place.
    expect(
      redactForIngestion('ssn 123-45-6789 ein 12-3456789 end', { stringMode: 'mask-spans' }),
    ).toBe('ssn [REDACTED:ssn] ein [REDACTED:ein] end')
  })

  it('does not infinite-loop on a circular reference (cycle guard)', () => {
    const node: Record<string, unknown> = { ssn: '123-45-6789', note: 'keep' }
    node.self = node // cycle
    const out = redactForIngestion(node) as Record<string, unknown>
    expect(out.ssn).toBe('[REDACTED:field]') // sensitive key
    expect(out.note).toBe('keep')
    expect(out.self).toBeDefined() // cycle broken, did not throw/hang
  })
})

describe('maskSpans (standalone substring masking)', () => {
  it('replaces each PII span in place, leaves the rest', () => {
    expect(maskSpans('call 123-45-6789 now')).toBe('call [REDACTED:ssn] now')
    expect(maskSpans('nothing here')).toBe('nothing here')
  })

  it('honors a validate predicate (Luhn card, substring)', () => {
    // The LUHN_CARD pattern's trailing `[ -]?` greedily consumes the separator
    // after the last digit, so the matched span includes the following space —
    // maskSpans replaces exactly what detectSpans matched.
    expect(maskSpans('card 4111 1111 1111 1111 ok', [LUHN_CARD])).toBe('card [REDACTED:cc]ok')
    // Luhn-invalid → not matched → untouched.
    expect(maskSpans('order 1234567890123456 ok', [LUHN_CARD])).toBe('order 1234567890123456 ok')
  })
})

describe('detectSpans', () => {
  it('finds non-overlapping spans with offsets, sorted', () => {
    const text = 'ssn 123-45-6789 and ein 12-3456789 end'
    const spans = detectSpans(text)
    expect(spans.map((s) => [s.kind, s.text])).toEqual([
      ['ssn', '123-45-6789'],
      ['ein', '12-3456789'],
    ])
    // offsets round-trip
    for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.text)
    // stable ids
    expect(spans.map((s) => s.id)).toEqual(['span-0', 'span-1'])
  })

  it('accepts extra patterns', () => {
    const spans = detectSpans('pay 4111-1111-1111-1111 now', [CARD])
    expect(spans).toHaveLength(1)
    expect(spans[0]!.kind).toBe('credit-card')
  })

  it('skips matches that fail a validate predicate (Luhn)', () => {
    expect(detectSpans('pay 4111 1111 1111 1111 now', [LUHN_CARD])).toHaveLength(1)
    expect(detectSpans('order 1234567890123456 here', [LUHN_CARD])).toHaveLength(0)
  })
})

describe('buildRedactedDocument', () => {
  it('splits into text + redacted segments, encrypts originals, leaks no plaintext PII', async () => {
    const text = 'client 123-45-6789 owes'
    const doc = await buildRedactedDocument(text, { encrypt: enc })
    expect(doc.segments).toEqual([
      { type: 'text', text: 'client ' },
      { type: 'redacted', id: 'span-0', kind: 'ssn', cipher: btoa('123-45-6789') },
      { type: 'text', text: ' owes' },
    ])
    // the serialized doc carries NO plaintext SSN
    expect(JSON.stringify(doc)).not.toContain('123-45-6789')
  })

  it('handles a span at the start and adjacent spans', async () => {
    const doc = await buildRedactedDocument('123-45-6789 12-3456789', { encrypt: enc })
    expect(doc.segments.map((s) => s.type)).toEqual(['redacted', 'text', 'redacted'])
  })
})

describe('revealSpan — gated + audited', () => {
  const docOf = async () => buildRedactedDocument('x 123-45-6789 y', { encrypt: enc })

  it('grants → decrypts + fires the audit hook', async () => {
    const doc = await docOf()
    const onReveal = vi.fn()
    const r = await revealSpan(doc, 'span-0', { decrypt: dec, canReveal: () => true, onReveal })
    expect(r).toEqual({ ok: true, value: '123-45-6789' })
    expect(onReveal).toHaveBeenCalledWith({ id: 'span-0', kind: 'ssn' })
  })

  it('denies (fail-closed) → never decrypts, never audits', async () => {
    const doc = await docOf()
    const decrypt = vi.fn(dec)
    const onReveal = vi.fn()
    const r = await revealSpan(doc, 'span-0', { decrypt, canReveal: () => false, onReveal })
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
    expect(decrypt).not.toHaveBeenCalled()
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('unknown span id → not_found', async () => {
    const doc = await docOf()
    expect(await revealSpan(doc, 'nope', { decrypt: dec, canReveal: () => true })).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })
})
