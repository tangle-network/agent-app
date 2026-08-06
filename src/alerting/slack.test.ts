import { describe, expect, it } from 'vitest'
import { checkSlackCredential, postSlackAlert } from './slack'

/** A `fetch` that answers with one Slack API body per call, recording every request. */
function stubFetch(
  answers: Array<
    { json: unknown; status?: number; headers?: Record<string, string> } | { throws: string }
  >,
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let index = 0
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    // The last queued answer repeats, so a retry scenario declares only the
    // states it cares about.
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    if (!answer) throw new Error('stubFetch was called with no queued answer')
    if ('throws' in answer) throw new Error(answer.throws)
    return new Response(JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: answer.headers,
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const noSleep = async (): Promise<void> => {}

describe('postSlackAlert', () => {
  it('posts the alert and reports the resolved channel and message id', async () => {
    const { impl, calls } = stubFetch([{ json: { ok: true, channel: 'C0INFRA', ts: '1754.001' } }])

    const outcome = await postSlackAlert({
      token: 'xoxb-live',
      channel: '#infra-alerts',
      text: 'spend verification: 1 finding',
      fetchImpl: impl,
    })

    expect(outcome).toEqual({ delivered: true, channel: 'C0INFRA', ts: '1754.001' })
    const [call] = calls
    expect(call?.url).toBe('https://slack.com/api/chat.postMessage')
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      channel: '#infra-alerts',
      text: 'spend verification: 1 finding',
    })
  })

  it('carries the token in a header, never in the URL', async () => {
    const { impl, calls } = stubFetch([{ json: { ok: true, channel: 'C0INFRA', ts: '1' } }])

    await postSlackAlert({
      token: 'xoxb-secret',
      channel: '#infra-alerts',
      text: 'hi',
      fetchImpl: impl,
    })

    const [call] = calls
    expect(call?.url).not.toContain('xoxb-secret')
    expect((call?.init?.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-secret')
  })

  // The defect this module exists for: Slack answers HTTP 200 with the failure
  // inside the body, so a status-only check reads a revoked token as delivered.
  it('reads a dead credential out of an HTTP 200 body rather than calling it delivered', async () => {
    const { impl } = stubFetch([{ json: { ok: false, error: 'account_inactive' }, status: 200 }])

    const outcome = await postSlackAlert({
      token: 'xoxb-revoked',
      channel: '#infra-alerts',
      text: 'page',
      fetchImpl: impl,
      sleepImpl: noSleep,
    })

    expect(outcome.delivered).toBe(false)
    if (outcome.delivered) throw new Error('unreachable')
    expect(outcome.reason).toBe('credential')
    expect(outcome.detail).toContain('SLACK_BOT_TOKEN')
  })

  it('separates a bot that was never invited from a dead token', async () => {
    const { impl } = stubFetch([{ json: { ok: false, error: 'not_in_channel' } }])

    const outcome = await postSlackAlert({
      token: 'xoxb-live',
      channel: '#infra-alerts',
      text: 'page',
      fetchImpl: impl,
      sleepImpl: noSleep,
    })

    if (outcome.delivered) throw new Error('unreachable')
    expect(outcome.reason).toBe('channel')
    expect(outcome.detail).toContain('invite the bot to #infra-alerts')
  })

  it('does not retry a settled refusal — the answer cannot change', async () => {
    const { impl, calls } = stubFetch([{ json: { ok: false, error: 'invalid_auth' } }])

    await postSlackAlert({
      token: 'xoxb-dead',
      channel: '#infra-alerts',
      text: 'page',
      attempts: 3,
      fetchImpl: impl,
      sleepImpl: noSleep,
    })

    expect(calls).toHaveLength(1)
  })

  it('retries a 429 and delivers when Slack recovers', async () => {
    const { impl, calls } = stubFetch([
      { json: {}, status: 429, headers: { 'retry-after': '1' } },
      { json: { ok: true, channel: 'C0INFRA', ts: '2' } },
    ])

    const outcome = await postSlackAlert({
      token: 'xoxb-live',
      channel: '#infra-alerts',
      text: 'page',
      fetchImpl: impl,
      sleepImpl: noSleep,
    })

    expect(outcome.delivered).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('reports transport failure after exhausting attempts instead of throwing', async () => {
    const { impl, calls } = stubFetch([{ throws: 'ECONNREFUSED' }])

    const outcome = await postSlackAlert({
      token: 'xoxb-live',
      channel: '#infra-alerts',
      text: 'page',
      attempts: 2,
      fetchImpl: impl,
      sleepImpl: noSleep,
    })

    if (outcome.delivered) throw new Error('unreachable')
    expect(outcome.reason).toBe('transport')
    expect(calls).toHaveLength(2)
  })

  // A product that has not adopted Slack must not have a failing alert path.
  it('treats an absent token or channel as configuration, not an incident', async () => {
    const { impl, calls } = stubFetch([{ json: { ok: true } }])

    const noToken = await postSlackAlert({
      token: undefined,
      channel: '#infra-alerts',
      text: 'x',
      fetchImpl: impl,
    })
    const noChannel = await postSlackAlert({
      token: 'xoxb-live',
      channel: '   ',
      text: 'x',
      fetchImpl: impl,
    })

    if (noToken.delivered || noChannel.delivered) throw new Error('unreachable')
    expect(noToken.reason).toBe('not-configured')
    expect(noChannel.reason).toBe('not-configured')
    expect(calls).toHaveLength(0)
  })
})

describe('checkSlackCredential', () => {
  it('confirms a live token without posting a message', async () => {
    const { impl, calls } = stubFetch([{ json: { ok: true, team: 'Tangle', bot_id: 'B01' } }])

    const verdict = await checkSlackCredential({ token: 'xoxb-live', fetchImpl: impl })

    expect(verdict).toEqual({ live: true, team: 'Tangle', botId: 'B01' })
    expect(calls[0]?.url).toBe('https://slack.com/api/auth.test')
    expect(calls.some((call) => call.url.includes('chat.postMessage'))).toBe(false)
  })

  it('reports a revoked app as a dead credential', async () => {
    const { impl } = stubFetch([{ json: { ok: false, error: 'account_inactive' } }])

    const verdict = await checkSlackCredential({ token: 'xoxb-revoked', fetchImpl: impl })

    expect(verdict.live).toBe(false)
    if (verdict.live) throw new Error('unreachable')
    expect(verdict.reason).toBe('credential')
  })

  it('does not call an unconfigured token dead — there is nothing to rotate', async () => {
    const verdict = await checkSlackCredential({ token: '' })

    if (verdict.live) throw new Error('unreachable')
    expect(verdict.reason).toBe('not-configured')
  })
})
