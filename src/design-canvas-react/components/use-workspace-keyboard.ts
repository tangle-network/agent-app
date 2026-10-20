/** Canvas keyboard commands and single-commit held-arrow nudges. */
import { useRef, type Dispatch, type SetStateAction } from 'react'
import { addElementCommand, setAttrsCommand, multiSetAttrsCommand, deleteElementCommand, groupElementsCommand, ungroupElementCommand, type MultiSetAttrsEntry } from '../engine/commands'
import { findElement, type SceneElement } from '../../design-canvas/model'
import type { SceneCommand, SnapResult } from '../contracts'
import type { WorkspaceViewProps } from './Workspace'
import { NO_MARQUEE, type MarqueeState, type GestureMode } from './workspace-gesture-state'
import { nudgeDelta as nudgeDeltaMath } from './transform-math'

const DUPLICATE_OFFSET = 10

type WorkspaceKeyboardOptions = Pick<WorkspaceViewProps, 'stack' | 'activePage' | 'canWrite' | 'onApplyOperations'> & {
  state: ReturnType<WorkspaceViewProps['stack']['getState']>
  persist: (command: SceneCommand) => Promise<void>
  gestureRef: { current: GestureMode }
  spaceHeldRef: { current: boolean }
  setMarquee: Dispatch<SetStateAction<MarqueeState>>
  setActiveSnap: Dispatch<SetStateAction<SnapResult | null>>
  editingElementId: string | null
  setEditingElementId: Dispatch<SetStateAction<string | null>>
}

export function useWorkspaceKeyboard({ stack, state, activePage, canWrite, onApplyOperations, persist, gestureRef, spaceHeldRef, setMarquee, setActiveSnap, editingElementId, setEditingElementId }: WorkspaceKeyboardOptions) {
  const { document, activePageId, selectedElementIds } = state
  const nudgeHeldRef = useRef<{
    key: string
    ids: string[]
    origin: Map<string, { x: number; y: number }>
  } | null>(null)

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === ' ') {
      e.preventDefault()
      spaceHeldRef.current = true
      return
    }

    const mod = e.metaKey || e.ctrlKey

    if (e.key === 'Escape') {
      e.preventDefault()
      if (gestureRef.current !== 'idle') {
        gestureRef.current = 'idle'
        setMarquee(NO_MARQUEE)
        setActiveSnap(null)
      } else if (editingElementId) {
        setEditingElementId(null)
      } else {
        stack.setView({ selectedElementIds: [] })
      }
      return
    }

    if (editingElementId) return

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElementIds.length > 0) {
      e.preventDefault()
      // Stop the event reaching DesignCanvas's window-level keydown, which also
      // handles delete/undo/redo — without this the editor handles the key twice
      // (delete two history steps, undo twice) when Workspace mounts inside it.
      e.stopPropagation()
      for (const id of [...selectedElementIds]) {
        try {
          persist(deleteElementCommand({ document, pageId: activePageId, elementId: id }))
        } catch { /* element gone — skip */ }
      }
      stack.setView({ selectedElementIds: [] })
      return
    }

    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      if (stack.canUndo()) stack.undo()
      return
    }
    if (mod && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
      e.preventDefault()
      e.stopPropagation()
      if (stack.canRedo()) stack.redo()
      return
    }

    if (mod && e.key === 'a') {
      e.preventDefault()
      const ids = activePage.elements.filter((el) => !el.locked && el.visible).map((el) => el.id)
      stack.setView({ selectedElementIds: ids })
      return
    }

    if (mod && e.key === 'd' && selectedElementIds.length > 0) {
      e.preventDefault()
      for (const id of selectedElementIds) {
        const found = findElement(activePage, id)
        if (!found) continue
        const clone: SceneElement = {
          ...structuredClone(found.element),
          id: crypto.randomUUID(),
          x: found.element.x + DUPLICATE_OFFSET,
          y: found.element.y + DUPLICATE_OFFSET,
        }
        persist(addElementCommand({ pageId: activePageId, element: clone }))
      }
      return
    }

    if (mod && !e.shiftKey && e.key === 'g' && selectedElementIds.length >= 2) {
      e.preventDefault()
      persist(groupElementsCommand({
        document,
        pageId: activePageId,
        elementIds: selectedElementIds,
        groupId: crypto.randomUUID(),
      }))
      return
    }

    if (mod && e.shiftKey && e.key === 'g' && selectedElementIds.length === 1) {
      e.preventDefault()
      const id = selectedElementIds[0]!
      persist(ungroupElementCommand({ document, pageId: activePageId, groupId: id }))
      return
    }

    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && selectedElementIds.length > 0) {
      e.preventDefault()
      const key = e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
      if (nudgeHeldRef.current && nudgeHeldRef.current.key !== key) {
        flushNudge()
      }
      if (!nudgeHeldRef.current) {
        const origins = new Map<string, { x: number; y: number }>()
        for (const id of selectedElementIds) {
          const found = findElement(activePage, id)
          if (found) origins.set(id, { x: found.element.x, y: found.element.y })
        }
        nudgeHeldRef.current = { key, ids: selectedElementIds.slice(), origin: origins }
      }
      // Apply nudge optimistically each keydown via the command stack so the
      // user sees live movement; the held ref lets us coalesce all steps into
      // one undo entry on keyup.
      const { dx, dy } = nudgeDeltaMath(key, e.shiftKey)
      const entries: MultiSetAttrsEntry[] = []
      for (const [id, orig] of nudgeHeldRef.current.origin) {
        const found = findElement(activePage, id)
        if (!found) continue
        entries.push({
          pageId: activePageId,
          elementId: id,
          attrs: { x: found.element.x + dx, y: found.element.y + dy },
          priorAttrs: { x: found.element.x, y: found.element.y },
        })
      }
      if (entries.length > 0) {
        // Preview: silent local apply without remote persist (flushed on keyup).
        stack.execute(multiSetAttrsCommand(entries))
      }
    }
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === ' ') {
      spaceHeldRef.current = false
      return
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      flushNudge()
    }
  }

  function flushNudge() {
    const held = nudgeHeldRef.current
    if (!held) return
    nudgeHeldRef.current = null
    if (!canWrite || held.ids.length === 0) return

    // Build a single coalesced set_attrs from original positions to current.
    const entries: MultiSetAttrsEntry[] = []
    for (const id of held.ids) {
      const orig = held.origin.get(id)
      const found = findElement(activePage, id)
      if (!orig || !found) continue
      entries.push({
        pageId: activePageId,
        elementId: id,
        attrs: { x: found.element.x, y: found.element.y },
        priorAttrs: { x: orig.x, y: orig.y },
      })
    }
    if (entries.length > 0) {
      // Persist the coalesced nudge; the intermediate stack entries from
      // keydown previews become part of the committed ops batch.
      onApplyOperations(multiSetAttrsCommand(entries).operations()).catch(() => {
        // Roll back if remote rejects.
        for (const [id, orig] of held.origin) {
          const found = findElement(activePage, id)
          if (!found) continue
          persist(setAttrsCommand({
            pageId: activePageId,
            elementId: id,
            attrs: { x: orig.x, y: orig.y },
            priorAttrs: { x: found.element.x, y: found.element.y },
          }))
        }
      })
    }
  }

  return { handleKeyDown, handleKeyUp }
}
