/**
 * The value half of an interactive OpenUI page: what a field holds, and whether
 * a submitted set of field values matches the form the agent authored.
 *
 * The NODE vocabulary (which fields exist, how they render) has one owner —
 * `@tangle-network/ui`'s `./openui` entry. This module does not restate it. It
 * declares the narrowest STRUCTURAL port a host needs to check a submission:
 * the field's id, its kind, and the constraints that make a value legal. A
 * renderer's richer node type satisfies this port by assignment, so the two
 * packages stay in step without either importing the other.
 */

/** A value one OpenUI field can hold. `string[]` is a multi-select. */
export type OpenUIValue = string | number | boolean | string[]

/** Submitted field values, keyed by field id. */
export type OpenUIFormValues = Record<string, OpenUIValue>

/**
 * Field ids the host will accept: identifier-safe, and never a key that would
 * reach `Object.prototype`. A submission arrives from a browser and is used to
 * index an object, so this is a boundary check, not a style rule.
 */
export function isSafeOpenUIFieldId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id !== '__proto__' && id !== 'constructor' && id !== 'prototype'
}

/** The input kinds a form field can be. */
export type OpenUIFieldKind = 'text' | 'number' | 'currency' | 'select' | 'checkbox' | 'slider'

const FIELD_KINDS: ReadonlySet<string> = new Set<OpenUIFieldKind>([
  'text',
  'number',
  'currency',
  'select',
  'checkbox',
  'slider',
])

/** Whether a string names an input kind this contract knows. */
export function isOpenUIFieldKind(kind: string): kind is OpenUIFieldKind {
  return FIELD_KINDS.has(kind)
}

/**
 * One field, reduced to what a value check needs. A renderer node carrying
 * labels, placeholders, and layout is assignable to this — the extra
 * presentation properties are simply not read here.
 */
export interface OpenUIFieldSpec {
  id: string
  kind: OpenUIFieldKind
  required?: boolean
  /** `number` / `currency` / `slider` bounds, inclusive. */
  min?: number
  max?: number
  /** Increment `number` / `currency` / `slider` values must land on, measured from `min ?? 0`. */
  step?: number
  /** Longest accepted `text` value. */
  maxLength?: number
  /** Accepted `select` values. */
  options?: ReadonlyArray<{ value: string }>
  /** A `select` that accepts more than one option; its value is a `string[]`. */
  multiple?: boolean
}

/** A form the host can check a submission against. */
export interface OpenUIFormSpec {
  id: string
  fields: readonly OpenUIFieldSpec[]
}

/** Why one field's value was rejected. */
export type OpenUIFieldIssueCode =
  | 'required'
  | 'type'
  | 'range'
  | 'step'
  | 'option'
  | 'length'
  | 'unknown_field'
  | 'duplicate_field'
  | 'unsafe_field_id'

/** One rejected field, named so a card can mark exactly that input. */
export interface OpenUIFieldIssue {
  fieldId: string
  code: OpenUIFieldIssueCode
  message: string
}

/** The outcome of checking a submission against a form. */
export type OpenUIFormValidation =
  | { ok: true; values: OpenUIFormValues }
  | { ok: false; issues: OpenUIFieldIssue[] }

function issue(fieldId: string, code: OpenUIFieldIssueCode, message: string): OpenUIFieldIssue {
  return { fieldId, code, message }
}

/** Floating-point step arithmetic: 0.1 increments must not reject 0.3. */
const STEP_EPSILON = 1e-9

function checkNumeric(field: OpenUIFieldSpec, value: number): OpenUIFieldIssue | null {
  if (!Number.isFinite(value)) return issue(field.id, 'type', `${field.id} must be a finite number`)
  if (field.min !== undefined && value < field.min) {
    return issue(field.id, 'range', `${field.id} must be at least ${field.min}`)
  }
  if (field.max !== undefined && value > field.max) {
    return issue(field.id, 'range', `${field.id} must be at most ${field.max}`)
  }
  if (field.step !== undefined && field.step > 0) {
    const offset = (value - (field.min ?? 0)) / field.step
    if (Math.abs(offset - Math.round(offset)) > STEP_EPSILON) {
      return issue(field.id, 'step', `${field.id} must move in steps of ${field.step}`)
    }
  }
  return null
}

function isEmpty(value: OpenUIValue): boolean {
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function checkField(field: OpenUIFieldSpec, value: OpenUIValue | undefined): OpenUIFieldIssue | null {
  if (value === undefined || isEmpty(value)) {
    // A checkbox is never "empty" — `false` is an answer — so only a genuinely
    // absent value can fail the required check for one.
    if (field.required) return issue(field.id, 'required', `${field.id} is required`)
    return null
  }

  switch (field.kind) {
    case 'text': {
      if (typeof value !== 'string') return issue(field.id, 'type', `${field.id} must be text`)
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return issue(field.id, 'length', `${field.id} must be at most ${field.maxLength} characters`)
      }
      return null
    }
    case 'number':
    case 'currency':
    case 'slider': {
      if (typeof value !== 'number') return issue(field.id, 'type', `${field.id} must be a number`)
      return checkNumeric(field, value)
    }
    case 'checkbox': {
      if (typeof value !== 'boolean') return issue(field.id, 'type', `${field.id} must be true or false`)
      return null
    }
    case 'select': {
      const allowed = field.options ? new Set(field.options.map((option) => option.value)) : null
      if (field.multiple) {
        if (!Array.isArray(value)) return issue(field.id, 'type', `${field.id} must be a list of choices`)
        if (allowed) {
          const rejected = value.find((entry) => !allowed.has(entry))
          if (rejected !== undefined) {
            return issue(field.id, 'option', `${field.id} does not offer "${rejected}"`)
          }
        }
        return null
      }
      if (typeof value !== 'string') return issue(field.id, 'type', `${field.id} must be a single choice`)
      if (allowed && !allowed.has(value)) return issue(field.id, 'option', `${field.id} does not offer "${value}"`)
      return null
    }
  }
}

/**
 * Check submitted values against the form the agent authored.
 *
 * Fails loud on both sides of the shape: a value the form never declared is an
 * error (`unknown_field`), not a silently ignored extra, because a host that
 * drops it would act on a form different from the one the user filled in. A
 * `required` field with no value is an error even when the caller simply never
 * sent the key.
 *
 * On success the returned `values` contain only declared fields, in the form's
 * own field order — the object a handler should act on.
 */
export function validateOpenUIFormValues(spec: OpenUIFormSpec, values: OpenUIFormValues): OpenUIFormValidation {
  const issues: OpenUIFieldIssue[] = []
  const seen = new Set<string>()
  for (const field of spec.fields) {
    if (!isSafeOpenUIFieldId(field.id)) {
      issues.push(issue(field.id, 'unsafe_field_id', `${field.id} is not a usable field id`))
      continue
    }
    if (seen.has(field.id)) {
      issues.push(issue(field.id, 'duplicate_field', `${field.id} is declared more than once`))
      continue
    }
    seen.add(field.id)
  }

  for (const key of Object.keys(values)) {
    if (!seen.has(key)) issues.push(issue(key, 'unknown_field', `${key} is not a field on this form`))
  }

  const accepted: OpenUIFormValues = {}
  for (const field of spec.fields) {
    if (!seen.has(field.id)) continue
    const value = Object.prototype.hasOwnProperty.call(values, field.id) ? values[field.id] : undefined
    const problem = checkField(field, value)
    if (problem) {
      issues.push(problem)
      continue
    }
    if (value !== undefined) accepted[field.id] = value
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, values: accepted }
}
