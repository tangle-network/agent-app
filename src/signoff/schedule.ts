/**
 * The dependency graph, and running it as wide as the graph allows.
 *
 * CI runs these steps in a line because a YAML `steps:` list is a line. Nothing
 * about the work requires that: typecheck, the suite, the build and knip all
 * read source and none reads another's output. On a 32-core host, running them
 * concurrently is free wall-clock, and it is the only reason a strictly larger
 * verification can still finish faster than the CI it replaces.
 *
 * The graph is declared per step (`needs`), validated here, and the schedule is
 * derived from it — so an omitted edge is a correctness bug the repo owns, and
 * a cycle is named rather than deadlocking.
 */

export interface GraphNode {
  readonly name: string
  readonly needs?: readonly string[]
}

/** Throws on a duplicate name, a dangling `needs`, or a cycle. */
export function validateGraph(nodes: readonly GraphNode[]): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.name)) throw new Error(`signoff: two steps are both named "${node.name}"; names must be unique`)
    seen.add(node.name)
  }
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      if (!seen.has(need)) {
        throw new Error(`signoff: step "${node.name}" needs "${need}", which is not a step in this config`)
      }
    }
  }

  const byName = new Map(nodes.map((node) => [node.name, node]))
  const state = new Map<string, 'visiting' | 'done'>()
  const walk = (name: string, path: readonly string[]): void => {
    const status = state.get(name)
    if (status === 'done') return
    if (status === 'visiting') {
      const cycle = [...path.slice(path.indexOf(name)), name].join(' -> ')
      throw new Error(`signoff: dependency cycle among steps: ${cycle}`)
    }
    state.set(name, 'visiting')
    for (const need of byName.get(name)?.needs ?? []) walk(need, [...path, name])
    state.set(name, 'done')
  }
  for (const node of nodes) walk(node.name, [])
}

export type TaskStatus = 'passed' | 'failed' | 'skipped' | 'cancelled' | 'blocked'

export interface TaskOutcome<T> {
  readonly name: string
  readonly status: TaskStatus
  /** Present for anything that actually ran, including a cancelled task. */
  readonly value: T | null
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
}

export interface RunGraphOptions<TNode extends GraphNode, TValue> {
  readonly nodes: readonly TNode[]
  readonly maxParallel: number
  /** `false` stops scheduling after the first failure and kills what is running. */
  readonly keepGoing: boolean
  /** Runs one node. Resolves `{ ok }` for pass/fail; must not throw for a
   *  failing command — a non-zero exit is data. */
  readonly run: (node: TNode, signal: AbortSignal) => Promise<{ readonly ok: boolean; readonly value: TValue }>
  /** Wall-clock origin, so outcomes are comparable across the whole run. */
  readonly now?: () => number
}

/**
 * Run the graph, honouring dependencies and the parallelism cap.
 *
 * Failure semantics, stated because they are the difference between a gate you
 * trust and one you argue with:
 *  - fail-fast (default): nothing new is scheduled, everything in flight is
 *    aborted and reported as `cancelled`, everything unstarted as `skipped`.
 *  - `keepGoing`: independent work continues, but a step whose dependency
 *    failed is reported `blocked`. It is never reported as passed, and never
 *    silently omitted.
 */
export async function runGraph<TNode extends GraphNode, TValue>(
  options: RunGraphOptions<TNode, TValue>,
): Promise<TaskOutcome<TValue>[]> {
  const { nodes, maxParallel, keepGoing, run, now = () => Date.now() } = options
  validateGraph(nodes)

  const origin = now()
  const outcomes = new Map<string, TaskOutcome<TValue>>()
  const pending = new Map(nodes.map((node) => [node.name, node]))
  const running = new Map<string, { readonly promise: Promise<void>; readonly controller: AbortController }>()
  let aborted = false

  const failedNames = new Set<string>()
  const passedNames = new Set<string>()

  const blockedBy = (node: TNode): boolean => (node.needs ?? []).some((need) => failedNames.has(need))
  const ready = (node: TNode): boolean => (node.needs ?? []).every((need) => passedNames.has(need))

  const settle = (name: string, outcome: TaskOutcome<TValue>): void => {
    outcomes.set(name, outcome)
    if (outcome.status === 'passed') passedNames.add(name)
    else failedNames.add(name)
  }

  const start = (node: TNode): void => {
    pending.delete(node.name)
    const controller = new AbortController()
    const startedAtMs = now() - origin
    const promise = run(node, controller.signal).then((result) => {
      const finishedAtMs = now() - origin
      const cancelled = controller.signal.aborted && !result.ok
      settle(node.name, {
        name: node.name,
        status: cancelled ? 'cancelled' : result.ok ? 'passed' : 'failed',
        value: result.value,
        startedAtMs,
        finishedAtMs,
      })
      running.delete(node.name)
    })
    running.set(node.name, { promise, controller })
  }

  for (;;) {
    if (!aborted) {
      // Drain everything the graph currently permits, up to the cap.
      for (const node of [...pending.values()]) {
        if (running.size >= maxParallel) break
        if (blockedBy(node)) {
          pending.delete(node.name)
          settle(node.name, { name: node.name, status: 'blocked', value: null, startedAtMs: null, finishedAtMs: null })
          continue
        }
        if (ready(node)) start(node)
      }
    }

    if (running.size === 0) {
      // Nothing running: either everything settled, or the rest is unreachable.
      if (pending.size === 0) break
      if (aborted) break
      // A pending node whose dependency neither passed nor failed cannot happen
      // after validateGraph, so anything left here is blocked or ready-next.
      const progressed = [...pending.values()].some((node) => ready(node) || blockedBy(node))
      if (!progressed) break
      continue
    }

    await Promise.race([...running.values()].map((entry) => entry.promise))

    if (!keepGoing && failedNames.size > 0 && !aborted) {
      aborted = true
      for (const entry of running.values()) entry.controller.abort()
    }
  }

  for (const node of pending.values()) {
    settle(node.name, {
      name: node.name,
      status: blockedBy(node) ? 'blocked' : 'skipped',
      value: null,
      startedAtMs: null,
      finishedAtMs: null,
    })
  }

  return nodes.map((node) => {
    const outcome = outcomes.get(node.name)
    if (!outcome) throw new Error(`signoff: step "${node.name}" produced no outcome — scheduler bug`)
    return outcome
  })
}
