import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { CirclePlus, History } from 'lucide-react'
import { AgentWorkspaceCompanion, AgentWorkspaceLayout } from '@tangle-network/agent-app/workspace-react'
import { SessionHistoryPanel, useSessionHistory, type FetchSessionPage } from '@tangle-network/agent-app/web-react'
import type { SessionSort } from '@tangle-network/agent-app/session-shell'
import { Conversation } from './Conversation'
import { workspaceTools } from './workspace-tools'
import { historyHref, json, listThreads, post, threadHref, type Session, type Thread } from './api'

const productName = document.title
const initialThreadId = new URL(location.href).searchParams.get('threadId')
const showHistory = !initialThreadId && new URL(location.href).searchParams.get('view') === 'history'

function Auth({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [signUp, setSignUp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') ?? '')
    setBusy(true); setError(null)
    try {
      await json(`/api/auth/sign-${signUp ? 'up' : 'in'}/email`, post({
        email, password: String(data.get('password') ?? ''), ...(signUp ? { name: email.split('@')[0] } : {}),
      }))
      await onAuthenticated()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <main className="flex min-h-dvh items-center justify-center bg-background p-6">
    <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-6">
      <p className="text-sm text-muted-foreground">{productName}</p>
      <h1 className="text-2xl font-medium">{signUp ? 'Create your account' : 'Sign in'}</h1>
      <label className="block text-sm">Email<input className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2" name="email" type="email" autoComplete="email" required disabled={busy} /></label>
      <label className="block text-sm">Password<input className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2" name="password" type="password" minLength={8} autoComplete={signUp ? 'new-password' : 'current-password'} required disabled={busy} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button className="w-full rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button>
      <button type="button" className="text-sm text-muted-foreground underline" disabled={busy} onClick={() => { setSignUp(!signUp); setError(null) }}>{signUp ? 'Have an account? Sign in' : 'No account? Sign up'}</button>
    </form>
  </main>
}

const fetchHistory: FetchSessionPage = async ({ q, sort, signal }) => {
  const threads = await listThreads(signal)
  const items = threads.filter((thread) => (thread.title ?? '').toLocaleLowerCase().includes(q.toLocaleLowerCase()))
    .sort((a, b) => (Date.parse(a.updatedAt ?? '') - Date.parse(b.updatedAt ?? '')) * (sort === 'oldest' ? 1 : -1))
  return { items, nextCursor: null }
}
function HistoryPage({ threads }: { threads: Thread[] }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('newest')
  const history = useSessionHistory({ fetchPage: fetchHistory, q: query.trim(), sort, initialPage: { items: threads, nextCursor: null } })
  return <div className="h-full min-h-0"><SessionHistoryPanel history={history} hasAnySessions={threads.length > 0}
    query={query} onQueryChange={setQuery} sort={sort} onSortChange={setSort}
    hrefForSession={threadHref} newSessionHref="/" emptyTitle="No conversations yet" /></div>
}

function Workspace({ session }: { session: Session }) {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState(initialThreadId)
  const [error, setError] = useState<string | null>(null)
  const refreshThreads = useCallback(async () => {
    setThreads(await listThreads()); setLoaded(true)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void listThreads(controller.signal).then((rows) => { setThreads(rows); setLoaded(true) }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => controller.abort()
  }, [])
  async function logout() {
    try { await json('/api/auth/sign-out', post({})); location.reload() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <AgentWorkspaceLayout
    navItems={[{ id: 'new', label: 'New thread', icon: CirclePlus, href: '/', variant: 'primary' }]}
    sessions={{ icon: History, href: historyHref, hrefForSession: threadHref, sessions: threads,
      totalCount: threads.length, activeSessionId: activeId }}
    activeId={showHistory ? 'history' : activeId ? undefined : 'new'}
    logo={<span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground" title={productName}>{productName.slice(0, 1)}</span>}
    logoHref="/" user={session.user} settingsHref={null} onLogout={() => void logout()}
    contentClassName="h-dvh min-h-0 overflow-hidden" defaultRailCollapsed={false}>
    {error && <div role="alert" className="p-4 text-sm text-destructive">{error} <button className="underline" onClick={() => location.reload()}>Reload</button></div>}
    {showHistory ? loaded ? <HistoryPage threads={threads} /> : <p role="status" className="p-6">Loading History…</p>
      : <AgentWorkspaceCompanion tabs={workspaceTools} persistenceKey={`workspace:${session.user.id}:tools`}><Conversation initialThreadId={initialThreadId} onThread={setActiveId} onChanged={refreshThreads} /></AgentWorkspaceCompanion>}
  </AgentWorkspaceLayout>
}

export function App() {
  const [session, setSession] = useState<Session | null>()
  const [error, setError] = useState<string | null>(null)
  const loadSession = useCallback(async () => {
    const next = await json<Session | null>('/api/auth/get-session')
    setSession(next?.user ? next : null); setError(null)
  }, [])
  useEffect(() => { void loadSession().catch((cause) => setError(String(cause))) }, [loadSession])
  if (session === undefined) return <main className="p-6">{error
    ? <p role="alert">{error} <button className="underline" onClick={() => void loadSession().catch((cause) => setError(String(cause)))}>Retry session</button></p>
    : <p role="status">Loading your workspace…</p>}</main>
  return session ? <Workspace session={session} /> : <Auth onAuthenticated={loadSession} />
}
