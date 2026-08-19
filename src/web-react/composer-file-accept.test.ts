import { describe, expect, it } from 'vitest'

import {
  acceptRejectionReason,
  filterAcceptedFiles,
  isAcceptedFileType,
  renamePastedImages,
} from './composer-file-accept'

function file(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('isAcceptedFileType', () => {
  it('accepts everything when the list is absent, empty, or only separators', () => {
    const pdf = file('notes.pdf', 'application/pdf')
    expect(isAcceptedFileType(pdf)).toBe(true)
    expect(isAcceptedFileType(pdf, '')).toBe(true)
    expect(isAcceptedFileType(pdf, '   ')).toBe(true)
    expect(isAcceptedFileType(pdf, ' , , ')).toBe(true)
  })

  it('matches an extension case-insensitively, on both sides', () => {
    expect(isAcceptedFileType(file('SHOT.PNG', ''), '.png')).toBe(true)
    expect(isAcceptedFileType(file('shot.png', ''), '.PNG')).toBe(true)
    expect(isAcceptedFileType(file('shot.gif', ''), '.png')).toBe(false)
  })

  it('matches an exact MIME type and rejects a near miss', () => {
    expect(isAcceptedFileType(file('a', 'image/png'), 'image/png')).toBe(true)
    expect(isAcceptedFileType(file('a', 'image/pngx'), 'image/png')).toBe(false)
  })

  it('matches a MIME wildcard without matching a longer type prefix', () => {
    expect(isAcceptedFileType(file('a', 'image/webp'), 'image/*')).toBe(true)
    // The trailing "/" is what stops `image/*` claiming `imagex/png`.
    expect(isAcceptedFileType(file('a', 'imagex/png'), 'image/*')).toBe(false)
  })

  it('is whitespace-tolerant across a comma-separated list', () => {
    expect(isAcceptedFileType(file('a.pdf', 'application/pdf'), ' image/* , .pdf ')).toBe(true)
  })

  it('rejects a file whose type is empty when the list names MIME types only', () => {
    expect(isAcceptedFileType(file('mystery', ''), 'image/*,application/pdf')).toBe(false)
  })
})

describe('filterAcceptedFiles', () => {
  it('splits a mixed batch and names the accept list in every reason', () => {
    const png = file('a.png', 'image/png')
    const mp3 = file('b.mp3', 'audio/mpeg')
    const { accepted, rejected } = filterAcceptedFiles([png, mp3], 'image/*')

    expect(accepted).toEqual([png])
    expect(rejected).toEqual([{ file: mp3, reason: acceptRejectionReason(mp3, 'image/*') }])
    expect(rejected[0]!.reason).toContain('"b.mp3"')
    expect(rejected[0]!.reason).toContain('image/*')
  })

  it('accepts a FileList, not only an array', () => {
    const transfer = new DataTransfer()
    transfer.items.add(file('a.png', 'image/png'))
    transfer.items.add(file('b.mp3', 'audio/mpeg'))

    const { accepted, rejected } = filterAcceptedFiles(transfer.files, 'image/*')
    expect(accepted.map((f) => f.name)).toEqual(['a.png'])
    expect(rejected.map((r) => r.file.name)).toEqual(['b.mp3'])
  })

  it('rejects nothing and preserves order when no accept list is given', () => {
    const files = [file('a.png', 'image/png'), file('b.mp3', 'audio/mpeg')]
    const { accepted, rejected } = filterAcceptedFiles(files)
    expect(accepted).toEqual(files)
    expect(rejected).toEqual([])
  })
})

describe('renamePastedImages', () => {
  it('renames generic clipboard bitmaps and counts on from startIndex', () => {
    const first = renamePastedImages([file('image.png', 'image/png')], 0)
    expect(first.files[0]!.name).toBe('pasted-image-1.png')
    expect(first.nextIndex).toBe(1)

    // A second paste of the same bitmap must not collide with the first.
    const second = renamePastedImages([file('image.png', 'image/png')], first.nextIndex)
    expect(second.files[0]!.name).toBe('pasted-image-2.png')
    expect(second.nextIndex).toBe(2)
  })

  it('takes the extension from the MIME type, and falls back to png for an unknown one', () => {
    expect(renamePastedImages([file('image', 'image/jpeg')], 0).files[0]!.name).toBe('pasted-image-1.jpg')
    expect(renamePastedImages([file('', 'image/webp')], 0).files[0]!.name).toBe('pasted-image-1.webp')
    expect(renamePastedImages([file('image', 'image/heic')], 0).files[0]!.name).toBe('pasted-image-1.png')
  })

  it('leaves a real filename and a non-image alone, and does not spend a counter on them', () => {
    const named = file('screenshot-of-the-bug.png', 'image/png')
    const pdf = file('image.pdf', 'application/pdf')
    const result = renamePastedImages([named, pdf], 0)

    expect(result.files[0]).toBe(named)
    expect(result.files[1]).toBe(pdf)
    expect(result.nextIndex).toBe(0)
  })

  it('preserves the bytes and the MIME type of a renamed file', async () => {
    const original = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    const renamed = renamePastedImages([original], 0).files[0]!

    expect(renamed.type).toBe('image/png')
    expect(new Uint8Array(await renamed.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})
