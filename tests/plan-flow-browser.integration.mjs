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
  CREATE TABLE requests(plan_id TEXT, method TEXT, target TEXT);
  CREATE TABLE attached(plan_id TEXT PRIMARY KEY, receipt TEXT);
  INSERT INTO plans VALUES('retry',1,0),('terminal',0,0),('pending',0,1);`)
const fixture = `import React, { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createDurablePlanDecisionClient, useDurablePlanFlow } from './src/web-react/durable-plan-flow';
const id = new URLSearchParams(location.search).get('case');
const initial = {planId:id,revision:1,status:'approved',body:'Integration plan',submittedAt:'2026-10-22T00:00:00Z',decidedAt:'2026-10-22T00:01:00Z'};
function Application(){
 const client=useMemo(()=>createDurablePlanDecisionClient({url:'/plan'}),[]);
 const [attached,setAttached]=useState(false);
 const attachFollowUp=async(receipt,plan,decision)=>{
  const response=await fetch('/attach',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receipt,plan,decision})});
  if(!response.ok)throw new Error('Attachment service unavailable');
  setAttached(true);
 };
 const [updates,setUpdates]=useState(0);
 const onUpdated=()=>setUpdates(value=>value+1);
 const flow=useDurablePlanFlow({plan:initial,client,autoRestore:true,attachFollowUp,onUpdated});
 return <main><h1>Saved plan</h1><output data-error>{flow.error??flow.attachError??''}</output>
 <output data-attached>{String(attached)}</output><output data-updates>{updates}</output><output data-pending>{String(flow.effectPending)}</output><output data-restoring>{String(flow.restoring)}</output>
 <button onClick={()=>setUpdates(value=>value+1)}>Render parent</button>
 <button onClick={flow.retryAttach}>Retry notifying the agent</button>
 <button onClick={()=>void flow.decide('approved')}>Continue plan</button></main>;
}
createRoot(document.getElementById('root')).render(<Application/>);`
const bundle = await build({ stdin: { contents: fixture, resolveDir: root, sourcefile: 'plan-client.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser' })
const errors = []
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
    db.prepare('INSERT INTO requests VALUES(?,?,?)').run(id,request.method,url.pathname)
    response.setHeader('content-type','application/json')
    if (url.pathname === '/plan') {
      if (request.method === 'POST') db.prepare('UPDATE plans SET pending=0,followup=1 WHERE id=?').run(id)
      const current = db.prepare('SELECT * FROM plans WHERE id=?').get(id)
      response.end(JSON.stringify({plan:{planId:id,revision:1,status:'approved',body:'Integration plan',submittedAt:'2026-10-22T00:00:00Z',decidedAt:'2026-10-22T00:01:00Z'},idempotent:true,
        ...(current.pending ? {effectPending:true}:{}), ...(current.followup ? {followUp:{receiptId:'receipt-'+id,turnId:'turn-'+id,state:'running'}}:{})}))
      return
    }
    assert.equal(url.pathname,'/attach')
    assert.equal(input.receipt.planId,id)
    assert.equal(input.receipt.revision,1)
    assert.equal(input.plan.status,'approved')
    assert.equal(input.decision,'approved')
    const attempts = db.prepare("SELECT count(*) AS n FROM requests WHERE plan_id=? AND target='/attach'").get(id).n
    if ((id === 'retry' && attempts <= 2) || (id === 'pending' && attempts === 1)) { response.writeHead(503); response.end(JSON.stringify({error:'Transient attachment outage'})); return }
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
  assert.deepEqual(errors,[])
  assert.deepEqual(browserErrors,[])
  console.log(JSON.stringify({proof:'plan-flow-browser',cases:3,attachmentRequests:db.prepare("SELECT count(*) AS n FROM requests WHERE target='/attach'").get().n,plansAttached:db.prepare('SELECT count(*) AS n FROM attached').get().n,serverErrors:errors,browserErrors}))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  db.close()
  await rm(scratch,{recursive:true,force:true})
}
