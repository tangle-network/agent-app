/**
 * Filename extension → media type. Browser-safe; no imports.
 *
 * `sniffMimeFromName` is the generic last-resort typing for uploads and
 * promoted agent files. `sniffMime` adds the code, MDX and spreadsheet types a
 * file preview picks its renderer from (rendered markdown, line-numbered code,
 * image, video, tabular CSV, embedded PDF, monospace text fallback). An unknown
 * extension falls to `text/plain`; it is never a rejection.
 */

const BASE_EXT_TO_MIME: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}

const PREVIEW_EXT_TO_MIME: Readonly<Record<string, string>> = {
  ...BASE_EXT_TO_MIME,
  mdx: 'text/markdown',
  ts: 'text/typescript',
  tsx: 'text/typescript-jsx',
  js: 'text/javascript',
  jsx: 'text/jsx',
  py: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  rb: 'text/x-ruby',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  toml: 'text/x-toml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
}

function lookup(table: Readonly<Record<string, string>>, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return 'text/plain'
  return table[ext] ?? 'text/plain'
}

/** Generic extension → mime for uploads and promoted files. */
export function sniffMimeFromName(filename: string): string {
  return lookup(BASE_EXT_TO_MIME, filename)
}

/** Extension → mime for choosing a file preview renderer. A product's own
 *  file types (e.g. `{ fountain: 'text/plain' }`) go in `extraExtensions`. */
export function sniffMime(filename: string, extraExtensions?: Readonly<Record<string, string>>): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext && extraExtensions && Object.hasOwn(extraExtensions, ext)) return extraExtensions[ext]!
  return lookup(PREVIEW_EXT_TO_MIME, filename)
}

/** The vault editor surface is Markdown-only. */
export function isEditableMime(mime: string): boolean {
  return mime === 'text/markdown'
}
