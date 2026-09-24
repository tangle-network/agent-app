import { createHostedAgent } from '@tangle-network/agent-app/hosted-agent'

/**
 * Braid: an agent people text or call. Each person gets their own isolated
 * sandbox with its own memory, and every cost bills to this app's Tangle key.
 *
 *   iMessage  person -> Inkbox line -> Tangle Hub -> the person's own box -> Hub reply
 *   voice     person -> ph0ny number -> POST /voice/hook (admit) -> ask_workspace -> POST /voice/ask
 *
 * Texts never reach this Worker: Hub routes them (see setup.ts).
 */
export interface Env {
  TANGLE_API_KEY: string
  VOICE_SECRET: string
  /** Your own phone (E.164): the line's owner. */
  OWNER_PHONE: string
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

export const braid = (env: Pick<Env, 'TANGLE_API_KEY' | 'OWNER_PHONE'> & Partial<Env>) => createHostedAgent({
  apiKey: env.TANGLE_API_KEY,
  profile: persona,
  owner: env.OWNER_PHONE,
  freeTurnsPerDay: 30,
  store: env.USERS,
  voiceSecret: env.VOICE_SECRET,
})

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (request.method === 'POST' && pathname === '/voice/hook') return braid(env).voiceHook(request)
    if (request.method === 'POST' && pathname === '/voice/ask') return braid(env).voiceAsk(request)
    return new Response('Braid is a Tangle hosted agent. Text or call to talk.\n')
  },
} satisfies ExportedHandler<Env>
