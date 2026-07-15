// Uses bg-surface-container-high — a bare Tailwind class carrying no literal
// reference, so the first check can't see it. The agent-app preset maps that
// class to the popover elevation token, which the fixture tokens.css omits →
// the utility check must flag it and name the class that resolves to it. This
// is the exact shape of the tax-agent transparent-dropdown incident.
export function BadUtilityComponent() {
  return <div className="rounded-md bg-surface-container-high p-2">transparent panel</div>
}
