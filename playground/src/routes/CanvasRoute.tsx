import { useCallback, useState } from 'react'
import { DesignCanvasEditor } from '@tangle-network/agent-app/design-canvas-react'
import { applySceneOperations } from '@tangle-network/agent-app/design-canvas'
import type { SceneOperation } from '@tangle-network/agent-app/design-canvas'
import { makeSceneDocument } from '../fixtures'

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
      <DesignCanvasEditor document={doc} rev={rev} canWrite onApplyOperations={onApplyOperations} />
    </div>
  )
}
