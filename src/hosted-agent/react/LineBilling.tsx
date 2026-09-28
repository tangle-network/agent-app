import type { LineBillingProps } from './contracts'

function resetTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** Read-only billing facts from the line attachment and Hub allowance status. */
export function LineBilling({ view }: LineBillingProps) {
  return <section className="tangle-lines" aria-label="Line billing">
    <header className="tangle-lines__heading">
      <div><h2>Billing</h2><p>{view.lineAddress}</p></div>
    </header>
    <dl className="tangle-lines__billing">
      <div>
        <dt>Line</dt>
        <dd>{view.linePayer.kind === 'workspace' ? view.linePayer.label : 'Payer not verified'}</dd>
        {view.linePayer.kind === 'workspace' && <dd className="tangle-lines__billing-detail">Charged to {view.workspaceName}.</dd>}
      </div>
      <div>
        <dt>Agent turns</dt>
        <dd>{view.turnPayer.kind === 'unverified' ? 'Payer not verified' : view.turnPayer.label}</dd>
        {view.turnPayer.kind === 'member' && <dd className="tangle-lines__billing-detail">Each member pays for their own admitted turns.</dd>}
      </div>
      <div>
        <dt>Allowance</dt>
        {view.allowance ? <>
          <dd>{view.allowance.turnsPerMemberPerDay} turns per member each day</dd>
          {view.allowance.used !== undefined && view.allowance.limit !== undefined &&
            <dd className="tangle-lines__billing-detail">{view.allowance.used} of {view.allowance.limit} turns used{view.allowance.resetsAt ? ` · resets ${resetTime(view.allowance.resetsAt)}` : ''}</dd>}
        </> : <dd>No allowance reported</dd>}
      </div>
    </dl>
  </section>
}
