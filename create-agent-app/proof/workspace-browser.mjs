// Real local Worker + D1 + packed browser assets. Never invokes a model or
// overrides a production handler. Run by the existing test:generated gate.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const [projectArg, evidenceArg] = process.argv.slice(2)
if (!projectArg || !evidenceArg) throw new Error('Usage: node workspace-browser.mjs <generated-project> <evidence-dir>')
const project = resolve(projectArg)
const evidence = resolve(evidenceArg)
const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
const config = join(project, 'wrangler.workspace-proof.toml')
const vars = join(project, '.dev.vars')
const state = join(project, '.workspace-proof-state')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const server = createServer()
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
await new Promise((resolve) => server.close(resolve))
const origin = `http://127.0.0.1:${port}`
const email = 'workspace-proof@example.test'
const password = randomBytes(24).toString('hex')
const failures = []
const recordings = []
let turnRequests = 0
let child
let browser
let workerOutput = ''

function run(args) {
  const result = spawnSync(pnpm, args, { cwd: project, env: process.env, stdio: 'inherit', timeout: 180_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${pnpm} ${args.join(' ')}`)
}
async function stopWorker() {
  if (!child || !child.pid || child.exitCode !== null) return
  const current = child
  const exited = new Promise((resolve) => current.once('exit', resolve))
  if (process.platform !== 'win32') process.kill(-current.pid, 'SIGTERM')
  else current.kill('SIGTERM')
  await Promise.race([exited, delay(5000)])
  if (current.exitCode === null && current.signalCode === null) {
    if (process.platform !== 'win32') process.kill(-current.pid, 'SIGKILL')
    else current.kill('SIGKILL')
    await exited
  }
  child = undefined
}
async function startWorker() {
  workerOutput = ''
  child = spawn(pnpm, ['exec', 'wrangler', 'dev', '--local', '--config', config, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state], {
    cwd: project, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  let spawnError
  child.once('error', (error) => { spawnError = error })
  for (const output of [child.stdout, child.stderr]) output.on('data', (chunk) => { workerOutput = (workerOutput + chunk).slice(-8000) })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`Worker exited (${child.exitCode})\n${workerOutput}`)
    try { if ((await fetch(`${origin}/api/auth/get-session`, { signal: AbortSignal.timeout(2000) })).ok) return }
    catch { /* Wait for the real build/Worker, never replace its responses. */ }
    await delay(250)
  }
  throw new Error(`Worker did not start\n${workerOutput}`)
}
async function pageInNewContext() {
  const viewport = { width: 1440, height: 960 }
  const context = await browser.newContext({ viewport, recordVideo: { dir: join(evidence, 'videos'), size: viewport } })
  const page = await context.newPage()
  const video = page.video()
  assert.ok(video, 'The generated workspace journey must retain its recording')
  recordings.push({ path: await video.path(), size: viewport })
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST') turnRequests++
  })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.origin === origin || url.protocol === 'data:' ? route.continue() : route.abort()
  })
  return { context, page }
}
async function signIn(page, signup) {
  await page.goto(origin)
  if (signup) await page.getByRole('button', { name: 'No account? Sign up' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('heading', { name: 'What can we work on?' }).waitFor()
}
async function assertStyled(page) {
  const actual = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    tokens: getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    stylesheets: document.styleSheets.length,
  }))
  assert.ok(actual.stylesheets > 0 && actual.tokens, 'Public styles and tokens must load')
  assert.notEqual(actual.background, 'rgba(0, 0, 0, 0)', 'Standalone body must not be transparent')
  assert.equal(actual.overflow, false, 'Workspace must fit the viewport')
  return actual
}

try {
  mkdirSync(evidence, { recursive: true })
  // Only this throwaway generated project's local config is changed. No real
  // account, provider secret, production database, or hosted endpoint is used.
  writeFileSync(config, readFileSync(join(project, 'wrangler.toml'), 'utf8')
    .replace('REPLACE_WITH_D1_DATABASE_ID', '00000000-0000-0000-0000-000000000001')
    .replace('http://localhost:8787', origin))
  writeFileSync(vars, `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  run(['exec', 'wrangler', 'd1', 'migrations', 'apply', pkg.name, '--local', '--config', config, '--persist-to', state])
  await startWorker()
  for (const path of ['/api/not-a-route', '/v1/not-a-route']) {
    const response = await fetch(origin + path, { headers: { Accept: 'text/html' } })
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  }
  browser = await chromium.launch({ headless: true })
  let { context, page } = await pageInNewContext()
  await signIn(page, true)
  // Customer discovery and owner key issuance on the real generated Worker.
  for (const path of ['/llms.txt', '/llms-full.txt', '/agent-setup.md', '/agent-api.md', '/.well-known/tangle-agent.json']) {
    const response = await fetch(origin + path)
    assert.equal(response.status, 200, path)
    assert.ok(!response.headers.get('content-type')?.includes('text/html'), path)
  }
  const markdown = await fetch(origin, { headers: { accept: 'text/markdown' } })
  assert.match(markdown.headers.get('content-type') ?? '', /text\/markdown/)
  assert.match(markdown.headers.get('vary') ?? '', /Accept/)
  await page.getByRole('link', { name: 'API access', exact: true }).click()
  await page.getByRole('heading', { name: 'API access', exact: true }).waitFor()
  assert.ok(!(await page.locator('body').innerText()).includes('gets its own capped key'), 'Manual owner-key onboarding must not advertise self-issued capped keys')
  await page.getByLabel('Name', { exact: true }).fill('Fresh external client proof')
  await page.getByRole('button', { name: 'Create key', exact: true }).click()
  const keyField = page.getByLabel('New API key', { exact: true })
  await keyField.waitFor()
  const localKey = await keyField.inputValue()
  const operator = await fetch(`${origin}/api/operator/v1`, { headers: { authorization: `Bearer ${localKey}` } })
  assert.equal(operator.status, 200)
  const contract = await operator.json()
  assert.deepEqual(contract.principal.scopes, ['operator:read'])
  assert.ok(!contract.app.capabilities.includes('files.read'), 'Unconfigured bytes must not be advertised')
  await page.getByRole('button', { name: 'I’ve saved it', exact: true }).click()
  await page.screenshot({ path: join(evidence, 'workspace-api-access.png'), fullPage: true })
  await page.getByRole('button', { name: 'Revoke Fresh external client proof', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Key revoked' }).waitFor()
  assert.equal((await fetch(`${origin}/api/operator/v1`, { headers: { authorization: `Bearer ${localKey}` } })).status, 401)
  await page.getByRole('link', { name: 'New thread', exact: true }).click()

  await page.getByRole('heading', { name: 'What can we work on?', exact: true }).waitFor()
  const entryDesktop = await assertStyled(page)
  await page.screenshot({ path: join(evidence, 'workspace-entry-desktop.png'), fullPage: true })
  const initialViewport = page.viewportSize()
  assert.ok(initialViewport)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.getByRole('heading', { name: 'What can we work on?', exact: true }).waitFor()
  const entryGeometry = await page.getByRole('heading', { name: 'What can we work on?', exact: true }).boundingBox()
  assert.ok(entryGeometry && entryGeometry.width >= 330, 'Mobile entry must use the full workspace width')
  assert.ok(Math.abs(entryGeometry.x + entryGeometry.width / 2 - 195) <= 2, 'Mobile entry must be centered')
  const entryMobile = await assertStyled(page)
  await page.screenshot({ path: join(evidence, 'workspace-entry-mobile.png'), fullPage: true })
  await page.setViewportSize(initialViewport)
  const response = await page.request.post(`${origin}/api/threads`, { data: { firstMessage: 'Saved workspace proof' } })
  assert.equal(response.status(), 200)
  const { thread } = await response.json()
  const href = `/?threadId=${encodeURIComponent(thread.id)}`
  await page.reload()
  await page.getByRole('link', { name: 'History', exact: true }).first().click()
  await page.getByRole('heading', { name: 'History', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Saved workspace proof', exact: true }).last().click()
  await page.waitForURL(`${origin}${href}`)
  await page.getByText('Send a message to continue this thread.', { exact: true }).waitFor()
  const desktop = await assertStyled(page)
  await page.screenshot({ path: join(evidence, 'workspace-desktop.png'), fullPage: true })
  await page.reload()
  assert.equal(new URL(page.url()).searchParams.get('threadId'), thread.id)
  const saved = await page.request.get(`${origin}/api/threads/${encodeURIComponent(thread.id)}/messages`)
  assert.equal(saved.status(), 200)
  assert.equal((await saved.json()).thread.id, thread.id)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
  await drawer.getByRole('link', { name: 'New thread', exact: true }).waitFor()
  await drawer.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  await page.screenshot({ path: join(evidence, 'workspace-mobile-navigation.png'), fullPage: true })
  await drawer.getByRole('link', { name: 'History', exact: true }).click()
  await page.getByRole('heading', { name: 'History', exact: true }).waitFor()
  const mobile = await assertStyled(page)
  await page.screenshot({ path: join(evidence, 'workspace-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'User menu', exact: true }).click()
  await page.getByRole('menu').waitFor()
  assert.equal(await page.getByRole('menuitem', { name: /Settings$/ }).count(), 0, 'Apps without settings must omit the destination')
  await page.screenshot({ path: join(evidence, 'workspace-mobile-account.png'), fullPage: true })
  await page.getByRole('menuitem', { name: /Sign Out$/ }).click()
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
  assert.equal((await page.request.get(`${origin}/api/threads`)).status(), 401)
  await context.close()
  await stopWorker()
  await startWorker()
  ;({ context, page } = await pageInNewContext())
  await signIn(page, false)
  await page.getByRole('link', { name: 'Saved workspace proof', exact: true }).first().click()
  await page.waitForURL(`${origin}${href}`)
  const reopened = await page.request.get(`${origin}/api/threads/${encodeURIComponent(thread.id)}/messages`)
  assert.equal(reopened.status(), 200)
  assert.equal((await reopened.json()).thread.id, thread.id)
  await page.getByText('Send a message to continue this thread.', { exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, 'workspace-reopened.png'), fullPage: true })
  await context.close()
  assert.deepEqual(failures, [], 'Browser runtime errors')
  assert.equal(turnRequests, 0, 'Local persistence proof must make no model turn requests')
  const result = {
    node: process.version,
    browser: browser.version(),
    browserDriver: "repository-pinned Playwright Chromium, one browser",
    package: pkg.name,
    checks: ['public agent discovery', 'owner read-only key issuance', 'fresh bearer client discovery', 'key revocation', 'real signup', 'real cookie session', 'HTTP thread create', 'History navigation', 'thread URL reload', 'shared mobile drawer navigation', 'shared profile menu signout', 'fresh Worker process and browser login reopen the same D1 thread'],
    entryDesktop, entryMobile, desktop, mobile, modelTurnRequests: turnRequests, recordings,
    unrun: ['hosted deployment', 'live model/sandbox turn', 'live mid-turn disconnect'],
    messagePersistence: 'Covered separately by the generated app e2e suite with its explicitly fake sandbox producer, not by this no-model browser proof.',
  }
  writeFileSync(join(evidence, 'workspace-proof.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser?.close()
  await stopWorker()
  for (const path of [config, vars, state]) rmSync(path, { recursive: true, force: true })
  if (recordings.length) writeFileSync(join(evidence, 'workspace-videos.json'), JSON.stringify({ recordings }, null, 2) + '\n')
}
