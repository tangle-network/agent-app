/**
 * src/worker.ts — the chat route. Code, not data.
 *
 * The minimal wired entry: a Cloudflare Worker that runs one bounded tool-loop
 * turn per chat request, with the agent→app tool side channel wired to the
 * preset handlers and the OpenAI-compatible Tangle Router as the backend.
 *
 * What this proves: the agent can call `submit_proposal` / `schedule_followup` /
 * `render_ui` / `add_citation`, each call is validated against your
 * `config.taxonomy` and persisted by the preset — with regulated proposals
 * fail-closed to the approval queue (never auto-executed). You extend the route;
 * you do not edit `@tangle-network/agent-app`.
 *
 * Install a trusted HeadlessAuth resolver before enabling customer work. Keep the human-in-the-loop invariant: regulated
 * proposals stay proposals.
 */

import { headlessAgentSurfaces } from './agent-surfaces'
import { config } from '../agent.config'
import { createAgentApp, type AppBindings } from './agent-app'
import {
  buildAppToolOpenAITools,
  createAppToolRuntimeExecutor,
  isAppToolName,
  type AppToolContext,
} from '@tangle-network/agent-app/tools'
import {
  runAppToolLoop,
  createOpenAICompatStreamTurn,
  type LoopEvent,
  type LoopMessage,
  type LoopToolCall,
  type ToolLoopEvent,
  type ToolLoopResult,
} from '@tangle-network/agent-app/runtime'

interface ChatRequest {
  message: string
}

/**
 * The OpenAI-compat stream yields the app's rich `LoopEvent` (it adds UI-only
 * `reasoning` / `usage` deltas). The awaitable loop consumes only `text` +
 * `tool_call`, so narrow the rest onto the substrate's `other` channel. (The
 * streaming `streamAppToolLoop` path takes the rich stream directly via
 * `extractText` / `extractToolCall` and needs no narrowing.)
 */
function narrowToToolLoopEvents(
  streamTurn: (messages: LoopMessage[]) => AsyncIterable<LoopEvent>,
): (messages: LoopMessage[]) => AsyncIterable<ToolLoopEvent> {
  return (messages) =>
    (async function* () {
      for await (const ev of streamTurn(messages)) {
        if (ev.type === 'text') yield { type: 'text', text: ev.text }
        else if (ev.type === 'tool_call') yield { type: 'tool_call', call: ev.call }
        else yield { type: 'other', event: ev }
      }
    })()
}

/** Assemble the system prompt from the config identity (DATA → prompt). */
function buildSystemPrompt(): string {
  const fragments = [
    config.identity.persona,
    ...(config.identity.systemPromptFragments ?? []),
    ...Object.values(config.identity.disclaimers ?? {}),
  ]
  return fragments.join('\n\n')
}

/** A product installs this server-side resolver; body identities are never trusted. */
export interface HeadlessAuth {
  authenticate(request: Request, env: AppBindings): Promise<AppToolContext | null>
}
export function createHeadlessWorker(auth?: HeadlessAuth) { return {
  async fetch(request: Request, env: AppBindings): Promise<Response> {
    const surface = headlessAgentSurfaces(new URL(request.url).origin).handle(request)
    if (surface) return surface
    const url = new URL(request.url)
    if (url.pathname !== '/chat' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 })
    }

    if (!auth) return Response.json({ error: 'Authentication is not configured', code: 'auth.not_configured' }, { status: 503 })
    const ctx = await auth.authenticate(request, env)
    if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const body = (await request.json()) as ChatRequest
    if (!body.message) {
      return new Response(JSON.stringify({ error: 'message is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const app = createAgentApp(env)

    const executor = createAppToolRuntimeExecutor({
      handlers: app.handlers,
      taxonomy: app.taxonomy,
      ctx,
    })

    const tools = buildAppToolOpenAITools(app.taxonomy)

    const result = await runAppToolLoop({
      systemPrompt: buildSystemPrompt(),
      userMessage: body.message,
      streamTurn: narrowToToolLoopEvents(createOpenAICompatStreamTurn({ ...app.resolveModel(), tools })),
      executeToolCall: (call: LoopToolCall) => executor({ toolName: call.toolName, args: call.args }),
      isExecutableTool: isAppToolName,
    })

    return new Response(
      JSON.stringify({
        text: result.finalText,
        toolResults: result.toolResults.map((t: ToolLoopResult['toolResults'][number]) => ({
          label: t.label,
          outcome: t.outcome,
        })),
        turns: result.turns,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  },
} }

export default createHeadlessWorker()
