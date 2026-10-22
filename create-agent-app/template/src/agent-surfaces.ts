import { createAgentSurfaceHandler, renderAgentSetupSkill, type AgentSurfaceConfig } from '@tangle-network/agent-app/agent-surfaces'

/** The headless skeleton must not advertise customer readiness before auth exists. */
export function headlessAgentSurfaces(origin: string) {
  const product: AgentSurfaceConfig = {
    id: '__PACKAGE_NAME__', name: '__PROJECT_NAME__', origin,
    summary: 'A headless tool-loop development skeleton. External-agent operation is disabled until the product installs trusted authentication and workspace authorization.',
    useWhen: ['Develop a domain tool-loop application; use the default chat template for a ready local-key operator API.'],
    signup: { kind: 'manual', steps: ['Ask the product operator to configure authentication and authorization. This skeleton does not issue keys or accept Tangle Platform keys. Do not send account credentials or work to /chat before the operator enables a trusted identity resolver.'] },
    apiKeyEnv: 'AGENT_APP_API_KEY', prerequisites: ['A product operator who has completed production authentication'], install: [], firstCall: [], verify: [],
    errors: [{ symptom: '503 auth.not_configured', cause: 'No trusted server-side identity resolver is installed', fix: 'The developer must wire one; request-body userId/workspaceId never authorize access.' }],
    pricing: { summary: 'Not ready for customer work. When enabled by the operator, model calls use the configured provider credentials and can incur charges.' },
    next: [], manifest: { ready: false, operator_api: null, auth: { kind: 'not_configured' }, capabilities: [] },
  }
  const handler = createAgentSurfaceHandler(product)
  return { ...handler, handle(request: Request) {
    if (new URL(request.url).pathname === '/llms-full.txt' && ['GET', 'HEAD'].includes(request.method)) return new Response(request.method === 'HEAD' ? null : renderAgentSetupSkill(product), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    return handler.handle(request)
  } }
}
