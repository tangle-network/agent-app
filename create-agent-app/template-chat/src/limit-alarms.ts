/**
 * src/limit-alarms.ts — platform-limit alarms on this Worker's D1 reads.
 *
 * Every resource starts from agent-app's defaults (128 MB Worker memory, 250,000 D1 rows per query, a 10 GB box
 * disk, 25 snapshots, 60 key requests per minute) and alarms at 80% to the Worker log and, when
 * `SLACK_OPS_WEBHOOK_URL` is set, the ops webhook. Pass `overrides` only for a limit this product measured
 * differently. See docs/launch-invariants.md in @tangle-network/agent-app.
 */

import { createProductLimitAlarms, withD1LimitAlarms } from '@tangle-network/agent-app/launch-invariants'
import type { AppEnv } from './env'
import { appSlug } from './sandbox'

const watched = new WeakMap<object, AppEnv>()

/**
 * The Worker's env with its D1 binding observed: rows read and response size on every query. One wrapper per env,
 * and every other binding is read live from the original.
 */
export function withLimitAlarms(env: AppEnv): AppEnv {
  if (!env.DB) return env
  const existing = watched.get(env)
  if (existing) return existing
  const database = withD1LimitAlarms(env.DB, createProductLimitAlarms({ product: appSlug, webhookUrl: env.SLACK_OPS_WEBHOOK_URL }))
  const next = new Proxy(env, { get: (target, key) => (key === 'DB' ? database : Reflect.get(target, key)) })
  watched.set(env, next)
  return next
}
