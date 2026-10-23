/** Actual SDK and shared detached stream in workerd. All native I/O targets the local protocol peer. */
import { Sandbox } from '@tangle-network/sandbox/core'
import { streamSandboxPrompt } from '../../src/sandbox/prompt-dispatch'

interface Env { PEER: string }
const controllers = new Map<string, AbortController>()
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const mode = url.searchParams.get('mode') ?? 'setup'
    if (url.pathname === '/stop') {
      const controller = controllers.get(mode)
      if (!controller) return new Response('No active execution', { status: 409 })
      controller.abort(new Error('fixture_stop_requested'))
      return Response.json({ requested: true })
    }
    if (url.pathname !== '/run') return new Response('Not found', { status: 404 })
    const controller = new AbortController()
    controllers.set(mode, controller)
    const events: unknown[] = []
    try {
      const box = await new Sandbox({ apiKey: 'fixture-local-sdk-only', baseUrl: env.PEER }).get('box-stop')
      if (!box) throw new Error('Fixture Sandbox missing')
      // Real product setup may await external I/O before invoking the shared helper.
      if (mode === 'setup') await fetch(`${env.PEER}/setup`)
      for await (const event of streamSandboxPrompt({ provider: {
        providerName: 'openai-compatible', apiKey: 'fixture-local-model-only', routerBaseUrl: env.PEER,
      } }, box, 'Perform the local fixture task.', {
        profile: { harness: 'opencode', model: { provider: 'openai-compatible', default: 'fixture/model' },
          prompt: { systemPrompt: 'Perform the local task.' } },
        sessionId: 'session-stop', executionId: `execution-${mode}`, turnId: `execution-${mode}`,
        signal: controller.signal, detach: true,
        // This callback runs after the actual async WebCrypto profile fingerprint.
        ...(mode === 'profile' ? { onProfileResolved: () => controller.abort(new Error('fixture_stop_requested')) } : {}),
      })) events.push(event)
      return Response.json({ aborted: controller.signal.aborted, events })
    } catch (error) {
      return Response.json({ aborted: controller.signal.aborted,
        error: error instanceof Error ? error.message : String(error), events })
    } finally { controllers.delete(mode) }
  },
}
