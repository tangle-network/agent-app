import { createHostedAgent } from '@tangle-network/agent-app/hosted-agent'

export function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(name + ' is required')
  return value
}

/** The application. Hub owns ingress, member isolation, turns and replies. */
export async function installAssistant() {
  const transport = process.env.TRANSPORT ?? 'email'
  if (!['email', 'whatsapp', 'imessage'].includes(transport)) throw new Error('Unsupported TRANSPORT')
  const agent = createHostedAgent({
    apiKey: required('TANGLE_API_KEY'),
    sandboxUrl: process.env.SANDBOX_URL ?? 'https://sandbox.tangle.tools',
    owner: required('OWNER_ADDRESS'),
    harness: 'opencode',
    freeTurnsPerDay: 10,
    profile: {
      name: 'Fieldnotes',
      model: { default: required('MODEL') },
      prompt: { systemPrompt: [
        'You are Fieldnotes, a helpful personal assistant. Keep replies brief.',
        'Use file tools to keep lasting user facts in /workspace/memory.md.',
        'Read those notes before answering a question about the person.',
        'When asked about scheduled work, read /workspace/scheduled-work.json.',
        'That file is evidence from an owner-configured platform workflow.',
        'Report its exact marker and result, not a guess. Missing files mean no evidence.',
        'Do not claim a reminder or external action was installed unless a tool proves it.',
      ].join(' ') },
    },
  })
  return agent.attachLine(required('CONNECTION_ID'), {
    transport,
    mode: 'personal',
    ...(transport === 'whatsapp' ? { phoneNumberId: required('PHONE_NUMBER_ID') } : {}),
  })
}
