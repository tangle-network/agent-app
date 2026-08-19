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

  it('takes the extension from the declared type — the mapped name, else the subtype', () => {
    expect(renamePastedImages([file('image', 'image/jpeg')], 0).files[0]!.name).toBe('pasted-image-1.jpg')
    expect(renamePastedImages([file('', 'image/webp')], 0).files[0]!.name).toBe('pasted-image-1.webp')
    // Unmapped type: the subtype is the truth, so the name says heic, not png.
    expect(renamePastedImages([file('image', 'image/heic')], 0).files[0]!.name).toBe('pasted-image-1.heic')
  })

  it('never lets the original filename overrule the type it contradicts', () => {
    // A clipboard bitmap is commonly NAMED `image.png` whatever it is. Taking
    // that extension over the declared type would rebuild the accept bypass:
    // the file would satisfy `accept=".png"` by a name the rename gave it.
    expect(renamePastedImages([file('image.png', 'image/heic')], 0).files[0]!.name).toBe('pasted-image-1.heic')
    expect(renamePastedImages([file('image.avif', 'image/heic')], 0).files[0]!.name).toBe('pasted-image-1.heic')
  })

  it('keeps an extension the declared type itself allows, rather than canonicalising it', () => {
    // `.jpeg` and `.jpg` are the same claim. Rewriting one to the other would
    // make a paste fail an `accept=".jpeg"` list that the picker admits.
    expect(renamePastedImages([file('image.jpeg', 'image/jpeg')], 0).files[0]!.name).toBe('pasted-image-1.jpeg')
    expect(renamePastedImages([file('image.jpg', 'image/jpeg')], 0).files[0]!.name).toBe('pasted-image-1.jpg')
    expect(renamePastedImages([file('image.tif', 'image/tiff')], 0).files[0]!.name).toBe('pasted-image-1.tif')

    const jpeg = file('image.jpeg', 'image/jpeg')
    const renamed = renamePastedImages([jpeg], 0).files
    expect(filterAcceptedFiles([jpeg], '.jpeg').accepted).toHaveLength(1)
    expect(filterAcceptedFiles(renamed, '.jpeg').accepted).toHaveLength(1)
  })

  it('falls back to the filename when the type names nothing usable', () => {
    // No subtype at all, and a compound subtype that is not extension-shaped:
    // in both the type says nothing an extension can be built from.
    expect(renamePastedImages([file('image.jpeg', 'image/')], 0).files[0]!.name).toBe('pasted-image-1.jpeg')
    expect(renamePastedImages([file('image.ico', 'image/vnd.acme.thing')], 0).files[0]!.name).toBe(
      'pasted-image-1.ico',
    )
  })

  it('never squeezes a compound MIME subtype into an extension nobody accepts', () => {
    // `vndmicrosofticon` is a name no accept list will ever match, so a good
    // `.ico` would sail through the picker and be refused on paste.
    const ico = file('image.ico', 'image/vnd.microsoft.icon')
    expect(renamePastedImages([ico], 0).files[0]!.name).toBe('pasted-image-1.ico')
    expect(renamePastedImages([file('image.ico', 'image/x-icon')], 0).files[0]!.name).toBe(
      'pasted-image-1.ico',
    )
    expect(filterAcceptedFiles(renamePastedImages([ico], 0).files, '.ico').accepted).toHaveLength(1)
  })

  it('cannot manufacture an extension through the subtype-less fallback', () => {
    // The fallback only ever sees `image.<ext>` (the sole generic form that
    // carries an extension), so it can only PRESERVE what the name already
    // claimed — an accept list decides the same way it would have with no
    // rename at all. That is why the fallback is not a hole in the rule above.
    const named = file('image.png', 'image/')
    expect(renamePastedImages([named], 0).files[0]!.name).toBe('pasted-image-1.png')
    expect(filterAcceptedFiles([named], '.png').accepted).toHaveLength(1)

    // The forms with no extension get no rename at all, not an invented one.
    for (const name of ['', 'image']) {
      const bare = file(name, 'image/')
      expect(renamePastedImages([bare], 0).files[0], name).toBe(bare)
    }
  })

  it('never renames an image to a format it is not, so accept still refuses it', () => {
    // A renamed file that claimed `.png` for HEIC bytes satisfied an
    // `accept=".png"` list by its new name alone, which made the rename a way
    // around the gate it is filtered by. Both the extensionless clipboard name
    // and the contradicting one have to stay refused.
    for (const name of ['image', 'image.png']) {
      const heic = file(name, 'image/heic')
      const { files } = renamePastedImages([heic], 0)
      const { accepted, rejected } = filterAcceptedFiles(files, '.png')

      expect(accepted, name).toEqual([])
      expect(rejected, name).toHaveLength(1)
      // The same blob still passes a list that genuinely admits it.
      expect(filterAcceptedFiles(files, 'image/*').accepted, name).toHaveLength(1)
    }
  })

  it('renames nothing once the counter can no longer produce a distinct number', () => {
    // At the safe-integer ceiling `+ 1` stops moving, so a second rename in the
    // batch would repeat the first name. Not renaming beats colliding.
    const result = renamePastedImages(
      [file('image.png', 'image/png'), file('image.png', 'image/png')],
      Number.MAX_SAFE_INTEGER - 1,
    )
    const names = result.files.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(['pasted-image-9007199254740991.png', 'image.png'])
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

  it('ignores a number too large to increment', () => {
    // Past 2^53 an increment is a no-op, so seeding from such a name would hand
    // the next paste that same name back.
    expect(pastedImageStartIndex(['pasted-image-9007199254740992.png'], 3)).toBe(3)
    expect(pastedImageStartIndex(['pasted-image-9007199254740991.png'], 3)).toBe(9007199254740991)
  })

  it('returns the counter unchanged for an empty queue', () => {
    expect(pastedImageStartIndex([], 5)).toBe(5)
  })
})
