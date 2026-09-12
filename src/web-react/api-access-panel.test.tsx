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

  it('uses product lifetime choices and default, reconciling removed options', async () => {
    const callbacks = props()
    const { rerender } = render(<ApiAccessPanel {...callbacks} expiryDays={[30, 60]} defaultExpiryDays={60} />)
    expect(screen.getByLabelText<HTMLSelectElement>('Expires in').value).toBe('60')
    expect(screen.getAllByRole<HTMLOptionElement>('option').map(option => option.value)).toEqual(['30', '60'])
    rerender(<ApiAccessPanel {...callbacks} expiryDays={[1]} defaultExpiryDays={60} />)
    expect(screen.getByLabelText<HTMLSelectElement>('Expires in').value).toBe('1')
    await create()
    const remaining = Date.parse(vi.mocked(callbacks.onCreate).mock.calls[0]![0].expiresAt) - Date.now()
    expect(remaining).toBeGreaterThan(80_000_000)
    expect(remaining).toBeLessThanOrEqual(86_400_000)
  })

  it('refuses creation when product lifetime choices are empty or invalid', () => {
    const callbacks = props()
    render(<ApiAccessPanel {...callbacks} expiryDays={[0, -1, NaN, Infinity, Number.MAX_VALUE]} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My client' } })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Create key' })
    expect(button.disabled).toBe(true)
    fireEvent.submit(button.closest('form')!)
    expect(callbacks.onCreate).not.toHaveBeenCalled()
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

  it('selects required permissions visibly and clears dependent permissions when a prerequisite is cleared', async () => {
    const callbacks = props()
    callbacks.access = [...callbacks.access, {
      scope: 'records:run', label: 'Run agent', description: 'Run with your records.', requires: ['records:read'],
    }]
    render(<ApiAccessPanel {...callbacks} />)
    const read = screen.getByRole<HTMLInputElement>('checkbox', { name: /Read records/ })
    const run = screen.getByRole<HTMLInputElement>('checkbox', { name: /Run agent/ })
    fireEvent.click(read)
    fireEvent.click(run)
    expect(read.checked).toBe(true)
    expect(run.checked).toBe(true)
    fireEvent.click(read)
    expect(read.checked).toBe(false)
    expect(run.checked).toBe(false)
    fireEvent.click(run)
    await create()
    expect(vi.mocked(callbacks.onCreate).mock.calls[0]![0].scopes).toEqual(['records:run', 'records:read'])
  })

  it('expands transitive defaults and drops dependents when a required permission disappears', () => {
    const callbacks = props()
    callbacks.access = [callbacks.access[0]!,
      { ...callbacks.access[1]!, requires: ['records:read'] },
      { scope: 'records:run', label: 'Run agent', description: 'Run.', requires: ['records:write'] },
    ]
    callbacks.defaultScopes = ['records:run']
    const { rerender } = render(<ApiAccessPanel {...callbacks} />)
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every(input => input.checked)).toBe(true)
    rerender(<ApiAccessPanel {...callbacks} access={callbacks.access.slice(1)} />)
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every(input => !input.checked && input.disabled)).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My client' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Create key' }).closest('form')!)
    expect(callbacks.onCreate).not.toHaveBeenCalled()
    rerender(<ApiAccessPanel {...callbacks} />)
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every(input => !input.checked)).toBe(true)
  })

  it('handles cyclic requirements without hanging or retaining a partially selected cycle', () => {
    const callbacks = props()
    callbacks.access = [
      { ...callbacks.access[0]!, requires: ['records:write'] },
      { ...callbacks.access[1]!, requires: ['records:read'] },
    ]
    render(<ApiAccessPanel {...callbacks} />)
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every(input => input.checked)).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Read records/ }))
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every(input => !input.checked)).toBe(true)
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
