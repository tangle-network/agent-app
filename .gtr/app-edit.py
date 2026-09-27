from pathlib import Path
import json, sys, shutil
root=Path(sys.argv[1]); helpers=Path(__file__).parent
p=root/'src/platform/sso.ts'; s=p.read_text()
def replace(text, before, after):
    if text.count(before) != 1: raise RuntimeError('Expected one source anchor: '+before[:80])
    return text.replace(before, after, 1)
s=replace(s, s[:s.index('import { clearCookieHeader')], '''/**
 * Tangle SSO for agent apps. OIDC callers use the registered runtime client
 * with S256 PKCE. Legacy API-key callers remain explicit during migration.
 * OIDC never falls back to cross-site exchange. Account matching and native
 * session cookie minting remain shared.
 */

import type { OidcTokens, PlatformOidcClient } from '@tangle-network/agent-runtime/platform'
''')
s=replace(s, 'if (!random || !timestamp || !mac) return false', "if (!random || !timestamp || !mac || !/^[0-9a-z]+$/.test(timestamp)) return false")
s=replace(s, 'return now() - mintedAt <= ttlMs', 'const age = now() - mintedAt\n  return age >= 0 && age <= ttlMs')
anchor='/** Local account shape required by the verified Tangle SSO account policy.'
s=replace(s, anchor, '''/** The runtime owns the OIDC wire protocol and its types. */
export type TangleOidcSsoAuthClient = Pick<
  PlatformOidcClient,
  'authorizeUrl' | 'exchange' | 'refresh' | 'userinfo' | 'revoke'
>

'''+anchor)
anchor='// ── Session cookie'
pos=s.index(anchor)
s=s[:pos]+'''/**
 * OIDC tokens are server-side credentials, not API keys. Implementations must
 * encrypt them at rest and bind them to the exact local session. Refresh and
 * disconnect must serialize updates to the same grant.
 */
export interface TangleOidcSsoAccountStore extends Omit<TangleSsoAccountStore, 'saveTangleLink'> {
  saveTangleLink(input: {
    userId: string
    sessionToken: string
    tangleUserId: string
    email: string
    name: string | null
    tokens: OidcTokens
    accessTokenExpiresAt: Date
  }): Promise<void>
  /** Remove an unpublished local session if callback persistence fails. */
  deleteSession(input: { sessionToken: string }): Promise<void>
}

'''+s[pos:]
s=replace(s, 'export interface TangleSsoHandlerOptions {', "export interface TangleSsoHandlerOptions {\n  protocol?: 'legacy'")
anchor='/** Define handlers for SSO start and callback routes'
pos=s.index(anchor)
s=s[:pos]+'''/** Registered OIDC client with a separate token persistence contract. */
export interface TangleOidcSsoHandlerOptions extends Omit<TangleSsoHandlerOptions, 'protocol' | 'auth' | 'store'> {
  protocol: 'oidc'
  auth: TangleOidcSsoAuthClient
  store: TangleOidcSsoAccountStore
}

'''+s[pos:]
s=replace(s, "headers.set('Location', location)", "headers.set('Location', location)\n  headers.set('Cache-Control', 'no-store')\n  headers.set('Referrer-Policy', 'no-referrer')")
s=replace(s, 'interface StateCookiePayload {\n  s: string\n  r: string\n}', 'interface StateCookiePayload {\n  s: string\n  r: string\n  v?: string\n  m?: string\n}')
start=s.index('function parseStateCookiePayload('); end=s.index('/** Create Tangle SSO handlers',start)
s=s[:start]+'''function parseStateCookiePayload(raw: string | null): StateCookiePayload | null {
  if (!raw || raw.length > 4096) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const { s, r, v, m } = parsed as Record<string, unknown>
    if (typeof s !== 'string' || typeof r !== 'string') return null
    return { s, r, ...(typeof v === 'string' ? { v } : {}), ...(typeof m === 'string' ? { m } : {}) }
  } catch { return null }
}

function stateBinding(payload: StateCookiePayload, callbackUrl: string): string {
  return JSON.stringify([payload.s, payload.r, payload.v ?? null, callbackUrl])
}

'''+s[end:]
start=s.index('export function createTangleSsoHandlers(')
s=s[:start]+(helpers/'sso-handlers.ts').read_text();p.write_text(s)
p=root/'src/app-auth/index.ts';s=p.read_text()
s=replace(s, '  type TangleSsoHandlers,', '  type TangleSsoHandlers,\n  type TangleOidcSsoAccountStore,\n  type TangleOidcSsoAuthClient,')
s=replace(s, 'export interface AppAuthSsoConfig {', "export interface AppAuthSsoConfig {\n  protocol?: 'legacy'")
anchor='/** Define the structure for application authentication data';pos=s.index(anchor)
s=s[:pos]+'''/** Registered OIDC client configuration. Login does not mint an API key. */
export interface AppAuthOidcSsoConfig extends Omit<AppAuthSsoConfig, 'protocol' | 'client' | 'store'> {
  protocol: 'oidc'
  client: TangleOidcSsoAuthClient
  store: TangleOidcSsoAccountStore
}

'''+s[pos:]
s=replace(s, '  sso?: AppAuthSsoConfig', '  sso?: AppAuthSsoConfig | AppAuthOidcSsoConfig')
s=replace(s, '''    sso = createTangleSsoHandlers({
      auth: config.sso.client,
      store: config.sso.store,''', '''    const transport = config.sso.protocol === 'oidc'
      ? { protocol: 'oidc' as const, auth: config.sso.client, store: config.sso.store }
      : { protocol: 'legacy' as const, auth: config.sso.client, store: config.sso.store }
    sso = createTangleSsoHandlers({
      ...transport,''')
p.write_text(s)
p=root/'package.json';j=json.loads(p.read_text())
j['devDependencies']['@tangle-network/agent-runtime']='github:tangle-network/agent-runtime#a3d2eb6a2d523caec56edb438be026339b8b5b27'
j['devDependencies']['@tangle-network/agent-interface']='2.13.0'
j['peerDependencies']['@tangle-network/agent-runtime']='>=0.278.1 <0.279.0'
j['peerDependencies']['@tangle-network/agent-interface']='^2.13.0'
p.write_text(json.dumps(j,indent=2)+'\n')
p=root/'src/peer-floors/check.test.ts';s=p.read_text();start=s.index('    // Runtime 0.262.0');end=s.index('\n  })',start)
s=s[:start]+'''    // The OIDC transport requires the runtime that includes PR #1410.
    expect(satisfiesRange('0.277.0', range!)).toBe(false)
    expect(satisfiesRange('0.278.0', range!)).toBe(false)
    expect(satisfiesRange('0.278.1', range!)).toBe(true)
    expect(satisfiesRange('0.278.999', range!)).toBe(true)
    expect(satisfiesRange('0.279.0', range!)).toBe(false)'''+s[end:]
s=s.replace("expect(satisfiesRange('2.11.0', range!)).toBe(true)", "expect(satisfiesRange('2.11.0', range!)).toBe(false)")
s=s.replace("expect(satisfiesRange('2.12.0', range!)).toBe(true)", "expect(satisfiesRange('2.12.0', range!)).toBe(false)\n    expect(satisfiesRange('2.13.0', range!)).toBe(true)")
s=s.replace("['@tangle-network/agent-interface', ['2.10.999'], ['2.11.0', '2.12.0'], ['3.0.0']]", "['@tangle-network/agent-interface', ['2.12.999'], ['2.13.0'], ['3.0.0']]")
p.write_text(s)
(root/'scripts').mkdir(exist_ok=True); (root/'docs').mkdir(exist_ok=True)
shutil.copyfile(helpers/'oidc-live-proof.mjs',root/'scripts/oidc-live-proof.mjs')
shutil.copyfile(helpers/'OIDC-CALLER-GTR.md',root/'docs/OIDC-CALLER-GTR.md')
