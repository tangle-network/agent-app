import { describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_CONTRACT } from '../../src/journeys/config'
import { clickUntilSubmitted, composerText, createSubmissionTracker, routeSubmitPaths, settleText } from '../../src/journeys/send'

describe('createSubmissionTracker', () => {
  const tracker = () => createSubmissionTracker('https://app.example.com/app/ws/chat/new', DEFAULT_CHAT_CONTRACT.sendPaths)

  it('counts the route, its single-fetch form, and a chat POST at any depth under /api', () => {
    expect(routeSubmitPaths('/app/ws/chat/new')).toEqual(['/app/ws/chat/new', '/app/ws/chat/new.data'])
    expect(routeSubmitPaths('/chat/')).toEqual(['/chat/', '/chat/_.data'])
    const t = tracker()
    t.observe('POST', 'https://app.example.com/app/ws/chat/new.data')
    t.observe('POST', 'https://app.example.com/api/chat')
    t.observe('POST', 'https://app.example.com/api/sessions/abc/chat')
    expect(t.count).toBe(3)
  })

  it('ignores a GET, another origin, and a sibling route that only extends the path', () => {
    const t = tracker()
    t.observe('GET', 'https://app.example.com/api/chat')
    t.observe('POST', 'https://other.example.com/api/chat')
    t.observe('POST', 'https://app.example.com/app/ws/chat/new/extra')
    t.observe('POST', 'https://app.example.com/api/chat/running')
    expect(t.count).toBe(0)
  })
})

describe('clickUntilSubmitted', () => {
  it('stops pressing the moment the send lands', async () => {
    let landed = false
    let clicks = 0
    await clickUntilSubmitted({
      landed: () => landed,
      ready: async () => {},
      click: async () => {
        clicks += 1
        if (clicks === 2) landed = true
      },
      wait: async () => {},
      attempts: 10,
    })
    expect(clicks).toBe(2)
  })

  it('tolerates a press that fails because the accepted send tore the composer down', async () => {
    let landed = false
    await expect(clickUntilSubmitted({
      landed: () => landed,
      ready: async () => {},
      click: async () => {
        landed = true
        throw new Error('element detached')
      },
      wait: async () => {},
      attempts: 3,
    })).resolves.toBeUndefined()
  })

  it('surfaces a composer that never submits', async () => {
    await expect(clickUntilSubmitted({ landed: () => false, ready: async () => {}, click: async () => {}, wait: async () => {}, attempts: 3 }))
      .rejects.toThrow('refused 3 presses')
    await expect(clickUntilSubmitted({ landed: () => false, ready: async () => {}, click: async () => { throw new Error('no such button') }, wait: async () => {}, attempts: 3 }))
      .rejects.toThrow('no such button')
  })
})

describe('settleText', () => {
  it('returns once six reads in a row agree', async () => {
    const reads = ['a', 'ab', 'abc', 'abc', 'abc', 'abc', 'abc', 'abc', 'never']
    let i = 0
    expect(await settleText(async () => reads[i++]!, async () => {})).toBe('abc')
    expect(i).toBe(8)
  })
})

describe('composerText', () => {
  const box = (el: Record<string, unknown>) => ({ evaluate: async <R,>(fn: (el: Element) => R) => fn(el as unknown as Element) })

  it('reads a textarea or input by its value, which innerText never holds', async () => {
    await expect(composerText(box({ value: 'Summarize the claim file', innerText: '' }))).resolves.toBe('Summarize the claim file')
  })

  it('reads a contenteditable composer by its innerText', async () => {
    await expect(composerText(box({ innerText: 'Draft the reply', textContent: 'Draft the reply' }))).resolves.toBe('Draft the reply')
  })
})
