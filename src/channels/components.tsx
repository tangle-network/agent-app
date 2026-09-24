import { useEffect, useId, useState } from 'react'
import { useChannelsClient } from './context'
import { useChannel, useChannelConnections, useChannelConversation, useChannelConversations, useChannels, useConnectChannel, useWhatsAppNumbers, verificationExpired } from './hooks'
import { NUMBER_CHARGE_NOTICE, NUMBER_RETRY_NOTICE, numberStage, useNumberChannel } from './numbers'
import type { Line, LineTransport } from './types'
import { ChannelFailure, ChannelState, buttonClass, inputClass, panelClass } from './ui'

const labels: Record<LineTransport, string> = { imessage: 'iMessage', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }

/** User-facing deep links, not provider API calls. Invalid addresses render as text only. */
export function channelMessageLink(line: Line, instruction: string): string | null {
  if (line.transport === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line.address)) return null
    return `mailto:${encodeURIComponent(line.address)}?subject=Channel%20test&body=${encodeURIComponent(instruction)}`
  }
  const address = line.routerAddress ?? line.address
  if (!/^\+[1-9]\d{7,14}$/.test(address)) return null
  if (line.transport === 'whatsapp') return `https://wa.me/${address.slice(1)}?text=${encodeURIComponent(instruction)}`
  return `sms:${address}?body=${encodeURIComponent(line.connect ?? instruction)}`
}

function CopyLine({ text }: { text: string }) {
  const [message, setMessage] = useState('')
  return <div className="space-y-2"><div className="flex items-start gap-2 rounded-md bg-muted p-3">
    <code className="min-w-0 flex-1 break-all">{text}</code>
    <button type="button" className={buttonClass} aria-label={`Copy ${text}`} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setMessage('Copied') }
      catch { setMessage('Copy is unavailable. Select and copy the displayed text.') }
    }}>Copy</button>
  </div>{message && <p role="status" className="text-sm">{message}</p>}</div>
}

/** Delivery evidence comes exclusively from the host. An acquired line is not proof. */
export function ChannelVerificationPanel({ lineId, className = '' }: { lineId: string; className?: string }) {
  const channel = useChannel(lineId)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setConfirming(false), [lineId])
  const busy = channel.state.status === 'pending'
  const act = (action: 'start' | 'resume' | 'send' | 'activate') => void channel.run({ action })
  return <section className={`${panelClass} ${className}`} aria-label="Channel verification" aria-busy={busy}>
    <h2 className="text-lg font-semibold">Verify this channel</h2>
    <ChannelState resource={channel.resource} empty="The channel is unavailable.">{({ line, verification: test }) => {
      const expired = test ? verificationExpired(test) : false
      const active = line.status === 'active' && line.attachment?.status === 'active'
      const link = test ? channelMessageLink(line, test.instruction) : null
      return <>
        <p className="font-medium">{labels[line.transport]} · {line.address}</p>
        {line.status !== 'active' ? <p role="alert">This line is {line.status}. Check the line’s status before testing or activating it.</p>
          : active && test?.status === 'verified' ? <p role="status">Both directions verified. Answering {labels[line.transport]} messages.</p>
          : !test || test.status === 'revoked' ? <>
            {active && <p>Attached to an agent, but no completed delivery test was returned.</p>}
            <p>Test inbound delivery and a reply before this agent answers people.</p>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => act('start')}>Start channel test</button>
          </> : expired ? <p role="alert">This test expired. Stop it before starting a new test.</p>
          : test.status === 'verified' ? <><p>Both directions verified. Messaging is not turned on yet.</p>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => act('activate')}>Turn on messaging</button></>
          : test.status === 'configuring' ? <><p>Connecting incoming messages to Tangle.</p>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => act('resume')}>Check setup</button></>
          : test.status === 'waiting' ? <>
            {line.connect && line.routerAddress && <><p>First, send this to {line.routerAddress}. The router replies with your agent’s number.</p><CopyLine text={line.connect} /></>}
            <p>{line.transport === 'email' ? `From another email address, send this line to ${line.address}.` : line.connect ? 'Then send this in the conversation the router opens:' : `From your phone, send this to ${line.address}:`}</p>
            <CopyLine text={test.instruction} />
            {link && <a className={buttonClass} href={link} target={line.transport === 'whatsapp' ? '_blank' : undefined} rel="noopener noreferrer">Open {line.transport === 'email' ? 'Email' : line.transport === 'whatsapp' ? 'WhatsApp' : 'Messages'}</a>}
          </> : test.status === 'received' ? <><p role="status">Your test message arrived.</p><button type="button" className={buttonClass} disabled={busy} onClick={() => act('send')}>Send test reply</button></>
          : test.status === 'sending' ? <p role="status">The test reply is being sent. Do not send another.</p>
          : test.status === 'uncertain' ? <><p role="alert">The reply result is uncertain. Check its status instead of sending another.</p><button type="button" className={buttonClass} disabled={busy} onClick={() => act('resume')}>Check reply status</button></>
          : test.status === 'needs_review' ? <p role="alert">Incoming message setup needs operator review. No delivery success is claimed.</p>
          : <p>Reply with the CONFIRM line in the message you received, in the same conversation.</p>}
        {test?.error && <p role="alert" className="text-destructive">{test.error}</p>}
        {test && test.status !== 'revoked' && !(active && test.status === 'verified') && <>
          {!confirming ? <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming(true)}>Stop this test</button> : <fieldset className="space-y-2"><legend>Stop this test and revoke its setup?</legend>
            <button type="button" className={buttonClass} disabled={busy} onClick={async () => { const outcome = await channel.run({ action: 'reset', confirm: true }); if (outcome.succeeded) setConfirming(false) }}>Confirm stop</button>{' '}
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming(false)}>Keep testing</button>
          </fieldset>}
        </>}
        <button type="button" className={buttonClass} disabled={busy} onClick={channel.resource.retry}>Refresh channel status</button>
      </>
    }}</ChannelState>
    <ChannelFailure state={channel.state} />
  </section>
}

function ConnectionPicker({ transport, onConnected }: { transport: Exclude<LineTransport, 'sms'>; onConnected: (line: Line) => void }) {
  const client = useChannelsClient()
  const connections = useChannelConnections(transport)
  const [connectionId, setConnectionId] = useState('')
  const [numberId, setNumberId] = useState('')
  const [address, setAddress] = useState('')
  const [showNumbers, setShowNumbers] = useState(false)
  const numbers = useWhatsAppNumbers(showNumbers ? connectionId : '')
  const connect = useConnectChannel(onConnected)
  const busy = connect.state.status === 'pending'
  useEffect(() => { setConnectionId(''); setNumberId(''); setShowNumbers(false); setAddress('') }, [client, transport])
  useEffect(() => {
    if (connections.status === 'ready' && connections.value.length === 1) setConnectionId(connections.value[0]!.id)
  }, [connections])
  useEffect(() => {
    if (numbers.status === 'ready' && numbers.value.length === 1) setNumberId(numbers.value[0]!.id)
  }, [numbers])
  return <>
    <ChannelState resource={connections} empty="No eligible Hub connections. Connect an identity in your app’s Integrations first.">{items => <form className="space-y-4" onSubmit={event => {
      event.preventDefault()
      if (transport === 'email') void connect.run({ kind: 'email', connectionId, address })
      else if (transport === 'whatsapp') void connect.run({ kind: 'connection', input: { transport, connectionId, phoneNumberId: numberId } })
      else void connect.run({ kind: 'connection', input: { transport, connectionId } })
    }}>
      <label className="block">Connection<select className={inputClass} value={connectionId} disabled={busy} onChange={event => { setConnectionId(event.target.value); setNumberId(''); setShowNumbers(false) }} required>
        <option value="">Choose a connection</option>{items.map(item => <option key={item.id} value={item.id}>{item.account ?? item.displayName}</option>)}
      </select></label>
      {transport === 'email' && <label className="block">Mailbox address<input className={inputClass} type="email" required value={address} disabled={busy} onChange={event => setAddress(event.target.value)} placeholder="hello@example.com" /></label>}
      {transport === 'whatsapp' && <>
        <button type="button" className={buttonClass} disabled={!connectionId || busy} onClick={() => { setShowNumbers(true); numbers.retry() }}>Show owned numbers</button>
        {showNumbers && <ChannelState resource={numbers} empty="This connection has no eligible WhatsApp numbers.">{owned => <label className="block">WhatsApp number<select className={inputClass} required value={numberId} disabled={busy} onChange={event => setNumberId(event.target.value)}>
          <option value="">Choose a number</option>{owned.map(number => <option key={number.id} value={number.id}>{number.address}</option>)}
        </select></label>}</ChannelState>}
      </>}
      <p className="text-sm text-muted-foreground">Connect an owned line, then test both directions. Each person must message first. Permissions remain managed in Tangle Hub.</p>
      <button type="submit" className={buttonClass} disabled={busy || !connectionId || (transport === 'email' && !address.trim()) || (transport === 'whatsapp' && (!numberId || !showNumbers || numbers.status !== 'ready'))}>{busy ? 'Connecting…' : 'Connect channel'}</button>
    </form>}</ChannelState>
    <ChannelFailure state={connect.state} />
  </>
}

export interface ChannelConnectProps { transport: LineTransport; initialLineId?: string; className?: string }

/** Select an existing line or connect an owned source, then verify it. */
export function ChannelConnect({ transport, initialLineId = '', className = '' }: ChannelConnectProps) {
  const [selected, setSelected] = useState(initialLineId)
  const lines = useChannels()
  const id = useId()
  useEffect(() => setSelected(initialLineId), [transport, initialLineId])
  return <div className={`space-y-4 ${className}`}>
    <section className={panelClass} aria-label={`${labels[transport]} channel`}>
      <h2 className="text-lg font-semibold">Connect {labels[transport]}</h2>
      {transport === 'imessage' && <p>Use a free shared iMessage identity, or acquire a dedicated number. A shared identity requires a connect message to the router first.</p>}
      <ChannelState resource={lines} empty="No lines connected to this agent yet.">{all => {
        const matching = all.filter(line => line.transport === transport && line.status !== 'released')
        return matching.length ? <><label htmlFor={id}>Existing line</label><select id={id} className={inputClass} value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">Choose or connect a line</option>{matching.map(line => <option value={line.id} key={line.id}>{line.label ?? line.address}</option>)}
        </select></> : <p>No {labels[transport]} lines connected yet.</p>
      }}</ChannelState>
      {!selected && transport !== 'sms' && <ConnectionPicker key={transport} transport={transport} onConnected={line => { setSelected(line.id); lines.retry() }} />}
      {selected && <button type="button" className={buttonClass} onClick={() => setSelected('')}>Choose another line</button>}
    </section>
    {selected ? <ChannelVerificationPanel key={selected} lineId={selected} /> : (transport === 'sms' || transport === 'imessage') && <NumberChannel transport={transport} />}
  </div>
}

type TransportPanelProps = Omit<ChannelConnectProps, 'transport'>
export function IMessageChannel(props: TransportPanelProps) { return <ChannelConnect {...props} transport="imessage" /> }
export function WhatsAppChannel(props: TransportPanelProps) { return <ChannelConnect {...props} transport="whatsapp" /> }
export function EmailChannel(props: TransportPanelProps) { return <ChannelConnect {...props} transport="email" /> }
export function SMSChannel(props: TransportPanelProps) { return <ChannelConnect {...props} transport="sms" /> }

/** A transport's managed number activation, with explicit consent and cancellation. */
export function NumberChannel({ transport, className = '' }: { transport: 'sms' | 'imessage'; className?: string }) {
  const client = useChannelsClient()
  const number = useNumberChannel(transport)
  const [consent, setConsent] = useState(false)
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [lineId, setLineId] = useState('')
  const connect = useConnectChannel(line => setLineId(line.id))
  useEffect(() => { setConsent(false) }, [number.quote?.token])
  useEffect(() => { setCancelId(null); setLineId('') }, [transport, client])
  const busy = number.state.status === 'pending' || connect.state.status === 'pending'
  const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
  return <section className={`${panelClass} ${className}`} aria-label={`${labels[transport]} number`} aria-busy={busy}>
    <h2 className="text-lg font-semibold">Get an {labels[transport]} number</h2>
    {!client.ordering ? <p>Number ordering is unavailable. Existing numbers are unchanged.</p> : <ChannelState resource={number.resource} empty="Number availability has not been confirmed.">{({ readiness, complete }) => <>
      {!readiness.configured && <p>New orders are disabled. Existing numbers still require separate cancellation.</p>}
      {!complete && <p role="alert">The order list is incomplete. New purchases are disabled until ownership can be confirmed.</p>}
      {number.held && <p>This agent already holds an order for this transport. Cancel and release it before ordering another.</p>}
      <button type="button" className={buttonClass} disabled={busy || !complete || !readiness.configured || !readiness.transports.includes(transport) || !!number.held || number.uncertain} onClick={() => void number.run({ action: 'quote' })}>See activation price</button>
    </>}</ChannelState>}
    {number.quote && <div className="space-y-3 rounded-md border border-border p-4">
      <h3 className="font-medium">Activation · {money(number.quote.activationCents)}</h3>
      <p className="whitespace-pre-wrap">{number.quote.terms || 'Published activation terms are missing. Ordering is disabled.'}</p>
      <p>{NUMBER_CHARGE_NOTICE}</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />I authorize this one-time activation charge. The number is not live until channel setup is complete.</label>
      {!number.uncertain && number.quote.expiresAt <= Date.now() && <p role="alert">This quote expired. Read a new activation price before ordering.</p>}
      <button type="button" className={buttonClass} disabled={busy || !consent || !number.quote.terms.trim() || (!number.uncertain && number.quote.expiresAt <= Date.now())} onClick={() => void number.run({ action: 'purchase', consent })}>{number.uncertain ? 'Retry approved purchase' : `Order for ${money(number.quote.activationCents)}`}</button>
    </div>}
    {number.uncertain && <p role="alert">The purchase response was lost or refused. Its outcome is not confirmed. {NUMBER_RETRY_NOTICE}</p>}
    {number.orders.map(order => <article key={order.id} className="space-y-3 rounded-md border border-border p-4">
      <h3 className="font-medium">{order.address ?? 'Your number order'}</h3><p>{numberStage(order)}</p>
      {order.errorCode && <p role="status">Status: {order.errorCode.replace(/_/g, ' ')}</p>}
      {order.status === 'ready_for_setup' && order.cancellation === 'none' && <><p>The number is acquired, not delivery-verified. Test it before connecting conversations.</p>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void connect.run({ kind: 'order', orderId: order.id })}>Test this number</button></>}
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void number.run({ action: 'advance', orderId: order.id })}>Check progress</button>{' '}
      {order.cancellation === 'none' && (cancelId !== order.id ? <button type="button" className={buttonClass} disabled={busy} onClick={() => setCancelId(order.id)}>Cancel number</button> : <fieldset className="space-y-2"><legend>Cancel this number? Access will be removed. Paid activation is not automatically refunded.</legend>
        <button type="button" className={buttonClass} disabled={busy} onClick={async () => { const result = await number.run({ action: 'cancel', orderId: order.id, confirm: true }); if (result.succeeded) setCancelId(null) }}>Confirm cancellation</button>{' '}
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setCancelId(null)}>Keep number</button>
      </fieldset>)}
    </article>)}
    <button type="button" className={buttonClass} disabled={busy} onClick={number.resource.retry}>Refresh number status</button>
    <p className="text-sm text-muted-foreground">SMS and iMessage are separate activations. Buying a number does not enable WhatsApp.</p>
    <ChannelFailure state={number.state} /><ChannelFailure state={connect.state} />
    {lineId && <ChannelVerificationPanel lineId={lineId} key={lineId} />}
  </section>
}

/** Read-only history. Messages stay on their original channel; no synthetic composer. */
export function ChannelConversation({ lineId, threadId, className = '' }: { lineId: string; threadId: string; className?: string }) {
  const messages = useChannelConversation(lineId, threadId)
  return <section className={`${panelClass} ${className}`} aria-label="Channel conversation">
    <h3 className="font-semibold">Conversation</h3>
    <ChannelState resource={messages} empty="No messages in this conversation yet.">{items => <ol role="log" aria-live="polite" aria-label="Messages" className="space-y-3">
      {items.map(message => <li key={message.id} className="space-y-1 rounded-md bg-muted p-3" data-direction={message.direction}>
        <p className="text-xs text-muted-foreground">{message.direction === 'in' ? 'Incoming' : 'Outgoing'} · {message.kind} · <time dateTime={message.createdAt}>{message.createdAt}</time></p>
        <p className="whitespace-pre-wrap break-words">{message.text ?? 'Non-text message'}</p>
        <p className="text-xs">{message.status}{message.errorCode ? ` · ${message.errorCode}` : ''}</p>
      </li>)}
    </ol>}</ChannelState>
    <button type="button" className={buttonClass} onClick={messages.retry}>Refresh messages</button>
  </section>
}

/** A channel's separate member threads. Changing line never reuses another line's selection. */
export function ChannelConversations({ lineId, className = '' }: { lineId: string; className?: string }) {
  const threads = useChannelConversations(lineId)
  const [selected, setSelected] = useState<{ lineId: string; threadId: string } | null>(null)
  const threadId = selected?.lineId === lineId ? selected.threadId : ''
  return <div className={`space-y-4 ${className}`}>
    <section className={panelClass} aria-label="Channel conversations"><h2 className="text-lg font-semibold">Conversations</h2>
      <ChannelState resource={threads} empty="No conversations yet. Members must message the line first.">{items => <nav aria-label="Choose a conversation" className="flex flex-wrap gap-2">
        {items.map(thread => <button type="button" key={thread.id} className={buttonClass} aria-pressed={thread.id === threadId} onClick={() => setSelected({ lineId, threadId: thread.id })}>{thread.memberId} · {thread.status}</button>)}
      </nav>}</ChannelState>
    </section>
    {threadId && <ChannelConversation key={`${lineId}:${threadId}`} lineId={lineId} threadId={threadId} />}
  </div>
}
