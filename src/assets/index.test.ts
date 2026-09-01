import { describe, expect, it } from 'vitest'
import { assetCreateJsonSchema } from './index'

type JsonSchemaNode = {
  $id?: string
  const?: string
  anyOf?: JsonSchemaNode[]
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
}

function branchFor(schema: JsonSchemaNode, format: string): JsonSchemaNode {
  const branch = schema.anyOf?.find((candidate) => candidate.properties?.format?.const === format)
  if (!branch) throw new Error(`asset-create schema has no ${format} branch`)
  return branch
}

describe('assetCreateJsonSchema', () => {
  it('covers every format with the exact required brand and content fields', () => {
    const schema = assetCreateJsonSchema as unknown as JsonSchemaNode
    const formats = [
      'email',
      'image:feed',
      'image:story',
      'image:carousel',
      'video:reel',
      'video:feed',
      'copy:caption',
      'copy:headline',
      'copy:sms',
    ]

    expect(schema.$id).toBe('https://tangle.tools/schemas/asset-create.json')
    expect(schema.anyOf).toHaveLength(formats.length)

    for (const format of formats) {
      const branch = branchFor(schema, format)
      expect(branch.required).toEqual(['format', 'brand', 'content'])

      const brand = branch.properties?.brand
      expect(brand?.required).toEqual([
        'primaryColor',
        'accentColor',
        'textColor',
        'fontFamily',
        'businessName',
        'voice',
      ])
      expect(brand?.properties).not.toHaveProperty('secondaryColor')

      const content = branch.properties?.content
      expect(content).toBeDefined()
      if (!content) continue

      const required = {
        email: ['subject', 'sections'],
        'image:feed': ['slides'],
        'image:story': ['slides'],
        'image:carousel': ['slides'],
        'video:reel': ['durationSeconds', 'scenes'],
        'video:feed': ['durationSeconds', 'scenes'],
        'copy:caption': ['headline', 'body', 'platform'],
        'copy:headline': ['headline', 'body', 'platform'],
        'copy:sms': ['headline', 'body', 'platform'],
      }[format]
      expect(content.required).toEqual(required)
    }
  })
})
