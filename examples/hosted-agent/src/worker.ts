import { createHostedAgent } from '@tangle-network/agent-app/hosted-agent'

/**
 * Braid: an agent people text or call. Each person gets their own isolated
 * sandbox with its own memory, and every cost bills to this app's Tangle key.
 *
 *   iMessage  person -> Inkbox line -> Tangle Hub -> the person's own box -> Hub reply
 *   voice     person -> ph0ny number -> POST /voice/hook (admit) -> ask_workspace -> POST /voice/ask
 *
 * Texts never reach this Worker: Hub routes them once `POST /setup` has
 * attached the line.
 */
export interface Env {
  TANGLE_API_KEY: string
  VOICE_SECRET: string
  /** Your own phone (E.164): the line's owner. */
  OWNER_PHONE: string
  /** Enables `POST /setup` while set. */
  SETUP_SECRET?: string
  /** Voice call tokens. */
  USERS: KVNamespace
}

export const persona = {
  name: 'Braid',
  model: { default: 'openai/gpt-5.6-luna' },
  prompt: {
    systemPrompt: [
      'Your name is Braid. You are a friend people text: warm, curious, direct and brief.',
      'You are not a coding assistant. Talk about the person\'s life and plans; never offer to write, review or refactor code.',
      'Write like a person texting: one to three short sentences, no markdown, no lists, no links unless asked.',
      'You remember people. When someone tells you something lasting about themselves (their name, plans, people,',
      'preferences, what they are working on), append one line to memory.md in your workspace. Read memory.md',
      'when it would help you answer, so you can follow up on what they told you before.',
      'Ask at most one question at a time. Say plainly when you do not know something.',
      'You are texting or on a call with them now, but you only answer when they reach out: you cannot message them later,',
      'set reminders, or look up live facts such as weather or news. Never promise a follow-up or a reminder; say plainly',
      'what you cannot do and how they can do it themselves.',
      'If asked what you are, say you are Braid, an AI; do not name the model or company behind you.',
    ].join(' '),
  },
}

const braid = (env: Env) => createHostedAgent({
  apiKey: env.TANGLE_API_KEY,
  profile: persona,
  owner: env.OWNER_PHONE,
  freeTurnsPerDay: 30,
  store: env.USERS,
  voiceSecret: env.VOICE_SECRET,
})

/**
 * One-time: attach an Inkbox iMessage identity, already connected to Hub under
 * this app's Tangle account, as Braid's line. It runs here because the Worker
 * holds the app's key. A Hub event subscription an earlier version of this
 * app made on the connection is removed first: Hub refuses a line that
 * another route would also answer.
 */
async function setup(request: Request, env: Env): Promise<Response> {
  const given = new TextEncoder().encode(request.headers.get('authorization') ?? '')
  const expected = new TextEncoder().encode(`Bearer ${env.SETUP_SECRET}`)
  if (!env.SETUP_SECRET || given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected)) {
    return new Response('not found', { status: 404 })
  }
  const { connectionId } = await request.json() as { connectionId: string }
  const hub = (path: string, init?: RequestInit) =>
    fetch(`https://id.tangle.tools/v1/hub/${path}`, { ...init, headers: { authorization: `Bearer ${env.TANGLE_API_KEY}` } })
  const listed = await (await hub('event-subscriptions')).json() as { data: { subscriptions: Array<{ id: string; clientReference: string }> } }
  for (const subscription of listed.data.subscriptions) {
    if (subscription.clientReference === `hosted-agent:${connectionId}`) await hub(`event-subscriptions/${subscription.id}`, { method: 'DELETE' })
  }
  try {
    return Response.json(await braid(env).attachLine(connectionId))
  } catch (error) {
    return Response.json({ error: String(error).slice(0, 500) }, { status: 502 })
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (request.method === 'POST' && pathname === '/setup') return setup(request, env)
    if (request.method === 'POST' && pathname === '/voice/hook') return braid(env).voiceHook(request)
    if (request.method === 'POST' && pathname === '/voice/ask') return braid(env).voiceAsk(request)
    return new Response('Braid is a Tangle hosted agent. Text or call to talk.\n')
  },
} satisfies ExportedHandler<Env>
