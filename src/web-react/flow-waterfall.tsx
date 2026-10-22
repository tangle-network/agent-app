import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FlowSpan, FlowTrace } from '../trace/flow-types'
import { spanFailed, spanRunning, visibleWaterfallRows, waterfallLayout } from './flow-waterfall-model'

const TONES: Record<FlowSpan['kind'] | 'failed', { label: string; color: string }> = {
  pipeline: { label: 'Orchestrator', color: 'fw-orchestrator' },
  model: { label: 'Model call', color: 'fw-model' },
  tool: { label: 'Tool call', color: 'fw-tool' },
  waiting: { label: 'Waiting', color: 'fw-waiting' },
  handoff: { label: 'Handoff', color: 'fw-handoff' },
  failed: { label: 'Failed', color: 'fw-failed' },
}
const SPEEDS = [0.5, 1, 1.5, 2, 4]
const controlClass = 'fw-control'
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

export interface FlowWaterfallProps {
  trace: FlowTrace
  /** Extend running spans between incoming snapshots. Inferred from span status by default. */
  live?: boolean
  /** Epoch-ms origin when the producer supplies one; otherwise advance from the latest snapshot. */
  startedAt?: number
  /** Accessible name also distinguishes multiple waterfalls on one page. */
  label?: string
  /** Fold all branches on first mount for large traces; search still reveals matches. */
  defaultCollapsed?: boolean
}

/** Shared trace inspector. Data remains producer-owned; playback only clips its presentation. */
export function FlowWaterfall({ trace, live, startedAt, label = 'Trace waterfall', defaultCollapsed = false }: FlowWaterfallProps) {
  const root = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(defaultCollapsed ? trace.spans.flatMap(span => span.parentId ? [span.parentId] : []) : []))
  const [speed, setSpeed] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(trace.totalMs)
  const isLive = live ?? trace.spans.some(spanRunning)

  useEffect(() => {
    setElapsed(trace.totalMs)
    if (!isLive) return
    const receivedAt = Date.now()
    const tick = () => setElapsed(Math.max(trace.totalMs, startedAt === undefined
      ? trace.totalMs + Date.now() - receivedAt : Date.now() - startedAt))
    tick()
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [trace, isLive, startedAt])

  const currentTrace = useMemo(() => {
    const totalMs = Math.max(trace.totalMs, isLive ? elapsed : 0,
      ...trace.spans.map(span => span.endMs))
    return { ...trace, totalMs, spans: trace.spans.map(span => isLive && spanRunning(span)
      ? { ...span, endMs: Math.max(span.endMs, totalMs) } : span) }
  }, [trace, elapsed, isLive])
  const totalMs = currentTrace.totalMs
  const playhead = Math.min(position ?? totalMs, totalMs)

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      const delta = (now - last) * speed
      last = now
      setPosition(previous => Math.min(totalMs, (previous ?? 0) + delta))
    }, 50)
    return () => clearInterval(timer)
  }, [playing, speed, totalMs])
  useEffect(() => { if (playing && position !== null && position >= totalMs) setPlaying(false) }, [position, playing, totalMs])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
      const active = document.activeElement
      const ownsFocus = root.current?.contains(active)
      const first = Array.from(document.querySelectorAll<HTMLElement>('[data-flow-waterfall]'))
        .find(element => element.getClientRects().length > 0)
      if (!ownsFocus && (active !== document.body || first !== root.current)) return
      event.preventDefault()
      search.current?.focus()
      search.current?.select()
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [])

  const rows = useMemo(() => waterfallLayout(currentTrace), [currentTrace])
  const visible = visibleWaterfallRows(rows, query, collapsed)
  const leaves = rows.filter(row => !row.hasChildren && row.kind !== 'pipeline')
  const slowest = leaves.reduce<typeof rows[number] | undefined>((best, row) =>
    !best || row.span.endMs - row.span.startMs > best.span.endMs - best.span.startMs ? row : best, undefined)
  const summary = [
    ['Duration', seconds(totalMs)],
    ['Cost', trace.costUsd === undefined ? 'Unknown' : `$${trace.costUsd.toFixed(trace.costUsd < 0.01 ? 6 : 4)}`],
    ['Tokens', (trace.promptTokens + trace.completionTokens).toLocaleString()],
    ['LLM calls', trace.modelCalls === undefined ? 'Unknown' : String(trace.modelCalls)],
    ['Tool calls', String(trace.toolCalls)],
    ['Errors', String(trace.errors ?? trace.spans.filter(spanFailed).length)],
  ]
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <section ref={root} data-flow-waterfall aria-label={label} className="fw-root">
      <div className="fw-heading">
        <div className="fw-title">
          {label}
          {isLive && <span className="fw-muted">Live</span>}
        </div>
        <div className="fw-search">
          <label htmlFor={searchId} className="fw-sr-only">Search trace</label>
          <input ref={search} id={searchId} type="search" value={query} placeholder="Search trace…" aria-keyshortcuts="Meta+f Control+f"
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') { setQuery(''); event.stopPropagation() }
            }} className={`${controlClass} fw-search-input`} />
          <button type="button" aria-label="Focus trace search" title="Search trace (⌘F / Ctrl+F)" onClick={() => search.current?.focus()} className={controlClass}>⌘F</button>
        </div>
      </div>
      <dl className="fw-summary">
        {summary.map(([name, value]) => <div key={name}>
          <dt className="fw-muted">{name}</dt>
          <dd className="fw-value" title={name === 'LLM calls' && trace.modelCalls === undefined ? 'Model output windows do not establish the number of LLM requests' : undefined}>{value}</dd>
        </div>)}
      </dl>
      <div className="fw-legend" aria-label="Span types">
        {Object.entries(TONES).map(([kind, tone]) => <span key={kind} className="fw-legend-item">
          <span aria-hidden className={`fw-dot ${tone.color}`} />{tone.label}
        </span>)}
      </div>
      {rows.some(row => row.hasChildren) && <div className="fw-branches">
        <button type="button" className={controlClass} onClick={() => setCollapsed(new Set())}>Expand all</button>
        <button type="button" className={controlClass} onClick={() => setCollapsed(new Set(rows.filter(row => row.hasChildren).map(row => row.id)))}>Collapse all</button>
      </div>}
      <div className="fw-timeline" role="region" aria-label="Trace timeline" tabIndex={0}>
        <div className="fw-track">
          <div className="fw-axis fw-grid">
            <span>Steps · {visible.length}/{rows.length}</span>
            <div className="fw-ticks"><span>0s</span><span>{seconds(totalMs / 2)}</span><span>{seconds(totalMs)}</span></div>
            <span className="fw-align-right">Duration</span>
          </div>
          {visible.length === 0 && <p role="status" className="fw-empty">
            {rows.length === 0 ? 'No spans yet. Waiting for trace events.' : `No matching steps for “${query}”.`}
          </p>}
          {visible.map(row => {
            const tone = !row.ok ? TONES.failed : TONES[row.kind]
            const width = Math.min(row.widthPct, Math.max(0, (playhead - Math.max(0, row.span.startMs)) / (totalMs || 1) * 100))
            const pending = row.span.startMs > playhead
            const running = spanRunning(row.span)
            return <div key={row.id} data-span-id={row.id} data-span-kind={!row.ok ? 'failed' : row.kind}
              data-slowest={row.id === slowest?.id || undefined}
              className={`fw-row fw-grid ${row.id === slowest?.id ? 'fw-slowest' : ''} ${pending ? 'fw-pending' : ''}`}>
              <div className="fw-name" style={{ paddingLeft: Math.min(row.depth, 8) * 12 }}>
                {row.hasChildren ? <button type="button" aria-label={`${collapsed.has(row.id) && !query ? 'Expand' : 'Collapse'} ${row.name}`}
                  aria-expanded={query ? true : !collapsed.has(row.id)} onClick={() => toggle(row.id)}
                  disabled={Boolean(query.trim())} className="fw-toggle">{collapsed.has(row.id) && !query ? '›' : '⌄'}</button>
                  : <span className="fw-leaf" aria-hidden>·</span>}
                <span title={`${row.name} · ${tone.label}${running ? ' · running' : ''}`} className="fw-span-name">
                  {row.name}{!row.ok && <span className="fw-error-text"> · failed</span>}{running && <span className="fw-muted"> · running</span>}
                </span>
              </div>
              <div className="fw-bar-track" title={`${tone.label} · ${seconds(row.span.startMs)} → ${seconds(row.span.endMs)}${row.approx ? ' · approximate' : ''}`}>
                <div className={`fw-bar ${tone.color} ${row.approx ? 'fw-approx' : ''}`}
                  style={{ left: `${row.offsetPct}%`, width: `${width}%` }} />
                {position !== null && <span className="fw-playhead" style={{ left: `${playhead / (totalMs || 1) * 100}%` }} />}
              </div>
              <span className="fw-duration" title={row.id === slowest?.id ? 'Slowest step' : undefined}>{row.durationLabel}</span>
            </div>
          })}
        </div>
      </div>
      {slowest && <p className="fw-slowest-caption">Slowest step: <span className="fw-text">{slowest.name}</span> · {slowest.durationLabel}</p>}
      <div className="fw-playback">
        <button type="button" className={controlClass} disabled={totalMs === 0} onClick={() => {
          if (playing) setPlaying(false)
          else { if (position === null || position >= totalMs) setPosition(0); setPlaying(true) }
        }}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" className={controlClass} disabled={totalMs === 0} onClick={() => { setPosition(0); setPlaying(false) }}>Restart</button>
        <label className="fw-speed">Speed
          <select aria-label="Playback speed" className={controlClass} value={speed} onChange={event => setSpeed(Number(event.target.value))}>
            {SPEEDS.map(value => <option key={value} value={value}>{value}x</option>)}
          </select>
        </label>
        <label className="fw-position">Position
          <input aria-label="Playback position" type="range" min={0} max={totalMs || 1} step="any" value={playhead} disabled={totalMs === 0}
            onChange={event => { setPosition(Number(event.target.value)); setPlaying(false) }} className="fw-slider" />
        </label>
        <output className="fw-time" aria-label="Playback time">{seconds(playhead)}</output>
        {position !== null && <button type="button" className={controlClass} onClick={() => { setPosition(null); setPlaying(false) }}>{isLive ? 'Follow live' : 'Show full trace'}</button>}
      </div>
    </section>
  )
}
