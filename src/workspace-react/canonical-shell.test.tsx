// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { AgentWorkspaceLayout, WorkspaceList, type WorkspaceListItem } from './index'

afterEach(cleanup)

const LONG = 'Synthetic profile verification 2026-09-11 for the Northern District consolidated matter'
const product = { name: 'Legal', mark: <svg data-testid="mark" />, href: '/app' }

function item(id: string, name: string, over: Partial<WorkspaceListItem> = {}): WorkspaceListItem {
  return { id, name, href: `/app/${id}`, updatedAt: '2026-09-27T12:00:00Z', ...over }
}

describe('canonical rail identity', () => {
  it('names the open workspace and the product, truncating a long name with the full text on hover', () => {
    render(
      <AgentWorkspaceLayout product={product} workspace={{ id: 'w1', name: LONG }} navItems={[]}>
        <p>page</p>
      </AgentWorkspaceLayout>,
    )
    const name = screen.getAllByText(LONG)[0]!
    expect(name.className).toContain('truncate')
    // Every ancestor up to the rail header must allow shrinking, or the name
    // overflows into the collapse button and the page (the Legal defect).
    const identity = name.closest('[title]')!
    expect(identity.getAttribute('title')).toBe(`${LONG} · Legal`)
    expect(identity.className).toContain('min-w-0')
    expect(identity.className).toContain('w-full')
    expect(screen.getAllByText('Legal').length).toBeGreaterThan(0)
    // One workspace and nowhere else to go: no menu that lists one item.
    expect(screen.queryByRole('button', { name: /Switch workspace/ })).toBeNull()
  })

  it('switches between workspaces with the product noun and offers the listing and creation', () => {
    render(
      <AgentWorkspaceLayout
        product={product}
        workspace={{
          id: 'w1',
          name: 'Acme',
          noun: { singular: 'client', plural: 'clients' },
          options: [{ id: 'w1', name: 'Acme' }, { id: 'w2', name: LONG }],
          hrefForWorkspace: (id) => `/app/${id}/work`,
          listHref: '/app',
          createHref: '/app/new',
        }}
        navItems={[]}
      >
        <p>page</p>
      </AgentWorkspaceLayout>,
    )
    const trigger = screen.getAllByRole('button', { name: 'Client: Acme. Switch client' })[0]!
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Switch client' })
    expect(within(menu).getByRole('menuitem', { name: /Northern District/ }).getAttribute('href')).toBe('/app/w2/work')
    expect(within(menu).getByRole('menuitem', { name: /Acme/ }).getAttribute('aria-current')).toBe('true')
    expect(within(menu).getByRole('menuitem', { name: 'All clients' }).getAttribute('href')).toBe('/app')
    expect(within(menu).getByRole('menuitem', { name: 'New client' }).getAttribute('href')).toBe('/app/new')
  })

  it('shows only the product on the listing, and keeps an explicit railHeaderContent for unmigrated products', () => {
    const { unmount } = render(
      <AgentWorkspaceLayout product={product} navItems={[]}>
        <p>page</p>
      </AgentWorkspaceLayout>,
    )
    expect(screen.getAllByRole('link', { name: 'Legal' })[0]!.getAttribute('href')).toBe('/app')
    unmount()
    render(
      <AgentWorkspaceLayout product={product} railHeaderContent={<span>Legacy header</span>} navItems={[]}>
        <p>page</p>
      </AgentWorkspaceLayout>,
    )
    expect(screen.getAllByText('Legacy header').length).toBeGreaterThan(0)
  })
})

describe('WorkspaceList', () => {
  it('renders worst-case names without counting copy, and drops a description that repeats the name', () => {
    render(
      <WorkspaceList
        noun={{ singular: 'project', plural: 'projects' }}
        items={[
          item('long', LONG, { description: `${LONG} and more` }),
          item('dup', 'GTM Agent', { description: 'GTM Agent' }),
          item('x', 'X', { updatedAt: null }),
          item('cjk', '株式会社タングル', { updatedAt: 'not a date' }),
        ]}
        create={{ href: '/app/new' }}
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'New project' }).getAttribute('href')).toBe('/app/new')
    expect(screen.getByRole('link', { name: LONG }).className).toContain('truncate')
    expect(screen.getAllByText('GTM Agent')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/\d+ (projects?|threads?|workspaces?|clients?)\b/)
    expect(document.body.textContent).not.toContain('Invalid Date')
  })

  it('designs the empty state around the one create action', () => {
    render(
      <WorkspaceList
        noun={{ singular: 'client', plural: 'clients' }}
        items={[]}
        create={{ href: '/app/new' }}
        empty={{ description: 'Each client keeps its own documents.' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'No clients yet' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'New client' })).toHaveLength(1)
  })

  it('puts delete in the overflow menu behind a confirmation, and shows a refusal inside the dialog', async () => {
    const remove = vi.fn().mockRejectedValueOnce(new Error('Only owners can delete clients.')).mockResolvedValueOnce(undefined)
    render(<WorkspaceList items={[item('a', 'Acme'), item('b', 'Globex')]} remove={remove} />)

    // Nothing destructive is on the row itself.
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Acme' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete workspace?' })
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Only owners can delete clients.'))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remove).toHaveBeenCalledTimes(2)
    expect(remove.mock.calls[0]![0].id).toBe('a')
  })

  it('offers search past eight items and says when nothing matches', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`c${i}`, `Client ${i}`))
    render(<WorkspaceList items={items} noun={{ singular: 'client', plural: 'clients' }} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search clients' }), { target: { value: 'zzz' } })
    expect(screen.getByRole('status').textContent).toContain('No clients match “zzz”.')
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(9)
  })
})
