import { useId, useMemo, useState, type ComponentType, type ReactNode } from 'react'

import { ActionDialog, ActionDialogButton } from '../web-react/action-dialog'
import { OVERLAY_SHADOW, PopoverSurface, usePopover } from '../web-react/controls'
import { WorkspaceInitial } from '../web-react/workspace-switcher'
import { DEFAULT_WORKSPACE_NOUN, type AgentWorkspaceNoun } from './rail-identity'

/** One workspace as the listing shows it. */
export interface WorkspaceListItem {
  id: string
  name: string
  /** The route that opens it. */
  href: string
  /** One line under the name. Not shown when it only repeats the name. */
  description?: string | null
  /** Last activity. Shown as a short date. */
  updatedAt?: string | number | Date | null
  /** Values for the product's `fields`, keyed by field id. */
  values?: Readonly<Record<string, ReactNode>>
  /** Replaces the initial avatar, for example with a logo the product already has. */
  avatar?: ReactNode
}

/** A product column: a value the user compares across workspaces (tax year, status, owner). */
export interface WorkspaceListField {
  id: string
  label: string
}

/** A non-destructive product action in an item's overflow menu. */
export interface WorkspaceListAction {
  id: string
  label: string
  onSelect: (item: WorkspaceListItem) => void
}

export interface WorkspaceListProps {
  items: readonly WorkspaceListItem[]
  /** The product's words for one workspace and several. Defaults to workspace / workspaces. */
  noun?: AgentWorkspaceNoun
  /** Page title. Defaults to the capitalized plural noun. */
  title?: string
  /** One sentence under the title, when the page needs one. */
  description?: ReactNode
  /** `list` rows for records people compare; `grid` cards for a handful of rich projects. */
  layout?: 'list' | 'grid'
  /** Product values, shown as columns (list) or under the description (grid). */
  fields?: readonly WorkspaceListField[]
  /**
   * The one primary action, labelled "New {singular}" unless `label` says otherwise.
   * `href` navigates; `onSelect` opens the product's own creation flow; `onCreate`
   * asks for a name in the shared dialog and hands it over — reject with an Error
   * to show its message, and navigate to the new workspace from inside it.
   */
  create?: {
    label?: string
    href?: string
    onSelect?: () => void
    onCreate?: (name: string) => Promise<void>
    /** Placeholder for the name field. Defaults to "{Singular} name". */
    namePlaceholder?: string
  }
  /** First-use copy. The create action is offered beneath it. */
  empty?: { title?: string; description?: string }
  /** Persist a new name. Reject with an Error to show its message in the dialog. */
  rename?: (item: WorkspaceListItem, name: string) => Promise<void>
  /** Delete for good. Offered in the overflow menu, behind a confirmation. */
  remove?: (item: WorkspaceListItem) => Promise<void>
  /** What deleting loses, for the confirmation. */
  removeConsequence?: (item: WorkspaceListItem) => string
  /** Extra overflow-menu actions. */
  actions?: (item: WorkspaceListItem) => readonly WorkspaceListAction[]
  /** Product content between the header and the items, such as a home summary. */
  children?: ReactNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- router-agnostic link slot, same as SidebarLayout
  LinkComponent?: ComponentType<any>
  /** Formats `updatedAt`. Defaults to a short month and day, with the year when it is not this year. */
  formatDate?: (value: Date) => string
}

/** The number of items past which the listing offers a search field. */
const SEARCH_THRESHOLD = 8

// Fixed widths keep every row's columns on the same x, whatever a date or value renders as.
const FIELD_CELL = 'hidden w-32 min-w-0 shrink-0 md:block'
const DATE_CELL = 'w-20 shrink-0 text-right sm:w-24'

function DefaultLink({ href, to, ...props }: { href?: string; to?: string; [key: string]: unknown }) {
  return <a href={href ?? to} {...props} />
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

function defaultFormatDate(value: Date): string {
  const sameYear = value.getFullYear() === new Date().getFullYear()
  return value.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

function present(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false && value !== ''
}

function toDate(value: WorkspaceListItem['updatedAt']): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A description is noise when it says the name again ("GTM Agent / GTM Agent"). */
function usefulDescription(item: WorkspaceListItem): string | null {
  const text = item.description?.trim()
  if (!text) return null
  return text.toLocaleLowerCase() === item.name.trim().toLocaleLowerCase() ? null : text
}

/**
 * The listing every product opens on: one title, one primary action, the
 * workspaces, and nothing that counts them. Destructive actions live in each
 * item's overflow menu behind a confirmation, never as an icon on every row.
 * The product supplies its noun, its columns, and its create route; render it
 * inside `AgentWorkspaceLayout` (with no `workspace`) so the listing wears the
 * same shell as the workspace it opens.
 */
export function WorkspaceList({
  items,
  noun = DEFAULT_WORKSPACE_NOUN,
  title,
  description,
  layout = 'list',
  fields = [],
  create,
  empty,
  rename,
  remove,
  removeConsequence,
  actions,
  children,
  LinkComponent,
  formatDate = defaultFormatDate,
}: WorkspaceListProps) {
  const Link = LinkComponent ?? DefaultLink
  const headingId = useId()
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<WorkspaceListItem | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [removing, setRemoving] = useState<WorkspaceListItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [createValue, setCreateValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = query.trim().toLocaleLowerCase()
  const visible = useMemo(
    () => (search ? items.filter((item) => item.name.toLocaleLowerCase().includes(search)) : items),
    [items, search],
  )
  const createLabel = create?.label ?? `New ${noun.singular}`
  const openCreate = () => {
    setError(null)
    setCreateValue('')
    setCreating(true)
  }
  const createControl = create
    ? <CreateButton create={create.onCreate && !create.href ? { ...create, onSelect: openCreate } : create} label={createLabel} Link={Link} />
    : null
  const submitCreate = () => {
    const name = createValue.trim()
    if (!name || !create?.onCreate) return
    void run(() => create.onCreate!(name), () => setCreating(false))
  }

  const hasDates = items.some((item) => toDate(item.updatedAt) !== null)
  const hasMenu = Boolean(rename) || Boolean(remove) || Boolean(actions)
  const menuFor = (item: WorkspaceListItem): MenuEntry[] => [
    ...(rename ? [{ id: 'rename', label: 'Rename', onSelect: () => { setError(null); setRenaming(item); setRenameValue(item.name) } }] : []),
    ...(actions?.(item) ?? []).map((action) => ({ id: action.id, label: action.label, onSelect: () => action.onSelect(item) })),
    ...(remove ? [{ id: 'delete', label: 'Delete', destructive: true, onSelect: () => { setError(null); setRemoving(item) } }] : []),
  ]

  const run = async (work: () => Promise<void>, done: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      done()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'That did not save. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const submitRename = () => {
    if (!renaming || !rename) return
    const name = renameValue.trim()
    if (!name || name === renaming.name) {
      setRenaming(null)
      return
    }
    void run(() => rename(renaming, name), () => setRenaming(null))
  }

  return (
    <section aria-labelledby={headingId} className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <h1 id={headingId} className="text-xl font-semibold tracking-tight text-foreground">
            {title ?? capitalize(noun.plural)}
          </h1>
          {description != null && <div className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</div>}
        </div>
        {items.length > 0 && createControl}
      </header>

      {children != null && <div className="mt-6">{children}</div>}

      {items.length === 0 ? (
        <div className="mt-6 flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-14 text-center">
          <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><path d="M16.75 13.5v6.5M13.5 16.75H20" />
            </svg>
          </span>
          <h2 className="mt-4 text-base font-semibold text-foreground">{empty?.title ?? `No ${noun.plural} yet`}</h2>
          {empty?.description && <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{empty.description}</p>}
          {createControl && <div className="mt-5">{createControl}</div>}
        </div>
      ) : (
        <>
          {items.length > SEARCH_THRESHOLD && (
            <div className="mt-6">
              <input
                type="search"
                aria-label={`Search ${noun.plural}`}
                placeholder={`Search ${noun.plural}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>
          )}
          {visible.length === 0 ? (
            <p role="status" className="mt-6 rounded-xl border border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No {noun.plural} match “{query.trim()}”.{' '}
              <button type="button" onClick={() => setQuery('')} className="font-medium text-foreground underline underline-offset-2">
                Clear search
              </button>
            </p>
          ) : layout === 'grid' ? (
            <ul className={`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 ${items.length > SEARCH_THRESHOLD ? 'mt-3' : 'mt-6'}`}>
              {visible.map((item) => (
                <GridCard key={item.id} item={item} fields={fields} menu={menuFor(item)} Link={Link} formatDate={formatDate} />
              ))}
            </ul>
          ) : (
            <div className={`overflow-hidden rounded-xl border border-border bg-card ${items.length > SEARCH_THRESHOLD ? 'mt-3' : 'mt-6'}`}>
              {fields.length > 0 && (
                <div aria-hidden className="hidden items-center gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground md:flex">
                  <span className="w-10 shrink-0" />
                  <span className="min-w-0 flex-1">Name</span>
                  {fields.map((field) => (
                    <span key={field.id} className={`${FIELD_CELL} truncate`}>{field.label}</span>
                  ))}
                  <span className={DATE_CELL}>{hasDates ? 'Updated' : ''}</span>
                  {hasMenu && <span className="w-8 shrink-0 [@media(pointer:coarse)]:w-11" />}
                </div>
              )}
              <ul className="divide-y divide-border">
                {visible.map((item) => (
                  <ListRow key={item.id} item={item} fields={fields} menu={menuFor(item)} reserveMenu={hasMenu} Link={Link} formatDate={formatDate} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {renaming && (
        <ActionDialog
          title={`Rename ${noun.singular}`}
          onClose={() => setRenaming(null)}
          busy={busy}
          error={error}
          footer={
            <>
              <ActionDialogButton variant="ghost" onClick={() => setRenaming(null)} disabled={busy}>Cancel</ActionDialogButton>
              <ActionDialogButton onClick={submitRename} disabled={busy || !renameValue.trim()}>Save</ActionDialogButton>
            </>
          }
        >
          <label htmlFor={`${headingId}-rename`} className="text-xs text-muted-foreground">Name</label>
          <input
            id={`${headingId}-rename`}
            value={renameValue}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) {
                event.preventDefault()
                submitRename()
              }
            }}
            className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
          />
        </ActionDialog>
      )}

      {creating && create?.onCreate && (
        <ActionDialog
          title={createLabel}
          onClose={() => setCreating(false)}
          busy={busy}
          error={error}
          footer={
            <>
              <ActionDialogButton variant="ghost" onClick={() => setCreating(false)} disabled={busy}>Cancel</ActionDialogButton>
              <ActionDialogButton onClick={submitCreate} disabled={busy || !createValue.trim()}>Create</ActionDialogButton>
            </>
          }
        >
          <label htmlFor={`${headingId}-create`} className="text-xs text-muted-foreground">Name</label>
          <input
            id={`${headingId}-create`}
            value={createValue}
            autoFocus
            placeholder={create.namePlaceholder ?? `${capitalize(noun.singular)} name`}
            onChange={(event) => setCreateValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) {
                event.preventDefault()
                submitCreate()
              }
            }}
            className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </ActionDialog>
      )}

      {removing && remove && (
        <ActionDialog
          title={`Delete ${noun.singular}?`}
          onClose={() => setRemoving(null)}
          busy={busy}
          error={error}
          footer={
            <>
              <ActionDialogButton variant="ghost" onClick={() => setRemoving(null)} disabled={busy}>Cancel</ActionDialogButton>
              <ActionDialogButton variant="destructive" onClick={() => void run(() => remove(removing), () => setRemoving(null))} disabled={busy}>
                Delete
              </ActionDialogButton>
            </>
          }
        >
          <p className="break-words text-sm text-muted-foreground">
            {removeConsequence?.(removing) ?? `“${removing.name}” and everything in it will be deleted. This cannot be undone.`}
          </p>
        </ActionDialog>
      )}
    </section>
  )
}

interface MenuEntry {
  id: string
  label: string
  destructive?: boolean
  onSelect: () => void
}

interface ItemProps {
  reserveMenu?: boolean
  item: WorkspaceListItem
  fields: readonly WorkspaceListField[]
  menu: MenuEntry[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- router-agnostic link slot
  Link: ComponentType<any>
  formatDate: (value: Date) => string
}

function UpdatedAt({ value, formatDate, className = 'shrink-0' }: { value: WorkspaceListItem['updatedAt']; formatDate: (value: Date) => string; className?: string }) {
  const date = toDate(value)
  if (!date) return <span className={className} />
  return (
    // Server and browser can format a date differently (zone, locale); the
    // browser's reading is the one the user should see.
    <time dateTime={date.toISOString()} suppressHydrationWarning className={`${className} text-xs tabular-nums text-muted-foreground`}>
      {formatDate(date)}
    </time>
  )
}

/**
 * The name is the row's link, stretched over the whole row with an `after:`
 * overlay, so the overflow menu can sit on top as a real sibling button
 * instead of a button nested inside a link.
 */
function ListRow({ item, fields, menu, reserveMenu, Link, formatDate }: ItemProps) {
  const detail = usefulDescription(item)
  const mobileFields = fields.filter((field) => present(item.values?.[field.id]))
  return (
    <li className="group relative isolate flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/60">
      {item.avatar ?? <WorkspaceInitial name={item.name} size="lg" />}
      <div className="min-w-0 flex-1">
        <Link
          href={item.href}
          to={item.href}
          title={item.name}
          className="block truncate text-sm font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {item.name}
        </Link>
        {detail && <p className="truncate text-xs text-muted-foreground" title={detail}>{detail}</p>}
        {/* Below md the columns are hidden, so their values ride under the name instead. */}
        {mobileFields.length > 0 && (
          <p className="truncate text-xs text-muted-foreground md:hidden">
            {mobileFields.map((field, index) => (
              <span key={field.id}>
                {index > 0 && ' · '}
                <span className="sr-only">{field.label}: </span>
                {item.values![field.id]}
              </span>
            ))}
          </p>
        )}
      </div>
      {fields.map((field) => (
        <div key={field.id} className={`${FIELD_CELL} truncate text-sm text-muted-foreground`}>
          <span className="sr-only">{field.label}: </span>
          {present(item.values?.[field.id]) ? item.values![field.id] : '—'}
        </div>
      ))}
      <UpdatedAt value={item.updatedAt} formatDate={formatDate} className={DATE_CELL} />
      {menu.length > 0 ? <ItemMenu item={item} entries={menu} /> : reserveMenu ? <span className="w-8 shrink-0 [@media(pointer:coarse)]:w-11" /> : null}
    </li>
  )
}

function GridCard({ item, fields, menu, Link, formatDate }: ItemProps) {
  const detail = usefulDescription(item)
  const shownFields = fields.filter((field) => present(item.values?.[field.id]))
  return (
    <li className="group relative isolate flex min-h-36 flex-col overflow-hidden rounded-xl border border-border bg-card p-4 transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-sm">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-16 bg-gradient-to-b from-primary/[0.07] to-transparent" />
      <div className="flex items-start gap-3">
        {item.avatar ?? <WorkspaceInitial name={item.name} size="lg" />}
        <div className="min-w-0 flex-1 pt-0.5">
          <Link
            href={item.href}
            to={item.href}
            title={item.name}
            className="line-clamp-2 break-words text-sm font-semibold text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {item.name}
          </Link>
          {detail && <p className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</p>}
        </div>
        {menu.length > 0 && <ItemMenu item={item} entries={menu} />}
      </div>
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        {shownFields.length > 0 ? (
          <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs">
            {shownFields.map((field) => (
              <div key={field.id} className="flex min-w-0 gap-1">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="truncate font-medium text-foreground">{item.values?.[field.id]}</dd>
              </div>
            ))}
          </dl>
        ) : <span />}
        <UpdatedAt value={item.updatedAt} formatDate={formatDate} />
      </div>
    </li>
  )
}

function ItemMenu({ item, entries }: { item: WorkspaceListItem; entries: MenuEntry[] }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  return (
    <div ref={containerRef} className="relative z-10 shrink-0">
      <button
        type="button"
        {...triggerProps}
        aria-label={`Actions for ${item.name}`}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        // Hidden until hover only where hover exists; a touch screen of any width shows it.
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
      >
        <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      <PopoverSurface
        open={open}
        id={panelId}
        role="menu"
        aria-label={`Actions for ${item.name}`}
        side="below"
        align="end"
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={`w-44 overflow-hidden rounded-md border border-card-edge bg-popover py-1 ${OVERLAY_SHADOW}`}
      >
        {entries.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              // The dialog this opens returns focus to whatever had it — the trigger, not <body>.
              triggerRef.current?.focus()
              entry.onSelect()
            }}
            className={`block w-full px-3 py-1.5 text-left text-sm transition ${
              entry.destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-accent'
            } ${entry.destructive && index > 0 ? 'mt-1 border-t border-border pt-2' : ''}`}
          >
            {entry.label}
          </button>
        ))}
      </PopoverSurface>
    </div>
  )
}

function CreateButton({
  create,
  label,
  Link,
}: {
  create: NonNullable<WorkspaceListProps['create']>
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- router-agnostic link slot
  Link: ComponentType<any>
}) {
  const className = 'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 active:scale-[0.98]'
  const icon = (
    <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
  if (create.href) {
    return (
      <Link href={create.href} to={create.href} className={className}>
        {icon}
        {label}
      </Link>
    )
  }
  return (
    <button type="button" onClick={create.onSelect} className={className}>
      {icon}
      {label}
    </button>
  )
}
