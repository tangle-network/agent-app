/** Built shared rows, real browser video/swipe, HTTP and SQLite; no provider or model calls. */
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
import { presentHubAction } from '../dist/hub-approvals/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--output')
const output = path.resolve(at >= 0 ? process.argv[at + 1] : path.join(os.homedir(), 'reviews', `hub-media-${Date.now()}`))
await mkdir(output, { recursive: true })
const temp = await mkdtemp(path.join(os.tmpdir(), 'hub-media-'))
const db = new DatabaseSync(path.join(output, 'media-feedback.sqlite'))
db.exec('CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, approval_id TEXT NOT NULL, body TEXT NOT NULL)')
const require = createRequire(import.meta.url)
const { build } = await import(createRequire(require.resolve('tsup')).resolve('esbuild'))
const checks = [], playback = [], externalRequests = [], browserErrors = []
let checkName = 'initial render', browser, context, page, server

// This runs inside the real browser: its MediaRecorder creates an actual moving WebM fixture.
async function makeFixtures() {
  const canvas = document.createElement('canvas')
  canvas.width = 360; canvas.height = 640
  const drawing = canvas.getContext('2d')
  const paint = (frame, color) => {
    drawing.fillStyle = color; drawing.fillRect(0, 0, 360, 640)
    drawing.fillStyle = '#ffffff'; drawing.font = 'bold 32px sans-serif'; drawing.fillText('Sandbox', 28, 220)
    drawing.font = '20px sans-serif'; drawing.fillText('Local media fixture', 28, 258)
    drawing.beginPath(); drawing.arc(45 + frame * 8, 350, 24, 0, Math.PI * 2); drawing.fill()
  }
  const images = ['#243e82', '#7a421d', '#314d3f'].map((color, index) => {
    paint(index * 8, color)
    return { kind: 'image', src: canvas.toDataURL('image/png'), alt: `Sandbox example, slide ${index + 1}`, width: 360, height: 640 }
  })
  const stream = canvas.captureStream(20)
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
  const chunks = []
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
  const stopped = new Promise(resolve => { recorder.onstop = resolve })
  recorder.start()
  let frame = 0
  const timer = setInterval(() => {
    paint(frame++, '#243e82')
    if (frame >= 30) { clearInterval(timer); recorder.stop() }
  }, 50)
  await stopped
  stream.getTracks().forEach(track => track.stop())
  const video = await new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve({ kind: 'video', src: reader.result, alt: 'Moving Sandbox example', width: 360, height: 640, poster: images[0].src })
    reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }))
  })
  const caption = 'Build the prototype before the setup afternoon. https://example.invalid/sandbox'
  const post = (id, channel, actionPath, input, placement, media, extra = {}) => ({
    id, providerId: actionPath === 'work-product' ? channel : actionPath.split('.')[0], actionPath, phase: 'waiting', executionMode: 'dry-run', account: 'Example studio',
    input, preview: { kind: 'post', channel, text: caption,
      displayName: 'Example studio', handle: '@example-studio', placement, media, ...extra },
  })
  return [
    post('x-image', 'x', 'x.tweets.create', { text: caption }, 'feed', [images[0]]),
    post('x-images', 'x', 'x.tweets.create', { text: caption }, 'feed', [...images, images[0]]),
    post('x-video', 'x', 'x.tweets.create', { text: caption }, 'feed', [video]),
    post('tiktok-video', 'tiktok', 'tiktok.publishing.videoFromUrl', { title: caption, video_url: 'https://example.invalid/video.webm' }, 'vertical', [video]),
    post('instagram-reel', 'instagram', 'instagram-business.media.createContainer', { container: { caption, media_type: 'REELS', video_url: 'https://example.invalid/video.webm' } }, 'vertical', [video]),
    { ...post('youtube-short', 'youtube', 'work-product', { caption }, 'vertical', [video]), bundle: { title: 'Retained YouTube Short (preview only)' } },
    post('instagram-carousel', 'instagram', 'instagram-business.media.createContainer', { container: { caption, media_type: 'CAROUSEL', children: ['fixture-slide-1', 'fixture-slide-2', 'fixture-slide-3'] } }, 'carousel', images),
    post('facebook-ad', 'facebook', 'meta-ads.creatives.createLink', { message: caption, headline: 'A smaller setup for your prototype', imageUrl: 'https://example.invalid/image.png', callToAction: 'Learn more' }, 'feed', [images[0]], { sponsored: true, callToAction: 'Learn more', link: { url: 'https://example.invalid/sandbox', title: 'A smaller setup for your prototype' } }),
    post('linkedin-sponsored', 'linkedin', 'linkedin.posts.create', { commentary: caption }, 'feed', [images[0]], { sponsored: true, callToAction: 'Learn more', link: { url: 'https://example.invalid/sandbox', title: 'A smaller setup for your prototype' } }),
    post('blocked-remote', 'x', 'x.tweets.create', { text: caption }, 'carousel', [{ kind: 'image', src: 'https://example.invalid/tracker.png', alt: 'Remote image' }, { kind: 'video', src: 'https://example.invalid/video.webm', alt: 'Remote video' }, { kind: 'image', src: 'blob:https://example.invalid/foreign', alt: 'Foreign Blob image' }]),
  ]
}

const app = `
import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {HubApprovalRow} from './dist/hub-approvals-react/index.js';
const makeFixtures=${makeFixtures.toString()};
function App(){const[items,setItems]=useState([]);const[selected,setSelected]=useState('x-image');
useEffect(()=>{const urls=[];(async()=>{let data=await(await fetch('/api/fixtures')).json();if(!data.length)data=await(await fetch('/api/fixtures',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await makeFixtures())})).json();const reel=data.find(item=>item.id==='instagram-reel');const asset=reel?.preview.media[0];if(asset){const bytes=await(await fetch(asset.src)).blob();const url=URL.createObjectURL(bytes);urls.push(url);asset.src=url}setItems(data)})();return()=>urls.forEach(url=>URL.revokeObjectURL(url))},[]);
async function feedback(item,fields){const response=await fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:item.id,...fields})});const body=await response.json();if(!response.ok)throw new Error(body.error);setItems(items=>items.map(item=>item.id===body.id?body:item))}
const item=items.find(item=>item.id===selected);if(!item)return <p>Preparing local media…</p>;
return <main className="mx-auto max-w-xl space-y-4 px-3 py-6"><header><h1 className="text-xl font-semibold">Review media before publishing</h1><p className="text-sm text-muted-foreground">Local fixtures. Automated fixture ratings; no actual Drew ratings.</p></header>
<label className="block text-sm">Preview case<select aria-label="Preview case" value={selected} onChange={event=>setSelected(event.target.value)} className="ml-2 rounded border p-2">{items.map(item=><option key={item.id}>{item.id}</option>)}</select></label>
<HubApprovalRow key={item.id} item={item} expanded onFeedback={feedback}/></main>}
createRoot(document.getElementById('root')).render(<App/>);`

const storedFeedback = id => {
  const row = db.prepare('SELECT body FROM feedback WHERE approval_id=? ORDER BY id DESC LIMIT 1').get(id)
  return row ? JSON.parse(row.body) : undefined
}
const list = () => db.prepare('SELECT body FROM previews ORDER BY rowid').all().map(row => {
  const item = JSON.parse(row.body)
  return { ...item, feedback: storedFeedback(item.id) }
})
async function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()) }
async function check(name, run) { checkName = name; await run(); checks.push({ name, result: 'PASS' }) }
try {
  await build({ stdin: { contents: app, loader: 'jsx', resolveDir: root }, outfile: path.join(temp, 'app.js'), absWorkingDir: root,
    bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
  const config = path.join(temp, 'tailwind.mjs')
  await writeFile(config, `import preset from ${JSON.stringify(path.join(root, 'dist/theme/tailwind-preset.js'))};export default {presets:[preset]}`)
  const css = await postcss([tailwind({ base: root })]).process(`@import "tailwindcss";\n@import "./dist/theme/tailwind.css";\n@config ${JSON.stringify(config)};`, { from: path.join(root, 'proof.css') })
  await writeFile(path.join(temp, 'app.css'), css.css)
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/fixtures') {
        if (request.method === 'POST') for (const item of await body(request)) db.prepare('INSERT INTO previews VALUES (?,?)').run(item.id, JSON.stringify(item))
        return json(response, list())
      }
      if (request.url === '/api/feedback') {
        const feedback = await body(request)
        const original = list().find(item => item.id === feedback.id)
        if (!original || !Number.isFinite(feedback.score) || feedback.score < 0 || feedback.score > 100) return json(response, { error: 'Invalid feedback' }, 400)
        const after = feedback.editedInput ?? original.input
        const diff = Object.keys(after).filter(key => JSON.stringify(after[key]) !== JSON.stringify(original.input[key])).map(key => ({ path: key, before: original.input[key], after: after[key] }))
        const saved = { score: feedback.score, comment: feedback.comment, editedInput: feedback.editedInput, diff, savedAt: new Date().toISOString(),
          workProductId: original.id, turnId: 'fixture-media-turn', promptVersion: 'fixture-media-prompt', reviewer: 'fixture-reviewer' }
        db.prepare('INSERT INTO feedback (approval_id,body) VALUES (?,?)').run(original.id, JSON.stringify(saved))
        return json(response, { ...original, feedback: saved })
      }
      const asset = request.url === '/app.js' ? ['app.js', 'text/javascript'] : request.url === '/app.css' ? ['app.css', 'text/css'] : null
      if (asset) { response.writeHead(200, { 'content-type': asset[1] }); return response.end(await readFile(path.join(temp, asset[0]))) }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Media preview proof</title><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
    } catch (error) { await json(response, { error: String(error) }, 500) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, slowMo: 80 })
  context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 1000 }, recordVideo: { dir: output, size: { width: 1280, height: 1000 } } })
  context.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) externalRequests.push(request.url()) })
  page = await context.newPage(); page.on('pageerror', error => browserErrors.push(error.message))
  await page.goto(origin)
  await expect(page.getByLabel('Preview case', { exact: true })).toBeVisible({ timeout: 15000 })
  await check('canonical provider inputs preserve copy without the host media projection', async () => {
    for (const fixture of list().filter(item => item.actionPath !== 'work-product')) {
      const derived = presentHubAction({ ...fixture, preview: undefined }).preview
      assert.equal(derived.kind, 'post', fixture.actionPath)
      assert.equal(derived.channel, fixture.preview.channel)
      assert.equal(derived.text, fixture.preview.text)
    }
  })
  for (const [position, fixture] of list().entries()) await check(`${fixture.id}: payload, playback, phone layout and persisted feedback`, async () => {
    await page.getByLabel('Preview case', { exact: true }).selectOption(fixture.id)
    await expect(page.locator('[data-hub-media-channel]')).toBeVisible()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('')
    await expect(page.getByText('Example studio', { exact: false }).first()).toBeVisible()
    if (fixture.id === 'blocked-remote') {
      await expect(page.getByText(/not embedded in this preview/)).toHaveCount(3)
      await expect(page.locator('video,img')).toHaveCount(0)
    } else if (fixture.preview.media[0].kind === 'video') {
      const video = page.locator('video').first()
      await expect(video).toHaveJSProperty('muted', true)
      await expect(video).toHaveAttribute('playsinline', '')
      await expect(video).toHaveJSProperty('controls', true)
      const first = await video.evaluate(element => element.currentTime)
      await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(first + 0.1)
      playback.push({ fixture: fixture.id, beforeSeconds: first, afterSeconds: await video.evaluate(element => element.currentTime), source: await video.evaluate(element => element.src.startsWith('blob:') ? 'current-origin Blob' : 'embedded data') })
    } else await expect(page.locator('[data-hub-media-channel] img').first()).toBeVisible()
    if (fixture.id === 'x-images') {
      await expect(page.locator('[data-hub-media-image-grid] img')).toHaveCount(4)
      await expect(page.locator('[data-hub-media-carousel]')).toHaveCount(0)
    }
    await expect(page.locator('[data-hub-media-character-count]')).toHaveText(`${[...fixture.preview.text].length} characters`)
    if (fixture.preview.sponsored) await expect(page.getByText(fixture.preview.channel === 'linkedin' ? 'Promoted' : 'Sponsored', { exact: true })).toBeVisible()
    if (fixture.preview.placement === 'vertical') {
      await page.getByRole('button', { name: 'Show caption safe zones', exact: true }).click()
      const guides = page.locator('[data-hub-media-safe-zone]')
      await expect(guides).toBeVisible()
      const bounds = await guides.boundingBox()
      assert.ok(bounds.width > 0 && bounds.height > 0, 'Caption guide must retain a usable clear area')
    }
    for (const [label, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal document overflow')
      await page.screenshot({ path: path.join(output, `${fixture.id}-${label}.png`), fullPage: true })
    }
    if (fixture.id === 'instagram-carousel') {
      await page.getByRole('button', { name: 'Next slide', exact: true }).click()
      await expect(page.getByText('Slide 2 of 3', { exact: true })).toHaveText('Slide 2 of 3')
      await page.getByRole('button', { name: 'Previous slide', exact: true }).click()
      await expect(page.getByText('Slide 1 of 3', { exact: true })).toHaveText('Slide 1 of 3')
      const scroller = page.locator('[data-hub-media-carousel-scroll]')
      await scroller.scrollIntoViewIfNeeded()
      const box = await scroller.boundingBox()
      const cdp = await context.newCDPSession(page)
      await cdp.send('Input.synthesizeScrollGesture', { x: box.x + box.width / 2, y: Math.min(box.y + box.height / 2, 700), xDistance: -box.width * 0.85, yDistance: 0, gestureSourceType: 'touch', speed: 500 })
      await expect.poll(() => scroller.evaluate(element => element.scrollLeft / element.clientWidth)).toBeGreaterThan(0.5)
      await cdp.detach()
      await page.screenshot({ path: path.join(output, 'instagram-carousel-after-swipe.png'), fullPage: true })
    }
    await page.getByLabel('Score (0–100)', { exact: true }).fill(String(70 + position))
    await page.getByLabel('Comment', { exact: true }).fill(`Fixture feedback for ${fixture.id}; actual owner rating unknown.`)
    await page.getByRole('button', { name: 'Edit to teach', exact: true }).click()
    await expect(page.getByLabel('Post text', { exact: true })).toHaveValue(fixture.preview.text)
    await page.getByLabel('Post text', { exact: true }).fill(fixture.preview.text + ' Edited for clarity.')
    await page.getByRole('button', { name: 'Save feedback', exact: true }).click()
    await expect(page.getByText('Feedback saved', { exact: true })).toBeVisible()
    assert.equal(storedFeedback(fixture.id).score, 70 + position)
    const field = fixture.input.container ? 'container' : typeof fixture.input.title === 'string' ? 'title' : typeof fixture.input.message === 'string' ? 'message' : typeof fixture.input.caption === 'string' ? 'caption' : typeof fixture.input.commentary === 'string' ? 'commentary' : 'text'
    assert.deepEqual(storedFeedback(fixture.id).diff.map(entry => entry.path), [field])
  })
  await check('reduced motion pauses autoplay while native video playback remains available', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByLabel('Preview case', { exact: true }).selectOption('tiktok-video')
    const video = page.locator('video').first()
    await expect(video).toHaveJSProperty('paused', true)
    await expect(video).toHaveJSProperty('loop', false)
    const box = await video.boundingBox()
    await video.click({ position: { x: 20, y: box.height - 20 } })
    await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0.1)
    await page.screenshot({ path: path.join(output, 'reduced-motion-manual-play.png'), fullPage: true })
  })
  await check('all preview scores survive reload, with zero external network calls', async () => {
    await page.reload()
    await expect(page.getByLabel('Score (0–100)', { exact: true })).toHaveValue('70')
    const items = list()
    assert.equal(items.filter(item => Number.isFinite(item.feedback?.score)).length, items.length)
    assert.deepEqual(externalRequests, [])
    assert.deepEqual(browserErrors, [])
  })
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
  checks.push({ name: checkName, result: 'FAIL', error: String(error) }); process.exitCode = 1
} finally {
  await context?.close(); await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  const items = list()
  const report = { target: 'Built shared approval UI and local HTTP/SQLite fixture transport', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    capturedAt: new Date().toISOString(), checks, playback, externalRequests, browserErrors,
    previewCount: items.length, scoredCount: items.filter(item => Number.isFinite(item.feedback?.score)).length,
    missingCoverage: ['Actual Drew ratings', 'Real phone hardware gestures', 'Platform screenshot fidelity comparison', 'Deployed GTM consumer', 'Live publishing or ad buying'] }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const media = (await readdir(output)).filter(file => /\.(png|webm)$/.test(file)).sort().map(file => `<figure><figcaption>${file}</figcaption>${file.endsWith('.webm') ? `<video controls src="${file}"></video>` : `<img alt="${file}" src="${file}">`}</figure>`).join('')
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media preview proof</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem}img,video{max-width:100%}pre{white-space:pre-wrap}</style><h1>Media preview proof</h1><p>Local fixture ratings; actual Drew ratings and platform fidelity remain unknown. No posting or purchases.</p><pre>${JSON.stringify(report, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>${media}`)
  db.close(); await rm(temp, { recursive: true, force: true })
  console.log(JSON.stringify({ output, passed: checks.filter(check => check.result === 'PASS').length, failed: checks.filter(check => check.result === 'FAIL').length }))
}
