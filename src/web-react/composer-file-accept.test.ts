import { describe, expect, it } from 'vitest'

import {
  acceptRejectionReason,
  filterAcceptedFiles,
  isAcceptedFileType,
  pastedImageStartIndex,
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

  it('takes the extension from the MIME type, the name, or the subtype — never a guess', () => {
    expect(renamePastedImages([file('image', 'image/jpeg')], 0).files[0]!.name).toBe('pasted-image-1.jpg')
    expect(renamePastedImages([file('', 'image/webp')], 0).files[0]!.name).toBe('pasted-image-1.webp')
    // Unmapped type: the subtype is the truth, so the name says heic, not png.
    expect(renamePastedImages([file('image', 'image/heic')], 0).files[0]!.name).toBe('pasted-image-1.heic')
    // An extension on the original name outranks the subtype.
    expect(renamePastedImages([file('image.avif', 'image/heic')], 0).files[0]!.name).toBe('pasted-image-1.avif')
  })

  it('never renames an image to a format it is not, so accept still refuses it', () => {
    // A renamed file that claimed `.png` for HEIC bytes satisfied an
    // `accept=".png"` list by its new name alone, which made the rename a way
    // around the gate it is filtered by.
    const heic = file('image', 'image/heic')
    const { files } = renamePastedImages([heic], 0)
    const { accepted, rejected } = filterAcceptedFiles(files, '.png')

    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(1)
    // The same blob still passes a list that genuinely admits it.
    expect(filterAcceptedFiles(files, 'image/*').accepted).toHaveLength(1)
  })

  it('leaves an image alone when no extension can be derived truthfully', () => {
    const nameless = file('', 'image/')
    const result = renamePastedImages([nameless], 0)
    expect(result.files[0]).toBe(nameless)
    expect(result.nextIndex).toBe(0)
  })

  it('leaves a name that is only an extension alone — a dotfile is a real name', () => {
    const dotfile = file('.png', 'image/png')
    expect(renamePastedImages([dotfile], 0).files[0]).toBe(dotfile)
  })

  it('leaves a real filename and a non-image alone, and does not spend a counter on them', () => {
    const named = file('screenshot-of-the-bug.png', 'image/png')
    const pdf = file('image.pdf', 'application/pdf')
    const result = renamePastedImages([named, pdf], 0)

    expect(result.files[0]).toBe(named)
    expect(result.files[1]).toBe(pdf)
    expect(result.nextIndex).toBe(0)
  })

  it('preserves the bytes, the MIME type and the modification time of a renamed file', async () => {
    // Only the name changes. A reset `lastModified` would make the pasted file
    // look new to any downstream fingerprint or dedupe that reads it.
    const original = new File([new Uint8Array([1, 2, 3])], 'image.png', {
      type: 'image/png',
      lastModified: 1_000_000_000_000,
    })
    const renamed = renamePastedImages([original], 0).files[0]!

    expect(renamed.type).toBe('image/png')
    expect(renamed.lastModified).toBe(1_000_000_000_000)
    expect(new Uint8Array(await renamed.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('numbers past a pasted-image name carried in the SAME batch', () => {
    // One paste can hold a file already named `pasted-image-1.png` beside a raw
    // bitmap; numbering the bitmap blindly would duplicate its batch-mate.
    const preNamed = file('pasted-image-1.png', 'image/png')
    const bitmap = file('image.png', 'image/png')
    const result = renamePastedImages([preNamed, bitmap], 0)

    expect(result.files.map((f) => f.name)).toEqual(['pasted-image-1.png', 'pasted-image-2.png'])
    expect(result.nextIndex).toBe(2)
    // Order does not matter: the batch is scanned before any renaming starts.
    expect(renamePastedImages([bitmap, preNamed], 0).files.map((f) => f.name)).toEqual([
      'pasted-image-2.png',
      'pasted-image-1.png',
    ])
  })
})

describe('pastedImageStartIndex', () => {
  it('takes the highest already-staged pasted-image number when it beats the counter', () => {
    expect(pastedImageStartIndex(['pasted-image-1.png', 'pasted-image-4.jpg'], 0)).toBe(4)
  })

  it('keeps the counter when it is already ahead of the staged names', () => {
    expect(pastedImageStartIndex(['pasted-image-1.png'], 7)).toBe(7)
  })

  it('ignores names that are not pasted images', () => {
    expect(pastedImageStartIndex(['report.pdf', 'pasted-image-x.png', 'my-pasted-image-9.png'], 2)).toBe(2)
  })

  it('reads a bare pasted-image-<n> with no extension', () => {
    expect(pastedImageStartIndex(['pasted-image-3'], 0)).toBe(3)
  })

  it('returns the counter unchanged for an empty queue', () => {
    expect(pastedImageStartIndex([], 5)).toBe(5)
  })
})
