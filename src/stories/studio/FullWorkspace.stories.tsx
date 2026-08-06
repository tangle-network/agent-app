import type { Meta, StoryObj } from '@storybook/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { StudioWorkspace } from '../../studio-react'
import type { StudioRole } from '../../studio-react'
import { libraryGenerations, libraryTotalCost } from './fixtures'

/**
 * The whole studio surface with its orchestrator wired in. Two environment
 * notes:
 *
 * - `useStudioGenerations` calls `useRevalidator`, which only exists under a
 *   DATA router — so the story mounts the workspace through
 *   `createMemoryRouter`/`RouterProvider` (a plain MemoryRouter throws).
 * - No `workspaceId` is passed: that skips the `/api/media-models` fetch and
 *   the generations poll loop, so the story renders entirely from fixture
 *   data. Generate stays disabled (it requires a workspaceId) — the composer
 *   and library are otherwise fully interactive (type tabs, filters, drawer,
 *   detail view all work against local state).
 */
function WorkspaceDemo({ role }: { role: StudioRole }) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <div className="flex h-screen flex-col bg-background">
            <StudioWorkspace
              generations={libraryGenerations}
              totalCost={libraryTotalCost}
              role={role}
            />
          </div>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  return <RouterProvider router={router} />
}

const meta: Meta<typeof StudioWorkspace> = {
  title: 'Studio/StudioWorkspace',
  component: StudioWorkspace,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof StudioWorkspace>

/** Editor: header + composer + latest-batch canvas + library drawer. */
export const FullWorkspace: Story = {
  name: 'Full workspace — editor',
  render: () => <WorkspaceDemo role="editor" />,
}

/** Viewer: read-only — composer and canvas collapse to the library teaser. */
export const ViewerWorkspace: Story = {
  name: 'Full workspace — viewer',
  render: () => <WorkspaceDemo role="viewer" />,
}

/** Nobody has generated anything yet. */
export const EmptyWorkspace: Story = {
  name: 'Full workspace — empty',
  render: function EmptyWorkspaceDemo() {
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <div className="flex h-screen flex-col bg-background">
              <StudioWorkspace generations={[]} totalCost={0} role="owner" />
            </div>
          ),
        },
      ],
      { initialEntries: ['/'] },
    )
    return <RouterProvider router={router} />
  },
}
