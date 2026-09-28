import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LineMember } from '@tangle-network/sandbox'
import type { LineMembersProps } from './contracts'

const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect

const STATUS: Record<LineMember['status'], { label: string; detail: string }> = {
  invited: { label: 'Awaiting consent', detail: 'The first message from this address confirms consent.' },
  active: { label: 'Consented', detail: 'This member has sent a message to the line.' },
  stopped: { label: 'Stopped', detail: 'The member texted STOP. Only a message from them with START resumes replies.' },
  removed: { label: 'Removed', detail: 'This address no longer has access to the line.' },
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The member request failed. Try again.'
}

/** Manage Hub line members while keeping consent and STOP authority with the sender. */
export function LineMembers({ lineId, scopeKey, client, roles, canManage, canAdd = true, maxMembers, allowRoleChange = true, allowRemoveLastOwner = false, onNotice }: LineMembersProps) {
  const clientRef = useRef(client)
  clientRef.current = client
  const sequence = useRef(0)
  const incarnation = useRef(0)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const removeTriggers = useRef(new Map<string, HTMLButtonElement>())
  const restoreFocusTo = useRef<string | null>(null)
  useBrowserLayoutEffect(() => {
    incarnation.current++
    return () => { incarnation.current++ }
  }, [lineId, scopeKey])
  const [memberSnapshot, setMemberSnapshot] = useState<{ lineId: string; scopeKey: string; members: LineMember[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const members = memberSnapshot?.lineId === lineId && memberSnapshot.scopeKey === scopeKey ? memberSnapshot.members : null

  function stillCurrent(requestIncarnation: number): boolean {
    return requestIncarnation === incarnation.current
  }

  async function reload(requestIncarnation: number): Promise<boolean> {
    const request = ++sequence.current
    try {
      const next = await clientRef.current.list(lineId)
      if (request !== sequence.current || !stillCurrent(requestIncarnation)) return false
      setMemberSnapshot({ lineId, scopeKey, members: next })
      setError(null)
      setRefreshFailed(false)
      return true
    } catch (cause) {
      if (request !== sequence.current || !stillCurrent(requestIncarnation)) return false
      setError(errorMessage(cause))
      setRefreshFailed(true)
      return false
    }
  }

  async function retry() {
    if (busy) return
    const requestIncarnation = incarnation.current
    setBusy('refresh')
    try { await reload(requestIncarnation) }
    finally { if (stillCurrent(requestIncarnation)) setBusy(null) }
  }

  function closeConfirmation(memberId: string) {
    restoreFocusTo.current = memberId
    setConfirmId(null)
  }

  useEffect(() => {
    setMemberSnapshot(null)
    setError(null)
    setRefreshFailed(false)
    setAddress('')
    setLabel('')
    setRole('member')
    setConfirmId(null)
    restoreFocusTo.current = null
    setBusy(null)
    void reload(incarnation.current)
    return () => { sequence.current++ }
  }, [lineId, scopeKey])

  useEffect(() => {
    if (confirmId) confirmButton.current?.focus()
  }, [confirmId])

  useEffect(() => {
    const memberId = restoreFocusTo.current
    if (confirmId !== null || memberId === null) return
    restoreFocusTo.current = null
    const trigger = removeTriggers.current.get(memberId)
    if (trigger && !trigger.disabled) trigger.focus()
    else heading.current?.focus()
  }, [confirmId, members, refreshFailed])

  const selectedRole = roles.some(item => item.value === role) ? role : roles.find(item => item.value === 'member')?.value ?? roles[0]?.value ?? ''
  const activeMembers = members?.filter(member => member.status !== 'removed').length ?? 0
  const activeOwners = members?.filter(member => member.role === 'owner' && member.status !== 'removed').length ?? 0

  async function mutate(key: string, action: () => Promise<void>, success: string, onSuccess?: () => void) {
    if (busy || refreshFailed) return
    const requestIncarnation = incarnation.current
    setBusy(key)
    setError(null)
    try {
      await action()
      if (!stillCurrent(requestIncarnation)) return
      const refreshed = await reload(requestIncarnation)
      if (!stillCurrent(requestIncarnation)) return
      onSuccess?.()
      onNotice?.(refreshed
        ? { kind: 'success', message: success }
        : { kind: 'error', message: 'Member updated, but the current member list could not be loaded.' })
    } catch (cause) {
      if (!stillCurrent(requestIncarnation)) return
      const detail = errorMessage(cause)
      setError(detail)
      onNotice?.({ kind: 'error', message: detail })
    } finally {
      if (stillCurrent(requestIncarnation)) setBusy(null)
    }
  }

  function add() {
    const trimmed = address.trim()
    if (!trimmed || !selectedRole || members === null || (maxMembers !== undefined && activeMembers >= maxMembers)) return
    void mutate('add', () => clientRef.current.add(lineId, { address: trimmed, role: selectedRole, ...(label.trim() ? { label: label.trim() } : {}) }), 'Member invited. Their first message confirms consent.', () => {
      setAddress('')
      setLabel('')
    })
  }

  return <section className="tangle-lines" aria-label="Line members">
    <header className="tangle-lines__heading">
      <div><h2 ref={heading} tabIndex={-1}>Members</h2><p>Each address controls its own consent and STOP state.</p></div>
      {members && <span className="tangle-lines__count">{activeMembers} {activeMembers === 1 ? 'member' : 'members'}</span>}
    </header>
    {error && <div className="tangle-lines__error" role="alert">
      <span>{error}</span>
      {(members === null || refreshFailed) && <button type="button" disabled={busy !== null} onClick={() => void retry()}>Retry</button>}
    </div>}
    {members === null ? !error && <p className="tangle-lines__muted" role="status">Loading members…</p> : <div className="tangle-lines__list">
      {members.length === 0 && <p className="tangle-lines__empty">{canAdd ? 'No members yet. Invite an address that you own or have permission to add.' : 'No members yet.'}</p>}
      {members.map(member => {
        const lastOwner = member.role === 'owner' && activeOwners <= 1
        const editable = canManage && member.status !== 'removed' && (!lastOwner || allowRemoveLastOwner)
        return <div className="tangle-lines__row" key={member.id}>
          <div className="tangle-lines__row-main">
            <span className={`tangle-lines__state tangle-lines__state--${member.status}`}>{STATUS[member.status].label}</span>
            <strong>{member.label || member.address}</strong>
            {member.label && <p>{member.address}</p>}
            <p>{STATUS[member.status].detail}</p>
          </div>
          <div className="tangle-lines__row-actions">
            {editable ? <>
              {allowRoleChange && !lastOwner ? <label className="tangle-lines__compact-label">Role
                <select value={member.role} disabled={busy !== null || refreshFailed} onChange={event => void mutate(member.id, () => clientRef.current.update(lineId, member.id, { role: event.target.value }), 'Role updated.')}>
                  {!roles.some(item => item.value === member.role) && <option value={member.role}>{member.role}</option>}
                  {roles.map(item => <option key={item.value} value={item.value}>{item.label}{item.tools === 'chat' ? ' · chat only' : ''}</option>)}
                </select>
              </label> : <span className="tangle-lines__role">{roles.find(item => item.value === member.role)?.label ?? member.role}</span>}
              {confirmId === member.id ? <div className="tangle-lines__confirm" role="group" aria-label={`Remove ${member.label || member.address}?`}>
                <span>Remove {member.label || member.address}?</span>
                <button ref={confirmButton} type="button" className="tangle-lines__danger" disabled={busy !== null || refreshFailed} onClick={() => void mutate(member.id, () => clientRef.current.remove(lineId, member.id), 'Member removed.', () => closeConfirmation(member.id))}>Remove</button>
                <button type="button" disabled={busy !== null} onClick={() => closeConfirmation(member.id)}>Keep</button>
              </div> : <button ref={node => { if (node) removeTriggers.current.set(member.id, node); else removeTriggers.current.delete(member.id) }} type="button" className="tangle-lines__quiet" disabled={busy !== null || refreshFailed} onClick={() => setConfirmId(member.id)}>Remove</button>}
            </> : <span className="tangle-lines__role">{roles.find(item => item.value === member.role)?.label ?? member.role}</span>}
          </div>
        </div>
      })}
    </div>}

    {canManage && canAdd && members !== null && (maxMembers === undefined || activeMembers < maxMembers) && <div className="tangle-lines__setup">
      <h3>Invite a member</h3>
      <p>Hub marks the address as invited. The member confirms by messaging the line.</p>
      <div className="tangle-lines__fields">
        <label>Phone number or email
          <input value={address} onChange={event => setAddress(event.target.value)} autoComplete="off" placeholder="+15551234567 or name@example.com" />
        </label>
        <label>Name (optional)
          <input value={label} onChange={event => setLabel(event.target.value)} placeholder="Member name" />
        </label>
        <label>Role
          <select value={selectedRole} disabled={roles.length === 0} onChange={event => setRole(event.target.value)}>
            {roles.map(item => <option key={item.value} value={item.value}>{item.label}{item.tools === 'chat' ? ' · chat only' : ''}</option>)}
          </select>
        </label>
      </div>
      <button type="button" className="tangle-lines__primary" disabled={busy !== null || refreshFailed || !address.trim() || !selectedRole} onClick={add}>
        {busy === 'add' ? 'Inviting…' : 'Invite member'}
      </button>
    </div>}
  </section>
}
