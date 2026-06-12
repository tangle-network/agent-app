/**
 * Program monitor: a canvas letterboxed to the sequence aspect that paints
 * the playhead frame — black base, the topmost enabled video-track clip via
 * `frameProvider.drawFrame`, then caption text bottom-centered on an 80%
 * black backing bar with type scaled to canvas height / 18.
 *
 * Track stacking: tracks composite bottom-up, so among clips active at the
 * frame the one on the HIGHEST sortOrder track covers the rest; muted tracks
 * do not render. Only `video` tracks paint — `reference` tracks are
 * non-rendered guide media (model contract) and are excluded from mp4/EDL/
 * contact-sheet export, so painting them would preview content the program
 * output does not contain. Paints serialize through a latest-wins queue —
 * decode is async, so a slow seek never paints over a newer frame.
 *
 * `sourceSeconds` = (sourceInFrame + playhead offset into the clip) / fps:
 * the model maps source frames 1:1 at sequence fps.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { framesToSeconds, snapshotFrame } from '../../sequences/model'
import type { SequenceTimeline } from '../../sequences/model'
import type { PlaybackClock, VideoFrameProvider } from '../contracts'
import { captionFontPx, letterboxRect } from './interaction-math'

export interface PreviewCanvasProps {
  timeline: SequenceTimeline
  clock: PlaybackClock
  frameProvider: VideoFrameProvider
  className?: string
}

interface CanvasSize {
  width: number
  height: number
}

export function PreviewCanvas({ timeline, clock, frameProvider, className }: PreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState<CanvasSize | null>(null)
  const [drawError, setDrawError] = useState<string | null>(null)
  const paintQueueRef = useRef<{ running: boolean; queuedFrame: number | null }>({ running: false, queuedFrame: null })
  /** Latest paint inputs, readable from the async queue without re-binding it. */
  const paintInputsRef = useRef({ timeline, frameProvider, size })
  paintInputsRef.current = { timeline, frameProvider, size }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    function measure() {
      const node = containerRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      // Zero-size during layout/hidden tabs is a transient, not an error.
      if (rect.width <= 0 || rect.height <= 0) return
      const fit = letterboxRect({
        containerWidth: rect.width,
        containerHeight: rect.height,
        mediaWidth: timeline.sequence.width,
        mediaHeight: timeline.sequence.height,
      })
      setSize((current) => {
        const next = { width: Math.round(fit.width), height: Math.round(fit.height) }
        return current && current.width === next.width && current.height === next.height ? current : next
      })
    }
    measure()
    // ResizeObserver is absent in non-browser test environments; the single
    // mount measure above still sizes the canvas there.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [timeline.sequence.width, timeline.sequence.height])

  const requestPaint = useMemo(() => {
    async function paint(frame: number) {
      const { timeline: current, frameProvider: provider, size: cssSize } = paintInputsRef.current
      const canvas = canvasRef.current
      if (!canvas || !cssSize) return
      const ctx = canvas.getContext('2d')
      // Canvas 2D is unavailable in non-browser test environments; layout
      // still renders, only pixels are skipped.
      if (!ctx) return
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
      const backingWidth = Math.round(cssSize.width * dpr)
      const backingHeight = Math.round(cssSize.height * dpr)
      if (canvas.width !== backingWidth) canvas.width = backingWidth
      if (canvas.height !== backingHeight) canvas.height = backingHeight
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cssSize.width, cssSize.height)

      // The playhead may rest at durationFrames (sequence end); paint the
      // final addressable frame there.
      const paintFrame = Math.max(0, Math.min(frame, current.sequence.durationFrames - 1))
      const snapshot = snapshotFrame(current, paintFrame)

      const mediaEntries = snapshot.active.filter(({ track, clip }) => (
        track.kind === 'video' && !track.muted && clip.media !== undefined && (clip.media.kind === 'video' || clip.media.kind === 'image')
      ))
      const top = mediaEntries[mediaEntries.length - 1]
      if (top && top.clip.media) {
        const sourceSeconds = framesToSeconds(top.clip.sourceInFrame + (paintFrame - top.clip.startFrame), current.sequence.fps)
        await provider.drawFrame(top.clip.media.url, sourceSeconds, ctx, {
          x: 0,
          y: 0,
          width: cssSize.width,
          height: cssSize.height,
        })
      }

      if (snapshot.captions.length > 0) {
        const fontPx = captionFontPx(cssSize.height)
        ctx.font = `600 ${fontPx}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const barHeight = fontPx * 1.6
        let centerY = cssSize.height - barHeight
        for (const caption of [...snapshot.captions].reverse()) {
          const textWidth = Math.min(ctx.measureText(caption.text).width, cssSize.width * 0.86)
          const barWidth = textWidth + fontPx * 1.2
          ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
          ctx.fillRect((cssSize.width - barWidth) / 2, centerY - barHeight / 2, barWidth, barHeight)
          ctx.fillStyle = '#fff'
          ctx.fillText(caption.text, cssSize.width / 2, centerY, cssSize.width * 0.86)
          centerY -= barHeight + fontPx * 0.25
        }
      }
    }

    return function requestPaint(frame: number) {
      const queue = paintQueueRef.current
      if (queue.running) {
        queue.queuedFrame = frame
        return
      }
      queue.running = true
      void (async () => {
        let next: number | null = frame
        while (next !== null) {
          const target = next
          queue.queuedFrame = null
          try {
            await paint(target)
            setDrawError(null)
          } catch (error) {
            setDrawError(error instanceof Error ? error.message : String(error))
          }
          next = queue.queuedFrame
        }
        queue.running = false
      })()
    }
  }, [])

  useEffect(() => {
    requestPaint(clock.getFrame())
    return clock.subscribe(requestPaint)
  }, [clock, requestPaint])

  // Timeline edits and canvas resizes repaint the held frame.
  useEffect(() => {
    requestPaint(clock.getFrame())
  }, [timeline, size, clock, requestPaint])

  return (
    <div ref={containerRef} className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        data-preview-canvas
        className="block"
        style={size ? { width: `${size.width}px`, height: `${size.height}px` } : { width: '100%', height: '100%' }}
      />
      {drawError ? (
        <p className="absolute inset-x-3 bottom-2 truncate rounded bg-rose-950/80 px-2 py-1 text-center text-xs text-rose-200" role="alert">
          {drawError}
        </p>
      ) : null}
    </div>
  )
}
