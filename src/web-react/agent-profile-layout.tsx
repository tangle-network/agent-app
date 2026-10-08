import type { ReactNode } from 'react'

const sectionGlyphs: Record<string, { path: string; color: string }> = {
  Identity: { path: 'M20 21v-2a7 7 0 0 0-14 0v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', color: 'bg-primary/10 text-primary' },
  'Prompts and instructions': { path: 'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3 M9 15l3-1 9-9-2-2-9 9-1 3', color: 'bg-primary/10 text-primary' },
  'Tools and permissions': { path: 'M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7l-9-4 M8 12l3 3 5-6', color: 'bg-success/10 text-success' },
  'Model and runtime': { path: 'M8 8h8v8H8z M9 3v5m6-5v5M9 16v5m6-5v5M3 9h5m-5 6h5m8-6h5m-5 6h5', color: 'bg-primary/10 text-primary' },
}
const resourceGlyph = { path: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6 M14 2v6h6 M8 13h8m-8 4h6', color: 'bg-warning/10 text-warning-strong' }

export function ProfileSectionHeading({ title }: { title: string }) {
  const glyph = sectionGlyphs[title] ?? resourceGlyph
  return <span className="flex min-w-0 items-center gap-3">
    <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${glyph.color}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={glyph.path} /></svg>
    </span>
    <span className="min-w-0 break-words text-sm font-semibold text-foreground">{title}</span>
  </span>
}

export function ProfileCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
    <header className="border-b border-border bg-muted/35 px-4 py-3 sm:px-5">
      <h3><ProfileSectionHeading title={title} /></h3>
      {description && <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>}
    </header>
    <div className="min-w-0 space-y-4 p-4 sm:p-5">{children}</div>
  </section>
}
