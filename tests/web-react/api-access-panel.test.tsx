// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ApiAccessPanel } from '../../src/web-react/api-access-panel'

afterEach(cleanup)

it('keeps existing keys in a card, including when there are none', () => {
  render(<ApiAccessPanel
    keys={[]}
    access={[{ scope: 'records:read', label: 'Read records', description: 'Read records and run status.' }]}
    defaultScopes={['records:read']}
    baseUrl="https://example.test"
    onChanged={() => {}}
  />)
  const heading = screen.getByRole('heading', { name: 'Your keys' })
  const card = heading.parentElement
  expect(card?.className).toContain('bg-card')
  expect(card?.className).toContain('border-border')
  expect(card?.textContent).toContain('No keys yet.')
})
