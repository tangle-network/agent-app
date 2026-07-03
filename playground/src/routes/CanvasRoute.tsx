import { useCallback, useEffect, useState } from 'react'
import { CanvasInsertPanel, DesignCanvasEditor } from '@tangle-network/agent-app/design-canvas-react'
import { applySceneOperations } from '@tangle-network/agent-app/design-canvas'
import type { SceneOperation } from '@tangle-network/agent-app/design-canvas'
import { lightTheme, darkTheme } from '@tangle-network/agent-app/theme'
import { makeSceneDocument } from '../fixtures'

/** Read the live theme from the document element so the Konva canvas (which
 *  cannot resolve CSS vars) paints with the active palette. Tracks toggles via
 *  a MutationObserver on the `data-theme` attribute and `class` list. */
function useIsDark(): boolean {
  const read = () => {
    if (typeof document === 'undefined') return false
    const root = document.documentElement
    return root.getAttribute('data-theme') === 'dark' || root.classList.contains('dark')
  }
  const [isDark, setIsDark] = useState(read)
  useEffect(() => {
    const root = document.documentElement
    const obs = new MutationObserver(() => setIsDark(read()))
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    setIsDark(read())
    return () => obs.disconnect()
  }, [])
  return isDark
}

/**
 * Mounts the full design-canvas editor (toolbar, rulers, layers panel, pages
 * strip, zoom controls, Konva canvas) against a populated multi-element scene.
 *
 * The editor applies operations optimistically against its own command stack;
 * the host's job is to persist them and return the new revision. We reduce the
 * ops into our document state with the engine's own `applySceneOperations` so
 * the editor sees a coherent post-apply document on every save (the engine path
 * verified against the real engine, not a static echo).
 */
export function CanvasRoute() {
  const [doc, setDoc] = useState(() => makeSceneDocument())
  const [rev, setRev] = useState(1)
  const isDark = useIsDark()

  const onApplyOperations = useCallback(
    async (operations: SceneOperation[]) => {
      const nextRev = rev + 1
      // Reduce ops into the canonical document via the engine; if the engine
      // ever rejects an op we surface it (fail loud) rather than echoing stale.
      const next = applySceneOperations(doc, operations)
      setDoc(next)
      setRev(nextRev)
      return { rev: nextRev, document: next }
    },
    [doc, rev],
  )

  return (
    <div className="h-full w-full">
      <DesignCanvasEditor
        document={doc}
        rev={rev}
        canWrite
        onApplyOperations={onApplyOperations}
        renderSidePanel={({ activePage }) => (
          <CanvasInsertPanel
            canWrite
            page={{
              pageId: activePage.id,
              width: activePage.width,
              height: activePage.height,
              background: activePage.background,
            }}
            onInsert={onApplyOperations}
          />
        )}
        render={isDark ? darkTheme.canvasRender : lightTheme.canvasRender}
      />
    </div>
  )
}
