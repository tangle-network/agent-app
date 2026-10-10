import { useCallback, useState, type ComponentType, type ReactNode } from 'react'

import { CheckGlyph, OVERLAY_SHADOW, PopoverSurface } from '../web-react/controls'
import { usePopoverDialog } from '../web-react/popover-dialog'
import { WorkspaceInitial } from '../web-react/workspace-switcher'

/** What a product is called and how it is marked. The same three values for every product. */
export interface AgentProductIdentity {
  /** Short product name, for example `Legal` or `GTM`. */
  name: string
  /** Square brand mark, sized by the product for a 20px slot. */
  mark: ReactNode
  /** Where the mark leads: the workspace listing, or home when there is none. */
  href: string
}

/** The words a product uses for one workspace and for several. */
export interface AgentWorkspaceNoun {
  singular: string
  plural: string
}

export const DEFAULT_WORKSPACE_NOUN: AgentWorkspaceNoun = { singular: 'workspace', plural: 'workspaces' }

/** The workspace that is open, and where else this person can go. */
export interface AgentWorkspaceIdentity {
  id: string
  name: string
  /** Defaults to workspace / workspaces. */
  noun?: AgentWorkspaceNoun
  /** Every workspace this person can open, including the open one, in the product's order. */
  options?: readonly { id: string; name: string }[]
  /** Required with `options`: the route that opens a workspace. */
  hrefForWorkspace?: (workspaceId: string) => string
  /** The listing route. Adds an "All …" entry. */
  listHref?: string
  /** The creation route. Adds a "New …" entry. */
  createHref?: string
}

/** The number of workspaces past which the switcher offers a search field. */
const SEARCH_THRESHOLD = 7

const HIDE_ON_RAIL: Record<'md' | 'lg', string> = { md: 'md:hidden', lg: 'lg:hidden' }

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

export interface AgentRailIdentityProps {
  product: AgentProductIdentity
  workspace?: AgentWorkspaceIdentity | null
  /**
   * The breakpoint below which the fixed rail is hidden. The rail draws the
   * mark itself; below this width the same content heads the mobile bar and
   * drawer, which have no mark of their own.
   */
  hideBelow?: 'md' | 'lg'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches SidebarLayout's router-agnostic link slot
  LinkComponent?: ComponentType<any>
}

function DefaultLink({ href, to, ...props }: { href?: string; to?: string; [key: string]: unknown }) {
  return <a href={href ?? to} {...props} />
}

/**
 * The top of every product's rail: which product, and which workspace.
 *
 * One line when no workspace is open (the listing), two when one is: the
 * workspace name, then the product beneath it. Both truncate inside the rail
 * and carry the full text as a tooltip, so a long name can never push into
 * the collapse button or the page beside the rail. It is a switcher only when
 * there is somewhere to switch to; a menu that lists one item is not offered.
 */
export function AgentRailIdentity({ product, workspace, hideBelow = 'lg', LinkComponent }: AgentRailIdentityProps) {
  const Link = LinkComponent ?? DefaultLink
  const mobileMark = (
    <span aria-hidden className={`flex h-7 w-7 shrink-0 items-center justify-center ${HIDE_ON_RAIL[hideBelow]}`}>
      {product.mark}
    </span>
  )

  if (!workspace) {
    return (
      <Link
        href={product.href}
        to={product.href}
        title={product.name}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-accent"
      >
        {mobileMark}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{product.name}</span>
      </Link>
    )
  }

  const stack = (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate text-sm font-semibold leading-5 text-foreground">{workspace.name}</span>
      <span className="block truncate text-sm leading-5 text-muted-foreground">{product.name}</span>
    </span>
  )
  const others = (workspace.options ?? []).filter((option) => option.id !== workspace.id)
  const switchable = (others.length > 0 && workspace.hrefForWorkspace !== undefined) || Boolean(workspace.listHref) || Boolean(workspace.createHref)

  if (!switchable) {
    return (
      <div title={`${workspace.name} · ${product.name}`} className="flex w-full min-w-0 items-center gap-2 px-1.5 py-1">
        {mobileMark}
        {stack}
      </div>
    )
  }

  return <WorkspaceMenu product={product} workspace={workspace} mobileMark={mobileMark} stack={stack} Link={Link} />
}

function WorkspaceMenu({
  product,
  workspace,
  mobileMark,
  stack,
  Link,
}: {
  product: AgentProductIdentity
  workspace: AgentWorkspaceIdentity
  mobileMark: ReactNode
  stack: ReactNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- router-agnostic link slot
  Link: ComponentType<any>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) setQuery('')
  }, [])
  // A non-modal dialog, like WorkspaceSwitcher: opening focuses the first
  // control, and Tab past the last one returns beside the trigger.
  const { containerRef, triggerRef, panelRef, triggerProps, id: panelId } = usePopoverDialog(open, changeOpen)
  const noun = workspace.noun ?? DEFAULT_WORKSPACE_NOUN
  const options = workspace.hrefForWorkspace ? workspace.options ?? [] : []
  const search = query.trim().toLocaleLowerCase()
  const visible = search ? options.filter((option) => option.name.toLocaleLowerCase().includes(search)) : options
  const close = () => changeOpen(false)
  const rowClass = 'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent'

  return (
    <div ref={containerRef} className="w-full min-w-0">
      <button
        type="button"
        {...triggerProps}
        aria-label={`${capitalize(noun.singular)}: ${workspace.name}. Switch ${noun.singular}`}
        title={`${workspace.name} · ${product.name}`}
        onClick={() => changeOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-accent aria-expanded:bg-accent"
      >
        {mobileMark}
        {stack}
        <svg aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="m8 9 4-4 4 4m-8 6 4 4 4-4" />
        </svg>
      </button>
      <PopoverSurface
        open={open}
        id={panelId}
        role="dialog"
        aria-label={`Switch ${noun.singular}`}
        side="below"
        triggerRef={triggerRef}
        panelRef={panelRef}
        contentKey={`${query}:${options.length}`}
        className={`w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-card-edge bg-popover p-1.5 text-foreground ${OVERLAY_SHADOW}`}
      >
        {options.length > SEARCH_THRESHOLD && (
          <input
            data-autofocus
            aria-label={`Search ${noun.plural}`}
            placeholder={`Search ${noun.plural}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-1.5 h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground"
          />
        )}
        {options.length > 0 && (
          <div className="max-h-72 overflow-y-auto">
            {visible.map((option) => (
              <Link
                key={option.id}
                href={workspace.hrefForWorkspace!(option.id)}
                to={workspace.hrefForWorkspace!(option.id)}
                aria-current={option.id === workspace.id ? 'page' : undefined}
                title={option.name}
                onClick={close}
                className={rowClass}
              >
                <WorkspaceInitial name={option.name} />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {option.id === workspace.id && <CheckGlyph className="h-4 w-4 shrink-0 text-primary" />}
              </Link>
            ))}
            {visible.length === 0 && (
              <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
                No {noun.plural} match “{query.trim()}”.
              </p>
            )}
          </div>
        )}
        {(workspace.listHref || workspace.createHref) && (
          <div className={options.length > 0 ? 'mt-1.5 border-t border-border pt-1.5' : undefined}>
            {workspace.listHref && (
              <Link href={workspace.listHref} to={workspace.listHref} onClick={close} className={rowClass}>
                <svg aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
                </svg>
                <span className="min-w-0 flex-1 truncate">All {noun.plural}</span>
              </Link>
            )}
            {workspace.createHref && (
              <Link href={workspace.createHref} to={workspace.createHref} onClick={close} className={rowClass}>
                <svg aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span className="min-w-0 flex-1 truncate">New {noun.singular}</span>
              </Link>
            )}
          </div>
        )}
      </PopoverSurface>
    </div>
  )
}
