import { useCallback, useLayoutEffect, useRef, useState } from 'react'

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
  const jumpToLatest = useCallback(() => {
    follow(true)
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
      previousTop.current = viewport.scrollTop
    }
  }, [viewport, follow])

  useLayoutEffect(() => {
    if (!viewport || !content) return
    previousTop.current = viewport.scrollTop
    const scroll = () => {
      const top = viewport.scrollTop
      // A scrollbar drag or keyboard scroll upward pauses even within the
      // bottom threshold. Only an actual return downward resumes following.
      if (top < previousTop.current) follow(false)
      else if (top > previousTop.current && viewport.scrollHeight - top - viewport.clientHeight <= 24) follow(true)
      previousTop.current = top
    }
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) follow(false) }
    let touchY = 0
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0 }
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? touchY
      if (nextY > touchY) follow(false)
      touchY = nextY
    }
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) follow(false)
    }
    const resize = () => { if (followingRef.current) jumpToLatest() }
    viewport.addEventListener('scroll', scroll)
    viewport.addEventListener('wheel', wheel, { passive: true })
    viewport.addEventListener('touchstart', touchStart, { passive: true })
    viewport.addEventListener('touchmove', touchMove, { passive: true })
    viewport.addEventListener('keydown', key)
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
    }
  }, [viewport, content, follow, jumpToLatest])

  return { viewportRef, contentRef, following, jumpToLatest }
}
