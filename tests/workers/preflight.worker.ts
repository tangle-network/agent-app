import { httpHeadProbe, runPreflight } from '../../src/preflight'

/** Runs a preflight HEAD probe with its default fetch inside workerd, against the URL the test passes. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url).searchParams.get('target')!
    return Response.json(await runPreflight([httpHeadProbe({ name: 'peer', url, timeoutMs: 5_000 })]))
  },
}
