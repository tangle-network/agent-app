// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiAccessPanel, type ApiAccessPanelProps } from './api-access-panel'

const fixtureKey = 'synthetic-client-key-not-a-credential'
const props = (): ApiAccessPanelProps => ({
  keys: [],
  access: [
    { scope: 'records:read', label: 'Read records', description: 'Read your records.' },
    { scope: 'records:write', label: 'Edit records', description: 'Edit your records.' },
  ],
  defaultScopes: ['records:read'],
  baseUrl: 'https://example.test',
  onCreate: vi.fn(async () => ({ id: 'key-1', key: fixtureKey })),
  onRevoke: vi.fn(async () => {}),
  onChanged: vi.fn(),
})

async function create() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My client' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
  await screen.findByRole('heading', { name: 'Save your key' })
}

describe('ApiAccessPanel', () => {
  it('uses app scopes and finite expiry, masks the secret, and discards it after acknowledgement', async () => {
    const callbacks = props()
    render(<ApiAccessPanel {...callbacks} />)
    await create()
    expect(callbacks.onCreate).toHaveBeenCalledWith({ name: 'My client', scopes: ['records:read'], expiresAt: expect.any(String) })
    const input = vi.mocked(callbacks.onCreate).mock.calls[0]![0]
    expect(Date.parse(input.expiresAt) - Date.now()).toBeGreaterThan(6 * 86_400_000)
    expect(Date.parse(input.expiresAt) - Date.now()).toBeLessThanOrEqual(7 * 86_400_000)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Save your key' }))
    const secret = screen.getByLabelText<HTMLInputElement>('New API key')
    expect(secret.type).toBe('password')
    expect(secret.value).toBe(fixtureKey)
    expect(screen.queryByText(fixtureKey)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'I’ve saved it' }))
    expect(screen.queryByLabelText('New API key')).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
    expect(callbacks.onChanged).toHaveBeenCalledOnce()
  })

  it('passes changed scopes and expiry to the app callback', async () => {
    const callbacks = props()
    render(<ApiAccessPanel {...callbacks} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Edit records/ }))
    fireEvent.change(screen.getByLabelText('Expires in'), { target: { value: '1' } })
    await create()
    const input = vi.mocked(callbacks.onCreate).mock.calls[0]![0]
    expect(input.scopes).toEqual(['records:read', 'records:write'])
    expect(Date.parse(input.expiresAt) - Date.now()).toBeGreaterThan(80_000_000)
    expect(Date.parse(input.expiresAt) - Date.now()).toBeLessThanOrEqual(86_400_000)
  })

  it('does not submit default scopes absent from the visible permissions', async () => {
    const callbacks = props()
    callbacks.defaultScopes = ['records:read', 'hidden:admin']
    render(<ApiAccessPanel {...callbacks} />)
    await create()
    expect(vi.mocked(callbacks.onCreate).mock.calls[0]![0].scopes).toEqual(['records:read'])
  })

  it('drops a selected permission when the app removes it, even if it later returns', async () => {
    const callbacks = props()
    const { rerender } = render(<ApiAccessPanel {...callbacks} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My client' } })
    rerender(<ApiAccessPanel {...callbacks} access={[callbacks.access[1]!]} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create key' }).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('button', { name: 'Create key' }).closest('form')!)
    expect(callbacks.onCreate).not.toHaveBeenCalled()
    rerender(<ApiAccessPanel {...callbacks} />)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read records/ }).checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: /Edit records/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('heading', { name: 'Save your key' })
    expect(vi.mocked(callbacks.onCreate).mock.calls[0]![0].scopes).toEqual(['records:write'])
  })

  it('shows failed creation without exposing a secret or claiming success', async () => {
    const callbacks = props()
    callbacks.onCreate = vi.fn(async () => { throw new Error('Key store unavailable') })
    render(<ApiAccessPanel {...callbacks} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My client' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Key store unavailable')
    expect(screen.queryByLabelText('New API key')).toBeNull()
    expect(callbacks.onChanged).not.toHaveBeenCalled()
  })

  it('clears the newly created secret on revocation and waits for app confirmation', async () => {
    const callbacks = props()
    callbacks.keys = [{ id: 'key-1', name: 'My client', scopes: ['records:read'], expiresAt: '2030-01-01' }]
    callbacks.onRevoke = vi.fn().mockRejectedValueOnce(new Error('Could not revoke key')).mockResolvedValueOnce(undefined)
    render(<ApiAccessPanel {...callbacks} />)
    await create()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke My client' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not revoke key')
    expect(screen.getByLabelText('New API key')).toBeTruthy()
    expect(callbacks.onChanged).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke My client' }))
    await waitFor(() => expect(screen.queryByLabelText('New API key')).toBeNull())
    expect(callbacks.onRevoke).toHaveBeenCalledWith('key-1')
    expect(callbacks.onChanged).toHaveBeenCalledTimes(2)
  })
})
