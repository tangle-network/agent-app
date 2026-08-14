import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * `ChatComposer`'s send handlers stay assignable from the shapes that compiled
 * against the shipped `onSend?: (message: string) => void`.
 *
 * This is a COMPILE-time property, so it is checked by compiling — a runtime
 * assertion cannot see it, and a source scan asserting "the type says union"
 * would only restate the source. The rule being guarded is TypeScript's
 * return-type-`void` special case: a function returning anything is assignable
 * where `=> void` is expected, and that stops applying the moment the target
 * return type becomes a UNION containing `void`. So narrowing these props to
 * `ComposerSendResult` compiles clean here and breaks a pinned consumer's build
 * with no signal in this repo at all — the failure class this package's
 * additive-only contract exists to prevent.
 *
 * The shapes below are not hypothetical: an arrow whose expression body returns
 * a value (`(m) => rows.push(m)`) and an ai-sdk `append` (which resolves to
 * `Promise<string | null | undefined>`) are the two that a fleet product is
 * most likely to have written.
 *
 * To see it fail: change `onSend` / `onSendParts` in `src/web-react/chat-composer.tsx`
 * back to `(message: string) => ComposerSendResult` and re-run — TS2322 on the
 * legacy cases, which is what a consumer would have hit on `pnpm install`.
 */

const repoRoot = resolve(__dirname, '..', '..')
const composer = join(repoRoot, 'src', 'web-react', 'chat-composer')
const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc')

const workdir = mkdtempSync(join(tmpdir(), 'composer-send-compat-'))
afterAll(() => rmSync(workdir, { recursive: true, force: true }))

// Each case starts a fresh TypeScript process. Allow cold compiler startup on
// shared CI hosts without weakening the compile assertions.
const COMPILE_TEST_TIMEOUT_MS = 30_000

/** Compile `source` against the real component types; return tsc's diagnostics. */
function compile(name: string, source: string): { ok: boolean; output: string } {
  const file = join(workdir, `${name}.ts`)
  writeFileSync(file, source, 'utf8')
  try {
    execFileSync(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--jsx',
        'react-jsx',
        '--target',
        'es2022',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        file,
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { ok: true, output: '' }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

const preamble = `import type { ChatComposerProps } from ${JSON.stringify(composer)}\n`

describe('ChatComposer send handlers stay assignable from pre-outcome shapes', () => {
  const legacy: Array<[string, string]> = [
    ['a void statement body', 'const h: ChatComposerProps["onSend"] = (m: string) => { console.log(m) }'],
    ['an expression body returning a value', 'const h: ChatComposerProps["onSend"] = (m: string) => m.length'],
    [
      'an async handler resolving to a value',
      'const h: ChatComposerProps["onSend"] = (m: string) => Promise.resolve(m as string | null | undefined)',
    ],
    [
      'a parts handler with an expression body',
      'const h: ChatComposerProps["onSendParts"] = (m: string, p: unknown[]) => p.length + m.length',
    ],
  ]

  for (const [label, body] of legacy) {
    it(
      `accepts ${label}`,
      () => {
        const { ok, output } = compile(label.replace(/\W+/g, '-'), `${preamble}${body}\nexport { h }\n`)
        expect(output).not.toMatch(/TS2322/)
        expect(ok).toBe(true)
      },
      COMPILE_TEST_TIMEOUT_MS,
    )
  }

  it(
    'still accepts a handler that reports a rejection',
    () => {
      const { ok, output } = compile(
        'rejection',
        `${preamble}const h: ChatComposerProps["onSend"] = (m: string) => ({ ok: false as const, error: m })\nexport { h }\n`,
      )
      expect(output).toBe('')
      expect(ok).toBe(true)
    },
    COMPILE_TEST_TIMEOUT_MS,
  )

  it(
    'fails the compile when the fixture itself is wrong, so a green run means something',
    () => {
      const { ok, output } = compile(
        'negative-control',
        `${preamble}const h: ChatComposerProps["onSend"] = (m: number) => { console.log(m) }\nexport { h }\n`,
      )
      expect(ok).toBe(false)
      expect(output).toMatch(/TS2322/)
    },
    COMPILE_TEST_TIMEOUT_MS,
  )
})
