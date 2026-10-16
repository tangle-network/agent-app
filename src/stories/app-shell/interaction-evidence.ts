import { useEffect, useRef } from 'react'

const roles = ['--interaction-feedback-budget', '--interaction-pending-delay', '--interaction-long-work-delay', '--interaction-mutation-budget'] as const
const interactionProtocol = {
  batches: 2,
  attemptsPerBatch: 40,
  conditions: ['normal', 'interrupted', 'reduced-motion'],
  cacheStates: ['cold', 'warm'],
  selection: 'Consecutive browser input starts; retain failures and identify capture exclusions before replacement.',
  percentile: 'Sorted nearest rank ceil(p * n); separate action, condition, batch and cold/warm context.',
  cold: 'New browser context without application cache.',
  warm: 'Same loaded workflow after initialization.',
  spacing: 'Reset the workflow and settle its visible state before the next declared attempt.',
  observationWindow: 'Maximum computed interaction role time on the input target; missing or invalid roles retain an unresolved sample without observation.',
  presentation: 'DOM state and frame callbacks are bounds, not a presented-frame measurement. Calibrated trace/recording evidence is required.',
} as const

type Batch = { condition: typeof interactionProtocol.conditions[number]; cache: 'cold' | 'warm'; batch: number }
type Sample = {
  attempt: number; action: string; inputStart: number; handlerStart: number
  batch: Batch | null; domObserved?: number; frameBefore?: number; frameAfter?: number
  elapsedBoundsMs?: [number, number]; feedbackBudgetMs: number | null
  roleReadings: ReturnType<typeof readRoles>; observationWindowMs?: number
  anchorBefore?: { id: string; top: number; lineHeight: number }; anchorAfterTop?: number
  status: 'UNCHECKED'; reason: string
}
function timeMs(raw: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s)$/.exec(raw.trim())
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : null
}
function readRoles(target: Element = document.documentElement) {
  const style = getComputedStyle(target)
  return Object.fromEntries(roles.map(role => [role, { css: style.getPropertyValue(role).trim(), ms: timeMs(style.getPropertyValue(role)) }]))
}
function nameOf(node: HTMLElement): string {
  const labelledBy = node.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ')
  const nativeLabel = (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) ? Array.from(node.labels ?? []).map(label => label.textContent?.trim()).filter(Boolean).join(' ') : ''
  return node.getAttribute('aria-label') || labelledBy || nativeLabel || node.textContent?.trim() || node.id || node.tagName.toLowerCase()
}
function intendedChange(target: HTMLElement, event: Event): { action: string; changed: () => boolean } | null {
  const expanded = target.getAttribute('aria-expanded')
  if (expanded !== null) return { action: `disclosure:${nameOf(target)}`, changed: () => target.getAttribute('aria-expanded') !== expanded }
  if (event.type === 'input') return { action: `field:${nameOf(target)}`, changed: () => true }
  if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) return { action: 'control:checked-state', changed: () => true }
  const dialog = target.closest('[role="dialog"]')
  if (event instanceof KeyboardEvent && event.key === 'Escape') {
    if (!dialog) return null
    if (dialog?.getAttribute('aria-busy') === 'true') return { action: 'dialog:busy-dismiss-guard', changed: () => dialog.isConnected }
    return { action: 'dialog:escape', changed: () => !dialog?.isConnected }
  }
  if (target.getAttribute('role') === 'gridcell') return { action: 'grid:edit', changed: () => !!target.querySelector('input,textarea,select') }
  const text = nameOf(target)
  if (text === 'Rename profile') return { action: 'dialog:open', changed: () => !!document.querySelector('[role="dialog"]') }
  if (dialog && (text === 'Save' || text === 'Cancel')) return { action: `dialog:${text.toLowerCase()}`, changed: () => !dialog.isConnected }
  const original = target.textContent
  return { action: `control:${text}`, changed: () => !target.isConnected || target.textContent !== original || target.hasAttribute('disabled') }
}

/** The catalog owns these observations; capture scripts only export them. */
export function useInteractionEvidence() {
  const root = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const samples: Sample[] = []
    let batch: Batch | null = null
    let disposed = false
    const timeoutIds = new Set<number>()
    const frameIds = new Set<number>()
    const observers = new Set<MutationObserver>()
    const summaries = () => {
      const groups = new Map<string, Sample[]>()
      for (const sample of samples) {
        const key = JSON.stringify([sample.action, sample.batch]); groups.set(key, [...(groups.get(key) ?? []), sample])
      }
      return [...groups].map(([key, group]) => {
        const observed = group.flatMap(sample => sample.elapsedBoundsMs ? [sample.elapsedBoundsMs[1]] : []).sort((a, b) => a - b)
        const unresolved = group.length - observed.length
        const percentile = (p: number) => !unresolved && observed.length ? observed[Math.ceil(p * observed.length) - 1] : null
        return { group: JSON.parse(key), attempted: group.length, unresolved, candidateUpperBoundP50Ms: percentile(.5), candidateUpperBoundP95Ms: percentile(.95), candidateUpperBoundMaxMs: unresolved ? null : observed.at(-1) ?? null, status: 'UNCHECKED', reason: unresolved ? 'Incomplete population: percentile and maximum summaries suppressed; unresolved attempts are retained.' : 'Candidate frame bounds require calibrated presented-frame evidence.' }
      })
    }
    const api = {
      protocol: interactionProtocol,
      declareBatch(next: Batch) {
        if (!interactionProtocol.conditions.includes(next.condition) || !interactionProtocol.cacheStates.includes(next.cache) || !Number.isInteger(next.batch) || next.batch < 1 || next.batch > interactionProtocol.batches) throw new Error('Batch must follow the declared catalog protocol')
        batch = { ...next }
      },
      snapshot() {
        return { protocol: interactionProtocol, roles: readRoles(), batch, samples: samples.map(sample => ({ ...sample })), summaries: summaries(),
          environment: { browser: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches },
          calibration: { status: 'UNCHECKED', next: 'Run the deliberately delayed fixture and correlate DOM/frame bounds with calibrated traces and recording frames.' },
          sourceRevision: 'UNCHECKED until attached to the catalog manifest or exact gate receipt',
          installedBrandRevision: 'UNCHECKED until attached from the frozen dependency/release receipt',
        }
      },
      async calibrate() {
        const indicator = root.current?.querySelector<HTMLElement>('[data-design-calibration]')
        if (!indicator) return { status: 'UNCHECKED', reason: 'Visible calibration fixture missing.' }
        const budget = readRoles(indicator)['--interaction-feedback-budget']?.ms
        if (budget == null) return { status: 'UNCHECKED', reason: 'Installed CSS feedback role is missing or not an explicit CSS time.' }
        indicator.hidden = false
        indicator.textContent = 'Calibration waiting'
        const start = performance.now()
        await new Promise(resolve => setTimeout(resolve, budget * 2))
        if (disposed) return { status: 'UNCHECKED', reason: 'Calibration fixture unmounted before the delayed change.' }
        indicator.textContent = 'Calibration changed'
        const domObserved = performance.now()
        await new Promise<number>(requestAnimationFrame)
        if (disposed) return { status: 'UNCHECKED', reason: 'Calibration fixture unmounted before the final frame callback.' }
        const frameAfter = await new Promise<number>(requestAnimationFrame)
        return { status: 'UNCHECKED', role: '--interaction-feedback-budget', css: readRoles(indicator)['--interaction-feedback-budget']?.css, inputStart: start, domObserved, frameAfter,
          clockCheck: domObserved - start >= budget * 2 ? 'PASS' : 'FAIL', reason: 'Clock calibration is separate from presented-frame calibration; inspect the retained trace/video.' }
      },
    }
    const capture = (event: Event) => {
      const handlerStart = performance.now()
      if (disposed || !(event.target instanceof Element)) return
      const target = event.target.closest<HTMLElement>('button,input,textarea,select,[role="gridcell"]')
      if (!target || !(root.current?.contains(target) || target.closest('[role="dialog"]'))) return
      if (event instanceof KeyboardEvent && !(event.key === 'Escape' || (event.key === 'Enter' && target.matches('input,textarea')))) return
      const intent = intendedChange(target, event)
      const inputStart = event.timeStamp > performance.timeOrigin ? event.timeStamp - performance.timeOrigin : event.timeStamp
      const roleReadings = readRoles(target)
      const sample: Sample = { attempt: samples.length + 1, action: intent?.action ?? `unmapped:${event.type}:${nameOf(target)}`, inputStart, handlerStart, batch: batch && { ...batch }, roleReadings, feedbackBudgetMs: roleReadings['--interaction-feedback-budget']?.ms ?? null,
        status: 'UNCHECKED', reason: 'No relevant presented frame has been calibrated. Missing changes remain in the sample population.' }
      const anchor = root.current?.querySelector<HTMLElement>('[data-design-anchor]')
      if (anchor) sample.anchorBefore = { id: anchor.dataset.designAnchor ?? '', top: anchor.getBoundingClientRect().top, lineHeight: parseFloat(getComputedStyle(anchor).lineHeight) }
      samples.push(sample)
      if (!intent) {
        sample.reason = 'Unmapped input retained without observation; no relevant-feedback predicate is defined.'
        return
      }
      const roleTimes = roles.map(role => roleReadings[role]?.ms)
      if (roleTimes.some(time => time == null)) {
        sample.reason = 'Input retained without observation: a computed interaction role on its target is absent or invalid.'
        return
      }
      sample.observationWindowMs = Math.max(...roleTimes as number[])
      let timeoutId: number | undefined
      let watching = true
      const finish = () => {
        watching = false
        observer.disconnect(); observers.delete(observer)
        if (timeoutId !== undefined) { window.clearTimeout(timeoutId); timeoutIds.delete(timeoutId) }
      }
      const observe = () => {
        if (disposed || !watching || !intent.changed() || sample.domObserved !== undefined) return
        sample.domObserved = performance.now()
        finish()
        const first = requestAnimationFrame(before => {
          frameIds.delete(first); if (disposed) return
          sample.frameBefore = before
          const second = requestAnimationFrame(after => {
            frameIds.delete(second); if (disposed) return
            sample.frameAfter = after
            if (anchor?.isConnected) sample.anchorAfterTop = anchor.getBoundingClientRect().top
            sample.elapsedBoundsMs = [Math.max(0, sample.domObserved! - inputStart), Math.max(0, after - inputStart)]
          }); frameIds.add(second)
        }); frameIds.add(first)
      }
      const observer = new MutationObserver(observe)
      observers.add(observer); observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
      timeoutId = window.setTimeout(() => {
        finish()
        sample.reason = 'No relevant state observed within the computed role-backed observation window; unresolved input retained.'
      }, sample.observationWindowMs)
      timeoutIds.add(timeoutId)
      queueMicrotask(observe)
    }
    window.__agentAppInteractionEvidence = api
    document.addEventListener('click', capture, true)
    document.addEventListener('input', capture, true)
    document.addEventListener('keydown', capture, true)
    return () => {
      disposed = true
      document.removeEventListener('click', capture, true); document.removeEventListener('input', capture, true); document.removeEventListener('keydown', capture, true)
      for (const id of frameIds) cancelAnimationFrame(id)
      for (const observer of observers) observer.disconnect()
      for (const id of timeoutIds) window.clearTimeout(id)
      if (window.__agentAppInteractionEvidence === api) delete window.__agentAppInteractionEvidence
    }
  }, [])
  return root
}

declare global {
  interface Window { __agentAppInteractionEvidence?: {
    protocol: typeof interactionProtocol
    declareBatch(batch: Batch): void
    snapshot(): unknown
    calibrate(): Promise<unknown>
  } }
}
