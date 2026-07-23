import { describe, expect, it } from 'vitest'

import * as original from '../../src/chat-store/parts'
import * as reexported from '../../src/web-react/chat-attachments'

// `/web-react`'s `chat-attachments` module exists solely so a browser bundle
// gets the attachment vocabulary without pulling in `/chat-store`'s drizzle
// peer (see the module doc comment). It re-exports the SAME symbols from
// `../chat-store/parts` rather than redefining them — a barrel rename or a
// copy-paste drift in either file must fail loud here, not silently ship two
// diverging `isChatAttachmentPart` implementations.

describe('web-react chat-attachments re-exports', () => {
  it('re-exports the exact same function/value identities as chat-store/parts (no shadow copies)', () => {
    expect(reexported.isChatAttachmentPart).toBe(original.isChatAttachmentPart)
    expect(reexported.attachmentInputToPart).toBe(original.attachmentInputToPart)
    expect(reexported.attachmentKindForMime).toBe(original.attachmentKindForMime)
    expect(reexported.attachmentPartKey).toBe(original.attachmentPartKey)
    expect(reexported.attachmentPartsFromMessageParts).toBe(original.attachmentPartsFromMessageParts)
  })
})
