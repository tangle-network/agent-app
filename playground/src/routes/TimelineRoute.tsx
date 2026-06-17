import { useCallback, useMemo, useState } from 'react'
import { TimelineEditor } from '@tangle-network/agent-app/sequences-react'
import type { SequenceApplyResult } from '@tangle-network/agent-app/sequences'
import type { SequenceOperation } from '@tangle-network/agent-app/sequences'
import { makeTimeline, makeSolidFrameProvider } from '../fixtures'

/**
 * Mounts the timeline editor (program monitor, transport row, ruler, video +
 * caption tracks) against a populated sequence. The frame provider is the
 * simplest valid one: it paints a solid color into the preview rect, no media
 * decode — enough for the preview monitor to render real pixels.
 *
 * onApplyOperations echoes an index-aligned `SequenceApplyResult[]` so the
 * editor's optimistic-id reconciliation has a well-formed reply for any edit.
 */
export function TimelineRoute() {
  const [timeline] = useState(() => makeTimeline())
  const frameProvider = useMemo(() => makeSolidFrameProvider(), [])

  const onApplyOperations = useCallback(
    async (operations: SequenceOperation[]): Promise<SequenceApplyResult[]> => {
      // Visual playground: the host doesn't persist. Return an index-aligned
      // result array so reconciliation never warns about a length mismatch.
      // Non-clip ops report a sequence echo; the editor only reads `clip` kinds.
      return operations.map(() => ({ kind: 'sequence', sequence: timeline.sequence }))
    },
    [timeline],
  )

  return (
    <div className="h-full w-full">
      <TimelineEditor
        timeline={timeline}
        canWrite
        frameProvider={frameProvider}
        onApplyOperations={onApplyOperations}
      />
    </div>
  )
}
