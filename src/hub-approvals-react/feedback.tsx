import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { Button, Input, Label, Textarea } from '@tangle-network/ui/primitives'
import { presentHubAction, type HubActionPreview, type HubApprovalFeedback, type HubApprovalItem } from '../hub-approvals'

export interface HubPreviewFeedbackProps {
  item: HubApprovalItem
  onFeedback: (item: HubApprovalItem, feedback: HubApprovalFeedback) => Promise<void>
  /** Owner-local drafts survive collapsing/switching previews, never another viewer. */
  drafts?: Map<string, ReviewFeedbackDraft>
}

export interface ReviewFeedbackDraft { score: string; comment: string; editing: boolean; edited: boolean; subject: string; body: string; payload: string; saved: boolean }
export type ReviewVerdict = 'approve' | 'reject' | 'request_changes'
export interface ReviewFeedbackFormHandle {
  focusScore: () => void
  focusComment: () => void
  submitVerdict: (verdict: ReviewVerdict) => Promise<void>
}
export interface ReviewFeedbackFormProps {
  input: unknown
  preview?: HubActionPreview
  feedback?: HubApprovalFeedback
  draftKey: string
  drafts?: Map<string, ReviewFeedbackDraft>
  onFeedback?: (feedback: HubApprovalFeedback) => Promise<void>
  onVerdict?: (verdict: ReviewVerdict, feedback: HubApprovalFeedback) => Promise<void>
  allowedVerdicts?: readonly ReviewVerdict[]
  approveLabel?: string
  disabled?: boolean
  editNote?: string
}

/** One form for Hub previews, assets and work products. Hosts own storage and authority. */
export const ReviewFeedbackForm = forwardRef<ReviewFeedbackFormHandle, ReviewFeedbackFormProps>(function ReviewFeedbackForm({
  input, preview, feedback: saved, draftKey, drafts, onFeedback, onVerdict,
  allowedVerdicts = ['approve', 'reject', 'request_changes'], approveLabel = 'Approve', disabled = false,
  editNote = 'Your edit is saved as a teaching example.',
}, ref) {
  const id = useId()
  const scoreInput = useRef<HTMLInputElement>(null)
  const commentInput = useRef<HTMLTextAreaElement>(null)
  const original = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const priorInput = saved?.editedInput !== undefined ? saved.editedInput : input
  const prior = priorInput && typeof priorInput === 'object' && !Array.isArray(priorInput) ? priorInput as Record<string, unknown> : {}
  const kind = preview?.kind
  const container = kind === 'post' && original.container && typeof original.container === 'object' && !Array.isArray(original.container)
    ? original.container as Record<string, unknown> : null
  const nestedCaption = container && typeof container.caption === 'string'
  const copyField = ['text', 'commentary', 'caption', 'message', 'title'].find((key) => typeof original[key] === 'string')
  const editablePost = kind === 'post' && (nestedCaption || copyField)
  const field = kind === 'email'
    ? typeof original.html === 'string' ? 'html' : typeof original.body === 'string' ? 'body' : 'text'
    : nestedCaption ? 'caption' : copyField ?? 'text'
  const priorText = nestedCaption && prior.container && typeof prior.container === 'object'
    ? (prior.container as Record<string, unknown>)[field] : prior[field]
  const draft = drafts?.get(draftKey)
  const [score, setScore] = useState(draft?.score ?? (saved ? String(saved.score) : ''))
  const [comment, setComment] = useState(draft?.comment ?? saved?.comment ?? '')
  const [editing, setEditing] = useState(draft?.editing ?? false)
  const [edited, setEdited] = useState(draft?.edited ?? saved?.editedInput !== undefined)
  const [subject, setSubject] = useState(draft?.subject ?? String(prior.subject ?? ''))
  const [body, setBody] = useState(draft?.body ?? String(priorText ?? ''))
  const [payload, setPayload] = useState(draft?.payload ?? JSON.stringify(priorInput ?? null, null, 2))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState((draft ? draft.saved : saved) ? 'Feedback saved' : '')
  const [error, setError] = useState('')

  useEffect(() => {
    drafts?.set(draftKey, { score, comment, editing, edited, subject, body, payload, saved: status === 'Feedback saved' })
  }, [drafts, draftKey, score, comment, editing, edited, subject, body, payload, status])

  async function save(verdict?: ReviewVerdict) {
    if (busy || disabled || (verdict ? !onVerdict || !allowedVerdicts.includes(verdict) : !onFeedback)) return
    if (verdict && verdict !== 'approve' && !comment.trim()) {
      setError('Add a note before rejecting or requesting changes.'); commentInput.current?.focus(); return
    }
    if (score.trim() === '' || !Number.isInteger(Number(score)) || Number(score) < 0 || Number(score) > 100) {
      setError('Enter a score from 0 to 100.'); scoreInput.current?.focus(); return
    }
    setBusy(true); setError(''); setStatus('')
    try {
      const editedInput: unknown = edited
        ? kind === 'email' ? { ...original, subject, [field]: body }
          : editablePost ? nestedCaption ? { ...original, container: { ...container, [field]: body } } : { ...original, [field]: body } : JSON.parse(payload)
        : saved?.editedInput
      const value: HubApprovalFeedback = { score: Number(score), comment,
        ...(editedInput !== undefined && JSON.stringify(editedInput) !== JSON.stringify(input) ? { editedInput } : {}) }
      if (verdict) await onVerdict!(verdict, value)
      else await onFeedback!(value)
      setStatus('Feedback saved')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Feedback could not be saved. Your edits are kept here.')
    } finally { setBusy(false) }
  }
  useImperativeHandle(ref, () => ({ focusScore: () => { scoreInput.current?.focus(); scoreInput.current?.select() },
    focusComment: () => commentInput.current?.focus(), submitVerdict: (verdict) => save(verdict) }))

  return (
    <form aria-label="Preview feedback" className="space-y-3 border-t border-border pt-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy || disabled} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36 space-y-1">
          <Label htmlFor={`${id}-score`}>Score (0–100)</Label>
          <Input ref={scoreInput} id={`${id}-score`} type="number" inputMode="numeric" min={0} max={100} step={1} required value={score}
            placeholder="Unscored" disabled={busy} onChange={(event) => { setScore(event.target.value); setStatus('') }} />
        </div>
        <Button type="button" variant="outline" aria-expanded={editing} disabled={busy} onClick={() => { setEditing((value) => !value); setStatus('') }}>Edit to teach</Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-comment`}>Comment</Label>
        <Textarea ref={commentInput} id={`${id}-comment`} value={comment} rows={2} disabled={busy} onChange={(event) => { setComment(event.target.value); setStatus('') }} />
      </div>
      {editing && <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{editNote}</p>
        {kind === 'email' && <div className="space-y-1"><Label htmlFor={`${id}-subject`}>Subject</Label><Input id={`${id}-subject`} value={subject} disabled={busy} onChange={(event) => { setSubject(event.target.value); setEdited(true); setStatus('') }} /></div>}
        {kind === 'email' || editablePost
          ? <div className="space-y-1"><Label htmlFor={`${id}-body`}>{kind === 'email' ? 'Body' : 'Post text'}</Label><Textarea id={`${id}-body`} value={body} rows={6} disabled={busy} onChange={(event) => { setBody(event.target.value); setEdited(true); setStatus('') }} /></div>
          : <div className="space-y-1"><Label htmlFor={`${id}-payload`}>Payload</Label><Textarea id={`${id}-payload`} value={payload} rows={6} disabled={busy} onChange={(event) => { setPayload(event.target.value); setEdited(true); setStatus('') }} /></div>}
      </div>}
      {error && <p role="alert" className="text-sm text-[var(--surface-danger-text)]">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {onVerdict && allowedVerdicts.map(verdict => <Button key={verdict} type="button" variant={verdict === 'approve' ? 'default' : 'outline'} disabled={busy}
          aria-keyshortcuts={verdict === 'approve' ? 'A' : verdict === 'request_changes' ? 'R' : undefined}
          onClick={() => void save(verdict)}>{verdict === 'approve' ? approveLabel : verdict === 'reject' ? 'Reject' : 'Request changes'}</Button>)}
        {onFeedback && <Button type="submit" variant="outline" disabled={busy}>{busy ? 'Saving feedback…' : 'Save feedback'}</Button>}
        <p role="status" className="text-sm text-muted-foreground">{busy && !onFeedback ? 'Saving review…' : status}</p>
      </div>
      </fieldset>
    </form>
  )
})

/** Existing Hub adapter: teaching never calls the effect transport. */
export function HubPreviewFeedback({ item, onFeedback, drafts }: HubPreviewFeedbackProps) {
  const draftKey = JSON.stringify([item.id, item.actionPath, item.input])
  return <ReviewFeedbackForm key={draftKey} input={item.input} preview={presentHubAction(item).preview} feedback={item.feedback} draftKey={draftKey} drafts={drafts}
    onFeedback={(feedback) => onFeedback(item, feedback)} editNote="Your edit is saved as a teaching example. Live approval applies to the original held payload." />
}
