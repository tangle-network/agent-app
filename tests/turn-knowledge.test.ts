import { describe, expect, it } from 'vitest'
import { budgetTurnKnowledge, composeRouterTurnPrompt, turnKnowledgeInstructions, workspaceKnowledgeForTurn } from '../src/runtime/router-turn'

describe('turn knowledge', () => {
  it('keeps small files whole within the byte budget and lists the rest by name', () => {
    const files = budgetTurnKnowledge([
      { path: 'b.md', size: 30, text: 'b'.repeat(30) },
      { path: 'a.md', size: 20, text: 'a'.repeat(20) },
      { path: 'big.md', size: 9_000, text: 'x'.repeat(9_000) },
      { path: 'c.md', size: 40, text: 'c'.repeat(40) },
    ], { textBytes: 60 })
    expect(files.map(file => [file.path, file.text === null ? null : file.size])).toEqual([
      ['a.md', 20], ['b.md', 30], ['big.md', null], ['c.md', null],
    ])
  })

  it('puts the grounding rule, file text and the read tool for unshown files in the prompt', () => {
    const prompt = composeRouterTurnPrompt({ prompt: { systemPrompt: 'You are Pablo.' } }, {
      toolNames: ['workspace.knowledge.read'], context: ['Current time: noon.'],
      knowledge: { readTool: 'workspace.knowledge.read', files: [
        { path: 'house-rules.md', size: 21, text: 'Checkout is at 12 pm.' },
        { path: 'manual.md', size: 9_000, text: null },
      ] } })
    expect(prompt).toContain('Never give a typical or assumed value')
    expect(prompt).toContain('Knowledge file house-rules.md:\nCheckout is at 12 pm.')
    expect(prompt).toContain('Knowledge file manual.md (9000 bytes, text not shown): read it with workspace_knowledge_read')
    expect(prompt.indexOf('Checkout is at 12 pm.')).toBeLessThan(prompt.indexOf('Current time: noon.'))
  })

  it('names no tool when the app has none for reading files', () => {
    expect(turnKnowledgeInstructions([{ path: 'big.md', size: 9_000, text: null }]))
      .toEqual([expect.not.stringContaining('read it with'), 'Knowledge file big.md (9000 bytes, text not shown).'])
  })

  it('reads a workspace store\'s file entries and skips memory entries', async () => {
    const store = { list: async () => [
      { path: '/files/rules.md', kind: 'file', content: 'Quiet hours start at 9:30 pm.' },
      { path: '/files/menu.pdf', kind: 'file', bytes: { size: 120_000 } },
      { path: '/files/note', kind: 'fact', content: 'not a file' },
    ] }
    expect(await workspaceKnowledgeForTurn(store, 'ws')).toEqual([
      { path: '/files/menu.pdf', size: 120_000, text: null },
      { path: '/files/rules.md', size: 29, text: 'Quiet hours start at 9:30 pm.' },
    ])
  })
})
