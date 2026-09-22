import { SandboxClient } from '@tangle-network/sandbox'
const client = new SandboxClient({
  apiKey: process.env.SANDBOX_API_KEY,
  baseUrl: process.env.SANDBOX_API_URL,
})
const name = `track-a-create-canary-${Date.now()}`.slice(0, 63)
try {
  const box = await client.create({ name })
  console.log(JSON.stringify({ ok: true, id: box.id, name }))
  try { await box.delete() ; console.log('[canary] deleted') } catch (e) { console.log('[canary] delete failed:', String(e?.message ?? e).slice(0,200)) }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err).slice(0, 500), status: err?.status ?? err?.statusCode ?? null }))
  process.exit(2)
}
