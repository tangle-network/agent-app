import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { OVERLAY_SHADOW } from '../web-react/controls'

export interface StudioToastInput {
  message: string
  action?: { label: string; run: () => void }
  durationMs?: number
  /** Fires exactly once when the toast leaves for ANY reason. */
  onDismiss?: (reason: 'timeout' | 'dismissed' | 'action') => void
}

type DismissReason = 'timeout' | 'dismissed' | 'action'
type ToastRecord = StudioToastInput & { id: string; leaving: boolean }

interface StudioToastContextValue {
  toast: (input: StudioToastInput) => string
  dismiss: (id: string) => void
  setDockLift: (px: number | null) => void
}

const StudioToastContext = createContext<StudioToastContextValue | null>(null)

function StudioToast({ record, leave }: { record: ToastRecord; leave: (id: string, reason: DismissReason) => void }) {
  useEffect(() => {
    if (record.leaving) return
    const duration = record.durationMs ?? 3500
    if (duration === 0) return
    const timer = window.setTimeout(() => leave(record.id, 'timeout'), duration)
    return () => window.clearTimeout(timer)
  }, [leave, record.durationMs, record.id, record.leaving])

  return (
    <div
      role="status"
      className={`pointer-events-auto flex max-w-[min(94vw,480px)] items-center gap-2.5 rounded-[10px] border border-border bg-card py-2 pl-[13px] pr-2 text-[13px] ${OVERLAY_SHADOW} ${record.leaving ? 'studio-toast-out' : 'studio-toast-in'}`}
    >
      <span className="min-w-0 truncate">{record.message}</span>
      {record.action && (
        <button
          type="button"
          onClick={() => {
            record.action?.run()
            leave(record.id, 'action')
          }}
          className="rounded-lg border-0 px-2 py-1 text-[13px] font-semibold text-primary hover:bg-primary/10"
        >
          {record.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => leave(record.id, 'dismissed')}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}

export function StudioToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const [dockLift, setDockLift] = useState<number | null>(null)
  const [mounted, setMounted] = useState(false)
  const sequence = useRef(0)
  const dismissed = useRef(new Set<string>())
  const records = useRef(new Map<string, ToastRecord>())
  const removalTimers = useRef(new Set<number>())
  const active = useRef(true)

  const leave = useCallback((id: string, reason: DismissReason) => {
    if (dismissed.current.has(id)) return
    const record = records.current.get(id)
    if (!record) return
    dismissed.current.add(id)
    record.onDismiss?.(reason)
    setToasts((current) => current.map((toast) => toast.id === id ? { ...toast, leaving: true } : toast))
    const timer = window.setTimeout(() => {
      removalTimers.current.delete(timer)
      records.current.delete(id)
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 180)
    removalTimers.current.add(timer)
  }, [])

  const toast = useCallback((input: StudioToastInput) => {
    const id = `studio-toast-${++sequence.current}`
    if (!active.current) return id
    const record: ToastRecord = { ...input, id, leaving: false }
    records.current.set(id, record)
    setToasts((current) => [...current, record])
    return id
  }, [])

  const dismiss = useCallback((id: string) => leave(id, 'dismissed'), [leave])
  const value = useMemo(() => ({ toast, dismiss, setDockLift }), [dismiss, toast])

  // Match the server and first client render to avoid an SSR hydration mismatch (#465).
  useEffect(() => {
    setMounted(true)
    return () => {
      active.current = false
      for (const timer of removalTimers.current) window.clearTimeout(timer)
      removalTimers.current.clear()
      records.current.clear()
      dismissed.current.clear()
    }
  }, [])

  return (
    <StudioToastContext.Provider value={value}>
      {children}
      {mounted && createPortal(
        <div
          role="region"
          aria-label="Notifications"
          style={{ bottom: dockLift ? dockLift + 10 : 22 }}
          className="studio-layer-toasts pointer-events-none fixed left-1/2 flex -translate-x-1/2 flex-col items-center gap-2"
        >
          {toasts.map((record) => <StudioToast key={record.id} record={record} leave={leave} />)}
        </div>,
        document.body,
      )}
    </StudioToastContext.Provider>
  )
}

export function useStudioToast(): StudioToastContextValue {
  const context = useContext(StudioToastContext)
  if (!context) throw new Error('useStudioToast must be used within a StudioToastProvider')
  return context
}
