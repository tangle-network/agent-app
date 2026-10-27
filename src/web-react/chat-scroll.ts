import { useCallback, useRef, useState } from 'react'
import { useBrowserLayoutEffect } from './controls'

/** Follow a growing transcript only while its reader stays at the bottom.
 * Bind the refs to the scrolling viewport and its content. ResizeObserver also
 * covers streamed markdown, image loads and tool disclosures without callers
 * maintaining a list of every update that can change the transcript height.
 */
export function useChatScroll() {
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null)
  const [content, contentRef] = useState<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  const previousTop = useRef(0)
  const follow = useCallback((value: boolean) => {
    followingRef.current = value
    setFollowing(value)
  }, [])
  const scrollToBottom = useCallback(() => {
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
      previousTop.current = viewport.scrollTop
    }
  }, [viewport])
  const jumpToLatest = useCallback(() => {
    follow(true)
    scrollToBottom()
    viewport?.focus({ preventScroll: true })
  }, [viewport, follow, scrollToBottom])

  useBrowserLayoutEffect(() => {
    if (!viewport || !content) return
    if (!followingRef.current) viewport.scrollTop = previousTop.current
    previousTop.current = viewport.scrollTop
    const scroll = () => { previousTop.current = viewport.scrollTop }
    const resumeAtBottom = () => requestAnimationFrame(() => {
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24) follow(true)
    })
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) follow(false)
      else if (event.deltaY > 0) resumeAtBottom()
    }
    let touchY = 0
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0 }
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? touchY
      if (nextY > touchY) follow(false)
      else if (nextY < touchY) resumeAtBottom()
      touchY = nextY
    }
    const key = (event: KeyboardEvent) => {
      // Native End targets an old bottom while output is still growing.
      // An explicit return to latest follows the current bottom immediately.
      if (event.key === 'End' && event.target === viewport) {
        event.preventDefault()
        follow(true)
        scrollToBottom()
      }
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) follow(false)
      if (['ArrowDown', 'PageDown'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) resumeAtBottom()
    }
    let scrollbar = false
    const pointerDown = (event: PointerEvent) => {
      scrollbar = event.target === viewport && event.offsetX >= viewport.clientWidth
      if (scrollbar) follow(false)
    }
    const pointerUp = () => {
      if (scrollbar) resumeAtBottom()
      scrollbar = false
    }
    const resize = () => { if (followingRef.current) scrollToBottom() }
    viewport.addEventListener('scroll', scroll)
    viewport.addEventListener('wheel', wheel, { passive: true })
    viewport.addEventListener('touchstart', touchStart, { passive: true })
    viewport.addEventListener('touchmove', touchMove, { passive: true })
    viewport.addEventListener('keydown', key)
    viewport.addEventListener('pointerdown', pointerDown)
    viewport.addEventListener('pointerup', pointerUp)
    viewport.addEventListener('pointercancel', pointerUp)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(content)
    observer?.observe(viewport)
    resize()
    return () => {
      observer?.disconnect()
      viewport.removeEventListener('scroll', scroll)
      viewport.removeEventListener('wheel', wheel)
      viewport.removeEventListener('touchstart', touchStart)
      viewport.removeEventListener('touchmove', touchMove)
      viewport.removeEventListener('keydown', key)
      viewport.removeEventListener('pointerdown', pointerDown)
      viewport.removeEventListener('pointerup', pointerUp)
      viewport.removeEventListener('pointercancel', pointerUp)
    }
  }, [viewport, content, follow, scrollToBottom])

  return { viewportRef, contentRef, following, jumpToLatest }
}
