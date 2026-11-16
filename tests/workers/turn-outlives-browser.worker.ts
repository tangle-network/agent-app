/**
 * Real workerd fixture for a chat turn that outlives the browser that sent it. The Worker and the app's
 * TurnStreamDO subclass build the same chat routes with `turnHost`; the producer answers over 40 s, longer than a
 * Worker request's `waitUntil` work may run after its client leaves. D1 marks record where the producer ran and whose
 * `waitUntil` held the turn's work, and the host binding marks each request it sends to a turn's object.
 * `/probe/wait-until` checks the runtime itself: a Worker request's own `waitUntil` work, marked once a second, after
 * its client disconnects.
 */
import type { D1Database } from '@cloudflare/workers-types'
import { createChatTurnRoutes, type ChatTurnMessageStore, type ChatTurnRequestContext } from '../../src/chat-routes/turn-routes'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/turn-buffer'
import { peekDurableTurnLock, type TurnStreamNamespaceLike } from '../../src/turn-stream/adapters'
import { TurnStreamDO, type TurnStreamDOState } from '../../src/turn-stream/do'

interface Env { DB: D1Database; TURN_STREAM_DO: TurnStreamNamespaceLike & { newUniqueId(): unknown }; TURN_STREAM_AUTH_SECRET: string }
type Where = 'worker' | 'object'

const STEP_MS = 4_000
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

/** The binding as the turn host sees it: every request sent to a turn's object is marked first. */
function markedHost(env: Env): Env['TURN_STREAM_DO'] {
  const namespace = env.TURN_STREAM_DO
  return {
    idFromName: name => namespace.idFromName(name),
    newUniqueId: () => namespace.newUniqueId(),
    get: (id, options) => {
      const stub = namespace.get(id, options)
      return { fetch: async (input, init) => { await mark(env, 'host:object-request'); return stub.fetch(input, init) } }
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
    produce: async () => {
      await mark(env, `produce:${where}`)
      let text = ''
      return {
        stream: (async function* () {
          for (const part of PARTS) {
            await sleep(STEP_MS)
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

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const [, route, workspaceId = '', turnId = ''] = new URL(request.url).pathname.split('/')
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
      const answer = await env.DB.prepare("SELECT content FROM proof_messages WHERE role = 'assistant'").first<{ content: string }>()
      const marks = await env.DB.prepare('SELECT kind FROM proof_marks ORDER BY rowid').all<{ kind: string }>()
      return Response.json({
        answer: answer?.content ?? null,
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
