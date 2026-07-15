/**
 * The assembled mini chat app for the vertical composition suite — a product
 * built ONLY from the shipped subpaths, wired the way a real consumer wires
 * them (no test doubles between the modules themselves):
 *
 *   auth       `createAppAuth` (better-auth memoryAdapter) + its guard quartet
 *   storage    `createChatTables` + `createChatStore` over :memory: better-sqlite3
 *   gates      `assertSystemPromptWithinBudget` + `assertEnvWithinLimits` +
 *              `assertProvisionPayloadWithinCap` at the turn boundary (#190)
 *   turn       a fake sandbox producer emitting canonical sidecar part events
 *              (`message.part.updated` snapshots + deltas, step-finish usage
 *              receipts, interaction asks, error) pumped through `/stream`'s
 *              normalizer into BOTH lanes: the NDJSON client stream
 *              (`/web-react` chat-stream line shapes) and the persisted
 *              assistant message parts
 *   asks       `/interactions`: the producer blocks on the fake sidecar broker;
 *              `createInteractionAnswerRoute` answers through the same registry
 *
 * Access control composes app-auth with the store's injected seams: guards
 * throw Responses (the router convention), the product membership check turns
 * a session into per-workspace allow/deny, and `bulkDeleteThreads` receives it
 * as `assertAccess`.
 */

import {
  interactionToPersistedPart,
  noticePart,
  createInteractionAnswerRoute,
  type ChatInteractionStatus,
  type InteractionRequestWire,
  type InteractionAnswerRoute,
} from '../../src/interactions/index'
import { createAppAuth, type AppAuth, type AppAuthSession } from '../../src/app-auth/index'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { createChatTables, type ChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase, type ChatStore } from '../../src/chat-store/store'
import { ChatStoreInputError, type ChatMessagePart } from '../../src/chat-store/index'
import {
  finalizeAssistantParts,
  getPartKey,
  mergePersistedPart,
  normalizePersistedPart,
  type JsonRecord,
} from '../../src/stream/index'
import { assertEnvWithinLimits, assertProvisionPayloadWithinCap } from '../../src/sandbox/index'
import { assertSystemPromptWithinBudget, type ComposeProfileBudget } from '../../src/profile/index'
import { openDatabase, workspacesTable } from '../teams/db-helper'
import { createFakeSidecarSession, type FakeSidecarSession, type InteractionResolutionRecord } from './fake-sidecar'

export const MINI_APP_MODEL = 'mini/model-1'
const BASE_URL = 'http://localhost:3000'
const AUTH_SECRET = 'vertical-suite-secret'

// ---------------------------------------------------------------------------
// Fake sandbox producer vocabulary — canonical sidecar shapes (mirrors the
// `message.part.updated` envelope the ADC sidecar emits, minus the
// session/message ids the normalizer strips anyway).

export type ProducerEvent =
  /** A canonical part snapshot; `delta` is the increment for text/reasoning. */
  | { type: 'message.part.updated'; part: JsonRecord; delta?: string }
  /** An ask. `block: false` registers + emits without waiting (a re-emitted
   *  duplicate); the default blocks the turn until EVERY outstanding ask is
   *  resolved — the broker semantics. */
  | { type: 'interaction'; request: InteractionRequestWire; block?: boolean }
  /** The turn failed server-side. */
  | { type: 'error'; message: string }

interface MiniAppOptions {
  /** The scripted turn every chat POST runs. */
  script?: ProducerEvent[]
  /** #190 gate knobs. */
  budget?: ComposeProfileBudget
  sandboxEnv?: Record<string, string>
  /** Extra bytes staged into the provision profile (files channel). */
  profileFileContent?: string
  /** Product prompt composition; default is a small static prompt. */
  systemPromptFor?: (message: string) => string
}

export interface MiniApp {
  appAuth: AppAuth
  store: ChatStore
  tables: ChatTables
  db: ChatDatabase
  sidecar: FakeSidecarSession
  routes: {
    /** POST `{ workspaceId, threadId?, message }` → NDJSON turn stream. */
    chat(request: Request): Promise<Response>
    /** GET `?workspaceId=` → `{ threads, total }`. */
    listThreads(request: Request): Promise<Response>
    /** GET `?threadId=` → `{ thread, messages }`; inaccessible reads 404. */
    getThread(request: Request): Promise<Response>
    /** POST `{ ids }` → `{ deleted }`; any denied workspace rejects all. */
    bulkDeleteThreads(request: Request): Promise<Response>
    interactions: InteractionAnswerRoute
  }
  /** Sign up a user and return the Cookie header a browser would replay. */
  signUp(email: string): Promise<string>
  grantMembership(email: string, workspaceId: string): void
  createWorkspace(id: string, name?: string): Promise<void>
}

function deniedWorkspaceResponse(): Response {
  return Response.json({ error: 'Forbidden', code: 'workspace.forbidden' }, { status: 403 })
}

/** Route-boundary convention: guards and access checks THROW Responses. */
async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof Response) return err
    if (err instanceof ChatStoreInputError) {
      return Response.json({ error: err.message }, { status: 400 })
    }
    throw err
  }
}

export async function createMiniApp(options: MiniAppOptions = {}): Promise<MiniApp> {
  const tables = createChatTables({ workspaceTable: workspacesTable })
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  const store = createChatStore(db, tables)
  const sidecar = createFakeSidecarSession()

  const appAuth = createAppAuth({
    appName: 'Vertical Mini App',
    baseURL: BASE_URL,
    secret: AUTH_SECRET,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  })

  const memberships = new Map<string, Set<string>>()
  const isMember = (email: string, workspaceId: string) => memberships.get(email)?.has(workspaceId) ?? false
  const assertMember = (session: AppAuthSession, workspaceId: string) => {
    if (!isMember(session.user.email, workspaceId)) throw deniedWorkspaceResponse()
  }

  const systemPromptFor = options.systemPromptFor ?? (() => 'You are the vertical mini app agent.')
  let turnCounter = 0

  function runGates(message: string): void {
    assertSystemPromptWithinBudget(systemPromptFor(message), options.budget)
    const env = options.sandboxEnv ?? {}
    assertEnvWithinLimits(env)
    const profile = {
      name: 'vertical-mini',
      prompt: { systemPrompt: systemPromptFor(message) },
      resources: { files: options.profileFileContent ? [{ path: '/knowledge.md', content: options.profileFileContent }] : [] },
    }
    // `ProvisionProfileSection` is structural, so a product-composed profile
    // passes without casting through the SDK's AgentProfile.
    assertProvisionPayloadWithinCap({ env, secrets: [], backend: { profile } })
  }

  interface TurnState {
    partOrder: string[]
    partMap: Map<string, JsonRecord>
    announcedTools: Set<string>
    asked: InteractionRequestWire[]
    resolutions: Map<string, InteractionResolutionRecord>
    tailParts: JsonRecord[]
    receipt: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number; seen: boolean }
    failed: string | null
  }

  function interactionStatusOf(state: TurnState, request: InteractionRequestWire): ChatInteractionStatus {
    const resolution = state.resolutions.get(request.id)
    if (!resolution) return 'pending'
    return resolution.outcome === 'accepted' ? 'answered' : 'declined'
  }

  /** Drives the scripted producer: encodes the client NDJSON lane and
   *  accumulates the persistence lane, then persists the assistant message. */
  function runTurn(threadId: string, turnId: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const script = options.script ?? []
    return new ReadableStream({
      async start(controller) {
        const emit = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        const state: TurnState = {
          partOrder: [],
          partMap: new Map(),
          announcedTools: new Set(),
          asked: [],
          resolutions: new Map(),
          tailParts: [],
          receipt: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, seen: false },
          failed: null,
        }
        emit({ type: 'turn', turnId })

        for (const event of script) {
          if (event.type === 'error') {
            state.failed = event.message
            emit({ type: 'error', error: 'Chat loop failed', details: event.message })
            break
          }

          if (event.type === 'interaction') {
            state.asked.push(event.request)
            void sidecar.ask(event.request)
            emit({ type: 'interaction', data: { request: event.request } })
            if (event.block !== false) {
              const resolved = await sidecar.waitAll()
              for (const [id, resolution] of resolved) state.resolutions.set(id, resolution)
            }
            continue
          }

          const raw = event.part
          // The normalizer projects the FULL storable vocabulary (text/
          // reasoning/tool plus file/image/step-start/step-finish/subtask);
          // unknown kinds come back null and are skipped.
          const normalized = normalizePersistedPart(raw)
          if (!normalized) continue

          if (String(normalized.type ?? '') === 'step-finish') {
            const tokens = (normalized.tokens ?? {}) as {
              input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number }
            }
            state.receipt.seen = true
            state.receipt.input += tokens.input ?? 0
            state.receipt.output += tokens.output ?? 0
            state.receipt.reasoning += tokens.reasoning ?? 0
            state.receipt.cacheRead += tokens.cache?.read ?? 0
            state.receipt.cacheWrite += tokens.cache?.write ?? 0
            state.receipt.cost += typeof normalized.cost === 'number' ? normalized.cost : 0
            state.tailParts.push(normalized)
            emit({
              kind: 'event',
              event: {
                type: 'usage',
                usage: { promptTokens: tokens.input ?? 0, completionTokens: tokens.output ?? 0 },
              },
            })
            continue
          }

          const key = getPartKey(normalized)
          const existing = state.partMap.get(key)
          if (!existing) state.partOrder.push(key)
          state.partMap.set(key, mergePersistedPart(existing, normalized, event.delta))

          const type = String(normalized.type ?? '')
          if (type === 'text') {
            emit({ kind: 'event', event: { type: 'text', text: event.delta ?? String(normalized.text ?? '') } })
          } else if (type === 'reasoning') {
            emit({ kind: 'event', event: { type: 'reasoning', text: event.delta ?? String(normalized.text ?? '') } })
          } else if (type === 'tool') {
            const merged = state.partMap.get(key)!
            const toolState = (merged.state ?? {}) as { status?: string; input?: unknown; output?: unknown; error?: string }
            const toolCallId = String(merged.id ?? '')
            const toolName = String(merged.tool ?? 'tool')
            if (!state.announcedTools.has(toolCallId)) {
              state.announcedTools.add(toolCallId)
              emit({
                kind: 'event',
                event: { type: 'tool_call', call: { toolCallId, toolName, args: (toolState.input ?? {}) as Record<string, unknown> } },
              })
            }
            if (toolState.status === 'completed' || toolState.status === 'error') {
              emit({
                kind: 'tool_result',
                toolCallId,
                toolName,
                label: toolName,
                outcome: toolState.status === 'completed'
                  ? { ok: true, result: toolState.output }
                  : { ok: false, message: toolState.error ?? 'tool failed' },
              })
            }
          }
        }

        // Persistence lane: same accumulated parts, one assistant row.
        const orderedParts = state.partOrder
          .map((key) => state.partMap.get(key))
          .filter((part): part is JsonRecord => Boolean(part))
        const finalText = orderedParts
          .filter((part) => String(part.type ?? '') === 'text')
          .map((part) => String(part.text ?? ''))
          .join('')
        const parts: JsonRecord[] = finalizeAssistantParts(state.partOrder, state.partMap, finalText)
        for (const tail of state.tailParts) parts.push(tail)
        for (const request of state.asked) {
          parts.push(interactionToPersistedPart(request, interactionStatusOf(state, request)))
        }
        if (state.failed) {
          parts.push(noticePart('warning', turnId, `The agent hit an error and this turn stopped: ${state.failed}`))
        }
        await store.appendMessage({
          threadId,
          role: 'assistant',
          content: finalText,
          parts: parts as unknown as ChatMessagePart[],
          model: MINI_APP_MODEL,
          ...(state.receipt.seen
            ? {
                inputTokens: state.receipt.input,
                outputTokens: state.receipt.output,
                reasoningTokens: state.receipt.reasoning,
                cacheReadTokens: state.receipt.cacheRead,
                cacheWriteTokens: state.receipt.cacheWrite,
                costUsd: state.receipt.cost,
              }
            : {}),
        })

        emit({ type: 'metadata', data: { modelUsed: MINI_APP_MODEL } })
        emit({ type: 'turn_status', status: state.failed ? 'error' : 'complete' })
        controller.close()
      },
    })
  }

  const chat = (request: Request) =>
    handle(async () => {
      const session = await appAuth.requireApiUser(request)
      const body = (await request.json().catch(() => null)) as
        | { workspaceId?: string; threadId?: string; message?: string }
        | null
      const message = body?.message?.trim()
      if (!body?.workspaceId || !message) {
        return Response.json({ error: 'workspaceId and message are required' }, { status: 400 })
      }
      assertMember(session, body.workspaceId)

      try {
        runGates(message)
      } catch (err) {
        // The #190 gates throw Errors with the actionable breakdown — surface
        // them as a client-visible 400 BEFORE any row is written.
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
      }

      let threadId = body.threadId
      if (threadId) {
        const thread = await store.getThread(threadId)
        if (!thread || thread.workspaceId !== body.workspaceId) {
          return Response.json({ error: 'Thread not found' }, { status: 404 })
        }
      } else {
        const thread = await store.createThread({ workspaceId: body.workspaceId, firstMessage: message })
        threadId = thread.id
      }
      await store.appendMessage({ threadId, role: 'user', content: message })

      turnCounter += 1
      const turnId = `turn-${turnCounter}`
      return new Response(runTurn(threadId, turnId), {
        headers: {
          'content-type': 'application/x-ndjson',
          'x-thread-id': threadId,
          'x-turn-id': turnId,
        },
      })
    })

  const listThreads = (request: Request) =>
    handle(async () => {
      const session = await appAuth.requireApiUser(request)
      const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? ''
      assertMember(session, workspaceId)
      const result = await store.listThreads({ workspaceId })
      return Response.json(result)
    })

  const getThread = (request: Request) =>
    handle(async () => {
      const session = await appAuth.requireApiUser(request)
      const threadId = new URL(request.url).searchParams.get('threadId') ?? ''
      const thread = await store.getThread(threadId)
      // Inaccessible reads are indistinguishable from missing ones — a
      // cross-workspace probe must not learn the thread exists.
      if (!thread || !isMember(session.user.email, thread.workspaceId)) {
        return Response.json({ error: 'Thread not found' }, { status: 404 })
      }
      const messages = await store.listMessages(threadId)
      return Response.json({ thread, messages })
    })

  const bulkDeleteThreads = (request: Request) =>
    handle(async () => {
      const session = await appAuth.requireApiUser(request)
      const body = (await request.json().catch(() => null)) as { ids?: string[] } | null
      const result = await store.bulkDeleteThreads({
        ids: body?.ids ?? [],
        assertAccess: (workspaceId) => {
          if (!isMember(session.user.email, workspaceId)) throw deniedWorkspaceResponse()
        },
      })
      return Response.json(result)
    })

  const interactions = createInteractionAnswerRoute({
    resolveConnection: async ({ request, intent, body }) => {
      let session: AppAuthSession
      try {
        session = await appAuth.requireApiUser(request)
      } catch (err) {
        if (err instanceof Response) return { ok: false, response: err }
        throw err
      }
      const threadId =
        intent === 'answer'
          ? String(body?.threadId ?? '')
          : new URL(request.url).searchParams.get('threadId') ?? ''
      const thread = await store.getThread(threadId)
      if (!thread) return { ok: false, response: Response.json({ error: 'Thread not found' }, { status: 404 }) }
      if (!isMember(session.user.email, thread.workspaceId)) {
        return { ok: false, response: deniedWorkspaceResponse() }
      }
      return { ok: true, connection: sidecar.connection }
    },
    logger: { warn: () => {}, error: () => {} },
  })

  return {
    appAuth,
    store,
    tables,
    db,
    sidecar,
    routes: { chat, listThreads, getThread, bulkDeleteThreads, interactions },
    async signUp(email: string) {
      const response = await appAuth.auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({ email, password: 'correct-horse-battery', name: email.split('@')[0] }),
        }),
      )
      if (response.status !== 200) throw new Error(`sign-up failed (${response.status})`)
      return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0]!)
        .join('; ')
    },
    grantMembership(email, workspaceId) {
      const set = memberships.get(email) ?? new Set<string>()
      set.add(workspaceId)
      memberships.set(email, set)
    },
    async createWorkspace(id, name = id) {
      await db.insert(workspacesTable).values({ id, organizationId: 'org-vertical', name })
    },
  }
}
