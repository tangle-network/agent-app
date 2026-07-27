// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useTurnRecovery } from '../../src/web-react/use-turn-recovery'
import type { RecoveredTurnEvent } from '../../src/web-react/turn-recovery'

const textLine = (seq: number, text: string) =>
  JSON.stringify({ seq, kind: 'event', event: { type: 'text', text } })
const sentinel = (status: 'complete' | 'error') =>
  JSON.stringify({ type: 'turn_status', status })

function ndjson(lines: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= lines.length) return controller.close()
        controller.enqueue(encoder.encode(`${lines[i]}\n`))
        i += 1
      },
    }),
  )
}

const FAST = {
  liveSilenceTimeoutMs: 40,
  settlePollIntervalMs: 5,
  livenessPollTicks: 2,
  reconnectDelayMs: 5,
}

function harness(overrides: Partial<Parameters<typeof useTurnRecovery>[0]> = {}) {
  const events: RecoveredTurnEvent[] = []
  const options = {
    scopeKey: 'thread-1',
    listRunning: vi.fn(async () => ['turn-live']),
    openReplay: vi.fn(async () => ndjson([textLine(1, 'recovered'), sentinel('complete')])),
    onEvent: (e: RecoveredTurnEvent) => events.push(e),
    timings: FAST,
    ...overrides,
  } as Parameters<typeof useTurnRecovery>[0]
  return { options, events }
}

describe('useTurnRecovery', () => {
  it('discovers a running turn on mount and re-attaches to it', async () => {
    const { options, events } = harness()
    const { result } = renderHook(() => useTurnRecovery(options))

    await waitFor(() => expect(result.current.discovery).toBe('ready'))
    await waitFor(() => expect(result.current.following).toBe(false))

    expect(options.openReplay).toHaveBeenCalledTimes(1)
    expect(events.map((e) => e.type)).toEqual(['text'])
    cleanup()
  })

  it('reports no running turn as ready, and never opens a replay', async () => {
    const { options } = harness({ listRunning: vi.fn(async () => []) })
    const { result } = renderHook(() => useTurnRecovery(options))

    await waitFor(() => expect(result.current.discovery).toBe('ready'))
    expect(options.openReplay).not.toHaveBeenCalled()
    expect(result.current.activeTurnId).toBeNull()
    cleanup()
  })

  it('distinguishes a failed probe from an empty one', async () => {
    // Legal gates its composer on exactly this difference.
    const onDiscoveryError = vi.fn()
    const { options } = harness({
      listRunning: vi.fn(async () => {
        throw new Error('HTTP 503')
      }),
      onDiscoveryError,
    })
    const { result } = renderHook(() => useTurnRecovery(options))

    await waitFor(() => expect(result.current.discovery).toBe('failed'))
    expect(onDiscoveryError).toHaveBeenCalledWith('HTTP 503')
    expect(options.openReplay).not.toHaveBeenCalled()
    cleanup()
  })

  it('never steals a turn a local POST already owns', async () => {
    const { options } = harness({ isTurnOwnedLocally: () => true })
    const { result } = renderHook(() => useTurnRecovery(options))

    await waitFor(() => expect(result.current.discovery).toBe('ready'))
    // Discovery found a turn, but the POST owns it — attaching would render the
    // transcript twice.
    expect(options.openReplay).not.toHaveBeenCalled()
    expect(result.current.following).toBe(false)
    cleanup()
  })

  it('re-probes when the scope changes', async () => {
    const listRunning = vi.fn(async () => [])
    const { options } = harness({ listRunning })
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useTurnRecovery({ ...options, scopeKey }),
      { initialProps: { scopeKey: 'thread-1' } },
    )

    await waitFor(() => expect(result.current.discovery).toBe('ready'))
    expect(listRunning).toHaveBeenCalledTimes(1)

    rerender({ scopeKey: 'thread-2' })
    await waitFor(() => expect(listRunning).toHaveBeenCalledTimes(2))
    cleanup()
  })

  it('stays idle when disabled or unscoped', async () => {
    const { options } = harness({ scopeKey: null })
    const { result } = renderHook(() => useTurnRecovery(options))
    await waitFor(() => expect(result.current.discovery).toBe('idle'))
    expect(options.listRunning).not.toHaveBeenCalled()
    cleanup()
  })

  it('follows a turn handed over from a POST that ended early', async () => {
    const { options, events } = harness({ listRunning: vi.fn(async () => []) })
    const { result } = renderHook(() => useTurnRecovery(options))
    await waitFor(() => expect(result.current.discovery).toBe('ready'))

    act(() => result.current.follow('turn-handoff'))
    await waitFor(() => expect(result.current.following).toBe(false))

    expect(options.openReplay).toHaveBeenCalledTimes(1)
    expect(options.openReplay).toHaveBeenCalledWith('turn-handoff', 0, expect.anything())
    expect(events).toHaveLength(1)
    cleanup()
  })

  it('reports the settled result', async () => {
    const onTurnSettled = vi.fn()
    const { options } = harness({ onTurnSettled })
    renderHook(() => useTurnRecovery(options))

    await waitFor(() => expect(onTurnSettled).toHaveBeenCalledTimes(1))
    expect(onTurnSettled.mock.calls[0]![0]).toMatchObject({
      turnId: 'turn-live',
      lane: 'durable',
      status: 'complete',
    })
    cleanup()
  })

  it('stops forwarding events after unmount', async () => {
    // A window that never terminates, so the follow is still live at unmount.
    const { options, events } = harness({
      openReplay: vi.fn(async () => ndjson([textLine(1, 'first')])),
      listRunning: vi.fn(async () => ['turn-live']),
    })
    const { result, unmount } = renderHook(() => useTurnRecovery(options))
    await waitFor(() => expect(events.length).toBeGreaterThan(0))
    expect(result.current.following).toBe(true)

    unmount()
    const seen = events.length
    await new Promise((r) => setTimeout(r, 60))
    expect(events.length).toBe(seen)
    cleanup()
  })

  it('stop() abandons the follow without unmounting', async () => {
    const { options, events } = harness({
      openReplay: vi.fn(async () => ndjson([textLine(1, 'first')])),
      listRunning: vi.fn(async () => ['turn-live']),
    })
    const { result } = renderHook(() => useTurnRecovery(options))
    await waitFor(() => expect(result.current.following).toBe(true))

    act(() => result.current.stop())
    await waitFor(() => expect(result.current.following).toBe(false))
    const seen = events.length
    await new Promise((r) => setTimeout(r, 40))
    expect(events.length).toBe(seen)
    cleanup()
  })
})
