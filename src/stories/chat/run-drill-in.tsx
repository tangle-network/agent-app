/**
 * Story-only wiring for the tool row's "Open full transcript" action. In
 * production the host serves a persisted `ToolRunRecord` per `toolCallId`
 * (fail-closed: only ids its own loop created) and mounts `RunDrillIn` itself;
 * the stories have no server, so they synthesize the record from the call's
 * own args/result. That keeps the demo functional — the button opens the real
 * panel over the transcript — instead of dead-ending on a console.log.
 */
import { useState, type ReactNode } from 'react'
import { RunDrillIn, type ChatToolCallInfo, type ToolRunRecord } from '../../web-react'

/** Panel header: the command the run executed, or the humanized tool name. */
function titleOf(call: ChatToolCallInfo): string {
  if (call.name === 'sandbox_run_command' && typeof call.args?.command === 'string') {
    return `Ran ${call.args.command}`
  }
  return call.name.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** Synthesize the run record the drill-in renders, from the call itself. */
function runRecordFromCall(call: ChatToolCallInfo): ToolRunRecord {
  const envelope =
    typeof call.result === 'object' && call.result !== null
      ? (call.result as { ok?: boolean; result?: unknown; message?: string })
      : null
  const inner = (envelope?.result ?? {}) as { stdout?: string; stderr?: string }
  const failed = call.status === 'error' || envelope?.ok === false
  const detail = failed
    ? (envelope?.message ?? 'failed')
    : [inner.stdout, inner.stderr].filter(Boolean).join('\n') ||
      (envelope ? JSON.stringify(envelope.result, null, 2) : undefined)
  return {
    toolCallId: call.id,
    toolName: call.name,
    title: titleOf(call),
    status: call.status === 'running' ? 'running' : failed ? 'error' : 'complete',
    steps:
      call.status === 'running'
        ? []
        : [
            {
              at: new Date().toISOString(),
              label: typeof call.args?.command === 'string' ? call.args.command : call.name,
              ...(detail ? { detail } : {}),
              status: failed ? ('error' as const) : ('ok' as const),
            },
          ],
  }
}

/**
 * Wrap a ChatMessages story so `onToolCallClick` opens the real `RunDrillIn`
 * panel (and still logs, for parity with the other story hosts). The panel is
 * `fixed` against the canvas's right edge, exactly as `ChatControls/RunDrillIn
 * → Over transcript` mounts it.
 */
export function WithRunDrillIn({
  children,
}: {
  children: (onToolCallClick: (call: ChatToolCallInfo) => void) => ReactNode
}) {
  const [run, setRun] = useState<ToolRunRecord | null>(null)
  return (
    <>
      {children((call) => {
        console.log('open run transcript', call.id)
        setRun(runRecordFromCall(call))
      })}
      {run && <RunDrillIn run={run} onClose={() => setRun(null)} />}
    </>
  )
}
