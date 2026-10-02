/** Fresh installed-package/type/browser proof. Requires the repository's normal dev install. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
assert.ok(process.argv[2], 'Supply a new evidence directory; existing proof is never overwritten.')
const proof = resolve(process.argv[2])
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '',
  'Run this proof from a clean, committed checkout; use an evidence directory outside the source tree.')
mkdirSync(proof, { recursive: false })
const scratch = mkdtempSync(join(tmpdir(), 'agent-app-chatgpt-'))
const consumer = join(scratch, 'consumer')
mkdirSync(consumer)
const require = createRequire(join(root, 'package.json'))
const { build } = createRequire(require.resolve('tsup'))('esbuild')
const npm = join(root, 'node_modules/npm/bin/npm-cli.js')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const commands = []
const run = (command, args, cwd = root) => {
  commands.push({ command, args, cwd: cwd === root ? 'source' : 'isolated-consumer' })
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}
let browser, server
const report = { ok: false, commands, browser: [], limits: ['Synthetic display data; no live registration, OAuth, permissions, message, or hosted-adoption proof.'] }
try {
  report.sourceCommit = run('git', ['rev-parse', 'HEAD']).trim()
  run(process.execPath, ['--experimental-strip-types', '--test', 'tests/integrations-react/chatgpt-state.node.mjs'])
  run('pnpm', ['run', 'build'])
  const packOutput = JSON.parse(run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch]))
  const packed = Array.isArray(packOutput) ? packOutput[0] : packOutput['@tangle-network/agent-app']
  assert.ok(packed?.filename)
  assert.ok(packed.files.some(file => file.path === 'dist/integrations-react/chatgpt.d.ts'))
  const archive = join(scratch, packed.filename)
  report.archiveSha256 = sha256(readFileSync(archive))
  const dependencies = { '@tangle-network/agent-app': `file:${archive}` }
  // Use the source checkout's actual installed public UI cohort, not floating versions.
  for (const name of ['react', 'react-dom', '@types/react', '@types/react-dom', '@tangle-network/ui',
    '@tangle-network/brand', '@tangle-network/sandbox-ui', '@tangle-network/hub-sdk', 'tailwindcss']) {
    dependencies[name] = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
  }
  report.dependencies = { ...dependencies, '@tangle-network/agent-app': 'fresh local archive' }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2))
  run(process.execPath, [npm, 'install', '--ignore-scripts', '--strict-peer-deps', '--no-audit', '--no-fund'], consumer)
  run(process.execPath, [npm, 'ci', '--ignore-scripts', '--strict-peer-deps', '--no-audit', '--no-fund'], consumer)
  report.consumerLockSha256 = sha256(readFileSync(join(consumer, 'package-lock.json')))
  copyFileSync(join(root, 'examples/connect-chatgpt/Connections.tsx'), join(consumer, 'Connections.tsx'))
  writeFileSync(join(consumer, 'main.tsx'), `
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Connections, type ExistingAppConnection } from './Connections'
const root = createRoot(document.getElementById('root')!)
function fixture(name: string, scenario: string): ExistingAppConnection {
  const enrollment = { enrollmentId: name + '-enrollment', agentId: name + '-agent', workspaceId: name + '-workspace', threadId: name + '-thread' }
  const endpoint = 'https://' + name.toLowerCase() + '.example/api/agents/mcp'
  const registration = { endpoint, connectionId: 'asdk_app_fixture_' + name }
  const app: ExistingAppConnection = { config: { identity: { name, persona: 'Local display fixture only.' } }, enrollment, endpoint }
  if (scenario === 'connected' || scenario === 'stale') app.connection = { status: 'connected', registration, enrollment: { ...enrollment } }
  else if (scenario === 'checking' || scenario === 'error') app.connection = { status: scenario }
  else if (name === 'GTM') app.connection = { status: 'registered', registration }
  if (scenario === 'stale') app.enrollment = { ...enrollment, threadId: 'changed-thread' }
  if (scenario === 'invalid') app.endpoint = ''
  if (scenario === 'long') { app.config.identity.name += ' — ' + 'LongWorkspaceName'.repeat(12); app.endpoint += '/' + 'resource'.repeat(60); app.connection = { status: 'setup' } }
  return app
}
declare global { interface Window { renderProof: (scenario: string) => void } }
window.renderProof = scenario => flushSync(() => root.render(<>
  <p style={{ margin: '1rem', fontSize: '0.875rem' }}>Local display fixtures — not hosted connections.</p>
  <Connections builder={fixture('Builder', scenario)} gtm={fixture('GTM', scenario)} />
</>))
window.renderProof('setup')
`)
  writeFileSync(join(consumer, 'contract-check.ts'), `
import type { ChatGPTConnectionState, ChatGPTRegistration } from '@tangle-network/agent-app/integrations-react'
declare const registration: ChatGPTRegistration
// @ts-expect-error A registered ID alone must never imply an enrolled connection.
const missingIdentity = { status: 'connected', registration } satisfies ChatGPTConnectionState
// @ts-expect-error Package installation is not a supported connection observation.
const installed = { status: 'installed' } satisfies ChatGPTConnectionState
`)
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx',
      strict: true, noEmit: true, skipLibCheck: true, lib: ['DOM', 'ES2022'] },
    include: ['Connections.tsx', 'main.tsx', 'contract-check.ts'],
  }, null, 2))
  run('pnpm', ['exec', 'tsc', '--project', join(consumer, 'tsconfig.json')])
  report.typecheck = 'strict consumer; skipLibCheck=true (not package-wide declaration validation)'
  await build({ absWorkingDir: consumer, entryPoints: ['main.tsx'], outfile: join(consumer, 'app.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' } })
  writeFileSync(join(consumer, 'tailwind.config.mjs'), "import preset from '@tangle-network/agent-app/tailwind-preset'; export default { presets: [preset] };\n")
  const utilities = await postcss([tailwind({ base: consumer })]).process(`
@import 'tailwindcss';
@config './tailwind.config.mjs';
@source './Connections.tsx';
@source './node_modules/@tangle-network/agent-app/dist';
@source './node_modules/@tangle-network/ui/dist';
`, { from: join(consumer, 'consumer.css') })
  const installed = createRequire(join(consumer, 'package.json'))
  const css = utilities.css + '\n' + readFileSync(installed.resolve('@tangle-network/agent-app/styles'), 'utf8')
  const js = readFileSync(join(consumer, 'app.js'))
  report.cssSha256 = sha256(css)
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to ChatGPT installed proof</title><link rel="stylesheet" href="/style.css"><body style="margin:0;background:hsl(var(--background));color:hsl(var(--foreground));font-family:var(--font-sans)"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`
  server = createServer((request, response) => {
    const resource = { '/': ['text/html', html], '/app.js': ['text/javascript', js], '/style.css': ['text/css', css] }[request.url]
    if (!resource) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': resource[0] }); response.end(resource[1])
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch()
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    const errors = [], externalRequests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      externalRequests.push(route.request().url()); return route.abort()
    })
    await page.addInitScript(() => {
      window.clickedLinks = []
      document.addEventListener('click', event => {
        const link = event.target instanceof Element ? event.target.closest('a') : null
        if (link) { event.preventDefault(); window.clickedLinks.push(link.href) }
      })
    })
    await page.goto(origin)
    await page.waitForSelector('[data-chatgpt-state="setup"]')
    await page.evaluate(theme => { document.documentElement.className = theme }, theme)
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Connect to ChatGPT')), true)
    const focus = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' || s.boxShadow !== 'none' })
    assert.ok(focus, 'Primary action must have visible keyboard focus')
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.clickedLinks), ['https://chatgpt.com/plugins'])
    assert.equal(await page.locator('section').first().getAttribute('data-chatgpt-state'), 'setup')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY')
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('details').first().evaluate(element => element.open), true)
    await page.keyboard.press('Tab')
    const selection = await page.evaluate(() => { const el = document.activeElement; return { tag: el.tagName, selected: el.selectionEnd - el.selectionStart, length: el.value?.length } })
    assert.equal(selection.tag, 'INPUT'); assert.equal(selection.selected, selection.length)
    for (const scenario of ['setup', 'connected', 'checking', 'error', 'stale', 'invalid', 'long']) {
      await page.evaluate(scenario => window.renderProof(scenario), scenario)
      const expected = { setup: 'setup', connected: 'connected', checking: 'checking', error: 'error', stale: 'error', invalid: 'unavailable', long: 'setup' }[scenario]
      assert.equal(await page.locator('section').first().getAttribute('data-chatgpt-state'), expected)
      await page.locator('summary').first().click()
      const dimensions = await page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        cardsFit: [...document.querySelectorAll('section')].every(el => el.scrollWidth <= el.clientWidth),
        actionHeights: [...document.querySelectorAll('section > div > a, section > div > button')].map(el => el.getBoundingClientRect().height),
        cardBackground: getComputedStyle(document.querySelector('section')).backgroundColor,
      }))
      assert.equal(dimensions.scrollWidth, dimensions.width)
      assert.ok(dimensions.cardsFit)
      assert.ok(dimensions.actionHeights.length === 2 && dimensions.actionHeights.every(height => height >= 44))
      if (['setup', 'connected', 'error'].includes(scenario)) await page.screenshot({ path: join(proof, `${scenario}-${width}-${theme}.png`), fullPage: true })
      report.browser.push({ width, theme, scenario, ...dimensions })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const animated = await page.locator('section').first().evaluate(element => [...element.querySelectorAll('*')].some(el => getComputedStyle(el).animationName !== 'none'))
    assert.equal(animated, false)
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, [])
    await page.close()
  }
  assert.notEqual(report.browser.find(row => row.theme === 'light').cardBackground, report.browser.find(row => row.theme === 'dark').cardBackground)
  report.ok = true
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  writeFileSync(join(proof, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  rmSync(scratch, { recursive: true, force: true })
}
