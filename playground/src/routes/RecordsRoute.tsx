import { useState } from 'react'
import {
  RecordGrid,
  SessionHistoryPanel,
  type SessionSort,
} from '@tangle-network/agent-app/web-react'
import { makeSessions, makeRecordGridRows, RECORD_GRID_COLUMNS } from '../fixtures'

/**
 * Visual audit for the two surfaces PR #404 named as still in-place and
 * carrying the same latent risk as the composer picker popovers it fixed:
 * the session-history kebab menu and the record-grid source popover. Both
 * now render through PopoverSurface (see AGENTS.md "UI chrome ownership").
 *
 * Neither surface owns a horizontally scrolling rail the way ChatComposer
 * does, so the reproduction here is the general form of the same defect
 * rather than that specific one: `ClipHost` is a short, `overflow: auto`
 * host — a narrow dashboard slot or sidebar card a real product might dock
 * either surface into — shorter than the popover panel it opens. Before the
 * migration this host's own clip erased the panel exactly the way the
 * composer's 34px rail did; portaling to `document.body` makes the host's
 * own height irrelevant.
 */
function Demo({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </h3>
      <div className="rounded-2xl border border-border bg-card/40 p-4">{children}</div>
    </section>
  )
}

function ClipHost({
  label,
  height,
  children,
}: {
  label: string
  height: number
  children: React.ReactNode
}) {
  return (
    <div
      data-popover-audit={label}
      className="overflow-auto rounded-xl border border-border bg-card"
      style={{ height }}
    >
      {children}
    </div>
  )
}

export function RecordsRoute() {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('newest')
  const sessions = makeSessions()
  const rows = makeRecordGridRows()

  return (
    <div className="h-full w-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-xl space-y-7 px-6 py-10">
        <Demo title="Session history — kebab menu, in a short clipping host">
          <ClipHost label="session-history" height={190}>
            <SessionHistoryPanel
              history={{
                items: sessions,
                hasMore: false,
                isLoadingFirst: false,
                isLoadingMore: false,
                isError: false,
                loadMore: () => {},
                retry: () => {},
                reload: () => {},
              }}
              hasAnySessions
              query={query}
              onQueryChange={setQuery}
              sort={sort}
              onSortChange={setSort}
              hrefForSession={(id) => `/app/ws_1/chat/${id}`}
              onRename={() => {}}
              onDelete={() => {}}
            />
          </ClipHost>
        </Demo>

        <Demo title="Record grid — provenance popover, in a short clipping host">
          <ClipHost label="record-grid" height={190}>
            <RecordGrid
              columns={RECORD_GRID_COLUMNS}
              state={{ status: 'ready', value: rows, retry: () => {} }}
              caption="Cap table"
              empty={{ title: 'No holders yet', description: 'Add a founder or an investor.' }}
            />
          </ClipHost>
        </Demo>
      </div>
    </div>
  )
}
