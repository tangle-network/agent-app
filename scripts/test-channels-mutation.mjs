import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const file = new URL('../src/channels/hooks.ts', import.meta.url)
const original = readFileSync(file, 'utf8')
const guard = "      if (test.status !== 'verified') throw new Error('Verify inbound delivery and the test reply before activation.')"
if (original.split(guard).length !== 2) throw new Error('Expected exactly one activation guard to mutate.')
const dir = mkdtempSync(join(tmpdir(), 'channels-mutation-'))
const report = join(dir, 'tests.json')
const testName = 'refuses activation until both directions are verified'
function run() {
  const result = spawnSync('pnpm', ['test', 'tests/channels/hooks.test.tsx', '-t', testName, '--reporter=json', `--outputFile=${report}`], { encoding: 'utf8' })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  const json = JSON.parse(readFileSync(report, 'utf8'))
  const assertions = json.testResults.flatMap(suite => suite.assertionResults).filter(test => test.title === testName)
  if (assertions.length !== 1) throw new Error('The protected hook test did not execute exactly once.')
  return { code: result.status, assertion: assertions[0] }
}
try {
  writeFileSync(file, original.replace(guard, '      // Counterfactual: early activation allowed.'))
  const mutant = run()
  if (mutant.code === 0 || mutant.assertion.status !== 'failed') throw new Error('The hook test failed to detect early activation.')
  console.log('Mutation detected: removing the activation guard fails its hook test.')
} finally {
  writeFileSync(file, original)
}
try {
  const restored = run()
  if (restored.code !== 0 || restored.assertion.status !== 'passed') throw new Error('Restored activation guard did not pass.')
  console.log('Restored source: activation hook test passes.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
