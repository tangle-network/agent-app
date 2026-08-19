/**
 * The composer's file-ingress filter, and the clipboard rename that goes with
 * it.
 *
 * A file reaches a composer by three routes — the picker dialog, a drag-and-drop,
 * and a clipboard paste — and only the picker gets a native `accept` filter (one
 * the user can defeat with "All Files"). Every route therefore funnels through
 * {@link filterAcceptedFiles}, so a type the picker will not offer cannot arrive
 * by another route instead.
 *
 * One route can still reach a different verdict, and it does so deliberately.
 * Paste is the only route that RENAMES, and {@link renamePastedImages} names a
 * file after the type it declares. So a clipboard bitmap called `image.png` that
 * declares `image/heic` is judged as `.heic` on paste, while the picker and a
 * drop judge the name they were handed and admit it under `accept=".png"`. The
 * filter is the same on all three; what differs is the name it is given, and
 * paste is stricter precisely because a rename that kept the contradicting name
 * would let the composer manufacture its own way past the filter.
 *
 * ONE accept matcher serves the package: `ChatComposer` gates its ingress on it
 * and `useComposerAttachments` gates `addFiles` on it. A second implementation
 * of the `accept` grammar is how the two ends of the same staging path start
 * disagreeing about what a file is.
 *
 * Pure data in, pure data out — nothing here throws, logs, or touches the DOM,
 * so a caller decides how a rejection is surfaced. Import-free beyond the
 * browser's own `File`, which keeps it usable from `/web-react`'s client bundle.
 */

/** A file the `accept` list refused, with the reason to show for it. */
export interface ComposerFileRejection {
  file: File
  reason: string
}

/**
 * Checks one file against a comma-separated `accept` list, using the grammar of
 * the native `<input accept>` attribute: extensions (`.png`), exact MIME types
 * (`image/png`), and MIME wildcards (`image/*`). An absent or empty list accepts
 * everything, which is what an unset `accept` prop means.
 */
export function isAcceptedFileType(file: File, accept?: string): boolean {
  if (!accept || accept.trim().length === 0) return true

  const patterns = accept
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
  if (patterns.length === 0) return true

  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()

  return patterns.some((pattern) => {
    const lower = pattern.toLowerCase()
    if (lower.startsWith('.')) return name.endsWith(lower)
    if (lower.endsWith('/*')) {
      // Keep the trailing "/" so `image/*` cannot match `imagex/png`, and
      // require a real subtype after it: `image/` and `image//png` are
      // malformed types, and a `File.type` can carry either.
      const prefix = lower.slice(0, -1)
      if (!type.startsWith(prefix)) return false
      const subtype = type.slice(prefix.length)
      return subtype.length > 0 && !subtype.includes('/')
    }
    return type === lower
  })
}

/** The reason an `accept` list refused a file. One wording for every ingress
 *  route, so the same file reads the same whether it was picked or dropped. */
export function acceptRejectionReason(file: File, accept: string): string {
  return `"${file.name}" is not an accepted file type (${accept}).`
}

/**
 * Splits a batch into what the `accept` list admits and what it refuses. Size
 * and count limits are NOT applied here: they belong to the staging queue, which
 * knows what is already staged (`useComposerAttachments`), while this runs at the
 * composer's edge where that is unknown.
 */
export function filterAcceptedFiles(
  files: File[] | FileList,
  accept?: string,
): { accepted: File[]; rejected: ComposerFileRejection[] } {
  const list = Array.isArray(files) ? files : Array.from(files)
  const accepted: File[] = []
  const rejected: ComposerFileRejection[] = []
  for (const file of list) {
    if (isAcceptedFileType(file, accept)) accepted.push(file)
    else rejected.push({ file, reason: acceptRejectionReason(file, accept ?? '') })
  }
  return { accepted, rejected }
}

/**
 * Extensions that truthfully name each image type, most canonical first. A type
 * with more than one is the reason this is a LIST and not a single name: `.jpeg`
 * and `.jpg` are the same claim, so a rename that swapped one for the other
 * would make a paste fail an `accept=".jpeg"` list that the very same file
 * passes through the picker.
 *
 * A type absent from here derives its single extension from the MIME subtype.
 */
const IMAGE_EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe'],
  'image/jpg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/bmp': ['bmp'],
  'image/svg+xml': ['svg'],
  'image/tiff': ['tiff', 'tif'],
  'image/x-icon': ['ico'],
  'image/vnd.microsoft.icon': ['ico'],
}

/**
 * Matches EXACTLY the generic names browsers give a clipboard bitmap: an empty
 * name, `image`, or `image.<ext>`. Those are the names that collide across
 * pastes. A name that is only an extension (`.png`) is a real, if unusual,
 * filename and is left alone.
 */
function isGenericImageName(name: string): boolean {
  return /^(?:image(?:\.[a-z0-9]+)?)?$/i.test(name.trim())
}

/**
 * The extension a renamed clipboard image should carry, or null when none can
 * be derived truthfully.
 *
 * It must never name a format the bytes are not. A rename that hands an
 * `accept=".png"` list a file satisfying it by its new name alone turns the
 * rename into a way around the very gate it is filtered by.
 *
 * So the DECLARED TYPE decides which extensions are truthful, and the filename
 * may only pick among those. A clipboard file can carry a name whose extension
 * contradicts its type — a bitmap named `image.png` that is really `image/heic`
 * — and letting the name win there is exactly the hole this order closes. But
 * when the name's extension is one the type itself allows, it is kept: an
 * `image.jpeg` of type `image/jpeg` stays `.jpeg`, because rewriting it to the
 * canonical `.jpg` would make the paste fail an `accept=".jpeg"` list that the
 * same file passes through the picker.
 *
 * A subtype only stands in for an extension when it is already shaped like one.
 * `image/heic` is; `image/vnd.microsoft.icon` is not, and squeezing the
 * punctuation out of it would yield `vndmicrosofticon` — a name no accept list
 * will ever match, so a perfectly good `.ico` would be admitted through the
 * picker and refused on paste. An unrecognised compound type therefore names
 * nothing, and the filename is consulted instead.
 *
 * The filename is consulted on its own ONLY when the type names nothing usable
 * — either no subtype at all (`image/`) or a compound one. That is not an
 * exception to the rule above: the only named files this function ever sees are
 * `image.<ext>` (see {@link isGenericImageName}), so the fallback can only ever
 * preserve an extension the name already carried — it cannot manufacture one,
 * and an accept list therefore decides the same way it would have without the
 * rename. When nothing yields an extension, the caller skips the rename rather
 * than guessing.
 */
function imageExtension(file: File): string | null {
  const type = file.type.toLowerCase()
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase()

  const mapped = IMAGE_EXTENSIONS_BY_MIME[type]
  const subtype = type.startsWith('image/') ? type.slice('image/'.length) : ''
  const bare = subtype.split('+')[0] ?? ''
  const truthful = mapped ?? (/^[a-z0-9]+$/.test(bare) ? [bare] : [])

  if (truthful.length === 0) return fromName ?? null
  if (fromName !== undefined && truthful.includes(fromName)) return fromName
  return truthful[0] ?? null
}

/** The `pasted-image-<n>` numbers these names already occupy. */
function takenPastedImageIndexes(names: Iterable<string>): Set<number> {
  const taken = new Set<number>()
  for (const name of names) {
    const digits = /^pasted-image-(\d+)(?:\.[a-z0-9]+)?$/i.exec(name.trim())?.[1]
    if (digits === undefined) continue
    const parsed = Number.parseInt(digits, 10)
    if (Number.isSafeInteger(parsed)) taken.add(parsed)
  }
  return taken
}

/**
 * The lowest number above `after` that no name has claimed.
 *
 * Searching upward from the caller's own count — rather than from the highest
 * number any staged name happens to carry — is what keeps this bounded. A queue
 * may hold `pasted-image-9007199254740991.png`, and counting from THAT would
 * strand the next paste at a ceiling where incrementing stops working. Staged
 * numbers are avoided, never followed, so the loop advances at most once per
 * number already claimed and always terminates. `after` is normalised by the
 * caller to a value it can still count from, which is what keeps `+ 1` moving.
 */
function nextFreeIndex(taken: Set<number>, after: number): number {
  let candidate = after + 1
  while (taken.has(candidate)) candidate += 1
  return candidate
}

/**
 * Gives every generically-named clipboard image a distinct
 * `pasted-image-<n>.<ext>` name. Two pastes of the same bitmap otherwise arrive
 * as `image.png` twice, and a staging queue that keys on the name treats the
 * second as a duplicate of the first.
 *
 * A number is never reused. The search avoids every `pasted-image-<n>` already
 * present in `stagedNames` (the queue the host still holds, which outlives this
 * composer's own count) and in the batch itself (one paste can carry a file
 * already named that way beside a raw bitmap), so a collision is not reachable
 * rather than merely unlikely. `startIndex` is the caller's running count, and
 * `nextIndex` is the count to hand the next paste.
 *
 * Files that already carry a real name pass through untouched, so a copied
 * `report.pdf` keeps being `report.pdf`. So does an image whose extension
 * cannot be derived from what it declares — a renamed file must never claim a
 * format it is not. Only the name changes: the bytes, the type and the
 * modification time travel with it, so downstream fingerprinting still sees
 * the file the user pasted.
 */
export function renamePastedImages(
  files: File[],
  startIndex: number,
  stagedNames: Iterable<string> = [],
): { files: File[]; nextIndex: number } {
  const taken = takenPastedImageIndexes([...stagedNames, ...files.map((file) => file.name)])
  // A count that cannot be counted from starts over. That means a negative, a
  // fraction or NaN, and it also means a count sitting AT the safe ceiling: one
  // more than that is not representable, so the search would try to step and
  // never move. `startIndex + 1` is the thing the search actually needs, so it
  // is the thing tested here.
  const usable =
    Number.isSafeInteger(startIndex) && startIndex >= 0 && Number.isSafeInteger(startIndex + 1)
  let nextIndex = usable ? startIndex : 0
  const renamed = files.map((file) => {
    const typed = file.type.startsWith('image/')
    // A clipboard file can arrive with no MIME type at all, and one named
    // `image.png` still collides across pastes exactly as a typed one does.
    // Its extension then comes from its own name, which cannot manufacture a
    // claim it did not already carry.
    if (!isGenericImageName(file.name) || (!typed && file.type !== '')) return file
    const extension = imageExtension(file)
    if (extension === null) return file
    nextIndex = nextFreeIndex(taken, nextIndex)
    taken.add(nextIndex)
    return new File([file], `pasted-image-${nextIndex}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    })
  })
  return { files: renamed, nextIndex }
}
