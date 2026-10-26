/**
 * The box runtime's agent protocol, as the sidecar serves it, over real HTTP:
 * a run admitted on `POST /agents/run/stream` (detached when the request says so,
 * else cancelled when its stream closes early), its buffered replay on
 * `GET /agents/run/{id}/events`, the session's status and execution ledger,
 * completed turns by turn id (a repeated turn id is the same run, never a
 * second one), the interaction registry, and a real directory as the box's file
 * tree. The test decides what each new run does (`onRun`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export type RuntimeEvent = { type: string; data: Record<string, unknown> }

export interface RuntimeRun {
  executionId: string
  sessionId: string
  turnId: string
  task: string
  backend: Record<string, unknown>
  startedAt: number
  events: RuntimeEvent[]
  terminal: 'completed' | 'failed' | 'cancelled' | null
  /** A question the box agent is waiting on, while unanswered. */
  question?: Record<string, unknown> & { id: string }
  onAnswer?: (data: Record<string, unknown> | undefined) => void
  listeners: Set<() => void>
}

export interface SidecarRuntimePeer {
  runs: Map<string, RuntimeRun>
  /** Every admission request, by execution id, including repeats of a run that already exists. */
  sends: string[]
  unknown: string[]
  push(run: RuntimeRun, event: RuntimeEvent): void
  finish(run: RuntimeRun, answer: string): void
  fail(run: RuntimeRun, message: string): void
  /** False, and nothing is asked, when the turn's backend did not enable questions. */
  ask(run: RuntimeRun, question: Record<string, unknown> & { id: string }, onAnswer: (data: Record<string, unknown> | undefined) => void): boolean
  /** Serves `path` (relative to the runtime URL); false when it is not a runtime route. */
  handle(request: IncomingMessage, response: ServerResponse, path: string, url: URL, body: string): boolean
}

const walk = (dir: string): Array<{ path: string; size: number; mtime: number }> => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [{ path: join(dir, entry.name),
    size: statSync(join(dir, entry.name)).size, mtime: Math.floor(statSync(join(dir, entry.name)).mtimeMs) }])

export function createSidecarRuntimePeer(options: {
  /** The directory the box's file tree is read from; tree paths are relative to it, as the sidecar's are to /home/agent. */
  disk: string
  onRun(run: RuntimeRun, peer: SidecarRuntimePeer): void
}): SidecarRuntimePeer {
  const runs = new Map<string, RuntimeRun>()
  const sends: string[] = []
  const unknown: string[] = []
  const push = (run: RuntimeRun, event: RuntimeEvent) => {
    run.events.push(event)
    if (event.type === 'done') run.terminal = event.data.status === 'completed' ? 'completed' : event.data.status === 'cancelled' ? 'cancelled' : 'failed'
    for (const listener of [...run.listeners]) listener()
  }
  const ids = (run: RuntimeRun) => ({ executionId: run.executionId, sessionId: run.sessionId })
  const peer: SidecarRuntimePeer = {
    runs, sends, unknown, push,
    finish(run, answer) {
      push(run, { type: 'text', data: { text: answer, ...ids(run) } })
      push(run, { type: 'result', data: { finalText: answer, response: answer, success: true, ...ids(run) } })
      push(run, { type: 'done', data: { status: 'completed', success: true, ...ids(run) } })
    },
    fail(run, message) {
      push(run, { type: 'done', data: { status: 'failed', success: false, message, ...ids(run) } })
    },
    ask(run, question, onAnswer) {
      // The runtime opens the question channel only when the turn's backend config enables it.
      if ((run.backend.interactions as { question?: unknown } | undefined)?.question !== true) return false
      run.question = question
      run.onAnswer = onAnswer
      push(run, { type: 'interaction', data: { request: question } })
      return true
    },
    handle(request, response, path, url, body) {
      const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); return true }
      const inSession = (sessionId: string) => [...runs.values()].filter(run => run.sessionId === sessionId)
      const session = path.match(/^\/agents\/sessions\/([^/]+)(\/runs|\/interactions)?$/)
      if (session && request.method === 'GET' && !session[2]) {
        const latest = inSession(decodeURIComponent(session[1]!)).at(-1)
        if (!latest) return json({ error: 'Session not found' }, 404)
        return json({ id: latest.sessionId, status: latest.terminal ?? 'running', latestExecutionId: latest.executionId,
          ...(latest.terminal ? {} : { activeExecutionId: latest.executionId }) })
      }
      if (session?.[2] === '/runs') return json({ success: true, executions: inSession(decodeURIComponent(session[1]!)).reverse().map(run => ({
        executionId: run.executionId, sessionId: run.sessionId, status: run.terminal ?? 'active', startedAt: run.startedAt,
        ...(run.terminal ? { completedAt: Date.now() } : {}), eventCount: run.events.length, lastEventId: String(run.events.length) })) })
      if (session?.[2] === '/interactions') {
        const asking = inSession(decodeURIComponent(session[1]!)).find(run => run.question)
        if (request.method === 'GET') return json({ success: true, data: { interactions: asking ? [asking.question] : [] } })
        const answer = JSON.parse(body) as { id: string; outcome: string; data?: Record<string, unknown> }
        if (!asking || asking.question!.id !== answer.id) return json({ success: false, error: { code: 'INTERACTION_NOT_FOUND', message: 'The ask is gone' } }, 404)
        const onAnswer = asking.onAnswer!
        asking.question = undefined
        asking.onAnswer = undefined
        onAnswer(answer.data)
        return json({ success: true })
      }
      if (path === '/messages/turns') {
        const run = [...runs.values()].find(value => value.turnId === url.searchParams.get('turnId') && value.sessionId === url.searchParams.get('sessionId'))
        if (run?.terminal !== 'completed') { response.writeHead(204).end(); return true }
        const text = String(run.events.find(event => event.type === 'result')?.data.finalText ?? '')
        return json({ turnId: run.turnId, sessionId: run.sessionId, completedAt: new Date().toISOString(),
          result: { text, response: text, success: true, executionId: run.executionId } })
      }
      if (path === '/messages') return json([])
      if (path === '/agents/run/stream' && request.method === 'POST') {
        const input = JSON.parse(body) as { sessionId: string; turnId?: string; runControlRef?: unknown; detach?: boolean
          parts?: Array<{ type: string; text?: string }>; backend: Record<string, unknown> }
        const executionId = String(request.headers['x-execution-id'] ?? '')
        sends.push(executionId)
        const detached = input.detach === true || request.headers['x-agent-detach'] === 'true'
        let run = runs.get(executionId)
        const fresh = !run
        if (!run) {
          run = { executionId, sessionId: input.sessionId, turnId: input.turnId ?? executionId, backend: input.backend,
            task: (input.parts ?? []).filter(part => part.type === 'text').map(part => Buffer.from(part.text ?? '', 'base64').toString('utf8')).join('\n'),
            startedAt: Date.now(), events: [], terminal: null, listeners: new Set() }
          runs.set(executionId, run)
        }
        const live = run
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        let sent = 0
        const write = (id: number, event: RuntimeEvent) => response.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
        write(0, { type: 'execution.started', data: { ...ids(live), runControlRef: input.runControlRef } })
        const flush = () => {
          while (sent < live.events.length) { write(sent + 1, live.events[sent]!); sent++ }
          if (live.terminal) { live.listeners.delete(flush); response.end() }
        }
        live.listeners.add(flush)
        response.on('close', () => {
          live.listeners.delete(flush)
          // A run that was not sent detached ends with the stream that carried it.
          if (!detached && !live.terminal) push(live, { type: 'done', data: { status: 'cancelled', success: false, message: 'Execution cancelled: the stream closed', ...ids(live) } })
        })
        if (fresh) options.onRun(live, peer)
        flush()
        return true
      }
      const replay = path.match(/^\/agents\/run\/([^/]+)\/events$/)
      if (replay && request.method === 'GET') {
        const run = runs.get(decodeURIComponent(replay[1]!))
        if (!run) return json({ success: false, error: { code: 'EXECUTION_NOT_FOUND', message: 'Unknown execution' } }, 404)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        let sent = Number(url.searchParams.get('lastEventId') ?? '0') || 0
        const flush = () => {
          while (sent < run.events.length) {
            const event = run.events[sent]!
            sent++
            response.write(`id: ${sent}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
          }
          if (run.terminal) { run.listeners.delete(flush); response.end() }
        }
        run.listeners.add(flush)
        response.on('close', () => run.listeners.delete(flush))
        flush()
        return true
      }
      if (path === '/files/tree') {
        const at = url.searchParams.get('path') ?? options.disk
        const files = walk(at).map(file => ({ ...file, path: relative(options.disk, file.path) }))
        return json({ data: { root: relative(options.disk, at), directories: [], files,
          stats: { totalDirectories: 0, totalFiles: files.length, scanDurationMs: 1, truncated: false } } })
      }
      if (path === '/files/read') {
        const { path: file } = JSON.parse(body) as { path: string }
        return json({ success: true, data: { content: readFileSync(file, 'utf8'), encoding: 'utf8' } })
      }
      unknown.push(`${request.method} ${path}`)
      return false
    },
  }
  return peer
}
