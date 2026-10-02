import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Line } from '@tangle-network/sandbox'
import type {
  LineBoxMode, LineConnectInput, LineConnectionOption, LineIdentityKind, LineIdentityOption,
  LineSetupLine, LineSetupProps, LineSetupSnapshot,
} from './contracts'

const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect

const TRANSPORT: Record<Line['transport'], string> = {
  imessage: 'iMessage', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email',
}
const IDENTITY: Record<LineIdentityKind, string> = {
  handle: 'Inkbox handle', number: 'Dedicated number', email: 'Email line',
}

type Choice = { key: string; connection: LineConnectionOption; identity: LineIdentityOption }

function LineMessageAction({ line }: { line: LineSetupLine }) {
  if (line.transport !== 'imessage' || line.targetId === null || line.status !== 'active') return null
  if (!!line.connect !== !!line.routerAddress) return null
  const shared = !!line.connect && !!line.routerAddress
  const number = shared ? line.routerAddress : line.address
  if (!number || !/^\+[1-9]\d{7,14}$/.test(number)) return null
  return <a className="tangle-lines__quiet" href={`sms:${number}?body=${encodeURIComponent(shared ? line.connect ?? '' : 'Hello')}`}>
    {shared ? 'Connect iMessage' : 'Text it now'}
  </a>
}

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

function canOfferReconnect(line: LineSetupLine, choice: Choice): boolean {
  if (line.connectionId !== choice.connection.id || line.transport !== choice.identity.transport || line.targetId !== null) return false
  if (line.providerNumberId === null) return line.transport !== 'whatsapp' && !choice.identity.phoneNumberId && !choice.identity.requiresPhoneNumberId
  return choice.identity.phoneNumberId === line.providerNumberId ||
    (!choice.identity.phoneNumberId && choice.identity.requiresPhoneNumberId === true)
}

function matchesLineIdentity(line: LineSetupLine, identity: LineIdentityOption, numberId: string): boolean {
  if (line.transport !== identity.transport) return false
  if (line.providerNumberId === null) return line.transport !== 'whatsapp' && !identity.phoneNumberId && !identity.requiresPhoneNumberId
  return numberId === line.providerNumberId
}

/** Set up an owned identity through a host route backed by sandbox.lines and Hub. */
export function LineSetup({ client, scopeKey, initialTargetId, targetLabel, canManage, canConnect = canManage, showConnectionSetup = true, connectPrerequisite, setupDescription, emptyConnectionsMessage, onNotice }: LineSetupProps) {
  const clientRef = useRef(client)
  clientRef.current = client
  const sequence = useRef(0)
  const incarnation = useRef(0)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const setupHeading = useRef<HTMLHeadingElement>(null)
  const disconnectTriggers = useRef(new Map<string, HTMLButtonElement>())
  const restoreFocusTo = useRef<string | null>(null)
  useBrowserLayoutEffect(() => {
    incarnation.current++
    return () => { incarnation.current++ }
  }, [scopeKey, initialTargetId])
  const [loadedSnapshot, setLoadedSnapshot] = useState<{ scopeKey: string; initialTargetId: string | undefined; value: LineSetupSnapshot } | null>(null)
  const snapshot = loadedSnapshot?.scopeKey === scopeKey && loadedSnapshot.initialTargetId === initialTargetId ? loadedSnapshot.value : null
  const [loading, setLoading] = useState(true)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<LineIdentityKind>('handle')
  const [choiceKey, setChoiceKey] = useState('')
  const [targetId, setTargetId] = useState(initialTargetId ?? '')
  const [boxMode, setBoxMode] = useState<LineBoxMode>('per-member')
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [confirmation, setConfirmation] = useState<{ lineId: string; attachmentId: string | undefined } | null>(null)
  const confirmLineId = confirmation?.lineId ?? null

  function stillCurrent(requestIncarnation: number): boolean {
    return requestIncarnation === incarnation.current
  }

  async function reload(requestIncarnation: number): Promise<LineSetupSnapshot | null> {
    const request = ++sequence.current
    try {
      const next = await clientRef.current.load()
      if (request !== sequence.current || !stillCurrent(requestIncarnation)) return null
      setLoadedSnapshot({ scopeKey, initialTargetId, value: next })
      setError(null)
      setRefreshFailed(false)
      setTargetId(current => next.targets.some(target => target.id === current)
        ? current : next.targets.find(target => target.id === initialTargetId)?.id ?? next.targets[0]?.id ?? '')
      setLoading(false)
      return next
    } catch (cause) {
      if (request !== sequence.current || !stillCurrent(requestIncarnation)) return null
      setError(message(cause))
      setRefreshFailed(true)
      setLoading(false)
      return null
    }
  }

  function retry() {
    if (loading) return
    setLoading(true)
    void reload(incarnation.current)
  }

  function closeConfirmation(lineId: string) {
    restoreFocusTo.current = lineId
    setConfirmation(null)
  }

  useEffect(() => {
    setLoading(true)
    setLoadedSnapshot(null)
    setError(null)
    setRefreshFailed(false)
    setBusy(false)
    setKind('handle')
    setChoiceKey('')
    setTargetId(initialTargetId ?? '')
    setBoxMode('per-member')
    setPhoneNumberId('')
    setConfirmation(null)
    restoreFocusTo.current = null
    void reload(incarnation.current)
    return () => { sequence.current++ }
  }, [scopeKey, initialTargetId])

  useEffect(() => {
    if (confirmLineId) confirmButton.current?.focus()
  }, [confirmLineId])

  useEffect(() => {
    const lineId = restoreFocusTo.current
    if (confirmLineId !== null || lineId === null) return
    restoreFocusTo.current = null
    const trigger = disconnectTriggers.current.get(lineId)
    if (trigger && !trigger.disabled) trigger.focus()
    else (heading.current ?? setupHeading.current)?.focus()
  }, [confirmLineId, snapshot, refreshFailed])

  const allChoices = snapshot ? choicesFor(snapshot) : []
  const choices = snapshot ? allChoices.filter(choice => {
    const occupied = snapshot.lines.filter(line => line.status !== 'released' && line.transport === choice.identity.transport)
    const [line] = occupied
    return occupied.length === 0 || (occupied.length === 1 && line !== undefined && canOfferReconnect(line, choice))
  }) : []
  const availableKinds = (['handle', 'number', 'email'] as const).filter(value => choices.some(choice => choice.identity.kind === value))
  const selectedKind = availableKinds.includes(kind) ? kind : availableKinds[0]
  const kindChoices = choices.filter(choice => choice.identity.kind === selectedKind)
  const selected = kindChoices.find(choice => choice.key === choiceKey) ?? kindChoices[0]
  const visibleLines = snapshot?.lines.filter(line => line.status !== 'released') ?? []
  const showSetup = Boolean(snapshot && canManage && showConnectionSetup &&
    (snapshot.connections === null || choices.length > 0 || allChoices.length === 0))
  const showExisting = snapshot ? visibleLines.length > 0 || !showSetup : !(canManage && showConnectionSetup)
  const hasSeveralChoices = availableKinds.length > 1 || kindChoices.length > 1 || (snapshot?.targets.length ?? 0) > 1
  const SetupHeading = showExisting ? 'h3' : 'h2'
  const selectedTarget = snapshot?.targets.find(target => target.id === targetId)
  const selectedMode = selectedTarget?.modes.includes(boxMode) ? boxMode : selectedTarget?.modes[0]
  const enteredNumber = selected?.identity.phoneNumberId ?? phoneNumberId.trim()
  const needsNumber = selected?.identity.transport === 'whatsapp' || selected?.identity.requiresPhoneNumberId
  const occupied = selected && snapshot?.lines.filter(line => line.status !== 'released' && line.transport === selected.identity.transport)
  const [occupiedLine] = occupied || []
  const reconnectChoice = Boolean(selected && occupied?.length === 1 && occupiedLine && canOfferReconnect(occupiedLine, selected))
  const reconnecting = Boolean(reconnectChoice && selected && occupiedLine &&
    matchesLineIdentity(occupiedLine, selected.identity, enteredNumber))
  const blockedByExistingLine = Boolean(occupied?.length && !reconnecting)
  const answeringCount = snapshot?.lines.filter(line => line.answering).length ?? 0
  const draft: LineConnectInput | null = selected && selectedTarget && selectedMode
    ? {
      connectionId: selected.connection.id,
      transport: selected.identity.transport,
      ...(enteredNumber ? { phoneNumberId: enteredNumber } : {}),
      targetId: selectedTarget.id,
      boxMode: selectedMode,
    } : null
  const prerequisite = draft ? connectPrerequisite?.(draft) : null
  const connectReady = Boolean(canManage && canConnect && draft && (prerequisite?.ready ?? true)
    && !(needsNumber && !enteredNumber) && !blockedByExistingLine && !busy && !loading && !refreshFailed)

  async function connect() {
    if (!connectReady || !draft || !selected) return
    const requestIncarnation = incarnation.current
    setBusy(true)
    setError(null)
    try {
      await clientRef.current.connect(draft)
      if (!stillCurrent(requestIncarnation)) return
      const updated = await reload(requestIncarnation)
      if (!stillCurrent(requestIncarnation)) return
      if (!updated) {
        onNotice?.({ kind: 'error', message: 'Line connected, but its current status could not be loaded.' })
        return
      }
      const line = updated.lines.find(item => item.status !== 'released' && item.connectionId === selected.connection.id &&
        item.transport === selected.identity.transport && item.providerNumberId === (enteredNumber || null))
      onNotice?.({ kind: 'success', message: line?.answering ? 'The line is answering.' : 'Line connected. Add a member to start answers.' })
    } catch (cause) {
      if (!stillCurrent(requestIncarnation)) return
      const detail = message(cause)
      setError(detail)
      onNotice?.({ kind: 'error', message: detail })
    } finally {
      if (stillCurrent(requestIncarnation)) setBusy(false)
    }
  }

  async function disconnect() {
    if (!confirmation || busy || loading || refreshFailed) return
    const { lineId, attachmentId: expectedAttachmentId } = confirmation
    const requestIncarnation = incarnation.current
    setBusy(true)
    setError(null)
    try {
      await clientRef.current.disconnect(lineId, expectedAttachmentId)
      if (!stillCurrent(requestIncarnation)) return
      const updated = await reload(requestIncarnation)
      if (!stillCurrent(requestIncarnation)) return
      closeConfirmation(lineId)
      onNotice?.(updated
        ? { kind: 'success', message: 'The line stopped answering.' }
        : { kind: 'error', message: 'Line disconnected, but its current status could not be loaded.' })
    } catch (cause) {
      if (!stillCurrent(requestIncarnation)) return
      const detail = message(cause)
      setError(detail)
      onNotice?.({ kind: 'error', message: detail })
    } finally {
      if (stillCurrent(requestIncarnation)) setBusy(false)
    }
  }

  return <section className="tangle-lines" aria-label="Agent lines">
    {showExisting && <header className="tangle-lines__heading">
      <div>
        <h2 ref={heading} tabIndex={-1}>Lines</h2>
        {snapshot && <p>{snapshot.workspaceName} can use one line per transport.</p>}
      </div>
      {answeringCount > 1 && <span className="tangle-lines__count">{answeringCount} answering</span>}
    </header>}

    {error && <div className="tangle-lines__error" role="alert">
      <div><strong>{refreshFailed ? 'Lines are unavailable' : 'Line action failed'}</strong><p>{error}</p></div>
      {(!snapshot || refreshFailed) && <button type="button" disabled={loading} onClick={retry}>Retry</button>}
    </div>}
    {loading && <p className="tangle-lines__muted" role="status">Loading lines…</p>}

    {snapshot && <>
      {showExisting && <div className="tangle-lines__list">
        {visibleLines.length === 0 &&
          <div className="tangle-lines__empty"><strong>No lines connected</strong><p>{canManage && showConnectionSetup
            ? 'Connect an owned identity below to let this workspace answer messages.'
            : 'There are no connected lines in this workspace.'}</p></div>}
        {visibleLines.map(line =>
          <div className="tangle-lines__row" key={line.id}>
            <div className="tangle-lines__row-main">
              <div className="tangle-lines__row-heading"><span className="tangle-lines__transport">{TRANSPORT[line.transport]}</span><span className={`tangle-lines__status${line.answering ? ' tangle-lines__status--answering' : ''}`}>{line.answering ? 'Answering' : line.targetId === null ? 'Disconnected' : line.status === 'active' ? 'Awaiting member' : line.status}</span></div>
              <strong>{line.address}</strong>
              {line.transport === 'imessage' && line.connect && line.routerAddress && line.targetId !== null && <p>Send <code>{line.connect}</code> to {line.routerAddress}. Then message the number Inkbox sends you.</p>}
              <LineMessageAction line={line} />
              <p>{line.targetLabel ?? 'No agent or box assigned'}{line.boxMode && ` · ${line.boxMode === 'per-member' ? 'one box per member' : 'shared box'}`}</p>
              {line.lastTurn.kind === 'latest' ? <p>Last turn: {line.lastTurn.status} · {dateTime(line.lastTurn.at)}</p>
                : <p>{line.lastTurn.kind === 'none' ? 'No turns yet.' : 'Turn history unavailable.'}</p>}
            </div>
            {canManage && line.canDisconnect && line.targetId !== null && line.status === 'active' && <div className="tangle-lines__row-actions">
              {confirmLineId === line.id ? <div className="tangle-lines__confirm" role="group" aria-label={`Disconnect ${line.address}?`}>
                <span>Disconnect this line?</span>
                <button ref={confirmButton} type="button" className="tangle-lines__danger" disabled={busy || loading || refreshFailed} onClick={() => void disconnect()}>Disconnect</button>
                <button type="button" disabled={busy} onClick={() => closeConfirmation(line.id)}>Keep line</button>
              </div> : <button ref={node => { if (node) disconnectTriggers.current.set(line.id, node); else disconnectTriggers.current.delete(line.id) }} type="button" className="tangle-lines__quiet" disabled={busy || loading || refreshFailed} onClick={() => setConfirmation({ lineId: line.id, attachmentId: line.attachmentId ?? undefined })}>Disconnect line</button>}
            </div>}
          </div>)}
      </div>}

      {showSetup && <div className={`tangle-lines__setup${showExisting ? '' : ' tangle-lines__setup--first'}`}>
        <SetupHeading ref={setupHeading} tabIndex={-1}>Connect a line</SetupHeading>
        {hasSeveralChoices && setupDescription && <p>{setupDescription}</p>}
        {snapshot.connections === null ? <div className="tangle-lines__error" role="status">
          <span>Hub connections could not be read. Check Hub access and try again.</span>
          <button type="button" disabled={loading} onClick={retry}>Retry</button>
        </div>
          : availableKinds.length === 0 ? <p className="tangle-lines__empty">
            {emptyConnectionsMessage ?? 'Connect an owned handle, number, or mailbox in Hub, then'} <button type="button" disabled={loading} onClick={retry}>reload</button>.
          </p>
            : <>
              {availableKinds.length > 1 && <div className="tangle-lines__kinds" role="group" aria-label="Identity type">
                {availableKinds.map(value => <button key={value} type="button" aria-pressed={selectedKind === value} onClick={() => { setKind(value); setChoiceKey(''); setPhoneNumberId('') }}>{IDENTITY[value]}</button>)}
              </div>}
              <div className="tangle-lines__fields">
                {kindChoices.length > 1 ? <label>Line
                  <select value={selected?.key ?? ''} onChange={event => { setChoiceKey(event.target.value); setPhoneNumberId('') }}>
                    {kindChoices.map(choice => <option key={choice.key} value={choice.key}>{choice.identity.label} · {TRANSPORT[choice.identity.transport]} via {choice.connection.label}</option>)}
                  </select>
                </label> : selected && <div className="tangle-lines__fixed-choice">
                  <span>Line</span>
                  <strong>{selected.identity.label}</strong>
                  <small>{TRANSPORT[selected.identity.transport]} via {selected.connection.label}</small>
                </div>}
                {snapshot.targets.length > 1 ? <label>{targetLabel ?? 'Agent or box'}
                  <select value={selectedTarget?.id ?? ''} onChange={event => setTargetId(event.target.value)}>
                    {snapshot.targets.map(target => <option key={target.id} value={target.id}>{target.label}{targetLabel ? '' : ` · ${target.kind}`}</option>)}
                  </select>
                </label> : selectedTarget && <div className="tangle-lines__fixed-choice">
                  <span>{targetLabel ?? 'Agent or box'}</span>
                  <strong>{selectedTarget.label}{targetLabel ? '' : ` · ${selectedTarget.kind}`}</strong>
                </div>}
                {selectedTarget && selectedTarget.modes.length > 1 && <fieldset>
                  <legend>Conversation space</legend>
                  <label><input type="radio" name={`line-box-mode-${scopeKey}`} value="per-member" checked={selectedMode === 'per-member'} disabled={!selectedTarget?.modes.includes('per-member')} onChange={() => setBoxMode('per-member')} /> One box per member</label>
                  <label><input type="radio" name={`line-box-mode-${scopeKey}`} value="shared" checked={selectedMode === 'shared'} disabled={!selectedTarget?.modes.includes('shared')} onChange={() => setBoxMode('shared')} /> Shared box for a team</label>
                </fieldset>}
                {needsNumber && !selected?.identity.phoneNumberId && <label>Existing provider number ID
                  <input value={phoneNumberId} onChange={event => setPhoneNumberId(event.target.value)} autoComplete="off" placeholder="Number ID from Hub" />
                </label>}
              </div>
              {reconnectChoice && blockedByExistingLine && <p className="tangle-lines__warning">Enter this line's current provider number ID to reconnect.</p>}
              {prerequisite?.content}
              <button className="tangle-lines__primary" type="button" disabled={!connectReady} onClick={() => void connect()}>
                {busy ? (reconnectChoice ? 'Reconnecting…' : 'Connecting…') : `${reconnectChoice ? 'Reconnect' : 'Connect'} ${selected ? TRANSPORT[selected.identity.transport] : 'line'}`}
              </button>
            </>}
      </div>}
    </>}
  </section>
}
