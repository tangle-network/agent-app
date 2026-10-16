/** Browser integration proof of the built shared approval surface. No provider credentials or calls. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const argument = (name) => process.argv[process.argv.indexOf(name) + 1]
const before = process.argv.includes('--capture-before')
const fault = process.argv.includes('--fault-no-feedback')
const output = path.resolve(process.argv.includes('--output') ? argument('--output') : path.join(os.homedir(), 'reviews', `hub-preview-${Date.now()}`))
await mkdir(output, { recursive: true })
const temp = await mkdtemp(path.join(os.tmpdir(), 'hub-preview-'))
const db = new DatabaseSync(path.join(output, 'feedback.sqlite'))
db.exec('CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, approval_id TEXT NOT NULL, body TEXT NOT NULL)')
const require = createRequire(import.meta.url)
const { build } = await import(createRequire(require.resolve('tsup')).resolve('esbuild'))
const checks = []
const externalRequests = []
const errors = []
let failedSaves = 0
let decisionCalls = 0
let failNextSave = false
let holdNextSave = false
let releaseSave
let checkName = 'initial render'
let browser, context, server, page
const original = {
  id: 'fixture-email-1', actionPath: 'gmail.send', providerId: 'gmail', phase: 'waiting',
  executionMode: 'dry-run', account: 'Taylor at Example <taylor@example.invalid>',
  input: {
    from: 'Taylor at Example <taylor@example.invalid>', to: ['Alex <alex@example.invalid>'],
    subject: 'A smaller sandbox setup for your next prototype',
    previewText: 'A working environment without another setup afternoon.',
    body: '<p>Hi Alex,</p><p>Your prototype should start with code, not setup. Here is a <a href="https://example.invalid/sandbox">sandbox walkthrough</a>.</p><p>Would a five-minute setup help your next experiment?</p><p>Taylor<br>Example team</p>'
      + '<img src="https://example.invalid/tracking.gif"><script>fetch("https://example.invalid/script")</script>'
      + '<meta http-equiv="refresh" content="0;url=https://example.invalid/redirect"><link rel="stylesheet" href="https://example.invalid/remote.css">'
      + '<form action="https://example.invalid/form"><input type="submit" value="Submit remote"></form>'
      + '<iframe src="https://example.invalid/frame"></iframe><object data="https://example.invalid/object"></object>',
    html: true,
  },
}
const latest = () => {
  const row = db.prepare('SELECT body FROM feedback ORDER BY id DESC LIMIT 1').get()
  return row ? JSON.parse(row.body) : null
}
const item = () => ({ ...original, ...(latest() ? { feedback: latest() } : {}) })
const js = path.join(temp, 'app.js')
const app = `
import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HubApprovalRow,HubApprovalDock} from './dist/hub-approvals-react/index.js';
function App(){
  const [item,setItem]=useState(null);
  const [expanded,setExpanded]=useState(true);
  const query=new URLSearchParams(location.search);
  const dock=query.has('dock');
  useEffect(()=>{fetch('/api/approval').then(r=>r.json()).then(setItem)},[]);
  async function onFeedback(item,feedback){
    const response=await fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:item.id,...feedback})});
    const body=await response.json();if(!response.ok)throw new Error(body.error);if(!query.has('lag'))setItem(body);
  }
  async function onDecide(){await fetch('/api/decide',{method:'POST'});}
  if(!item)return <p>Loading preview…</p>;
  const feedback=${fault ? 'undefined' : 'onFeedback'};
  const plain='Hi Alex, see https://example.invalid/plain-link for the walkthrough.';
  const shown=query.has('plain')?{...item,input:{...item.input,html:false,body:plain}}:query.has('post')?{...item,providerId:'x',actionPath:'x.tweets.create',input:{text:'A smaller setup for your prototype: https://example.invalid/post-link'}}:item;
  const other={...item,id:'fixture-email-2',feedback:undefined,input:{...item.input,subject:'A separate held email for Sam',to:['Sam <sam@example.invalid>']}};
  return <main className="mx-auto max-w-3xl space-y-5 px-4 py-6"><header><p className="text-sm text-muted-foreground">Local fixture · no message sent</p><h1 className="text-xl font-semibold">Review outreach for Alex</h1></header>
  {dock?<HubApprovalDock items={[item,other]} onDecide={onDecide} onFeedback={feedback}/>:<HubApprovalRow item={shown} expanded={expanded} onExpandedChange={setExpanded} onFeedback={feedback}/>}</main>;
}
createRoot(document.getElementById('root')).render(<App/>);`

async function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}
async function check(name, run) {
  checkName = name
  await run()
  checks.push({ name, result: 'PASS' })
}
async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(dimensions.scroll <= dimensions.width, JSON.stringify(dimensions))
}
try {
  await build({ stdin: { contents: app, loader: 'jsx', resolveDir: root }, outfile: js, absWorkingDir: root,
    bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
  // The preset is the same public entry used by real consumers; keep temporary config outside the checkout.
  const config = path.join(temp, 'tailwind.mjs')
  await writeFile(config, `import preset from ${JSON.stringify(path.join(root, 'dist/theme/tailwind-preset.js'))};export default {presets:[preset]}`)
  const css = await postcss([tailwind({ base: root })]).process(
    `@import "tailwindcss";\n@import "./dist/theme/tailwind.css";\n@config ${JSON.stringify(config)};`,
    { from: path.join(root, 'proof.css') },
  )
  await writeFile(path.join(temp, 'app.css'), css.css)
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/approval') return json(response, item())
      if (request.url === '/api/decide') { decisionCalls++; return json(response, { error: 'Live execution is outside this proof' }, 409) }
      if (request.url === '/api/feedback' && request.method === 'POST') {
        const feedback = await requestBody(request)
        if (holdNextSave) { holdNextSave = false; await new Promise(resolve => { releaseSave = resolve }) }
        if (failNextSave) { failNextSave = false; failedSaves++; return json(response, { error: 'Fixture storage unavailable; your edits are still here.' }, 503) }
        if (feedback.id !== original.id || !Number.isFinite(feedback.score) || feedback.score < 0 || feedback.score > 100 || typeof feedback.comment !== 'string') return json(response, { error: 'Invalid feedback' }, 400)
        const edited = feedback.editedInput ?? original.input
        // This fixture transport owns persistence only. GTM separately proves its production signal service.
        const diff = Object.keys({ ...original.input, ...edited }).filter(key => JSON.stringify(original.input[key]) !== JSON.stringify(edited[key]))
          .map(key => ({ path: key, before: original.input[key], after: edited[key] }))
        const saved = { score: feedback.score, comment: feedback.comment, editedInput: feedback.editedInput,
          diff, savedAt: new Date().toISOString(), reviewer: 'fixture-reviewer', workProductId: 'fixture-product-1',
          turnId: 'fixture-turn-1', promptVersion: 'fixture-prompt-1' }
        db.prepare('INSERT INTO feedback (approval_id, body) VALUES (?, ?)').run(original.id, JSON.stringify(saved))
        return json(response, item())
      }
      const asset = request.url === '/app.js' ? ['app.js', 'text/javascript'] : request.url === '/app.css' ? ['app.css', 'text/css'] : null
      if (asset) { response.writeHead(200, { 'content-type': asset[1] }); return response.end(await readFile(path.join(temp, asset[0]))) }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Shared preview proof</title></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
    } catch (error) { await json(response, { error: String(error) }, 500) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, slowMo: 100 })
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, recordVideo: { dir: output, size: { width: 1280, height: 1000 } } })
  page = await context.newPage()
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) externalRequests.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  await expect(page.locator('[data-hub-approval-row]')).toBeVisible()
  if (!before) await expect(page.getByTitle('Email body', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(output, before ? 'before-desktop.png' : 'after-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, before ? 'before-phone.png' : 'after-phone.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 1000 })
  await check('new preview starts without a human score', async () => {
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('')
    assert.equal(latest(), null)
  })
  await check('email HTML renders links but cannot execute or contact remote services', async () => {
    const email = page.locator('[data-hub-email-preview]')
    await expect(email).toContainText('taylor@example.invalid')
    await expect(email).toContainText('alex@example.invalid')
    await expect(email).toContainText(original.input.subject)
    await expect(email).toContainText(original.input.previewText)
    const frame = page.frameLocator('iframe').first()
    await expect(frame.getByText('Hi Alex,', { exact: true })).toBeVisible()
    await expect(frame.getByText('sandbox walkthrough', { exact: true })).toHaveAttribute('href', 'https://example.invalid/sandbox')
    await expect(frame.locator('script, form, meta[http-equiv="refresh"], iframe, object, link')).toHaveCount(0)
    await frame.getByText('sandbox walkthrough', { exact: true }).click()
    assert.equal(context.pages().length, 1, 'Sandbox must block link popups')
    assert.deepEqual(externalRequests, [])
  })
  const subject = 'Start your prototype without the setup afternoon'
  const body = '<p>Hi Alex,</p><p>Try the sandbox on your next prototype.</p><p>Taylor<br>Example team</p>'
  await check('human-style score, comment and email edit persist as a server-computed diff', async () => {
    await page.getByLabel('Score (0–100)', { exact: true }).fill('82')
    await page.getByLabel('Comment', { exact: true }).fill('Make the opening specific. Keep one clear request.')
    await page.getByRole('button', { name: 'Edit to teach', exact: true }).click()
    await page.getByLabel('Subject', { exact: true }).fill(subject)
    await page.getByLabel('Body', { exact: true }).fill(body)
    const collapse = page.locator('[data-hub-approval-row] button[aria-expanded]').first()
    await collapse.click()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveCount(0)
    await collapse.click()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('82')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Make the opening specific. Keep one clear request.')
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(subject)
    await expect(page.getByLabel('Body', { exact: true })).toHaveValue(body)
    await expect(page.getByText('Feedback saved', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Save feedback', exact: true }).click()
    await expect(page.getByText('Feedback saved', { exact: true })).toBeVisible()
    const saved = latest()
    assert.equal(saved.score, 82)
    assert.equal(saved.editedInput.subject, subject)
    assert.equal(saved.editedInput.body, body)
    assert.deepEqual(saved.diff.map(entry => entry.path).sort(), ['body', 'subject'])
    assert.equal(saved.workProductId, 'fixture-product-1')
    assert.equal(saved.turnId, 'fixture-turn-1')
    assert.equal(saved.promptVersion, 'fixture-prompt-1')
    await page.reload()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('82')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue(saved.comment)
    await page.getByRole('button', { name: 'Edit to teach', exact: true }).click()
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(subject)
    await expect(page.getByLabel('Body', { exact: true })).toHaveValue(body)
  })
  await check('failed save preserves the entered score, comment and edit', async () => {
    failNextSave = true
    await page.getByLabel('Score (0–100)', { exact: true }).fill('91')
    await page.getByLabel('Comment', { exact: true }).fill('Keep this feedback during a failed save.')
    await page.getByLabel('Subject', { exact: true }).fill('Unsaved subject remains')
    await page.getByRole('button', { name: 'Save feedback', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Fixture storage unavailable')
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('91')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep this feedback during a failed save.')
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Unsaved subject remains')
    assert.equal(latest().score, 82)
  })
  await check('0 and 100 are valid human scores, with phone and desktop layouts', async () => {
    for (const [score, viewport] of [[0, { width: 390, height: 844 }], [100, { width: 1280, height: 1000 }]]) {
      await page.setViewportSize(viewport)
      await page.getByLabel('Score (0–100)', { exact: true }).fill(String(score))
      await page.getByRole('button', { name: 'Save feedback', exact: true }).click()
      await expect(page.getByText('Feedback saved', { exact: true })).toBeVisible()
      await noOverflow(page)
      await page.screenshot({ path: path.join(output, `saved-${score === 0 ? 'phone' : 'desktop'}.png`), fullPage: true })
      assert.equal(latest().score, score)
      await page.reload()
      await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue(String(score))
    }
  })
  await check('dock reuses persisted feedback without approving a live effect', async () => {
    await page.goto(`${origin}/?dock=1`)
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('100')
    await expect(page.getByRole('button', { name: 'Approve live', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await noOverflow(page)
    await page.screenshot({ path: path.join(output, 'dock-phone.png'), fullPage: true })
  })
  await check('switching between held previews preserves separate unsaved drafts and truthful save status', async () => {
    await page.getByLabel('Score (0–100)', { exact: true }).fill('88')
    await page.getByLabel('Comment', { exact: true }).fill('First preview has an unsaved correction.')
    await page.getByRole('button', { name: 'Edit to teach', exact: true }).click()
    await page.getByLabel('Subject', { exact: true }).fill('Keep the first draft separate')
    await page.locator('[data-hub-approval-dock-row="fixture-email-2"]').click()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('')
    await page.getByLabel('Score (0–100)', { exact: true }).fill('29')
    await page.getByLabel('Comment', { exact: true }).fill('Second preview has a different draft.')
    await page.locator('[data-hub-approval-dock-row="fixture-email-1"]').click()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('88')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('First preview has an unsaved correction.')
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Keep the first draft separate')
    await expect(page.getByText('Feedback saved', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Hide the preview', exact: true }).click()
    await page.getByRole('button', { name: 'Show the request', exact: true }).click()
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Keep the first draft separate')
    await expect(page.getByText('Feedback saved', { exact: true })).toHaveCount(0)
    await page.locator('[data-hub-approval-dock-row="fixture-email-2"]').click()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('29')
    await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Second preview has a different draft.')
    assert.equal(latest().score, 100, 'Unsaved drafts must not become outcome signals')
  })
  await check('save locks navigation and retains its success before host feedback refresh', async () => {
    await page.goto(`${origin}/?dock=1&lag=1`)
    await page.getByLabel('Score (0–100)', { exact: true }).fill('92')
    holdNextSave = true
    await page.getByRole('button', { name: 'Save feedback', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Saving feedback…', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Hide the preview', exact: true })).toBeDisabled()
    await expect(page.locator('[data-hub-approval-dock-row="fixture-email-2"]')).toBeDisabled()
    await expect.poll(() => typeof releaseSave).toBe('function')
    releaseSave()
    releaseSave = undefined
    await expect(page.getByText('Feedback saved', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Hide the preview', exact: true }).click()
    await page.getByRole('button', { name: 'Show the request', exact: true }).click()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('92')
    await expect(page.getByText('Feedback saved', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('92')
    assert.equal(latest().score, 92)
  })
  await check('plain email and social post links stay inert on click', async () => {
    for (const kind of ['plain', 'post']) {
      await page.goto(`${origin}/?${kind}=1`)
      const link = page.getByRole('link', { name: `https://example.invalid/${kind}-link`, exact: true })
      await expect(link).toBeVisible()
      await link.click()
      assert.equal(context.pages().length, 1, `${kind} preview must not open a live link`)
      await noOverflow(page)
      await page.screenshot({ path: path.join(output, `${kind}-phone.png`), fullPage: true })
    }
    assert.equal(decisionCalls, 0)
    assert.equal(failedSaves, 1)
    assert.deepEqual(externalRequests, [])
    assert.deepEqual(errors, [])
  })
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
  checks.push({ name: checkName, result: 'FAIL', error: String(error) })
  process.exitCode = 1
} finally {
  releaseSave?.()
  await context?.close()
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  const report = { target: 'built shared approval UI with local HTTP/SQLite fixture transport; not deployed GTM',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    capturedAt: new Date().toISOString(), fault, checks, externalRequests, decisionCalls, failedSaves, browserErrors: errors,
    savedFeedback: latest(), missingCoverage: ['Actual inbox side-by-side comparison', 'Actual Drew rating', 'Served GTM production flow', 'GTM Gmail dispatch integration'] }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const media = (await readdir(output)).filter(file => /\.(png|webm)$/.test(file)).sort()
    .map(file => `<figure><figcaption>${file}</figcaption>${file.endsWith('.webm') ? `<video controls src="${file}"></video>` : `<a href="${file}"><img alt="${file}" src="${file}"></a>`}</figure>`).join('')
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared approval preview proof</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem}img,video{max-width:100%}pre{white-space:pre-wrap}</style><h1>Shared approval preview proof</h1><p>Local built package, real HTTP and SQLite fixture persistence. This is not production GTM proof or an actual Drew rating.</p>${media}<pre>${JSON.stringify(report, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`)
  db.close()
  await rm(temp, { recursive: true, force: true })
  console.log(JSON.stringify({ output, passed: checks.filter(check => check.result === 'PASS').length, failed: checks.filter(check => check.result === 'FAIL').length }))
}
