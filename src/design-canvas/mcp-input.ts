import { isRecord, requireEnum } from '../tools/mcp-arguments'

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string when provided`)
  return value
}

export function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} is required and must be a finite number`)
  }
  return value
}

export function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number when provided`)
  }
  return value
}

export function optionalNonNegativeInteger(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer when provided`)
  }
  return value
}

export function requireStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name]
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${name} is required and must be a non-empty array of strings`)
  }
  return value as string[]
}

export function optionalRecord(args: Record<string, unknown>, name: string): Record<string, string> | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`${name} must be an object mapping string keys to string values when provided`)
  }
  return value as Record<string, string>
}

export function optionalEnum<T extends string>(args: Record<string, unknown>, name: string, values: readonly T[]): T | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  return requireEnum(args, name, values)
}

export const pageIdProp = { type: 'string', description: 'Page id to target. Omit to target the first page.' }

export const elementIdProp = { type: 'string', description: 'Element id to target.' }

export const xProp = { type: 'number', description: 'X position in page coordinates (px).' }

export const yProp = { type: 'number', description: 'Y position in page coordinates (px).' }

export const widthProp = { type: 'number', description: 'Width in px (must be > 0).' }

export const heightProp = { type: 'number', description: 'Height in px (must be > 0).' }

export const colorProp = (label: string) => ({ type: 'string', description: `${label} — hex (#rrggbb), rgb(), rgba(), or "transparent".` })
