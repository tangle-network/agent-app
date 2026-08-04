import { describe, expect, it } from 'vitest'

import { buildAppToolOpenAITools } from '../../src/tools/index'
import { OPENUI_INPUT_KINDS, OPENUI_INTERACTIVE_AUTHORING_GUIDE } from '../../src/openui/index'

const TAXONOMY = { proposalTypes: ['outreach'], regulatedTypes: [] } as const

function renderUiDescription(tools: ReturnType<typeof buildAppToolOpenAITools>): string {
  const tool = tools.find((t) => t.function.name === 'render_ui')
  if (!tool) throw new Error('render_ui tool missing')
  return tool.function.description
}

describe('interactive-UI authoring guide', () => {
  it('leaves the shipped tool description byte-identical when not asked for', () => {
    const description = renderUiDescription(buildAppToolOpenAITools(TAXONOMY))
    expect(description).toBe(
      'Show a generated view live in the workspace. Validates the OpenUI JSON and persists the artifact. Executes immediately.',
    )
  })

  it('leaves a product description override byte-identical when not asked for', () => {
    const description = renderUiDescription(
      buildAppToolOpenAITools(TAXONOMY, { descriptions: { render_ui: 'Draw a chart.' } }),
    )
    expect(description).toBe('Draw a chart.')
  })

  it('appends the guide after the default description when asked for', () => {
    const description = renderUiDescription(buildAppToolOpenAITools(TAXONOMY, { interactiveUi: true }))
    expect(description.startsWith('Show a generated view live in the workspace.')).toBe(true)
    expect(description.endsWith(OPENUI_INTERACTIVE_AUTHORING_GUIDE)).toBe(true)
  })

  it('appends the guide after a product override too', () => {
    const description = renderUiDescription(
      buildAppToolOpenAITools(TAXONOMY, { interactiveUi: true, descriptions: { render_ui: 'Draw a chart.' } }),
    )
    expect(description.startsWith('Draw a chart.')).toBe(true)
    expect(description.endsWith(OPENUI_INTERACTIVE_AUTHORING_GUIDE)).toBe(true)
  })

  it('changes no other tool', () => {
    const plain = buildAppToolOpenAITools(TAXONOMY)
    const interactive = buildAppToolOpenAITools(TAXONOMY, { interactiveUi: true })
    expect(interactive.map((t) => t.function.name)).toEqual(plain.map((t) => t.function.name))
    for (const [index, tool] of interactive.entries()) {
      if (tool.function.name === 'render_ui') continue
      expect(tool).toEqual(plain[index])
    }
  })

  it('teaches every input kind the value checker knows', () => {
    for (const kind of OPENUI_INPUT_KINDS) {
      expect(OPENUI_INTERACTIVE_AUTHORING_GUIDE).toContain(`"${kind === 'text' ? 'input' : kind}"`)
    }
  })
})
