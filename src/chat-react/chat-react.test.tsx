import { describe, expect, it } from 'vitest'

import * as chatReact from './index'
import { EntryComposer } from '../web-react/entry-composer'
import { ComposerModeControls } from '../web-react/composer-mode-controls'

/**
 * `/chat-react` is a compatibility re-export over `/web-react` — behavior is
 * tested where the components live (`src/web-react/entry-composer.test.tsx`).
 * What this pins is the shim itself: the same identities, so an app importing
 * from either subpath composes against one component, not two copies.
 */
describe('chat-react compatibility surface', () => {
  it('re-exports the /web-react components by identity', () => {
    expect(chatReact.EntryComposer).toBe(EntryComposer)
    expect(chatReact.ComposerModeControls).toBe(ComposerModeControls)
  })
})
