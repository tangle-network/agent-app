/** Real React/Chromium → HTTP → SQLite plan-client integration. No provider calls. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('tsup/package.json'))('esbuild')
const root = process.cwd()
const scratch = await mkdtemp(path.join(tmpdir(), 'agent-app-plan-browser-'))
const db = new Database(path.join(scratch, 'plans.sqlite'))
db.exec(`CREATE TABLE plans(id TEXT PRIMARY KEY, followup INTEGER, pending INTEGER);
  CREATE TABLE requests(plan_id TEXT, method TEXT, target TEXT, scope TEXT);
  CREATE TABLE attached(plan_id TEXT PRIMARY KEY, receipt TEXT);
  INSERT INTO plans VALUES('retry',1,0),('terminal',0,0),('pending',0,1),('next',0,0),('stale-plan',1,0),('stale-revision',1,0),('stale-unmount',1,0),('stale-aba',1,0),('stale-error',1,0),('sticky',1,0),('inline-auto',1,0),('inline-manual',1,0),('scope-restore',1,0),('scope-error',1,0),('scope-decide',1,0),('scope-restored',1,0);`)
const fixture = `import React, { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createDurablePlanDecisionClient, useDurablePlanFlow } from './src/web-react/durable-plan-flow';
const id = new URLSearchParams(location.search).get('case');
const initial = {planId:id,revision:1,status:['inline-manual','scope-decide'].includes(id)?'pending':'approved',body:'Integration plan',submittedAt:'2026-10-22T00:00:00Z',decidedAt:'2026-10-22T00:01:00Z'};
function Controller({selected,scope,onUpdated}){
 const memoClient=useMemo(()=>createDurablePlanDecisionClient({
  url:id==='scope-decide'?()=>'/plan?scope='+scope:'/plan?scope='+scope,
  ...(id==='scope-decide'?{scopeKey:String(scope)}:{}),
 }),[scope]);
 // Recreated factories, URL/body functions and callbacks are valid public hook inputs.
 const client=id.startsWith('inline-')?createDurablePlanDecisionClient({url:()=>'/plan',body:()=>({source:'inline-browser-proof'})}):memoClient;
 const [attached,setAttached]=useState(false);
 const attachFollowUp=async(receipt,plan,decision)=>{
  const response=await fetch('/attach',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receipt,plan,decision,scope})});
  if(!response.ok)throw new Error('Attachment service unavailable');
  setAttached(true);
 };
 const flow=useDurablePlanFlow({plan:selected,client,...(id==='scope-error'?{scopeKey:String(scope)}:{}),autoRestore:true,attachFollowUp,onUpdated});
 return <main><h1>Saved plan</h1><output data-error>{flow.error??flow.attachError??''}</output>
 <output data-plan>{flow.plan.planId+':'+flow.plan.revision}</output><output data-attached>{String(attached)}</output><output data-pending>{String(flow.effectPending)}</output><output data-restoring>{String(flow.restoring)}</output>
 <button onClick={flow.retryAttach}>Retry notifying the agent</button>
 <button onClick={()=>void flow.decide('approved')}>Continue plan</button></main>;
}
function Application(){
 const [selected,setSelected]=useState(initial),[scope,setScope]=useState(0),[mounted,setMounted]=useState(true),[updates,setUpdates]=useState(0);
 const onUpdated=()=>setUpdates(value=>value+1);
 return <><output data-updates>{updates}</output>
 <button onClick={()=>setUpdates(value=>value+1)}>Render parent</button>
 <button onClick={()=>setSelected({...initial,planId:'next',status:'pending'})}>Change plan</button>
 <button onClick={()=>setSelected({...initial,revision:2,status:'pending'})}>Change revision</button>
  <button onClick={()=>setScope(value=>value+1)}>Change scope</button>
 <button onClick={()=>setSelected({...initial,status:'pending'})}>Return plan</button>
 <button onClick={()=>setMounted(false)}>Unmount plan</button>
 {mounted&&<Controller selected={selected} scope={scope} onUpdated={onUpdated}/>}</>;
}
createRoot(document.getElementById('root')).render(<Application/>);`
const bundle = await build({ stdin: { contents: fixture, resolveDir: root, sourcefile: 'plan-client.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser' })
const errors = []
const held = new Map()
const release = (id, index=0) => { const item=held.get(id)[index]; item.finish(); return item }
const waitHeld = async (id,count) => {
  const deadline=Date.now()+5000
  while((held.get(id)?.length??0)<count&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(held.get(id)?.length,count,'authority received held request '+id)
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/client.js') { response.setHeader('content-type','text/javascript'); response.end(bundle.outputFiles[0].text); return }
    if (url.pathname === '/') { response.setHeader('content-type','text/html'); response.end('<div id="root"></div><script type="module" src="/client.js"></script>'); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const input = body ? JSON.parse(body) : {}
    const id = url.searchParams.get('planId') ?? input.planId ?? input.plan?.planId
    const row = db.prepare('SELECT * FROM plans WHERE id=?').get(id)
    assert.ok(row, 'request names a persisted plan')
    const scope=String(url.searchParams.get('scope')??input.scope??0)
    db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(id,request.method,url.pathname,scope)
    response.setHeader('content-type','application/json')
    if (url.pathname === '/plan') {
      if (request.method === 'POST') db.prepare('UPDATE plans SET pending=0,followup=1 WHERE id=?').run(id)
      const current = db.prepare('SELECT * FROM plans WHERE id=?').get(id)
      const finish = () => response.end(JSON.stringify({plan:{planId:id,revision:Number(url.searchParams.get('revision')??1),status:'approved',body:'Integration plan',submittedAt:'2026-10-22T00:00:00Z',decidedAt:'2026-10-22T00:01:00Z'},idempotent:true,
        ...(current.pending ? {effectPending:true}:{}), ...(current.followup ? {followUp:{receiptId:'receipt-'+id+(id.startsWith('scope-')?'-'+scope:''),turnId:'turn-'+id,state:'running'}}:{})}))
      if ((id.startsWith('stale-') && request.method==='GET' && url.searchParams.get('revision')==='1') ||
          (['scope-restore','scope-error','scope-decide'].includes(id) && scope==='0')) {
        const entries=held.get(id)??[]; entries.push({finish,response}); held.set(id,entries)
      } else finish()
      return
    }
    assert.equal(url.pathname,'/attach')
    assert.equal(input.receipt.planId,id)
    assert.equal(input.receipt.revision,1)
    assert.equal(input.plan.status,'approved')
    assert.equal(input.decision,'approved')
    if(id.startsWith('scope-')) assert.equal(input.receipt.receiptId,'receipt-'+id+'-'+scope,'receipt belongs to attachment context')
    const attempts = db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id=? AND target='/attach'").get(id).n
    if ((id === 'retry' && attempts <= 2) || (id === 'pending' && attempts === 1) || id === 'sticky') { response.writeHead(503); response.end(JSON.stringify({error:'Transient attachment outage'})); return }
    db.prepare('INSERT OR REPLACE INTO attached VALUES(?,?)').run(id,input.receipt.receiptId)
    response.end(JSON.stringify({attached:true}))
  } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(JSON.stringify({error:String(error)})) }
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const base = 'http://127.0.0.1:'+server.address().port
let browser
try {
  browser = await chromium.launch({ headless:true })
  const page = await browser.newPage()
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(String(error)))
  for(const id of ['scope-restore','scope-error','scope-decide']) {
    await page.goto(base+'/?case='+id)
    if(id==='scope-decide') await page.getByRole('button',{name:'Continue plan',exact:true}).click()
    await waitHeld(id,1)
    await page.getByRole('button',{name:'Change scope',exact:true}).click()
    if(id==='scope-decide') await page.getByRole('button',{name:'Continue plan',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('[data-attached]')?.textContent==='true',undefined,{timeout:5000})
    const updates=await page.locator('[data-updates]').textContent()
    const responseSettled=page.waitForResponse(response=>new URL(response.url()).pathname==='/plan'&&new URL(response.url()).searchParams.get('scope')==='0')
    if(id==='scope-error') { const item=held.get(id)[0]; item.response.writeHead(503); item.response.end(JSON.stringify({error:'Old scope unavailable'})) }
    else release(id)
    await (await responseSettled).finished()
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    assert.equal(await page.locator('[data-updates]').textContent(),updates,id+': old scope must not update new context')
    assert.equal(await page.locator('[data-error]').textContent(),'')
    assert.equal(db.prepare("SELECT receipt FROM attached WHERE plan_id=?").get(id).receipt,'receipt-'+id+'-1')
    assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id=? AND target='/attach'").get(id).n,1)
  }
  await page.goto(base+'/?case=scope-restored')
  await page.waitForFunction(()=>document.querySelector('[data-attached]')?.textContent==='true'&&document.querySelector('[data-restoring]')?.textContent==='false')
  await page.getByRole('button',{name:'Change scope',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-updates]')?.textContent==='2'&&document.querySelector('[data-restoring]')?.textContent==='false')
  assert.equal(db.prepare("SELECT receipt FROM attached WHERE plan_id='scope-restored'").get().receipt,'receipt-scope-restored-1')
  assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='scope-restored' AND target='/plan'").get().n,2,'new scope restores an already-restored plan')
  if(process.env.PLAN_BROWSER_REGRESSION!=='inline-manual'){
    await page.goto(base+'/?case=inline-auto')
    await page.waitForFunction(()=>document.querySelector('[data-attached]')?.textContent==='true'&&document.querySelector('[data-restoring]')?.textContent==='false',undefined,{timeout:5000})
    await page.getByRole('button',{name:'Render parent',exact:true}).click({clickCount:3})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='inline-auto' AND target='/plan'").get().n,1,'inline autoRestore stays bounded across parent renders')
    assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='inline-auto' AND target='/attach'").get().n,1)
    assert.equal(await page.locator('[data-error]').textContent(),'')
  }
  await page.goto(base+'/?case=inline-manual')
  await page.getByRole('button',{name:'Continue plan',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-attached]')?.textContent==='true',undefined,{timeout:5000})
  assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='inline-manual' AND target='/plan'").get().n,1,'inline decide applies once')
  assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='inline-manual' AND target='/attach'").get().n,1)
  assert.equal(await page.locator('[data-updates]').textContent(),'1')
  assert.equal(await page.locator('[data-error]').textContent(),'')
  await page.goto(base+'/?case=retry')
  await page.locator('[data-error]').filter({hasText:'notifying the agent'}).waitFor()
  assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='retry' AND target='/attach'").get().n,2)
  await page.getByRole('button',{name:'Retry notifying the agent'}).click()
  await page.waitForFunction(()=>document.querySelector('[data-error]').textContent===''&&document.querySelector('[data-restoring]').textContent==='false')
  assert.equal(db.prepare("SELECT receipt FROM attached WHERE plan_id='retry'").get().receipt,'receipt-retry')
  assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='retry' AND target='/attach'").get().n,3)
  await page.goto(base+'/?case=terminal')
  await page.waitForFunction(()=>Number(document.querySelector('[data-updates]')?.textContent)>0&&document.querySelector('[data-restoring]')?.textContent==='false')
  await page.waitForFunction(()=>document.querySelector('[data-error]')?.textContent==='')
  // A user action after settlement must not launch another automatic restore.
  await page.getByRole('button',{name:'Retry notifying the agent'}).click()
  await page.waitForFunction(()=>document.querySelector('[data-restoring]')?.textContent==='false')
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='terminal' AND target='/plan'").get().n,1)
  await page.goto(base+'/?case=pending')
  await page.waitForFunction(()=>document.querySelector('[data-pending]')?.textContent==='true')
  await page.waitForFunction(()=>document.querySelector('[data-restoring]')?.textContent==='false')
  await page.getByRole('button',{name:'Render parent'}).click({clickCount:3})
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  assert.equal(await page.locator('[data-error]').textContent(),'')
  assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id='pending' AND method='GET'").get().n,1)
  const continued = page.waitForResponse(response=>new URL(response.url()).pathname==='/attach'&&response.request().method()==='POST')
  await page.getByRole('button',{name:'Continue plan'}).click()
  await (await continued).finished()
  await page.waitForFunction(()=>document.querySelector('[data-pending]')?.textContent==='false'&&document.querySelector('[data-restoring]')?.textContent==='false'&&document.querySelector('[data-attached]')?.textContent==='true', undefined, {timeout:5000})
  assert.equal(db.prepare("SELECT receipt FROM attached WHERE plan_id='pending'").get().receipt,'receipt-pending')
  // A terminal attachment error belongs only to its plan/client context.
  if(process.env.PLAN_BROWSER_REGRESSION!=='stale') {
  await page.goto(base+'/?case=sticky')
  await page.locator('[data-error]').filter({hasText:'notifying the agent'}).waitFor()
  await page.getByRole('button',{name:'Change plan',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-plan]')?.textContent==='next:1')
  assert.equal(await page.locator('[data-error]').textContent(),'','attachment failure must reset for a new plan')
  }
  // Slow authority responses must never update or attach an obsolete context.
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  for (const [id,action] of [['stale-plan','Change plan'],['stale-revision','Change revision'],['stale-unmount','Unmount plan'],['stale-aba','Change plan'],['stale-error','Change plan']]) {
    await page.goto(base+'/?case='+id)
    await page.waitForFunction(()=>document.querySelector('[data-restoring]')?.textContent==='true')
    await waitHeld(id,1)
    await page.getByRole('button',{name:action,exact:true}).click()
    if(id==='stale-aba'){
      await page.getByRole('button',{name:'Return plan',exact:true}).click()
      await page.waitForFunction(()=>document.querySelector('[data-restoring]')?.textContent==='false')
    }
    const updates=await page.locator('[data-updates]').textContent()
    const responseSettled=page.waitForResponse(response=>new URL(response.url()).pathname==='/plan'&&new URL(response.url()).searchParams.get('planId')===id)
    if(id==='stale-error') { const item=held.get(id)[0]; item.response.writeHead(503); item.response.end(JSON.stringify({error:'Old authority unavailable'})) }
    else release(id)
    await (await responseSettled).finished()
    await settle()
    assert.equal(await page.locator('[data-updates]').textContent(),updates,id+': stale onUpdated must be ignored')
    assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id=? AND target='/attach'").get(id).n,0,id+': stale follow-up must not be attached')
    if(id!=='stale-unmount') assert.equal(await page.locator('[data-error]').textContent(),'',id+': stale errors must be ignored'.trim())
    if(id==='stale-aba'){
      await page.getByRole('button',{name:'Continue plan',exact:true}).click()
      await page.waitForFunction(()=>document.querySelector('[data-attached]')?.textContent==='true')
      assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id=? AND target='/attach'").get(id).n,1)
    }
  }
  assert.deepEqual(errors,[])
  assert.deepEqual(browserErrors,[])
  console.log(JSON.stringify({proof:'plan-flow-browser',cases:15,attachmentRequests:db.prepare("SELECT count(*) AS n FROM requests WHERE target='/attach'").get().n,plansAttached:db.prepare('SELECT count(*) AS n FROM attached').get().n,serverErrors:errors,browserErrors}))
} finally {
  for(const entries of held.values()) for(const item of entries) item.response.destroy()
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  db.close()
  await rm(scratch,{recursive:true,force:true})
}
