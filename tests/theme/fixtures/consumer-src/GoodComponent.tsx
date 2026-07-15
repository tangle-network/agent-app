// References only tokens the fixture tokens.css defines: var(--card) directly
// and `bg-card`/`text-foreground` utilities (bg-card → --card, defined). The
// checker must report NO miss for this file.
export function GoodComponent() {
  return (
    <div className="rounded-lg bg-card text-foreground" style={{ borderColor: 'var(--card)' }}>
      defined tokens only
    </div>
  )
}
