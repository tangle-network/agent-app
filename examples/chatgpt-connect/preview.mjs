/** Install the packed public API in a fresh consumer and serve two app configurations. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const output = resolve(process.argv[2] ?? join(tmpdir(), 'chatgpt-connect-preview'))
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'agent-app-chatgpt-consumer-'))
const run = (cmd, args, cwd = scratch) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
const packLog = run('npm', ['pack', '--json', '--pack-destination', scratch], root)
writeFileSync(join(output, 'pack.log'), packLog)
const pack = JSON.parse(packLog.slice(packLog.indexOf('[\n')))[0]
const archive = join(scratch, pack.filename)
writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
  '@tangle-network/agent-app': `file:${archive}`, '@tangle-network/chatgpt-agents-kit': '0.1.0',
  '@tangle-network/ui': '11.12.0', '@tangle-network/brand': '1.10.0', react: '19.2.8', 'react-dom': '19.2.8',
}, devDependencies: { typescript: '7.0.2', '@types/react': '19.2.18', '@types/react-dom': '19.2.5', esbuild: '0.28.1', 'axe-core': '4.11.1' } }, null, 2))
writeFileSync(join(output, 'consumer-install.log'), run('npm', ['install', '--no-audit', '--no-fund']))
cpSync(join(here, 'app.tsx'), join(scratch, 'app.tsx'))
writeFileSync(join(scratch, 'metadata.mjs'), `import { defineAgentAppMetadata } from '@tangle-network/chatgpt-agents-kit';
import { writeFileSync } from 'node:fs';
const apps = {};
for (const [key, displayName, description, agentId, workspaceId] of [
  ['gtm', 'GTM workspace', 'Work on account research and campaign tasks with your existing agent.', 'research-agent', 'gtm-workspace'],
  ['creative', 'Creative workspace', 'Continue creative briefs and review deliverables with your existing agent.', 'creative-agent', 'design-studio'],
]) {
  const endpoint = 'https://' + key + '.example.com/api/agents/mcp';
  apps[key] = { endpoint, app: defineAgentAppMetadata({ name: key + '-example', displayName, description }, endpoint),
    enrollment: { enrollmentId: 'example-' + key + '-enrollment', agentId, workspaceId, threadId: 'example-' + key + '-thread' } };
}
writeFileSync('config.json', JSON.stringify(apps, null, 2));`)
run(process.execPath, ['metadata.mjs'])
writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, resolveJsonModule: true, noEmit: true }, include: ['app.tsx'] }))
writeFileSync(join(output, 'consumer-typecheck.log'), run(join(scratch, 'node_modules/.bin/tsc'), []))
run(join(scratch, 'node_modules/.bin/esbuild'), ['app.tsx', '--bundle', '--format=esm', '--platform=browser', '--outdir=public', '--metafile=metafile.json', '--log-level=error'])
const bundle = JSON.parse(readFileSync(join(scratch, 'metafile.json'), 'utf8'))
const forbidden = Object.keys(bundle.inputs).filter(path => /agent-runtime|sandbox\/|app-oauth|agent-enrollment|node:/.test(path))
if (forbidden.length) throw Error('Browser bundle contains server modules: ' + forbidden.join(', '))
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to ChatGPT · installed examples</title><link rel="stylesheet" href="/app.css"><style>
body { margin:0; background:hsl(var(--background)); color:hsl(var(--foreground)); font-family:var(--font-sans,sans-serif); } header { border-bottom:1px solid hsl(var(--border)); padding:1.25rem 2rem; } main { max-width:52rem; margin:0 auto; padding:3rem 1.25rem; } h1 { font-size:clamp(1.75rem,5vw,2.5rem); line-height:1.1; letter-spacing:-.03em; margin:.75rem 0; } .example-label,.example-note,.example-intro { color:hsl(var(--muted-foreground)); font-size:.875rem; line-height:1.5; } .example-intro { margin-bottom:2rem; } .example-note { margin-top:1.25rem; } header svg { width:28px; height:28px; } header a,header div { color:inherit; } header>span,header>div { display:flex; align-items:center; gap:.75rem; }
</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`
writeFileSync(join(scratch, 'public/index.html'), html)
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const files = { '/app.js': ['app.js', 'application/javascript'], '/app.css': ['app.css', 'text/css'], '/axe.js': ['../node_modules/axe-core/axe.min.js', 'application/javascript'] }
  const [file, type] = files[path] ?? ['index.html', 'text/html']
  res.setHeader('Content-Type', type)
  res.end(readFileSync(join(scratch, 'public', file)))
})
const port = Number(process.env.CONNECT_PORT ?? 4401)
server.listen(port, '127.0.0.1', () => {
  const receipt = { sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), url: `http://127.0.0.1:${port}`, scratch, archive, archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    installedAppVersion: JSON.parse(readFileSync(join(scratch, 'node_modules/@tangle-network/agent-app/package.json'))).version,
    kitVersion: '0.1.0', browserInputs: Object.keys(bundle.inputs), serverModulesInBrowser: forbidden,
    proofScope: 'Two installed app configurations with kit metadata and native enrollment identity fixtures. No live ChatGPT connection or hosted installation.' }
  writeFileSync(join(output, 'installation.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ url: receipt.url, scratch, archiveSha256: receipt.archiveSha256 }))
})
