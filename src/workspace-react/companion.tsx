import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tangle-network/sandbox-ui/primitives'
import { WorkspaceLayout } from '@tangle-network/sandbox-ui/workspace'

export interface AgentWorkspaceCompanionTab {
  id: string
  label: string
  icon?: ReactNode
  /** Retain a visited tab through tab switches, pane closure, and viewport changes. */
  keepMounted?: boolean
  renderContent: (state: { active: boolean }) => ReactNode
}

export interface AgentWorkspaceCompanionHandle {
  openTab: (tabId: string) => boolean
}

export interface AgentWorkspaceCompanionProps {
  children: ReactNode
  tabs: readonly AgentWorkspaceCompanionTab[]
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
  tabs,
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

  if (tabs.length === 0) return <>{children}</>

  return (
    <Tabs key={persistenceKey} value={active} onValueChange={selectTab} className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${className ?? ''}`}>
      <WorkspaceLayout
        className="h-full min-h-0 min-w-0 flex-1"
        collapsedControlsPlacement="overlay"
        keepRightMounted
        center={children}
        rightOpen={open}
        onRightOpenChange={changeOpen}
        rightLabel={label}
        defaultRightWidth={defaultWidth}
        persistenceKey={persistenceKey}
        minRightWidth={280}
        rightContentClassName="flex flex-col overflow-hidden"
        rightHeader={(
          <TabsList aria-label={label} className="h-9 max-w-full justify-start overflow-x-auto bg-transparent p-0">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5 px-2.5 text-sm">
                {tab.icon}<span>{tab.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        right={tabs.map((tab) => {
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
        })}
      />
    </Tabs>
  )
})
