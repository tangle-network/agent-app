// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadComposerSelections,
  saveComposerSelections,
  type PersistedComposerSelections,
} from './composer-persistence'

const snapshot: PersistedComposerSelections = {
  v: 1,
  type: 'image',
  selectedModels: { image: 'gpt-image-2' },
  optionsByModel: { 'gpt-image-2': { size: '1024x1024', n: 2 } },
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('composer persistence', () => {
  it('loads a defensively checked snapshot and drops invalid map entries', () => {
    window.localStorage.setItem('studio-composer:ws-1', JSON.stringify({
      ...snapshot,
      selectedModels: { image: 'gpt-image-2', video: 42, avatar: 'ignored' },
      optionsByModel: {
        'gpt-image-2': { size: '1024x1024', n: 2, invalid: ['not primitive'] },
        broken: 'not an option map',
      },
    }))

    expect(loadComposerSelections('ws-1')).toEqual(snapshot)
  })

  it('returns null when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })

    expect(loadComposerSelections('ws-1')).toBeNull()
  })

  it('swallows a throwing localStorage.setItem', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() => saveComposerSelections('ws-1', snapshot)).not.toThrow()
  })
})
