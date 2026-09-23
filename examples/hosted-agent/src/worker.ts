import { createHostedAgent, type HostedInbound } from '@tangle-network/agent-app/hosted-agent'

/**
 * Juno: an agent people text or call. Each person gets their own isolated
 * sandbox with its own memory, and every cost bills to this app's Tangle key.
 *
 *   iMessage  person -> Inkbox shared line -> Hub -> POST /hub -> queue -> answer -> Hub reply
 *   voice     person -> ph0ny number -> POST /voice/hook (admit) -> ask_workspace -> POST /voice/ask
 */
export interface Env {
  TANGLE_API_KEY: string
  HUB_CALLBACK_SECRET: string
  VOICE_SECRET: string
  USERS: KVNamespace
  TURNS: Queue<HostedInbound>
}

export const persona = {
  name: 'Juno',
  prompt: {
    systemPrompt: [
      'Your name is Juno. You are a friend people text: warm, curious, direct and brief.',
      'Write like a person texting: one to three short sentences, no markdown, no lists, no links unless asked.',
      'You remember people. When someone tells you something lasting about themselves (their name, plans, people,',
      'preferences, what they are working on), append one line to memory.md in your workspace. Read memory.md',
      'when it would help you answer, so you can follow up on what they told you before.',
      'Ask at most one question at a time. Say plainly when you do not know something. If asked, say you are an AI.',
    ].join(' '),
  },
}

const agent = (env: Env) => createHostedAgent({
  apiKey: env.TANGLE_API_KEY,
  profile: persona,
  store: env.USERS,
  voiceSecret: env.VOICE_SECRET,
  freeTurnsPerDay: 30,
})

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (request.method === 'POST' && pathname === '/hub') {
      const { response, inbound } = await agent(env).receive(request, env.HUB_CALLBACK_SECRET)
      if (inbound) await env.TURNS.send(inbound)
      return response
    }
    if (request.method === 'POST' && pathname === '/voice/hook') return agent(env).voiceHook(request)
    if (request.method === 'POST' && pathname === '/voice/ask') return agent(env).voiceAsk(request)
    return new Response('Juno is a Tangle hosted agent. Text or call to talk.\n')
  },

  async queue(batch, env) {
    const juno = agent(env)
    for (const message of batch.messages) {
      try {
        const outcome = await juno.respond(message.body, { lastAttempt: message.attempts >= 6 })
        if (outcome === 'pending') message.retry({ delaySeconds: 10 })
        else message.ack()
        console.log(`[juno] run=${message.body.runId} attempt=${message.attempts} outcome=${outcome}`)
      } catch (error) {
        console.error(`[juno] run=${message.body.runId} attempt=${message.attempts} error=${String(error).slice(0, 300)}`)
        message.retry({ delaySeconds: 20 })
      }
    }
  },
} satisfies ExportedHandler<Env, HostedInbound>
