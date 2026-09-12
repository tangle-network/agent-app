import { describe, expect, it } from 'vitest'
import { isWorkspaceFileExportable } from '../src/web/file-export'

describe('workspace file export boundary', () => {
  it.each(['opencode.json', 'OPENCODE.JSON', 'OpEnCoDe.JsOnC', 'nested/opencode.json', '.env', '.codex/auth.json', 'a/.config/token', '../opencode.json', './brief.md', '/brief.md', 'a//brief.md', 'a\\brief.md', 'a\0brief.md'])('excludes runtime or invalid path %s', path => {
    expect(isWorkspaceFileExportable(path)).toBe(false)
  })
  it.each(['brief.md', 'content/buyer-experiment.json', 'docs/opencode.json.md', 'configs/public.json'])('retains business file %s', path => {
    expect(isWorkspaceFileExportable(path)).toBe(true)
  })
})
