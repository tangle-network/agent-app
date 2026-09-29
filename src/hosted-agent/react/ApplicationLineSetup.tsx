import { useMemo, useState } from 'react'
import { LineSetup } from './LineSetup'
import type { LineConnectInput, LineSetupClient, LineSetupProps } from './contracts'

export interface ApplicationLineConnectInput extends LineConnectInput {
  operatorAddress: string
  turnsPerDay: number
}
export interface ApplicationLineSetupClient extends Omit<LineSetupClient, 'connect'> {
  connect(input: ApplicationLineConnectInput): Promise<void>
}
export interface ApplicationLineSetupProps extends Omit<LineSetupProps, 'client' | 'canConnect'> {
  client: ApplicationLineSetupClient
  /** Disable new grants without preventing disconnection of an existing line. */
  enabled: boolean
}

/** Nominate a sender explicitly, then use the existing connection and disconnect UI. */
export function ApplicationLineSetup(props: ApplicationLineSetupProps) {
  return <ApplicationLineSetupScope key={props.scopeKey} {...props} />
}

function ApplicationLineSetupScope({ client, enabled, ...props }: ApplicationLineSetupProps) {
  const [operatorAddress, setAddress] = useState('')
  const [limit, setLimit] = useState('20')
  const [approved, setApproved] = useState<string | null>(null)
  const address = operatorAddress.trim()
  const turnsPerDay = Number(limit)
  const nomination = JSON.stringify({ address, turnsPerDay })
  const valid = address.length <= 320 && (/^\+[1-9]\d{6,14}$/.test(address) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    && Number.isSafeInteger(turnsPerDay) && turnsPerDay >= 1 && turnsPerDay <= 10_000
  const canConnect = props.canManage && enabled && valid && approved === nomination
  const lineClient = useMemo<LineSetupClient>(() => ({
    load: () => client.load(),
    disconnect: (id, expectedAttachmentId) => client.disconnect(id, expectedAttachmentId),
    connect: input => {
      if (!canConnect) throw new Error('Confirm the sender and daily limit before connecting')
      return client.connect({ ...input, operatorAddress: address, turnsPerDay })
    },
  }), [client, canConnect, address, turnsPerDay])
  return <>
    {props.canManage && <section className="tangle-lines tangle-lines--application" aria-label="Application access">
      <header className="tangle-lines__application-heading">
        <h2>Text your workspace</h2>
        <p>Continue a conversation from a number or mailbox you own. The agent keeps the same context and saved work.</p>
      </header>
      {!enabled ? <div className="tangle-lines__notice" role="status">
        <strong>New connections are disabled</strong>
        <p>You can still review and disconnect an existing line below.</p>
      </div> : <div className="tangle-lines__authorization">
        <div className="tangle-lines__authorization-heading">
          <h3>Authorize a sender</h3>
          <p>Only this sender can issue commands through the line you connect.</p>
        </div>
        <div className="tangle-lines__fields">
          <label>Authorized sender
            <input value={operatorAddress} onChange={e => { setAddress(e.target.value); setApproved(null) }}
              autoComplete="off" placeholder="+15550100001 or your Apple ID / email" />
          </label>
          <label>Maximum messages per day
            <input type="number" min={1} max={10_000} step={1} value={limit}
              onChange={e => { setLimit(e.target.value); setApproved(null) }} />
          </label>
        </div>
        <label className="tangle-lines__delegation">
          <input type="checkbox" checked={approved === nomination} disabled={!valid}
            onChange={e => setApproved(e.target.checked ? nomination : null)} />
          I authorize this sender to work in the conversation I select below using my application access and compute budget.
        </label>
        <p className="tangle-lines__fine-print">The daily message limit is not a dollar cap. The first inbound message establishes messaging consent.
          STOP stops replies, not an already accepted task; cancel that task in the application.</p>
      </div>}
    </section>}
    <LineSetup {...props} targetLabel={props.targetLabel ?? 'Conversation'} client={lineClient} canConnect={canConnect} showConnectionSetup={enabled} />
  </>
}
