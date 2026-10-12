import { OPERATOR_API_BASE_PATH, OPERATOR_ROUTES } from '@tangle-network/agent-app/operator'
import { config } from '../agent.config'

/** Core routes come from the shared contract, never a separate path catalog.
 * Optional product storage operations are discovered after authentication.
 */
export function operatorOpenApi(origin: string, runEnabled = false) {
  const optional = new Set(['workspaces.create', 'journal.list', 'files.list', 'files.read', 'assets.read', 'scorecard.get'])
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of OPERATOR_ROUTES) {
    if (optional.has(route.id) || (!runEnabled && route.id === 'turns.start')) continue
    const path = OPERATOR_API_BASE_PATH + route.path.replace(/:([A-Za-z]+)/g, '{$1}')
    const parameters: unknown[] = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }))
    if (route.id === 'turns.get') parameters.push({ name: 'wait', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 25, default: 0 } })
    if (route.id === 'threads.list') parameters.push({ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
    const operation = {
      operationId: route.id,
      'x-required-scopes': route.scopes,
      ...(parameters.length ? { parameters } : {}),
      ...(route.id === 'turns.start' ? { requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['turnId', 'content'], properties: {
          turnId: { type: 'string', format: 'uuid', description: 'Persist before sending; reuse after an ambiguous outcome. Concurrent or interrupted claims can report unknown until the retained transcript establishes an outcome.' },
          content: { type: 'string', minLength: 1, description: 'At most 65536 UTF-8 bytes.' },
          threadId: { type: 'string', maxLength: 256 }, title: { type: 'string', maxLength: 200 }, model: { type: 'string', maxLength: 200 },
        },
      } } } } } : {}),
      responses: {
        [route.id === 'turns.start' ? '202' : '200']: { description: route.id.startsWith('turns.') ? 'A turn record. Inspect state; HTTP success alone does not establish task success.' : 'Authorized response.', content: { 'application/json': { schema: route.id.startsWith('turns.') ? { type: 'object', required: ['turn'], properties: { turn: { $ref: '#/components/schemas/Turn' } } } : { type: 'object' } } } },
        '400': { description: 'Invalid JSON, input, UUID or query.' },
        '401': { description: 'Missing, invalid, revoked or expired local key.' }, '402': { description: 'Capped execution is unsupported on the browser-backed operator lane.' },
        '403': { description: 'Required scopes were not granted.' }, '404': { description: 'Unknown or inaccessible resource.' },
        '409': { description: 'UUID conflicts with a different thread. Inspect the existing work rather than starting another UUID.' },
        '429': { description: 'Per-key request quota. Honor Retry-After.' }, '503': { description: 'Source unavailable, unknown decision state, or bounded adapter capacity exceeded.' },
      },
    }
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation }
  }
  return { openapi: '3.1.0', info: { title: `${config.name} operator API`, version: '1.0.0' }, servers: [{ url: origin }],
    security: [{ localKey: [] }], paths,
    components: { securitySchemes: { localKey: { type: 'http', scheme: 'bearer', bearerFormat: 'ak_', description: 'Owner-issued expiring key; no cookie fallback or Platform key support.' } },
      schemas: { Turn: { type: 'object', required: ['workspaceId', 'threadId', 'turnId', 'state', 'reply', 'failure', 'assets', 'files', 'approvals'], properties: {
        workspaceId: { type: 'string' }, threadId: { type: 'string' }, turnId: { type: 'string' },
        state: { type: 'string', enum: ['queued', 'working', 'input-required', 'succeeded', 'failed', 'unknown'] },
        reply: { type: ['object', 'null'] }, failure: { type: ['object', 'null'] }, assets: { type: 'array' }, files: { type: 'array' }, approvals: { type: 'array', description: 'Only the named owner decides; no operator approval mutation endpoint.' },
      } } } },
  }
}
