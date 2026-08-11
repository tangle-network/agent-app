/**
 * `inert`, across the React versions this package's peer range admits.
 *
 * React 19 knows `inert` as a boolean attribute and omits it for `false`.
 * React 18 does not know it at all: it writes an unknown attribute through
 * verbatim, so `inert={false}` renders `inert="false"` — and HTML reads ANY
 * value, the string `"false"` included, as inert. A `inert={!open}` binding
 * therefore makes the OPEN panel the unfocusable one on React 18, and
 * `peerDependencies` declares `react >=18`, so that consumer is real.
 *
 * The fix is to remove the false case rather than to spell it differently:
 * there is no value React 18 renders as "not inert" except no attribute at all.
 */

import { version as reactVersion } from 'react'

/**
 * Props that make an element inert when `inert` is true, and nothing at all
 * when it is false.
 *
 * `reactMajor` is a parameter so both spellings stay testable on one installed
 * React; callers pass nothing and get the running version.
 */
export function inertProps(
  inert: boolean,
  reactMajor: number = Number.parseInt(reactVersion, 10),
): { inert?: boolean } {
  if (!inert) return {}
  // React 18's spelling is a string that @types/react 19 cannot describe, since
  // it declares `inert` a boolean — hence the cast. An unparseable version
  // (NaN) falls to this branch deliberately: `inert=""` is inert on BOTH
  // versions, while `inert={true}` is DROPPED by React 18 and would silently
  // leave a collapsed panel focusable.
  return reactMajor >= 19 ? { inert: true } : ({ inert: '' } as unknown as { inert?: boolean })
}
