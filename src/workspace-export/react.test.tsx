// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceExportPanel } from './react'

const fetcher = vi.fn(async () => new Response(JSON.stringify({ exports: [] }), { status: 200 })) as unknown as typeof fetch

afterEach(cleanup)

describe('WorkspaceExportPanel description', () => {
  it('defaults to one short line', async () => {
    render(<WorkspaceExportPanel endpoint="/api/exports" canExport fetcher={fetcher} />)
    const line = screen.getByText('Everything in one zip. Credentials are never included.')
    expect(line.textContent!.split(/\s+/).length).toBeLessThanOrEqual(12)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('renders the app-supplied description', async () => {
    render(<WorkspaceExportPanel endpoint="/api/exports" canExport fetcher={fetcher} description={<>Your data, <strong>one zip</strong>.</>} />)
    expect(screen.getByText('one zip').tagName).toBe('STRONG')
    expect(screen.queryByText(/Credentials are never included/)).toBeNull()
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('renders no description line for null', async () => {
    const { container } = render(<WorkspaceExportPanel endpoint="/api/exports" canExport fetcher={fetcher} description={null} />)
    expect(container.querySelector('header p')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})
