from pathlib import Path

def replace(path, before, after):
    p = Path(path)
    text = p.read_text()
    if text.count(before) != 1:
        raise RuntimeError(f'{path}: expected one source match')
    p.write_text(text.replace(before, after, 1))

replace('src/web-react/controls.tsx', """      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }""", """      if (e.key === 'Escape' && !e.defaultPrevented) {
        const ownPath = panelRef.current?.getAttribute(POPOVER_SURFACE_ATTR)
        const focusedPath = document.activeElement?.closest(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR)
        if (ownPath && focusedPath?.startsWith(`${ownPath}${POPOVER_PATH_SEPARATOR}`)) return
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }""")
replace('src/web-react/agent-session-controls.tsx', "import { HarnessGlyph } from './harness-glyphs'", "import { HarnessGlyph } from './harness-glyphs'\nimport { AgentSettingsPopover } from './agent-settings-popover'")
replace('src/web-react/agent-session-controls.tsx', "layout?: 'inline' | 'compact'", "layout?: 'inline' | 'compact' | 'grouped'\n  /** Optional host-owned profile selector inside the grouped settings surface. */\n  profileControl?: ReactNode\n  /** Profile name or other current identity shown on the grouped trigger. */\n  settingsSummary?: ReactNode")
replace('src/web-react/agent-session-controls.tsx', '    className,\n  } = props', '    className,\n    profileControl,\n    settingsSummary,\n  } = props')
replace('src/web-react/agent-session-controls.tsx', "  if (layout === 'inline') {", """  if (layout === 'grouped') {
    return (
      <AgentSettingsPopover summary={settingsSummary ?? selectedModel?.name ?? model} className={className}>
        {profileControl != null && <div className="space-y-1.5"><p className="text-xs font-medium text-muted-foreground">Profile</p>{profileControl}</div>}
        <div className="space-y-1.5"><p className="text-xs font-medium text-muted-foreground">Model</p>{modelPicker}</div>
        {showHarness && <div className="space-y-1.5"><p className="text-xs font-medium text-muted-foreground">Agent backend</p><HarnessPicker value={harness} onChange={onHarness} available={availableHarnesses} lockReason={harnessLockReason} fullWidth variant={variant} /></div>}
        {showEffort && <div className="space-y-1.5"><p className="text-xs font-medium text-muted-foreground">Thinking</p><EffortPicker value={effort} onChange={onEffortChange} levels={effortLevels} fullWidth variant={variant} /></div>}
      </AgentSettingsPopover>
    )
  }

  if (layout === 'inline') {""")
replace('src/web-react/agent-session-controls.tsx', 'behavior. `compact`: model inline, harness + effort behind a gear popover.', 'behavior. `compact`: model inline, harness + effort behind a gear popover.\n   * `grouped`: one named settings dialog containing the same controlled pickers.')
for path, text in [
  ('src/web-react/index.tsx', "\nexport * from './agent-settings-popover'\nexport * from './workspace-switcher'\n"),
  ('src/workspace-react/index.tsx', "\nexport { WorkspaceSwitcher, type WorkspaceSwitcherItem, type WorkspaceSwitcherProps } from '../web-react/workspace-switcher'\n")
]:
    p = Path(path)
    p.write_text(p.read_text() + text)
replace('src/web-react/entry-composer.tsx', "'relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-background px-5'", "'relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto bg-background px-5 py-8'")
replace('src/web-react/entry-composer.tsx', '<div className="w-full" style={{ maxWidth }}>', '<div className="my-auto w-full shrink-0" style={{ maxWidth }}>')
Path('.changeset').mkdir(exist_ok=True)
Path('.changeset/shared-workspace-controls.md').write_text('''---
"@tangle-network/agent-app": minor
---

Export a searchable WorkspaceSwitcher and an accessible AgentSettingsPopover.
Add grouped AgentSessionControls with host-owned profile content while preserving
model, harness, reasoning, and lock semantics. Nested Escape dismisses the inner
picker first. Entry composers scroll on short screens instead of clipping.
''')
