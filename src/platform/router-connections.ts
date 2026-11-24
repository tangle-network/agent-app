/** Use a signed-in user's Router management bearer on the server. The upstream
 * provider key is write-only. Only the fields needed for selection cross to UI. */
export interface RouterKeyConnection {
  id: string
  provider: string
  displayName: string
  models: string[]
  createdAt: string
  disabled: boolean
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export function routerConnectionBaseUrl(routerV1: string, id: string) {
  if (!uuid.test(id)) throw new Error('Invalid Router connection ID.')
  const base = new URL(routerV1)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid Router origin.')
  return base.href.replace(/\/+$/, '') + '/byok/' + id
}

interface RouterRecord {
  id: string; name?: string | null; label?: string; provider: string
  disabled: boolean; allowed_models?: string[] | null; created_at: string
}

function publicRecord(row: RouterRecord): RouterKeyConnection {
  return { id: row.id, provider: row.provider, displayName: row.name || row.label || row.provider,
    disabled: row.disabled, createdAt: row.created_at, models: row.allowed_models ?? [] }
}

export function createRouterConnections(options: { baseUrl: string; bearer: string; fetch?: typeof fetch; signal?: AbortSignal }) {
  const endpoint = new URL(options.baseUrl)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error('Invalid Router origin.')
  const base = endpoint.href.replace(/\/+$/, '') + '/byok'
  async function request(url: string, method: string, body?: Record<string, unknown>) {
    const response = await (options.fetch ?? fetch)(url, { method, redirect: 'error', signal: options.signal,
      headers: { authorization: 'Bearer ' + options.bearer, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error('Router connection request failed (HTTP ' + response.status + ').')
    return response
  }
  return {
    async list(): Promise<RouterKeyConnection[]> {
      const result: RouterKeyConnection[] = []
      for (;;) {
        const response = await request(base + '?limit=100&offset=' + result.length, 'GET')
        const page = await response.json() as { data: RouterRecord[]; total_count: number }
        result.push(...page.data.map(publicRecord))
        if (!page.data.length || result.length >= page.total_count) return result
      }
    },
    async connect(input: { provider: string; key: string; name: string; models: string[] }) {
      const response = await request(base, 'POST', { provider: input.provider, key: input.key, name: input.name, allowed_models: input.models })
      return publicRecord(((await response.json()) as { data: RouterRecord }).data)
    },
    async get(id: string) {
      const response = await request(routerConnectionBaseUrl(endpoint.href, id), 'GET')
      return publicRecord(((await response.json()) as { data: RouterRecord }).data)
    },
    async revoke(id: string) { await request(routerConnectionBaseUrl(endpoint.href, id), 'DELETE') },
  }
}
