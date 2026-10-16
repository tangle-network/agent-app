import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Bookmark, Camera, ChevronLeft, ChevronRight, Heart, MessageCircle, MoreHorizontal, Repeat2, Search, Send, Share2, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Button } from '@tangle-network/ui/primitives'
import type { HubActionPreview, HubPreviewMedia } from '../hub-approvals'
import { embeddedPreviewImage, linkedText } from './email'

type Post = Extract<HubActionPreview, { kind: 'post' }>
const CHANNELS: Record<Post['channel'], string> = {
  x: 'X', linkedin: 'LinkedIn', slack: 'Slack', instagram: 'Instagram',
  facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube',
}

/** The host resolves frozen, authorized bytes before rendering. No URLs are fetched here. */
export function previewMediaSource(value: string | undefined, kind: 'image' | 'video'): string | undefined {
  if (!value) return undefined
  if (kind === 'image' && embeddedPreviewImage(value)) return value
  if (kind === 'video' && /^data:video\/(?:mp4|webm|ogg);base64,[a-z0-9+/=\s]+$/i.test(value)) return value
  if (!value.startsWith('blob:') || typeof window === 'undefined') return undefined
  try {
    const url = new URL(value)
    return window.location.origin !== 'null' && url.origin === window.location.origin ? value : undefined
  } catch { return undefined }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(true)
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(preference.matches)
    update(); preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])
  return reduced
}

function MediaAsset({ media, active = true, fit = 'cover' }: { media: HubPreviewMedia; active?: boolean; fit?: 'contain' | 'cover' }) {
  const source = previewMediaSource(media.src, media.kind)
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [source])
  useEffect(() => {
    const element = video.current
    if (!element || !source) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visible = false
    const update = () => {
      element.loop = !preference.matches
      if (active && visible && !preference.matches && !document.hidden) void element.play().catch(() => {})
      else element.pause()
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; update() })
    observer.observe(element)
    preference.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      observer.disconnect(); preference.removeEventListener('change', update)
      document.removeEventListener('visibilitychange', update); element.pause()
    }
  }, [source, active])
  const style: CSSProperties = { width: '100%', height: '100%', objectFit: fit }
  if (!source || failed) return <p role="status" className="flex h-full min-h-32 items-center justify-center p-5 text-center text-sm text-muted-foreground">{media.alt || 'Media'} — {failed ? 'could not be displayed' : 'not embedded in this preview'}</p>
  return media.kind === 'video'
    ? <video ref={video} src={source} poster={previewMediaSource(media.poster, 'image')} controls muted playsInline preload="metadata"
        aria-label={media.alt || 'Video preview'} style={style} onError={() => setFailed(true)} />
    : <img src={source} alt={media.alt} style={style} onError={() => setFailed(true)} />
}

function ratio(media: HubPreviewMedia | undefined, fallback: string) {
  return media?.width && media.height && Number.isFinite(media.width / media.height) && media.width > 0 && media.height > 0
    ? `${media.width} / ${media.height}` : fallback
}

function Carousel({ media, square = false }: { media: readonly HubPreviewMedia[]; square?: boolean }) {
  const id = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const reduced = useReducedMotion()
  const go = (next: number) => {
    const element = viewport.current
    if (element) element.scrollTo({ left: element.clientWidth * next, behavior: reduced ? 'auto' : 'smooth' })
  }
  return <div className="relative" data-hub-media-carousel>
    <div ref={viewport} id={id} role="region" aria-roledescription="carousel" aria-label="Post media" tabIndex={0}
      data-hub-media-carousel-scroll className="flex overflow-x-auto"
      style={{ scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain', scrollbarWidth: 'none', touchAction: 'pan-x pan-y' }}
      onScroll={(event) => setIndex(Math.max(0, Math.min(media.length - 1, Math.round(event.currentTarget.scrollLeft / (event.currentTarget.clientWidth || 1)))))}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'ArrowRight') { event.preventDefault(); go(Math.min(media.length - 1, index + 1)) }
        if (event.key === 'ArrowLeft') { event.preventDefault(); go(Math.max(0, index - 1)) }
      }}>
      {media.map((asset, position) => <div key={`${position}:${asset.src}`} role="group" aria-roledescription="slide" aria-label={`${position + 1} of ${media.length}`}
        data-hub-media-slide={position} style={{ flex: '0 0 100%', minWidth: 0, scrollSnapAlign: 'start', aspectRatio: ratio(media[0], square ? '1' : '16 / 9') }}>
        <MediaAsset media={asset} active={index === position} />
      </div>)}
    </div>
    {media.length > 1 && <>
      <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/65 px-2 py-1 text-xs tabular-nums text-white" aria-hidden>{index + 1}/{media.length}</span>
      <button type="button" aria-label="Previous slide" aria-controls={id} disabled={index === 0} onClick={() => go(index - 1)}
        className="absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#262626] shadow-sm disabled:hidden"><ChevronLeft aria-hidden className="size-5" /></button>
      <button type="button" aria-label="Next slide" aria-controls={id} disabled={index === media.length - 1} onClick={() => go(index + 1)}
        className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#262626] shadow-sm disabled:hidden"><ChevronRight aria-hidden className="size-5" /></button>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1" aria-hidden>
        {media.map((_, position) => <span key={position} className={`size-1.5 rounded-full ${position === index ? 'bg-[#0095f6]' : 'bg-white/75'}`} />)}
      </div>
      <p className="sr-only" aria-live="polite">Slide {index + 1} of {media.length}</p>
    </>}
  </div>
}

function Avatar({ name, square = false }: { name?: string | null; square?: boolean }) {
  return <span aria-hidden className={`flex size-10 shrink-0 items-center justify-center bg-[#eef0f2] text-base font-semibold text-[#536471] ${square ? 'rounded-sm' : 'rounded-full'}`}>{name?.charAt(0).toUpperCase() || '?'}</span>
}

/** Feed controls are visual context only; previews cannot like, share or follow. */
function ChromeActions({ channel, vertical = false }: { channel: Post['channel']; vertical?: boolean }) {
  const actions: Array<[string, ReactNode]> = channel === 'youtube'
    ? [['Like', <ThumbsUp />], ['Dislike', <ThumbsDown />], ['Comments', <MessageCircle />], ['Share', <Share2 />]]
    : channel === 'tiktok' ? [['Like', <Heart />], ['Comment', <MessageCircle />], ['Share', <Share2 />]]
      : channel === 'instagram' && vertical ? [['Like', <Heart />], ['Comment', <MessageCircle />], ['Repost', <Repeat2 />], ['Share', <Send />], ['More', <MoreHorizontal />]]
    : channel === 'linkedin' || channel === 'facebook'
      ? [['Like', <ThumbsUp />], ['Comment', <MessageCircle />], [channel === 'linkedin' ? 'Repost' : 'Share', channel === 'linkedin' ? <Repeat2 /> : <Share2 />]]
      : channel === 'x' ? [['Reply', <MessageCircle />], ['Repost', <Repeat2 />], ['Like', <Heart />], ['Bookmark', <Bookmark />], ['Share', <Share2 />]]
        : [['Like', <Heart />], ['Comment', <MessageCircle />], ['Share', <Send />], ['Save', <Bookmark />]]
  return <div aria-label="Feed controls shown for context" className={vertical ? 'flex flex-col items-center gap-5' : 'flex items-center justify-between gap-3'}>
    {actions.map(([label, icon]) => <span key={label} title={label} aria-label={label} className={`flex items-center gap-1.5 [&>svg]:size-5 ${vertical ? 'flex-col text-[10px]' : 'text-[13px]'}`}>
      {icon}{(channel === 'facebook' || channel === 'linkedin' || (vertical && channel === 'youtube')) && <span>{label}</span>}
    </span>)}
  </div>
}

function VerticalPreview({ preview, account, media }: { preview: Post; account?: string | null; media: readonly HubPreviewMedia[] }) {
  const [guides, setGuides] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const caption = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const [insets, setInsets] = useState<CSSProperties>({})
  const name = preview.displayName ?? account ?? 'Account unavailable'
  const title = preview.channel === 'youtube' ? 'Shorts' : preview.channel === 'instagram' || preview.channel === 'facebook' ? 'Reels' : 'For You'
  useEffect(() => {
    const update = () => {
      if (!frame.current || !top.current || !caption.current || !rail.current) return
      const bounds = frame.current.getBoundingClientRect()
      setInsets({ top: top.current.getBoundingClientRect().bottom - bounds.top,
        bottom: bounds.bottom - caption.current.getBoundingClientRect().top,
        right: bounds.right - rail.current.getBoundingClientRect().left + 8, left: 16 })
    }
    const observer = new ResizeObserver(update)
    for (const element of [frame.current, top.current, caption.current, rail.current]) if (element) observer.observe(element)
    update(); return () => observer.disconnect()
  }, [preview.text, preview.channel])
  return <div className="mx-auto w-full max-w-[360px] space-y-2">
    <div ref={frame} data-hub-media-vertical className="relative isolate aspect-[9/16] overflow-hidden rounded-xl bg-black text-white [color-scheme:dark]">
      <div className="absolute inset-0">{media[0] ? <MediaAsset media={media[0]} /> : <p className="p-5 text-sm">Media not embedded in this preview</p>}</div>
      <div ref={top} className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/65 to-transparent px-4 pb-5 pt-4">
        <span className="text-lg font-semibold">{preview.channel === 'tiktok' && <span className="mr-4 text-white/70">Following</span>}{title}</span>
        {preview.channel === 'instagram' ? <Camera aria-hidden className="size-5" /> : <Search aria-hidden className="size-5" />}
      </div>
      <div ref={rail} className="pointer-events-none absolute bottom-40 right-3 drop-shadow-md"><ChromeActions channel={preview.channel} vertical /></div>
      <div ref={caption} className="pointer-events-none absolute bottom-14 left-0 right-14 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8 text-sm drop-shadow-md">
        <p className="break-words font-semibold">{preview.handle ?? name}</p>
        {preview.sponsored && <p className="mt-1 text-xs">Sponsored</p>}
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words leading-5">{preview.text}</p>
        {preview.callToAction && <p className="mt-2 rounded-md border border-white/70 px-3 py-2 text-center font-semibold">{preview.callToAction}</p>}
      </div>
      {guides && <div data-hub-media-safe-zone aria-label="Area clear of this preview’s caption and controls" className="pointer-events-none absolute border-2 border-dashed border-white/90" style={{ ...insets, boxShadow: '0 0 0 999px rgb(0 0 0 / 25%)' }} />}
    </div>
    <Button type="button" variant="outline" aria-pressed={guides} onClick={() => setGuides(value => !value)}>{guides ? 'Hide caption safe zones' : 'Show caption safe zones'}</Button>
    {guides && <p className="text-xs leading-5 text-muted-foreground">Guide follows this preview’s caption and controls. Placement and device can change the area.</p>}
  </div>
}

/** Source-supplied payload and media inside platform feed frames. No transport or effect callbacks. */
export function HubMediaPreview({ preview, account }: { preview: Post; account?: string | null }) {
  const media: readonly HubPreviewMedia[] = preview.media ?? preview.images?.map(image => ({ kind: 'image' as const, src: image.url, alt: image.alt ?? '' })) ?? []
  const name = preview.displayName ?? account ?? 'Account unavailable'
  const count = <p data-hub-media-character-count className="text-right text-xs tabular-nums text-muted-foreground">{[...preview.text].length} characters</p>
  if (preview.placement === 'vertical') return <div className="space-y-2"><article aria-label={`${CHANNELS[preview.channel]} ${preview.channel === 'youtube' ? 'Shorts' : 'vertical'} preview`} data-hub-media-channel={preview.channel}><VerticalPreview preview={preview} account={account} media={media} /></article>{count}</div>
  const x = preview.channel === 'x'
  const instagram = preview.channel === 'instagram'
  const imageGrid = x && preview.placement !== 'carousel' && media.length > 1 && media.length <= 4 && media.every(asset => asset.kind === 'image')
  return <div className="space-y-2"><article aria-label={`${CHANNELS[preview.channel]} ${preview.sponsored ? 'sponsored ' : ''}feed preview`} data-hub-media-channel={preview.channel}
    className={`overflow-hidden border border-[#d8dee3] bg-white text-[#0f1419] [color-scheme:light] ${x ? 'rounded-2xl' : 'rounded-lg'}`}>
    <header className="flex min-w-0 items-start gap-3 px-4 pt-4">
      <Avatar name={preview.displayName ?? account} square={preview.channel === 'linkedin'} />
      <div className="min-w-0 flex-1 text-sm"><p className="break-words font-semibold">{name}{preview.handle && <span className="ml-1.5 font-normal text-[#536471]">{preview.handle}</span>}</p>
        {preview.sponsored && <p className="mt-0.5 text-xs text-[#536471]">{preview.channel === 'linkedin' || x ? 'Promoted' : 'Sponsored'}</p>}
      </div><MoreHorizontal aria-hidden className="size-5 shrink-0 text-[#536471]" />
    </header>
    {!instagram && <p className="whitespace-pre-wrap break-words px-4 py-3 text-[15px] leading-6">{linkedText(preview.text)}</p>}
    {media.length > 0 && <div className={x ? 'mx-4 overflow-hidden rounded-xl border border-[#d8dee3]' : ''}>
      {imageGrid ? <div data-hub-media-image-grid className="grid aspect-[16/9] grid-cols-2 gap-0.5 overflow-hidden">
        {media.map((asset, index) => <div key={index} className={`min-h-0 overflow-hidden ${media.length === 3 && index === 0 ? 'row-span-2' : ''}`}><MediaAsset media={asset} /></div>)}
      </div> : <Carousel media={media} square={instagram} />}
    </div>}
    {preview.link && <div className="border-b border-[#d8dee3] bg-[#f3f6f8] px-4 py-3">
      <p className="truncate text-xs text-[#536471]">{preview.link.url.replace(/^https?:\/\//, '')}</p>
      {preview.link.title && <p className="mt-1 break-words text-sm font-semibold">{preview.link.title}</p>}
      {preview.link.description && <p className="mt-1 line-clamp-2 text-sm text-[#536471]">{preview.link.description}</p>}
      {preview.callToAction && <span className="mt-2 inline-block rounded border border-[#536471] px-3 py-1.5 text-sm font-semibold">{preview.callToAction}</span>}
    </div>}
    <div className="px-4 py-3 text-[#536471]"><ChromeActions channel={preview.channel} /></div>
    {instagram && <p className="whitespace-pre-wrap break-words px-4 pb-4 text-sm leading-5"><strong className="mr-1.5">{preview.handle ?? name}</strong>{linkedText(preview.text)}</p>}
    <p className="sr-only">Preview controls cannot post, buy, like, or share.</p>
  </article>{count}</div>
}
