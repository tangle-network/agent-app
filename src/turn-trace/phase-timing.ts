import type { TurnSpan, TurnSpanAttrs, TurnSpanKind, TurnTrace } from './recorder'

/** Domain-named phases and concurrent work over the turn's existing clock and D1 counter. */
export interface TurnPhaseTiming {
  readonly startedAt: number
  mark(name: string): void
  track<T>(name: string, work: Promise<T>, attrsOf?: (value: T) => TurnSpanAttrs): Promise<T>
  within(parent: TurnSpan | undefined): void
  phases(): Record<string, number>
  concurrent(): Record<string, number>
  queries(): Record<string, number>
}

export interface TurnPhaseTimingOptions {
  prefix: string
  startedAt?: number
  kinds?: Readonly<Record<string, TurnSpanKind>>
}

/** The recorder supplies its clock/counter; this module has no host or Node dependency. */
export function turnPhaseTiming(trace: TurnTrace, options: TurnPhaseTimingOptions,
  now: () => number, counter?: { readonly queries: number }): TurnPhaseTiming {
  const startedAt = options.startedAt ?? trace.startedAt
  let last = startedAt, floor = startedAt, lastQuery = counter?.queries ?? 0
  let parent: TurnSpan | undefined
  const phases: Record<string, number> = {}, concurrent: Record<string, number> = {}, queries: Record<string, number> = {}
  const kind = (name: string) => options.kinds?.[name] ?? 'admission'
  const label = (name: string) => `${options.prefix}.${name}`
  return {
    startedAt,
    mark(name) {
      const at = now()
      phases[name] = (phases[name] ?? 0) + at - last
      if (counter) {
        queries[name] = (queries[name] ?? 0) + counter.queries - lastQuery
        lastQuery = counter.queries
      }
      trace.record(label(name), kind(name), parent ? Math.max(last, floor) : last, at, {}, parent)
      last = at
    },
    track(name, work, attrsOf) {
      const began = now(), span = trace.start(label(name), kind(name))
      void work.then(value => { concurrent[name] = now() - began; span.end(attrsOf?.(value)) },
        error => { concurrent[name] = now() - began; span.end(undefined, error) }).catch(() => {})
      return work
    },
    within(span) { parent = span; floor = now() },
    phases: () => ({ ...phases }), concurrent: () => ({ ...concurrent }), queries: () => counter ? { ...queries } : {},
  }
}
