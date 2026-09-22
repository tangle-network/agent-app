// Controlled probe: does a box turn's requested model survive to the router?
// One box, one session per model, unique marker prompts, timestamps printed
// so the router origin log can be matched second-by-second.
import { SandboxClient } from '@tangle-network/sandbox'

const models = (process.env.PROBE_MODELS ?? 'gpt-5-mini,claude-sonnet-4-6,gpt-5.5').split(',')
const client = new SandboxClient({
  apiKey: process.env.SANDBOX_API_KEY,
  baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools',
})
const box = await client.create({ name: `model-substitution-probe-${Date.now()}`.slice(0, 63) })
console.log(`[probe] box ${box.id}`)

for (const model of models) {
  const marker = `PROOFTOKEN-${model.replace(/[^a-z0-9]/gi, '').toUpperCase()}`
  const t0 = new Date().toISOString()
  let text = ''
  let terminal = null
  try {
    for await (const ev of box.streamPrompt(
      `Repeat this exact token once and nothing else: ${marker}`,
      { model, sessionId: `probe-${model.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}` },
    )) {
      if (ev?.type === 'error' || ev?.type === 'session.run.failed') terminal = ev
      if (ev?.type === 'message.part.updated') {
        const part = ev.data?.part ?? {}
        if (part.type === 'text' && part.text) text = part.text
      }
    }
  } catch (err) {
    terminal = { thrown: String(err?.message ?? err) }
  }
  const t1 = new Date().toISOString()
  console.log(
    JSON.stringify({ model, window: [t0, t1], answered: text.slice(0, 80), terminal: terminal ? JSON.stringify(terminal).slice(0, 300) : null }),
  )
}
console.log('[probe] done')
