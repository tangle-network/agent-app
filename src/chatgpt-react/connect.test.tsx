// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatGPTConnect } from './index'
import { creativeExample, gtmExample } from './fixtures'

describe('ChatGPT connection surface', () => {
  it('opens supported setup with the exact endpoint, without inferring connected state', async () => {
    const user = userEvent.setup()
    render(<ChatGPTConnect {...gtmExample} />)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connect to ChatGPT' }))
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText('MCP URL').getAttribute('value')).toBe(gtmExample.endpoint)
    expect(screen.getByRole('link', { name: 'ChatGPT Plugins (new tab)' }).getAttribute('href')).toBe('https://chatgpt.com/plugins')
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('Ready to connect')
    await user.click(screen.getByRole('button', { name: 'Copy URL' }))
    expect(await navigator.clipboard.readText()).toBe(gtmExample.endpoint)
    expect(screen.getByText('MCP URL copied')).toBeTruthy()
    expect(screen.queryByText('Connected to ChatGPT')).toBeNull()
  })

  it('uses an explicitly supplied ChatGPT URL and never derives one from the ID', () => {
    render(<ChatGPTConnect {...gtmExample} registeredConnection={{ id: 'test-record-id', url: 'https://chatgpt.com/plugins' }} />)
    const action = screen.getByRole('link', { name: 'Connect to ChatGPT (opens a new tab)' })
    expect(action.getAttribute('href')).toBe('https://chatgpt.com/plugins')
    expect(action.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.queryByText('Connected to ChatGPT')).toBeNull()
  })

  it('falls back to supported setup for an invalid registered destination', async () => {
    const user = userEvent.setup()
    render(<ChatGPTConnect {...gtmExample} registeredConnection={{ id: 'test-record-id', url: 'https://chatgpt.com.evil.example/install' }} />)
    await user.click(screen.getByRole('button', { name: 'Connect to ChatGPT' }))
    expect(screen.getByLabelText('MCP URL').getAttribute('value')).toBe(gtmExample.endpoint)
    expect(screen.queryByRole('link', { name: 'Connect to ChatGPT (opens a new tab)' })).toBeNull()
  })

  it('renders host-confirmed state and delegates checks without granting or connecting anything', async () => {
    const user = userEvent.setup()
    const onCheck = vi.fn()
    const { rerender } = render(<ChatGPTConnect {...gtmExample} onCheck={onCheck} state={{ status: 'error', message: 'Please try again.' }} />)
    expect(screen.getByRole('alert').textContent).toBe('Please try again.')
    await user.click(screen.getByRole('button', { name: 'Check connection' }))
    expect(onCheck).toHaveBeenCalledTimes(1)
    rerender(<ChatGPTConnect {...gtmExample} onCheck={onCheck} state={{ status: 'checking' }} />)
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
    rerender(<ChatGPTConnect {...gtmExample} state={{ status: 'connected' }} />)
    expect(screen.getByRole('status').textContent).toBe('Connected to ChatGPT')
    expect(screen.getByRole('link', { name: 'Open in ChatGPT (opens a new tab)' }).getAttribute('href')).toBe('https://chatgpt.com/plugins')
  })

  it('drops setup and clipboard feedback when enrollment changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ChatGPTConnect {...gtmExample} />)
    await user.click(screen.getByRole('button', { name: 'Connect to ChatGPT' }))
    await user.click(screen.getByRole('button', { name: 'Copy URL' }))
    expect(screen.getByText('MCP URL copied')).toBeTruthy()
    rerender(<ChatGPTConnect {...creativeExample} />)
    expect(screen.queryByLabelText('MCP URL')).toBeNull()
    expect(screen.queryByText('MCP URL copied')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connect to ChatGPT' }))
    expect(screen.getByLabelText('MCP URL').getAttribute('value')).toBe(creativeExample.endpoint)
  })

  it('supports manual copy when clipboard access is unavailable', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('clipboard unavailable'))
    render(<ChatGPTConnect {...gtmExample} />)
    await user.click(screen.getByRole('button', { name: 'Connect to ChatGPT' }))
    await user.click(screen.getByRole('button', { name: 'Copy URL' }))
    expect(await screen.findByText('Select the MCP URL and copy it manually.')).toBeTruthy()
    await user.click(screen.getByLabelText('MCP URL'))
    const input = screen.getByLabelText('MCP URL')
    expect(input instanceof HTMLInputElement && input.selectionStart === 0 && input.selectionEnd === gtmExample.endpoint.length).toBe(true)
  })

  it('does not expose an invalid endpoint containing credentials', () => {
    const endpoint = 'https://user:private@example.com/mcp?token=private'
    render(<ChatGPTConnect {...gtmExample} endpoint={endpoint} />)
    expect(screen.getByRole('button', { name: 'Connect to ChatGPT' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('public HTTPS MCP URL')
    expect(document.body.textContent).not.toContain('private')
    expect(screen.queryByLabelText('MCP URL')).toBeNull()
  })
})
