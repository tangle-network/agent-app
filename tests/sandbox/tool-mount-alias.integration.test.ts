import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { buildSandboxToolFileMounts, sandboxToolBinDir } from '../../src/sandbox/app-tools'

/** The mounts written to a real filesystem and run by the real `/bin/sh` and `python3`, as a box runs a tool. */
it('runs one program under each alias name, and refuses a second copy of its bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-mount-alias-'))
  try {
    // A program that answers to several names and finds its siblings through realpath, as GTM's creative program does.
    const program = [
      '#!/usr/bin/env python3',
      'import os, sys',
      'print(os.path.basename(sys.argv[0]), os.path.dirname(os.path.realpath(sys.argv[0])), *sys.argv[1:])',
      '',
    ].join('\n')
    const options = { appName: 'alias-proof', baseDir: join(root, 'tools') }
    const mounts = buildSandboxToolFileMounts({ ...options, tools: [
      { name: 'render-ad', content: program },
      { name: 'render-video', aliasOf: 'render-ad' },
      { name: 'render-still', aliasOf: 'render-ad' },
    ] })
    for (const mount of mounts) {
      if (mount.resource.kind !== 'inline') throw new Error(`${mount.path} is not an inline mount`)
      mkdirSync(dirname(mount.path), { recursive: true })
      writeFileSync(mount.path, mount.resource.content)
      if (mount.executable) chmodSync(mount.path, 0o755)
    }
    expect(mounts.filter(mount => mount.resource.kind === 'inline' && mount.resource.content === program)).toHaveLength(1)

    const bin = sandboxToolBinDir(options)
    const programDir = realpathSync(bin)
    const run = (name: string) => execFileSync(join(bin, name), ['--size', '1080x1080'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TMPDIR: join(root, 'tmp') },
    }).trim()
    expect(run('render-ad')).toBe(`render-ad ${programDir} --size 1080x1080`)
    expect(run('render-video')).toBe(`render-video ${programDir} --size 1080x1080`)
    expect(run('render-still')).toBe(`render-still ${programDir} --size 1080x1080`)
    // A second call reuses the alias's link.
    expect(run('render-video')).toBe(`render-video ${programDir} --size 1080x1080`)

    // Five inline copies of one program are what made GTM's isolated profile 2 MB.
    const large = `#!/bin/sh\n${'#'.repeat(5_000)}\n`
    expect(() => buildSandboxToolFileMounts({ ...options, tools: [{ name: 'a', content: large }, { name: 'b', content: large }] }))
      .toThrow("declare b as { name: 'b', aliasOf: 'a' }")
    expect(() => buildSandboxToolFileMounts({ ...options, tools: [{ name: 'b', aliasOf: 'missing' }] }))
      .toThrow(/not an executable program in this call/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
