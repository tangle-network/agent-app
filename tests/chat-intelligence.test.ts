import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('shared consumed-stream observation', () => {
  it('preserves native iterator behavior through the built public entrypoint', () => {
    const output = execFileSync(process.execPath, ['scripts/prove-chat-intelligence.mjs'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    const report = JSON.parse(output) as { tests: number; passed: number; failed: number }
    expect(report.tests).toBeGreaterThan(0)
    expect(report.failed).toBe(0)
    expect(report.passed).toBe(report.tests)
  })
})
