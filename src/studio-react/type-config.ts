import { Film, FileText, Image, Mic, Video } from 'lucide-react'

/** Define configuration options for a type including label, icon, and color properties */
export interface TypeConfig {
  label: string
  icon: typeof Image
  color: string
}

/* Type badges sit on top of media thumbnails, so the tint is mixed SOLID onto
   the card surface — the kind hue survives but no photo bleeds through an
   alpha fill. The /30 border is the badge's edge tier over busy media. */
const IMAGE: TypeConfig = { label: 'Image', icon: Image, color: 'bg-[color-mix(in_srgb,#3b82f6_10%,hsl(var(--card)))] text-blue-600 border-blue-500/30' }

// string-keyed so list cards can index by Generation.type
/** Map type keys to their corresponding configuration objects including labels, icons, and colors */
export const TYPE_CONFIG: Record<string, TypeConfig> = {
  image: IMAGE,
  video: { label: 'Video', icon: Video, color: 'bg-[color-mix(in_srgb,#ef4444_10%,hsl(var(--card)))] text-red-600 border-red-500/30' },
  avatar: { label: 'Avatar', icon: Film, color: 'bg-[color-mix(in_srgb,#a855f7_10%,hsl(var(--card)))] text-purple-600 border-purple-500/30' },
  speech: { label: 'Audio', icon: Mic, color: 'bg-[color-mix(in_srgb,#f97316_10%,hsl(var(--card)))] text-orange-600 border-orange-500/30' },
  transcription: { label: 'Transcript', icon: FileText, color: 'bg-[color-mix(in_srgb,#10b981_10%,hsl(var(--card)))] text-emerald-600 border-emerald-500/30' },
}

// Safe lookup for an arbitrary `Generation.type` — always defined (the table is
// declared `Record<string, …>`, so a raw index is `T | undefined`). Falls back
// to the image config, matching the prior `?? TYPE_CONFIG.image` call sites.
/** Resolve the configuration object for a given type or return the default image configuration */
export function typeConfigFor(type: string): TypeConfig {
  return TYPE_CONFIG[type] ?? IMAGE
}
