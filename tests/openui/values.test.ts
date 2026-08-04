import { describe, expect, it } from 'vitest'

import {
  isOpenUIFieldKind,
  isSafeOpenUIFieldId,
  validateOpenUIFormValues,
  type OpenUIFormSpec,
} from '../../src/openui/index'

const FORM: OpenUIFormSpec = {
  id: 'deductions',
  fields: [
    { id: 'name', kind: 'text', required: true, maxLength: 10 },
    { id: 'amount', kind: 'currency', min: 0, max: 10_000 },
    { id: 'rate', kind: 'slider', min: 0, max: 1, step: 0.1 },
    { id: 'itemize', kind: 'checkbox' },
    { id: 'state', kind: 'select', options: [{ value: 'ny' }, { value: 'ca' }] },
    { id: 'tags', kind: 'select', multiple: true, options: [{ value: 'a' }, { value: 'b' }] },
  ],
}

describe('validateOpenUIFormValues', () => {
  it('accepts a well-formed submission and returns only declared fields', () => {
    const result = validateOpenUIFormValues(FORM, {
      name: 'Drew',
      amount: 1200.5,
      rate: 0.3,
      itemize: false,
      state: 'ny',
      tags: ['a', 'b'],
    })
    expect(result).toEqual({
      ok: true,
      values: { name: 'Drew', amount: 1200.5, rate: 0.3, itemize: false, state: 'ny', tags: ['a', 'b'] },
    })
  })

  it('rejects a value for a field the form never declared', () => {
    const result = validateOpenUIFormValues(FORM, { name: 'Drew', ssn: '123' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues).toContainEqual({
      fieldId: 'ssn',
      code: 'unknown_field',
      message: 'ssn is not a field on this form',
    })
  })

  it('rejects a missing required field', () => {
    const result = validateOpenUIFormValues(FORM, { amount: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues.map((i) => i.code)).toEqual(['required'])
  })

  it('treats a whitespace-only string as missing for a required field', () => {
    const result = validateOpenUIFormValues(FORM, { name: '   ' })
    expect(result.ok).toBe(false)
  })

  it('rejects a value of the wrong kind', () => {
    const result = validateOpenUIFormValues(FORM, { name: 'Drew', amount: '1200' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues).toContainEqual({ fieldId: 'amount', code: 'type', message: 'amount must be a number' })
  })

  it('enforces min and max', () => {
    const low = validateOpenUIFormValues(FORM, { name: 'Drew', amount: -1 })
    const high = validateOpenUIFormValues(FORM, { name: 'Drew', amount: 10_001 })
    expect(low.ok).toBe(false)
    expect(high.ok).toBe(false)
    if (low.ok || high.ok) throw new Error('expected rejection')
    expect(low.issues[0]?.code).toBe('range')
    expect(high.issues[0]?.code).toBe('range')
  })

  it('enforces step without tripping on float arithmetic', () => {
    expect(validateOpenUIFormValues(FORM, { name: 'Drew', rate: 0.3 }).ok).toBe(true)
    const offGrid = validateOpenUIFormValues(FORM, { name: 'Drew', rate: 0.35 })
    expect(offGrid.ok).toBe(false)
    if (offGrid.ok) throw new Error('expected rejection')
    expect(offGrid.issues[0]?.code).toBe('step')
  })

  it('rejects a choice the select does not offer', () => {
    const single = validateOpenUIFormValues(FORM, { name: 'Drew', state: 'tx' })
    const multi = validateOpenUIFormValues(FORM, { name: 'Drew', tags: ['a', 'z'] })
    expect(single.ok).toBe(false)
    expect(multi.ok).toBe(false)
    if (single.ok || multi.ok) throw new Error('expected rejection')
    expect(single.issues[0]).toEqual({ fieldId: 'state', code: 'option', message: 'state does not offer "tx"' })
    expect(multi.issues[0]?.code).toBe('option')
  })

  it('rejects a single-choice value sent as a list', () => {
    const result = validateOpenUIFormValues(FORM, { name: 'Drew', state: ['ny'] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues[0]?.code).toBe('type')
  })

  it('enforces maxLength on text', () => {
    const result = validateOpenUIFormValues(FORM, { name: 'a'.repeat(11) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues[0]?.code).toBe('length')
  })

  it('accepts false for a required checkbox but not an absent one', () => {
    const spec: OpenUIFormSpec = { id: 'f', fields: [{ id: 'agree', kind: 'checkbox', required: true }] }
    expect(validateOpenUIFormValues(spec, { agree: false })).toEqual({ ok: true, values: { agree: false } })
    expect(validateOpenUIFormValues(spec, {}).ok).toBe(false)
  })

  it('reports every bad field, not just the first', () => {
    const result = validateOpenUIFormValues(FORM, { amount: -5, state: 'tx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues.map((i) => i.fieldId).sort()).toEqual(['amount', 'name', 'state'])
  })

  it('rejects a form that declares an unusable field id', () => {
    const spec: OpenUIFormSpec = { id: 'f', fields: [{ id: '__proto__', kind: 'text' }] }
    const result = validateOpenUIFormValues(spec, {})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues[0]?.code).toBe('unsafe_field_id')
  })

  it('rejects a form that declares the same field twice', () => {
    const spec: OpenUIFormSpec = { id: 'f', fields: [{ id: 'a', kind: 'text' }, { id: 'a', kind: 'number' }] }
    const result = validateOpenUIFormValues(spec, {})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.issues[0]?.code).toBe('duplicate_field')
  })

  it('does not read inherited keys as submitted values', () => {
    const values = Object.create({ name: 'inherited' }) as Record<string, string>
    const result = validateOpenUIFormValues({ id: 'f', fields: [{ id: 'name', kind: 'text', required: true }] }, values)
    expect(result.ok).toBe(false)
  })
})

describe('field-id and kind guards', () => {
  it('accepts identifier-safe ids and refuses prototype keys', () => {
    expect(isSafeOpenUIFieldId('gross_income-1')).toBe(true)
    expect(isSafeOpenUIFieldId('has space')).toBe(false)
    expect(isSafeOpenUIFieldId('__proto__')).toBe(false)
    expect(isSafeOpenUIFieldId('constructor')).toBe(false)
    expect(isSafeOpenUIFieldId('prototype')).toBe(false)
  })

  it('names exactly the six input kinds', () => {
    for (const kind of ['text', 'number', 'currency', 'select', 'checkbox', 'slider']) {
      expect(isOpenUIFieldKind(kind)).toBe(true)
    }
    expect(isOpenUIFieldKind('heading')).toBe(false)
  })
})
