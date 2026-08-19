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

/** Matches the generic names browsers give a clipboard bitmap (`image`,
 *  `image.png`, or an empty name) — the names that collide across pastes. */
function isGenericImageName(name: string): boolean {
  return /^(image)?(\.[a-z0-9]+)?$/i.test(name.trim())
}

function imageExtension(file: File): string {
  const fromMime = IMAGE_EXTENSION_BY_MIME[file.type.toLowerCase()]
  if (fromMime) return fromMime
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]
  return fromName?.toLowerCase() ?? 'png'
}

/**
 * Gives every generically-named clipboard image a distinct
 * `pasted-image-<n>.<ext>` name, counting up from `startIndex`. Two pastes of
 * the same bitmap otherwise arrive as `image.png` twice, and a staging queue
 * that keys on the name treats the second as a duplicate of the first.
 *
 * Files that already carry a real name pass through untouched, so a copied
 * `report.pdf` keeps being `report.pdf`. `nextIndex` is the counter to hand the
 * next paste.
 */
export function renamePastedImages(
  files: File[],
  startIndex: number,
): { files: File[]; nextIndex: number } {
  let nextIndex = startIndex
  const renamed = files.map((file) => {
    if (!file.type.startsWith('image/') || !isGenericImageName(file.name)) return file
    nextIndex += 1
    return new File([file], `pasted-image-${nextIndex}.${imageExtension(file)}`, {
      type: file.type,
    })
  })
  return { files: renamed, nextIndex }
}
