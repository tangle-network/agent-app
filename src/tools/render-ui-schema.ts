import { validateOpenUIJsonNode } from '@tangle-network/ui/openui-schema'
import { ToolInputError } from './errors'

/** Decode one tool-transport JSON text, then enforce the renderer's node contract. */
export function parseRenderUiSchema(value: unknown) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new ToolInputError('invalid_schema', '$: schema JSON text is malformed.')
    }
    if (typeof value === 'string') {
      throw new ToolInputError('invalid_schema', '$: schema must encode one OpenUI node object, not another JSON string.')
    }
  }
  const result = validateOpenUIJsonNode(value)
  if (!result.ok) {
    throw new ToolInputError('invalid_schema', `${result.issue.path}: ${result.issue.message}`)
  }
  return result.value
}
