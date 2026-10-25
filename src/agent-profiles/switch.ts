/**
 * Chat profile-switch parsing with no dependencies, so browser code can import it without the
 * profile schemas: through the agent-profiles barrel it pulled zod and the schemas into
 * Hospitality's first page (254 KB of its 1,396 KB initial JavaScript).
 */
export function parseProfileSwitch(text: string): { name: string } | { invalid: true } | null {
  const trimmed = text.trim()
  if (!/^switch\s+to\b/i.test(trimmed)) return null
  const match = /^switch[ \t]+to[ \t]+([^\r\n]+)$/i.exec(trimmed)
  return match?.[1]?.trim() ? { name: match[1].trim() } : { invalid: true }
}

export function normalizeProfileName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}
