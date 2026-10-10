/**
 * Alarms that fire at 80% of a platform limit, before the limit fails a customer.
 *
 * On 2026-10-10 GTM recorded 19 platform-limit events (Worker memory, D1,
 * sandbox disk, snapshot count, key rate) and learned of each one after it had
 * failed someone. Each resource here has a declared limit; an observation at
 * or above 80% of it delivers a warning, and at or above the limit a critical
 * alert, through the same {@link AlertSink} the turn-health sweep uses (wrap it
 * in `createThrottledAlertSink` so a hot loop pages once).
 *
 * Where each observation comes from:
 * - `d1-rows-per-query`: {@link withD1LimitAlarms} reads `meta.rows_read` on every query.
 * - `worker-memory`: workerd exposes no heap reading, so the D1 wrapper observes
 *   the bytes each response returns (the reads that overran memory today), and a
 *   tail consumer reports an `exceededMemory` outcome at the full limit.
 * - `sandbox-disk` and `snapshot-count`: the Sandbox SDK's box usage and snapshot list, read on a schedule.
 * - `key-rate`: the per-key request counter the operator API keeps.
 */
import type { AlertSink, TurnHealthAlert } from '../turn-health/sink.js'
import { LAUNCH_BUDGETS } from './catalog.js'

export type LimitResource = 'worker-memory' | 'd1-rows-per-query' | 'sandbox-disk' | 'snapshot-count' | 'key-rate'

export const LIMIT_RESOURCES: readonly LimitResource[] = [
  'worker-memory',
  'd1-rows-per-query',
  'sandbox-disk',
  'snapshot-count',
  'key-rate',
]

/** The limit of each resource, in its own unit: bytes, rows, bytes, snapshots, requests per minute. */
export type LimitBudgets = Readonly<Record<LimitResource, number>>

const UNITS: Readonly<Record<LimitResource, string>> = {
  'worker-memory': 'bytes',
  'd1-rows-per-query': 'rows',
  'sandbox-disk': 'bytes',
  'snapshot-count': 'snapshots',
  'key-rate': 'requests/min',
}

export type LimitLevel = 'ok' | 'warning' | 'critical'

export interface LimitObservation {
  resource: LimitResource
  used: number
  limit: number
  /** used / limit. */
  share: number
  level: LimitLevel
}

export interface LimitAlarms {
  readonly budgets: LimitBudgets
  /** Record one reading; a warning or critical reading is delivered before this resolves. */
  observe(resource: LimitResource, used: number, context?: { subject?: string; detail?: string }): Promise<LimitObservation>
}

export interface LimitAlarmOptions {
  product: string
  budgets: LimitBudgets
  sink: AlertSink
  /** Default {@link LAUNCH_BUDGETS.alarmRatio}; a product cannot raise it past the limit itself. */
  ratio?: number
  now?: () => number
}

export function createLimitAlarms(options: LimitAlarmOptions): LimitAlarms {
  const ratio = Math.min(options.ratio ?? LAUNCH_BUDGETS.alarmRatio, 1)
  const now = options.now ?? (() => Date.now())
  for (const resource of LIMIT_RESOURCES) {
    const limit = options.budgets[resource]
    if (!(typeof limit === 'number' && limit > 0 && Number.isFinite(limit))) {
      throw new Error(`limit alarms: ${resource} needs a positive limit`)
    }
  }
  return {
    budgets: options.budgets,
    async observe(resource, used, context) {
      const limit = options.budgets[resource]
      const share = used / limit
      const level: LimitLevel = share >= 1 ? 'critical' : share >= ratio ? 'warning' : 'ok'
      const observation = { resource, used, limit, share, level }
      if (level === 'ok') return observation
      const alert: TurnHealthAlert = {
        product: options.product,
        severity: level,
        // Keyed by product and resource only, so a throttled sink pages once per resource.
        key: `limit:${options.product}:${resource}`,
        title: `${options.product}: ${resource} at ${Math.round(share * 100)}% of its limit`,
        details: [
          `${formatAmount(used, resource)} of ${formatAmount(limit, resource)} ${UNITS[resource]}`,
          ...(context?.subject ? [`in ${context.subject}`] : []),
          ...(context?.detail ? [context.detail] : []),
        ],
        data: { resource, used, limit, share, ...(context?.subject ? { subject: context.subject } : {}) },
        at: now(),
      }
      await options.sink.deliver(alert)
      return observation
    },
  }
}

function formatAmount(value: number, resource: LimitResource): string {
  if (UNITS[resource] === 'bytes') return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return Math.round(value).toLocaleString('en-US')
}

/** The D1 surface the wrapper measures; Cloudflare `D1Database` satisfies it. */
interface D1Measurable {
  prepare(sql: string): unknown
}

/**
 * The D1 binding with each query's rows read and response size observed.
 * Rows read come from `meta.rows_read` (the rows D1 scanned, not only those
 * returned); the response size is measured only when it could matter, by the
 * serialized length of the results.
 */
export function withD1LimitAlarms<D extends D1Measurable>(d1: D, alarms: LimitAlarms, options: { subject?: string } = {}): D {
  const observe = (sql: string, result: unknown) => {
    const meta = (result as { meta?: { rows_read?: unknown } } | null)?.meta
    const rowsRead = typeof meta?.rows_read === 'number' ? meta.rows_read : rowsOf(result)
    const pending: Promise<unknown>[] = []
    if (rowsRead !== null) pending.push(alarms.observe('d1-rows-per-query', rowsRead, { subject: options.subject, detail: sql }))
    const results = (result as { results?: unknown[] } | null)?.results ?? (Array.isArray(result) ? result : null)
    if (results && results.length > 0) {
      const bytes = JSON.stringify(results).length
      pending.push(alarms.observe('worker-memory', bytes, { subject: options.subject, detail: `one response: ${sql}` }))
    }
    // An alarm delivery failure must not fail the query that triggered it.
    return Promise.all(pending).catch(() => undefined)
  }
  const statement = (target: object, sql: string): object => new Proxy(target, {
    get(stmt, key) {
      const value = Reflect.get(stmt, key) as unknown
      if (typeof value !== 'function') return value
      if (key === 'bind') return (...params: unknown[]) => statement(value.apply(stmt, params) as object, sql)
      if (key === 'all' || key === 'raw' || key === 'run' || key === 'first') {
        return async (...args: unknown[]) => {
          const result: unknown = await value.apply(stmt, args)
          if (key !== 'first') await observe(sql, result)
          return result
        }
      }
      return value.bind(stmt)
    },
  })
  return new Proxy(d1, {
    get(binding, key) {
      const value = Reflect.get(binding, key) as unknown
      if (key === 'prepare') {
        return (sql: string) => statement((value as (sql: string) => object).call(binding, sql), sql.replace(/\s+/g, ' ').slice(0, 160))
      }
      return typeof value === 'function' ? value.bind(binding) : value
    },
  })
}

function rowsOf(result: unknown): number | null {
  if (Array.isArray(result)) return result.length
  const results = (result as { results?: unknown } | null)?.results
  return Array.isArray(results) ? results.length : null
}
