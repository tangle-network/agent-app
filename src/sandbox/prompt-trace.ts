/**
 * What a sandbox prompt stream tells the turn's trace: one `sandbox.prompt`
 * span for the whole stream, the sidecar's own first-text phases as child
 * spans, one `sandbox.generation` span from the first visible text, and one
 * `tool.call` span for each tool the box agent ran.
 *
 * Every time here is read on this side of the wire, from when each event
 * arrived. Event arrival is quantized by the stream's chunking, so the tool
 * spans carry `approx: true`. The sidecar's phases are offsets on its own
 * clock; only their durations are used, and the wait that no phase holds (the
 * SDK, the API, the orchestrator and the host, both ways) is `sandbox.transit`.
 */
import type { TurnSpan, TurnSpanAttrs, TurnTrace } from '../turn-trace/recorder'
import { nextCallIndex } from '../turn-trace/traced-fetch'

type Rec = Record<string, unknown>
const asRec = (value: unknown): Rec | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined
const asNum = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** The sidecar's phase order, and what each one's span is called. */
const PHASES = ['agent_run_start', 'harness_spawn', 'harness_ready', 'first_model_request', 'first_upstream_byte', 'first_text'] as const

interface PromptTrace {
  /** Read one raw sandbox event. Never throws. */
  observe(event: unknown): void
  /** End the stream's spans. `error` marks the prompt failed. */
  end(error?: unknown): void
}

function createPromptTrace(trace: TurnTrace, parent: TurnSpan | undefined, meta: TurnSpanAttrs): PromptTrace {
  const startedAt = Date.now()
  const prompt = trace.start('sandbox.prompt', 'sandbox', meta, parent)
  let firstEventAt: number | undefined
  let firstTextAt: number | undefined
  let generation: TurnSpan | undefined
  let phases: { offsets: Rec; warm: boolean | null; model?: string } | undefined
  let events = 0
  const tools = new Map<string, TurnSpan>()

  const startTool = (id: string, name: string) => {
    if (tools.has(id)) return
    tools.set(id, trace.start('tool.call', 'tool', {
      'gen_ai.tool.name': name, 'tool.call_id': id, 'call.index': nextCallIndex(trace, 'tool.call'), where: 'sandbox', approx: true,
    }, generation ?? prompt))
  }

  const observe = (raw: unknown) => {
    try {
      const event = asRec(raw)
      if (!event) return
      const now = Date.now()
      events++
      firstEventAt ??= now
      const type = typeof event.type === 'string' ? event.type : ''
      const data = asRec(event.data)
      if (type === 'result') {
        const report = asRec(data?.firstTextPhases)
        const offsets = asRec(report?.phasesMs)
        if (offsets) {
          phases = {
            offsets,
            warm: typeof report?.harnessWarm === 'boolean' ? report.harnessWarm : null,
            ...(typeof report?.model === 'string' ? { model: report.model } : {}),
          }
        }
        return
      }
      if (type === 'tool_call' || type === 'tool.call') {
        const id = String(data?.id ?? data?.callId ?? data?.callID ?? data?.name ?? '')
        if (id) startTool(id, String(data?.name ?? data?.tool ?? 'tool'))
        return
      }
      if (type === 'tool_result' || type === 'tool.result') {
        const id = String(data?.id ?? data?.callId ?? data?.callID ?? data?.name ?? '')
        tools.get(id)?.end(undefined, data?.error ?? (data?.status === 'error' ? 'tool_error' : undefined))
        return
      }
      if (type !== 'message.part.updated') return
      const part = asRec(data?.part)
      const partType = String(part?.type ?? '')
      if (partType === 'text' && firstTextAt === undefined && ((typeof data?.delta === 'string' && data.delta) || (typeof part?.text === 'string' && part.text))) {
        firstTextAt = now
        generation = prompt.child('sandbox.generation', 'model')
      } else if (partType === 'tool') {
        const id = String(part?.id ?? part?.callID ?? '')
        if (!id) return
        const state = asRec(part?.state)
        const status = String(state?.status ?? part?.status ?? '')
        startTool(id, String(part?.tool ?? 'tool'))
        if (status === 'completed' || status === 'error') tools.get(id)?.end(undefined, status === 'error' ? 'tool_error' : undefined)
      }
    } catch {
      // Telemetry never fails a turn.
    }
  }

  const end = (error?: unknown) => {
    try {
      // A tool the stream never closed ended with the stream.
      for (const span of tools.values()) span.end({ 'tool.unclosed': true })
      generation?.end()
      if (phases && firstTextAt !== undefined) {
        const firstText = asNum(phases.offsets.first_text)
        // The sidecar's clock starts at `turn_received`; its first text frame is the one this side saw at `firstTextAt`.
        if (firstText !== undefined && firstTextAt - firstText >= startedAt) {
          const origin = firstTextAt - firstText
          prompt.record('sandbox.transit', 'sandbox', startedAt, origin, { note: 'sdk, api, orchestrator and host hops, both ways' })
          let previous = 0
          for (const phase of PHASES) {
            const offset = asNum(phases.offsets[phase])
            if (offset === undefined || offset < previous) continue
            // The provider's first byte is model time; the harness steps before it are the box's.
            prompt.record(`sidecar.${phase}`, phase === 'first_upstream_byte' || phase === 'first_text' ? 'model' : 'sandbox', origin + previous, origin + offset)
            previous = offset
          }
        }
      }
      prompt.set({
        events,
        ...(firstEventAt !== undefined ? { first_event_ms: firstEventAt - startedAt } : {}),
        ...(firstTextAt !== undefined ? { first_text_ms: firstTextAt - startedAt } : {}),
        ...(phases?.warm !== null && phases?.warm !== undefined ? { 'sidecar.harness_warm': phases.warm } : {}),
        ...(phases?.model ? { 'sidecar.model': phases.model } : {}),
        ...Object.fromEntries(PHASES.flatMap((phase) => {
          const offset = asNum(phases?.offsets[phase])
          return offset === undefined ? [] : [[`sidecar.${phase}_ms`, Math.round(offset)]]
        })),
      })
      prompt.end(undefined, error)
    } catch {
      // Telemetry never fails a turn.
    }
  }

  return { observe, end }
}

export interface TraceSandboxPromptOptions {
  trace: TurnTrace
  /** The span the prompt hangs from. Default: the trace's root. */
  parent?: TurnSpan
  /** Attributes for the `sandbox.prompt` span: the sandbox id, the model, the harness. */
  meta?: TurnSpanAttrs
}

/**
 * Pass a sandbox prompt stream through unchanged while recording it in the turn's trace (see {@link createPromptTrace}).
 * `streamSandboxPrompt` does this itself when given a `trace`; a product that calls `box.streamPrompt` directly wraps
 * its stream here, and sends `trace.traceId` as the prompt's `traceId` so the Sandbox API records join the turn.
 */
export async function* traceSandboxPromptEvents(events: AsyncIterable<unknown>, options: TraceSandboxPromptOptions): AsyncGenerator<unknown> {
  const prompt = createPromptTrace(options.trace, options.parent, options.meta ?? {})
  let failure: unknown
  try {
    for await (const event of events) {
      prompt.observe(event)
      yield event
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    prompt.end(failure)
  }
}
