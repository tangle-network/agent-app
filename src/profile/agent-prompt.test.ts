import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { composeSkills } from '../skills/index'
import {
  captureModelInput,
  createMemoryModelInputStore,
  defaultQualitySkills,
  fingerprintAgentProfile,
  HUMAN_PROSE_SKILL_ID,
  humanProseSkill,
  LEARNED_GUIDANCE_SECTION_ID,
  MODEL_INPUT_RECORD_SCHEMA,
  modelInputBlob,
  OPERATING_CONTRACT_CLAUSES,
  OPERATING_CONTRACT_VERSION,
  parseSkillFrontmatter,
  readModelInput,
  renderAgentPrompt,
  renderOperatingContract,
  withDefaultQualitySkills,
  type AgentPromptInput,
  type ModelInputStore,
} from './index'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Digest of each contract version's default rendering. A wording change must
 *  bump OPERATING_CONTRACT_VERSION and add its digest here. */
const CONTRACT_DIGESTS: Record<number, string> = {
  1: '3a99743a19b6f00af5f7946bfe8afdaf03cd22c3545ff54aa20d2305027a5565',
}

const base: AgentPromptInput = {
  identity: 'You are the Example operator.',
  environment: '- **Vault**: the workspace files.',
}

describe('operating contract', () => {
  it('pins the default wording to its version', () => {
    expect(sha256(renderOperatingContract().text)).toBe(CONTRACT_DIGESTS[OPERATING_CONTRACT_VERSION])
  })

  it('renders every clause in order under one heading', () => {
    const contract = renderOperatingContract()
    expect(contract.text.startsWith('## Operating contract\n\n- ')).toBe(true)
    expect(contract.clauseIds).toEqual(OPERATING_CONTRACT_CLAUSES.map((clause) => clause.id))
    expect(contract.text).toContain('`Unverified: <claim>`')
    expect(contract.text).not.toContain('{unverified}')
  })

  it('omits clauses, substitutes the product label, and appends additions', () => {
    const contract = renderOperatingContract({
      omit: ['vault-memory', 'read-back'],
      unverifiedLabel: 'UNVERIFIED — confirm with [Agency]',
      additions: ['File every deliverable through `submit_proposal`.', '  '],
    })
    expect(contract.clauseIds).not.toContain('vault-memory')
    expect(contract.clauseIds).not.toContain('read-back')
    expect(contract.text).not.toContain('Workspace files are your memory')
    expect(contract.text).toContain('`UNVERIFIED — confirm with [Agency]`')
    expect(contract.text.endsWith('- File every deliverable through `submit_proposal`.')).toBe(true)
  })

  it('rejects an unknown omitted clause', () => {
    expect(() => renderOperatingContract({ omit: ['no-such-clause' as never] })).toThrow(/no-such-clause/)
  })
})

describe('renderAgentPrompt', () => {
  it('renders the sections in fixed order and joins them with a blank line', () => {
    const rendered = renderAgentPrompt({
      ...base,
      toolConventions: '- Inspect results.',
      skillIndex: '\n\n## Skills\n\n- human-prose: Write clearly. (read .opencode/skills/human-prose/SKILL.md)',
      standards: [{ id: 'standard', title: 'Operator standard', body: 'Hold the bar.' }],
      learnedGuidance: 'Lead with the number.',
      overlay: [{ id: 'workspace-config', title: 'Workspace configuration', body: 'Business: Acme' }],
    })
    expect(rendered.sections.map((section) => section.id)).toEqual([
      'identity',
      'operating-contract',
      'environment',
      'tool-conventions',
      'skills',
      'standard',
      LEARNED_GUIDANCE_SECTION_ID,
      'workspace-config',
    ])
    expect(rendered.prompt).toBe(rendered.sections.map((section) => section.text).join('\n\n'))
    expect(rendered.bytes).toBe(new TextEncoder().encode(rendered.prompt).byteLength)
    expect(rendered.contractVersion).toBe(OPERATING_CONTRACT_VERSION)
    expect(rendered.prompt.indexOf('## Domain guidance')).toBeLessThan(rendered.prompt.indexOf('### Operator standard'))
    expect(rendered.prompt.match(/## Domain guidance/g)).toHaveLength(1)
    expect(rendered.prompt.endsWith('## Workspace context\n\n### Workspace configuration\n\nBusiness: Acme')).toBe(true)
  })

  it('omits empty optional sections instead of rendering placeholders', () => {
    const rendered = renderAgentPrompt({ ...base, skillIndex: '', learnedGuidance: '<!-- none yet -->', overlay: [{ id: 'o', title: 'O', body: ' ' }] })
    expect(rendered.sections.map((section) => section.id)).toEqual(['identity', 'operating-contract', 'environment'])
    expect(rendered.prompt).not.toMatch(/No skills configured|No learned guidance|## Domain guidance|## Workspace context/)
  })

  it('falls back to the learned-guidance baseline and strips comments from a loaded body', () => {
    const fallback = renderAgentPrompt({ ...base, learnedGuidance: '<!-- placeholder -->', learnedGuidanceBaseline: 'Baseline rule.' })
    expect(fallback.sections.at(-1)?.text).toBe('## Domain guidance\n\n### Learned guidance\n\nBaseline rule.')
    const loaded = renderAgentPrompt({ ...base, learnedGuidance: '<!-- promoted 2026-10-07 -->\nPromoted rule.', learnedGuidanceBaseline: 'Baseline rule.' })
    expect(loaded.sections.at(-1)?.text).toBe('## Domain guidance\n\n### Learned guidance\n\nPromoted rule.')
  })

  it('heads a bare skill index', () => {
    const rendered = renderAgentPrompt({ ...base, skillIndex: '- a: b' })
    expect(rendered.sections.find((section) => section.id === 'skills')?.text).toBe('## Skills\n\n- a: b')
  })

  it('rejects duplicate section ids and an empty identity or environment', () => {
    expect(() =>
      renderAgentPrompt({ ...base, standards: [{ id: 'environment', title: 'X', body: 'y' }] }),
    ).toThrow(/duplicate section id "environment"/)
    expect(() => renderAgentPrompt({ ...base, identity: ' ' })).toThrow(/identity is empty/)
    expect(() => renderAgentPrompt({ ...base, environment: '' })).toThrow(/environment is empty/)
  })

  it('enforces a supplied budget', () => {
    const input = { ...base, standards: [{ id: 'big', title: 'Big', body: 'x'.repeat(2_000) }] }
    expect(() => renderAgentPrompt({ ...input, budget: { maxSystemPromptBytes: 1_000 } })).toThrow(/rendered agent prompt is \d+ bytes/)
    expect(renderAgentPrompt(input).bytes).toBeGreaterThan(2_000)
  })
})

describe('default quality skills', () => {
  it('mounts the shared human-prose skill with harness-valid frontmatter', () => {
    const [skill] = defaultQualitySkills()
    expect(skill?.id).toBe(HUMAN_PROSE_SKILL_ID)
    const { frontmatter, body } = parseSkillFrontmatter(skill?.skillMd ?? '')
    expect(frontmatter.name).toBe('human-prose')
    expect(frontmatter.description).toMatch(/structural tells/)
    expect(body).toContain('## The patterns to cut')
    expect(body).not.toContain('## Product vocabulary')
    const index = composeSkills({ skills: [skill!], mode: 'mounted', skillDir: '.opencode/skills' }).promptSection
    expect(index).toContain('(read .opencode/skills/human-prose/SKILL.md)')
  })

  it('adds product vocabulary and a mounted review skill', () => {
    const skill = humanProseSkill({
      bannedWords: ['leverage', 'seamless', 'leverage', ' '],
      preferredTerms: { 'AI-powered': 'name the capability' },
      reviewSkillId: 'humanizer',
    })
    expect(skill.skillMd).toContain('Do not use these in audience-facing prose: leverage, seamless.')
    expect(skill.skillMd).toContain('- "name the capability", not "AI-powered"')
    expect(skill.skillMd).toContain('`humanizer` skill')
    expect(skill.skillMd.trimEnd().endsWith('(github.com/hardikpandya/stop-slop).')).toBe(true)
  })

  it('refuses a product that still ships its own copy', () => {
    const copy = { ...humanProseSkill(), skillMd: 'old copy' }
    expect(() => withDefaultQualitySkills([copy])).toThrow(/human-prose duplicate a default quality skill/)
    const other = { ...humanProseSkill(), id: 'brand-voice' }
    expect(withDefaultQualitySkills([other]).map((skill) => skill.id)).toEqual(['brand-voice', 'human-prose'])
  })
})

describe('model input record', () => {
  it('addresses the system prompt by the same digest as the profile fingerprint', async () => {
    const prompt = renderAgentPrompt(base).prompt
    const blob = await modelInputBlob('system-prompt', prompt)
    const fingerprint = await fingerprintAgentProfile({ prompt: { systemPrompt: prompt } })
    expect(blob.digest).toBe(fingerprint.promptSha)
    expect(blob.digest).toBe(sha256(prompt))
  })

  it('stores each input once and records section digests', async () => {
    const store = createMemoryModelInputStore()
    const rendered = renderAgentPrompt({ ...base, learnedGuidance: 'Lead with the number.' })
    const plan = JSON.stringify({ files: [] })
    const first = await captureModelInput({ store, systemPrompt: rendered, inputs: [{ kind: 'workspace-plan', content: plan }], planDigest: 'plan-1', model: 'm', harness: 'opencode' })
    const second = await captureModelInput({ store, systemPrompt: rendered, inputs: [{ kind: 'workspace-plan', content: plan }], planDigest: 'plan-1', model: 'm', harness: 'opencode' })
    if (!first.succeeded || !second.succeeded) throw new Error('capture failed')
    expect(store.size).toBe(2)
    expect(first.value.digest).toBe(second.value.digest)
    expect(first.value.schema).toBe(MODEL_INPUT_RECORD_SCHEMA)
    expect(first.value.inputs.map((ref) => [ref.kind, ref.mediaType])).toEqual([
      ['system-prompt', 'text/markdown'],
      ['workspace-plan', 'application/json'],
    ])
    expect(first.value.inputs[0]).not.toHaveProperty('content')
    expect(first.value.sections.map((section) => section.id)).toEqual(rendered.sections.map((section) => section.id))
    expect(first.value.sections[0]?.digest).toBe(sha256(rendered.sections[0]!.text))
    expect(first.value.contractVersion).toBe(OPERATING_CONTRACT_VERSION)

    const read = await readModelInput(store, first.value.inputs[0]!)
    expect(read.succeeded && read.value.content).toBe(rendered.prompt)
  })

  it('returns a failure instead of a record when a blob is not stored', async () => {
    const refusing: ModelInputStore = {
      put: async () => ({ succeeded: false, error: 'bucket unavailable' }),
      get: async () => ({ succeeded: true, value: null }),
    }
    const outcome = await captureModelInput({ store: refusing, systemPrompt: 'prompt' })
    expect(outcome).toEqual({ succeeded: false, error: expect.stringContaining('bucket unavailable') })
    const throwing: ModelInputStore = {
      put: async () => {
        throw new Error('network down')
      },
      get: async () => ({ succeeded: true, value: null }),
    }
    expect(await captureModelInput({ store: throwing, systemPrompt: 'prompt' })).toEqual({
      succeeded: false,
      error: expect.stringContaining('network down'),
    })
  })

  it('detects a missing or altered blob on read', async () => {
    const store = createMemoryModelInputStore()
    const blob = await modelInputBlob('turn-context', 'context')
    expect((await readModelInput(store, blob)).succeeded).toBe(false)
    expect((await store.put({ ...blob, content: 'tampered' })).succeeded).toBe(false)
    const altered: ModelInputStore = {
      put: async () => ({ succeeded: true, value: undefined }),
      get: async () => ({ succeeded: true, value: { ...blob, content: 'tampered' } }),
    }
    expect(await readModelInput(altered, blob)).toEqual({ succeeded: false, error: expect.stringContaining('hashes to') })
  })
})
