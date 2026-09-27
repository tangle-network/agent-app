from pathlib import Path
import json
root = Path('.')
p = root / 'tests/integrations.test.ts'
s = p.read_text().replace("(seen.init.headers as Record<string, string>).Authorization", "new Headers(seen.init.headers).get('authorization')")
s = s.replace("    expect(calls).toBe(1)\n", "    // The SDK also asks the capability endpoint. Neither request grants approval.\n    expect(calls).toBe(2)\n")
p.write_text(s)
p = root / 'src/tools/openai.ts'
s = "import type { OpenAIChatTool } from '@tangle-network/agent-runtime'\n" + p.read_text()
start = s.index('/** A minimal OpenAI Chat Completions function-tool shape')
end = s.index('\n/**\n * Build the four app tools', start)
s = s[:start] + '''/** Published Runtime tool descriptor with the description and schema required by app tools. */
export interface OpenAIFunctionTool extends OpenAIChatTool {
  function: OpenAIChatTool['function'] & Required<Pick<OpenAIChatTool['function'], 'description' | 'parameters'>>
}
''' + s[end:]
p.write_text(s)
p = root / 'src/turn-health/sink.ts'
s = p.read_text().replace("import { describeReason,", "import { postSlackAlert } from '../alerting/slack.js'\nimport { describeReason,")
start = s.index("      const response = await fetchImpl('https://slack.com/api/chat.postMessage'")
end = s.index('\n    },\n  }\n}', start)
s = s[:start] + '''      const outcome = await postSlackAlert({
        token: options.botToken, channel: options.channel, text: lines.join('\\n'), attempts: 1,
        // Preserve the public minimal-fetch seam without owning a second Slack
        // request builder or response parser. Real callers use native fetch.
        fetchImpl: options.fetchImpl ? (async (url, init) => {
          const response = await fetchImpl(String(url), {
            method: init?.method ?? 'POST',
            headers: Object.fromEntries(new Headers(init?.headers)),
            body: String(init?.body ?? ''),
          })
          return new Response(await response.text?.() ?? '', { status: response.status })
        }) : undefined,
      })
      if (!outcome.delivered) throw new Error(`Slack alert failed (${outcome.reason}): ${outcome.detail}`)''' + s[end:]
p.write_text(s)
p = root / 'examples/hosted-agent/src/worker.ts'
s = p.read_text().replace("import { createHostedAgent }", "import { HubClient, HubSdkError } from '@tangle-network/hub-sdk'\nimport { createHostedAgent }")
start = s.index('  const hub = (path: string, init?: RequestInit) =>')
end = s.index('\n}\n\nexport default', start)
s = s[:start] + '''  const body = await request.json().catch(() => null) as {
    connectionId?: unknown
    voice?: { ph0nyConnectionId: string; ph0nyAgentId: string }
  } | null
  if (!body || (body.connectionId !== undefined && typeof body.connectionId !== 'string')) {
    return Response.json({ error: 'A JSON setup body with a connectionId is required' }, { status: 400 })
  }
  try {
    const hub = new HubClient({ baseUrl: 'https://id.tangle.tools', apiKey: env.TANGLE_API_KEY })
    const { subscriptions } = await hub.eventSubscriptions.list()
    const earlier = subscriptions.filter(s => s.clientReference?.startsWith('hosted-agent:'))
    const candidates = [...new Set(earlier.map(s => s.connectionId))]
    // Never choose an arbitrary identity when several legacy routes exist.
    const connectionId = body.connectionId ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!connectionId) return Response.json({ error: 'connectionId is required' }, { status: 400 })
    for (const subscription of earlier) {
      if (subscription.connectionId === connectionId) await hub.eventSubscriptions.delete(subscription.id)
    }
    return Response.json(await braid(env).attachLine(connectionId, { voice: body.voice }))
  } catch (error) {
    // SDK errors already redact credentials. Do not echo arbitrary provider bodies.
    return Response.json({ error: error instanceof HubSdkError ? error.code : 'line_setup_failed' }, { status: 502 })
  }''' + s[end:]
p.write_text(s)
p = root / 'examples/hosted-agent/package.json'
j = json.loads(p.read_text())
j['dependencies']['@tangle-network/hub-sdk'] = '0.19.2'
p.write_text(json.dumps(j, indent=2) + '\n')
