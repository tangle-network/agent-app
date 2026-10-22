/**
 * Server-side fetch target guard: refuse hosts that resolve to this machine or a
 * private network, so a user- or model-supplied URL cannot reach internal
 * services. URL canonicalization covers alternate IPv4 spellings. No imports.
 */
export function isBlockedFetchHostname(hostname: string): boolean {
  const input = hostname.toLowerCase().replace(/\.$/, '')
  let host: string
  try {
    host = new URL(`http://${input.includes(':') && !input.startsWith('[') ? `[${input}]` : input}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return true
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  // Conservatively refuse IPv6 literals, including mapped IPv4. A partial
  // string-based range parser cannot establish that such a target is public.
  if (host.includes(':')) return true
  return isBlockedIpv4Hostname(host)
}

function isBlockedIpv4Hostname(host: string): boolean {
  const ipv4Parts = host.split('.')
  if (ipv4Parts.length !== 4) return false
  const octets = ipv4Parts.map((part) => Number(part))
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  // Four octets were checked above, so both are defined.
  const [first, second] = octets as [number, number, number, number]
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first === 0
}
