import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tangle-network/sandbox-ui/primitives'
import { WorkspaceLayout } from '@tangle-network/sandbox-ui/workspace'
import { FlaskConical, FolderOpen, GitCompare, Monitor, Terminal } from 'lucide-react'

export interface AgentWorkspaceCompanionTab {
  id: string
  label: string
  icon?: ReactNode
  /** Retain a visited tab through tab switches, pane closure, and viewport changes. */
  keepMounted?: boolean
  renderContent: (state: { active: boolean }) => ReactNode
}

export type AgentWorkspaceCompanionTool = 'files' | 'agent' | 'terminal' | 'changes' | 'preview'

/** Supply only tools the product can actually serve. Content remains product-owned. */
export type AgentWorkspaceCompanionTools = Partial<Record<AgentWorkspaceCompanionTool, AgentWorkspaceCompanionTab['renderContent']>>

const companionTools = [
  { id: 'files', label: 'Files', Icon: FolderOpen },
  { id: 'agent', label: 'Agent', Icon: FlaskConical },
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
  { id: 'changes', label: 'Changes', Icon: GitCompare },
  { id: 'preview', label: 'Preview', Icon: Monitor },
] as const

/** Canonical order, labels, icons and lazy retention for companion tools. */
export function createAgentWorkspaceCompanionTabs(tools: AgentWorkspaceCompanionTools): AgentWorkspaceCompanionTab[] {
  return companionTools.flatMap(({ id, label, Icon }) => {
    const renderContent = tools[id]
    return renderContent ? [{ id, label, icon: <Icon className="h-3.5 w-3.5" aria-hidden />, keepMounted: true, renderContent }] : []
  })
}

export interface AgentWorkspaceCompanionNavigation {
  content: ReactNode
  header?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  label?: string
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  collapsedControl?: ReactNode
}

export interface AgentWorkspaceCompanionHandle {
  openTab: (tabId: string) => boolean
}

export interface AgentWorkspaceCompanionProps {
  children: ReactNode
  /** Use tools for shared defaults; tabs overrides them for product-specific navigation. */
  tabs?: readonly AgentWorkspaceCompanionTab[]
  tools?: AgentWorkspaceCompanionTools
  /** Optional session navigation, composed in the same responsive layout. */
  navigation?: AgentWorkspaceCompanionNavigation
  keyboardShortcuts?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  activeTabId?: string
  onActiveTabChange?: (tabId: string) => void
  defaultActiveTabId?: string
  /** Namespace for remembered tab selection and underlying pane dimensions. */
  persistenceKey?: string
  label?: string
  defaultWidth?: number
  className?: string
}

/** Product-owned tools beside a conversation; omitted tools have no tabs or effects. */
export const AgentWorkspaceCompanion = forwardRef<AgentWorkspaceCompanionHandle, AgentWorkspaceCompanionProps>(function AgentWorkspaceCompanion({
  children,
  tabs: customTabs,
  tools,
  navigation,
  keyboardShortcuts,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  activeTabId,
  onActiveTabChange,
  defaultActiveTabId,
  persistenceKey,
  label = 'Workspace tools',
  defaultWidth = 420,
  className,
}, ref) {
  const tabs = customTabs ?? createAgentWorkspaceCompanionTabs(tools ?? {})
  const [uncontrolledOpen, setOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const [selection, setSelection] = useState({ key: persistenceKey, id: defaultActiveTabId })
  const [visits, setVisits] = useState<{ key: string | undefined; ids: ReadonlySet<string> }>(() => ({ key: persistenceKey, ids: new Set() }))
  const requested = activeTabId ?? (selection.key === persistenceKey ? selection.id : defaultActiveTabId)
  const active = tabs.find((tab) => tab.id === requested)?.id ?? tabs[0]?.id
  const visited = visits.key === persistenceKey ? visits.ids : new Set<string>()
  const storageKey = persistenceKey ? `${persistenceKey}:companion-tab` : undefined

  const pendingRestoration = useRef<{ key: string | undefined; id: string | undefined } | undefined>(undefined)
  const reconciledSelection = useRef<string | undefined>(undefined)
  const restoredKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = JSON.stringify([persistenceKey, defaultActiveTabId])
    if (restoredKey.current === key || tabs.length === 0) return
    let id = activeTabId ?? defaultActiveTabId
    if (storageKey) {
      try { id = window.localStorage.getItem(storageKey) ?? id } catch { /* Browser storage is optional. */ }
    }
    const resolved = tabs.find((tab) => tab.id === id)?.id ?? tabs[0]?.id
    restoredKey.current = key
    pendingRestoration.current = { key: persistenceKey, id: resolved }
    setSelection({ key: persistenceKey, id: resolved })
    if (resolved && resolved !== activeTabId) {
      reconciledSelection.current = JSON.stringify([persistenceKey, requested, resolved])
      onActiveTabChange?.(resolved)
    }
  }, [storageKey, persistenceKey, defaultActiveTabId, activeTabId, requested, tabs, onActiveTabChange])

  useEffect(() => {
    // Let restored selection reach the controlled parent before reconciling stale props.
    const pending = pendingRestoration.current
    if (pending) {
      const acknowledged = activeTabId === undefined
        ? selection.key === pending.key && selection.id === pending.id
        : activeTabId === pending.id
      if (!acknowledged) return
      pendingRestoration.current = undefined
    }
    if (!active || tabs.some((tab) => tab.id === requested)) {
      reconciledSelection.current = undefined
      return
    }
    const key = JSON.stringify([persistenceKey, requested, active])
    if (reconciledSelection.current === key) return
    reconciledSelection.current = key
    setSelection({ key: persistenceKey, id: active })
    onActiveTabChange?.(active)
  }, [active, activeTabId, requested, selection, persistenceKey, tabs, onActiveTabChange])

  useEffect(() => {
    if (!open || !active) return
    setVisits((previous) => {
      const ids = previous.key === persistenceKey ? previous.ids : new Set<string>()
      return ids.has(active) ? previous : { key: persistenceKey, ids: new Set([...ids, active]) }
    })
  }, [open, active, persistenceKey])

  const selectTab = useCallback((id: string) => {
    if (!tabs.some((tab) => tab.id === id)) return false
    setSelection({ key: persistenceKey, id })
    onActiveTabChange?.(id)
    if (storageKey) {
      try { window.localStorage.setItem(storageKey, id) } catch { /* Selection still works without storage. */ }
    }
    return true
  }, [tabs, persistenceKey, storageKey, onActiveTabChange])
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }, [onOpenChange])

  useImperativeHandle(ref, () => ({
    openTab(id) {
      if (!selectTab(id)) return false
      changeOpen(true)
      return true
    },
  }), [selectTab, changeOpen])

  if (tabs.length === 0 && !navigation) return <>{children}</>

  return (
    <Tabs key={persistenceKey} value={active} onValueChange={selectTab} className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${className ?? ''}`}>
      <WorkspaceLayout
        className="h-full min-h-0 min-w-0 flex-1"
        collapsedControlsPlacement="overlay"
        keepRightMounted
        center={children}
        left={navigation?.content}
        leftContentClassName="py-0"
        leftHeader={navigation && (navigation.header !== undefined ? navigation.header : <span className="text-sm font-medium">{navigation.label ?? 'Chats'}</span>)}
        leftOpen={navigation?.open}
        onLeftOpenChange={navigation?.onOpenChange}
        leftLabel={navigation?.label ?? 'Chats'}
        defaultLeftWidth={navigation?.defaultWidth ?? 260}
        minLeftWidth={navigation?.minWidth ?? 200}
        maxLeftWidth={navigation?.maxWidth ?? 400}
        leftCollapsedControl={navigation?.collapsedControl}
        keyboardShortcuts={keyboardShortcuts}
        rightOpen={open}
        onRightOpenChange={changeOpen}
        rightLabel={label}
        defaultRightWidth={defaultWidth}
        persistenceKey={persistenceKey}
        minRightWidth={280}
        rightContentClassName="flex flex-col overflow-hidden"
        rightHeader={tabs.length > 0 ? <CompanionTabList tabs={tabs} active={active} label={label} /> : undefined}
        right={tabs.length > 0 ? tabs.map((tab) => {
          const isActive = tab.id === active
          const retained = tab.keepMounted && visited.has(tab.id)
          if (!(open && isActive) && !retained) return null
          return (
            <TabsContent
              key={tab.id}
              value={tab.id}
              forceMount={retained ? true : undefined}
              hidden={!open || !isActive}
              className="m-0 h-full min-h-0 min-w-0 flex-1 data-[state=inactive]:hidden"
            >
              {tab.renderContent({ active: open && isActive })}
            </TabsContent>
          )
        }) : undefined}
      />
    </Tabs>
  )
})

/**
 * The companion's tab row. When every labelled tab does not fit the pane (a
 * phone drawer, a narrow resized pane), inactive tabs that have an icon drop to
 * icon-only and the active tab keeps its label, so no tab hides behind the
 * close button. Labels stay in the accessibility tree either way. The row
 * returns to full labels once the pane is wide enough for them again.
 */
function CompanionTabList({ tabs, active, label }: { tabs: readonly AgentWorkspaceCompanionTab[]; active: string | undefined; label: string }) {
  const frameRef = useRef<HTMLDivElement>(null)
  const fullWidth = useRef(0)
  const [compact, setCompact] = useState(false)
  const signature = tabs.map((tab) => `${tab.id}\u0000${tab.label}\u0000${tab.icon ? 1 : 0}`).join('\u0001')

  useLayoutEffect(() => {
    fullWidth.current = 0
    setCompact(false)
  }, [signature])

  useLayoutEffect(() => {
    const frame = frameRef.current
    const list = frame?.firstElementChild
    if (!frame || !(list instanceof HTMLElement)) return
    const fit = () => {
      const available = frame.clientWidth
      if (!compact) {
        fullWidth.current = list.scrollWidth
        if (list.scrollWidth > available + 1) setCompact(true)
      } else if (fullWidth.current > 0 && available >= fullWidth.current) {
        setCompact(false)
      }
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [compact, signature])

  useEffect(() => {
    const trigger = frameRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    trigger?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active, compact])

  return (
    <div ref={frameRef} className="min-w-0" data-compact={compact ? '' : undefined}>
      <TabsList aria-label={label} className="h-9 max-w-full justify-start overflow-x-auto bg-transparent p-0">
        {tabs.map((tab) => {
          const iconOnly = compact && tab.icon && tab.id !== active
          return (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              title={iconOnly ? tab.label : undefined}
              className={iconOnly ? 'gap-1.5 px-2 text-sm' : 'gap-1.5 px-2.5 text-sm'}
            >
              {tab.icon}<span className={iconOnly ? 'sr-only' : undefined}>{tab.label}</span>
            </TabsTrigger>
          )
        })}
      </TabsList>
    </div>
  )
}
