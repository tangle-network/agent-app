import { useEffect, useRef, useState } from 'react'
import type { Line } from '@tangle-network/sandbox'
import type {
  LineBoxMode, LineConnectionOption, LineIdentityKind, LineIdentityOption,
  LineSetupProps, LineSetupSnapshot,
} from './contracts'

const TRANSPORT: Record<Line['transport'], string> = {
  imessage: 'iMessage', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email',
}
const IDENTITY: Record<LineIdentityKind, string> = {
  handle: 'Inkbox handle', number: 'Dedicated number', email: 'Email line',
}

type Choice = { key: string; connection: LineConnectionOption; identity: LineIdentityOption }

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The line request failed. Try again.'
}

function dateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function choicesFor(snapshot: LineSetupSnapshot): Choice[] {
  return (snapshot.connections ?? []).flatMap(connection => connection.identities.map((identity, index) => ({
    key: `${connection.id}:${index}`,
    connection,
    identity,
  })))
}

/** Set up an owned identity through a host route backed by sandbox.lines and Hub. */
export function LineSetup({ client, scopeKey, initialTargetId, canManage, onNotice }: LineSetupProps) {
  const clientRef = useRef(client)
  clientRef.current = client
  const sequence = useRef(0)
  const currentScope = useRef(scopeKey)
  const currentTarget = useRef(initialTargetId)
  const confirmButton = useRef<HTMLButtonElement>(null)
  currentScope.current = scopeKey
  currentTarget.current = initialTargetId
  const [loadedSnapshot, setLoadedSnapshot] = useState<{ scopeKey: string; initialTargetId: string | undefined; value: LineSetupSnapshot } | null>(null)
  const snapshot = loadedSnapshot?.scopeKey === scopeKey && loadedSnapshot.initialTargetId === initialTargetId ? loadedSnapshot.value : null
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<LineIdentityKind>('handle')
  const [choiceKey, setChoiceKey] = useState('')
  const [targetId, setTargetId] = useState(initialTargetId ?? '')
  const [boxMode, setBoxMode] = useState<LineBoxMode>('per-member')
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [confirmLineId, setConfirmLineId] = useState<string | null>(null)

  function stillCurrent(): boolean {
    return currentScope.current === scopeKey && currentTarget.current === initialTargetId
  }

  async function reload(): Promise<LineSetupSnapshot | null> {
    const request = ++sequence.current
    try {
      const next = await clientRef.current.load()
      if (request !== sequence.current || !stillCurrent()) return null
      setLoadedSnapshot({ scopeKey, initialTargetId, value: next })
      setError(null)
      setTargetId(current => next.targets.some(target => target.id === current)
        ? current : next.targets.find(target => target.id === initialTargetId)?.id ?? next.targets[0]?.id ?? '')
      setLoading(false)
      return next
    } catch (cause) {
      if (request !== sequence.current || !stillCurrent()) return null
      setError(message(cause))
      setLoading(false)
      return null
    }
  }

  useEffect(() => {
    setLoading(true)
    setLoadedSnapshot(null)
    setError(null)
    setBusy(false)
    setKind('handle')
    setChoiceKey('')
    setTargetId(initialTargetId ?? '')
    setBoxMode('per-member')
    setPhoneNumberId('')
    setConfirmLineId(null)
    void reload()
    return () => { sequence.current++ }
  }, [scopeKey, initialTargetId])

  useEffect(() => {
    if (confirmLineId) confirmButton.current?.focus()
  }, [confirmLineId])

  const allChoices = snapshot ? choicesFor(snapshot) : []
  const choices = snapshot ? allChoices.filter(choice => !snapshot.lines.some(line =>
    line.status !== 'released' && line.transport === choice.identity.transport &&
    (line.connectionId !== choice.connection.id || line.targetId !== null))) : []
  const availableKinds = (['handle', 'number', 'email'] as const).filter(value => choices.some(choice => choice.identity.kind === value))
  const selectedKind = availableKinds.includes(kind) ? kind : availableKinds[0]
  const kindChoices = choices.filter(choice => choice.identity.kind === selectedKind)
  const selected = kindChoices.find(choice => choice.key === choiceKey) ?? kindChoices[0]
  const selectedTarget = snapshot?.targets.find(target => target.id === targetId)
  const selectedMode = selectedTarget?.modes.includes(boxMode) ? boxMode : selectedTarget?.modes[0]
  const enteredNumber = selected?.identity.phoneNumberId ?? phoneNumberId.trim()
  const needsNumber = selected?.identity.transport === 'whatsapp' || selected?.identity.requiresPhoneNumberId
  const reconnecting = selected && snapshot?.lines.some(line => line.status !== 'released' &&
    line.connectionId === selected.connection.id && line.transport === selected.identity.transport && line.targetId === null)

  async function connect() {
    if (!selected || !selectedTarget || !selectedMode || (needsNumber && !enteredNumber) || busy) return
    setBusy(true)
    setError(null)
    try {
      await clientRef.current.connect({
        connectionId: selected.connection.id,
        transport: selected.identity.transport,
        ...(enteredNumber ? { phoneNumberId: enteredNumber } : {}),
        targetId: selectedTarget.id,
        boxMode: selectedMode,
      })
      if (!stillCurrent()) return
      const updated = await reload()
      if (!stillCurrent()) return
      if (!updated) {
        onNotice?.({ kind: 'error', message: 'Line connected, but its current status could not be loaded.' })
        return
      }
      const line = updated.lines.find(item => item.connectionId === selected.connection.id && item.transport === selected.identity.transport)
      onNotice?.({ kind: 'success', message: line?.answering ? 'The line is answering.' : 'Line connected. Add a member to start answers.' })
    } catch (cause) {
      if (!stillCurrent()) return
      const detail = message(cause)
      setError(detail)
      onNotice?.({ kind: 'error', message: detail })
    } finally {
      if (stillCurrent()) setBusy(false)
    }
  }

  async function disconnect(lineId: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await clientRef.current.disconnect(lineId)
      if (!stillCurrent()) return
      setConfirmLineId(null)
      const updated = await reload()
      if (!stillCurrent()) return
      onNotice?.(updated
        ? { kind: 'success', message: 'The line stopped answering.' }
        : { kind: 'error', message: 'Line disconnected, but its current status could not be loaded.' })
    } catch (cause) {
      if (!stillCurrent()) return
      const detail = message(cause)
      setError(detail)
      onNotice?.({ kind: 'error', message: detail })
    } finally {
      if (stillCurrent()) setBusy(false)
    }
  }

  return <section className="tangle-lines" aria-label="Agent lines">
    <header className="tangle-lines__heading">
      <div>
        <h2>Lines</h2>
        {snapshot && <p>{snapshot.workspaceName} can use one line per transport.</p>}
      </div>
      {snapshot && <span className="tangle-lines__count">{snapshot.lines.filter(line => line.answering).length} answering</span>}
    </header>

    {error && <div className="tangle-lines__error" role="alert">
      <span>{error}</span>
      {!snapshot && <button type="button" onClick={() => { setLoading(true); void reload() }}>Retry</button>}
    </div>}
    {loading && <p className="tangle-lines__muted" role="status">Loading lines…</p>}

    {snapshot && <>
      <div className="tangle-lines__list">
        {snapshot.lines.filter(line => line.status !== 'released').length === 0 &&
          <p className="tangle-lines__empty">No line answers for this workspace yet.</p>}
        {snapshot.lines.filter(line => line.status !== 'released').map(line =>
          <div className="tangle-lines__row" key={line.id}>
            <div className="tangle-lines__row-main">
              <span className="tangle-lines__eyebrow">{TRANSPORT[line.transport]} · {line.answering ? 'Answering' : line.targetId === null ? 'Disconnected' : line.status === 'active' ? 'Awaiting member' : line.status}</span>
              <strong>{line.routerAddress ?? line.address}</strong>
              {line.connect && line.targetId !== null && <p>To reach this agent, text <code>{line.connect}</code>.</p>}
              <p>{line.targetLabel ?? 'No agent or box assigned'}{line.boxMode && ` · ${line.boxMode === 'per-member' ? 'one box per member' : 'shared box'}`}</p>
              {line.lastTurn.kind === 'latest' ? <p>Last turn: {line.lastTurn.status} · {dateTime(line.lastTurn.at)}</p>
                : <p>{line.lastTurn.kind === 'none' ? 'No turns yet.' : 'Turn history unavailable.'}</p>}
            </div>
            {canManage && line.canDisconnect && line.targetId !== null && line.status === 'active' && <div className="tangle-lines__row-actions">
              {confirmLineId === line.id ? <div className="tangle-lines__confirm" role="group" aria-label={`Disconnect ${line.address}?`}>
                <span>Disconnect this line?</span>
                <button ref={confirmButton} type="button" className="tangle-lines__danger" disabled={busy} onClick={() => void disconnect(line.id)}>Disconnect</button>
                <button type="button" disabled={busy} onClick={() => setConfirmLineId(null)}>Keep line</button>
              </div> : <button type="button" className="tangle-lines__quiet" disabled={busy} onClick={() => setConfirmLineId(line.id)}>Disconnect line</button>}
            </div>}
          </div>)}
      </div>

      {canManage && (snapshot.connections === null || choices.length > 0 || allChoices.length === 0) && <div className="tangle-lines__setup">
        <h3>Connect an identity you own</h3>
        <p>Choose an identity already connected in Hub. Billing details appear below.</p>
        {snapshot.connections === null ? <div className="tangle-lines__error" role="status">
          <span>Hub connections could not be read. Check Hub access and try again.</span>
          <button type="button" disabled={loading} onClick={() => { setLoading(true); void reload() }}>Retry</button>
        </div>
          : availableKinds.length === 0 ? <p className="tangle-lines__empty">
            Connect an owned handle, number, or mailbox in Hub, then <button type="button" disabled={loading} onClick={() => { setLoading(true); void reload() }}>reload</button>.
          </p>
            : <>
              <div className="tangle-lines__kinds" role="group" aria-label="Identity type">
                {availableKinds.map(value => <button key={value} type="button" aria-pressed={selectedKind === value} onClick={() => { setKind(value); setChoiceKey(''); setPhoneNumberId('') }}>{IDENTITY[value]}</button>)}
              </div>
              <div className="tangle-lines__fields">
                <label>Owned connection
                  <select value={selected?.key ?? ''} onChange={event => { setChoiceKey(event.target.value); setPhoneNumberId('') }}>
                    {kindChoices.map(choice => <option key={choice.key} value={choice.key}>{choice.connection.label} · {choice.identity.label}</option>)}
                  </select>
                </label>
                <label>Agent or box
                  <select value={selectedTarget?.id ?? ''} onChange={event => setTargetId(event.target.value)}>
                    {snapshot.targets.map(target => <option key={target.id} value={target.id}>{target.label} · {target.kind}</option>)}
                  </select>
                </label>
                {selectedTarget && selectedTarget.modes.length > 1 && <fieldset>
                  <legend>Conversation space</legend>
                  <label><input type="radio" name={`line-box-mode-${scopeKey}`} value="per-member" checked={selectedMode === 'per-member'} disabled={!selectedTarget?.modes.includes('per-member')} onChange={() => setBoxMode('per-member')} /> One box per member</label>
                  <label><input type="radio" name={`line-box-mode-${scopeKey}`} value="shared" checked={selectedMode === 'shared'} disabled={!selectedTarget?.modes.includes('shared')} onChange={() => setBoxMode('shared')} /> Shared box for a team</label>
                </fieldset>}
                {needsNumber && !selected?.identity.phoneNumberId && <label>Existing provider number ID
                  <input value={phoneNumberId} onChange={event => setPhoneNumberId(event.target.value)} autoComplete="off" placeholder="Number ID from Hub" />
                </label>}
              </div>
              <button className="tangle-lines__primary" type="button" disabled={busy || !selected || !selectedTarget || !selectedMode || (needsNumber && !enteredNumber)} onClick={() => void connect()}>
                {busy ? (reconnecting ? 'Reconnecting…' : 'Connecting…') : `${reconnecting ? 'Reconnect' : 'Connect'} ${selected ? TRANSPORT[selected.identity.transport] : 'line'}`}
              </button>
            </>}
      </div>}
    </>}
  </section>
}
