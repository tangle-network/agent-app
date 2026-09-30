import type { WorkspaceAppRecord } from './index'

const protocol = 'tangle.workspace-app-data.v1'
const maxBytes = 65_536
const maxPending = 16
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const idPattern = /^[A-Za-z0-9_-]{1,80}$/

export interface WorkspaceAppDataEntry { value: string; revision: number }
export class WorkspaceAppDataConflict extends Error {
  constructor() {
    super('Workspace app data changed. Read it again before saving.')
    this.name = 'WorkspaceAppDataConflict'
  }
}
export interface WorkspaceAppDataHostOptions {
  /** Product-authorized registration for the current viewer. */
  app: Pick<WorkspaceAppRecord, 'id' | 'previewUrl' | 'status'>
  frame: HTMLIFrameElement
  /** Product callbacks are bound to the authorized business and app namespace. */
  read(key: string): Promise<WorkspaceAppDataEntry | null>
  /** Null creates only if absent; a revision updates only that version. */
  write(key: string, value: string, expectedRevision: number | null): Promise<{ revision: number }>
  remove(key: string, expectedRevision: number): Promise<void>
}
export interface WorkspaceAppDataHost { dispose(): void }
export interface WorkspaceAppDataClientOptions {
  appId: string
  /** Exact authenticated product origin, provided by the product. */
  parentOrigin: string
}
export interface WorkspaceAppDataClient {
  ready(): Promise<void>
  read(key: string): Promise<WorkspaceAppDataEntry | null>
  write(key: string, value: string, expectedRevision: number | null): Promise<{ revision: number }>
  remove(key: string, expectedRevision: number): Promise<void>
  dispose(): void
}

type Action = 'ready' | 'read' | 'write' | 'remove'
type Packet = {
  protocol: typeof protocol
  appId: string
  requestId: string
  action: Action
  key?: string
  value?: string
  expectedRevision?: number | null
  ok?: boolean
  entry?: WorkspaceAppDataEntry | null
  revision?: number
  error?: 'invalid' | 'conflict' | 'unavailable'
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function key(value: unknown): value is string {
  return typeof value === 'string' && keyPattern.test(value) && value !== '.' && value !== '..'
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function bounded(value: unknown): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).byteLength <= maxBytes
}
function appId(value: string): string {
  if (!idPattern.test(value)) throw new Error('Invalid workspace app ID')
  return value
}
function origin(value: string): string {
  const url = new URL(value)
  if (url.origin !== value || (url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Invalid workspace app data origin')
  }
  return url.origin
}
function packet(value: unknown): value is Packet {
  return object(value) && value.protocol === protocol &&
    typeof value.appId === 'string' && typeof value.requestId === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.requestId) &&
    typeof value.action === 'string' && ['ready', 'read', 'write', 'remove'].includes(value.action)
}

/** Bind one registered preview to a product-authorized data adapter. */
export function createWorkspaceAppDataHost(options: WorkspaceAppDataHostOptions): WorkspaceAppDataHost {
  const { app, frame } = options
  appId(app.id)
  if (app.status !== 'ready') throw new Error('Workspace app is not ready')
  const preview = new URL(app.previewUrl)
  const previewOrigin = origin(preview.origin)
  if (preview.protocol !== 'https:' || preview.username || preview.password || preview.search || preview.hash ||
    new URL(frame.src).href !== preview.href) {
    throw new Error('Iframe does not render the registered workspace app preview')
  }
  let closed = false
  let active = 0
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (closed || event.source !== frame.contentWindow || event.origin !== previewOrigin ||
      !packet(event.data) || event.data.appId !== app.id) return
    const message = event.data
    const reply = (result: Pick<Packet, 'ok' | 'entry' | 'revision' | 'error'>): void => {
      if (closed || event.source !== frame.contentWindow) return
      frame.contentWindow?.postMessage({
        protocol, appId: app.id, requestId: message.requestId, action: message.action, ...result,
      } satisfies Packet, previewOrigin)
    }
    if (message.action === 'ready') { reply({ ok: true }); return }
    if (!key(message.key) ||
      (message.action === 'write' && (!bounded(message.value) ||
        !(message.expectedRevision === null || revision(message.expectedRevision)))) ||
      (message.action === 'remove' && !revision(message.expectedRevision))) {
      reply({ ok: false, error: 'invalid' }); return
    }
    if (active >= maxPending) { reply({ ok: false, error: 'unavailable' }); return }
    active += 1
    const checkedKey = message.key
    void (async () => {
      try {
        if (message.action === 'read') {
          const entry = await options.read(checkedKey)
          if (entry !== null && (!bounded(entry.value) || !revision(entry.revision))) throw new Error('Invalid entry')
          reply({ ok: true, entry })
        } else if (message.action === 'write') {
          const result = await options.write(checkedKey, message.value as string, message.expectedRevision as number | null)
          if (!revision(result.revision)) throw new Error('Invalid revision')
          reply({ ok: true, revision: result.revision })
        } else {
          await options.remove(checkedKey, message.expectedRevision as number)
          reply({ ok: true })
        }
      } catch (error) {
        reply({ ok: false, error: error instanceof WorkspaceAppDataConflict ? 'conflict' : 'unavailable' })
      } finally { active -= 1 }
    })()
  }
  window.addEventListener('message', onMessage)
  return { dispose() { closed = true; window.removeEventListener('message', onMessage) } }
}

/** Use inside a registered preview; no product credential crosses the frame. */
export function createWorkspaceAppDataClient(options: WorkspaceAppDataClientOptions): WorkspaceAppDataClient {
  const id = appId(options.appId)
  const parentOrigin = origin(options.parentOrigin)
  if (window.parent === window) throw new Error('Workspace app data requires an embedded preview')
  const pending = new Map<string, {
    action: Action
    resolve(value: Packet): void
    reject(error: Error): void
    timeout: ReturnType<typeof setTimeout>
  }>()
  let closed = false
  let readyPromise: Promise<void> | undefined
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (closed || event.source !== window.parent || event.origin !== parentOrigin || !packet(event.data) ||
      event.data.appId !== id || typeof event.data.ok !== 'boolean') return
    const waiting = pending.get(event.data.requestId)
    if (!waiting || waiting.action !== event.data.action) return
    pending.delete(event.data.requestId)
    clearTimeout(waiting.timeout)
    if (event.data.ok) waiting.resolve(event.data)
    else waiting.reject(event.data.error === 'conflict' ? new WorkspaceAppDataConflict() :
      new Error('Workspace app data unavailable'))
  }
  window.addEventListener('message', onMessage)
  const send = (action: Action, fields: Partial<Packet> = {}, timeoutMs = 10_000): Promise<Packet> => {
    if (closed) return Promise.reject(new Error('Workspace app data client is closed'))
    if (pending.size >= maxPending) return Promise.reject(new Error('Too many workspace app data requests'))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('Workspace app data timed out')) }, timeoutMs)
      pending.set(requestId, { action, resolve, reject, timeout })
      window.parent.postMessage({ protocol, appId: id, requestId, action, ...fields } satisfies Packet, parentOrigin)
    })
  }
  const ready = (): Promise<void> => {
    if (readyPromise) return readyPromise
    readyPromise = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000
      const attempt = (): void => {
        if (closed) { reject(new Error('Workspace app data client is closed')); return }
        if (Date.now() >= deadline) { reject(new Error('Workspace app data host did not become ready')); return }
        void send('ready', {}, 300).then(() => resolve(), () => setTimeout(attempt, 200))
      }
      attempt()
    }).catch((error: unknown) => { readyPromise = undefined; throw error })
    return readyPromise
  }
  return {
    ready,
    async read(value) {
      if (!key(value)) throw new Error('Invalid workspace app data key')
      await ready()
      const response = await send('read', { key: value })
      if (response.entry !== null && (!object(response.entry) ||
        !bounded(response.entry.value) || !revision(response.entry.revision))) {
        throw new Error('Invalid workspace app data response')
      }
      return response.entry ?? null
    },
    async write(value, data, expectedRevision) {
      if (!key(value) || !bounded(data) || !(expectedRevision === null || revision(expectedRevision))) {
        throw new Error('Invalid workspace app data write')
      }
      await ready()
      const response = await send('write', { key: value, value: data, expectedRevision })
      if (!revision(response.revision)) throw new Error('Invalid workspace app data response')
      return { revision: response.revision }
    },
    async remove(value, expectedRevision) {
      if (!key(value) || !revision(expectedRevision)) throw new Error('Invalid workspace app data remove')
      await ready()
      await send('remove', { key: value, expectedRevision })
    },
    dispose() {
      closed = true
      window.removeEventListener('message', onMessage)
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timeout)
        waiting.reject(new Error('Workspace app data client is closed'))
      }
      pending.clear()
    },
  }
}
