/** Fit an optional vault dock beside the document or inside its narrow pane. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { VaultPaneProps } from './contracts'

/** Narrowest pane that places a dock beside the document rather than in it. */
const DOCK_SIDE_MIN_PX = 960

export function useVaultDockPlacement(renderDock: VaultPaneProps['renderDock']) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dockInline, setDockInline] = useState(false)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !renderDock || typeof ResizeObserver === 'undefined') return
    const apply = (width: number) => { if (width > 0) setDockInline(width < DOCK_SIDE_MIN_PX) }
    apply(root.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? 0))
    observer.observe(root)
    return () => observer.disconnect()
  }, [renderDock])
  return { rootRef, dockInline }
}
