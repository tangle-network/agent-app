/** Real built review inbox, keyboard-only triage, HTTP/SSE and atomic SQLite outcome records. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { chromium, expect } from 'playwright/test'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = process.argv.indexOf('--output')
const output = path.resolve(argument < 0 ? path.join(os.homedir(), 'reviews', `review-inbox-${Date.now()}`) : process.argv[argument + 1])
await mkdir(output, { recursive: true })
const temp = await mkdtemp(path.join(os.tmpdir(), 'review-inbox-'))
const db = new DatabaseSync(path.join(output, 'review-round.sqlite'))
db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE verdicts (id TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(id, revision)); CREATE TABLE signals (id TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(id, revision)); CREATE TABLE held (body TEXT NOT NULL); CREATE TABLE held_feedback (body TEXT NOT NULL)')
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const kinds = ['work-product', 'asset', 'hub', 'dry-run', 'asset', 'work-product', 'hub', 'dry-run', 'asset', 'work-product']
const fixtures = kinds.map((kind, index) => {
  const title = `${index + 1}. ${kind === 'work-product' ? 'Sandbox launch brief' : kind === 'asset' ? 'Sandbox campaign asset' : kind === 'hub' ? 'Email for Alex' : 'Sandbox social preview'}`
  const input = kind === 'work-product' ? { content: `Brief ${index + 1}: make the setup smaller.` }
    : kind === 'hub' ? { from: 'Taylor <taylor@example.invalid>', to: ['alex@example.invalid'], subject: 'A smaller prototype setup', body: 'Hi Alex, would a smaller sandbox setup help?', html: false }
      : { text: `Sandbox draft ${index + 1}: start with the prototype.` }
  const preview = kind === 'hub' ? { kind: 'email', from: input.from, to: input.to, cc: [], bcc: [], subject: input.subject, body: input.body, html: false, reply: false }
    : kind === 'work-product' ? undefined : { kind: 'post', channel: kind === 'asset' ? 'instagram' : 'x', text: input.text,
      ...(kind === 'asset' ? { placement: 'feed', media: [{ kind: 'image', src: image, alt: 'Local Sandbox asset fixture', width: 1, height: 1 }] } : {}) }
  return { id: `${kind}:${String(index + 1).padStart(2, '0')}`, revision: 'v1', title, kind, createdAt: (index === 3 ? 3 : index + 1) * 1000,
    canReview: true, input, preview, ...(kind === 'hub' ? { approveLabel: 'Approve preview' } : {}) }
})
for (const item of fixtures) db.prepare('INSERT INTO items VALUES (?, ?)').run(item.id, JSON.stringify(item))
const held = { id: 'held-email', actionPath: 'gmail.send', providerId: 'gmail', phase: 'waiting', executionMode: 'dry-run', input: fixtures.find(item => item.kind === 'hub').input }
db.prepare('INSERT INTO held VALUES (?)').run(JSON.stringify(held))
const originalOrder = [...fixtures].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
const clients = new Set()
const checks = [], externalRequests = [], browserErrors = []
let activeCheck = 'initial render', failNext = false, holdNext = false, releaseVerdict, verdictRequests = 0, failedWrites = 0
let browser, context, page, server
const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
function pendingItems() {
  return db.prepare('SELECT body FROM items ORDER BY id DESC').all().map(row => JSON.parse(row.body))
    .filter(item => !db.prepare('SELECT 1 FROM verdicts WHERE id=? AND revision=?').get(item.id, String(item.revision)))
}
function replace(item) {
  db.prepare('UPDATE items SET body=? WHERE id=?').run(JSON.stringify(item), item.id)
  publish({ items: pendingItems(), loading: false, error: null })
}
function publish(state) { for (const client of clients) client.write(`data: ${JSON.stringify(state)}\n\n`) }
async function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()) }
async function check(name, run) { activeCheck = name; await run(); checks.push({ name, result: 'PASS' }) }
async function tabTo(locator, keyboardPage = page) {
  for (let index = 0; index < 25; index++) {
    if (await locator.evaluate(element => element === document.activeElement)) return
    await keyboardPage.keyboard.press('Tab')
  }
  assert.fail('Keyboard could not reach the requested control')
}
async function score(value) {
  await page.keyboard.press('s')
  await expect(page.getByLabel('Score (0–100)', { exact: true })).toBeFocused()
  await page.keyboard.type(String(value))
  await page.keyboard.press('Escape')
}

const app = `import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {ReviewInbox} from './dist/web-react/index.js';import {HubActionPreviewView,HubApprovalRow} from './dist/hub-approvals-react/index.js';
function HubFixture(){const[item,setItem]=useState(null);useEffect(()=>{fetch('/api/held').then(response=>response.json()).then(setItem);const updates=new EventSource('/api/updates');updates.onmessage=event=>{const state=JSON.parse(event.data);if(state.held)setItem(state.held)};return()=>updates.close()},[]);if(!item)return <p>Loading held revision…</p>;return <main className="mx-auto max-w-2xl p-4"><HubApprovalRow item={item} expanded onFeedback={async(item,value)=>{const response=await fetch('/api/held-feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw new Error('Feedback could not save')}}/></main>}
function App(){const[items,setItems]=useState([]);const[loading,setLoading]=useState(true);const[error,setError]=useState(null);
async function load(){try{const response=await fetch('/api/items');if(!response.ok)throw new Error('Inbox unavailable');setItems(await response.json());setError(null)}catch(error){setError(error.message)}finally{setLoading(false)}}
useEffect(()=>{load();const updates=new EventSource('/api/updates');updates.onmessage=event=>{const state=JSON.parse(event.data);if(state.items){setItems(state.items);setLoading(state.loading);setError(state.error)}};return()=>updates.close()},[]);
async function verdict(item,feedback){const response=await fetch('/api/verdict',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:item.id,revision:item.revision,...feedback})});const result=await response.json();if(!response.ok)throw new Error(result.error);setItems(result.items)}
return <main className="px-4 py-6"><ReviewInbox items={items} initialSelectedId={new URLSearchParams(location.search).get('item')??undefined} loading={loading} error={error} onRefresh={load} onVerdict={verdict} renderItem={item=>item.preview?<HubActionPreviewView preview={item.preview} account="Example studio"/>:<article className="rounded-lg border border-border bg-card p-5"><h3 className="font-semibold">Retained work product</h3><p className="mt-3 whitespace-pre-wrap">{item.input.content}</p></article>}/></main>}
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('hub')?<HubFixture/>:<App/>);`

try {
  const require = createRequire(import.meta.url)
  const { build } = await import(createRequire(require.resolve('tsup')).resolve('esbuild'))
  await build({ stdin: { contents: app, loader: 'jsx', resolveDir: root }, outfile: path.join(temp, 'app.js'), absWorkingDir: root,
    bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
  const config = path.join(temp, 'tailwind.mjs')
  await writeFile(config, `import preset from ${JSON.stringify(path.join(root, 'dist/theme/tailwind-preset.js'))};export default {presets:[preset]}`)
  const css = await postcss([tailwind({ base: root })]).process(`@import "tailwindcss";\n@import "./dist/theme/tailwind.css";\n@config ${JSON.stringify(config)};`, { from: path.join(root, 'proof.css') })
  await writeFile(path.join(temp, 'app.css'), css.css)
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/items') return json(response, pendingItems())
      if (request.url === '/api/held') return json(response, JSON.parse(db.prepare('SELECT body FROM held').get().body))
      if (request.url === '/api/held-feedback') { db.prepare('INSERT INTO held_feedback VALUES (?)').run(JSON.stringify(await body(request))); return json(response, { saved: true }) }
      if (request.url === '/api/updates') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); response.flushHeaders()
        clients.add(response); request.on('close', () => clients.delete(response)); return
      }
      if (request.url === '/api/verdict' && request.method === 'POST') {
        verdictRequests++
        const value = await body(request)
        if (failNext) { failNext = false; failedWrites++; return json(response, { error: 'Storage failed before verdict commit. Your edits are kept.' }, 503) }
        if (holdNext) { holdNext = false; await new Promise(resolve => { releaseVerdict = resolve }) }
        const item = pendingItems().find(item => item.id === value.id && item.revision === value.revision)
        if (!item || !item.canReview) return json(response, { error: 'This revision can no longer be reviewed' }, 409)
        if (!['approve', 'reject', 'request_changes'].includes(value.verdict) || !Number.isInteger(value.score) || value.score < 0 || value.score > 100
          || typeof value.comment !== 'string' || (value.verdict !== 'approve' && !value.comment.trim())) return json(response, { error: 'Score and required note must be present' }, 400)
        const after = value.editedInput ?? item.input
        const diff = Object.keys({ ...item.input, ...after }).filter(key => JSON.stringify(item.input[key]) !== JSON.stringify(after[key]))
          .map(key => ({ path: key, before: item.input[key], after: after[key] }))
        const saved = { ...value, diff, reviewer: 'fixture-reviewer', workProductId: item.id, turnId: `fixture-turn-${item.id}`, promptVersion: 'fixture-prompt-v1', savedAt: new Date().toISOString() }
        db.exec('BEGIN')
        try {
          db.prepare('INSERT INTO verdicts VALUES (?,?,?)').run(item.id, String(item.revision), JSON.stringify(saved))
          db.prepare('INSERT INTO signals VALUES (?,?,?)').run(item.id, String(item.revision), JSON.stringify(saved))
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
        return json(response, { items: pendingItems() })
      }
      const asset = request.url === '/app.js' ? ['app.js', 'text/javascript'] : request.url === '/app.css' ? ['app.css', 'text/css'] : null
      if (asset) { response.writeHead(200, { 'content-type': asset[1] }); return response.end(await readFile(path.join(temp, asset[0]))) }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Review inbox proof</title><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
    } catch (error) { await json(response, { error: String(error) }, 500) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, slowMo: 40 })
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, recordVideo: { dir: output, size: { width: 1280, height: 1000 } } })
  context.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) externalRequests.push(request.url()) })
  page = await context.newPage(); page.on('pageerror', error => browserErrors.push(error.message))
  await page.goto(origin)
  await expect(page.locator('[data-review-title]')).toHaveText(originalOrder[0].title)
  await page.screenshot({ path: path.join(output, 'starting-desktop.png'), fullPage: true })
  await check('a held call isolates unsaved edits by immutable source payload and restores the prior draft', async () => {
    const hub = await context.newPage(); hub.on('pageerror', error => browserErrors.push(error.message))
    await hub.goto(`${origin}/?hub=1`)
    const scoreField = hub.getByLabel('Score (0–100)', { exact: true })
    await expect(scoreField).toHaveValue('')
    await tabTo(scoreField, hub); await hub.keyboard.type('66'); await hub.keyboard.press('Tab'); await hub.keyboard.press('Enter')
    await hub.keyboard.press('Tab'); await hub.keyboard.type('Keep the original source draft.')
    await hub.keyboard.press('Tab'); await hub.keyboard.press('ControlOrMeta+A'); await hub.keyboard.type('Unsubmitted v1 subject')
    await hub.keyboard.press('Tab'); await hub.keyboard.press('ControlOrMeta+A'); await hub.keyboard.type('Unsubmitted v1 body'); await hub.keyboard.press('Escape')
    const changed = { ...held, input: { ...held.input, subject: 'Server v2 subject', body: 'Server v2 body' } }
    db.prepare('UPDATE held SET body=?').run(JSON.stringify(changed)); publish({ held: changed })
    await expect(scoreField).toHaveValue('')
    await tabTo(hub.getByRole('button', { name: 'Edit to teach', exact: true }), hub); await hub.keyboard.press('Enter')
    await expect(hub.getByLabel('Subject', { exact: true })).toHaveValue('Server v2 subject')
    await expect(hub.getByLabel('Body', { exact: true })).toHaveValue('Server v2 body')
    db.prepare('UPDATE held SET body=?').run(JSON.stringify(held)); publish({ held })
    await expect(scoreField).toHaveValue('66')
    await expect(hub.getByLabel('Subject', { exact: true })).toHaveValue('Unsubmitted v1 subject')
    await expect(hub.getByLabel('Body', { exact: true })).toHaveValue('Unsubmitted v1 body')
    await hub.close(); assert.equal(count('held_feedback'), 0)
  })
  await check('deep links select an existing item without changing original round rank', async () => {
    const linked = await context.newPage()
    linked.on('pageerror', error => browserErrors.push(error.message))
    await linked.goto(`${origin}/?item=${encodeURIComponent(originalOrder[4].id)}`)
    await expect(linked.locator('[data-review-title]')).toHaveText(originalOrder[4].title)
    await expect(linked.locator('[data-review-progress]')).toHaveText('5 of 10')
    await linked.close()
    assert.equal(verdictRequests, 0)
  })
  await check('oldest-first round starts unscored; typing never triggers triage shortcuts', async () => {
    await expect(page.locator('[data-review-progress]')).toHaveText('1 of 10')
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('')
    await page.keyboard.press('a')
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toBeFocused()
    assert.equal(verdictRequests, 0)
    await page.keyboard.type('77'); await page.keyboard.press('Escape'); await page.keyboard.press('r')
    await expect(page.getByLabel('Comment', { exact: true })).toBeFocused()
    await page.keyboard.type('ajkr: keep the opening concrete.')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('ajkr: keep the opening concrete.')
    await expect(page.locator('[data-review-progress]')).toHaveText('1 of 10')
    assert.equal(verdictRequests, 0)
    await page.keyboard.press('Escape')
  })
  await check('editing and failed writes keep the same item, score and note', async () => {
    await page.keyboard.press('s'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
    await expect(page.getByLabel('Payload', { exact: true })).toBeFocused()
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(JSON.stringify({ content: 'Edited brief: start with a specific setup problem.' }))
    await page.keyboard.press('Escape')
    failNext = true; await page.keyboard.press('r')
    await expect(page.getByRole('alert')).toContainText('Storage failed before verdict commit')
    await expect(page.locator('[data-review-title]')).toHaveText(originalOrder[0].title)
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('77')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('ajkr: keep the opening concrete.')
    await expect(page.getByLabel('Payload', { exact: true })).toHaveValue(JSON.stringify({ content: 'Edited brief: start with a specific setup problem.' }))
    assert.equal(count('verdicts'), 0); assert.equal(count('signals'), 0)
  })
  await check('server acknowledgement gates advancement and stores one learning row', async () => {
    holdNext = true; await page.keyboard.press('r')
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
    await page.keyboard.press('j')
    await expect(page.locator('[data-review-progress]')).toHaveText('1 of 10')
    await expect.poll(() => typeof releaseVerdict).toBe('function')
    assert.equal(count('signals'), 0)
    releaseVerdict(); releaseVerdict = undefined
    await expect(page.locator('[data-review-progress]')).toHaveText('2 of 10')
    assert.equal(count('signals'), 1)
    const saved = JSON.parse(db.prepare('SELECT body FROM signals').get().body)
    assert.equal(saved.score, 77); assert.equal(saved.verdict, 'request_changes'); assert.equal(saved.diff[0].path, 'content')
  })
  await check('navigation and live revision changes preserve isolated drafts and permissions', async () => {
    await score(0)
    await page.keyboard.press('r'); await page.keyboard.type('Keep the image framing.'); await page.keyboard.press('Escape')
    await page.keyboard.press('j'); await page.keyboard.press('k')
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('0')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep the image framing.')
    const item = originalOrder[1]
    replace({ ...item, canReview: false })
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
    await page.keyboard.press('a'); assert.equal(count('signals'), 1)
    replace({ ...item, revision: 'v2', input: { text: 'A newer asset revision' } })
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('')
    replace(item)
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('0')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep the image framing.')
    await expect(page.getByText('Feedback saved', { exact: true })).toHaveCount(0)
    replace({ ...item, allowedVerdicts: ['request_changes'] })
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
    await page.keyboard.press('a'); assert.equal(verdictRequests, 2)
    replace(item)
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  })
  await check('transient load errors retain work; confirmed remote removal advances without a local verdict', async () => {
    const item = originalOrder[1]
    publish({ items: [], loading: true, error: null })
    await expect(page.locator('[data-review-inbox]')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('[data-review-title]')).toHaveText(item.title)
    publish({ items: [], loading: false, error: 'Fixture inbox unavailable' })
    await expect(page.getByRole('alert')).toContainText('Fixture inbox unavailable')
    await expect(page.getByRole('heading', { name: 'All caught up', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-review-title]')).toHaveText(item.title)
    publish({ items: pendingItems(), loading: false, error: null })
    await expect(page.getByRole('alert')).toHaveCount(0)
    db.prepare('DELETE FROM items WHERE id=?').run(item.id)
    publish({ items: pendingItems(), loading: false, error: null })
    await expect(page.locator('[data-review-title]')).toHaveText(originalOrder[2].title)
    await expect(page.locator('[data-review-progress]')).toHaveText('3 of 10')
    assert.equal(count('signals'), 1); assert.equal(verdictRequests, 2)
    db.prepare('INSERT INTO items VALUES (?, ?)').run(item.id, JSON.stringify(item))
    publish({ items: pendingItems(), loading: false, error: null })
    await expect(page.locator('[data-review-title]')).toHaveText(originalOrder[2].title)
    await page.keyboard.press('k')
    await expect(page.locator('[data-review-title]')).toHaveText(item.title)
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('0')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep the image framing.')
  })
  await check('ten mixed records receive keyboard verdicts, including required reject notes and score edges', async () => {
    await page.keyboard.press('a')
    for (let index = 2; index < originalOrder.length; index++) {
      const item = originalOrder[index]
      await expect(page.locator('[data-review-title]')).toHaveText(item.title)
      await expect(page.locator('[data-review-progress]')).toHaveText(`${index + 1} of 10`)
      await score(index === 9 ? 100 : 70 + index)
      if (index === 2) {
        await tabTo(page.getByRole('button', { name: 'Reject', exact: true }))
        await page.keyboard.press('Enter')
        await expect(page.getByLabel('Comment', { exact: true })).toBeFocused()
        assert.equal(count('signals'), 2)
        await page.keyboard.type('The opening needs a concrete example.'); await page.keyboard.press('Escape')
        await tabTo(page.getByRole('button', { name: 'Reject', exact: true })); await page.keyboard.press('Enter')
      } else if (index % 3 === 0) {
        await page.keyboard.press('r'); await expect(page.getByLabel('Comment', { exact: true })).toBeFocused()
        await page.keyboard.type('Shorten this and keep one clear next step.'); await page.keyboard.press('Escape'); await page.keyboard.press('r')
      } else {
        if (item.kind === 'hub') await expect(page.getByRole('button', { name: 'Approve preview', exact: true })).toBeVisible()
        await page.keyboard.press('a')
      }
      if (index === 3) {
        await expect(page.locator('[data-review-progress]')).toHaveText('5 of 10')
        await page.setViewportSize({ width: 390, height: 844 })
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        await page.screenshot({ path: path.join(output, 'triage-phone.png'), fullPage: true })
        await page.setViewportSize({ width: 1280, height: 1000 })
      }
    }
    await expect(page.getByRole('heading', { name: 'All caught up', exact: true })).toBeVisible()
    assert.equal(count('verdicts'), 10); assert.equal(count('signals'), 10); assert.equal(verdictRequests, 11); assert.equal(failedWrites, 1)
    const saved = db.prepare('SELECT body FROM signals').all().map(row => JSON.parse(row.body))
    assert.equal(saved.every(row => Number.isInteger(row.score) && row.workProductId && row.turnId && row.promptVersion), true)
    assert.equal(saved.find(row => row.id === originalOrder[1].id).score, 0)
    assert.equal(saved.find(row => row.id === originalOrder[9].id).score, 100)
    assert.deepEqual(externalRequests, []); assert.deepEqual(browserErrors, [])
    await page.screenshot({ path: path.join(output, 'all-caught-up-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'all-caught-up-phone.png'), fullPage: true })
  })
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
  checks.push({ name: activeCheck, result: 'FAIL', error: String(error) }); process.exitCode = 1
} finally {
  releaseVerdict?.(); for (const client of clients) client.end()
  await context?.close(); await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  const report = { target: 'Built shared ReviewInbox with real local HTTP/SSE and SQLite; keyboard-only fixture triage',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), capturedAt: new Date().toISOString(),
    checks, previewCount: fixtures.length, verdictCount: count('verdicts'), learningRowCount: count('signals'), verdictRequests, failedWrites, externalRequests, browserErrors,
    missingCoverage: ['Actual Drew ratings', 'Real phone hardware', 'Served GTM consumer', 'Live send, publish or ad buy'] }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const media = (await readdir(output)).filter(file => /\.(png|webm)$/.test(file)).sort().map(file => `<figure><figcaption>${file}</figcaption>${file.endsWith('.webm') ? `<video controls src="${file}"></video>` : `<img alt="${file}" src="${file}">`}</figure>`).join('')
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review inbox proof</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem}img,video{max-width:100%}pre{white-space:pre-wrap}</style><h1>Keyboard review inbox proof</h1><p>Local fixture records and ratings, with real HTTP and SQLite. Actual Drew ratings and served GTM behavior remain unchecked.</p><pre>${JSON.stringify(report, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>${media}`)
  db.close(); await rm(temp, { recursive: true, force: true })
  console.log(JSON.stringify({ output, passed: checks.filter(check => check.result === 'PASS').length, failed: checks.filter(check => check.result === 'FAIL').length }))
}
