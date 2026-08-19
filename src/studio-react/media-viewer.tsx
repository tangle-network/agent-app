import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Download, FolderOpen, FolderPlus, Pause, Play, Trash2, X } from 'lucide-react'

import {
  generationAspectRatio,
  generationError,
  generationSpecSegments,
  generationStatus,
  generationVaultPath,
  hashSeed,
  previewWaveformBars,
  relativeTime,
  WIDE_WAVEFORM_BARS,
  type Generation,
  type StudioMediaActions,
  type VaultSaveResult,
} from '../studio'
import { OVERLAY_SHADOW, POPOVER_SURFACE_ATTR, usePopover } from '../web-react/controls'
import { downloadGenerationsViaAnchor } from './download-generations'
import { formatClock, useStudioPlayback } from './studio-playback'
import { VaultPathPopover } from './vault-path-popover'

export interface MediaViewerModalProps {
  generation: Generation | null
  onClose: () => void
  actions?: StudioMediaActions
  /** Screens own the delete confirm; absent hides the Delete button. */
  onRequestDelete?: (generation: Generation) => void
  /** After a successful save from the footer popover. */
  onSaved?: (results: readonly VaultSaveResult[]) => void
}

const TYPE_LABELS: Record<string, string> = {
  image: 'Image',
  video: 'Video',
  speech: 'Audio',
  avatar: 'Avatar',
  transcription: 'Transcript',
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const footerButtonClass =
  'inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium hover:bg-accent'

function hasOpenPopover(): boolean {
  return typeof document !== 'undefined' && document.querySelector(`[${POPOVER_SURFACE_ATTR}]`) !== null
}

function Waveform({ generation }: { generation: Generation }): JSX.Element {
  const { registerPositionNode } = useStudioPlayback()
  const layersRef = useRef<HTMLDivElement>(null)
  const bars = useMemo(
    () => previewWaveformBars(generation.id, WIDE_WAVEFORM_BARS),
    [generation.id],
  )
  const hue = useMemo(() => hashSeed(generation.id) % 360, [generation.id])

  useEffect(() => registerPositionNode(generation.id, layersRef.current), [generation.id, registerPositionNode])

  const renderBars = () => bars.map((bar, index) => (
    <i key={index} style={{ height: `${bar.heightPct}%`, opacity: bar.opacity }} />
  ))
  return (
    <div
      className="absolute inset-0"
      style={{ background: `linear-gradient(158deg, hsl(${hue} 38% 24%), hsl(${(hue + 34) % 360} 46% 13%))` }}
    >
      <div ref={layersRef} className="studio-wave-layers" style={{ color: `hsl(${hue} 92% 74%)` }}>
        <div className="studio-wave studio-wave-base">{renderBars()}</div>
        <div className="studio-wave studio-wave-play">{renderBars()}</div>
      </div>
    </div>
  )
}

function AudioTransport({ generation }: { generation: Generation }): JSX.Element {
  const playback = useStudioPlayback()
  const elapsedRef = useRef<HTMLSpanElement>(null)
  const seekRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const pointerIdRef = useRef<number | null>(null)
  const [ariaPosition, setAriaPosition] = useState(0)
  const isPlaying = playback.activeId === generation.id && playback.playing
  const duration = playback.activeId === generation.id ? playback.durationSeconds : 0

  useEffect(() => playback.registerTimeNode(elapsedRef.current), [playback.registerTimeNode])
  useEffect(
    () => playback.registerPositionNode(generation.id, seekRef.current),
    [generation.id, playback.registerPositionNode],
  )
  useEffect(() => {
    setAriaPosition(playback.activeId === generation.id ? playback.getPositionSeconds() : 0)
  }, [generation.id, playback.activeId, playback.durationSeconds, playback.getPositionSeconds, playback.playing])

  const syncAriaPosition = useCallback(() => {
    setAriaPosition(playback.activeId === generation.id ? playback.getPositionSeconds() : 0)
  }, [generation.id, playback])

  function toggle() {
    playback.toggle(generation)
    syncAriaPosition()
  }

  function seekFromClientX(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || duration <= 0) return
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    playback.seekTo(generation, fraction * duration)
    setAriaPosition(fraction * duration)
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.focus()
    pointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture?.(event.pointerId)
    seekFromClientX(event.clientX)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== event.pointerId) return
    seekFromClientX(event.clientX)
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    pointerIdRef.current = null
    syncAriaPosition()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      playback.seekBy(event.key === 'ArrowLeft' ? -5 : 5)
      syncAriaPosition()
    } else if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault()
      toggle()
    }
  }

  const position = Math.max(0, duration > 0 ? Math.min(ariaPosition, duration) : ariaPosition)
  return (
    <div className="mt-3.5 flex items-center gap-3 px-0.5">
      <button
        type="button"
        aria-label={isPlaying ? 'Pause' : 'Play'}
        onClick={toggle}
        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-raised hover:brightness-110"
      >
        {isPlaying
          ? <Pause size={15} strokeWidth={1.5} fill="currentColor" />
          : <Play size={15} strokeWidth={1.5} fill="currentColor" />}
      </button>
      <span ref={elapsedRef} className="min-w-8 text-[12px] text-muted-foreground tabular-nums">
        {duration > 0 ? '0:00' : '--:--'}
      </span>
      <div
        ref={seekRef}
        className="studio-seek relative flex h-5 min-w-0 flex-1 cursor-pointer items-center"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={position}
        aria-valuetext={duration > 0 ? formatClock(position) : '--:--'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onKeyDown={onKeyDown}
      >
        <div ref={trackRef} className="relative h-1 w-full overflow-hidden rounded-full bg-accent">
          <div className="studio-seek-fill absolute inset-y-0 left-0 bg-primary" />
        </div>
        <div className="studio-seek-thumb absolute h-[13px] w-[13px] -translate-x-1/2 rounded-full bg-primary ring-2 ring-card" />
      </div>
      <span className="text-[12px] text-muted-foreground tabular-nums">
        {duration > 0 ? formatClock(duration) : '--:--'}
      </span>
    </div>
  )
}

export function MediaViewerModal({
  generation,
  onClose,
  actions,
  onRequestDelete,
  onSaved,
}: MediaViewerModalProps): JSX.Element | null {
  const playback = useStudioPlayback()
  const stopPlayback = playback.stop
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const priorFocusRef = useRef<HTMLElement | null>(null)
  const openSessionRef = useRef(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [savePending, setSavePending] = useState(false)
  const popover = usePopover(saveOpen, setSaveOpen)
  const open = generation !== null

  const stopAndRestore = useCallback(() => {
    if (!openSessionRef.current) return
    openSessionRef.current = false
    stopPlayback()
    const priorFocus = priorFocusRef.current
    if (priorFocus?.isConnected) priorFocus.focus()
  }, [stopPlayback])

  const close = useCallback(() => {
    setSaveOpen(false)
    stopAndRestore()
    onClose()
  }, [onClose, stopAndRestore])

  useEffect(() => {
    if (!open) return
    priorFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openSessionRef.current = true
    closeRef.current?.focus()
    return stopAndRestore
  }, [open, stopAndRestore])

  useEffect(() => {
    if (!open) return
    function onDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || hasOpenPopover()) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onDocumentKeyDown)
    return () => document.removeEventListener('keydown', onDocumentKeyDown)
  }, [close, open])

  if (!generation || typeof document === 'undefined') return null

  const ratio = generationAspectRatio(generation)
  const status = generationStatus(generation)
  const vaultPath = generationVaultPath(generation)
  const metaSegments = [
    TYPE_LABELS[generation.type] ?? generation.type,
    generation.model,
    ...generationSpecSegments(generation),
    generation.createdAt ? relativeTime(generation.createdAt) : null,
    vaultPath,
  ].filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || hasOpenPopover()) return
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    if (!focusable || focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  async function save(path: string) {
    if (!actions?.save || !generation) return
    setSavePending(true)
    try {
      const results = await actions.save({ generations: [generation], path })
      setSaveOpen(false)
      onSaved?.(results)
    } finally {
      setSavePending(false)
    }
  }

  function viewVault(event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) {
    if (!actions?.onOpenVault || !generation) return
    event.preventDefault()
    actions.onOpenVault(generation)
  }

  const mediaStyle: CSSProperties = generation.type === 'transcription'
    ? { width: '100%' }
    : {
      width: `min(100%, calc(70vh * ${ratio}))`,
      aspectRatio: ratio,
    }
  const vaultHref = vaultPath && actions?.vaultHref ? actions.vaultHref(vaultPath) : null
  const viewControl = vaultPath && (vaultHref || actions?.onOpenVault)
  const modal = (
    <div
      className="studio-layer-viewer studio-backdrop fixed inset-0 grid place-items-center p-6"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Media detail"
        onKeyDown={onPanelKeyDown}
        className={`studio-rise relative max-h-[92vh] w-[min(780px,100%)] overflow-auto rounded-[14px] border border-border bg-card p-3.5 ${OVERLAY_SHADOW}`}
      >
        <button
          ref={closeRef}
          type="button"
          aria-label="Close"
          onClick={close}
          className="absolute right-3.5 top-3.5 z-10 grid h-8 w-8 place-items-center rounded-full border border-border bg-card hover:bg-accent"
        >
          <X size={15} strokeWidth={1.5} />
        </button>

        <div className="flex justify-center">
          <div className="relative overflow-hidden rounded-xl border border-border bg-accent" style={mediaStyle}>
            {status === 'pending' || status === 'running' ? (
              <div className="studio-skeleton absolute inset-0" />
            ) : status === 'failed' ? (
              <div className="grid h-full w-full place-items-center bg-accent p-3 text-center text-[12px] text-destructive">
                {generationError(generation) ?? 'Generation failed'}
              </div>
            ) : generation.result === null ? (
              <div className="studio-skeleton absolute inset-0" />
            ) : generation.type === 'image' ? (
              <img src={generation.result} className="h-full w-full object-cover" alt={generation.prompt} />
            ) : generation.type === 'video' || generation.type === 'avatar' ? (
              <video src={generation.result} controls playsInline className="h-full w-full object-cover" />
            ) : generation.type === 'transcription' ? (
              <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap p-4 text-[13.5px] leading-relaxed">
                {generation.result ?? ''}
              </div>
            ) : generation.type === 'speech' ? (
              <Waveform generation={generation} />
            ) : null}
          </div>
        </div>

        {status !== 'failed' && generation.type === 'speech' && <AudioTransport generation={generation} />}

        <p className="mx-0.5 mb-1.5 mt-4 max-w-[62ch] text-[15px] leading-normal">{generation.prompt}</p>
        <div className="mx-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
          {metaSegments.join(' · ')}
        </div>

        <div className="mt-3.5 flex flex-wrap gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => { void (actions?.download ?? downloadGenerationsViaAnchor)([generation]) }}
            className={footerButtonClass}
          >
            <Download size={15} strokeWidth={1.5} /> Download
          </button>

          {!vaultPath && actions?.save && (
            <div ref={popover.containerRef}>
              <button
                {...popover.triggerProps}
                type="button"
                onClick={() => setSaveOpen((value) => !value)}
                className={footerButtonClass}
              >
                <FolderPlus size={15} strokeWidth={1.5} /> Save to vault
              </button>
              <VaultPathPopover
                open={saveOpen}
                triggerRef={popover.triggerRef}
                panelRef={popover.panelRef}
                generations={[generation]}
                onSubmit={save}
                onCancel={() => setSaveOpen(false)}
                pending={savePending}
              />
            </div>
          )}

          {viewControl && (vaultHref ? (
            <a href={vaultHref} onClick={viewVault} className={footerButtonClass}>
              <FolderOpen size={15} strokeWidth={1.5} /> View in vault
            </a>
          ) : (
            <button type="button" onClick={viewVault} className={footerButtonClass}>
              <FolderOpen size={15} strokeWidth={1.5} /> View in vault
            </button>
          ))}

          {onRequestDelete && (
            <button
              type="button"
              onClick={() => onRequestDelete(generation)}
              className={`${footerButtonClass} ml-auto text-destructive hover:border-destructive hover:bg-destructive/10`}
            >
              <Trash2 size={15} strokeWidth={1.5} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
