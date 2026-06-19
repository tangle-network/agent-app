import { Film, FileText, Image, Mic, Video } from 'lucide-react'

export interface TypeConfig {
  label: string
  icon: typeof Image
  color: string
}

const IMAGE: TypeConfig = { label: 'Image', icon: Image, color: 'bg-blue-500/10 text-blue-600 border-blue-500/20' }

// string-keyed so list cards can index by Generation.type
export const TYPE_CONFIG: Record<string, TypeConfig> = {
  image: IMAGE,
  video: { label: 'Video', icon: Video, color: 'bg-red-500/10 text-red-600 border-red-500/20' },
  avatar: { label: 'Avatar', icon: Film, color: 'bg-purple-500/10 text-purple-600 border-purple-500/20' },
  speech: { label: 'Audio', icon: Mic, color: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
  transcription: { label: 'Transcript', icon: FileText, color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
}

// Safe lookup for an arbitrary `Generation.type` — always defined (the table is
// declared `Record<string, …>`, so a raw index is `T | undefined`). Falls back
// to the image config, matching the prior `?? TYPE_CONFIG.image` call sites.
export function typeConfigFor(type: string): TypeConfig {
  return TYPE_CONFIG[type] ?? IMAGE
}
