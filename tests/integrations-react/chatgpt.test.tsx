// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ConnectToChatGPT } from '../../src/integrations-react/chatgpt'
import type { ConnectToChatGPTProps } from '../../src/integrations-react/chatgpt-types'

const enrollment = { enrollmentId: 'fixture-enrollment', agentId: 'fixture-agent', workspaceId: 'fixture-workspace', threadId: 'fixture-thread' }
const props: ConnectToChatGPTProps = { app: { name: 'Builder' }, enrollment, endpoint: 'https://builder.example/api/agents/mcp' }
const registration = { connectionId: 'asdk_app_fixture', endpoint: props.endpoint }
const connected = { status: 'connected', registration, enrollment } as const

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('ConnectToChatGPT', () => {
  it('runs all projection regressions against the actual TypeScript source', () => {
    const script = fileURLToPath(new URL('./chatgpt-state.node.mjs', import.meta.url))
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--test', script], { encoding: 'utf8' })
    expect(output).toContain('# fail 0')
    expect(output).toContain('# tests 19')
  })

  it('keeps one primary action, native details, and an associated read-only endpoint', async () => {
    const user = userEvent.setup()
    const { container } = render(<ConnectToChatGPT {...props} />)
    const action = screen.getByRole('link', { name: 'Connect to ChatGPT' })
    expect(action.getAttribute('href')).toBe('https://chatgpt.com/plugins')
    expect(action.getAttribute('target')).toBe('_blank')
    expect(action.getAttribute('rel')).toBe('noopener noreferrer')
    expect(action.getAttribute('referrerpolicy')).toBe('no-referrer')
    await user.tab()
    expect(document.activeElement).toBe(action)
    await user.tab()
    expect(document.activeElement?.tagName).toBe('SUMMARY')
    // Native keyboard toggling and layout are checked by the packed browser probe.
    fireEvent.click(container.querySelector('summary')!)
    const endpoint = screen.getByLabelText('MCP endpoint') as HTMLInputElement
    endpoint.focus()
    expect(endpoint.readOnly).toBe(true)
    expect(endpoint.value).toBe(props.endpoint)
    expect(endpoint.selectionEnd! - endpoint.selectionStart!).toBe(props.endpoint.length)
  })

  it('does not infer connection from navigation, messages, or package generation', () => {
    const fetch = vi.fn(() => { throw new Error('unexpected request') })
    vi.stubGlobal('fetch', fetch)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const { container } = render(<ConnectToChatGPT {...props} />)
    const action = screen.getByRole('link', { name: 'Connect to ChatGPT' })
    action.addEventListener('click', event => event.preventDefault())
    fireEvent.click(action)
    window.dispatchEvent(new MessageEvent('message', { data: { status: 'connected' }, origin: 'https://chatgpt.com' }))
    expect(container.querySelector('section')?.getAttribute('data-chatgpt-state')).toBe('setup')
    expect(fetch).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
  })

  it('reuses registered connections without showing create-another instructions', () => {
    const { container } = render(<ConnectToChatGPT {...props} connection={{ status: 'registered', registration }} />)
    fireEvent.click(container.querySelector('summary')!)
    expect(screen.getByRole('link', { name: 'Use existing connection' }).getAttribute('href')).toBe('https://chatgpt.com/plugins')
    expect(screen.queryByText(/choose the plus button/)).toBeNull()
    expect(screen.getByText(/Registration alone does not confirm/)).toBeTruthy()
    expect(screen.queryByText('Connected to this agent')).toBeNull()
  })

  it('clears stale success and open details when the selected conversation changes', () => {
    const { container, rerender } = render(<ConnectToChatGPT {...props} connection={connected} />)
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.open).toBe(true)
    rerender(<ConnectToChatGPT {...props} enrollment={{ ...enrollment, threadId: 'different' }} connection={connected} />)
    expect(screen.queryByText('Connected to this agent')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('different agent or conversation')
    expect(container.querySelector('details')?.open).toBe(false)
    expect(container.textContent).not.toContain(registration.connectionId)
  })

  it('announces checking and failure instead of leaving prior success visible', () => {
    const { container, rerender } = render(<ConnectToChatGPT {...props} connection={connected} />)
    rerender(<ConnectToChatGPT {...props} connection={{ status: 'checking' }} />)
    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: 'Checking connection…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('link', { name: 'Open ChatGPT' })).toBeNull()
    rerender(<ConnectToChatGPT {...props} connection={{ status: 'error' }} />)
    expect(screen.getByRole('alert').textContent).toContain('Connection not confirmed')
    expect(container.querySelector('section')?.hasAttribute('aria-busy')).toBe(false)
  })

  it('does not reflect a credential-bearing endpoint', () => {
    const { container } = render(<ConnectToChatGPT {...props} endpoint="https://secret:credential@builder.example/mcp" />)
    expect(screen.getByRole('alert').textContent).toContain('Setup unavailable')
    expect((screen.getByRole('button', { name: 'Setup unavailable' }) as HTMLButtonElement).disabled).toBe(true)
    expect(container.innerHTML).not.toMatch(/secret|credential@/)
    expect(screen.queryByLabelText('MCP endpoint')).toBeNull()
  })

  it('mounts independently for two apps with unique labels and IDs', () => {
    const { container } = render(<>
      <ConnectToChatGPT {...props} />
      <ConnectToChatGPT {...props} app={{ name: 'GTM' }} endpoint="https://gtm.example/api/agents/mcp" />
    </>)
    const ids = Array.from(container.querySelectorAll('[id]'), element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(screen.getByRole('region', { name: 'Builder Connect to ChatGPT' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'GTM Connect to ChatGPT' })).toBeTruthy()
    expect(screen.getByText('Builder')).toBeTruthy()
    expect(screen.getByText('GTM')).toBeTruthy()
  })
})
