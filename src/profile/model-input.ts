/**
 * "What the model saw": content-addressed copies of the exact inputs a turn
 * sent to the model, linked from the turn's execution receipt.
 *
 * A receipt that names a profile revision cannot say what the prompt read once
 * the rendering code has changed. Storing each input by digest answers that
 * permanently: identical prompts across turns share one blob, so a turn adds a
 * small record of digests rather than another copy of the prompt.
 *
 * The store is a port. A product implements it over its own storage (an object
 * bucket, a database table, a vault directory); `createMemoryModelInputStore`
 * is the reference implementation and test double. A digest is the lowercase
 * sha256 hex of the UTF-8 content, the same encoding as
 * `ProfileFingerprint.promptSha`, so a fingerprint already on a receipt
 * resolves to its system-prompt blob directly.
 */

import type { RenderedAgentPrompt } from './agent-prompt'

export const MODEL_INPUT_RECORD_SCHEMA = 'agent-app.model-input.v1'

/** What an input was. `workspace-plan` is the canonical JSON of the
 *  materialized workspace plan; `turn-context` is per-turn text appended after
 *  the system prompt. */
export type ModelInputKind = 'system-prompt' | 'workspace-plan' | 'turn-context'

export type ModelInputMediaType = 'text/markdown' | 'application/json' | 'text/plain'

export interface ModelInputBlob {
  digest: string
  kind: ModelInputKind
  mediaType: ModelInputMediaType
  bytes: number
  content: string
}

/** A blob without its content: what a record carries. */
export type ModelInputRef = Omit<ModelInputBlob, 'content'>

/** One system-prompt section's identity, from {@link RenderedAgentPrompt}. Two
 *  records compared section by section name the section that changed. */
export interface ModelInputSectionRef {
  id: string
  title: string
  bytes: number
  digest: string
}

/** The record an execution receipt embeds. */
export interface ModelInputRecord {
  schema: typeof MODEL_INPUT_RECORD_SCHEMA
  /** sha256 over the record's other fields; equal records have equal digests. */
  digest: string
  inputs: ModelInputRef[]
  /** Empty when the system prompt was a plain string. */
  sections: ModelInputSectionRef[]
  /** Operating-contract version, when the prompt came from `renderAgentPrompt`. */
  contractVersion: number | null
  /** ADC plan identity (`hashWorkspacePlan`), matching `ProfileTurnPin.planDigest`. */
  planDigest: string | null
  model: string | null
  harness: string | null
}

export type ModelInputOutcome<T> = { succeeded: true; value: T } | { succeeded: false; error: string }

/** Content-addressed blob storage for model inputs. */
export interface ModelInputStore {
  /** Store a blob. Idempotent: putting an existing digest succeeds. */
  put(blob: ModelInputBlob): Promise<ModelInputOutcome<void>>
  /** Load a blob; `null` when the digest is unknown. */
  get(digest: string): Promise<ModelInputOutcome<ModelInputBlob | null>>
}

const encoder = new TextEncoder()

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const DEFAULT_MEDIA_TYPE: Record<ModelInputKind, ModelInputMediaType> = {
  'system-prompt': 'text/markdown',
  'workspace-plan': 'application/json',
  'turn-context': 'text/markdown',
}

/** Address one input by its content. */
export async function modelInputBlob(
  kind: ModelInputKind,
  content: string,
  mediaType: ModelInputMediaType = DEFAULT_MEDIA_TYPE[kind],
): Promise<ModelInputBlob> {
  return { digest: await sha256Hex(content), kind, mediaType, bytes: encoder.encode(content).byteLength, content }
}

export interface CaptureModelInputInput {
  store: ModelInputStore
  /** The final system prompt the model received. */
  systemPrompt: string | RenderedAgentPrompt
  /** Other inputs, such as the canonical workspace-plan JSON. */
  inputs?: ReadonlyArray<{ kind: ModelInputKind; content: string; mediaType?: ModelInputMediaType }>
  planDigest?: string | null
  model?: string | null
  harness?: string | null
}

function failed(error: string): { succeeded: false; error: string } {
  return { succeeded: false, error }
}

/** Store every input, then build the record a receipt links to. Returns a
 *  failure, never a record, when any blob was not stored. */
export async function captureModelInput(input: CaptureModelInputInput): Promise<ModelInputOutcome<ModelInputRecord>> {
  const rendered = typeof input.systemPrompt === 'string' ? null : input.systemPrompt
  const prompt = rendered ? rendered.prompt : (input.systemPrompt as string)
  const blobs = await Promise.all([
    modelInputBlob('system-prompt', prompt),
    ...(input.inputs ?? []).map((extra) => modelInputBlob(extra.kind, extra.content, extra.mediaType)),
  ])
  for (const blob of blobs) {
    let stored: ModelInputOutcome<void>
    try {
      stored = await input.store.put(blob)
    } catch (error) {
      return failed(`model-input store threw storing ${blob.kind} ${blob.digest}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!stored.succeeded) return failed(`model-input store refused ${blob.kind} ${blob.digest}: ${stored.error}`)
  }
  const sections = rendered
    ? await Promise.all(rendered.sections.map(async (section) => ({
        id: section.id,
        title: section.title,
        bytes: section.bytes,
        digest: await sha256Hex(section.text),
      })))
    : []
  const body = {
    schema: MODEL_INPUT_RECORD_SCHEMA,
    inputs: blobs.map((blob) => ({ digest: blob.digest, kind: blob.kind, mediaType: blob.mediaType, bytes: blob.bytes })),
    sections,
    contractVersion: rendered?.contractVersion ?? null,
    planDigest: input.planDigest ?? null,
    model: input.model ?? null,
    harness: input.harness ?? null,
  } satisfies Omit<ModelInputRecord, 'digest'>
  return { succeeded: true, value: { ...body, digest: await sha256Hex(JSON.stringify(body)) } }
}

/** Load one input back and verify its content still matches its digest. */
export async function readModelInput(
  store: ModelInputStore,
  ref: Pick<ModelInputRef, 'digest'>,
): Promise<ModelInputOutcome<ModelInputBlob>> {
  let loaded: ModelInputOutcome<ModelInputBlob | null>
  try {
    loaded = await store.get(ref.digest)
  } catch (error) {
    return failed(`model-input store threw reading ${ref.digest}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!loaded.succeeded) return loaded
  if (!loaded.value) return failed(`model input ${ref.digest} is not in the store`)
  const actual = await sha256Hex(loaded.value.content)
  if (actual !== ref.digest) return failed(`model input ${ref.digest} content hashes to ${actual}`)
  return { succeeded: true, value: loaded.value }
}

/** In-memory store. Rejects a blob whose content does not match its digest. */
export function createMemoryModelInputStore(): ModelInputStore & { readonly size: number } {
  const blobs = new Map<string, ModelInputBlob>()
  return {
    get size() {
      return blobs.size
    },
    async put(blob) {
      const actual = await sha256Hex(blob.content)
      if (actual !== blob.digest) return failed(`digest ${blob.digest} does not match content (${actual})`)
      if (!blobs.has(blob.digest)) blobs.set(blob.digest, { ...blob })
      return { succeeded: true, value: undefined }
    },
    async get(digest) {
      const blob = blobs.get(digest)
      return { succeeded: true, value: blob ? { ...blob } : null }
    },
  }
}
