/**
 * Bounded runtime telemetry: wrap agent-runtime's stream-event collector with an
 * event-count cap and a serialized-byte cap, so persisted run metadata cannot
 * grow without bound. Events past either cap are dropped and counted.
 */

import {
  createRuntimeStreamEventCollector,
  type RuntimeStreamEvent,
  type RuntimeTelemetryOptions,
} from '@tangle-network/agent-runtime'

export interface RuntimeTelemetryCaps {
  maxEvents: number
  maxBytes: number
}

/** What was dropped once a cap was hit; `undefined` from `truncation()` means nothing was. */
export interface RuntimeTelemetryTruncation {
  eventsDropped: number
  sizeCapped: boolean
}

export interface CappedRuntimeTelemetry {
  /** Feed every runtime event through this. */
  record(event: RuntimeStreamEvent): void
  /** The retained events. */
  events(): ReturnType<typeof createRuntimeStreamEventCollector>['events']
  truncation(): RuntimeTelemetryTruncation | undefined
}

/** Collect runtime stream events under `caps`; `telemetryOptions` pass through to the collector. */
export function createCappedRuntimeTelemetry(
  caps: RuntimeTelemetryCaps,
  telemetryOptions: RuntimeTelemetryOptions = {},
): CappedRuntimeTelemetry {
  const collector = createRuntimeStreamEventCollector(telemetryOptions)
  let telemetryBytes = 0
  let eventsDropped = 0
  let sizeCapped = false

  return {
    record(event) {
      const before = collector.events.length
      if (before >= caps.maxEvents) {
        eventsDropped++
        return
      }
      collector.onEvent(event)
      const appended = collector.events[collector.events.length - 1]
      if (!appended || collector.events.length === before) return
      const nextBytes = telemetryBytes + JSON.stringify(appended).length + 1
      if (nextBytes > caps.maxBytes) {
        collector.events.pop()
        sizeCapped = true
        eventsDropped++
        return
      }
      telemetryBytes = nextBytes
    },
    events: () => collector.events,
    truncation: () => (eventsDropped > 0 || sizeCapped ? { eventsDropped, sizeCapped } : undefined),
  }
}
