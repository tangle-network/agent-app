import { describe, expect, it } from 'vitest'
import { assembleSystemPrompt } from './index'

/** Stand-ins for the product-built strings that cross the seam. These mirror the
 *  shape gtm's `build-prompt.ts` produces: `base` is the persona + tools (+
 *  skills) block, `directive` is the always-on operating directive, and each
 *  section is either '' or a `\n\n## …`-prefixed string. */
const BASE = 'PERSONA SYSTEM PROMPT\n\n## Tools\n\nbash, curl, python3'
const DIRECTIVE = '## Drive results from message 0\nTake the lead.'

/** Pre-render the gtm-style sections the way the product's augment closure does,
 *  so the assembler only ever sees finished strings. */
function knownContextSection(lines: string[], board?: string): string {
  const boardBlock = board ? `## Board\n${board}` : ''
  return `\n\n## Known Context\n${lines.join('\n')}\n\n${boardBlock}`
}
function approvalSection(body: string): string {
  return `\n\n## Approval History\n${body}`
}
function questionsSection(lines: string[]): string {
  return `\n\n## Pending Questions for the User\n${lines.join('\n')}`
}
function newWorkspaceSection(): string {
  return '\n\n## New Workspace\nNo context configured yet.'
}

/** Narrow the typed outcome, failing loud if it did not succeed. */
function expectPrompt(result: ReturnType<typeof assembleSystemPrompt>): string {
  if (!result.succeeded) throw new Error(`expected success, got: ${result.error}`)
  return result.prompt
}

describe('assembleSystemPrompt — seam guard', () => {
  it('fails loud (typed outcome) on an empty base instead of emitting a roleless prompt', () => {
    const result = assembleSystemPrompt({ base: '', directive: DIRECTIVE })
    expect(result.succeeded).toBe(false)
    if (!result.succeeded) expect(result.error).toMatch(/base is empty/)
  })

  it('treats a whitespace-only base as empty', () => {
    const result = assembleSystemPrompt({ base: '   \n\t ', directive: DIRECTIVE })
    expect(result.succeeded).toBe(false)
  })
})

describe('assembleSystemPrompt — base + directive join', () => {
  it('joins base and directive with a single \\n\\n', () => {
    const prompt = expectPrompt(assembleSystemPrompt({ base: BASE, directive: DIRECTIVE }))
    expect(prompt).toBe(`${BASE}\n\n${DIRECTIVE}`)
  })

  it('suppresses the join when the directive is empty', () => {
    const prompt = expectPrompt(assembleSystemPrompt({ base: BASE, directive: '' }))
    expect(prompt).toBe(BASE)
  })
})

describe('assembleSystemPrompt — ordered section concatenation', () => {
  it('appends each section with no added separator (sections carry their own prefix)', () => {
    const sections = [
      knownContextSection(['Products: Acme', 'Channels: seo, ads'], 'open items: 3'),
      approvalSection('2 approved, 0 rejected'),
      questionsSection(['- [pricing] which tier?']),
    ]
    const prompt = expectPrompt(
      assembleSystemPrompt({ base: BASE, directive: DIRECTIVE, sections, trim: true }),
    )
    expect(prompt).toBe(`${BASE}\n\n${DIRECTIVE}${sections.join('')}`.trim())
  })

  it('drops absent sections (empty strings contribute nothing)', () => {
    const sections = ['', approvalSection('1 approved, 1 rejected'), '']
    const prompt = expectPrompt(
      assembleSystemPrompt({ base: BASE, directive: DIRECTIVE, sections }),
    )
    expect(prompt).toBe(`${BASE}\n\n${DIRECTIVE}\n\n## Approval History\n1 approved, 1 rejected`)
  })

  it('round-trips no sections to base + directive only', () => {
    const prompt = expectPrompt(
      assembleSystemPrompt({ base: BASE, directive: DIRECTIVE, sections: [] }),
    )
    expect(prompt).toBe(`${BASE}\n\n${DIRECTIVE}`)
  })
})

describe('assembleSystemPrompt — trim asymmetry preserved', () => {
  it('trims the result when trim: true (the hasContext branch behavior)', () => {
    const sections = [knownContextSection(['Products: Acme'])] // no board -> trailing \n\n
    const prompt = expectPrompt(
      assembleSystemPrompt({ base: BASE, directive: DIRECTIVE, sections, trim: true }),
    )
    expect(prompt.endsWith('\n')).toBe(false)
    expect(prompt).toBe(`${BASE}\n\n${DIRECTIVE}\n\n## Known Context\nProducts: Acme`)
  })

  it('does NOT trim when trim is unset (the new-workspace branch behavior)', () => {
    const sections = [newWorkspaceSection(), '\n\ntrailing ']
    const prompt = expectPrompt(
      assembleSystemPrompt({ base: BASE, directive: DIRECTIVE, sections }),
    )
    expect(prompt.endsWith('trailing ')).toBe(true)
  })
})

/**
 * Golden-string parity: the assembler must reproduce gtm's pre-lift
 * `buildSystemPrompt` output byte-for-byte. These goldens are computed with the
 * SAME template literals the pre-lift code used, then asserted against the
 * assembler's output for a populated config (hasContext, trimmed) and an empty
 * config (new-workspace, untrimmed).
 */
describe('assembleSystemPrompt — golden parity with pre-lift buildSystemPrompt', () => {
  const base = BASE
  const operatingDirective = DIRECTIVE

  it('hasContext branch: base + directive + Known Context (+ board) + approval + questions, trimmed', () => {
    const ctx = ['Primary objective: signups (target 1000)', 'Products: Acme', 'Channels: seo, ads']
    const boardSummary = 'open: 2, pending approval: 1'
    const approval = '\n\n## Approval History\nYour proposals have been: 3 approved, 1 rejected'
    const questions = '\n\n## Pending Questions for the User\n- [pricing] which tier first?'

    // Exactly the pre-lift hasContext return expression.
    const golden =
      `${base}\n\n${operatingDirective}\n\n## Known Context\n${ctx.join('\n')}\n\n${boardSummary ? `## Board\n${boardSummary}` : ''}${approval}${questions}`.trim()

    const sections = [
      `\n\n## Known Context\n${ctx.join('\n')}\n\n${boardSummary ? `## Board\n${boardSummary}` : ''}`,
      approval,
      questions,
    ]
    const prompt = expectPrompt(
      assembleSystemPrompt({ base, directive: operatingDirective, sections, trim: true }),
    )
    expect(prompt).toBe(golden)
  })

  it('new-workspace branch (no config): base + directive + New Workspace + artifact, NOT trimmed', () => {
    const newWorkspaceBody =
      '\n\n## New Workspace\nNo context yet. If the founder gave you a concrete task or a URL, act on it first.'
    const artifactSection = '\n\n## Active Artifact — Vault file: brief.md\nviewing now'

    // Exactly the pre-lift `!config` return expression (no trim).
    const golden = `${base}\n\n${operatingDirective}${newWorkspaceBody}${artifactSection}`

    const sections = [newWorkspaceBody, artifactSection]
    const prompt = expectPrompt(
      assembleSystemPrompt({ base, directive: operatingDirective, sections }),
    )
    expect(prompt).toBe(golden)
  })
})