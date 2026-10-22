/**
 * Where studio-generated media lands in the Vault and how its file type is
 * named: default folders per output type, path resolution from a requested
 * output path, and the extension/mime mapping for provider results.
 */
import { validateVaultFilePath } from '../../vault/store/paths'
import { isBlockedFetchHostname } from '../../web/fetch-guard'

export type GeneratedOutputType = 'image' | 'video' | 'avatar' | 'speech' | 'transcription'
export type GeneratedMediaType = Exclude<GeneratedOutputType, 'transcription'>

export const DEFAULT_GENERATED_OUTPUT_PATHS: Record<GeneratedOutputType, string> = {
  image: 'generated/images',
  video: 'generated/videos',
  avatar: 'generated/avatars',
  speech: 'generated/audio',
  transcription: 'generated/transcripts',
}

export interface GeneratedOutputConfig {
  defaultPath: string
  extensions: Set<string>
  defaultExtension: string
  defaultMimeType: string
  frontmatterType: string
  title: string
}

export const GENERATED_OUTPUT_CONFIG: Record<GeneratedOutputType, GeneratedOutputConfig> = {
  image: {
    defaultPath: DEFAULT_GENERATED_OUTPUT_PATHS.image,
    extensions: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']),
    defaultExtension: '.png',
    defaultMimeType: 'image/png',
    frontmatterType: 'generated-image',
    title: 'Studio generated image',
  },
  video: {
    defaultPath: DEFAULT_GENERATED_OUTPUT_PATHS.video,
    extensions: new Set(['.mp4', '.mov', '.m4v', '.webm']),
    defaultExtension: '.mp4',
    defaultMimeType: 'video/mp4',
    frontmatterType: 'generated-video',
    title: 'Studio generated video',
  },
  avatar: {
    defaultPath: DEFAULT_GENERATED_OUTPUT_PATHS.avatar,
    extensions: new Set(['.mp4', '.mov', '.m4v', '.webm']),
    defaultExtension: '.mp4',
    defaultMimeType: 'video/mp4',
    frontmatterType: 'generated-avatar',
    title: 'Studio generated avatar',
  },
  speech: {
    defaultPath: DEFAULT_GENERATED_OUTPUT_PATHS.speech,
    extensions: new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.aac']),
    defaultExtension: '.mp3',
    defaultMimeType: 'audio/mpeg',
    frontmatterType: 'generated-audio',
    title: 'Studio generated audio',
  },
  transcription: {
    defaultPath: DEFAULT_GENERATED_OUTPUT_PATHS.transcription,
    extensions: new Set(['.md']),
    defaultExtension: '.md',
    defaultMimeType: 'text/markdown',
    frontmatterType: 'generated-transcript',
    title: 'Studio generated transcript',
  },
}

export function normalizeGeneratedOutputPath(type: GeneratedOutputType, input: string | null | undefined): string {
  const trimmed = (input ?? '').trim().replace(/^\/+|\/+$/g, '')
  const normalized = trimmed.replace(/^vault\/+/i, '') || GENERATED_OUTPUT_CONFIG[type].defaultPath
  validateVaultFilePath(normalized)
  return normalized
}

/** The Vault path of a generated file: the output path itself when it names a file, else `fileName` under it. */
export function resolveGeneratedVaultPath(input: {
  type: GeneratedOutputType
  outputPath: string | null | undefined
  fileName: string
}): string {
  const config = GENERATED_OUTPUT_CONFIG[input.type]
  const outputPath = normalizeGeneratedOutputPath(input.type, input.outputPath)
  const fileName = input.fileName.trim()
  validateVaultFilePath(fileName)
  const vaultPath = hasConfiguredExtension(outputPath, config.extensions) ? outputPath : `${outputPath}/${fileName}`
  validateVaultFilePath(vaultPath)
  return vaultPath
}

export function extensionForGeneratedMimeType(type: GeneratedMediaType, mimeType: string): string {
  const clean = mimeType.toLowerCase().split(';')[0]?.trim()
  if (clean === 'image/jpeg') return '.jpg'
  if (clean === 'image/webp') return '.webp'
  if (clean === 'image/gif') return '.gif'
  if (clean === 'image/avif') return '.avif'
  if (clean === 'video/webm') return '.webm'
  if (clean === 'video/quicktime') return '.mov'
  if (clean === 'audio/wav' || clean === 'audio/x-wav') return '.wav'
  if (clean === 'audio/mp4' || clean === 'audio/x-m4a') return '.m4a'
  if (clean === 'audio/ogg' || clean === 'application/ogg') return '.ogg'
  if (clean === 'audio/webm') return '.webm'
  if (clean === 'audio/aac') return '.aac'
  return GENERATED_OUTPUT_CONFIG[type].defaultExtension
}

/** A provider result URL that is safe to fetch: https and not a private network host. */
export function validateGeneratedMediaSourceUrl(value: string, type: GeneratedMediaType): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Generated ${generatedMediaLabel(type)} provider returned an invalid URL`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Generated ${generatedMediaLabel(type)} provider returned a non-https URL`)
  }
  if (isBlockedFetchHostname(url.hostname)) {
    throw new Error(`Generated ${generatedMediaLabel(type)} provider returned a private network URL`)
  }
  return url.toString()
}

export function generatedExtensionFromUrl(value: string, type: GeneratedMediaType): string | null {
  const ext = fileExtension(new URL(value).pathname)
  if (ext && GENERATED_OUTPUT_CONFIG[type].extensions.has(ext)) return ext
  return null
}

export function generatedMimeTypeFromUrl(value: string, type: GeneratedMediaType): string | null {
  const ext = generatedExtensionFromUrl(value, type)
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.avif') return 'image/avif'
  if (ext === '.webm' && type !== 'speech') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.ogg') return 'audio/ogg'
  if (ext === '.webm') return 'audio/webm'
  if (ext === '.aac') return 'audio/aac'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.mp4') return 'video/mp4'
  return null
}

function hasConfiguredExtension(path: string, extensions: Set<string>): boolean {
  const ext = fileExtension(path)
  return Boolean(ext && extensions.has(ext))
}

function fileExtension(path: string): string | null {
  const name = path.split('/').pop() ?? path
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex === -1) return null
  return name.slice(dotIndex).toLowerCase()
}

/** The word a message uses for a media type ("audio" for speech). */
export function generatedMediaLabel(type: GeneratedMediaType): string {
  if (type === 'speech') return 'audio'
  return type
}

export function isGeneratedMediaType(value: unknown): value is GeneratedMediaType {
  return value === 'image' || value === 'video' || value === 'avatar' || value === 'speech'
}
