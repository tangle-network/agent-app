/**
 * A project settings page built only from `settings-react` and the ui
 * settings atoms, over the in-browser backend: every row autosaves, confirms
 * or groups its save the way the settings contract says. The story renders it
 * and `scripts/prove-settings-pages.mjs` drives it in a real browser.
 */

import {
  Button,
  Input,
  SegmentedControl,
  SettingsRow,
  SettingsSection,
  Switch,
  Textarea,
} from '@tangle-network/ui/primitives'
import { Bell, Bot, Gauge, Settings, Users } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import {
  ConfirmAction,
  confirmSettingResponse,
  DeleteWorkspaceSection,
  ExportSection,
  InvitationsSection,
  MembersSection,
  SettingsLayout,
  SettingsSaveBar,
  TimezonePicker,
  useSettingField,
  type SettingsLinkProps,
  type SettingsNavSection,
} from '../../settings-react'
import { confirmWrite, type MutationOutcome } from '../../web-react/async'
import type { DemoBackend, DemoInvitation, DemoMember, DemoWorkspace, ViewerRole } from './settings-backend'

export type DemoSectionId = 'general' | 'agent' | 'notifications' | 'limits' | 'team'

export interface SettingsDemoProps {
  backend: DemoBackend
  viewer?: ViewerRole
  initialSection?: DemoSectionId
  /** How long a section's "loader" takes, so the optimistic nav and progress line show. */
  routeDelayMs?: number
}

const NavigateContext = createContext<(href: string) => void>(() => undefined)

/** The router link a product would pass; here it switches the demo's section. */
function DemoLink({ href, onClick, children, ...rest }: SettingsLinkProps) {
  const navigate = useContext(NavigateContext)
  return (
    <a
      href={href}
      {...rest}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
        event.preventDefault()
        navigate(href)
      }}
    >
      {children}
    </a>
  )
}

const OWNER = 'Priya'
const ownerOnly = (what: string) => `Only ${OWNER}, the owner, can ${what}.`

type Patch = Partial<DemoWorkspace>

function useWorkspaceApi(backend: DemoBackend) {
  const [workspace, setWorkspace] = useState<DemoWorkspace | null>(null)
  const [members, setMembers] = useState<DemoMember[]>([])
  const [invitations, setInvitations] = useState<DemoInvitation[]>([])
  const reload = useCallback(async () => {
    const [w, m, i] = await Promise.all(['/api/workspace', '/api/members', '/api/invitations'].map((path) => backend.fetch(path).then((r) => r.json())))
    setWorkspace(w as DemoWorkspace)
    setMembers(m as DemoMember[])
    setInvitations(i as DemoInvitation[])
  }, [backend])
  useEffect(() => { void reload() }, [reload])
  const patch = useCallback(async (next: Patch): Promise<MutationOutcome<DemoWorkspace>> => {
    const outcome = await confirmSettingResponse(
      backend.fetch('/api/workspace', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) }),
      (data) => data as DemoWorkspace,
    )
    if (outcome.succeeded) setWorkspace(outcome.value)
    return outcome
  }, [backend])
  // A route that answers `{ success: true }` or 204 kept the value it was sent.
  const put = useCallback(async <K extends keyof DemoWorkspace>(path: string, key: K, value: DemoWorkspace[K]) => {
    const outcome = await confirmSettingResponse(
      backend.fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }),
      () => value,
    )
    if (outcome.succeeded) {
      const kept = outcome.value
      setWorkspace((current) => current && { ...current, [key]: kept })
    }
    return outcome
  }, [backend])
  const send = useCallback(async (method: string, path: string, body?: unknown) => {
    const outcome = await confirmSettingResponse(backend.fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }))
    if (outcome.succeeded && !path.startsWith('/api/digest')) void reload()
    return outcome
  }, [backend, reload])
  return { workspace, members, invitations, patch, put, send }
}

/** A field whose saved value lives in the workspace record. */
function useWorkspaceField<K extends keyof DemoWorkspace>(
  workspace: DemoWorkspace,
  key: K,
  patch: (next: Patch) => Promise<MutationOutcome<DemoWorkspace>>,
  options: { commitOn?: 'change' | 'blur'; debounceMs?: number; validate?: (value: DemoWorkspace[K]) => string | null } = {},
) {
  return useSettingField<DemoWorkspace[K]>({
    saved: workspace[key],
    save: async (value) => {
      const outcome = await patch({ [key]: value } as Patch)
      return outcome.succeeded ? confirmWrite(outcome.value[key]) : outcome
    },
    ...options,
  })
}

function GeneralSection({ workspace, patch, send, fetcher, viewer, onDeleted }: SectionProps & { onDeleted: () => void }) {
  const name = useWorkspaceField(workspace, 'name', patch, {
    commitOn: 'blur',
    validate: (value) => (value.trim() ? null : 'Enter a project name.'),
  })
  const timezone = useWorkspaceField(workspace, 'timezone', patch)
  const owner = viewer === 'owner'
  return (
    <>
      <SettingsSection id="project" title="Project">
        <SettingsRow label="Project name" htmlFor="project-name" {...name.rowProps}>
          <Input
            id="project-name"
            value={name.draft}
            onChange={(event) => name.setDraft(event.target.value)}
            onBlur={() => name.commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') name.commit()
              if (event.key === 'Escape') name.revert()
            }}
          />
        </SettingsRow>
        <SettingsRow label="Timezone" htmlFor="timezone" description="Moves the digest hour; scheduled posts never move." {...timezone.rowProps}>
          <TimezonePicker id="timezone" value={timezone.draft} onChange={timezone.setDraft} />
        </SettingsRow>
      </SettingsSection>
      <ExportSection
        title="Copy and export"
        endpoint="/api/exports"
        fetcher={fetcher}
        canExport={owner}
        disabledReason={ownerOnly('export everything')}
      >
        <SettingsRow label="Vault files" layout="compact">
          <Button type="button" variant="outline">Download JSON</Button>
        </SettingsRow>
      </ExportSection>
      <DeleteWorkspaceSection
        name={workspace.name}
        counts={[{ count: 214, label: 'chats' }, { count: 48, label: 'vault files' }, { count: 3, label: 'automations stop' }, { count: 3, label: 'members lose access' }]}
        disabledReason={owner ? undefined : ownerOnly('delete this project')}
        notice="Export first if you need a copy: Copy and export, above."
        onDelete={() => send('DELETE', '/api/workspace')}
        onDeleted={onDeleted}
      />
    </>
  )
}

function AgentSection({ workspace, patch, put }: SectionProps) {
  const charts = useWorkspaceField(workspace, 'charts', patch)
  const instructions = useSettingField({
    saved: workspace.instructions,
    commitOn: 'blur',
    save: (next) => put('/api/agent/instructions', 'instructions', next),
  })
  const dailyRun = useWorkspaceField(workspace, 'dailyRun', patch)
  const [confirmRun, setConfirmRun] = useState(false)
  return (
    <>
      <SettingsSection id="defaults" title="Defaults">
        <SettingsRow label="Tables and charts in chat" htmlFor="charts" layout="compact" {...charts.rowProps}>
          <Switch id="charts" checked={charts.draft} onCheckedChange={charts.setDraft} />
        </SettingsRow>
        <SettingsRow label="Custom instructions" htmlFor="instructions" layout="stacked" description="Applies to new chats and the next automation run." {...instructions.rowProps}>
          <Textarea id="instructions" value={instructions.draft} onChange={(event) => instructions.setDraft(event.target.value)} onBlur={() => instructions.commit()} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection id="automations" title="Automations">
        <SettingsRow label="Daily GTM run" htmlFor="daily-run" layout="compact" description="Runs the agent every morning on billed sandbox compute." {...dailyRun.rowProps}>
          <Switch
            id="daily-run"
            checked={dailyRun.draft}
            onCheckedChange={(on) => (on ? setConfirmRun(true) : dailyRun.setDraft(false))}
          />
        </SettingsRow>
      </SettingsSection>
      <ConfirmAction
        open={confirmRun}
        onOpenChange={setConfirmRun}
        title="Turn on the daily GTM run?"
        consequence="The agent runs every morning at 09:00 in your timezone, on billed sandbox compute. You can turn it off at any time."
        confirmLabel="Turn on"
        onConfirm={async () => {
          const outcome = await patch({ dailyRun: true })
          return outcome.succeeded ? confirmWrite(true) : outcome
        }}
      />
    </>
  )
}

const NOTICE_OPTIONS = [
  { value: 'each' as const, label: 'Each request' },
  { value: 'daily' as const, label: 'Once a day' },
  { value: 'never' as const, label: 'Never' },
]

function NotificationsSection({ workspace, patch, put, send, viewer }: SectionProps) {
  const digest = useSettingField({ saved: workspace.digest, save: (next) => put('/api/digest', 'digest', next) })
  // Clicking through the choices sends only the one the person stops on.
  const email = useWorkspaceField(workspace, 'approvalEmail', patch, { debounceMs: 600 })
  const text = useWorkspaceField(workspace, 'approvalText', patch)
  const [sent, setSent] = useState<{ ok: true; at: string } | { ok: false; message: string } | null>(null)
  const [sending, setSending] = useState(false)
  const sendNow = async () => {
    setSending(true)
    const outcome = await send('POST', '/api/digest/send')
    setSending(false)
    setSent(outcome.succeeded
      ? { ok: true, at: new Date((outcome.value as { sentAt: string }).sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
      : { ok: false, message: outcome.message })
  }
  return (
    <>
      <SettingsSection id="digest" title="Daily digest">
        <SettingsRow label="Email the owner a daily digest" htmlFor="digest-email" layout="compact" {...digest.rowProps}>
          <Switch id="digest-email" checked={digest.draft} onCheckedChange={digest.setDraft} />
        </SettingsRow>
        <SettingsRow
          label="Send a digest now"
          layout="compact"
          description={sent?.ok ? `Sent at ${sent.at}.` : undefined}
          error={sent && !sent.ok ? sent.message : undefined}
        >
          <Button type="button" variant="outline" loading={sending} onClick={() => void sendNow()}>Send now</Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection id="approvals" title="Approval notices" description="Nothing leaves this project until you approve it.">
        <SettingsRow label="Email" htmlFor="approval-email" {...email.rowProps}>
          <SegmentedControl id="approval-email" aria-label="Approval emails" value={email.draft} onValueChange={email.setDraft} options={NOTICE_OPTIONS} />
        </SettingsRow>
        <SettingsRow label="Text" htmlFor="approval-text" {...text.rowProps}>
          <SegmentedControl id="approval-text" aria-label="Approval texts" value={text.draft} onValueChange={text.setDraft} options={NOTICE_OPTIONS} />
        </SettingsRow>
        <SettingsRow label="Texting phone" htmlFor="texting-phone" disabledReason={viewer === 'owner' ? undefined : ownerOnly('change the texting phone')} description={viewer === 'owner' ? 'Texts go to the phone verified in Messaging.' : undefined}>
          <Input id="texting-phone" value="+1 (555) 010-0199" readOnly disabled={viewer !== 'owner'} />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}

function parseDollars(text: string): number | null | 'invalid' {
  const cleaned = text.replace(/[$,\s]/g, '')
  if (!cleaned) return null
  const value = Number(cleaned)
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 'invalid'
}

const money = (value: number | null) => (value === null ? 'No cap' : `$${value.toLocaleString()}`)

function LimitsSection({ workspace, patch, viewer }: SectionProps) {
  const owner = viewer === 'owner'
  const [draft, setDraft] = useState({ perDay: String(workspace.caps.perDay ?? ''), total: String(workspace.caps.total ?? '') })
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const parsed = { perDay: parseDollars(draft.perDay), total: parseDollars(draft.total) }
  const invalid = parsed.perDay === 'invalid' || parsed.total === 'invalid'
  const caps = { perDay: parsed.perDay === 'invalid' ? null : parsed.perDay, total: parsed.total === 'invalid' ? null : parsed.total }
  const changed = (['perDay', 'total'] as const).filter((key) => caps[key] !== workspace.caps[key])
  const raises = changed.filter((key) => caps[key] === null || (workspace.caps[key] !== null && caps[key]! > workspace.caps[key]!))
  const save = async (): Promise<MutationOutcome<unknown>> => {
    setState('saving')
    const outcome = await patch({ caps })
    setState(outcome.succeeded ? 'saved' : 'failed')
    setError(outcome.succeeded ? null : outcome.message)
    if (outcome.succeeded) setDraft({ perDay: String(outcome.value.caps.perDay ?? ''), total: String(outcome.value.caps.total ?? '') })
    return outcome
  }
  const label = { perDay: 'Per day', total: 'Total' }
  return (
    <SettingsSection
      id="spend-caps"
      title="Ad spend caps"
      description="Ads pause when a cap is reached."
      footer={
        <SettingsSaveBar
          changes={invalid ? 0 : changed.length}
          state={state}
          error={error}
          saveLabel="Save caps"
          disabledReason={owner ? undefined : ownerOnly('change ad spend caps')}
          onDiscard={() => setDraft({ perDay: String(workspace.caps.perDay ?? ''), total: String(workspace.caps.total ?? '') })}
          onSave={() => (raises.length > 0 ? setConfirming(true) : void save())}
        />
      }
    >
      {(['perDay', 'total'] as const).map((key) => (
        <SettingsRow
          key={key}
          label={label[key]}
          htmlFor={`cap-${key}`}
          description={caps[key] !== workspace.caps[key] && parsed[key] !== 'invalid' ? `Was ${money(workspace.caps[key])}` : undefined}
          error={parsed[key] === 'invalid' ? 'Enter an amount in dollars, such as 1,500.' : undefined}
        >
          <Input
            id={`cap-${key}`}
            inputMode="decimal"
            value={draft[key]}
            disabled={!owner}
            placeholder="No cap"
            onChange={(event) => {
              setDraft((current) => ({ ...current, [key]: event.target.value }))
              if (state !== 'saving') setState('idle')
            }}
          />
        </SettingsRow>
      ))}
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title="Raise the ad spend caps?"
        consequence="The agent can approve ad spend up to the new caps without asking again."
        changes={raises.map((key) => ({ label: label[key], from: money(workspace.caps[key]), to: money(caps[key]) }))}
        confirmLabel="Save caps"
        onConfirm={save}
      />
    </SettingsSection>
  )
}

function TeamSection({ members, invitations, send, viewer }: SectionProps) {
  const role = viewer === 'owner' ? 'owner' : 'admin'
  return (
    <>
      <MembersSection
        description="4 of 5 seats used"
        members={members}
        currentRole={role}
        currentUserId={viewer === 'owner' ? 'u-priya' : 'u-jonas'}
        onChangeRole={({ memberId, role: next }) => send('PATCH', `/api/members/${memberId}`, { role: next })}
        onRemove={({ memberId }) => send('DELETE', `/api/members/${memberId}`)}
        onInvite={(input) => send('POST', '/api/invitations', input)}
        plansHref="#plans"
        LinkComponent={DemoLink}
        menuItems={() => [{ label: 'Make team owner…', onSelect: () => undefined, disabledReason: viewer === 'owner' ? undefined : ownerOnly('choose the team owner') }]}
      />
      <InvitationsSection
        invitations={invitations}
        currentRole={role}
        onResend={({ invitationId }) => send('POST', `/api/invitations/${invitationId}/resend`)}
        onRevoke={({ invitationId }) => send('DELETE', `/api/invitations/${invitationId}`)}
        onCopy={() => undefined}
      />
    </>
  )
}

interface SectionProps {
  workspace: DemoWorkspace
  members: DemoMember[]
  invitations: DemoInvitation[]
  viewer: ViewerRole
  patch: (next: Patch) => Promise<MutationOutcome<DemoWorkspace>>
  put: <K extends keyof DemoWorkspace>(path: string, key: K, value: DemoWorkspace[K]) => Promise<MutationOutcome<DemoWorkspace[K]>>
  send: (method: string, path: string, body?: unknown) => Promise<MutationOutcome<unknown>>
  /** The export section reads through the same backend as every other row. */
  fetcher: typeof fetch
}

export function SettingsDemo({ backend: api, viewer = 'owner', initialSection = 'general', routeDelayMs = 350 }: SettingsDemoProps) {
  const { workspace, members, invitations, patch, put, send } = useWorkspaceApi(api)
  const [active, setActive] = useState<DemoSectionId>(initialSection)
  const [deleted, setDeleted] = useState(false)
  const navigate = useCallback((href: string) => {
    const id = new URL(href, 'https://settings.example').searchParams.get('section') as DemoSectionId | null
    if (!id) return
    setTimeout(() => setActive(id), routeDelayMs)
  }, [routeDelayMs])
  const sections: SettingsNavSection[] = [
    { id: 'general', label: 'General', href: '?section=general', icon: Settings },
    { id: 'agent', label: 'Agent', href: '?section=agent', icon: Bot },
    { id: 'notifications', label: 'Notifications', href: '?section=notifications', icon: Bell },
    { id: 'limits', label: 'Limits', href: '?section=limits', icon: Gauge },
    { id: 'team', label: 'Team', href: '?section=team', icon: Users, badge: members.length || undefined },
  ]
  if (deleted) return <p className="p-8 text-sm text-muted-foreground" role="status">The project was deleted. A product navigates to its project list here.</p>
  if (!workspace) return <p className="p-8 text-sm text-muted-foreground" role="status">Loading settings…</p>
  const props: SectionProps = { workspace, members, invitations, viewer, patch, put, send, fetcher: api.fetch }
  const body: Record<DemoSectionId, ReactNode> = {
    general: <GeneralSection {...props} onDeleted={() => setDeleted(true)} />,
    agent: <AgentSection {...props} />,
    notifications: <NotificationsSection {...props} />,
    limits: <LimitsSection {...props} />,
    team: <TeamSection {...props} />,
  }
  return (
    <NavigateContext.Provider value={navigate}>
      <SettingsLayout
        title="Project settings"
        description={workspace.name}
        meta={<>Setup in progress · <a className="font-medium text-[var(--accent-text)] underline-offset-4 hover:underline" href="#onboarding">Finish setup</a></>}
        sections={sections}
        activeId={active}
        LinkComponent={DemoLink}
        onIntent={() => undefined}
      >
        {body[active]}
      </SettingsLayout>
    </NavigateContext.Provider>
  )
}
