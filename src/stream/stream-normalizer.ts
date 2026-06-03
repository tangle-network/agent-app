export type JsonRecord = Record<string, unknown>

export interface StreamEvent {
  type: string
  data?: JsonRecord
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function resolveToolId(part: JsonRecord): string {
  return String(
    part.id ??
      part.callID ??
      part.callId ??
      part.toolUseId ??
      part.toolCallId ??
      part.tool ??
      part.name ??
      `tool-${Date.now()}`,
  )
}

export function resolveToolName(part: JsonRecord): string {
  return String(part.tool ?? part.name ?? 'tool')
}

export function normalizeTime(value: unknown): JsonRecord | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const start = Number(record.start ?? record.startedAt ?? record.started_at)
  const end = Number(record.end ?? record.completedAt ?? record.completed_at)
  if (!Number.isFinite(start) && !Number.isFinite(end)) return undefined

  return {
    start: Number.isFinite(start) ? start : undefined,
    end: Number.isFinite(end) ? end : undefined,
  }
}

export function normalizeToolEvent(event: StreamEvent): StreamEvent {
  if (event.type === 'tool_call' || event.type === 'tool.call') {
    const data = event.data ?? {}
    return {
      type: 'message.part.updated',
      data: {
        part: {
          type: 'tool',
          id: data.id ?? data.callId ?? data.callID ?? data.name,
          tool: data.name ?? data.tool ?? 'tool',
          input: data.arguments ?? data.input,
          status: 'running',
        },
      },
    }
  }

  if (event.type === 'tool_result' || event.type === 'tool.result') {
    const data = event.data ?? {}
    const error = asString(data.error)
    return {
      type: 'message.part.updated',
      data: {
        part: {
          type: 'tool',
          id: data.id ?? data.callId ?? data.callID ?? data.name,
          tool: data.name ?? data.tool ?? 'tool',
          output: data.output,
          error,
          status: error ? 'error' : 'completed',
        },
      },
    }
  }

  return event
}

export function normalizePersistedPart(rawPart: JsonRecord): JsonRecord | null {
  const type = String(rawPart.type ?? '')

  if (type === 'text') {
    return {
      type: 'text',
      text: asString(rawPart.text) ?? asString(rawPart.content) ?? '',
    }
  }

  if (type === 'reasoning') {
    return {
      type: 'reasoning',
      text: asString(rawPart.text) ?? asString(rawPart.content) ?? '',
      time: normalizeTime(rawPart.time),
    }
  }

  if (type === 'tool') {
    const state = asRecord(rawPart.state)
    const output = state?.output ?? rawPart.output
    const error = asString(state?.error ?? rawPart.error)
    const status =
      state?.status === 'completed' || rawPart.status === 'completed'
        ? 'completed'
        : state?.status === 'error' || rawPart.status === 'error' || error
          ? 'error'
          : output !== undefined
            ? 'completed'
            : 'running'

    return {
      type: 'tool',
      id: resolveToolId(rawPart),
      tool: resolveToolName(rawPart),
      callID:
        rawPart.callID != null || rawPart.callId != null
          ? String(rawPart.callID ?? rawPart.callId)
          : undefined,
      state: {
        status,
        input: state?.input ?? rawPart.input,
        output,
        error,
        metadata: asRecord(state?.metadata) ?? asRecord(rawPart.metadata),
        time: normalizeTime(state?.time ?? rawPart.time),
      },
    }
  }

  return null
}

export function getPartKey(part: JsonRecord): string {
  const type = String(part.type ?? 'unknown')
  if (type === 'tool') {
    return `tool:${resolveToolId(part)}`
  }

  if (type === 'reasoning') {
    return `reasoning:${String(part.id ?? part.partId ?? part.index ?? 'current')}`
  }

  return `text:${String(part.id ?? part.partId ?? part.index ?? 'current')}`
}

export function mergePersistedPart(existing: JsonRecord | undefined, incoming: JsonRecord, delta?: string): JsonRecord {
  const type = String(incoming.type ?? '')
  if (!existing) {
    if (type === 'text' && delta) {
      return { type: 'text', text: delta }
    }
    return incoming
  }

  if (type === 'text' && String(existing.type ?? '') === 'text') {
    return {
      ...existing,
      ...incoming,
      text: delta ? `${String(existing.text ?? '')}${delta}` : String(incoming.text ?? ''),
    }
  }

  if (type === 'reasoning' && String(existing.type ?? '') === 'reasoning') {
    const existingText = String(existing.text ?? '')
    const incomingText = String(incoming.text ?? '')
    return {
      ...existing,
      ...incoming,
      text: delta && incomingText === existingText ? `${existingText}${delta}` : incomingText || existingText,
      time: incoming.time ?? existing.time,
    }
  }

  if (type === 'tool' && String(existing.type ?? '') === 'tool') {
    return {
      ...existing,
      ...incoming,
      state: {
        ...(asRecord(existing.state) ?? {}),
        ...(asRecord(incoming.state) ?? {}),
        time: asRecord(incoming.state)?.time ?? asRecord(existing.state)?.time,
      },
    }
  }

  return incoming
}

export function finalizeAssistantParts(
  partOrder: string[],
  partMap: Map<string, JsonRecord>,
  finalText: string,
): JsonRecord[] {
  const parts = partOrder
    .map((key) => partMap.get(key))
    .filter((part): part is JsonRecord => Boolean(part))

  if (!parts.some((part) => String(part.type ?? '') === 'text')) {
    if (finalText.trim()) {
      parts.push({ type: 'text', text: finalText })
    }
    return parts
  }

  return parts.map((part) => {
    if (String(part.type ?? '') !== 'text') return part
    return {
      ...part,
      text: finalText || String(part.text ?? ''),
    }
  })
}

export function encodeEvent(encoder: TextEncoder, event: StreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}
