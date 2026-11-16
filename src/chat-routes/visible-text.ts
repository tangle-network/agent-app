/**
 * Apply a product's final-text transform (a PII redactor, for example) to every
 * stored part a reader sees as words: the answer's text parts and the reasoning
 * parts, which also hold a Router turn's pre-tool narration. One rule for the
 * final row, the draft row and the detached-turn row.
 */
export function transformVisibleTextParts<T>(
  parts: readonly T[],
  transform: (text: string) => string | Promise<string>,
): Promise<T[]> {
  return Promise.all(parts.map(async (part) => {
    const type = String((part as { type?: unknown }).type ?? '')
    return type === 'text' || type === 'reasoning'
      ? { ...part, text: await transform(String((part as { text?: unknown }).text ?? '')) }
      : part
  }))
}
