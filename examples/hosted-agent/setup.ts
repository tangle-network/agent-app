import { createHostedAgent } from '@tangle-network/agent-app/hosted-agent'
import { persona } from './src/worker'

/**
 * One-time: route an Inkbox iMessage identity, already connected to Hub under
 * this app's Tangle account, to the deployed Worker.
 *
 *   TANGLE_API_KEY=... HUB_CALLBACK_SECRET=... CONNECTION_ID=hubconn_... \
 *   IDENTITY_ID=<inkbox identity uuid> WORKER_URL=https://juno.example.workers.dev npx tsx setup.ts
 */
const env = process.env as Record<string, string>
for (const name of ['TANGLE_API_KEY', 'HUB_CALLBACK_SECRET', 'CONNECTION_ID', 'IDENTITY_ID', 'WORKER_URL']) {
  if (!env[name]) throw new Error(`${name} is required`)
}
const braid = createHostedAgent({ apiKey: env.TANGLE_API_KEY, profile: persona, store: { get: async () => null, put: async () => {} } })
const subscription = await braid.connect({
  connectionId: env.CONNECTION_ID, identityId: env.IDENTITY_ID,
  callbackUrl: `${env.WORKER_URL.replace(/\/+$/, '')}/hub`, secret: env.HUB_CALLBACK_SECRET,
})
console.log(`subscription ${subscription.id} ${subscription.status} ${subscription.event}`)
