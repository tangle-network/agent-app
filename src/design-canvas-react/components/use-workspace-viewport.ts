/** Canvas measurement, automatic fit, and host fit/export callback refs. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type Konva from 'konva'
import type { WorkspaceViewProps } from './Workspace'
import type { ExportTriggerOptions } from '../contracts'
import type { createZoomPanMath } from '../engine/zoom-pan'
import { exportPageDataUrl } from '../export'

type WorkspaceViewportOptions = Pick<WorkspaceViewProps, 'stack' | 'activePage' | 'onFitRef' | 'onExport' | 'onExportRef' | 'onReady'> & {
  activePageId: string
  fitOnMount: boolean
  zoomPanMath: ReturnType<typeof createZoomPanMath>
}

export function useWorkspaceViewport({ stack, activePage, activePageId, fitOnMount, onReady, onFitRef, onExport, onExportRef, zoomPanMath }: WorkspaceViewportOptions) {
  // -------------------------------------------------------------------------
  // Container sizing
  // -------------------------------------------------------------------------

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 })
  // Auto-fit stays live until the user takes control of the view (wheel zoom,
  // pan, zoom controls, explicit fit). While live, every container re-measure
  // re-fits: the first measurement can be a transient (composite grids and
  // mounting chrome settle over several frames), and a one-shot fit would lock
  // the page at the transient size's zoom — the 5% clamp for small cells.
  const autoFitRef = useRef(true)
  const lastAutoFitRef = useRef<{ zoom: number; panX: number; panY: number; width: number; height: number } | null>(null)
  const readyRef = useRef(false)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setContainerSize({ width, height })
      if (width <= 0 || height <= 0) return

      // A view that no longer matches our last auto-fit means the user owns
      // the view now — never yank their zoom on a later resize.
      const view = stack.getState()
      const last = lastAutoFitRef.current
      if (last && (view.zoom !== last.zoom || view.panX !== last.panX || view.panY !== last.panY)) {
        autoFitRef.current = false
      }
      // Re-fit only when the measured size CHANGED. Effect re-subscriptions
      // (page switch, document edit) re-fire the observer with the same size;
      // re-fitting there would clobber the zoom+pan the page switch preserved.
      if (
        autoFitRef.current &&
        fitOnMount &&
        activePage.width > 0 &&
        activePage.height > 0 &&
        (!last || last.width !== width || last.height !== height)
      ) {
        const fit = zoomPanMath.fitPage(activePage, { width, height })
        stack.setView(fit)
        lastAutoFitRef.current = { ...fit, width, height }
      }
      // One-shot ready signal on the first real measurement.
      if (!readyRef.current) {
        readyRef.current = true
        onReady?.()
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [activePage, fitOnMount, onReady, stack, zoomPanMath])

  const stageRef = useRef<Konva.Stage | null>(null)

  // -------------------------------------------------------------------------
  // Fit-page callback — exposed via onFitRef so the chrome can trigger it
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!onFitRef) return
    onFitRef.current = () => {
      const { width, height } = containerSize
      if (width <= 0 || height <= 0) return
      const view = zoomPanMath.fitPage(activePage, { width, height })
      stack.setView(view)
    }
    return () => {
      // Only clear if we still own the slot (multiple WorkspaceView mounts
      // would each try to own it; the last to mount wins, but on unmount we
      // must not clear a ref filled by a newer mount).
      if (onFitRef.current !== null) onFitRef.current = null
    }
  })

  // -------------------------------------------------------------------------
  // Export callback — the chrome's Export control calls this through the ref;
  // the workspace owns the stage, so it renders here and forwards the result.
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!onExportRef || !onExport) return
    onExportRef.current = ({ format, pixelRatio }: ExportTriggerOptions) => {
      const stage = stageRef.current
      if (!stage) return
      void (async () => {
        const dataUrl = await exportPageDataUrl(stage, activePage, { format, pixelRatio })
        await onExport({ pageId: activePageId, format, dataUrl, pixelRatio })
      })()
    }
    return () => {
      if (onExportRef.current !== null) onExportRef.current = null
    }
  })

  return { containerRef, containerSize, stageRef }
}
