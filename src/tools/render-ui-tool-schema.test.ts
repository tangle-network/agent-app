import { describe, expect, it } from 'vitest'
import { buildAppToolOpenAITools } from './openai'

type Schema = Record<string, unknown>

/**
 * Gemini refuses a tool schema whose `$ref` loop passes only through required
 * values ("ref loops are only supported if they include optional or nullable
 * property values, or a potentially-zero-length array items"). A step breaks
 * the loop when it is an optional property or an array that may be empty.
 * Returns the first loop made only of required steps, or null.
 */
function findRequiredRefLoop(defs: Record<string, Schema>): string[] | null {
  const requiredRefs = (schema: Schema): string[] => {
    const refs: string[] = []
    const visit = (node: unknown, required: boolean) => {
      if (!required || !node || typeof node !== 'object') return
      const value = node as Schema
      if (typeof value.$ref === 'string') refs.push(value.$ref.replace('#/$defs/', ''))
      for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        if (Array.isArray(value[key])) for (const branch of value[key] as unknown[]) visit(branch, true)
      }
      if (value.type === 'array' && typeof value.minItems === 'number' && value.minItems > 0) visit(value.items, true)
      const properties = (value.properties ?? {}) as Record<string, unknown>
      const requiredNames = new Set(Array.isArray(value.required) ? (value.required as string[]) : [])
      for (const [name, property] of Object.entries(properties)) visit(property, requiredNames.has(name))
    }
    visit(schema, true)
    return refs
  }
  const edges = new Map(Object.entries(defs).map(([name, schema]) => [name, requiredRefs(schema)]))
  const search = (name: string, path: string[]): string[] | null => {
    if (path.includes(name)) return [...path.slice(path.indexOf(name)), name]
    for (const next of edges.get(name) ?? []) {
      const loop = search(next, [...path, name])
      if (loop) return loop
    }
    return null
  }
  for (const name of edges.keys()) {
    const loop = search(name, [])
    if (loop) return loop
  }
  return null
}

describe('render_ui tool schema', () => {
  const renderUi = buildAppToolOpenAITools({ proposalTypes: ['review'], regulatedTypes: [] }).find(
    (tool) => tool.function.name === 'render_ui',
  )
  const parameters = renderUi?.function.parameters as Schema & { $defs: Record<string, Schema> }

  it('keeps nested containers in the advertised node schema', () => {
    expect(parameters.properties).toMatchObject({ schema: { $ref: '#/$defs/node' } })
    expect(parameters.$defs.stack).toBeDefined()
  })

  it('has no recursive loop of required values, which Gemini rejects', () => {
    expect(findRequiredRefLoop(parameters.$defs)).toBeNull()
  })

  it('detects the loop that a nonempty recursive children array forms', () => {
    const defs = structuredClone(parameters.$defs)
    const stackProperties = defs.stack?.properties as Record<string, Schema>
    stackProperties.children = { ...stackProperties.children, minItems: 1 }
    expect(findRequiredRefLoop(defs)).toEqual(['node', 'stack', 'node'])
  })
})
