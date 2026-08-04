/**
 * The calibration proof: every case below is a shape lifted from one of the two
 * production verticals this gate was measured against, with the file and line
 * it was measured at named in the test. Unit tests written from imagination
 * describe a checker's intent; these describe what shipped.
 *
 * Half of them assert a REPORT (the defect the audit named, which a doc argued
 * about and the verticals shipped anyway) and half assert SILENCE (the shape
 * that produced a false positive, whose removal is the only reason a team keeps
 * the gate switched on). Both halves are load-bearing: a checker that loses the
 * first is useless and one that loses the second gets disabled, and only the
 * pair of them together is a calibration.
 *
 * Measured totals are in `docs/legibility-calibration.md`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkEmptyStates } from './checks/empty-state'
import { checkReachability } from './checks/reachability'
import { checkSilentFailure } from './checks/silent-failure'
import { checkUncheckedSuccess } from './checks/success'
import { checkVocabulary } from './checks/vocabulary'
import { buildScannedFile, scanSources } from './scan'

const at = (path: string, source: string) => buildScannedFile(path, source)

describe('vocabulary — the word the audit named', () => {
  it('reports "materialization" reaching a reader from a thrown Error', () => {
    // legal-agent src/lib/.server/chat/attachment-store.ts:114 — the flagship
    // instance, and the reason the `new Error` tier exists at all: the word
    // never appears in a component, only in a server module whose message the
    // chat transcript renders.
    const findings = checkVocabulary(
      at(
        '/app/src/lib/.server/chat/attachment-store.ts',
        'throw new Error(`Attachment read produced no bytes for sandbox materialization: ${part.path}`)',
      ),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('materialization')
  })

  it('does not report the same word as an identifier', () => {
    // tax-agent has 20+ `materializeTaxSkillsForTurn` references and not one is
    // copy. A word-boundary match is what keeps them out.
    const findings = checkVocabulary(
      at('/app/src/lib/.server/tax/chat-turn.ts', "import { materializeTaxSkillsForTurn } from './skill-placement'"),
    )
    expect(findings).toEqual([])
  })
})

describe('unchecked success — the Settings page that answered "Saved" to a 404', () => {
  it('reports the shipped handler', () => {
    // tax-agent apps/web/src/routes/app.settings.tsx:163-179, verbatim shape.
    const findings = checkUncheckedSuccess(
      at(
        '/app/src/routes/app.settings.tsx',
        `
        const handleSave = async () => {
          setSaving(true)
          setSaved(false)
          try {
            await fetch(\`\${API_BASE}/api/settings\`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify(settings),
            })
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
          } catch (err) {
            console.warn('[settings] save failed:', err)
          }
          setSaving(false)
        }
      `,
      ),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('resolves on a 404')
  })

  it('reports a toast fired on an unread PATCH', () => {
    // legal-agent src/routes/app.workspace.approvals.tsx:37-45. A rejected
    // approval renders "Approved".
    const findings = checkUncheckedSuccess(
      at(
        '/app/src/routes/app.workspace.approvals.tsx',
        `
        const executeAction = async (id: string, status: 'approved' | 'rejected') => {
          await fetch('/api/approvals', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionId: id, status }),
          })
          toast.success(status === 'approved' ? 'Approved' : 'Rejected')
          revalidator.revalidate()
        }
      `,
      ),
    )
    expect(findings).toHaveLength(1)
  })
})

describe('silent failure — the fluent chain that hid two screens', () => {
  it('reports a multi-line fetch chain whose .catch only clears the spinner', () => {
    // legal-agent src/routes/app.workspace.templates.tsx:50-58 and
    // src/routes/app.billing.tsx:19-27, the same shape twice. A line-anchored
    // scan back from `.catch` sees only whitespace and reports nothing, which is
    // why both screens render a network failure as an empty library.
    const findings = checkSilentFailure(
      at(
        '/app/src/routes/app.workspace.templates.tsx',
        `
        useEffect(() => {
          fetch('/api/templates')
            .then((r) => r.json() as Promise<{ templates?: TemplateSummary[] }>)
            .then((data) => {
              setTemplates(data.templates ?? [])
              setLoading(false)
            })
            .catch(() => setLoading(false))
        }, [])
      `,
      ),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('discards the failure')
  })

  it('still ignores a body-parse fallback written the same way', () => {
    // The precision half of the same rule: a chain that ENDS at `.json()` is a
    // parse fallback on a response whose status the caller already read.
    const findings = checkSilentFailure(
      at(
        '/app/src/routes/app.workspace.templates.tsx',
        `
        const load = async () => {
          const res = await fetch('/api/templates')
          if (!res.ok) return setError('Could not load templates')
          const body = await res
            .json()
            .catch(() => ({}))
          setTemplates(body.templates ?? [])
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })

  it('ignores a handler in a module that cannot render', () => {
    // legal-agent src/lib/.server/audit.ts:27 and 20 more like it. The failure
    // IS reported here — to the operator — and 31 of 52 findings were this.
    const findings = checkSilentFailure(
      at(
        '/app/src/lib/.server/audit.ts',
        `
        export async function logAudit(params: AuditParams): Promise<void> {
          try {
            await db.insert(auditLog).values({ ...params })
          } catch (err) {
            console.error('[audit] failed to write audit log:', err)
          }
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })

  it('ignores a try whose only I/O is reading a request body', () => {
    // tax-agent apps/web/src/routes/api.sessions.$id.chat.ts:26-31, legal-agent
    // src/lib/.server/chat/chat-vertical.ts:227-232. A parse fallback, not a
    // request that failed.
    const findings = checkSilentFailure(
      at(
        '/app/src/routes/edge.ts',
        `
        let body: Record<string, unknown> = {}
        try {
          body = (await request.clone().json()) as Record<string, unknown>
        } catch {
          body = {}
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })

  it('ignores a handler that puts the control back', () => {
    // tax-agent apps/web/src/routes/app.$sessionId.tsx:524-535. The toggle
    // visibly snaps back, which is the failure being reported.
    const findings = checkSilentFailure(
      at(
        '/app/src/routes/app.$sessionId.tsx',
        `
        const togglePlanMode = async (next: boolean) => {
          const previous = planMode
          setPlanMode(next)
          try {
            const response = await fetch('/api/plan-mode', { method: 'POST', body: JSON.stringify({ planMode: next }) })
            if (!response.ok) setPlanMode(previous)
          } catch {
            setPlanMode(previous)
          }
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })

  it('ignores a handler that returns a named outcome', () => {
    // tax-agent apps/web/src/hooks/use-session-file-mentions.ts:23. "unknown" is
    // a third state the screen renders, not a swallowed failure.
    const findings = checkSilentFailure(
      at(
        '/app/src/hooks/use-session-file-mentions.ts',
        `
        async function probe(): Promise<'warming' | 'ready' | 'unknown'> {
          try {
            const body = await (await fetch('/api/status')).json()
            if (body.status === 'ready') return 'ready'
            return 'unknown'
          } catch {
            return 'unknown'
          }
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })

  it('ignores a preference that failed to persist', () => {
    // tax-agent apps/web/src/components/theme-toggle.tsx:20-24. The theme
    // applied; only the write failed. Reporting it teaches a team that this
    // check cannot tell a failure from a preference.
    const findings = checkSilentFailure(
      at(
        '/app/src/components/theme-toggle.tsx',
        `
        function persist(theme: string): void {
          try {
            localStorage.setItem(STORAGE_KEY, theme)
          } catch {
            // private mode / storage disabled
          }
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })
})

describe('empty states — a screen that strands the reader vs a section that does not', () => {
  it('reports the page whose whole body is the empty state', () => {
    // tax-agent apps/web/src/routes/app.calendar.tsx:372, the instance the
    // product-clarity audit named.
    const findings = checkEmptyStates(
      at(
        '/app/src/routes/app.calendar.tsx',
        `
        export default function Calendar() {
          return (
            <div className="p-6">
              {deadlines.length === 0 ? (
                <div className="rounded-xl border p-10 text-center">
                  <p className="text-sm">No deadlines tracked yet</p>
                </div>
              ) : (
                <ul>{deadlines.map((d) => <li key={d.id}>{d.title}</li>)}</ul>
              )}
            </div>
          )
        }
      `,
      ),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('No deadlines tracked yet')
  })

  it('does not report a titled section with nothing in it', () => {
    // legal-agent src/routes/app.workspace.contracts.$id.tsx:154-227 carries
    // four of these under four `<h2>`s. The screen is full; the reader is
    // oriented; reporting all four buries the page-level dead end above.
    const findings = checkEmptyStates(
      at(
        '/app/src/routes/app.workspace.contracts.$id.tsx',
        `
        export default function ContractDetail() {
          return (
            <div>
              <section>
                <h2 className='text-lg font-semibold mb-2'>Parties</h2>
                {contract.parties.length === 0 ? (
                  <p className='text-muted-foreground text-sm'>No parties recorded.</p>
                ) : (
                  <ul>{contract.parties.map((p) => <li key={p.name}>{p.name}</li>)}</ul>
                )}
              </section>
            </div>
          )
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })

  it('does not report a per-row placeholder inside a list', () => {
    // legal-agent src/routes/app.workspace.filings.tsx:106-110 — an empty
    // kanban column, rendered once per stage on a screen full of other stages.
    const findings = checkEmptyStates(
      at(
        '/app/src/routes/app.workspace.filings.tsx',
        `
        export default function Filings() {
          return (
            <div className="grid grid-cols-4">
              {stages.map((stage) => (
                <div key={stage.id}>
                  <p>{stage.title}</p>
                  {stage.items.length === 0 && (
                    <div className="flex items-center justify-center h-20 text-xs">No filings</div>
                  )}
                </div>
              ))}
            </div>
          )
        }
      `,
      ),
    )
    expect(findings).toEqual([])
  })
})

/** A product tree on disk: the reachability check reads real files. */
function product(files: Record<string, string>): { dir: string; routes: string } {
  const root = mkdtempSync(join(tmpdir(), 'legibility-calibration-'))
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return { dir: join(root, 'src'), routes: join(root, 'src/routes.ts') }
}

describe('unreachable capability — the island', () => {
  /**
   * legal-agent, reduced: three contract screens that link each other, and a
   * sidebar that names none of them. Every route in the island has an inbound
   * link, so "does a link exist" answers yes for all three — and the redline
   * engine shipped openable only by typing its URL.
   */
  const ROUTES = `
import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/_index.tsx'),
  route('app', 'routes/app.tsx', [
    route(':workspaceId', 'routes/app.workspace.tsx', [
      index('routes/app.workspace._index.tsx'),
      route('filings', 'routes/app.workspace.filings.tsx'),
      route('contracts', 'routes/app.workspace.contracts.tsx'),
      route('contracts/redline', 'routes/app.workspace.contracts.redline.tsx'),
      route('contracts/:id', 'routes/app.workspace.contracts.$id.tsx'),
    ]),
  ]),
] satisfies RouteConfig
`

  const SIDEBAR = `
const NAV = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'filings', label: 'Filings', path: '/filings' },
]
`

  const FILES = {
    'src/routes.ts': ROUTES,
    'src/components/workspace-sidebar.tsx': SIDEBAR,
    'src/routes/app.workspace.contracts.tsx': `
      export default function Contracts() {
        return <Link to={\`/app/\${workspaceId}/contracts/redline\`}>Redline</Link>
      }
    `,
    'src/routes/app.workspace.contracts.redline.tsx': `
      export default function Redline() {
        return <Link to={\`/app/\${workspaceId}/contracts/\${contract.contractId}\`}>Open</Link>
      }
    `,
    'src/routes/app.workspace.contracts.$id.tsx': `
      export default function ContractDetail() {
        return <Link to={\`/app/\${workspaceId}/contracts\`}>Back</Link>
      }
    `,
    'src/routes/app.workspace.filings.tsx': 'export default function Filings() { return <div /> }',
  }

  const unreachable = (files: Record<string, string>): string[] => {
    const { dir, routes } = product(files)
    const result = checkReachability({
      files: scanSources([dir]),
      options: { routeConfigFile: routes, navFiles: [join(dir, 'components/workspace-sidebar.tsx')] },
    })
    return result.findings.map((finding) => /"([^"]+)"/.exec(finding.message)?.[1] ?? '')
  }

  it('reports every screen in a mutually-linked island', () => {
    expect(unreachable(FILES).sort()).toEqual([
      'app/:workspaceId/contracts',
      'app/:workspaceId/contracts/:id',
      'app/:workspaceId/contracts/redline',
    ])
  })

  it('clears the whole island when one navigation entry opens it', () => {
    expect(
      unreachable({
        ...FILES,
        'src/components/workspace-sidebar.tsx': `${SIDEBAR}\nconst EXTRA = { id: 'contracts', path: '/contracts' }\n`,
      }),
    ).toEqual([])
  })

  it('opens the island transitively from one link in a shared component', () => {
    // A link in a file that is not a route module could be rendered anywhere,
    // so it counts as always available — the direction that removes findings.
    // Opening the contract LIST then makes the list's own link to the redline a
    // door, and the redline's link to the detail page a door after that: the
    // pass runs to a fixpoint rather than one hop.
    expect(
      unreachable({
        ...FILES,
        'src/components/contract-banner.tsx': `
          export function ContractBanner() {
            return <Link to={\`/app/\${workspaceId}/contracts\`}>Contracts</Link>
          }
        `,
      }),
    ).toEqual([])
  })

  it('does not report a route whose path is computed', () => {
    // legal-v2 src/routes.ts:139 — `route(pattern, 'routes/x.ts', { id })` in a
    // `.map()`. The path is not in the source, so no door can be checked
    // against it and the module name must not be read as one.
    expect(
      unreachable({
        ...FILES,
        'src/routes.ts': ROUTES.replace(
          "      route('filings', 'routes/app.workspace.filings.tsx'),",
          "      ...LEGACY.map((pattern) => route(pattern, 'routes/legacy-redirect.ts', { id: pattern })),",
        ),
      }),
    ).not.toContain('app/:workspaceId/routes/legacy-redirect.ts')
  })
})
