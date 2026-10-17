/**
 * The confirmation for a setting that costs money, reaches people, removes
 * something or acts outside the product. It states the consequence, any
 * from → to changes and an optional notice, can require the person to type a
 * name, and closes only when the write is confirmed: a refusal stays in the
 * dialog with the server's sentence, so the person can try again or cancel.
 *
 * Wide screens get an `AlertDialog`; below 40rem it is a bottom `Sheet` with
 * full-width buttons, the confirming one first.
 */

import {
  Alert,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@tangle-network/ui/primitives'
import { CircleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { useConfirmedMutation, type MutationOutcome } from '../web-react/async'

/** One value the action changes, shown as `label: from → to`. */
export interface ConfirmChange {
  label: string
  from: ReactNode
  to: ReactNode
}

export interface ConfirmActionProps<T = unknown> {
  /** The control that opens the dialog, such as a `Button`. Leave it out and drive `open` from a menu item. */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** A question naming the action: "Delete Fieldnote GTM?" */
  title: string
  /** What happens, in one or two sentences: cost, reach, what is removed and whether it can be undone. */
  consequence: ReactNode
  changes?: ConfirmChange[]
  /** A note the person should read before confirming, such as what else this allows. */
  notice?: ReactNode
  /** The verb on the confirming button: "Delete project", "Turn on". */
  confirmLabel: string
  cancelLabel?: string
  /** `danger` draws the confirming button destructive. */
  tone?: 'default' | 'danger'
  /** Fields the action needs, such as an address and a role. Drawn between the notice and `requireText`. */
  children?: ReactNode
  /** False keeps the confirming button unavailable, such as until a live check passes. */
  canConfirm?: boolean
  /** The text the person types before the action is available, such as the project name. */
  requireText?: string
  /** Performs the action. Only a confirmed outcome closes the dialog. */
  onConfirm: () => Promise<MutationOutcome<T>>
  /** Runs after a confirmed outcome, with its value: navigate away, refresh a list. */
  onConfirmed?: (value: T) => void
}

const NARROW = '(max-width: 40rem)'

function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined
  const query = window.matchMedia(NARROW)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(NARROW).matches),
    () => false,
  )
}

export function ConfirmAction<T = unknown>({
  trigger,
  open: openProp,
  onOpenChange,
  title,
  consequence,
  changes,
  notice,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  children,
  canConfirm = true,
  requireText,
  onConfirm,
  onConfirmed,
}: ConfirmActionProps<T>) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = openProp ?? innerOpen
  const [typed, setTyped] = useState('')
  const narrow = useNarrowViewport()
  const bodyRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inputId = useId()
  const errorId = useId()

  const mutation = useConfirmedMutation<void, T>({ mutate: () => onConfirm(), concurrency: 'reject' })
  const pending = mutation.state.status === 'pending'
  const failure = mutation.state.status === 'failed' ? mutation.state.message : null
  const { reset } = mutation

  const setOpen = useCallback((next: boolean) => {
    // A write in flight keeps the dialog: closing it would hide its outcome.
    if (!next && pending) return
    setInnerOpen(next)
    onOpenChange?.(next)
  }, [onOpenChange, pending])

  useEffect(() => {
    if (!open) return
    setTyped('')
    reset()
  }, [open, reset])

  const ready = canConfirm && (requireText === undefined || typed.trim() === requireText)
  const confirm = async () => {
    if (!ready || pending) return
    const outcome = await mutation.run()
    if (!outcome.succeeded) return
    setInnerOpen(false)
    onOpenChange?.(false)
    onConfirmed?.(outcome.value)
  }

  // A dialog with fields opens on its first field; otherwise on Cancel, so Enter never confirms by accident.
  const focusFirst = (event: Event) => {
    const target = bodyRef.current?.querySelector<HTMLElement>('input, textarea, [role="combobox"]') ?? cancelRef.current
    if (!target) return
    event.preventDefault()
    target.focus()
  }

  const hasBody = Boolean(changes?.length) || notice != null || children != null || requireText !== undefined || failure != null
  const body = hasBody && (
    <div ref={bodyRef} className="grid min-w-0 gap-4 text-sm">
      {changes && changes.length > 0 && (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border border-border px-4 py-3">
          {changes.map((change) => (
            <div key={change.label} className="contents">
              <dt className="text-muted-foreground">{change.label}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">
                <span className="text-muted-foreground">{change.from}</span>
                <span aria-hidden="true" className="px-1.5 text-muted-foreground">→</span>
                <span className="sr-only"> to </span>
                <span className="font-medium text-foreground">{change.to}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {notice != null && <Alert tone="info">{notice}</Alert>}
      {children}
      {requireText !== undefined && (
        <div className="grid gap-2">
          <Label htmlFor={inputId}>Type <span className="font-semibold [overflow-wrap:anywhere]">{requireText}</span> to confirm</Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={failure ? errorId : undefined}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void confirm()
              }
            }}
          />
        </div>
      )}
      {failure && (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-[var(--surface-danger-text)] [overflow-wrap:anywhere]">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{failure}</span>
        </p>
      )}
    </div>
  )

  const confirmButton = (
    <Button
      type="button"
      variant={tone === 'danger' ? 'destructive' : 'default'}
      loading={pending}
      disabled={!ready || pending}
      onClick={() => void confirm()}
      data-confirm-action
    >
      {confirmLabel}
    </Button>
  )

  if (narrow) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
        <SheetContent side="bottom" hideCloseButton onOpenAutoFocus={focusFirst} className="max-h-[90dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{consequence}</SheetDescription>
          </SheetHeader>
          {body && <div className="px-4">{body}</div>}
          <SheetFooter className="pb-[max(1rem,env(safe-area-inset-bottom))]">
            {confirmButton}
            <Button ref={cancelRef} type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>{cancelLabel}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent onOpenAutoFocus={focusFirst}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{consequence}</AlertDialogDescription>
        </AlertDialogHeader>
        {body}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={pending}>{cancelLabel}</AlertDialogCancel>
          {confirmButton}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
