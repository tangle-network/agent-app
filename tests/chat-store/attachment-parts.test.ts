import { describe, expect, it } from 'vitest'
import {
  attachmentKindForMime,
  attachmentPartKey,
  attachmentInputToPart,
  isChatAttachmentPart,
  attachmentPartsFromMessageParts,
  buildAttachmentPromptBlock,
  historyContentWithAttachments,
  DEFAULT_ATTACHMENT_PROMPT_HEADER,
} from '../../src/chat-store/parts'
import type { ChatAttachmentInput } from '../../src/chat-routes/wire'

// Byte-compat proof for the attachment vocabulary lifted from gtm's
// `chat-attachments.ts` — the prompt-block text especially feeds dispatched
// prompts, so its exact bytes are load-bearing for gtm-agent#618 adoption.

describe('attachmentKindForMime', () => {
  it('maps image/* to image and everything else (incl. absent) to file', () => {
    expect(attachmentKindForMime('image/png')).toBe('image')
    expect(attachmentKindForMime('application/pdf')).toBe('file')
    expect(attachmentKindForMime(undefined)).toBe('file')
    expect(attachmentKindForMime('')).toBe('file')
  })
})

describe('attachmentPartKey', () => {
  it('keys on the store path', () => {
    expect(attachmentPartKey('uploads/report.pdf')).toBe('attachment:uploads/report.pdf')
  })
})

describe('attachmentInputToPart', () => {
  const input: ChatAttachmentInput = { path: 'uploads/report.pdf', name: 'report.pdf', size: 1024, mediaType: 'application/pdf', kind: 'file' }

  it('projects an input to a minimal part, dropping falsy optionals', () => {
    expect(attachmentInputToPart(input)).toEqual({
      type: 'file',
      path: 'uploads/report.pdf',
      name: 'report.pdf',
      size: 1024,
      mediaType: 'application/pdf',
    })
  })

  it('drops a non-finite size and an empty mediaType rather than storing them', () => {
    const part = attachmentInputToPart({ ...input, size: Number.NaN, mediaType: '' })
    expect(part).toEqual({ type: 'file', path: 'uploads/report.pdf', name: 'report.pdf' })
  })
})

describe('isChatAttachmentPart', () => {
  it('accepts image/file parts carrying a string path (incl. sidecar path-only file parts)', () => {
    expect(isChatAttachmentPart({ type: 'image', path: 'a.png', name: 'a.png' })).toBe(true)
    expect(isChatAttachmentPart({ type: 'file', path: '/box/x' })).toBe(true)
  })

  it('rejects non-attachment shapes', () => {
    expect(isChatAttachmentPart({ type: 'text', text: 'hi' })).toBe(false)
    expect(isChatAttachmentPart({ type: 'file' })).toBe(false)
    expect(isChatAttachmentPart(null)).toBe(false)
  })
})

describe('attachmentPartsFromMessageParts', () => {
  it('filters an untyped parts array to just the attachment-shaped ones', () => {
    const parts = [
      { type: 'text', text: 'hi' },
      { type: 'file', path: 'uploads/a.pdf', name: 'a.pdf' },
      { type: 'image', path: 'uploads/b.png', name: 'b.png' },
    ]
    expect(attachmentPartsFromMessageParts(parts)).toHaveLength(2)
    expect(attachmentPartsFromMessageParts(null)).toEqual([])
  })
})

describe('buildAttachmentPromptBlock', () => {
  it('emits gtm-byte-identical text with the default header', () => {
    const block = buildAttachmentPromptBlock([
      { name: 'report.pdf', path: 'uploads/report.pdf' },
      { name: 'pic.png', path: 'uploads/pic.png' },
    ])
    expect(block).toBe(
      '\n\nAttached files (already saved to the workspace vault — read them from these paths):\n' +
        '- report.pdf (vault: uploads/report.pdf)\n' +
        '- pic.png (vault: uploads/pic.png)',
    )
    expect(DEFAULT_ATTACHMENT_PROMPT_HEADER).toBe('Attached files (already saved to the workspace vault — read them from these paths):')
  })

  it('returns empty string for no attachments', () => {
    expect(buildAttachmentPromptBlock([])).toBe('')
  })

  it('overrides the header line when asked, keeping the per-file line format', () => {
    const block = buildAttachmentPromptBlock([{ name: 'a.pdf', path: 'p/a.pdf' }], 'Files:')
    expect(block).toBe('\n\nFiles:\n- a.pdf (vault: p/a.pdf)')
  })
})

describe('historyContentWithAttachments', () => {
  it('appends the block once when the message carries attachment parts', () => {
    const out = historyContentWithAttachments({
      content: 'see attached',
      parts: [{ type: 'file', path: 'uploads/a.pdf', name: 'a.pdf' }],
    })
    expect(out).toBe('see attached\n\n' + DEFAULT_ATTACHMENT_PROMPT_HEADER + '\n- a.pdf (vault: uploads/a.pdf)')
  })

  it('leaves content untouched when there are no attachment parts', () => {
    expect(historyContentWithAttachments({ content: 'plain', parts: [{ type: 'text', text: 'x' }] })).toBe('plain')
    expect(historyContentWithAttachments({ content: 'plain' })).toBe('plain')
  })
})
