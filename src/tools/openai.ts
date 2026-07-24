import type { AppToolTaxonomy, BuildAppToolsOptions } from './types'

/** The four canonical app-tool names. Stable identifiers the model calls in
 *  both the sandbox (MCP server name) and runtime (function-tool name) paths. */
export const APP_TOOL_NAMES = ['submit_proposal', 'schedule_followup', 'render_ui', 'add_citation'] as const
/** Resolve a valid application tool name from the predefined list of tool names */
export type AppToolName = (typeof APP_TOOL_NAMES)[number]

const NAME_SET = new Set<string>(APP_TOOL_NAMES)
/** Determine if a string matches a valid application tool name */
export function isAppToolName(name: string): name is AppToolName {
  return NAME_SET.has(name)
}

/** A minimal OpenAI Chat Completions function-tool shape — structurally
 *  compatible with `@tangle-network/agent-runtime`'s `OpenAIChatTool` without
 *  importing it (keeps this package runtime-free). */
export interface OpenAIFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Build the four app tools in OpenAI function-tool shape. `submit_proposal`'s
 * `type` enum is the product's {@link AppToolTaxonomy.proposalTypes}; the
 * model-facing descriptions and the follow-up priority enum default to the
 * Tangle reference vocabulary and can be retuned via {@link BuildAppToolsOptions}
 * (the tool names + JSON-Schema shapes stay fixed — they are mechanism). Pass
 * the result to the agent-runtime backend's `tools`.
 */
export function buildAppToolOpenAITools(
  taxonomy: AppToolTaxonomy,
  opts?: BuildAppToolsOptions,
): OpenAIFunctionTool[] {
  const d = opts?.descriptions
  const priorityValues = opts?.priorityValues ?? ['low', 'medium', 'high']
  const custom: OpenAIFunctionTool[] = (opts?.customTools ?? []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  return [
    {
      type: 'function',
      function: {
        name: 'submit_proposal',
        description:
          d?.submit_proposal ??
          'Route a regulated or state-changing action to a human for approval (a recommendation, contacting/soliciting a contact, outreach, a record/account change, scheduling). Queues it for a named certified human to approve before it executes.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...taxonomy.proposalTypes] },
            title: { type: 'string', description: 'Short label for the approval queue.' },
            description: { type: 'string', description: 'The full drafted message/recommendation, with sources.' },
          },
          required: ['type', 'title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_followup',
        description:
          d?.schedule_followup ??
          'Register a dated cadence step (a reminder, chase, or check-in) on the follow-up calendar. Executes immediately.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
            priority: { type: 'string', enum: [...priorityValues] },
          },
          required: ['title', 'dueDate'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'render_ui',
        description:
          d?.render_ui ??
          'Show a generated view live in the workspace. Validates the OpenUI JSON and persists the artifact. Executes immediately.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            schema: { type: 'object', description: 'The OpenUI JSON object.' },
          },
          required: ['title', 'schema'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_citation',
        description:
          d?.add_citation ??
          'Anchor a grounding reference: the exact quote from a file backing a figure or claim. Verifies the quote appears in the file. Executes immediately.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The vault file path.' },
            quote: { type: 'string', description: 'The exact text from it.' },
          },
          required: ['path', 'quote'],
        },
      },
    },
    ...custom,
  ]
}
