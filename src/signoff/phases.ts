import { validateGraph } from './schedule'
import type { LoadedSignoffConfig, SignoffPhase } from './types'

/** One selector for the runner and consumers of declared step metadata. */
export function selectSignoffPhase(loaded: LoadedSignoffConfig, phase: SignoffPhase = 'all'): LoadedSignoffConfig {
  if (phase !== 'all' && phase !== 'release' && phase !== 'suites') {
    throw new Error(`signoff: phase must be all, release or suites, got "${phase}"`)
  }
  if (phase === 'all') return loaded
  const { steps } = loaded.config
  validateGraph(steps)
  const unclassified = steps.filter(step => step.phase === undefined)
  if (unclassified.length) {
    throw new Error(`signoff: partial phase ${phase} requires every step to be classified; missing phase: ${unclassified.map(step => step.name).join(', ')}`)
  }
  const byName = new Map(steps.map(step => [step.name, step]))
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      if (step.phase === 'release' && byName.get(need)?.phase === 'suites') {
        throw new Error(`signoff: release step "${step.name}" depends on suites step "${need}"`)
      }
    }
  }
  const requested = steps.filter(step => step.phase === phase).map(step => step.name)
  if (!requested.length) throw new Error(`signoff: no steps declared for ${phase} phase`)
  const selected = new Set<string>()
  const include = (name: string): void => {
    if (selected.has(name)) return
    selected.add(name)
    for (const need of byName.get(name)?.needs ?? []) include(need)
  }
  requested.forEach(include)
  const requestedNames = new Set(requested)
  return {
    ...loaded,
    config: { ...loaded.config, steps: steps.filter(step => selected.has(step.name)) },
    selection: {
      requested,
      prerequisites: steps.filter(step => selected.has(step.name) && !requestedNames.has(step.name)).map(step => step.name),
      excluded: steps.filter(step => !selected.has(step.name)).map(step => step.name),
    },
  }
}
