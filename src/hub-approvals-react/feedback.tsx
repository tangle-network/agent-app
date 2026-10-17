import { useEffect, useId, useState } from 'react'
import { Button, Input, Label, Textarea } from '@tangle-network/ui/primitives'
import { presentHubAction, type HubApprovalFeedback, type HubApprovalItem } from '../hub-approvals'

export interface HubPreviewFeedbackProps {
  item: HubApprovalItem
  onFeedback: (item: HubApprovalItem, feedback: HubApprovalFeedback) => Promise<void>
  /** Owner-local drafts survive collapsing/switching previews, never another viewer. */
  drafts?: Map<string, FeedbackDraft>
}

interface FeedbackDraft { score: string; comment: string; editing: boolean; edited: boolean; subject: string; body: string; payload: string; saved: boolean }

/** Host callback saves the signal; this component has no execution transport. */
export function HubPreviewFeedback({ item, onFeedback, drafts }: HubPreviewFeedbackProps) {
  const id = useId()
  const saved = item.feedback
  const original = item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? item.input as Record<string, unknown> : {}
  const prior = saved?.editedInput && typeof saved.editedInput === 'object' && !Array.isArray(saved.editedInput)
    ? saved.editedInput as Record<string, unknown> : original
  const kind = presentHubAction(item).preview.kind
  const field = kind === 'email'
    ? typeof original.html === 'string' ? 'html' : typeof original.body === 'string' ? 'body' : 'text'
    : typeof original.commentary === 'string' ? 'commentary' : 'text'
  const draft = drafts?.get(item.id)
  const [score, setScore] = useState(draft?.score ?? (saved ? String(saved.score) : ''))
  const [comment, setComment] = useState(draft?.comment ?? saved?.comment ?? '')
  const [editing, setEditing] = useState(draft?.editing ?? false)
  const [edited, setEdited] = useState(draft?.edited ?? saved?.editedInput !== undefined)
  const [subject, setSubject] = useState(draft?.subject ?? String(prior.subject ?? ''))
  const [body, setBody] = useState(draft?.body ?? String(prior[field] ?? ''))
  const [payload, setPayload] = useState(draft?.payload ?? JSON.stringify(prior, null, 2))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState((draft ? draft.saved : saved) ? 'Feedback saved' : '')
  const [error, setError] = useState('')

  useEffect(() => {
    drafts?.set(item.id, { score, comment, editing, edited, subject, body, payload, saved: status === 'Feedback saved' })
  }, [drafts, item.id, score, comment, editing, edited, subject, body, payload, status])

  async function save() {
    if (busy) return
    if (score.trim() === '' || !Number.isInteger(Number(score)) || Number(score) < 0 || Number(score) > 100) {
      setError('Enter a score from 0 to 100.'); return
    }
    setBusy(true); setError(''); setStatus('')
    try {
      const editedInput: unknown = edited
        ? kind === 'email' ? { ...original, subject, [field]: body }
          : kind === 'post' ? { ...original, [field]: body } : JSON.parse(payload)
        : saved?.editedInput
      await onFeedback(item, { score: Number(score), comment,
        ...(editedInput !== undefined && JSON.stringify(editedInput) !== JSON.stringify(item.input) ? { editedInput } : {}) })
      setStatus('Feedback saved')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Feedback could not be saved. Your edits are kept here.')
    } finally { setBusy(false) }
  }

  return (
    <form aria-label="Preview feedback" className="space-y-3 border-t border-border pt-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36 space-y-1">
          <Label htmlFor={`${id}-score`}>Score (0–100)</Label>
          <Input id={`${id}-score`} type="number" inputMode="numeric" min={0} max={100} step={1} required value={score}
            placeholder="Unscored" disabled={busy} onChange={(event) => { setScore(event.target.value); setStatus('') }} />
        </div>
        <Button type="button" variant="outline" aria-expanded={editing} disabled={busy} onClick={() => { setEditing((value) => !value); setStatus('') }}>Edit to teach</Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-comment`}>Comment</Label>
        <Textarea id={`${id}-comment`} value={comment} rows={2} disabled={busy} onChange={(event) => { setComment(event.target.value); setStatus('') }} />
      </div>
      {editing && <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Your edit is saved as a teaching example. Live approval applies to the original held payload.</p>
        {kind === 'email' && <div className="space-y-1"><Label htmlFor={`${id}-subject`}>Subject</Label><Input id={`${id}-subject`} value={subject} disabled={busy} onChange={(event) => { setSubject(event.target.value); setEdited(true); setStatus('') }} /></div>}
        {kind === 'email' || kind === 'post'
          ? <div className="space-y-1"><Label htmlFor={`${id}-body`}>{kind === 'email' ? 'Body' : 'Post text'}</Label><Textarea id={`${id}-body`} value={body} rows={6} disabled={busy} onChange={(event) => { setBody(event.target.value); setEdited(true); setStatus('') }} /></div>
          : <div className="space-y-1"><Label htmlFor={`${id}-payload`}>Payload</Label><Textarea id={`${id}-payload`} value={payload} rows={6} disabled={busy} onChange={(event) => { setPayload(event.target.value); setEdited(true); setStatus('') }} /></div>}
      </div>}
      {error && <p role="alert" className="text-sm text-[var(--surface-danger-text)]">{error}</p>}
      <div className="flex flex-wrap items-center gap-3"><Button type="submit" variant="outline" disabled={busy}>{busy ? 'Saving feedback…' : 'Save feedback'}</Button><p role="status" className="text-sm text-muted-foreground">{status}</p></div>
    </form>
  )
}
