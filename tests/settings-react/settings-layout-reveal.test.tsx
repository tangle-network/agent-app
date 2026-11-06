// @vitest-environment jsdom
/**
 * The settings layout's `#hash` reveal for a card that is not in the document
 * when the section mounts, such as a section still loading its data: it
 * reveals and focuses the card once it appears, instead of staying at the top.
 */
import { render } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsLayout } from '../../src/settings-react'

/** A card that lands after mount, as a client-loaded section's does. */
function LateCard({ id }: { id: string }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 10)
    return () => clearTimeout(timer)
  }, [])
  return loaded ? <section id={id}><h2 id={`${id}-title`}>{id}</h2></section> : <p>Loading…</p>
}

describe('SettingsLayout hash reveal', () => {
  it('reveals a #hash card once it appears after mount', () => {
    window.location.hash = '#services'
    render(
      <SettingsLayout
        title="Business"
        sections={[{ id: 'business', label: 'Business', href: '/settings/business' }]}
        activeId="business"
      >
        <LateCard id="services" />
      </SettingsLayout>,
    )
    return vi.waitFor(() => expect(document.activeElement?.id).toBe('services-title'))
  })
})
