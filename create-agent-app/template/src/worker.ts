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
 * Replace the system-prompt assembly + per-turn context recovery with your real
 * auth/session once you have one. Keep the human-in-the-loop invariant: regulated
 * proposals stay proposals.
 */

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
} from '@tangle-network/agent-app/runtime'

interface ChatRequest {
  message: string
  /** Trusted server-side in a real app; taken from the body here for the skeleton. */
  userId?: string
  workspaceId?: string
  threadId?: string | null
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

export default {
  async fetch(request: Request, env: AppBindings): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/chat' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 })
    }

    const body = (await request.json()) as ChatRequest
    if (!body.message) {
      return new Response(JSON.stringify({ error: 'message is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const app = createAgentApp(env)

    // Trusted per-turn context. In production recover this from your auth/session,
    // NEVER from model tool args — the model must not be able to forge identity.
    const ctx: AppToolContext = {
      userId: body.userId ?? 'anonymous',
      workspaceId: body.workspaceId ?? 'default',
      threadId: body.threadId ?? null,
    }

    const executor = createAppToolRuntimeExecutor({
      handlers: app.handlers,
      taxonomy: app.taxonomy,
      ctx,
    })

    const tools = buildAppToolOpenAITools(app.taxonomy)

    const result = await runAppToolLoop({
      systemPrompt: buildSystemPrompt(),
      userMessage: body.message,
      streamTurn: createOpenAICompatStreamTurn({ ...app.resolveModel(), tools }),
      executeToolCall: (call) => executor({ toolName: call.toolName, args: call.args }),
      isExecutableTool: isAppToolName,
    })

    return new Response(
      JSON.stringify({
        text: result.finalText,
        toolResults: result.toolResults.map((t) => ({ label: t.label, outcome: t.outcome })),
        turns: result.turns,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  },
}
