/**
 * In-process turn-stream harness: a fake namespace that routes `idFromName`
 * to REAL {@link TurnStreamDO} instances over an in-memory storage/socket
 * state. The adapters and the DO run their production code paths — only the
 * Cloudflare runtime (isolation, hibernation, real sockets) is simulated.
 *
 * The harness runs the DO in its PRODUCTION auth mode: instances carry their
 * channel name and a capability-token secret (a fixed default, overridable),
 * so tests exercise the real gate — an adapter call without `auth` fails
 * exactly like a misconfigured worker would. Test-side viewer sockets attach
 * through `channel().connect()` (inside the DO, post-upgrade), which is the
 * one hop that legitimately skips the HTTP gate.
 *
 * For vitest composition tests and keyless local dev (the same role
 * `createMemoryTurnEventStore` plays for the D1 store). Not for production:
 * state is per-process and evaporates on restart.
 */

import { TurnStreamDO, type TurnStreamDOOptions, type TurnStreamDOState, type TurnStreamSocket, type TurnStreamStorage } from './do'
import type { TurnStreamNamespaceLike, TurnStreamStubLike } from './adapters'

function createMemoryStorage(): TurnStreamStorage {
  const map = new Map<string, unknown>()
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined
    },
    async put(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      return map.delete(key)
    },
    async list<T>({ prefix, start }: { prefix: string; start?: string }) {
      const keys = [...map.keys()]
        .filter((key) => key.startsWith(prefix) && (start === undefined || key >= start))
        .sort()
      return new Map(keys.map((key) => [key, map.get(key) as T]))
    },
  }
}

/** A test-side viewer socket: records frames sent by the DO and lets the
 *  test drive the `sync` handshake. */
export interface MemoryTurnStreamSocket extends TurnStreamSocket {
  readonly frames: string[]
  readonly closed: boolean
}

/** Define an in-memory channel for streaming turn-based data with viewer socket connection support */
export interface MemoryTurnStreamChannel {
  /** Attach a viewer socket to this channel (bypasses the HTTP 101 — the
   *  upgrade handshake is Cloudflare-runtime-only) and run its `sync`. */
  connect(input: { sessionId: string; scope: 'thread' | 'workspace'; afterSeq?: number }): Promise<MemoryTurnStreamSocket>
  readonly instance: TurnStreamDO
}

/** Provide an interface to manage channels and namespaces for memory-based turn stream testing */
export interface MemoryTurnStreamHarness {
  namespace: TurnStreamNamespaceLike
  /** The channel (creating its DO instance if needed) for a channel key —
   *  e.g. `threadChannelKey(ws, thread)` — to connect test viewers. */
  channel(name: string): MemoryTurnStreamChannel
}

interface MemoryInstance {
  instance: TurnStreamDO
  sockets: MemoryTurnStreamSocket[]
}

/**
 * Build the harness. `createInstance` lets a product test run its own
 * `TurnStreamDO` subclass through the same wiring.
 */
/** Default harness secret — long enough to satisfy the DO's minimum, fixed so
 *  tests are deterministic. Products testing their own subclass pass their
 *  own via `options.authSecret`. */
export const MEMORY_TURN_STREAM_AUTH_SECRET = 'test-turn-stream-harness-secret-0123456789ab'

export function createMemoryTurnStreamHarness(
  createInstance: (state: TurnStreamDOState, authSecret: string) => TurnStreamDO = (state, secret) =>
    new TurnStreamDO(state, undefined, { authSecret: secret }),
  options: TurnStreamDOOptions & { authSecret?: string } = {},
): MemoryTurnStreamHarness {
  const authSecret = options.authSecret ?? MEMORY_TURN_STREAM_AUTH_SECRET
  const createInst = (state: TurnStreamDOState) => createInstance(state, authSecret)
  const instances = new Map<string, MemoryInstance>()

  function ensure(name: string): MemoryInstance {
    let entry = instances.get(name)
    if (!entry) {
      const sockets: MemoryTurnStreamSocket[] = []
      const state: TurnStreamDOState = {
        storage: createMemoryStorage(),
        acceptWebSocket: (ws) => sockets.push(ws as MemoryTurnStreamSocket),
        getWebSockets: () => sockets.filter((ws) => !ws.closed),
        id: { name },
      }
      entry = { instance: createInst(state), sockets }
      instances.set(name, entry)
    }
    return entry
  }


  const namespace: TurnStreamNamespaceLike = {
    idFromName: (name) => name,
    get(id): TurnStreamStubLike {
      const entry = ensure(String(id))
      return {
        fetch: (input, init) =>
          entry.instance.fetch(typeof input === 'string' ? new Request(input, init) : input),
      }
    },
  }

  return {
    namespace,
    channel(name) {
      const entry = ensure(name)
      return {
        instance: entry.instance,
        async connect({ sessionId, scope, afterSeq = 0 }) {
          let attachment: unknown = null
          const frames: string[] = []
          let closed = false
          const socket: MemoryTurnStreamSocket = {
            get frames() {
              return frames
            },
            get closed() {
              return closed
            },
            send(data) {
              if (closed) throw new Error('socket closed')
              frames.push(data)
            },
            close() {
              closed = true
            },
            serializeAttachment(value) {
              attachment = value
            },
            deserializeAttachment() {
              return attachment
            },
          }
          socket.serializeAttachment({ sessionId, scope, synced: false })
          entry.sockets.push(socket)
          await entry.instance.webSocketMessage(socket, JSON.stringify({ type: 'sync', afterSeq }))
          return socket
        },
      }
    },
  }
}
