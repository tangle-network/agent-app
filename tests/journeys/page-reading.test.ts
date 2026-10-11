// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promptHead, readChatPage } from '../../src/journeys/page-reading'
import { DEFAULT_FAILURE_TEXT, DEFAULT_STOPPED_TEXT, scoreTurn, TurnEvidence } from '../../src/journeys/score'

// jsdom has no layout, so no innerText: stand in one line per element, which is all these fixtures need.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement): string {
      if (this.children.length === 0) return this.textContent ?? ''
      return Array.from(this.childNodes).map((n) => (n instanceof HTMLElement ? n.innerText : (n.nodeValue ?? ''))).join('\n')
    },
  })
})
afterAll(() => {
  delete (HTMLElement.prototype as { innerText?: string }).innerText
})

const GTM = {
  failure: [...DEFAULT_FAILURE_TEXT, /stopped before finishing/i],
  stopped: [...DEFAULT_STOPPED_TEXT, /You stopped this turn/i],
}
const STOP_PROMPT = 'Write the full 30-day launch plan for Ledgerly, a bookkeeping app for solo accountants.'
const FOLLOW_UP = 'Thanks. Reply with one sentence: what is the single most important metric for week one?'
const STOP_CARD = '<div data-notice-tone="error"><p>You stopped this turn.</p><p>Retry to run it again.</p><button>Retry</button></div>'
const composer = (text = '') => `<div data-testid="composer-card"><div role="textbox" aria-label="Message input">${text}</div><button aria-label="Send">Send</button></div>`

function render(html: string): void {
  document.body.innerHTML = `<main id="main-content">${html}</main>`
}

function read(prompt: string | null) {
  return readChatPage({
    transcript: '#main-content', status: '[role="status"]', failureNodes: '[role="alert"], [data-notice-tone="error"]',
    retrySource: '^Retry$', retryFlags: '', assistant: '.reply', composer: '[data-testid="composer-card"]', stopName: 'Stop response',
    promptHead: prompt === null ? null : promptHead(prompt),
  })
}

describe('readChatPage reads a turn from after its own prompt', () => {
  it('does not stop a follow-up when the page re-renders the earlier stopped turn above it (GTM, 2026-10-11 19:23Z)', () => {
    // Live, after Stop: only the grey notice, and the follow-up typed in the composer.
    render(`<div>${STOP_PROMPT}</div><div role="status">Request was interrupted by the user. Send a new message to continue.</div>${composer(FOLLOW_UP)}`)
    const before = read(FOLLOW_UP)
    expect(before.anchored).toBe(false)
    // After Send: the stopped turn's red card and Retry render above the new message.
    const afterSend = `<div>${STOP_PROMPT}</div>${STOP_CARD}<div>${FOLLOW_UP}</div><div class="reply">Activated accounts in week one.</div>${composer()}`
    render(afterSend)
    const after = read(FOLLOW_UP)
    expect(after).toMatchObject({ anchored: true, failureNodes: [], retryButtons: 0, lines: ['Activated accounts in week one.'] })

    const evidence = new TurnEvidence(GTM, FOLLOW_UP)
    evidence.begin(before)
    evidence.observe(after)
    expect(scoreTurn({ timedOut: false, evidence: evidence.added(), replyChars: 31, stopPressed: false }).outcome).toBe('completed')

    // The same page read from the whole transcript is the defect this replaces.
    render(afterSend)
    const whole = new TurnEvidence(GTM, FOLLOW_UP)
    whole.begin(before)
    whole.observe(read(null))
    expect(scoreTurn({ timedOut: false, evidence: whole.added(), replyChars: 31, stopPressed: false }).outcome).toBe('stopped')
  })

  it('still fails the turn on a card after its prompt', () => {
    render(`<div>${STOP_PROMPT}</div><div>${FOLLOW_UP}</div><div data-notice-tone="error"><p>The agent stopped before finishing.</p><button>Retry</button></div>${composer()}`)
    const after = read(FOLLOW_UP)
    expect(after).toMatchObject({ anchored: true, retryButtons: 1 })
    // A floor taken from the whole transcript before the prompt showed does not hide a card after it.
    const evidence = new TurnEvidence(GTM, FOLLOW_UP)
    evidence.begin(read(null))
    evidence.observe(after)
    expect(scoreTurn({ timedOut: false, evidence: evidence.added(), replyChars: 0, stopPressed: false }).outcome).toBe('failed')
  })

  it('anchors on the person’s message, not on a reply that quotes it', () => {
    render(`<div>${FOLLOW_UP}</div><div role="alert">Upload failed</div><div class="reply">You asked: ${FOLLOW_UP}</div>${composer()}`)
    expect(read(FOLLOW_UP)).toMatchObject({ anchored: true, failureNodes: ['Upload failed'], lines: ['Upload failed', `You asked: ${FOLLOW_UP}`] })
  })

  it('reads the whole transcript when the page does not show the prompt', () => {
    render(`${STOP_CARD}<div class="reply">Done.</div>${composer()}`)
    expect(read(FOLLOW_UP)).toMatchObject({ anchored: false, failureNodes: ['You stopped this turn.Retry to run it again.Retry'], retryButtons: 1 })
  })
})

describe('promptHead', () => {
  it('is the first non-empty line, whitespace squashed, at most 48 characters', () => {
    expect(promptHead('\n  Research   the three competitors most likely to lose me deals\nand cite them')).toBe('Research the three competitors most likely to lo')
    expect(promptHead('  \n ')).toBeNull()
  })
})
