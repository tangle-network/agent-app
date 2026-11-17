/**
 * A turn's own trace, for the member who owns it: the waterfall of the spans `routes.trace` serves (the turn receipt's
 * `traceUrl`) and the OTLP JSON to download, so a member can see where a turn's time went and hill-climb their own use.
 * The drawer reads the trace when it opens; a turn whose trace is not exported yet says so and reads again on request.
 */
import { FlowWaterfall, type FlowWaterfallProps } from '@tangle-network/charts/react'
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tangle-network/ui/primitives'
import { Activity } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { turnTraceFlow, type TurnTraceFlow } from './turn-trace-flow'

type TraceState =
  | { status: 'loading' }
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; body: string; trace: TurnTraceFlow }

export interface TurnTraceDrawerProps {
  /** The turn receipt's `traceUrl`, or `turnTraceUrlForMessage` for a turn in history. */
  traceUrl: string
  open: boolean
  onOpenChange(open: boolean): void
  /** Marks for span rows, e.g. sandbox-ui's `traceSpanMark`; the inspector draws a kind glyph without one. */
  renderIcon?: FlowWaterfallProps['renderIcon']
  /** Test seam; default `fetch` with the page's own session. */
  fetchImpl?: typeof fetch
}

const seconds = (ms: number | undefined) => (ms === undefined ? 'unknown' : `${(ms / 1000).toFixed(1)} s`)

/** The turn's trace in a side sheet: its summary, the span waterfall, and its OTLP JSON to download. */
export function TurnTraceDrawer({ traceUrl, open, onOpenChange, renderIcon, fetchImpl }: TurnTraceDrawerProps) {
  const [state, setState] = useState<TraceState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setState({ status: 'loading' })
    void (async () => {
      try {
        const response = await (fetchImpl ?? fetch)(traceUrl, {
          credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal,
        })
        if (response.status === 404) return setState({ status: 'pending' })
        if (!response.ok) return setState({ status: 'failed', message: `The trace could not be read (HTTP ${response.status}).` })
        const body = await response.text()
        const trace = turnTraceFlow(JSON.parse(body))
        setState(trace ? { status: 'ready', body, trace } : { status: 'pending' })
      } catch {
        if (!controller.signal.aborted) setState({ status: 'failed', message: 'The trace could not be read. Check your connection and try again.' })
      }
    })()
    return () => controller.abort()
  }, [open, traceUrl, fetchImpl, attempt])

  const downloadHref = useMemo(
    () => (state.status === 'ready' ? URL.createObjectURL(new Blob([state.body], { type: 'application/json' })) : null),
    [state],
  )
  useEffect(() => () => { if (downloadHref) URL.revokeObjectURL(downloadHref) }, [downloadHref])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Turn trace</SheetTitle>
          <SheetDescription>
            {state.status === 'ready'
              ? `${seconds(state.trace.wallMs ?? state.trace.flow.totalMs)} in all · first output after ${seconds(state.trace.firstVisibleMs)} · first answer text after ${seconds(state.trace.firstTextMs)}${state.trace.coveragePct === undefined ? '' : ` · ${state.trace.coveragePct}% of the time inside a named step`}`
              : 'Where this turn spent its time: each step, model call and tool call, on one clock.'}
          </SheetDescription>
        </SheetHeader>
        {state.status === 'loading' && <p className="text-sm text-muted-foreground">Reading the trace…</p>}
        {state.status === 'pending' && (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
            <p>This turn's trace is not stored yet. It is saved a few seconds after the turn finishes.</p>
            <Button variant="outline" size="sm" onClick={retry}>Read again</Button>
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
              <Button asChild variant="outline" size="sm">
                <a href={downloadHref ?? undefined} download={`turn-${state.trace.traceId}.otlp.json`}>Download OTLP</a>
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export interface TurnTraceButtonProps extends Omit<TurnTraceDrawerProps, 'open' | 'onOpenChange'> {
  label?: string
}

/** A message action that opens the turn's trace: put it in `ChatMessages`' `renderExtras` or a product's message row. */
export function TurnTraceButton({ label = 'Trace', ...drawer }: TurnTraceButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open this turn's trace"
        title="Open this turn's trace"
        className="inline-flex items-center gap-1 rounded p-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Activity className="h-3.5 w-3.5" aria-hidden />
        {label}
      </button>
      <TurnTraceDrawer {...drawer} open={open} onOpenChange={setOpen} />
    </>
  )
}
