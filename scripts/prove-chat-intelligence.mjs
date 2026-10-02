import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const entry = process.env.AGENT_APP_OBSERVATION_ENTRY
  ? pathToFileURL(resolve(process.env.AGENT_APP_OBSERVATION_ENTRY))
  : new URL(process.argv.includes('--source')
    ? '../src/chat-routes/intelligence.ts'
    : '../dist/chat-routes/index.js', import.meta.url)
const { observeChatTurnStream, produceChatTurnWithIntelligence } = await import(entry.href)
const results = []
const test = async (name, fn) => {
  try { await fn(); results.push({ name, passed: true }) }
  catch (error) { results.push({ name, passed: false, error: error.message }) }
}
const setup = (overrides = {}) => {
  const records = []
  let clientCalls = 0
  const options = {
    sessionId: 'session', userId: 'user', workspaceId: 'workspace',
    runId: 'native-execution', model: 'requested-model',
    client: () => {
      clientCalls++
      return { async traceRun(meta, body) {
        const outcome = await body({
          recordOutput() { throw new Error('Unexpected content export') },
          recordOutcome() { throw new Error('Unexpected task-success claim') },
        })
        assert.equal(outcome, undefined)
        records.push(structuredClone(meta))
      } }
    }, ...overrides,
  }
  return { records, options, clientCalls: () => clientCalls }
}
const status = (records) => records.map(r => r.labels['tangle.stream.termination'])
async function* normal() { yield { type: 'one' }; yield { type: 'two' } }

await test('construction does not pull or emit a completed observation', async () => {
  const { records, options, clientCalls } = setup()
  let started = false
  async function* source() { started = true; yield { type: 'one' } }
  const stream = observeChatTurnStream(source(), options)
  await Promise.resolve()
  assert.equal(started, false); assert.equal(clientCalls(), 0)
  await stream.next()
  assert.equal(started, true); assert.equal(records.length, 0)
  await stream.next()
  assert.deepEqual(status(records), ['exhausted'])
})
await test('native pull ordering and sent values survive queued next calls', async () => {
  const { records, options } = setup(); const inputs = []
  async function* source() { inputs.push(yield { type: 'one' }); inputs.push(yield { type: 'two' }) }
  const stream = observeChatTurnStream(source(), options)
  const outcomes = await Promise.all([stream.next(), stream.next('a'), stream.next('b')])
  assert.deepEqual(outcomes.map(r => r.done), [false, false, true])
  assert.deepEqual(inputs, ['a', 'b']); assert.deepEqual(status(records), ['exhausted'])
})
await test('the original event objects are returned without serialization', async () => {
  const { options } = setup(); const event = { type: 'tool', data: { identity: Symbol('local') } }
  async function* source() { yield event }
  const stream = observeChatTurnStream(source(), options)
  assert.equal((await stream.next()).value, event); await stream.return()
})
await test('an original thrown source error is preserved', async () => {
  const { records, options } = setup(); const failure = new Error('source')
  async function* source() { yield { type: 'partial' }; throw failure }
  const stream = observeChatTurnStream(source(), options); await stream.next()
  await assert.rejects(stream.next(), e => e === failure)
  assert.deepEqual(status(records), ['failed'])
})
await test('non-Error thrown values are preserved and never exported', async () => {
  const { records, options } = setup(); const failure = { private: 'do-not-export' }
  async function* source() { throw failure }
  const stream = observeChatTurnStream(source(), options)
  await assert.rejects(stream.next(), e => e === failure)
  assert.deepEqual(status(records), ['failed'])
  assert.equal(JSON.stringify(records).includes('do-not-export'), false)
})
await test('a consumer throw can be recovered by the source', async () => {
  const { records, options } = setup(); const error = new Error('recover'); let caught
  async function* source() { try { yield { type: 'one' } } catch(e) { caught=e; yield { type:'recovered' } } }
  const stream = observeChatTurnStream(source(), options); await stream.next()
  assert.equal((await stream.throw(error)).value.type, 'recovered'); assert.equal(caught, error)
  assert.equal(records.length, 0); await stream.next(); assert.deepEqual(status(records), ['exhausted'])
})
await test('an uncaught consumer throw is preserved', async () => {
  const { records, options } = setup(); const error = new Error('uncaught')
  const stream = observeChatTurnStream(normal(), options); await stream.next()
  await assert.rejects(stream.throw(error), e => e === error)
  assert.deepEqual(status(records), ['failed'])
})
await test('return forwards its value and records interruption', async () => {
  const { records, options } = setup(); const stream = observeChatTurnStream(normal(), options)
  await stream.next(); const result = await stream.return('native-return')
  assert.deepEqual(result, { value: 'native-return', done: true })
  assert.deepEqual(status(records), ['interrupted'])
})
await test('yielded cancellation cleanup must finish before observation', async () => {
  const { records, options } = setup(); let cleaned = false
  async function* source() { try { yield { type:'one' } } finally { yield {type:'cleanup'}; cleaned=true } }
  const stream = observeChatTurnStream(source(), options); await stream.next()
  assert.deepEqual(await stream.return('return-value'), {done:false, value:{type:'cleanup'}})
  assert.equal(cleaned, false); assert.equal(records.length, 0)
  assert.deepEqual(await stream.next(), {done:true, value:'return-value'})
  assert.equal(cleaned, true); assert.deepEqual(status(records), ['interrupted'])
})
await test('queued return does not relabel earlier natural exhaustion', async () => {
  const { records, options } = setup(); async function* source() { yield {type:'one'} }
  const stream = observeChatTurnStream(source(), options); await stream.next()
  await Promise.all([stream.next(), stream.return('after-exhaustion')])
  assert.deepEqual(status(records), ['exhausted'])
})
await test('queued return that actually closes the source is interruption', async () => {
  const { records, options } = setup(); const stream = observeChatTurnStream(normal(), options)
  await stream.next(); await Promise.all([stream.return(), stream.next()])
  assert.deepEqual(status(records), ['interrupted'])
})
await test('cleanup errors are original failures, not false successful cancellation', async () => {
  const { records, options } = setup(); const failure = new Error('cleanup')
  async function* source() { try { yield {type:'one'} } finally { throw failure } }
  const stream = observeChatTurnStream(source(), options); await stream.next()
  await assert.rejects(stream.return(), e=>e===failure); assert.deepEqual(status(records), ['failed'])
})
await test('pre-start return reaches factory-owned cleanup without a run claim', async () => {
  const { records, options, clientCalls } = setup(); const source=normal(); let returns=0
  const close=source.return.bind(source); source.return=(value)=>{returns++; return close(value)}
  const stream=observeChatTurnStream(source,options); await stream.return(); await stream.next()
  assert.equal(returns,1); assert.equal(records.length,0); assert.equal(clientCalls(),0)
})
await test('pre-start throw reaches the source without creating an execution', async () => {
  const { records, options } = setup(); const failure = new Error('never-started')
  const stream=observeChatTurnStream(normal(),options)
  await assert.rejects(stream.throw(failure),e=>e===failure); await stream.next()
  assert.equal(records.length,0)
})
await test('observation is emitted once across repeated terminal operations', async () => {
  const { records, options } = setup(); const stream=observeChatTurnStream(normal(),options)
  for await(const _ of stream) {}
  await stream.next(); await stream.return(); await assert.rejects(stream.throw(new Error('closed')))
  assert.deepEqual(status(records), ['exhausted'])
})
await test('interleaved streams keep run and tenant metadata separate', async () => {
  const a=setup(), b=setup({sessionId:'other',workspaceId:'other-workspace'})
  const first=observeChatTurnStream(normal(),a.options), second=observeChatTurnStream(normal(),b.options)
  await Promise.all([first.next(),second.next()]); await first.return()
  await second.next(); await second.next()
  assert.deepEqual(status(a.records),['interrupted']); assert.deepEqual(status(b.records),['exhausted'])
  assert.equal(a.records[0].labels['tangle.workspaceId'],'workspace')
  assert.equal(b.records[0].labels['tangle.workspaceId'],'other-workspace')
})
await test('metadata is captured before asynchronous factory work', async () => {
  const { records, options }=setup(); let release
  const ready=new Promise(r=>{release=r})
  const input={...options,produce:async()=>{await ready;return {stream:normal(),finalText:()=>''}}}
  const pending=produceChatTurnWithIntelligence(input); input.model='mutated'; input.sessionId='mutated'
  release(); const producer=await pending; for await(const _ of producer.stream){}
  assert.equal(records[0].model,'requested-model'); assert.equal(records[0].labels['tangle.sessionId'],'session')
})
await test('factory errors propagate without an invented stream observation', async () => {
  const { records, options }=setup(); const failure=new Error('factory')
  await assert.rejects(produceChatTurnWithIntelligence({...options,produce:()=>{throw failure}}),e=>e===failure)
  assert.equal(records.length,0)
})
await test('one producer is constructed and output is not read', async () => {
  const { records, options }=setup(); let factories=0, reads=0
  const producer=await produceChatTurnWithIntelligence({...options,produce:()=>{factories++;return{
    stream:normal(),finalText:()=>{reads++;return 'private-text'}
  }}})
  for await(const _ of producer.stream){}
  assert.equal(factories,1);assert.equal(reads,0);assert.equal(JSON.stringify(records).includes('private-text'),false)
})
await test('class-backed and frozen producer projections retain their receiver', async () => {
  const { options }=setup()
  class Producer {
    #text='private-value'; stream=normal()
    finalText(){return this.#text}
    assistantParts(){return [{type:'text',text:this.#text}]}
    draftParts(){return [{type:'text',text:this.#text}]}
    usage(){return {costUsd:0}}
    modelFailover(){return {usedFallback:false,attempts:[],model:this.#text}}
    modelAttribution(){return {echoReceived:true,servedModel:this.#text}}
  }
  const original=Object.freeze(new Producer()), originalStream=original.stream
  const producer=await produceChatTurnWithIntelligence({...options,produce:()=>original})
  for await(const _ of producer.stream){}
  assert.equal(original.stream,originalStream);assert.equal(producer.finalText(),'private-value')
  assert.equal(producer.assistantParts()[0].text,'private-value');assert.equal(producer.draftParts()[0].text,'private-value')
  assert.deepEqual(producer.usage(),{costUsd:0});assert.equal(producer.modelFailover().model,'private-value')
  assert.equal(producer.modelAttribution().servedModel,'private-value')
})
await test('model attribution getter is not eagerly read and stays live', async () => {
  const { options }=setup();let served='before',reads=0
  const original={stream:normal(),finalText:()=>'',get model(){reads++;return served}}
  const producer=await produceChatTurnWithIntelligence({...options,produce:()=>original})
  assert.equal(reads,0);served='actual';assert.equal(producer.model,'actual')
  for await(const _ of producer.stream){};assert.equal(reads,1)
})
await test('optional projection methods remain absent when unsupported', async () => {
  const { options }=setup();const producer=await produceChatTurnWithIntelligence({...options,produce:()=>({stream:normal(),finalText:()=>''})})
  for(const name of ['assistantParts','draftParts','usage','modelFailover','modelAttribution']) assert.equal(producer[name],undefined)
  await producer.stream.return()
})
await test('in-band provider error remains an event, never a task-success score', async () => {
  const { records, options }=setup();const event={type:'error',data:{private:'details'}}
  async function* source(){yield event}
  const stream=observeChatTurnStream(source(),options);assert.equal((await stream.next()).value,event)
  await stream.next();assert.deepEqual(status(records),['exhausted'])
  assert.equal(JSON.stringify(records).includes('details'),false)
})
await test('observer initialization failures do not break streaming', async () => {
  let diagnostics=0
  const { options }=setup({client:()=>{throw new Error('private secret')},onObservationError:()=>{diagnostics++}})
  const stream=observeChatTurnStream(normal(),options);const events=[];for await(const event of stream)events.push(event)
  assert.equal(events.length,2);assert.equal(diagnostics,1)
})
await test('observer rejection and diagnostic failure do not replace source error', async () => {
  const sourceError=new Error('source')
  const { options }=setup({client:()=>({traceRun:async()=>{throw new Error('observer')}}),onObservationError:()=>{throw new Error('logger')}})
  async function* source(){throw sourceError}
  await assert.rejects(observeChatTurnStream(source(),options).next(),e=>e===sourceError)
})
await test('native async disposal follows the same return path', async () => {
  const { records, options }=setup();const stream=observeChatTurnStream(normal(),options)
  await stream.next();await stream[Symbol.asyncDispose]();assert.deepEqual(status(records),['interrupted'])
})
await test('terminal metadata has bounded timing and no invented usage or success', async () => {
  const { records, options }=setup();const before=Date.now();const stream=observeChatTurnStream(normal(),options)
  for await(const _ of stream){};const after=Date.now(),record=records[0],labels=record.labels
  assert.ok(labels['tangle.started_at_ms']>=before);assert.ok(labels['tangle.completed_at_ms']<=after)
  assert.ok(labels['tangle.duration_ms']>=0);assert.equal(record.runId,'native-execution')
  assert.equal(labels['tangle.outcome.success'],undefined);assert.equal(labels['tangle.usage.inference_usd'],undefined)
  assert.equal(labels['tangle.observation.kind'],'stream-lifecycle')
})

const failed=results.filter(r=>!r.passed)
console.log(JSON.stringify({entry:entry.href,node:process.version,tests:results.length,passed:results.length-failed.length,failed:failed.length,scope:process.argv.includes('--source')?'Actual shared source with native iterators and an injected trace port; not installed Runtime, package build, or deployed proof.':'Built public entrypoint with native iterators and an injected trace port; not a real Runtime exporter or deployed proof.',results},null,2))
process.exitCode=failed.length?1:0
