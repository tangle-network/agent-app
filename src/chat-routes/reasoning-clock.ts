/**
 * When each reasoning run of a turn started and ended, so every chat producer
 * persists one reasoning part shape: `{ type: 'reasoning', text, time: { start, end } }`
 * (`ChatReasoningPart` in `/chat-store`).
 *
 * The engine (`./router-producer`) and the sandbox (`./sandbox-producer`) both
 * stream reasoning live as `{ type: 'reasoning', text }` deltas. This clock gives
 * their persisted parts the same timing: a run starts at its first delta and
 * ends when anything else streams (answer text, a tool) or the turn ends. A
 * harness that timed its own part keeps its times; the clock fills only what it
 * left out. `/web-react` reads the result back (`chatReasoningFromParts`), so a
 * reloaded turn shows how long the model thought.
 *
 * Import-free, so the browser-safe chat stream can share the part's type.
 */

/** Start and end, in epoch milliseconds, of one reasoning run. */
export interface ReasoningRunTime {
  start?: number
  end?: number
}

/** The clock one producer keeps for one turn. `K` is how the producer names a run: a part key or the part itself. */
export interface ReasoningClock<K> {
  /** A reasoning delta for `run` streamed. Starts its clock on the first; ends any other open run. */
  reasoning(run: K): void
  /** Something other than reasoning streamed, or the turn ended: the open run is over. */
  settle(): void
  /** The run's time, the part's own `start` and `end` winning where it has them. */
  time(run: K, own?: ReasoningRunTime): ReasoningRunTime | undefined
}

/** A clock for one turn's reasoning runs. */
export function createReasoningClock<K>(now: () => number = Date.now): ReasoningClock<K> {
  const runs = new Map<K, ReasoningRunTime>()
  let open: { run: K } | null = null
  const settle = () => {
    if (!open) return
    const time = runs.get(open.run)
    if (time && time.end === undefined) time.end = now()
    open = null
  }
  return {
    reasoning(run) {
      if (open && open.run === run) return
      settle()
      const time = runs.get(run)
      // The same run resumed after an interruption: it is open again.
      if (time) delete time.end
      else runs.set(run, { start: now() })
      open = { run }
    },
    settle,
    time(run, own) {
      const time = runs.get(run)
      if (!time) return own
      const start = own?.start ?? time.start
      const end = own?.end ?? time.end
      return { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) }
    },
  }
}
