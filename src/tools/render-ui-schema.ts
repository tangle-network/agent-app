import { validateOpenUIJsonNode } from '@tangle-network/ui/openui-schema'
import { ToolInputError } from './errors'

/** Map the renderer-owned JSON contract to a correctable tool error. */
export function assertRenderUiSchema(value: unknown): void {
  const result = validateOpenUIJsonNode(value)
  if (!result.ok) {
    throw new ToolInputError('invalid_schema', `${result.issue.path}: ${result.issue.message}`)
  }
}
