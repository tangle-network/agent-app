/**
 * The settings page: a `PageHeader`, one link per section and the current
 * section's cards, in `PageShell measure="settings"`. Each section is its own
 * URL, so a product routes `/settings/<section>` and loads only that
 * section's data. The frame answers to the content area's width: from 60rem
 * the links are a sticky 13rem column beside a 48rem column of cards, and
 * below that a sticky 56px tab strip whose current tab is kept in view.
 *
 * Navigation responds at once: the clicked link becomes current before the
 * route resolves, nothing dims, and a thin progress line shows only after the
 * pending delay. A `#hash` scrolls its section (or row) into view and focuses
 * its heading.
 */

import { Button, PageHeader, PageShell } from '@tangle-network/ui/primitives'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { PENDING_DELAY_MS } from './save-status'

/** An icon component such as a `lucide-react` icon. It shows only in the column. */
export type SettingsIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>

export interface SettingsNavSection {
  id: string
  label: string
  /** The section's own URL. */
  href: string
  icon?: SettingsIcon
  /** Leaves the link out, for a section the viewer's role cannot open. */
  hidden?: boolean
  /** A short count after the label, such as the number of members. */
  badge?: ReactNode
}

/** What a `LinkComponent` receives: render an anchor (or a router link) with these props. */
export interface SettingsLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string
  children?: ReactNode
}

export type SettingsLinkComponent = ComponentType<SettingsLinkProps>

export interface SettingsNavProps {
  sections: SettingsNavSection[]
  /** The section the route rendered. */
  activeId: string
  /**
   * Renders each link: pass the router's link (with prefetch off where the
   * edge refuses prefetch requests). Defaults to a plain anchor.
   */
  LinkComponent?: SettingsLinkComponent
  /** Called once per section when a pointer rests on or focus reaches its link: warm its route module here. */
  onIntent?: (section: SettingsNavSection) => void
}

export interface SettingsLayoutProps extends SettingsNavProps {
  /** The page title, such as "Project settings". */
  title: ReactNode
  /** One line under the title, such as the workspace name. */
  description?: ReactNode
  /** A second line under the description, such as "Setup in progress · Finish setup". */
  meta?: ReactNode
  /** The current section's `SettingsSection` cards. */
  children: ReactNode
  /** The navigation landmark's name. */
  navigationLabel?: string
  /** Bounds the frame the layout answers to, such as `mx-auto max-w-5xl`. */
  className?: string
}

function PlainLink({ href, children, ...rest }: SettingsLinkProps) {
  return <a href={href} {...rest}>{children}</a>
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
}

/** The section a click made current before its route resolved; cleared when the route lands or history moves. */
function useOptimisticSection(activeId: string) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  useEffect(() => setPendingId(null), [activeId])
  useEffect(() => {
    const clear = () => setPendingId(null)
    window.addEventListener('popstate', clear)
    return () => window.removeEventListener('popstate', clear)
  }, [])
  return { currentId: pendingId ?? activeId, pending: pendingId !== null && pendingId !== activeId, setPendingId }
}

/** The edge panel a chevron sits on: a 44px touch target that takes no room in the strip. */
const CUE_PANEL = 44
const STRIP_GAP = 4

/** Chevrons on the strip's edges while links lie past them. They page the strip; touch and trackpads scroll it natively. */
function useStripOverflow(listRef: RefObject<HTMLUListElement | null>) {
  const [overflow, setOverflow] = useState({ start: false, end: false })
  const strip = useCallback(() => listRef.current?.parentElement ?? null, [listRef])
  useLayoutEffect(() => {
    const nav = strip()
    if (!nav) return
    const measure = () => {
      // The column never scrolls sideways, so it never shows a chevron.
      const scrolls = getComputedStyle(nav).overflowX !== 'visible' && nav.scrollWidth > nav.clientWidth + 1
      const start = scrolls && nav.scrollLeft > 1
      const end = scrolls && nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1
      setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    measure()
    nav.addEventListener('scroll', measure, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resize?.observe(nav)
    if (listRef.current) resize?.observe(listRef.current)
    return () => {
      nav.removeEventListener('scroll', measure)
      resize?.disconnect()
    }
  }, [listRef, strip])
  const page = (direction: 1 | -1) => {
    const nav = strip()
    if (!nav) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    nav.scrollBy({ left: direction * nav.clientWidth * 0.75, behavior: reduce ? 'auto' : 'smooth' })
  }
  return { overflow, page }
}

/**
 * A chevron on a solid panel at the strip's edge, as `SegmentedControl` draws
 * its own: a fade over a tab's text shows nothing. The panel's shadow paints
 * the page gutter too, so no half-hidden label shows beyond it.
 */
function ScrollCue({ side, onPage }: { side: 'start' | 'end'; onPage: () => void }) {
  const start = side === 'start'
  const Icon = start ? ChevronLeft : ChevronRight
  const gutter = start ? 'calc(-1 * var(--tangle-settings-gutter, 0px))' : 'var(--tangle-settings-gutter, 0px)'
  return (
    <Button
      type="button"
      variant="bare"
      tabIndex={-1}
      aria-hidden="true"
      data-scroll-cue={side}
      onClick={onPage}
      className={`sticky z-[1] mb-px flex shrink-0 items-center self-stretch bg-background ${start ? 'left-0 justify-start' : 'right-0 justify-end'}`}
      style={{
        width: CUE_PANEL,
        [start ? 'marginRight' : 'marginLeft']: -(CUE_PANEL + STRIP_GAP),
        boxShadow: `${gutter} 0 0 0 hsl(var(--background))`,
      }}
    >
      <span className="flex size-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm">
        <Icon aria-hidden="true" className="size-4" />
      </span>
    </Button>
  )
}

interface NavLinksProps extends SettingsNavProps {
  currentId: string
  onPick: (id: string) => void
}

function NavLinks({ sections, currentId, LinkComponent = PlainLink, onIntent, onPick }: NavLinksProps) {
  const listRef = useRef<HTMLUListElement>(null)
  const warmed = useRef(new Set<string>())
  const { overflow, page } = useStripOverflow(listRef)
  const intent = (section: SettingsNavSection) => {
    if (!onIntent || warmed.current.has(section.id)) return
    warmed.current.add(section.id)
    onIntent(section)
  }
  return (
    <>
      {overflow.start && <ScrollCue side="start" onPage={() => page(-1)} />}
      <ul ref={listRef} role="list">
        {sections.filter((section) => !section.hidden).map((section) => {
          const Icon = section.icon
          const current = section.id === currentId
          return (
            <li key={section.id}>
              <LinkComponent
                href={section.href}
                aria-current={current ? 'page' : undefined}
                data-settings-section={section.id}
                onPointerEnter={() => intent(section)}
                onFocus={() => intent(section)}
                onClick={(event) => {
                  if (isPlainClick(event)) onPick(section.id)
                }}
              >
                {Icon && <Icon aria-hidden="true" />}
                <span>{section.label}</span>
                {section.badge != null && <span data-count="">{section.badge}</span>}
              </LinkComponent>
            </li>
          )
        })}
      </ul>
      {overflow.end && <ScrollCue side="end" onPage={() => page(1)} />}
    </>
  )
}

/**
 * The section links alone, for a page that composes its own
 * `PageShell measure="settings"`: pass it as the shell's `navigation`, which
 * draws the column, the tab strip and the current link.
 */
export function SettingsNav(props: SettingsNavProps) {
  const { currentId, setPendingId } = useOptimisticSection(props.activeId)
  return <NavLinks {...props} currentId={currentId} onPick={setPendingId} />
}

/** Scrolls `#hash` into view and focuses its heading; without a hash, a section change starts at the top. */
function useSectionScroll(activeId: string, rootRef: RefObject<HTMLDivElement | null>) {
  const first = useRef(true)
  useEffect(() => {
    const reveal = () => {
      const hash = decodeURIComponent(window.location.hash.slice(1))
      const target = hash ? document.getElementById(hash) : null
      if (!target) return false
      target.scrollIntoView({ block: 'start' })
      const heading = document.getElementById(`${hash}-title`) ?? target.querySelector<HTMLElement>('h2, h3, label') ?? target
      if (!heading.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(heading.tagName)) heading.setAttribute('tabindex', '-1')
      heading.focus({ preventScroll: true })
      return true
    }
    if (!reveal() && !first.current) rootRef.current?.scrollIntoView({ block: 'start' })
    first.current = false
    const onHash = () => void reveal()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [activeId, rootRef])
}

/** True once `pending` has lasted the pending delay. */
function useDelayed(pending: boolean): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!pending) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), PENDING_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending])
  return shown
}

export function SettingsLayout({
  title,
  description,
  meta,
  sections,
  activeId,
  LinkComponent,
  onIntent,
  navigationLabel = 'Settings sections',
  className,
  children,
}: SettingsLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { currentId, pending, setPendingId } = useOptimisticSection(activeId)
  const showProgress = useDelayed(pending)
  useSectionScroll(activeId, rootRef)
  const visible = sections.filter((section) => !section.hidden)
  // PageHeader's level-2 title is the operational 20px size; titleAs keeps it the page's h1.
  // The meta line rides in the description so it keeps the 14px floor.
  const header = (
    <PageHeader
      level={2}
      titleAs="h1"
      title={title}
      description={description != null || meta != null
        ? <>{description}{meta != null && <span className="mt-1 block">{meta}</span>}</>
        : undefined}
    />
  )
  return (
    <div ref={rootRef} className="relative min-w-0" data-settings-layout>
      {showProgress && (
        <div role="progressbar" aria-label="Opening section" className="pointer-events-none absolute inset-x-0 top-0 z-[4] h-0.5 overflow-hidden">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--accent-text)] motion-reduce:animate-none" />
        </div>
      )}
      <PageShell
        measure="settings"
        className={className}
        navigationLabel={navigationLabel}
        header={header}
        navigation={visible.length > 1
          ? <NavLinks sections={visible} activeId={activeId} currentId={currentId} LinkComponent={LinkComponent} onIntent={onIntent} onPick={setPendingId} />
          : undefined}
        article={children}
      />
    </div>
  )
}
