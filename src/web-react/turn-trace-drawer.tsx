/**
 * A turn's own trace, for the member who owns it: the waterfall of the spans `routes.trace` serves (the turn receipt's
 * `traceUrl`) and the OTLP JSON to download, so a member can see where a turn's time went and hill-climb their own use.
 * The drawer reads the trace when it opens; a turn whose trace is not stored yet says so and reads again on request.
 */
import { FlowWaterfall, type FlowWaterfallProps } from '@tangle-network/charts/react'
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@tangle-network/ui/primitives'
import { Activity } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { turnTraceFlow, type TurnTraceFlow } from './turn-trace-flow'

type TraceState =
  | { status: 'loading' }
  | { status: 'absent'; message: string; retry: boolean }
  | { status: 'failed'; message: string }
  | { status: 'ready'; body: string; trace: TurnTraceFlow }

const NO_TRACE_YET = 'No trace for this turn yet. A trace is saved a few seconds after its turn finishes; older turns may have none.'

/** What a refusal means to the member, by the route's `code` (`routes.trace`). */
function absentState(code: unknown): TraceState {
  return code === 'turn_trace_unreadable'
    ? { status: 'absent', retry: false, message: 'This app does not keep turn traces.' }
    : { status: 'absent', retry: true, message: NO_TRACE_YET }
}

async function readTrace(traceUrl: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<TraceState> {
  const response = await fetchImpl(traceUrl, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
  const body = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { status: 'failed', message: 'The trace link did not answer with a trace.' }
  }
  if (response.status === 404) return absentState((parsed as { code?: unknown } | null)?.code)
  if (!response.ok) return { status: 'failed', message: `The trace could not be read (HTTP ${response.status}).` }
  const trace = turnTraceFlow(parsed)
  return trace ? { status: 'ready', body, trace } : absentState(undefined)
}

export interface TurnTraceDrawerProps {
  /** The turn receipt's `traceUrl`, or `turnTraceUrlForMessage` for a turn in history. */
  traceUrl: string
  open: boolean
  onOpenChange(open: boolean): void
  /** The control that opens it; focus returns there when the drawer closes. */
  trigger?: ReactElement
  /** Marks for span rows, e.g. sandbox-ui's `traceSpanMark`; the inspector draws a kind glyph without one. */
  renderIcon?: FlowWaterfallProps['renderIcon']
  /** Test seam; default `fetch` with the page's own session. */
  fetchImpl?: typeof fetch
}

const seconds = (ms: number | undefined) => (ms === undefined ? 'unknown' : `${(ms / 1000).toFixed(1)} s`)

/** The turn's headline numbers, each with its unit. */
function summaryLine(trace: TurnTraceFlow): string {
  return [
    `${seconds(trace.wallMs ?? trace.flow.totalMs)} in all`,
    `first output after ${seconds(trace.firstVisibleMs)}`,
    `first answer text after ${seconds(trace.firstTextMs)}`,
    ...(trace.coveragePct === undefined ? [] : [`${trace.coveragePct}% of the time inside a named step`]),
  ].join(' · ')
}

/** Save the JSON the route served, exactly as served. */
function download(body: string, traceId: string): void {
  const href = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href, download: `turn-${traceId}.otlp.json` })
  link.click()
  setTimeout(() => URL.revokeObjectURL(href), 0)
}

/** The turn's trace in a side sheet: its summary, the span waterfall, and its OTLP JSON to download. */
export function TurnTraceDrawer({ traceUrl, open, onOpenChange, trigger, renderIcon, fetchImpl }: TurnTraceDrawerProps) {
  const [state, setState] = useState<TraceState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // A parent that passes an inline fetch must not refetch on every render.
  const fetchRef = useRef(fetchImpl)
  fetchRef.current = fetchImpl
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setState({ status: 'loading' })
    readTrace(traceUrl, fetchRef.current ?? fetch, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setState(next) },
      () => {
        if (!controller.signal.aborted) setState({ status: 'failed', message: 'The trace could not be read. Check your connection and try again.' })
      },
    )
    return () => controller.abort()
  }, [open, traceUrl, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Turn trace</SheetTitle>
          <SheetDescription>
            {state.status === 'ready'
              ? summaryLine(state.trace)
              : 'Where this turn spent its time: each step, model call and tool call, on one clock.'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6" aria-live="polite">
          {state.status === 'loading' && <p className="text-sm text-muted-foreground">Reading the trace…</p>}
          {state.status === 'absent' && (
            <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
              <p>{state.message}</p>
              {state.retry && <Button variant="outline" size="sm" onClick={retry}>Read again</Button>}
            </div>
          )}
          {state.status === 'failed' && (
            <div className="flex flex-col items-start gap-2 text-sm">
              <p role="alert">{state.message}</p>
              <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
            </div>
          )}
          {state.status === 'ready' && (
            <>
              <div className="rounded-md border border-border bg-secondary p-2">
                <FlowWaterfall trace={state.trace.flow} defaultView="spans" {...(renderIcon ? { renderIcon } : {})} />
              </div>
              <div>
                <Button variant="outline" size="sm" onClick={() => download(state.body, state.trace.traceId)}>Download OTLP</Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export interface TurnTraceButtonProps extends Omit<TurnTraceDrawerProps, 'open' | 'onOpenChange' | 'trigger'> {
  label?: string
}

const TRACE_ACTION_CLASS = 'inline-flex items-center gap-1 rounded p-0.5 text-xs text-muted-foreground transition '
  + 'hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** A message action that opens the turn's trace: put it in `ChatMessages`' `renderExtras` or a product's message row. */
export function TurnTraceButton({ label = 'Trace', ...drawer }: TurnTraceButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <TurnTraceDrawer
      {...drawer}
      open={open}
      onOpenChange={setOpen}
      trigger={(
        <button type="button" title="Where this turn spent its time" className={TRACE_ACTION_CLASS}>
          <Activity className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
      )}
    />
  )
}
