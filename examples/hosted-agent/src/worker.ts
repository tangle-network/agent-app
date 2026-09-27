import { createHostedAgent, HostedAgentError, type HostedAgentLineOptions } from '@tangle-network/agent-app/hosted-agent'

/** Hub receives messages. This Worker only installs an explicitly selected line. */
export interface Env {
  TANGLE_API_KEY: string
  /** Email or E.164 address. OWNER_PHONE is retained for existing deployments. */
  OWNER_ADDRESS?: string
  OWNER_PHONE?: string
  SETUP_SECRET?: string
}

export const persona = {
  name: 'Braid',
  model: { default: 'openai/gpt-5.6-luna' },
  prompt: {
    systemPrompt: [
      'Your name is Braid. You are a friend people text: warm, curious, direct and brief.',
      'You are not a coding assistant. Talk about the person\'s life and plans.',
      'Write one to three short sentences. Ask at most one question at a time.',
      'When someone tells you a lasting fact about themselves, append it to memory.md.',
      'Read memory.md when it helps you answer. Never claim a file write succeeded without a tool result.',
      'You only answer when they reach out. This example has no reminder or live-search tool.',
      'Never promise a later message, reminder or live lookup. Say plainly when you do not know.',
      'If asked what you are, say you are Braid, an AI.',
    ].join(' '),
  },
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** No implicit connection discovery, webhook deletion or provider credentials. */
async function setup(request: Request, env: Env): Promise<Response> {
  const given = new TextEncoder().encode(request.headers.get('authorization') ?? '')
  const expected = new TextEncoder().encode(`Bearer ${env.SETUP_SECRET}`)
  if (!env.SETUP_SECRET || given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected))
    return new Response('not found', { status: 404 })
  const owner = env.OWNER_ADDRESS ?? env.OWNER_PHONE
  if (!owner) return Response.json({ error: 'owner_not_configured' }, { status: 503 })
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }
  if (!record(body) || typeof body.connectionId !== 'string' || !body.connectionId.trim() || body.connectionId.length > 256)
    return Response.json({ error: 'connectionId is required' }, { status: 400 })
  if ((body.transport !== undefined && !['imessage', 'email', 'whatsapp'].includes(String(body.transport))) ||
      (body.mode !== undefined && !['personal', 'shared'].includes(String(body.mode))) ||
      (body.phoneNumberId !== undefined && (typeof body.phoneNumberId !== 'string' || !body.phoneNumberId.trim() || body.phoneNumberId.length > 256)) ||
      (body.voice !== undefined && (!record(body.voice) || typeof body.voice.ph0nyConnectionId !== 'string' || typeof body.voice.ph0nyAgentId !== 'string')))
    return Response.json({ error: 'invalid_line_options' }, { status: 400 })
  const options: HostedAgentLineOptions = {
    transport: body.transport as HostedAgentLineOptions['transport'],
    mode: body.mode as HostedAgentLineOptions['mode'],
    phoneNumberId: body.phoneNumberId as string | undefined,
    voice: body.voice as HostedAgentLineOptions['voice'],
  }
  try {
    const agent = createHostedAgent({ apiKey: env.TANGLE_API_KEY, profile: persona, owner, freeTurnsPerDay: 30 })
    return Response.json(await agent.attachLine(body.connectionId, options))
  } catch (error) {
    if (error instanceof HostedAgentError)
      return Response.json({ error: error.code, message: error.message }, { status: 400 })
    if (record(error) && error.status === 409)
      return Response.json({
        error: 'line_setup_conflict',
        message: 'This connection is already routed. For an older Braid deployment, explicitly remove its hosted-agent event subscription in Hub, then repeat setup. For an attached line, use its existing configuration or explicitly detach before changing it. Setup has not removed either route.',
      }, { status: 409 })
    // Provider evidence and credentials never become a public response.
    return Response.json({ error: 'line_setup_failed', message: 'Check the owned Hub connection and provider readiness.' }, { status: 502 })
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/setup') return setup(request, env)
    return new Response('Braid is a Tangle hosted agent. Contact its configured line.\n')
  },
} satisfies ExportedHandler<Env>
