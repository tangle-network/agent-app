import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { Generation } from '../studio/generation'

export interface StudioAudioElementLike {
  src: string
  currentTime: number
  readonly duration: number
  play(): Promise<void> | void
  pause(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface StudioPlayback {
  activeId: string | null
  playing: boolean
  durationSeconds: number
  play(generation: Generation): void
  pause(): void
  toggle(generation: Generation): void
  stop(): void
  seekTo(generation: Generation, seconds: number): void
  seekBy(seconds: number): void
  getPositionSeconds(): number
  registerPositionNode(id: string, node: HTMLElement | null): () => void
  registerTimeNode(node: HTMLElement | null): () => void
}

const StudioPlaybackContext = createContext<StudioPlayback | null>(null)

const createBrowserAudioElement = (): StudioAudioElementLike => new Audio()

export function formatClock(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`
}

function metadataDuration(generation: Generation): number {
  const duration = generation.metadata?.durationSeconds
  return typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, duration) : 0
}

function clampPosition(seconds: number, duration: number): number {
  const finiteSeconds = Number.isFinite(seconds) ? seconds : 0
  return Math.max(0, duration > 0 ? Math.min(finiteSeconds, duration) : finiteSeconds)
}

export function StudioPlaybackProvider(props: {
  children: ReactNode
  createAudioElement?: () => StudioAudioElementLike
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState(0)

  const activeIdRef = useRef<string | null>(null)
  const playingRef = useRef(false)
  const durationRef = useRef(0)
  const createAudioElementRef = useRef(props.createAudioElement ?? createBrowserAudioElement)
  createAudioElementRef.current = props.createAudioElement ?? createBrowserAudioElement
  const audioRef = useRef<StudioAudioElementLike | null>(null)
  const audioListenersRef = useRef<{
    loadedmetadata: () => void
    ended: () => void
  } | null>(null)
  const positionNodesRef = useRef(new Map<string, Set<HTMLElement>>())
  const timeNodeRef = useRef<HTMLElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const playAttemptRef = useRef(0)

  const setActive = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveId(id)
  }, [])

  const setIsPlaying = useCallback((value: boolean) => {
    playingRef.current = value
    setPlaying(value)
  }, [])

  const setDuration = useCallback((value: number) => {
    const normalized = Number.isFinite(value) ? Math.max(0, value) : 0
    durationRef.current = normalized
    setDurationSeconds(normalized)
  }, [])

  const paintAll = useCallback(() => {
    const currentId = activeIdRef.current
    const position = currentId ? Math.max(0, audioRef.current?.currentTime ?? 0) : 0
    const duration = durationRef.current
    const fraction = duration > 0 ? Math.min(1, position / duration) : 0

    for (const [id, nodes] of positionNodesRef.current) {
      const isActive = id === currentId && (playingRef.current || position > 0)
      for (const node of nodes) {
        node.style.setProperty('--pos', isActive ? fraction.toFixed(4) : '0')
        if (isActive) node.dataset.active = 'true'
        else delete node.dataset.active
      }
    }
    if (timeNodeRef.current) timeNodeRef.current.textContent = formatClock(position)
  }, [])

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(animationFrameRef.current)
    }
    animationFrameRef.current = null
  }, [])

  const startAnimation = useCallback(() => {
    if (animationFrameRef.current !== null || typeof requestAnimationFrame !== 'function') return
    const frame = () => {
      animationFrameRef.current = null
      paintAll()
      if (playingRef.current) animationFrameRef.current = requestAnimationFrame(frame)
    }
    animationFrameRef.current = requestAnimationFrame(frame)
  }, [paintAll])

  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current
    const audio = createAudioElementRef.current()
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration)
      paintAll()
    }
    const onEnded = () => {
      playAttemptRef.current += 1
      audio.currentTime = 0
      setIsPlaying(false)
      cancelAnimation()
      paintAll()
    }
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)
    audioListenersRef.current = { loadedmetadata: onLoadedMetadata, ended: onEnded }
    audioRef.current = audio
    return audio
  }, [cancelAnimation, paintAll, setDuration, setIsPlaying])

  const adopt = useCallback((generation: Generation) => {
    const audio = ensureAudio()
    if (activeIdRef.current !== generation.id) {
      audio.src = generation.result ?? ''
      audio.currentTime = 0
      setDuration(metadataDuration(generation))
      setActive(generation.id)
    }
    return audio
  }, [ensureAudio, setActive, setDuration])

  const play = useCallback((generation: Generation) => {
    if (!generation.result) return
    const audio = adopt(generation)
    const attempt = ++playAttemptRef.current
    setIsPlaying(false)
    cancelAnimation()
    paintAll()

    try {
      const result = audio.play()
      if (result && typeof result.then === 'function') {
        void result.then(() => {
          if (playAttemptRef.current !== attempt || activeIdRef.current !== generation.id) return
          setIsPlaying(true)
          paintAll()
          startAnimation()
        }, () => {
          if (playAttemptRef.current !== attempt) return
          setIsPlaying(false)
          cancelAnimation()
          paintAll()
        })
      } else {
        setIsPlaying(true)
        paintAll()
        startAnimation()
      }
    } catch {
      if (playAttemptRef.current === attempt) {
        setIsPlaying(false)
        cancelAnimation()
        paintAll()
      }
    }
  }, [adopt, cancelAnimation, paintAll, setIsPlaying, startAnimation])

  const pause = useCallback(() => {
    playAttemptRef.current += 1
    audioRef.current?.pause()
    setIsPlaying(false)
    cancelAnimation()
    paintAll()
  }, [cancelAnimation, paintAll, setIsPlaying])

  const stop = useCallback(() => {
    playAttemptRef.current += 1
    audioRef.current?.pause()
    if (audioRef.current) audioRef.current.currentTime = 0
    setIsPlaying(false)
    setActive(null)
    cancelAnimation()
    paintAll()
  }, [cancelAnimation, paintAll, setActive, setIsPlaying])

  const toggle = useCallback((generation: Generation) => {
    if (activeIdRef.current === generation.id && playingRef.current) pause()
    else play(generation)
  }, [pause, play])

  const seekTo = useCallback((generation: Generation, seconds: number) => {
    if (!generation.result) return
    const changedTrack = activeIdRef.current !== generation.id
    const audio = adopt(generation)
    if (changedTrack) {
      playAttemptRef.current += 1
      setIsPlaying(false)
      cancelAnimation()
    }
    audio.currentTime = clampPosition(seconds, durationRef.current)
    paintAll()
  }, [adopt, cancelAnimation, paintAll, setIsPlaying])

  const seekBy = useCallback((seconds: number) => {
    if (!activeIdRef.current || !audioRef.current) return
    audioRef.current.currentTime = clampPosition(audioRef.current.currentTime + seconds, durationRef.current)
    paintAll()
  }, [paintAll])

  const getPositionSeconds = useCallback(() => audioRef.current?.currentTime ?? 0, [])

  const registerPositionNode = useCallback((id: string, node: HTMLElement | null) => {
    if (!node) {
      const nodes = positionNodesRef.current.get(id)
      if (nodes) {
        for (const registered of nodes) {
          registered.style.setProperty('--pos', '0')
          delete registered.dataset.active
        }
      }
      positionNodesRef.current.delete(id)
      return () => {}
    }
    const nodes = positionNodesRef.current.get(id) ?? new Set<HTMLElement>()
    nodes.add(node)
    positionNodesRef.current.set(id, nodes)
    paintAll()
    return () => {
      nodes.delete(node)
      if (nodes.size === 0) positionNodesRef.current.delete(id)
    }
  }, [paintAll])

  const registerTimeNode = useCallback((node: HTMLElement | null) => {
    timeNodeRef.current = node
    paintAll()
    return () => {
      if (timeNodeRef.current === node) timeNodeRef.current = null
    }
  }, [paintAll])

  useEffect(() => {
    paintAll()
  }, [activeId, durationSeconds, paintAll, playing])

  useEffect(() => () => {
    playAttemptRef.current += 1
    cancelAnimation()
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    const listeners = audioListenersRef.current
    if (listeners) {
      audio.removeEventListener('loadedmetadata', listeners.loadedmetadata)
      audio.removeEventListener('ended', listeners.ended)
    }
  }, [cancelAnimation])

  const value = useMemo<StudioPlayback>(() => ({
    activeId,
    playing,
    durationSeconds,
    play,
    pause,
    toggle,
    stop,
    seekTo,
    seekBy,
    getPositionSeconds,
    registerPositionNode,
    registerTimeNode,
  }), [
    activeId,
    durationSeconds,
    getPositionSeconds,
    pause,
    play,
    playing,
    registerPositionNode,
    registerTimeNode,
    seekBy,
    seekTo,
    stop,
    toggle,
  ])

  return <StudioPlaybackContext.Provider value={value}>{props.children}</StudioPlaybackContext.Provider>
}

export function useStudioPlayback(): StudioPlayback {
  const playback = useContext(StudioPlaybackContext)
  if (!playback) throw new Error('useStudioPlayback must be used within a StudioPlaybackProvider')
  return playback
}
