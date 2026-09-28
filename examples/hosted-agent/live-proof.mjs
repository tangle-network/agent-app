import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Sandbox, lineInstanceKey } from '@tangle-network/sandbox/core'
import { HubClient } from '@tangle-network/hub-sdk'
import { installAssistant, required } from './assistant.mjs'

const dir = process.env.PROOF_DIR ?? './proof'
await mkdir(dir, { recursive: true, mode: 0o700 })
const save = (name, value) => writeFile(dir + '/' + name + '.json', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const load = async name => JSON.parse(await readFile(dir + '/' + name + '.json', 'utf8'))
const sandbox = new Sandbox({ apiKey: required('TANGLE_API_KEY'), baseUrl: process.env.SANDBOX_URL ?? 'https://sandbox.tangle.tools' })
const hub = new HubClient({ apiKey: required('TANGLE_API_KEY'), baseUrl: process.env.PLATFORM_URL ?? 'https://id.tangle.tools' })
const command = process.argv[2]

async function memberThread() {
  const saved = await load('line')
  const line = await sandbox.lines.get(saved.id)
  assert.equal(line.attachment?.status, 'active', 'Line must have an active attachment')
  const address = required('OWNER_ADDRESS').trim().toLowerCase()
  const members = await sandbox.lines.members(line.id).list()
  const member = members.find(m => m.address.toLowerCase() === address)
  assert.ok(member, 'Declared owner member is missing')
  assert.equal(member.status, 'active', 'Complete the real email challenge or send a real phone message first')
  const threads = await sandbox.lines.threads(line.id).list()
  const thread = threads.find(t => t.memberId === member.id && t.status === 'active')
  assert.ok(thread, 'The real message must have created a thread')
  const key = await lineInstanceKey(line.attachment.instance.keyPrefix, member.address)
  const instance = await sandbox.instances.get(key)
  assert.equal(instance?.sandboxId, thread.sandboxId, 'Line thread must use the named instance')
  return { line, member, thread, key, instance }
}

if (command === 'setup') {
  const line = await installAssistant()
  await save('line', line)
  assert.equal(line.attachment?.status, 'active')
  const again = await installAssistant()
  assert.equal(again.id, line.id)
  assert.equal(again.attachment?.id, line.attachment.id, 'Repeat setup must not create another attachment')
  console.log(JSON.stringify({ lineId: line.id, transport: line.transport, address: line.address, connect: line.connect,
    routerAddress: line.routerAddress, instanceKeyPrefix: line.attachment.instance?.keyPrefix }, null, 2))
} else if (command === 'inspect') {
  const state = await memberThread()
  const messages = await sandbox.lines.threads(state.line.id).messages(state.thread.id)
  await save('conversation', { ...state, messages })
  assert.ok(messages.some(m => m.direction === 'in' && m.turnId), 'No real inbound turn receipt')
  assert.ok(messages.some(m => m.direction === 'out' && m.kind === 'agent'), 'No agent reply row')
  console.log(JSON.stringify({ lineId: state.line.id, threadId: state.thread.id, sandboxId: state.thread.sandboxId,
    instanceKey: state.key, messages: messages.map(m => ({ id: m.id, direction: m.direction, kind: m.kind,
      turnId: m.turnId, status: m.status, errorCode: m.errorCode })) }, null, 2))
} else if (command === 'schedule') {
  const state = await memberThread()
  assert.ok(!state.line.attachment.limits.allowance,
    'This developer-owned proof is not a substitute for metered member admission')
  const marker = 'scheduled-' + randomUUID()
  const source = `import { Sandbox } from '../sdk.mjs';
export default async function run(input) {
  const sdk = new Sandbox({ apiKey: process.env.TANGLE_SANDBOX_API_KEY, baseUrl: process.env.TANGLE_SANDBOX_API_URL });
  const record = await sdk.instances.get(input.key);
  if (!record || record.sandboxId !== input.sandboxId) throw new Error('The assistant instance changed; refuse to write elsewhere');
  const box = await sdk.get(record.sandboxId);
  if (!box) throw new Error('Assistant sandbox is absent');
  const document = { marker: input.marker, result: 137 * 29 };
  const program = 'require("node:fs").writeFileSync("/workspace/scheduled-work.json",' + JSON.stringify(JSON.stringify(document)) + '); console.log(' + JSON.stringify(JSON.stringify(document)) + ')';
  const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
  const result = await box.exec('node -e ' + quote(program));
  if (result.exitCode !== 0) throw new Error('Scheduled sandbox command failed');
  return { sandboxId: box.id, key: input.key, ...JSON.parse(result.stdout.trim()) };
}`
  const definition = { name: 'assistant-proof-' + randomUUID().slice(0, 8), on: { schedule: { cron: '* * * * *', timezone: 'UTC' } },
    do: [{ 'script.run': { timeoutMs: 120000, input: { key: state.key, sandboxId: state.thread.sandboxId, marker }, source } }] }
  const workflow = await hub.workflows.create(JSON.stringify(definition))
  console.log('Created scheduled workflow ' + workflow.id + '. No manual run is issued.')
  try {
    await save('workflow', { id: workflow.id, marker, sandboxId: state.thread.sandboxId, key: state.key })
    const deadline = Date.now() + 240000
    let run
    while (Date.now() < deadline) {
      const page = await hub.workflows.listRuns(workflow.id, { limit: 5 })
      if (page.runs.length) { run = page.runs[0]; break }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    assert.ok(run, 'The real schedule did not fire within the proof window')
    await hub.workflows.setEnabled(workflow.id, false)
    const detail = await hub.workflows.waitForRun(workflow.id, run.id, { timeoutMs: 180000 })
    await save('scheduled-run', detail)
    assert.equal(detail.status, 'succeeded', 'Scheduled run failed; inspect the retained receipt')
    const box = await sandbox.get(state.thread.sandboxId)
    assert.ok(box)
    const read = await box.exec('cat /workspace/scheduled-work.json')
    assert.equal(read.exitCode, 0)
    const document = JSON.parse(read.stdout)
    assert.deepEqual(document, { marker, result: 3973 })
    await save('scheduled-file', document)
    console.log(JSON.stringify({ workflowId: workflow.id, runId: run.id, sandboxId: box.id, ...document }, null, 2))
  } finally {
    await hub.workflows.setEnabled(workflow.id, false)
  }
} else if (command === 'pause') {
  const workflow = await load('workflow')
  await hub.workflows.setEnabled(workflow.id, false)
  console.log('Paused ' + workflow.id)
} else if (command === 'detach') {
  const line = await load('line')
  assert.equal(required('CONFIRM_LINE_ID'), line.id, 'Confirm the exact disposable line id')
  // Operator cleanup only. The installed 0.53 SDK has no global lines.detach;
  // that verb ships in 0.54.2. Keep the proof on its declared registry floor.
  const response = await sandbox.fetch('/v1/lines/' + encodeURIComponent(line.id) + '/attachment', { method: 'DELETE' })
  const receipt = await response.json()
  assert.ok(response.ok, 'Line detach failed: HTTP ' + response.status)
  assert.equal(receipt.success, true)
  assert.equal(typeof receipt.data?.detached, 'boolean')
  await save('detach', { status: response.status, ...receipt })
  console.log('Detached ' + line.id + '. Its sandbox and receipts are retained.')
} else {
  throw new Error('Use setup, inspect, schedule, pause, or detach')
}
