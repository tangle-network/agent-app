

// ---------------------------------------------------------------------------
// Argument readers — fail loud with name + expected type
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`)
  }
  return value
}

export function requireEnum<T extends string>(args: Record<string, unknown>, name: string, values: readonly T[]): T {
  const value = args[name]
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

export function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}
