/**
 * React lifecycle around `followTurn` (`./turn-recovery`): discover a turn
 * already running when the page mounts, re-attach to it, and tear everything
 * down on unmount or a scope change.
 *
 * The hook owns LIFECYCLE only — aborts, staleness guards, the discovery state
 * machine, and the guard that stops discovery stealing a turn a local POST
 * already owns. It owns NO turn state: parts, text, reasoning and tool chips
 * stay in the product's reducer, because that vocabulary is the product's.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  discoverRunningTurn,
  followTurn,
  type FollowTurnOptions,
  type FollowTurnResult,
  type LiveLaneConnector,
  type RecoveredTurnEvent,
  type TurnResetReason,
} from './turn-recovery'

/**
 * Where the page-load probe got to.
 *
 * `failed` is deliberately distinct from `ready`-with-no-turn: a product that
 * gates its composer on the probe must be able to tell "nothing is running"
 * from "I could not ask".
 */
export type TurnDiscoveryState = 'idle' | 'probing' | 'ready' | 'failed'

/** Timing knobs forwarded verbatim to `followTurn`. */
export type TurnRecoveryTimings = Pick<
  FollowTurnOptions,
  'liveSilenceTimeoutMs' | 'settlePollIntervalMs' | 'livenessPollTicks' | 'reconnectDelayMs'
>

/** Configure page-load turn recovery for one chat scope. */
export interface UseTurnRecoveryOptions {
  /**
   * The scope this hook is following — a threadId, a sessionId, or a composite
   * key. Opaque on purpose: products scope turns differently and the hook never
   * needs to parse it. Changing it aborts the current follow and re-probes;
   * `null` disables the hook entirely.
   */
  scopeKey: string | null
  /** `GET …/running` → running turn ids, newest first. */
  listRunning(signal: AbortSignal): Promise<string[]>
  /** `GET …/replay/:turnId?fromSeq=` → the durable NDJSON window. */
  openReplay(turnId: string, fromSeq: number, signal: AbortSignal): Promise<Response>
  /** Optional live lane — omit for durable-only recovery. */
  attachLive?: LiveLaneConnector
  onEvent(event: RecoveredTurnEvent): void
  /** Discard accumulated turn state before a lane switch or a from-zero replay. */
  onResetTurn?(reason: TurnResetReason): void
  onTurnStart?(turnId: string): void
  onTurnSettled?(result: FollowTurnResult): void
  /** Probe failure. Never thrown — products differ on whether it is user-visible. */
  onDiscoveryError?(error: string): void
  /**
   * Return true while a local POST owns the turn. Discovery must not attach to
   * a turn the page is already streaming, or the transcript renders twice.
   */
  isTurnOwnedLocally?(): boolean
  /** Probe on mount. Default true. */
  discoverOnMount?: boolean
  enabled?: boolean
  timings?: TurnRecoveryTimings
}

/** What the hook exposes to the chat surface. */
export interface UseTurnRecoveryResult {
  discovery: TurnDiscoveryState
  /** The turn currently being followed, if any. */
  activeTurnId: string | null
  following: boolean
  /**
   * Follow a turn explicitly — the hand-off for a POST whose own request ended
   * before the run did. No-ops while a local POST still owns the turn.
   */
  follow(turnId: string): void
  /** Abandon the current follow without unmounting. */
  stop(): void
}

/** Discover and re-attach to a turn already running in this scope */
export function useTurnRecovery(options: UseTurnRecoveryOptions): UseTurnRecoveryResult {
  const { scopeKey, enabled = true, discoverOnMount = true } = options

  const [discovery, setDiscovery] = useState<TurnDiscoveryState>('idle')
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)

  // Options change on nearly every render (inline callbacks are the house
  // style), so the effect must not depend on them — it reads the CURRENT ones
  // through a ref instead, keyed only on the scope.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  /** Bumped per scope; a follow from a previous scope must not write state. */
  const generationRef = useRef(0)

  const runFollow = useCallback(async (turnId: string, generation: number) => {
    const current = optionsRef.current
    if (!turnId || current.isTurnOwnedLocally?.()) return
    if (!mountedRef.current || generation !== generationRef.current) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setActiveTurnId(turnId)
    setFollowing(true)
    current.onTurnStart?.(turnId)

    let result: FollowTurnResult | null = null
    try {
      result = await followTurn({
        turnId,
        signal: controller.signal,
        listRunning: (signal) => optionsRef.current.listRunning(signal),
        openReplay: (id, fromSeq, signal) => optionsRef.current.openReplay(id, fromSeq, signal),
        ...(current.attachLive ? { attachLive: current.attachLive } : {}),
        onEvent: (event) => optionsRef.current.onEvent(event),
        onResetTurn: (reason) => optionsRef.current.onResetTurn?.(reason),
        ...current.timings,
      })
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setFollowing(false)
        setActiveTurnId(null)
      }
      if (abortRef.current === controller) abortRef.current = null
    }

    if (result && mountedRef.current && generation === generationRef.current) {
      optionsRef.current.onTurnSettled?.(result)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current

    // A scope change abandons whatever the previous scope was following.
    abortRef.current?.abort()
    abortRef.current = null
    setFollowing(false)
    setActiveTurnId(null)

    if (!enabled || !scopeKey || !discoverOnMount) {
      setDiscovery('idle')
      return
    }

    setDiscovery('probing')
    const probe = new AbortController()

    void (async () => {
      const result = await discoverRunningTurn(
        (signal) => optionsRef.current.listRunning(signal),
        probe.signal,
      )
      if (probe.signal.aborted || !mountedRef.current || generation !== generationRef.current) {
        return
      }
      if (!result.succeeded) {
        setDiscovery('failed')
        optionsRef.current.onDiscoveryError?.(result.error)
        return
      }
      setDiscovery('ready')
      if (result.turnId) void runFollow(result.turnId, generation)
    })()

    return () => probe.abort()
  }, [scopeKey, enabled, discoverOnMount, runFollow])

  const follow = useCallback(
    (turnId: string) => {
      void runFollow(turnId, generationRef.current)
    },
    [runFollow],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  return { discovery, activeTurnId, following, follow, stop }
}
