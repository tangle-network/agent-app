/** Structured, bounded latency records for one request or agent turn. */

export const STAGE_TIMING_EVENT = 'stage_timing'
export const STAGE_TIMING_VERSION = 1

export type StageTimingOutcome = 'ok' | 'error' | 'timeout' | 'skipped'
export type StageTimingKind = 'leaf' | 'span'
export type StageTimingDetailValue = string | number | boolean | null

export interface StageTimingContext {
  runId: string
  workspaceId?: string
  threadId?: string
  sandboxId?: string
  model?: string
  harness?: string
  path?: string
}

export interface StageTimingRecordInput {
  kind?: StageTimingKind
  outcome?: StageTimingOutcome
  attempt?: number
  /** Bounded operational metadata only. Do not pass user input or credentials. */
  detail?: Record<string, StageTimingDetailValue | undefined>
}

export interface StageTimingRecord extends StageTimingContext {
  evt: typeof STAGE_TIMING_EVENT
  v: typeof STAGE_TIMING_VERSION
  stage: string
  kind: StageTimingKind
  startedAt: number
  durationMs: number
  outcome: StageTimingOutcome
  attempt?: number
  detail?: Record<string, StageTimingDetailValue>
}

export interface StageTimingHandle {
  readonly startedAt: number
  done(input?: StageTimingRecordInput): void
  fail(error: unknown, input?: StageTimingRecordInput): void
}

export interface StageTiming {
  readonly context: Readonly<StageTimingContext>
  setContext(input: Partial<Omit<StageTimingContext, 'runId'>>): void
  recordDuration(
    stage: string,
    startedAt: number,
    durationMs: number,
    input?: StageTimingRecordInput,
  ): void
  start(stage: string, input?: StageTimingRecordInput): StageTimingHandle
  measure<T>(
    stage: string,
    input: StageTimingRecordInput,
    operation: () => Promise<T>,
  ): Promise<T>
}

export interface CreateStageTimingOptions {
  context?: Partial<StageTimingContext>
  /** Carrier for a validated record. Throws and rejected promises are contained. */
  emit(record: StageTimingRecord): void | Promise<void>
  /** Epoch-millisecond clock. Defaults to `Date.now`. */
  now?(): number
  /** ID seam used only when `context.runId` is absent. */
  createRunId?(): string
}

const MAX_STAGE_LENGTH = 80
const MAX_IDENTIFIER_LENGTH = 128
const MAX_DETAIL_KEYS = 8
const MAX_DETAIL_KEY_LENGTH = 64
const MAX_DETAIL_STRING_LENGTH = 64
const SENSITIVE_KEY =
  /(?:api|auth|access|refresh|session|private|secret|password|credential|cookie|bearer|token)[_-]?(?:key|token|secret)?/iu

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_IDENTIFIER_LENGTH) : undefined
}

function sanitizeDetail(
  detail: StageTimingRecordInput['detail'],
): Record<string, StageTimingDetailValue> | undefined {
  if (!detail) return undefined
  const entries: [string, StageTimingDetailValue][] = []
  for (const [rawKey, value] of Object.entries(detail)) {
    if (entries.length >= MAX_DETAIL_KEYS) break
    const key = rawKey.trim().slice(0, MAX_DETAIL_KEY_LENGTH)
    if (!key || value === undefined || SENSITIVE_KEY.test(key)) continue
    if (typeof value === 'string') {
      entries.push([key, value.slice(0, MAX_DETAIL_STRING_LENGTH)])
    } else if (typeof value === 'number') {
      entries.push([key, Number.isFinite(value) ? value : null])
    } else {
      entries.push([key, value])
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** Build one safe record, or return null when its required fields are invalid. */
export function buildStageTimingRecord(
  context: StageTimingContext,
  stage: string,
  startedAt: number,
  durationMs: number,
  input: StageTimingRecordInput = {},
): StageTimingRecord | null {
  const name = typeof stage === 'string' ? stage.trim() : ''
  if (
    !name ||
    !Number.isFinite(startedAt) ||
    startedAt < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return null
  }

  const runId = boundedIdentifier(context.runId)
  if (!runId) return null
  const record: StageTimingRecord = {
    evt: STAGE_TIMING_EVENT,
    v: STAGE_TIMING_VERSION,
    stage: name.slice(0, MAX_STAGE_LENGTH),
    kind: input.kind === 'span' ? 'span' : 'leaf',
    startedAt: Math.round(startedAt),
    durationMs: Math.round(durationMs),
    outcome: input.outcome ?? 'ok',
    runId,
  }

  for (const key of [
    'workspaceId',
    'threadId',
    'sandboxId',
    'model',
    'harness',
    'path',
  ] as const) {
    const value = boundedIdentifier(context[key])
    if (value) record[key] = value
  }
  if (
    typeof input.attempt === 'number' &&
    Number.isSafeInteger(input.attempt) &&
    input.attempt >= 0
  ) {
    record.attempt = input.attempt
  }
  const detail = sanitizeDetail(input.detail)
  if (detail) record.detail = detail
  return record
}

function outcomeForError(error: unknown): StageTimingOutcome {
  const candidate = error && typeof error === 'object'
    ? (error as { code?: unknown; message?: unknown })
    : null
  const text = `${String(candidate?.code ?? '')} ${
    candidate?.message ?? String(error ?? '')
  }`
  return /timeout|timed ?out|deadline/iu.test(text) ? 'timeout' : 'error'
}

/**
 * Create a stage timer with an injected carrier. Invalid records and carrier
 * failures are dropped because telemetry cannot decide request success.
 */
export function createStageTiming(options: CreateStageTimingOptions): StageTiming {
  const now = options.now ?? (() => Date.now())
  const generatedRunId = () =>
    boundedIdentifier((options.createRunId ?? (() => crypto.randomUUID()))()) ??
    crypto.randomUUID()
  const context: StageTimingContext = {
    ...options.context,
    runId: boundedIdentifier(options.context?.runId) ?? generatedRunId(),
  }

  const emit = (
    stage: string,
    startedAt: number,
    durationMs: number,
    input: StageTimingRecordInput = {},
  ): void => {
    try {
      const record = buildStageTimingRecord(context, stage, startedAt, durationMs, input)
      if (!record) return
      const result = options.emit(record)
      if (result && typeof result.then === 'function') void result.catch(() => undefined)
    } catch {
      // Telemetry cannot decide whether the measured operation succeeds.
    }
  }

  return {
    context,
    setContext(input) {
      Object.assign(context, input)
    },
    recordDuration(stage, startedAt, durationMs, input = {}) {
      emit(stage, startedAt, durationMs, input)
    },
    start(stage, input = {}) {
      const startedAt = now()
      let emitted = false
      const finish = (extra: StageTimingRecordInput = {}) => {
        if (emitted) return
        emitted = true
        emit(stage, startedAt, now() - startedAt, {
          ...input,
          ...extra,
          detail: { ...input.detail, ...extra.detail },
        })
      }
      return {
        startedAt,
        done: finish,
        fail(error, extra = {}) {
          finish({ ...extra, outcome: outcomeForError(error) })
        },
      }
    },
    async measure(stage, input, operation) {
      const handle = this.start(stage, input)
      try {
        const value = await operation()
        handle.done()
        return value
      } catch (error) {
        handle.fail(error)
        throw error
      }
    },
  }
}
