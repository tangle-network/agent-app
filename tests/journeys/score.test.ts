import { describe, expect, it } from 'vitest'
import { DEFAULT_FAILURE_TEXT, DEFAULT_STOPPED_TEXT, scoreTurn, TurnEvidence, type TranscriptSnapshot } from '../../src/journeys/score'

const DEFAULTS = { failure: DEFAULT_FAILURE_TEXT, stopped: DEFAULT_STOPPED_TEXT }
/** GTM's own failure-card copy, as its journeys config adds it. */
const GTM = {
  failure: [...DEFAULT_FAILURE_TEXT, /stopped before finishing/i, /unable to connect to the sandbox/i],
  stopped: [...DEFAULT_STOPPED_TEXT, /You stopped this turn/i],
}

const snap = (lines: string[], extra: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot => ({ lines, failureNodes: [], retryButtons: 0, ...extra })

function judge(patterns: typeof DEFAULTS, prompt: string, before: TranscriptSnapshot, after: TranscriptSnapshot[], facts: { replyChars: number; timedOut?: boolean; stopPressed?: boolean }) {
  const evidence = new TurnEvidence(patterns, prompt)
  evidence.begin(before)
  for (const s of after) evidence.observe(s)
  return scoreTurn({ timedOut: facts.timedOut ?? false, evidence: evidence.added(), replyChars: facts.replyChars, stopPressed: facts.stopPressed ?? false })
}

// The visible text of the cards the 2026-10-11 GTM journeys recorded (critic frames
// j1-r3d-0318, j2-p1-0144, j3-d-0133). None carried role="alert"; each was scored "completed".
const PROMPT = 'Please update the saved plan.'
const STOPPED_BEFORE_FINISHING = [
  PROMPT,
  'Thanks—that resolves the baseline and fallback. I’ll update the plan to count 100 additional paid clinic acquisitions by Dec 31.',
  '7 tool runs · Ran 3 commands · 4 other steps',
  'The agent stopped before finishing.',
  'Your message and everything in this workspace are saved. Retry to run it again.',
  'Retry',
  'Show details',
]
const SANDBOX_UNREACHABLE = [
  PROMPT,
  "I'm unable to connect to the sandbox right now. Send your message again in a moment; if it keeps failing, share the support details with the team.",
  'Retry sending your message — sandbox provisioning can be transient.',
  'Retry',
  'Show details',
]
const USER_STOP = [
  PROMPT,
  'You stopped this turn.',
  'Your message and everything in this workspace are saved. Retry to run it again.',
  'Show details',
  'Request was interrupted by the user. Send a new message to continue.',
]

describe('scoreTurn on the six failed turns of 2026-10-11', () => {
  it('fails a mid-turn native failure even with no app copy configured, from the Retry control that appeared', () => {
    const v = judge(DEFAULTS, PROMPT, snap([PROMPT]), [snap(STOPPED_BEFORE_FINISHING, { retryButtons: 1 })], { replyChars: 255 })
    expect(v.outcome).toBe('failed')
    expect(v.error).toBe('a Retry control appeared in the transcript')
  })

  it('names the card line when the app declares its copy', () => {
    const v = judge(GTM, PROMPT, snap([PROMPT]), [snap(STOPPED_BEFORE_FINISHING, { retryButtons: 1 })], { replyChars: 255 })
    expect(v.outcome).toBe('failed')
    expect(v.error).toBe('The agent stopped before finishing.')
  })

  it('reads the typed code from a collapsed details panel', () => {
    const v = judge(DEFAULTS, PROMPT, snap([PROMPT]), [
      snap(STOPPED_BEFORE_FINISHING.filter((l) => l !== 'Retry'), {
        failureNodes: ['OpenCode prompt returned an invalid assistant message (APIError 401) | Code: sandbox.native_turn_failed'],
      }),
    ], { replyChars: 255 })
    expect(v.outcome).toBe('failed')
    expect(v.failures[0]).toContain('sandbox.native_turn_failed')
  })

  it('never completes a first turn that produced no reply text, card or not', () => {
    expect(judge(GTM, PROMPT, snap([]), [snap(SANDBOX_UNREACHABLE, { retryButtons: 1 })], { replyChars: 0 }).outcome).toBe('failed')
    const bare = judge(DEFAULTS, PROMPT, snap([]), [snap([PROMPT])], { replyChars: 0 })
    expect(bare.outcome).toBe('empty')
    expect(bare.error).toBe('the turn ended without any reply text')
  })

  it('scores a Stop as stopped from the runtime line, even with no Retry button', () => {
    expect(judge(DEFAULTS, PROMPT, snap([PROMPT]), [snap(USER_STOP)], { replyChars: 120 }).outcome).toBe('stopped')
    expect(judge(GTM, PROMPT, snap([PROMPT]), [snap(USER_STOP.slice(0, 4))], { replyChars: 120 }).error).toBe('You stopped this turn.')
  })

  it('scores a Stop the journey pressed as stopped, and a Stop that never took effect as timeout', () => {
    expect(judge(DEFAULTS, PROMPT, snap([]), [snap([PROMPT, 'partial answer'])], { replyChars: 14, stopPressed: true }).outcome).toBe('stopped')
    expect(judge(DEFAULTS, PROMPT, snap([]), [snap([PROMPT])], { replyChars: 14, stopPressed: true, timedOut: true }).outcome).toBe('timeout')
  })
})

describe('TurnEvidence counts only what the turn added', () => {
  it('does not fail a good turn because an earlier turn in the thread failed', () => {
    const before = snap(STOPPED_BEFORE_FINISHING, { retryButtons: 1 })
    const after = snap([...STOPPED_BEFORE_FINISHING, 'Follow up', 'Here is the revised plan.'], { retryButtons: 1 })
    const v = judge(GTM, 'Follow up', before, [after], { replyChars: 25 })
    expect(v).toEqual({ outcome: 'completed', error: null, failures: [] })
  })

  it('fails a Retry that replaced the old card with a new failure carrying the same words', () => {
    const card = snap(STOPPED_BEFORE_FINISHING, { retryButtons: 1 })
    const running = snap([PROMPT, 'Working…'])
    const v = judge(GTM, PROMPT, card, [running, card], { replyChars: 255 })
    expect(v.outcome).toBe('failed')
  })

  it('ignores failure words in the person’s own prompt', () => {
    const prompt = 'Why did my last run say "APIError 401"?'
    const v = judge(DEFAULTS, prompt, snap([]), [snap([prompt, 'A 401 means the key was refused.'])], { replyChars: 33 })
    expect(v.outcome).toBe('completed')
  })

  it('fails an error payload rendered where the reply belongs', () => {
    const v = judge(DEFAULTS, PROMPT, snap([]), [snap([PROMPT, 'Failed to connect to Sandbox API: ECONNREFUSED'])], { replyChars: 47 })
    expect(v.outcome).toBe('failed')
  })

  it('counts a new failure-marked element', () => {
    const v = judge(DEFAULTS, PROMPT, snap([], { failureNodes: ['Upload failed'] }), [
      snap([PROMPT, 'done'], { failureNodes: ['Upload failed', 'The model stream stopped before a clean completion.'] }),
    ], { replyChars: 4 })
    expect(v.outcome).toBe('failed')
    expect(v.failures).toEqual(['The model stream stopped before a clean completion.'])
  })
})

describe('scoreTurn ordering', () => {
  it('reports not-sent and timeout as themselves', () => {
    const none = { failures: [], stopped: [], retryAppeared: false }
    expect(scoreTurn({ notSent: 'no chat request', timedOut: false, evidence: none, replyChars: 0, stopPressed: false }).outcome).toBe('not-sent')
    expect(scoreTurn({ timedOut: true, evidence: none, replyChars: 900, stopPressed: false }).outcome).toBe('timeout')
  })
})
