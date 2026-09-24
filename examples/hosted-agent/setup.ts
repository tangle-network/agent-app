import { HubClient } from '@tangle-network/hub-sdk'
import { braid } from './src/worker'

/**
 * One-time: attach an Inkbox iMessage identity, already connected to Hub
 * under this app's Tangle account, as Braid's line. Hub then routes each text
 * to the sender's own box and replies itself.
 *
 *   TANGLE_API_KEY=... OWNER_PHONE=+1... CONNECTION_ID=hubconn_... npx tsx setup.ts
 *
 * An app that routed the identity to its own Worker before (an event
 * subscription) has that subscription removed first, since Hub refuses a line
 * that another route would also answer.
 */
const env = process.env as Record<string, string>
for (const name of ['TANGLE_API_KEY', 'OWNER_PHONE', 'CONNECTION_ID']) {
  if (!env[name]) throw new Error(`${name} is required`)
}
const hub = new HubClient({ baseUrl: 'https://id.tangle.tools', apiKey: env.TANGLE_API_KEY })
for (const subscription of (await hub.eventSubscriptions.list()).subscriptions) {
  if (subscription.clientReference !== `hosted-agent:${env.CONNECTION_ID}` || subscription.status !== 'active') continue
  await hub.eventSubscriptions.delete(subscription.id)
  console.log(`removed subscription ${subscription.id}`)
}
const attachment = await braid({ TANGLE_API_KEY: env.TANGLE_API_KEY, OWNER_PHONE: env.OWNER_PHONE }).attachLine(env.CONNECTION_ID)
console.log(`line ${attachment.lineId} attachment ${attachment.id} ${attachment.status} keyPrefix ${attachment.instance?.keyPrefix}`)
