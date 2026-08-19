// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Generation } from '../studio/generation'
import {
  formatClock,
  type StudioAudioElementLike,
  StudioPlaybackProvider,
  useStudioPlayback,
} from './studio-playback'

class FakeAudio implements StudioAudioElementLike {
  src = ''
  currentTime = 0
  duration = Number.NaN
  play = vi.fn<() => void>()
  pause = vi.fn<() => void>()
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

const generation = (id: string, result: string | null = `https://media.test/${id}.mp3`, durationSeconds = 10): Generation => ({
  id,
  type: 'speech',
  prompt: id,
  result,
  model: null,
  cost: null,
  createdAt: null,
  metadata: { durationSeconds },
})

function setup() {
  const audio = new FakeAudio()
  const createAudioElement = vi.fn(() => audio)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StudioPlaybackProvider createAudioElement={createAudioElement}>{children}</StudioPlaybackProvider>
  )
  return { audio, createAudioElement, ...renderHook(() => useStudioPlayback(), { wrapper }) }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('StudioPlaybackProvider', () => {
  it('uses one audio element when switching tracks and clears the previous node', () => {
    const { audio, createAudioElement, result } = setup()
    const nodeA = document.createElement('div')
    const nodeB = document.createElement('div')
    act(() => {
      result.current.registerPositionNode('a', nodeA)
      result.current.registerPositionNode('b', nodeB)
      result.current.play(generation('a'))
    })
    audio.currentTime = 4
    act(() => result.current.play(generation('b')))

    expect(createAudioElement).toHaveBeenCalledTimes(1)
    expect(audio.pause).not.toHaveBeenCalled()
    expect(audio.src).toBe('https://media.test/b.mp3')
    expect(result.current.activeId).toBe('b')
    expect(nodeA.style.getPropertyValue('--pos')).toBe('0')
    expect(nodeA.getAttribute('data-active')).toBeNull()
  })

  it('toggles the active track without resetting its position', () => {
    const { audio, result } = setup()
    const clip = generation('a')
    act(() => result.current.toggle(clip))
    audio.currentTime = 3.25
    act(() => result.current.toggle(clip))

    expect(result.current.playing).toBe(false)
    expect(audio.pause).toHaveBeenCalledTimes(1)
    expect(audio.currentTime).toBe(3.25)

    act(() => result.current.toggle(clip))
    expect(result.current.playing).toBe(true)
    expect(audio.currentTime).toBe(3.25)
    expect(audio.play).toHaveBeenCalledTimes(2)
  })

  it('shares a playing tile with a newly registered viewer node', () => {
    const { audio, createAudioElement, result } = setup()
    const tileNode = document.createElement('div')
    const viewerNode = document.createElement('div')
    act(() => {
      result.current.registerPositionNode('a', tileNode)
      result.current.play(generation('a'))
    })
    audio.currentTime = 4

    act(() => result.current.registerPositionNode('a', viewerNode))

    expect(audio.currentTime).toBe(4)
    expect(createAudioElement).toHaveBeenCalledTimes(1)
    expect(viewerNode.getAttribute('data-active')).toBe('true')
  })

  it('paints waveform position and elapsed time on animation frames', () => {
    let frame: FrameRequestCallback | null = null
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const { audio, result } = setup()
    const positionNode = document.createElement('div')
    const timeNode = document.createElement('span')
    act(() => {
      result.current.registerPositionNode('a', positionNode)
      result.current.registerTimeNode(timeNode)
      result.current.play(generation('a'))
    })
    audio.currentTime = 2.5

    act(() => frame?.(0))

    expect(positionNode.style.getPropertyValue('--pos')).toBe('0.2500')
    expect(timeNode.textContent).toBe('0:02')
    act(() => result.current.pause())
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('resets to the beginning and pauses when playback ends', () => {
    const { audio, result } = setup()
    const node = document.createElement('div')
    act(() => {
      result.current.registerPositionNode('a', node)
      result.current.play(generation('a'))
    })
    audio.currentTime = 9
    act(() => audio.emit('ended'))

    expect(result.current.playing).toBe(false)
    expect(result.current.activeId).toBe('a')
    expect(audio.currentTime).toBe(0)
    expect(node.style.getPropertyValue('--pos')).toBe('0')
  })

  it('stops playback and clears every registered node', () => {
    const { audio, result } = setup()
    const nodeA = document.createElement('div')
    const nodeB = document.createElement('div')
    act(() => {
      result.current.registerPositionNode('a', nodeA)
      result.current.registerPositionNode('b', nodeB)
      result.current.play(generation('a'))
    })
    audio.currentTime = 5
    act(() => result.current.stop())

    expect(result.current.activeId).toBeNull()
    expect(result.current.playing).toBe(false)
    for (const node of [nodeA, nodeB]) {
      expect(node.style.getPropertyValue('--pos')).toBe('0')
      expect(node.getAttribute('data-active')).toBeNull()
    }
  })

  it('adopts a fresh track on seek without playing it', () => {
    const { audio, result } = setup()
    const node = document.createElement('div')
    act(() => {
      result.current.registerPositionNode('a', node)
      result.current.seekTo(generation('a'), 4)
    })

    expect(result.current.activeId).toBe('a')
    expect(result.current.playing).toBe(false)
    expect(audio.currentTime).toBe(4)
    expect(audio.play).not.toHaveBeenCalled()
    expect(node.style.getPropertyValue('--pos')).toBe('0.4000')
    expect(node.getAttribute('data-active')).toBe('true')
  })

  it('clamps relative seeks to the active duration', () => {
    const { audio, result } = setup()
    act(() => result.current.seekTo(generation('a', undefined, 8), 6))
    act(() => result.current.seekBy(5))
    expect(audio.currentTime).toBe(8)

    act(() => result.current.seekBy(-15))
    expect(audio.currentTime).toBe(0)
  })

  it('uses loaded audio metadata when it becomes available', () => {
    const { audio, result } = setup()
    act(() => result.current.seekTo(generation('a', undefined, Number.NaN), 2))
    expect(result.current.durationSeconds).toBe(0)

    audio.duration = 12.5
    act(() => audio.emit('loadedmetadata'))
    expect(result.current.durationSeconds).toBe(12.5)
  })

  it('does nothing for a generation without a result', () => {
    const { createAudioElement, result } = setup()
    act(() => result.current.play(generation('a', null)))
    expect(createAudioElement).not.toHaveBeenCalled()
    expect(result.current.activeId).toBeNull()
  })

  it('throws a clear error outside the provider', () => {
    expect(() => renderHook(() => useStudioPlayback())).toThrow(
      'useStudioPlayback must be used within a StudioPlaybackProvider',
    )
  })
})

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [61, '1:01'],
    [599.9, '9:59'],
  ])('formats %s seconds as %s', (seconds, formatted) => {
    expect(formatClock(seconds)).toBe(formatted)
  })
})
