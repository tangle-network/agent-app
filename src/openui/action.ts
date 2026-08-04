/**
 * What travels when a user presses a button on a page the agent authored.
 *
 * The submission is a plain REST body, not a chat turn. That is the entire
 * point of this module: pressing "Recalculate" on an agent-authored form must
 * cost the same as pressing a button on a hand-built screen — one product route
 * call, no model tokens, no sandbox wake-up. The wire shape here is therefore
 * deliberately small and self-contained: an action id, the form it belongs to,
 * that form's current values, and enough addressing for the product to find the
 * page. Nothing in it references a session, a turn, or a run.
 */

import { isSafeOpenUIFieldId, type OpenUIFormValues, type OpenUIValue } from './values'

/** What the browser POSTs when an action fires. */
export interface OpenUIActionSubmission {
  /** The action's stable id, as authored on the page. */
  actionId: string
  /** The form whose values are attached, when the action sits in one. */
  formId?: string
  /** Current values of that form, keyed by field id. Empty for a bare action. */
  values: OpenUIFormValues
  /** The node the action was rendered on, when the page carries several. */
  nodeId?: string
  /** Vault path of the persisted `render_ui` artifact this page came from. */
  artifactPath?: string
}

/** Parsed submission, or the reason the body was refused. */
export type OpenUIActionBodyValidation =
  | { ok: true; submission: OpenUIActionSubmission }
  | { ok: false; code: OpenUIActionBodyErrorCode; error: string }

/** Why a submission body was refused before any handler ran. */
export type OpenUIActionBodyErrorCode =
  | 'OPENUI_ACTION_ID_MISSING'
  | 'OPENUI_ACTION_ID_INVALID'
  | 'OPENUI_FORM_ID_INVALID'
  | 'OPENUI_NODE_ID_INVALID'
  | 'OPENUI_ARTIFACT_PATH_INVALID'
  | 'OPENUI_VALUES_INVALID'
  | 'OPENUI_FIELD_ID_INVALID'
  | 'OPENUI_FIELD_VALUE_INVALID'

/** Ids the host accepts on the wire: identifier-safe, same rule as field ids. */
export function isSafeOpenUIActionId(id: string): boolean {
  return isSafeOpenUIFieldId(id)
}

function isOpenUIValue(value: unknown): value is OpenUIValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  )
}

function optionalId(
  value: unknown,
  code: OpenUIActionBodyErrorCode,
  label: string,
): { ok: true; value: string | undefined } | { ok: false; code: OpenUIActionBodyErrorCode; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string' || !isSafeOpenUIActionId(value)) {
    return { ok: false, code, error: `Invalid ${label}: letters, numbers, underscores, and hyphens only` }
  }
  return { ok: true, value }
}

/** A vault path is a product-addressed string, not an identifier — bound its
 *  length and reject traversal rather than the character class. */
function isSafeArtifactPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !path.includes('..') && !path.startsWith('/')
}

/**
 * Validate a raw JSON body into a submission. Every rejection names a code so
 * the browser can tell "the page sent something malformed" from "the product
 * refused the action".
 */
export function validateOpenUIActionBody(body: Record<string, unknown>): OpenUIActionBodyValidation {
  const actionId = body.actionId
  if (typeof actionId !== 'string' || actionId.trim() === '') {
    return { ok: false, code: 'OPENUI_ACTION_ID_MISSING', error: 'Missing actionId' }
  }
  if (!isSafeOpenUIActionId(actionId)) {
    return {
      ok: false,
      code: 'OPENUI_ACTION_ID_INVALID',
      error: 'Invalid actionId: letters, numbers, underscores, and hyphens only',
    }
  }

  const formId = optionalId(body.formId, 'OPENUI_FORM_ID_INVALID', 'formId')
  if (!formId.ok) return formId
  const nodeId = optionalId(body.nodeId, 'OPENUI_NODE_ID_INVALID', 'nodeId')
  if (!nodeId.ok) return nodeId

  let artifactPath: string | undefined
  if (body.artifactPath !== undefined && body.artifactPath !== null) {
    if (typeof body.artifactPath !== 'string' || !isSafeArtifactPath(body.artifactPath)) {
      return { ok: false, code: 'OPENUI_ARTIFACT_PATH_INVALID', error: 'Invalid artifactPath' }
    }
    artifactPath = body.artifactPath
  }

  const values: OpenUIFormValues = {}
  if (body.values !== undefined && body.values !== null) {
    if (typeof body.values !== 'object' || Array.isArray(body.values)) {
      return { ok: false, code: 'OPENUI_VALUES_INVALID', error: 'Invalid values: expected an object of field values' }
    }
    for (const [key, value] of Object.entries(body.values as Record<string, unknown>)) {
      if (!isSafeOpenUIFieldId(key)) {
        return {
          ok: false,
          code: 'OPENUI_FIELD_ID_INVALID',
          error: 'Invalid values: field names must contain only letters, numbers, underscores, or hyphens',
        }
      }
      if (!isOpenUIValue(value)) {
        return {
          ok: false,
          code: 'OPENUI_FIELD_VALUE_INVALID',
          error: 'Invalid values: field values must be strings, numbers, booleans, or string arrays',
        }
      }
      values[key] = value
    }
  }

  return {
    ok: true,
    submission: {
      actionId,
      values,
      ...(formId.value ? { formId: formId.value } : {}),
      ...(nodeId.value ? { nodeId: nodeId.value } : {}),
      ...(artifactPath ? { artifactPath } : {}),
    },
  }
}

function describeValue(value: OpenUIValue): string {
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/**
 * One plain line recording what the user did, for the product to carry into the
 * NEXT turn's context.
 *
 * The action itself spends no model tokens; without a record of it the agent
 * would later reason about a page the user has already changed. Appending this
 * to the thread (as a note, a system line, or a stored part) is how the agent
 * catches up on the next turn the user actually pays for.
 */
export function describeOpenUIAction(submission: OpenUIActionSubmission): string {
  const entries = Object.entries(submission.values)
  const where = submission.formId ? ` on form "${submission.formId}"` : ''
  if (entries.length === 0) return `User pressed "${submission.actionId}"${where}.`
  const pairs = entries.map(([key, value]) => `${key}=${describeValue(value)}`).join(', ')
  return `User pressed "${submission.actionId}"${where} with ${pairs}.`
}
