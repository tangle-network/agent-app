import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/journeys/cli'

// An app that keeps each script at journeys/<id>/run.ts and runs the CLI from
// journeys/: the id names the script folder there, which has no video.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'journeys-frames-')))
const app = join(root, 'journeys')
const out = join(root, 'out')
mkdirSync(join(app, 'demo-flow'), { recursive: true })
writeFileSync(join(app, 'demo-flow', 'run.ts'), '')
writeFileSync(
  join(app, 'journeys.config.mjs'),
  "export default { app: 'demo', baseUrl: 'https://demo.example.com', identities: { owner: { emailEnv: 'DEMO_EMAIL', passwordEnv: 'DEMO_PASSWORD', signIn: 'password' } } }\n",
)

const cwd = process.cwd()
const env = { ...process.env }
afterEach(() => {
  process.chdir(cwd)
  process.env = { ...env }
  vi.restoreAllMocks()
})

async function frames(...args: string[]) {
  process.chdir(app)
  process.env.JOURNEYS_OUT = out
  process.env.JOURNEYS_STATE_DIR = join(root, 'state')
  const errors: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)))
  const code = await main(['frames', ...args])
  return { code, stderr: errors.join('\n') }
}

describe('agent-app-journeys frames', () => {
  it('exits 1 and names the folder it read when that folder has no video', async () => {
    const { code, stderr } = await frames('demo-flow', 'founder')
    expect(code).toBe(1)
    expect(stderr).toContain(`frames read ${join(app, 'demo-flow')}`)
    expect(stderr).toContain('video/founder-full.mp4')
    expect(stderr).toContain(join(out, 'demo-flow'))
  })

  it('exits 1 for an output folder whose recording is missing', async () => {
    mkdirSync(join(out, 'empty-run', 'video'), { recursive: true })
    const { code, stderr } = await frames(join(out, 'empty-run'), 'founder')
    expect(code).toBe(1)
    expect(stderr).toContain(`frames read ${join(out, 'empty-run')}`)
  })
})

process.on('exit', () => rmSync(root, { recursive: true, force: true }))
