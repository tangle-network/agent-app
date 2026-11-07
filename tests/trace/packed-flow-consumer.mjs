/** Public package seam: application producers -> published charts -> server markup.
 * Uses the frozen checkout's real dependency tree, without an isolated-install claim. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const output = process.env.FLOW_CONSUMER_PROOF_DIR
const runtimeOnly = process.argv.includes('--runtime-only')
const scratch = mkdtempSync(join(tmpdir(),'app-flow-consumer-'))
try {
  const packed = JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',scratch],{encoding:'utf8'}))
  const archive = (Array.isArray(packed) ? packed[0] : packed['@tangle-network/agent-app']).filename
  const installation = join(scratch,'node_modules/@tangle-network/agent-app')
  mkdirSync(installation,{recursive:true})
  execFileSync('tar',['-xzf',join(scratch,archive),'--strip-components=1','-C',installation])
  symlinkSync(join(root,'node_modules'),join(installation,'node_modules'),'dir')
  writeFileSync(join(scratch,'package.json'),'{"private":true,"type":"module"}')
  const fromPack = createRequire(join(scratch,'package.json'))
  const fromOwner = createRequire(join(root,'package.json'))
  const load = (require,id) => import(pathToFileURL(require.resolve(id)).href)
  const { buildFlowTrace, stepActivityFlowTrace, timedEventsFromLines, renderWaterfall } = await load(fromPack,'@tangle-network/agent-app/trace')
  const surfaces = await load(fromPack,'@tangle-network/agent-app/web-react')
  for (const removed of ['FlowWaterfall','waterfallLayout']) assert.equal(removed in surfaces,false,removed)
  assert.equal('composeMissionFlowTrace' in await load(fromPack,'@tangle-network/agent-app/trace'),false)
  if (!runtimeOnly) {
    // Type-only APIs require a real downstream compiler; runtime namespace checks cannot prove them.
    const compilerManifest = fromOwner.resolve('typescript/package.json')
    const compiler = join(dirname(compilerManifest),JSON.parse(readFileSync(compilerManifest,'utf8')).bin.tsc)
    const compile = source => {
      writeFileSync(join(scratch,'types.ts'),source)
      writeFileSync(join(scratch,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,noEmit:true,types:[],lib:['ES2022','DOM']},files:['types.ts']}))
      return spawnSync(process.execPath,[compiler,'-p',join(scratch,'tsconfig.json')],{encoding:'utf8'})
    }
    const retained = compile("import type {MissionActivityLaneProps} from '@tangle-network/agent-app/web-react'; import type {FlowTrace,FlowSpan} from '@tangle-network/agent-app/trace'; export type Retained=MissionActivityLaneProps; const span:FlowSpan={kind:'tool',name:'retained',startMs:0,endMs:1}; const trace:FlowTrace={spans:[span],totalMs:1,promptTokens:0,completionTokens:0,toolCalls:1}; const unknown:FlowTrace={spans:[span],totalMs:1}; void [trace,unknown];")
    assert.equal(retained.status,0,retained.stdout+retained.stderr)
    const retired = compile("import type {FlowWaterfallProps,WaterfallRow} from '@tangle-network/agent-app/web-react'; import type {MissionFlowStep} from '@tangle-network/agent-app/trace'; import type {FlowTrace} from '@tangle-network/agent-app/trace'; export type Removed=[FlowWaterfallProps,WaterfallRow,MissionFlowStep]; declare const trace:FlowTrace; const oldTotal:number=trace.promptTokens;")
    assert.notEqual(retired.status,0,'Removed type exports must fail downstream compilation')
    for (const diagnostic of [/FlowWaterfallProps/,/WaterfallRow/,/MissionFlowStep/,/TS(2305|2724)/,/TS2322/]) assert.match(retired.stdout,diagnostic)
  }
  const { FlowWaterfall } = await load(fromOwner,'@tangle-network/charts/react')
  const { createElement } = await load(fromOwner,'react')
  const { renderToStaticMarkup } = await load(fromOwner,'react-dom/server')
  const html = trace => renderToStaticMarkup(createElement(FlowWaterfall,{trace}))
  assert.equal(Object.keys(fromPack('@tangle-network/agent-app/package.json').exports).some(key=>key.includes('flow-waterfall')),false)
  const css = readFileSync(fromPack.resolve('@tangle-network/agent-app/styles'),'utf8')
  assert.match(css,/\.fw-root/)
  assert.doesNotMatch(css,/@import\s/)
  const cases = [
    ['failed',['failed','Error','CANCELLED','Aborted','down'],[],undefined,undefined,undefined],
    ['running',['running','Pending'],[{promptTokens:7}],7,undefined,undefined],
    ['done',['completed'],[{promptTokens:0,completionTokens:0}],0,0,0],
    ['done',['completed'],[{promptTokens:7,completionTokens:3},{promptTokens:13,completionTokens:2}],20,5,30],
  ]
  const observed = []
  for (const [expected,statuses,usage,promptTokens,completionTokens,costUsd] of cases) for (const status of statuses) {
    const lane = stepActivityFlowTrace([{taskId:'task',tool:'worker',detail:'Domain result',status,startedAt:new Date(0).toISOString(),...(expected==='running'?{}:{durationMs:1000})}],{startedAt:0,nowMs:2000})
    assert.deepEqual([lane.spans[0].status,lane.spans[0].meta.status,lane.promptTokens,lane.completionTokens],[expected,status,undefined,undefined],`Lane ${status}`)
    assert.equal(html(lane).includes('data-span-kind="failed"'),expected==='failed')
    assert.match(renderWaterfall(lane)+html(lane),/unknownp \+ unknownc tok[\s\S]*Tokens not reported/)
    if(expected==='running')assert.equal(lane.spans[0].endMs,2000)
    writeFileSync(join(scratch,'turn.jsonl'),[
      JSON.stringify({_t:0,type:'tool_call',call:{toolCallId:'protocol',toolName:'Boundary tool'}}),
      ...(expected==='running'?[]:[JSON.stringify({_t:1000,kind:'tool_result',toolCallId:'protocol',outcome:{ok:expected!=='failed'}})]),
      ...usage.map((usage,i)=>JSON.stringify({_t:2000+i,type:'usage',usage})),
    ].join('\n'))
    const trace = buildFlowTrace(timedEventsFromLines(readFileSync(join(scratch,'turn.jsonl'),'utf8').split('\n')),{pricing:{prompt:1,completion:2},running:expected==='running'})
    const ascii = renderWaterfall(trace), markup = html(trace)
    assert.deepEqual([trace.promptTokens,trace.completionTokens,trace.costUsd,trace.spans[0].status],[promptTokens,completionTokens,costUsd,expected])
    assert.equal(markup.includes('data-span-kind="failed"'),expected==='failed')
    assert.match(markup,/data-span-id="protocol"/)
    assert.match(ascii,new RegExp(`${promptTokens ?? 'unknown'}p \\+ ${completionTokens ?? 'unknown'}c tok`))
    assert.match(markup,promptTokens===undefined || completionTokens===undefined ? /Tokens not reported/ : new RegExp(`title="${promptTokens+completionTokens} tokens"`))
    if(costUsd===0)assert.match(markup,/\$0(?:\.0+)?(?=[^\d.]|$)/)
    assert.doesNotMatch(ascii+markup,/\b(undefined|NaN|Infinity)\b/)
    observed.push({status,expected,renderedFailure:markup.includes('data-span-kind="failed"'),promptTokens:trace.promptTokens ?? null,completionTokens:trace.completionTokens ?? null,costUsd:trace.costUsd ?? null})
  }
  const result = {result:'PASS',packedPublicExports:true,dependencyTree:'frozen owner checkout',removedExports:true,retainedTraceTypes:runtimeOnly?null:true,retiredTypeImportsRejected:runtimeOnly?null:true,optionalTotalsTypeBreak:runtimeOnly?null:true,storedUsageCases:cases.length,stylesheetBridge:true,bufferedFailure:true,running:true,domainStatuses:observed}
  if(output){mkdirSync(resolve(output),{recursive:true});writeFileSync(join(output,'producer-consumer.json'),JSON.stringify(result,null,2))}
  console.log(JSON.stringify(result))
} finally {rmSync(scratch,{recursive:true,force:true})}
