/**
 * Transformer-based selection layer. Attaches a Konva.Transformer to all
 * currently-selected Konva nodes so the user can resize and rotate them.
 *
 * SINGLE vs. MULTI:
 * - Single selection: resize + rotate.
 * - Multi-selection: rigid resize (keepRatio enforced) + rotate.
 *
 * Rotation snap: within 5° of 0/45/90/135/180 the rotation locks to the
 * nearest cardinal/diagonal (same threshold as the snapRotation pure function).
 *
 * Scale baking: Konva's Transformer sets scaleX/scaleY on the node during
 * a transform gesture. On transformend we read the final x/y/width/height/
 * scaleX/scaleY/rotation from each node, bake scale into width/height, and
 * emit ONE multiSetAttrsCommand. Scale never persists on Konva nodes across
 * render cycles — the next render resets scaleX=scaleY=1 by rendering from
 * model attrs.
 *
 * Special baking per kind:
 * - rect/ellipse/image/video/group: bakeRectTransform (scale → width/height).
 * - line: bakeLineTransform (scale baked into points array).
 * - text: bakeTextTransform (scaleX→width, scaleY→fontSize).
 * - ellipse: center position is adjusted back to top-left model coords via
 *   ellipseTopLeftFromCenter before emitting attrs.
 *
 * Min-size guard: width/height are clamped to ≥ 4px after baking so users
 * cannot collapse an element to zero and lose it.
 *
 * The overlay: prefix on the Transformer name lets export logic skip it.
 */

import { useEffect, useRef } from 'react'
import { Layer, Transformer } from 'react-konva'
import type Konva from 'konva'
import {
  bakeRectTransform,
  bakeLineTransform,
  bakeTextTransform,
  ellipseTopLeftFromCenter,
  snapRotation,
} from './transform-math'
import type { MultiSetAttrsEntry } from '../engine/commands'
import type { SceneAttrsPatch } from '../../design-canvas/operations'
import type { SceneElement } from '../../design-canvas/model'

export interface SelectionLayerProps {
  /** Konva stage reference to look up selected nodes by name. */
  stageRef: React.RefObject<Konva.Stage | null>
  /** Selected element ids from editor state. */
  selectedIds: string[]
  /** The model elements corresponding to selectedIds (pre-gesture snapshot). */
  selectedElements: SceneElement[]
  /** Whether the canvas is writable. False → transformer renders but is not interactive. */
  canWrite: boolean
  /** Emitted when a transform gesture completes with final attrs per element. */
  onTransformEnd(entries: MultiSetAttrsEntry[]): void
  /** Active page id — every entry in onTransformEnd carries this. */
  pageId: string
}

const MIN_SIZE = 4

export function SelectionLayer({
  stageRef,
  selectedIds,
  selectedElements,
  canWrite,
  onTransformEnd,
  pageId,
}: SelectionLayerProps) {
  const trRef = useRef<Konva.Transformer | null>(null)

  // Sync the transformer's attached nodes whenever selection changes.
  useEffect(() => {
    const tr = trRef.current
    const stage = stageRef.current
    if (!tr || !stage) return

    const nodes: Konva.Node[] = []
    for (const id of selectedIds) {
      // Nodes carry their element id as their `name` prop.
      const node = stage.findOne(`[name="${id}"]`)
      if (node) nodes.push(node)
    }
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  }, [selectedIds, stageRef])

  function handleTransformEnd() {
    const tr = trRef.current
    if (!tr) return
    const nodes = tr.nodes() as Konva.Node[]
    if (nodes.length === 0) return

    const entries: MultiSetAttrsEntry[] = []

    for (const node of nodes) {
      const elementId = node.name()
      const element = selectedElements.find((e) => e.id === elementId)
      if (!element) continue

      const priorAttrs = elementToPriorAttrs(element)
      const finalAttrs = bakeNodeToAttrs(node, element)
      if (!finalAttrs) continue

      entries.push({ pageId, elementId, attrs: finalAttrs, priorAttrs })
    }

    if (entries.length > 0) onTransformEnd(entries)
  }

  const multiSelect = selectedIds.length > 1

  return (
    // The Layer must participate in the hit graph (listening) or the Transformer
    // anchors below receive no pointer events and resize/rotate is dead. We scope
    // listening to canWrite so a read-only canvas stays fully click-through.
    // Click-through to elements for selection is preserved: this layer paints
    // only the Transformer, whose anchors are the sole hit targets — empty
    // regions have no shapes, so pointer hits fall through to the content layer.
    // Export exclusion is unaffected: export.ts hides nodes by the 'overlay:'
    // name prefix, not by `listening` (see export-math.isExportHiddenNodeName).
    <Layer name="overlay:selection" listening={canWrite}>
      <Transformer
        ref={trRef}
        name="overlay:transformer"
        // keepRatio for multi-select so the group scales uniformly.
        keepRatio={multiSelect}
        // Rotation snap: the rotationSnaps array controls the magnetism in
        // Konva's transformer. We pass the cardinal/diagonal angles; Konva
        // applies a threshold internally. We also call snapRotation() on
        // transformend for fine-grain 5° threshold enforcement.
        rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
        rotationSnapTolerance={5}
        // Min size so elements cannot be collapsed.
        boundBoxFunc={(oldBox, newBox) => {
          if (newBox.width < MIN_SIZE || newBox.height < MIN_SIZE) return oldBox
          return newBox
        }}
        listening={canWrite}
        onTransformEnd={canWrite ? handleTransformEnd : undefined}
      />
    </Layer>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the current model attrs as a "prior" patch for undo. */
function elementToPriorAttrs(element: SceneElement): SceneAttrsPatch {
  const base: SceneAttrsPatch = {
    x: element.x,
    y: element.y,
    rotation: element.rotation,
  }
  switch (element.kind) {
    case 'rect':
    case 'image':
    case 'video':
      return { ...base, width: element.width, height: element.height }
    case 'ellipse':
      return { ...base, width: element.width, height: element.height }
    case 'line':
      return { ...base, points: element.points.slice() }
    case 'text':
      return { ...base, width: element.width, fontSize: element.fontSize }
    case 'group':
      return { ...base, width: undefined, height: undefined }
  }
}

/**
 * Read final attrs from a Konva node after a transformer gesture and bake
 * scale into model dimensions. Returns null when the element kind has no
 * meaningful size to bake (shouldn't happen in practice).
 */
function bakeNodeToAttrs(node: Konva.Node, element: SceneElement): SceneAttrsPatch | null {
  // Snap rotation within 5° of cardinal/diagonal angles.
  const rawRotation = node.rotation()
  const snappedRotation = snapRotation(rawRotation, 5)

  const baseNode = {
    x: node.x(),
    y: node.y(),
    width: node.width(),
    height: node.height(),
    scaleX: node.scaleX(),
    scaleY: node.scaleY(),
    rotation: snappedRotation,
  }

  switch (element.kind) {
    case 'rect':
    case 'image':
    case 'video':
    case 'group': {
      const baked = bakeRectTransform(baseNode)
      return {
        x: baked.x,
        y: baked.y,
        width: Math.max(MIN_SIZE, baked.width),
        height: Math.max(MIN_SIZE, baked.height),
        rotation: baked.rotation,
      }
    }
    case 'ellipse': {
      // Konva.Ellipse's transformer node is centered (Konva reports x/y as
      // center coords, radiusX/radiusY via width/height halved). We must
      // convert back to model top-left coords.
      const baked = bakeRectTransform(baseNode)
      // After baking, node.x/y for an ellipse is its center because that's
      // how we placed it in ElementNode. Convert to top-left.
      const topLeft = ellipseTopLeftFromCenter({
        x: baked.x,
        y: baked.y,
        // radiusX/radiusY = half of baked width/height
        radiusX: baked.width / 2,
        radiusY: baked.height / 2,
      })
      return {
        x: topLeft.x,
        y: topLeft.y,
        width: Math.max(MIN_SIZE, topLeft.width),
        height: Math.max(MIN_SIZE, topLeft.height),
        rotation: baked.rotation,
      }
    }
    case 'line': {
      const points = (node as Konva.Line).points()
      const baked = bakeLineTransform({ ...baseNode, points })
      return {
        x: baked.x,
        y: baked.y,
        rotation: baked.rotation,
        points: baked.points,
      }
    }
    case 'text': {
      const baked = bakeTextTransform({
        ...baseNode,
        fontSize: element.fontSize,
      })
      return {
        x: baked.x,
        y: baked.y,
        width: Math.max(MIN_SIZE, baked.width),
        rotation: baked.rotation,
        fontSize: Math.max(1, baked.fontSize),
      }
    }
  }
}
