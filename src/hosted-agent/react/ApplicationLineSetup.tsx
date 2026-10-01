import { useEffect, useMemo, useState } from 'react'
import type { ApplicationSenderVerification, ApplicationSenderVerificationStart } from '../application-verification'
import { LineSetup } from './LineSetup'
import type { LineConnectInput, LineSetupClient, LineSetupProps } from './contracts'

export type { ApplicationSenderVerification, ApplicationSenderVerificationStart } from '../application-verification'

export interface ApplicationLineConnectInput extends LineConnectInput {
  senderVerificationId: string
  turnsPerDay: number
}

export interface ApplicationLineSetupClient extends Omit<LineSetupClient, 'connect'> {
  /** Host creates or finds the selected owned line, then starts TEST with its owner key. */
  startSenderVerification(input: LineConnectInput): Promise<ApplicationSenderVerificationStart>
  /** Host returns only public fields. approvedSender never reaches the browser. */
  getSenderVerification(lineId: string, testId: string): Promise<ApplicationSenderVerification>
  /** Host rechecks owner authority and consumes the proof during attach. */
  connect(input: ApplicationLineConnectInput): Promise<void>
}

export interface ApplicationLineSetupProps extends Omit<LineSetupProps, 'client' | 'canConnect' | 'connectPrerequisite'> {
  client: ApplicationLineSetupClient
  /** Disable new grants without preventing disconnection of an existing line. */
  enabled: boolean
}

function verificationError(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The phone test could not be checked. Try again.'
}

function draftKey(input: LineConnectInput): string {
  return JSON.stringify(input)
}

function expiry(value: string): number {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

/** Verify an owned handset before connecting its iMessage line to an application. */
export function ApplicationLineSetup(props: ApplicationLineSetupProps) {
  return <ApplicationLineSetupScope key={props.scopeKey} {...props} />
}

function ApplicationLineSetupScope({ client, enabled, ...props }: ApplicationLineSetupProps) {
  const [limit, setLimit] = useState('20')
  const [session, setSession] = useState<{
    draftKey: string
    start: ApplicationSenderVerificationStart
    status: ApplicationSenderVerification
  } | null>(null)
  const [pending, setPending] = useState<{ kind: 'start' | 'check'; draftKey: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsStatusRefresh, setNeedsStatusRefresh] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const turnsPerDay = Number(limit)
  const validLimit = Number.isSafeInteger(turnsPerDay) && turnsPerDay >= 1 && turnsPerDay <= 10_000

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  function activeFor(input: LineConnectInput) {
    return session?.draftKey === draftKey(input) ? session : null
  }

  function verifiedFor(input: LineConnectInput, time: number): boolean {
    const active = activeFor(input)
    return Boolean(active && !needsStatusRefresh && !pending && active.status.state === 'verified'
      && active.status.proof.signedInboundTestAt && active.status.proof.providerReplyAcknowledgedAt
      && active.status.proof.signedInboundConfirmAt && expiry(active.status.expiresAt) > time)
  }

  async function start(input: LineConnectInput) {
    const key = draftKey(input)
    if (!enabled || !props.canManage || !validLimit || pending || input.transport !== 'imessage') return
    setPending({ kind: 'start', draftKey: key })
    setError(null)
    setNeedsStatusRefresh(true)
    try {
      const result = await client.startSenderVerification(input)
      if (!result.lineId || !result.testId || !result.testText || result.state !== 'awaiting_test'
        || expiry(result.expiresAt) <= Date.now()) throw new Error('The phone test could not be started. Try again.')
      setSession({
        draftKey: key,
        start: result,
        status: {
          lineId: result.lineId, testId: result.testId, state: result.state, expiresAt: result.expiresAt,
          proof: { signedInboundTestAt: null, providerReplyAcknowledgedAt: null, signedInboundConfirmAt: null },
        },
      })
      setNow(Date.now())
    } catch (cause) {
      setError(verificationError(cause))
    } finally {
      setPending(null)
    }
  }

  async function check(active: NonNullable<typeof session>) {
    if (pending) return
    setPending({ kind: 'check', draftKey: active.draftKey })
    setError(null)
    setNeedsStatusRefresh(true)
    try {
      const result = await client.getSenderVerification(active.start.lineId, active.start.testId)
      if (result.lineId !== active.start.lineId || result.testId !== active.start.testId)
        throw new Error('The phone test changed. Start a new test.')
      // Copy only public fields even if a host accidentally returns an SDK owner read.
      const status: ApplicationSenderVerification = {
        lineId: result.lineId, testId: result.testId, state: result.state, expiresAt: result.expiresAt,
        proof: {
          signedInboundTestAt: result.proof.signedInboundTestAt,
          providerReplyAcknowledgedAt: result.proof.providerReplyAcknowledgedAt,
          signedInboundConfirmAt: result.proof.signedInboundConfirmAt,
        },
      }
      setSession(current => current?.start.testId === active.start.testId ? { ...current, status } : current)
      setNeedsStatusRefresh(false)
      setNow(Date.now())
    } catch (cause) {
      setError(verificationError(cause))
    } finally {
      setPending(null)
    }
  }

  const lineClient = useMemo<LineSetupClient>(() => ({
    async load() {
      const snapshot = await client.load()
      return {
        ...snapshot,
        connections: snapshot.connections?.map(connection => ({
          ...connection,
          identities: connection.providerId === 'inkbox'
            ? connection.identities.filter(identity => identity.transport === 'imessage') : [],
        })).filter(connection => connection.identities.length > 0) ?? null,
      }
    },
    disconnect: (id, expectedAttachmentId) => client.disconnect(id, expectedAttachmentId),
    async connect(input) {
      const active = activeFor(input)
      if (!enabled || !props.canManage || !validLimit || !verifiedFor(input, Date.now()) || !active)
        throw new Error('Verify the selected phone before connecting this line')
      try {
        await client.connect({ ...input, senderVerificationId: active.start.testId, turnsPerDay })
        setSession(null)
      } catch (cause) {
        setNeedsStatusRefresh(true)
        throw cause
      }
    },
  }), [client, enabled, props.canManage, session, turnsPerDay, validLimit, needsStatusRefresh, pending])

  function prerequisite(input: LineConnectInput) {
    const key = draftKey(input)
    const active = activeFor(input)
    const expired = Boolean(active && expiry(active.status.expiresAt) <= now)
    const verified = verifiedFor(input, now)
    const inProgress = active && !expired && ['awaiting_test', 'sending', 'challenge_sent'].includes(active.status.state)
    const busy = pending?.draftKey === key
    const canStart = enabled && props.canManage && validLimit && !pending && input.transport === 'imessage'
    const canCheck = Boolean((inProgress || active?.status.state === 'verified') && !pending)

    return {
      ready: validLimit && verified,
      content: <div className="tangle-lines__verification" aria-label="Phone verification">
        <h4>Verify your phone</h4>
        <p>Use the phone that will send commands to this line. Connection opens after that phone is verified.</p>
        {!validLimit && <p className="tangle-lines__warning">Enter a daily message limit from 1 to 10,000 first.</p>}
        {(!active || expired || ['consumed', 'cancelled', 'superseded', 'failed', 'expired'].includes(active.status.state))
          ? <>
            {active && <p role="status">This phone test can no longer connect the line. Start a new test.</p>}
            <button type="button" className="tangle-lines__secondary" disabled={!canStart}
              onClick={() => void start(input)}>{busy && pending?.kind === 'start' ? 'Starting test…' : 'Start phone test'}</button>
          </> : <>
            <p>Text this exact message to the selected line from your phone:</p>
            <code className="tangle-lines__test-text">{active.start.testText}</code>
            <p>Follow the private reply on your phone. No confirmation code is entered here.</p>
            <p className="tangle-lines__verification-expiry">Test expires at {new Date(active.status.expiresAt).toLocaleTimeString()}.</p>
            {verified && <p className="tangle-lines__verified" role="status">Phone verified. You can connect this line.</p>}
            <div className="tangle-lines__verification-actions">
              {!verified && <span role="status">{active.status.state === 'verified'
                ? 'Check verification again before connecting.'
                : active.status.state === 'challenge_sent'
                  ? 'Confirmation sent. Reply from the same phone, then check again.'
                  : active.status.state === 'sending' ? 'Sending confirmation…' : 'Waiting for your test message.'}</span>}
              <button type="button" className="tangle-lines__secondary" disabled={!canCheck}
                onClick={() => void check(active)}>{busy && pending?.kind === 'check' ? 'Checking…' : 'Check verification'}</button>
            </div>
          </>}
        {error && <p className="tangle-lines__verification-error" role="alert">{error}</p>}
      </div>,
    }
  }

  return <>
    {props.canManage && <section className="tangle-lines tangle-lines--application" aria-label="Application access">
      <header className="tangle-lines__application-heading">
        <h2>Text your workspace</h2>
        <p>Connect an owned Inkbox iMessage line to a conversation. Verify your phone before it can use application access and compute.</p>
      </header>
      {!enabled ? <div className="tangle-lines__notice" role="status">
        <strong>New connections are disabled</strong>
        <p>You can still review and disconnect an existing line below.</p>
      </div> : <div className="tangle-lines__authorization">
        <label className="tangle-lines__limit">Maximum messages per day
          <input type="number" min={1} max={10_000} step={1} value={limit}
            onChange={event => setLimit(event.target.value)} />
        </label>
        <p className="tangle-lines__fine-print">The message limit is not a dollar cap. STOP stops replies, not an already accepted task; cancel that task in the application.</p>
      </div>}
    </section>}
    <LineSetup {...props} targetLabel={props.targetLabel ?? 'Conversation'} client={lineClient}
      canConnect={props.canManage && enabled} showConnectionSetup={enabled}
      connectPrerequisite={prerequisite}
      setupDescription="Choose an owned Inkbox iMessage line and the conversation it will answer."
      emptyConnectionsMessage="Add an owned Inkbox iMessage handle in Hub, then" />
  </>
}
