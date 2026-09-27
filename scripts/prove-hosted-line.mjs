#!/usr/bin/env node
// Live operator proof. This uses real Hub/Sandbox requests, not fixtures.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createHostedAgent } from '@tangle-network/agent-app/hosted-agent'
import { Sandbox } from '@tangle-network/sandbox/core'

const required = name => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const mode = process.argv[2] ?? 'inspect'
if (!['attach', 'inspect'].includes(mode)) throw new Error('Usage: node prove-hosted-line.mjs attach|inspect')
const apiKey = required('TANGLE_API_KEY')
const baseUrl = process.env.SANDBOX_URL ?? 'https://sandbox.tangle.tools'
const evidence = resolve(process.env.PROOF_DIR ?? 'hosted-line-proof')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const client = new Sandbox({ apiKey, baseUrl, timeoutMs: 45_000 })
const stamp = new Date().toISOString().replaceAll(':', '-')
const save = async (name, value) => {
  await writeFile(resolve(evidence, `${stamp}-${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
let lineId = process.env.LINE_ID
if (mode === 'attach') {
  const profileBytes = await readFile(required('PROFILE_JSON'), 'utf8')
  const profile = JSON.parse(profileBytes)
  const config = {
    id: required('HOSTED_AGENT_ID'), apiKey, profile,
    owner: required('OWNER_ADDRESS'), sandboxUrl: baseUrl,
    members: JSON.parse(process.env.MEMBERS_JSON ?? '[]'),
    freeTurnsPerDay: Number(process.env.FREE_TURNS ?? '20'),
  }
  const agent = createHostedAgent(config)
  if (agent.identity?.revision !== 1 || agent.identity.id !== config.id) {
    throw new Error('The installed agent-app package does not implement named hosted agents. Install the built PR tarball or its published release.')
  }
  const options = {
    transport: required('TRANSPORT'), mode: process.env.LINE_MODE ?? 'personal',
    ...(process.env.PHONE_NUMBER_ID ? { phoneNumberId: process.env.PHONE_NUMBER_ID } : {}),
    unknownSenders: 'reject',
  }
  const connection = required('CONNECTION_ID')
  const first = await agent.attachLine(connection, options)
  const second = await agent.attachLine(connection, options)
  if (!first.attachment || first.id !== second.id || first.attachment.id !== second.attachment?.id) {
    throw new Error('Repeated attach did not return the same line and attachment')
  }
  if (second.attachment.instance?.keyPrefix !== agent.identity.instanceKeyPrefix) {
    throw new Error('Hub did not preserve the assistant-specific instance namespace')
  }
  lineId = second.id
  await save('attach', { identity: agent.identity, profileSha256: createHash('sha256').update(profileBytes).digest('hex'), line: second })
}
if (!lineId) throw new Error('LINE_ID is required for inspect')
const line = await client.lines.get(lineId)
const members = await client.lines.members(lineId).list()
const threads = await client.lines.threads(lineId).list()
const exchanges = []
for (const thread of threads) {
  exchanges.push({ thread, messages: await client.lines.threads(lineId).messages(thread.id) })
}
await save('inspect', { line, members, exchanges })
console.log(JSON.stringify({ lineId, attachmentId: line.attachment?.id, address: line.address, connect: line.connect, routerAddress: line.routerAddress, members: members.length, threads: threads.map(thread => ({ id: thread.id, sandboxId: thread.sandboxId })), evidence }, null, 2))
