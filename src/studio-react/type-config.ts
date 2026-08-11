import { FileText, Image, Mic, User, Video } from 'lucide-react'

/** Define configuration options for a type including label, icon, and color properties */
export interface TypeConfig {
  label: string
  icon: typeof Image
  color: string
}

/* Type badges sit on top of media thumbnails, where a per-type hue is
   illegible and off-token — every type gets the same neutral scrim chip
   (no backdrop-blur, so the thumbnail doesn't smear through). The type
   icon inside the badge carries the identity instead of a color. */
const MEDIA_SCRIM = 'bg-black/60 text-white border-white/10'

const IMAGE: TypeConfig = { label: 'Image', icon: Image, color: MEDIA_SCRIM }

// string-keyed so list cards can index by Generation.type
/** Map type keys to their corresponding configuration objects including labels, icons, and colors */
export const TYPE_CONFIG: Record<string, TypeConfig> = {
  image: IMAGE,
  video: { label: 'Video', icon: Video, color: MEDIA_SCRIM },
  avatar: { label: 'Avatar', icon: User, color: MEDIA_SCRIM },
  speech: { label: 'Audio', icon: Mic, color: MEDIA_SCRIM },
  transcription: { label: 'Transcript', icon: FileText, color: MEDIA_SCRIM },
}

// Safe lookup for an arbitrary `Generation.type` — always defined (the table is
// declared `Record<string, …>`, so a raw index is `T | undefined`). Falls back
// to the image config, matching the prior `?? TYPE_CONFIG.image` call sites.
/** Resolve the configuration object for a given type or return the default image configuration */
export function typeConfigFor(type: string): TypeConfig {
  return TYPE_CONFIG[type] ?? IMAGE
}
