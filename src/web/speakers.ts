/**
 * A turn addressed to several agents is persisted as ONE assistant row whose
 * parts carry a `speaker` part before each responder's parts. A transcript
 * draws each answer under its author, so this splits such a row into one row
 * per speaker in stored order. Rows without a speaker part pass through
 * untouched, byte for byte. Pure and renderer-neutral: no React, no DOM.
 */
export interface SpeakerRow {
  id: string | number
  role?: string
  content: string
  /** Stored parts; the typed store union and raw records are both read. */
  parts?: ReadonlyArray<unknown>
  author?: { id: string; name: string; role?: string; avatarUrl?: string }
  segments?: unknown
  toolCalls?: unknown
}

export interface Speaker {
  id: string
  name: string
  handle?: string
}

const isSpeaker = (value: unknown): value is Record<string, unknown> & Speaker & { type: 'speaker' } => {
  const part = value as Record<string, unknown> | null
  return !!part && typeof part === 'object' && part.type === 'speaker' && typeof part.id === 'string' && typeof part.name === 'string'
}
const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

/** The role label a split row shows beside the agent's name. */
export const SPEAKER_ROLE_LABEL = 'Agent'

export function expandSpeakerRows<T extends SpeakerRow>(rows: readonly T[]): Array<T & Pick<SpeakerRow, 'author'>> {
  const out: Array<T & Pick<SpeakerRow, 'author'>> = []
  for (const row of rows) {
    const parts = (row.role === 'assistant' ? row.parts ?? [] : []).map(asRecord)
    if (!parts.some(isSpeaker)) { out.push(row); continue }
    let current: { speaker: Speaker; parts: Record<string, unknown>[] } | null = null
    const groups: Array<{ speaker: Speaker; parts: Record<string, unknown>[] }> = []
    for (const part of parts) {
      if (isSpeaker(part)) {
        current = { speaker: { id: part.id, name: part.name, ...(typeof part.handle === 'string' ? { handle: part.handle } : {}) }, parts: [] }
        groups.push(current)
      } else if (current) {
        current.parts.push(part)
      }
      // Parts before the first speaker belong to no one and are dropped; the
      // route writes a speaker part first.
    }
    groups.forEach((group, index) => {
      const content = group.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('')
      out.push({
        ...row,
        id: `${row.id}#${index}:${group.speaker.id}`,
        author: { id: group.speaker.id, name: group.speaker.name, role: SPEAKER_ROLE_LABEL },
        content,
        parts: group.parts,
        // Client-built views of the whole row do not apply to one speaker's slice.
        segments: undefined,
        toolCalls: undefined,
      })
    })
  }
  return out
}
