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
  /** Bounded primitive operational metadata only. Do not pass user input or credentials. */
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
  /** Epoch-millisecond clock. Defaults to `Date.now`; clock failures drop the record. */
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
const CREDENTIAL_VALUE =
  /\b(?:bearer|basic|digest|token)\s+\S+|\bapi[-_ ]?key\s*[:=]\s*\S+/iu

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_IDENTIFIER_LENGTH) : undefined
}

function safeProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}

function sanitizeDetail(
  detail: unknown,
): Record<string, StageTimingDetailValue> | undefined {
  try {
    if (!isObject(detail) || Array.isArray(detail)) return undefined
    const entries: [string, StageTimingDetailValue][] = []
    for (const [rawKey, value] of Object.entries(detail)) {
      if (entries.length >= MAX_DETAIL_KEYS) break
      const normalizedKey = rawKey.trim()
      if (
        !normalizedKey ||
        SENSITIVE_KEY.test(normalizedKey) ||
        value === undefined
      ) {
        continue
      }
      const key = normalizedKey.slice(0, MAX_DETAIL_KEY_LENGTH)
      if (typeof value === 'string') {
        if (CREDENTIAL_VALUE.test(value)) continue
        entries.push([key, value.slice(0, MAX_DETAIL_STRING_LENGTH)])
      } else if (typeof value === 'number') {
        entries.push([key, Number.isFinite(value) ? value : null])
      } else if (typeof value === 'boolean' || value === null) {
        entries.push([key, value])
      }
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  } catch {
    return undefined
  }
}

function isStageTimingKind(value: unknown): value is StageTimingKind {
  return value === 'leaf' || value === 'span'
}

function isStageTimingOutcome(value: unknown): value is StageTimingOutcome {
  return value === 'ok' || value === 'error' || value === 'timeout' || value === 'skipped'
}

/** Build one safe record, or return null when its required fields are invalid. */
export function buildStageTimingRecord(
  context: StageTimingContext,
  stage: string,
  startedAt: number,
  durationMs: number,
  input: StageTimingRecordInput = {},
): StageTimingRecord | null {
  try {
    const name = typeof stage === 'string' ? stage.trim() : ''
    if (
      !name ||
      !Number.isFinite(startedAt) ||
      startedAt < 0 ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      !isObject(context) ||
      !isObject(input)
    ) {
      return null
    }

    const rawKind = safeProperty(input, 'kind')
    const rawOutcome = safeProperty(input, 'outcome')
    const kind = rawKind === undefined ? 'leaf' : rawKind
    const outcome = rawOutcome === undefined ? 'ok' : rawOutcome
    if (!isStageTimingKind(kind) || !isStageTimingOutcome(outcome)) return null

    const runId = boundedIdentifier(safeProperty(context, 'runId'))
    if (!runId) return null
    const record: StageTimingRecord = {
      evt: STAGE_TIMING_EVENT,
      v: STAGE_TIMING_VERSION,
      stage: name.slice(0, MAX_STAGE_LENGTH),
      kind,
      startedAt: Math.round(startedAt),
      durationMs: Math.round(durationMs),
      outcome,
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
      const value = boundedIdentifier(safeProperty(context, key))
      if (value) record[key] = value
    }
    const attempt = safeProperty(input, 'attempt')
    if (
      typeof attempt === 'number' &&
      Number.isSafeInteger(attempt) &&
      attempt >= 0
    ) {
      record.attempt = attempt
    }
    const detail = sanitizeDetail(safeProperty(input, 'detail'))
    if (detail) record.detail = detail
    return record
  } catch {
    return null
  }
}

function safePrimitiveText(value: unknown): string {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean' &&
    typeof value !== 'bigint' &&
    typeof value !== 'symbol'
  ) {
    return ''
  }
  try {
    return String(value)
  } catch {
    return ''
  }
}

function outcomeForError(error: unknown): StageTimingOutcome {
  try {
    const objectLike = isObject(error) || typeof error === 'function'
    const code = objectLike ? safePrimitiveText(safeProperty(error as object, 'code')) : ''
    const message = objectLike
      ? safePrimitiveText(safeProperty(error as object, 'message'))
      : safePrimitiveText(error)
    return /timeout|timed ?out|deadline/iu.test(`${code} ${message}`)
      ? 'timeout'
      : 'error'
  } catch {
    return 'error'
  }
}

function safeClock(now: () => number): number | undefined {
  try {
    const value = now()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function safeObject(value: unknown): Record<string, unknown> {
  try {
    if (!isObject(value) || Array.isArray(value)) return {}
    return { ...value }
  } catch {
    return {}
  }
}

function mergeInputs(
  base: unknown,
  extra: unknown,
): StageTimingRecordInput {
  const baseObject = safeObject(base)
  const extraObject = safeObject(extra)
  const detail = {
    ...safeObject(baseObject.detail),
    ...safeObject(extraObject.detail),
  }
  return {
    ...baseObject,
    ...extraObject,
    detail: detail as Record<string, StageTimingDetailValue | undefined>,
  }
}

function withOutcome(extra: unknown, outcome: StageTimingOutcome): StageTimingRecordInput {
  return { ...safeObject(extra), outcome }
}

/**
 * Create a stage timer with an injected carrier. Invalid records and carrier
 * failures are dropped because telemetry cannot decide request success.
 */
export function createStageTiming(options: CreateStageTimingOptions): StageTiming {
  const now = options.now ?? (() => Date.now())
  const generatedRunId = () => {
    try {
      const value = (options.createRunId ?? (() => crypto.randomUUID()))()
      return boundedIdentifier(value) ?? crypto.randomUUID()
    } catch {
      try {
        return crypto.randomUUID()
      } catch {
        return 'run-unknown'
      }
    }
  }
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
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => undefined)
      }
    } catch {
      // Telemetry cannot decide whether the measured operation succeeds.
    }
  }

  return {
    context,
    setContext(input) {
      try {
        Object.assign(context, input)
      } catch {
        // Telemetry context updates cannot affect the measured operation.
      }
    },
    recordDuration(stage, startedAt, durationMs, input = {}) {
      emit(stage, startedAt, durationMs, input)
    },
    start(stage, input = {}) {
      const observedStart = safeClock(now)
      const startedAt = observedStart ?? 0
      let emitted = false
      const finish = (extra: StageTimingRecordInput = {}) => {
        if (emitted) return
        emitted = true
        if (observedStart === undefined) return
        const observedEnd = safeClock(now)
        if (observedEnd === undefined) return
        try {
          emit(stage, observedStart, observedEnd - observedStart, mergeInputs(input, extra))
        } catch {
          // A timer must never change the measured operation.
        }
      }
      return {
        startedAt,
        done: finish,
        fail(error, extra = {}) {
          let outcome: StageTimingOutcome = 'error'
          try {
            outcome = outcomeForError(error)
          } catch {
            // Keep the fallback error outcome when classification is hostile.
          }
          finish(withOutcome(extra, outcome))
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
