/**
 * Real workerd fixture for a chat turn that outlives the browser that sent it. The Worker and the app's
 * TurnStreamDO subclass build the same chat routes with `turnHost`; the producer answers over 40 s, longer than a
 * Worker request's `waitUntil` work may run after its client leaves. D1 marks record where the producer ran and whose
 * `waitUntil` held the turn's work, and the host binding marks each request it sends to a turn's object (and, for one
 * marked request, loses the object after its turn started).
 * `/probe/wait-until` checks the runtime itself: a Worker request's own `waitUntil` work, marked once a second, after
 * its client disconnects.
 */
import type { D1Database } from '@cloudflare/workers-types'
import { createChatTurnRoutes, type ChatTurnMessageStore, type ChatTurnRequestContext } from '../../src/chat-routes/turn-routes'
import { createBufferedTurnTap, createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/turn-buffer'
import { peekDurableTurnLock, type TurnStreamNamespaceLike } from '../../src/turn-stream/adapters'
import { TurnStreamDO, type TurnStreamDOState } from '../../src/turn-stream/do'

interface Env { DB: D1Database; TURN_STREAM_DO: TurnStreamNamespaceLike & { newUniqueId(): unknown }; TURN_STREAM_AUTH_SECRET: string }
type Where = 'worker' | 'object'

const PARTS = [...Array.from({ length: 9 }, (_, index) => `Part ${index + 1}. `), 'Final answer.']
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const mark = (env: Env, kind: string) => env.DB.prepare('INSERT INTO proof_marks (kind) VALUES (?)').bind(kind).run()

function messages(db: D1Database): ChatTurnMessageStore {
  return {
    async listMessages(threadId) {
      const rows = await db.prepare('SELECT id,role,content,parts FROM proof_messages WHERE thread_id=? ORDER BY rowid').bind(threadId)
        .all<{ id: string; role: 'user' | 'assistant'; content: string; parts: string | null }>()
      return rows.results.map(row => ({ ...row, parts: row.parts ? JSON.parse(row.parts) : null }))
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      await db.prepare('INSERT INTO proof_messages (id,thread_id,role,content,parts) VALUES (?,?,?,?,?)')
        .bind(id, input.threadId, input.role, input.content, input.parts ? JSON.stringify(input.parts) : null).run()
      return { ...input, id }
    },
  }
}

/** Mark whose `waitUntil` the routes hand the turn's work to, then hand it on. */
function observed(env: Env, where: Where, waitUntil: ((promise: Promise<unknown>) => void) | undefined): ChatTurnRequestContext {
  return { waitUntil: promise => { waitUntil?.(promise); waitUntil?.(mark(env, `wait-until:${where}`)) } }
}

const produced = async (env: Env) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM proof_marks WHERE kind LIKE 'produce:%'").first<{ n: number }>())?.n ?? 0

/** The binding as the turn host sees it: every request sent to a turn's object is marked first. A request carrying
 *  `x-proof-host-breaks` reaches the real object; once that object's producer has started, the call fails with a plain
 *  error, as a lost connection would, instead of returning the object's response. */
function markedHost(env: Env): Env['TURN_STREAM_DO'] {
  const namespace = env.TURN_STREAM_DO
  return {
    idFromName: name => namespace.idFromName(name),
    newUniqueId: () => namespace.newUniqueId(),
    get: (id, options) => {
      const stub = namespace.get(id, options)
      return { fetch: async (input, init) => {
        await mark(env, 'host:object-request')
        const breaks = typeof input !== 'string' && input.headers.has('x-proof-host-breaks')
        const before = breaks ? await produced(env) : 0
        const response = await stub.fetch(input, init)
        if (!breaks) return response
        for (const deadline = Date.now() + 30_000; await produced(env) === before; await sleep(100)) {
          if (Date.now() > deadline) throw new Error('the object never started the turn')
        }
        await response.body?.cancel()
        throw new Error('the connection to the turn object was lost')
      } }
    },
  }
}

function routes(env: Env, where: Where) {
  const auth = { secret: env.TURN_STREAM_AUTH_SECRET }
  return createChatTurnRoutes({
    projectId: 'turn-outlives-browser-proof',
    // The browser's cookie and the workspace in its URL decide, so a refusal proves both reach wherever this runs.
    authorize: async ({ request }) => {
      const workspaceId = new URL(request.url).pathname.split('/')[2] ?? ''
      return request.headers.get('cookie') === 'session=member' && workspaceId
        ? { ok: true as const, tenantId: workspaceId, userId: 'member', context: undefined }
        : { ok: false as const, response: Response.json({ error: 'not a member' }, { status: 401 }) }
    },
    store: messages(env.DB),
    turnStore: { db: env.DB, lock: { namespace: env.TURN_STREAM_DO, auth } },
    turnHost: { namespace: markedHost(env), auth },
    produce: async args => {
      await mark(env, `produce:${where}`)
      // The browser's turn answers over 40 s; the turn whose host breaks, over 10 s.
      const stepMs = args.body.content === 'Answer slowly.' ? 4_000 : 1_000
      let text = ''
      return {
        stream: (async function* () {
          for (const part of PARTS) {
            await sleep(stepMs)
            text += part
            yield { type: 'text', text: part }
          }
        })(),
        finalText: () => text,
      }
    },
    turnTrace: false,
    log: () => {},
  })
}

export class TurnOutlivesBrowserDO extends TurnStreamDO {
  constructor(state: TurnStreamDOState, env: Env) {
    super(state, env, {
      turnRoutes: () => {
        const hosted = routes(env, 'object')
        return { turn: (request, ctx) => hosted.turn(request, { ...ctx, ...observed(env, 'object', ctx.waitUntil) }) }
      },
    })
  }
}

type AdmissionArm = 'healthy' | 'sql-failure' | 'disconnect'
type AdmissionRecord = {
  arm: AdmissionArm; turnId: string; finished: boolean; clientCancelled: boolean
  returned: string[]; error?: { name: string; message: string }; terminalError?: { name: string; message: string }
  appends: Array<{ rows: Array<{ seq: number; event: string }>; invokedAt: number; sqlSettledAt?: number; confirmedAt?: number; error?: { name: string; message: string } }>
  writes: Array<{ line: string; invokedAt: number; returnedAt?: number; error?: { name: string; message: string } }>
}
// Three test-owned HTTP operations, never a production cache or receipt store.
// Control requests release only barriers; they never await another request's I/O.
const admissionArms = new Map<AdmissionArm, { record: AdmissionRecord; confirmation(): void; progress(): void; terminal(): void }>()

async function admissionProof(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, route: string, arm: string): Promise<Response> {
  if (request.headers.get('cookie') !== 'session=member') return new Response('Not a member', { status: 401 })
  if (arm !== 'healthy' && arm !== 'sql-failure' && arm !== 'disconnect') return new Response('Unknown arm', { status: 404 })
  if (route === 'admission-state') {
    const entry = admissionArms.get(arm)
    if (!entry) return new Response('No owned admission operation', { status: 404 })
    const store = createD1TurnEventStore(env.DB)
    return Response.json({ ...entry.record, rows: await store.read(entry.record.turnId, 0), status: await store.getStatus(entry.record.turnId) })
  }
  if (route === 'admission-release') {
    const entry = admissionArms.get(arm)
    if (!entry) return new Response('No owned admission operation', { status: 404 })
    const input = await request.json() as { confirmation?: boolean; progress?: boolean; terminal?: boolean }
    if (input.confirmation) entry.confirmation()
    if (input.progress) entry.progress()
    if (input.terminal) entry.terminal()
    return new Response(null, { status: 204 })
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (admissionArms.has(arm)) return new Response('Operation already owned', { status: 409 })
  const turnId = `buffer-${arm}`
  if (arm === 'sql-failure') {
    // The real SQLite INSERT fails. No storage promise/result is fabricated.
    await env.DB.prepare(`CREATE TRIGGER proof_native_admission_failure BEFORE INSERT ON turn_events
      WHEN NEW.turnId='buffer-sql-failure' AND (json_extract(NEW.event,'$.type')='execution.started'
        OR json_extract(NEW.event,'$.event.type')='execution.started')
      BEGIN SELECT RAISE(ABORT,'proof-native-admission-sql-refusal'); END`).run()
  }
  let confirm!: () => void, progress!: () => void, terminal!: () => void
  const confirmation = new Promise<void>(resolve => { confirm = resolve })
  const followingProgress = new Promise<void>(resolve => { progress = resolve })
  const terminalRelease = new Promise<void>(resolve => { terminal = resolve })
  const record: AdmissionRecord = { arm, turnId, finished: false, clientCancelled: false, returned: [], appends: [], writes: [] }
  admissionArms.set(arm, { record, confirmation: confirm, progress, terminal })
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      // The existing probe's HTTP opener permits observing a held response.
      // It is transport metadata, never a producer event or tap write.
      controller.enqueue(new TextEncoder().encode('open\n'))
    },
    cancel() { record.clientCancelled = true },
  })
  const actualStore = createD1TurnEventStore(env.DB)
  let admissionConfirmed = false
  const tap = createBufferedTurnTap({ turnId, scopeId: 'native-admission-proof',
    store: { ...actualStore, append: async (id, rows) => {
      // Start the actual owned SQL operation FIRST. Passive observations add
      // no logging await or replacement store; only its confirmation is held.
      const actualAppend = actualStore.append(id, rows)
      const append: AdmissionRecord['appends'][number] = { rows, invokedAt: Date.now() }
      record.appends.push(append)
      try {
        await actualAppend
        append.sqlSettledAt = Date.now()
        const containsAdmission = rows.some(row => {
          const event = JSON.parse(row.event)
          return (event.kind === 'event' ? event.event : event).type === 'execution.started'
        })
        if (containsAdmission && !admissionConfirmed) await confirmation
        append.confirmedAt = Date.now()
        if (containsAdmission) admissionConfirmed = true
      } catch (error) {
        append.error = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) }
        throw error
      }
    } },
    write: line => {
      const write: AdmissionRecord['writes'][number] = { line, invokedAt: Date.now() }
      record.writes.push(write)
      try {
        controller.enqueue(new TextEncoder().encode(line + '\n'))
        write.returnedAt = Date.now()
      } catch (error) {
        write.error = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) }
        throw error // Actual closed HTTP stream error; the tap owns swallowing it.
      }
    },
  })
  ctx.waitUntil((async () => {
    try {
      await tap.onEvent({ type: 'text', text: 'prefix ' }); record.returned.push('prefix')
      const admission = { type: 'execution.started', data: { sandboxId: 'proof-box', sessionId: 'proof-native-session', executionId: `native-${arm}` } }
      await tap.onEvent({ kind: 'event', event: admission }); record.returned.push('admission')
      await followingProgress
      if (arm === 'healthy') {
        await tap.onEvent(admission); record.returned.push('matching-admission')
        await tap.onEvent({ type: 'text', text: 'A' })
        await tap.onEvent({ type: 'text', text: 'B' }); record.returned.push('progress')
      }
      await terminalRelease
    } catch (error) {
      record.error = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) }
    } finally {
      try { await tap.done(record.error ? 'error' : 'complete') }
      catch (error) { record.terminalError = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } }
      if (arm === 'sql-failure') await env.DB.prepare('DROP TRIGGER proof_native_admission_failure').run()
      try { controller.close() } catch { /* Actual canceled stream is already closed. */ }
      record.finished = true
    }
  })())
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url)
    const [, route, workspaceId = '', turnId = ''] = url.pathname.split('/')
    if (route === 'admission-start' || route === 'admission-state' || route === 'admission-release') return admissionProof(request, env, ctx, route, workspaceId)
    if (route === 'seed') {
      const ddl = `${TURN_EVENTS_MIGRATION_SQL};
        CREATE TABLE IF NOT EXISTS proof_messages (id TEXT PRIMARY KEY,thread_id TEXT,role TEXT,content TEXT,parts TEXT);
        CREATE TABLE IF NOT EXISTS proof_marks (kind TEXT NOT NULL)`
      await env.DB.batch(ddl.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)))
      return new Response(null, { status: 204 })
    }
    if (route === 'chat') return routes(env, 'worker').turn(request, observed(env, 'worker', promise => ctx.waitUntil(promise)))
    if (route === 'replay') return routes(env, 'worker').replay(request, { turnId })
    if (route === 'state') {
      const answers = await env.DB.prepare("SELECT content FROM proof_messages WHERE role = 'assistant' AND thread_id = ? ORDER BY rowid")
        .bind(url.searchParams.get('thread') ?? '').all<{ content: string }>()
      const marks = await env.DB.prepare('SELECT kind FROM proof_marks ORDER BY rowid').all<{ kind: string }>()
      return Response.json({
        answers: answers.results.map(row => row.content),
        status: await createD1TurnEventStore(env.DB).getStatus(turnId),
        lock: await peekDurableTurnLock(env.TURN_STREAM_DO, { workspaceId, scope: 'workspace' }, { secret: env.TURN_STREAM_AUTH_SECRET }),
        marks: marks.results.map(row => row.kind),
      })
    }
    if (route === 'probe') {
      ctx.waitUntil((async () => {
        for (let second = 1; second <= 45; second++) {
          await sleep(1_000)
          await mark(env, `probe:${second}`)
        }
      })())
      // The body never ends, so only the client's disconnect ends this request.
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('open\n')) } }))
    }
    return new Response(null, { status: 404 })
  },
}
