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
  const { buildFlowTrace, composeMissionFlowTrace, stepActivityFlowTrace } = await load(fromPack,'@tangle-network/agent-app/trace')
  const surfaces = await load(fromPack,'@tangle-network/agent-app/web-react')
  for (const removed of ['FlowWaterfall','waterfallLayout']) assert.equal(removed in surfaces,false,removed)
  // Type-only APIs require a real downstream compiler; runtime namespace checks cannot prove them.
  const compilerManifest = fromOwner.resolve('typescript/package.json')
  const compiler = join(dirname(compilerManifest),JSON.parse(readFileSync(compilerManifest,'utf8')).bin.tsc)
  const compile = source => {
    writeFileSync(join(scratch,'types.ts'),source)
    writeFileSync(join(scratch,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,noEmit:true,types:[],lib:['ES2022','DOM']},files:['types.ts']}))
    return spawnSync(process.execPath,[compiler,'-p',join(scratch,'tsconfig.json')],{encoding:'utf8'})
  }
  const retained = compile("import type {MissionActivityLaneProps} from '@tangle-network/agent-app/web-react'; import type {FlowTrace,FlowSpan} from '@tangle-network/agent-app/trace'; export type Retained=MissionActivityLaneProps; const span:FlowSpan={kind:'tool',name:'retained',startMs:0,endMs:1}; const trace:FlowTrace={spans:[span],totalMs:1,promptTokens:0,completionTokens:0,toolCalls:1}; void trace;")
  assert.equal(retained.status,0,retained.stdout+retained.stderr)
  const retired = compile("import type {FlowWaterfallProps,WaterfallRow} from '@tangle-network/agent-app/web-react'; export type Removed=[FlowWaterfallProps,WaterfallRow];")
  assert.notEqual(retired.status,0,'Removed type exports must fail downstream compilation')
  assert.match(retired.stdout,/FlowWaterfallProps/)
  assert.match(retired.stdout,/WaterfallRow/)
  assert.match(retired.stdout,/TS(2305|2724)/,'The compiler must reject removed named exports')
  const { FlowWaterfall } = await load(fromOwner,'@tangle-network/charts/react')
  const { createElement } = await load(fromOwner,'react')
  const { renderToStaticMarkup } = await load(fromOwner,'react-dom/server')
  const html = trace => renderToStaticMarkup(createElement(FlowWaterfall,{trace}))
  const manifest = JSON.parse(readFileSync(join(installation,'package.json'),'utf8'))
  assert.equal(manifest.dependencies['@tangle-network/charts'],'0.15.0')
  assert.equal(Object.keys(manifest.exports).some(key=>key.includes('flow-waterfall')),false)
  const css = readFileSync(fromPack.resolve('@tangle-network/agent-app/styles'),'utf8')
  assert.match(css,/\.fw-root/)
  assert.doesNotMatch(css,/@import\s/)
  const failed = buildFlowTrace([
    {t:0,event:{type:'tool_call',call:{toolCallId:'failure',toolName:'boundary tool'}}},
    {t:1000,event:{kind:'tool_result',toolCallId:'failure',outcome:{ok:false}}},
  ])
  assert.equal(failed.spans[0].status,'failed','Buffered tool producer must set explicit failed status')
  assert.match(html(failed),/data-span-kind="failed"/)
  const statuses = ['failed','Error','CANCELLED','Aborted','down','running','Pending','completed']
  const observed = []
  for (const status of statuses) {
    const expected = ['running','pending'].includes(status.toLowerCase()) ? 'running' : status==='completed' ? 'done' : 'failed'
    const trace = composeMissionFlowTrace({steps:[{id:'step',intent:'Domain result',status,startedAt:0,durationMs:1000}],startedAt:0})
    assert.equal(trace.spans[0].status,expected,`Mission ${status}`)
    assert.equal(html(trace).includes('data-span-kind="failed"'),expected==='failed')
    const lane = stepActivityFlowTrace([{taskId:'task',tool:'worker',detail:'Domain result',status,startedAt:new Date(0).toISOString(),...(expected==='running'?{}:{durationMs:1000})}],{startedAt:0,nowMs:2000})
    assert.equal(lane.spans[0].status,expected,`Lane ${status}`)
    if(expected==='running')assert.equal(lane.spans[0].endMs,2000)
    observed.push({status,expected,renderedFailure:expected==='failed'})
  }
  const running = buildFlowTrace([{t:0,event:{type:'tool_call',call:{toolCallId:'open',toolName:'Open tool'}}}],{running:true})
  assert.equal(running.spans[0].status,'running')
  assert.match(html(running),/data-span-id="open"/)
  const result = {result:'PASS',packedPublicExports:true,dependencyTree:'frozen owner checkout',removedExports:true,retainedTraceTypes:true,retiredTypeImportsRejected:true,stylesheetBridge:true,bufferedFailure:true,running:true,domainStatuses:observed}
  if(output){mkdirSync(resolve(output),{recursive:true});writeFileSync(join(output,'producer-consumer.json'),JSON.stringify(result,null,2))}
  console.log(JSON.stringify(result))
} finally {rmSync(scratch,{recursive:true,force:true})}
