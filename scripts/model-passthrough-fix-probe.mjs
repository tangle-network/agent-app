// Controlled experiment: same box, two shapes of per-turn model request.
//   A (control)  : { model: 'gpt-5-mini' }                     — top-level option (P0 probe's shape)
//   B (documented): { backend: { model: { model: 'gpt-5-mini' } } }
// Router origin log is then matched to the printed windows.
import { SandboxClient } from '@tangle-network/sandbox'

const client = new SandboxClient({
  apiKey: process.env.SANDBOX_API_KEY,
  baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools',
})
const box = await client.create({ name: `model-passthrough-fix-probe-${Date.now()}`.slice(0, 63) })
console.log(`[probe] box ${box.id}`)

async function turn(label, options) {
  const marker = `PROOFTOKEN-${label}`
  const t0 = new Date().toISOString()
  let text = ''
  let terminal = null
  try {
    for await (const ev of box.streamPrompt(
      `Repeat this exact token once and nothing else: ${marker}`,
      { sessionId: `probe-${label.toLowerCase()}-${Date.now()}`, ...options },
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
  console.log(JSON.stringify({
    label,
    window: [t0, t1],
    answered: text.slice(0, 80),
    terminal: terminal ? JSON.stringify(terminal).slice(0, 300) : null,
  }))
}

await turn('SHAPEA-TOPLEVEL', { model: 'gpt-5-mini' })
await turn('SHAPEB-BACKEND', { backend: { model: { model: 'gpt-5-mini' } } })
console.log('[probe] done')
