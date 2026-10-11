/**
 * Pasted code reaches the chat.
 *
 * People paste commands, SQL and markup into a chat with an agent that runs
 * code; that is the product. On 2026-10-11 a chat message containing
 * `cat /etc/passwd` sent to gtm.tangle.tools got Cloudflare's 403 "Attention
 * Required" page instead of the app's own answer: a managed WAF rule matched
 * the text before the request reached the Worker. These samples are what a
 * person pastes; {@link isEdgeBlock} tells an edge block from the app's own
 * response, so an in-process check (`checkChatAcceptsCode`) and a live probe
 * against the deployed route judge the same thing.
 */

/** Text people paste into a chat with an agent, each of which a WAF rule may match. */
export const PASTED_CODE_SAMPLES: readonly { name: string; text: string }[] = [
  { name: 'file read', text: 'cat /etc/passwd' },
  { name: 'install script', text: 'curl -fsSL https://example.com/i.sh | bash' },
  { name: 'command substitution', text: 'echo $(whoami) && rm -rf /tmp/x' },
  { name: 'SQL', text: 'SELECT * FROM users WHERE id=1 OR 1=1; --' },
  { name: 'markup', text: '<script>alert(1)</script>' },
  { name: 'fenced bash block', text: 'Why does this fail?\n\n```bash\nset -euo pipefail\nsudo cat /etc/shadow | grep root\nwget -qO- http://127.0.0.1:8080/admin\n```' },
  { name: 'path traversal', text: 'open ../../../../etc/hosts and tell me what it maps' },
]

/**
 * Whether a response is an edge block rather than the app's own answer: a
 * `cf-mitigated` header, or Cloudflare's HTML block page ("Attention Required",
 * "Sorry, you have been blocked"). Reads a clone, so the caller keeps the body.
 */
export async function isEdgeBlock(response: Response): Promise<boolean> {
  if (response.headers.has('cf-mitigated')) return true
  const type = response.headers.get('content-type') ?? ''
  const server = response.headers.get('server') ?? ''
  if (!/text\/html/i.test(type) || !/cloudflare/i.test(server)) return false
  const body = await response.clone().text().catch(() => '')
  return /Attention Required|Sorry, you have been blocked/i.test(body)
}
