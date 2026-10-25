import { describe, expect, it } from 'vitest'
import { sandboxPromptExecutionOptions } from './prompt-options'

describe('sandboxPromptExecutionOptions', () => {
  it.each([undefined, 100, 0])('keeps total output inclusive of the reasoning subset (%s)', (reasoning) => {
    const options = sandboxPromptExecutionOptions({ maxOutputTokens: 321, ...(reasoning !== undefined ? { maxReasoningTokens: reasoning } : {}) }, 'high')
    expect(options.maxOutputTokens).toBe(321)
    expect(options.maxTotalOutputTokens).toBe(321)
    if (reasoning === undefined) expect(options).not.toHaveProperty('maxReasoningTokens')
    else if (reasoning === 0) {
      expect(options.effort).toBe('none')
      expect(options).not.toHaveProperty('maxReasoningTokens')
    } else expect(options.maxReasoningTokens).toBe(reasoning)
  })

  it('adds no token ceilings for an uncapped turn', () => {
    const options = sandboxPromptExecutionOptions(undefined, undefined)
    expect(options).not.toHaveProperty('maxOutputTokens')
    expect(options).not.toHaveProperty('maxTotalOutputTokens')
    expect(options).not.toHaveProperty('maxReasoningTokens')
  })
})
