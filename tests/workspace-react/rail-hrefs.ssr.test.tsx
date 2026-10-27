// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentWorkspaceLayout } from '../../src/workspace-react'

const Icon = () => <svg />
const render = (hrefForAgent: (id: string) => string) => renderToString(
  <AgentWorkspaceLayout navItems={[]} agents={{ icon: Icon, items: [{ id: 'lead', name: 'Research Lead', handle: 'research-lead' }], hrefForAgent }}>
    <p>Thread</p>
  </AgentWorkspaceLayout>,
)
afterEach(() => vi.restoreAllMocks())

// GTM release a371453 (2026-10-27) linked every rail row to /chat/new?profile=<id>; the old
// guard threw on the "?" while rendering, and every workspace page answered 500.
it('renders a rail row whose local href carries a query string', () => {
  const html = render((id) => `/app/ws/chat/new?profile=${id}`)
  expect(html).toContain('Research Lead')
  expect(html).toContain('/app/ws/chat/new?profile=lead')
})

it('drops and reports a row whose href is not a local path instead of failing the page', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const html = render(() => '//evil.example/x')
  expect(html).toContain('Thread')
  expect(html).not.toContain('evil.example')
  expect(error).toHaveBeenCalledWith(expect.stringContaining('dropped agent lead'))
})
