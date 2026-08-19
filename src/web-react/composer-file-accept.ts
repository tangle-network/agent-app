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
    // Keep the trailing "/" so `image/*` cannot match `imagex/png`.
    if (lower.endsWith('/*')) return type.startsWith(lower.slice(0, -1))
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

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
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
 * It must never name a format the bytes are not. A rename that invents `.png`
 * for an unrecognised image type hands an `accept=".png"` list a file that
 * satisfies it by its new name alone, which turns the rename into a way around
 * the very gate it is filtered by. So the extension comes from the mapped MIME
 * type, then the file's own name, then the MIME subtype itself
 * (`image/heic` → `heic`) — and when none of those yields anything, the caller
 * skips the rename rather than guessing.
 */
function imageExtension(file: File): string | null {
  const type = file.type.toLowerCase()
  const fromMime = IMAGE_EXTENSION_BY_MIME[type]
  if (fromMime) return fromMime
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]
  if (fromName) return fromName.toLowerCase()
  const subtype = type.startsWith('image/') ? type.slice('image/'.length) : ''
  const derived = (subtype.split('+')[0] ?? '').replace(/[^a-z0-9]/g, '')
  return derived.length > 0 ? derived : null
}

/**
 * The counter a paste should start from, given the names already staged. The
 * ref alone counts only this mount's pastes, so a queue the host still holds
 * across a remount — or one it seeded with `pasted-image-<n>` names of its own
 * — would have its names reused by the next paste, which is the collision the
 * rename exists to prevent.
 */
export function pastedImageStartIndex(stagedNames: Iterable<string>, current: number): number {
  let highest = current
  for (const name of stagedNames) {
    const index = /^pasted-image-(\d+)(?:\.[a-z0-9]+)?$/i.exec(name.trim())?.[1]
    if (index === undefined) continue
    const parsed = Number.parseInt(index, 10)
    if (Number.isFinite(parsed) && parsed > highest) highest = parsed
  }
  return highest
}

/**
 * Gives every generically-named clipboard image a distinct
 * `pasted-image-<n>.<ext>` name, counting up from `startIndex`. Two pastes of
 * the same bitmap otherwise arrive as `image.png` twice, and a staging queue
 * that keys on the name treats the second as a duplicate of the first.
 *
 * Files that already carry a real name pass through untouched, so a copied
 * `report.pdf` keeps being `report.pdf`. So does an image whose extension
 * cannot be derived from what it declares — a renamed file must never claim a
 * format it is not. `nextIndex` is the counter to hand the next paste.
 */
export function renamePastedImages(
  files: File[],
  startIndex: number,
): { files: File[]; nextIndex: number } {
  let nextIndex = startIndex
  const renamed = files.map((file) => {
    if (!file.type.startsWith('image/') || !isGenericImageName(file.name)) return file
    const extension = imageExtension(file)
    if (extension === null) return file
    nextIndex += 1
    return new File([file], `pasted-image-${nextIndex}.${extension}`, { type: file.type })
  })
  return { files: renamed, nextIndex }
}
