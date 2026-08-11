/**
 * `inert`, across the React versions this package's peer range admits.
 *
 * MEASURED, not reasoned. `react` + `react-dom` 18.3.1 and 19.2.8, each
 * rendering `<div inert={…}>x</div>` through `renderToStaticMarkup`, and the
 * same four cases re-read as `outerHTML` after `createRoot().render` — server
 * and client agreed on every row:
 *
 * | prop            | React 18.3.1                    | React 19.2.8                    |
 * | --------------- | ------------------------------- | ------------------------------- |
 * | `inert={false}` | `<div>x</div>` — NO attribute   | `<div>x</div>` — NO attribute   |
 * | `inert={''}`    | `<div inert="">x</div>` — inert | `<div>x</div>` — NO attribute   |
 * | `inert={true}`  | `<div>x</div>` — NO attribute   | `<div inert="">x</div>` — inert |
 *
 * React 18 warns on the two it drops (`Received \`false\`/\`true\` for a
 * non-boolean attribute \`inert\`.`); React 19 warns on the one it drops
 * (`Received an empty string for a boolean attribute \`inert\`.`).
 *
 * So the FALSE case needs no help: both majors already emit nothing, and a
 * plain `inert={!open}` binding never made an open panel inert on either. The
 * TRUE case is the one with no shared spelling — `true` is inert only on 19,
 * `''` only on 18, and there is no third value that is inert on both. Left as a
 * plain boolean binding, a COLLAPSED panel stays focusable and screen-reader
 * readable on React 18, which `peerDependencies` (`react >=18`) admits.
 *
 * That is what this helper is for, and why it is a function rather than a JSX
 * binding: the branch is a fact about the running React, so it belongs
 * somewhere a test can pass both majors in.
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
  // it declares `inert` a boolean — hence the cast.
  //
  // NaN takes the 19 branch (`NaN < 19` is false), which is a bet and is stated
  // as one: the table above measured no value that is inert on both majors, so
  // an unreadable version has to pick. It picks 19 because `Number.parseInt`
  // reads `18` out of every published React 18 version string, so a version
  // that does not parse is not React 18.
  return reactMajor < 19 ? ({ inert: '' } as unknown as { inert?: boolean }) : { inert: true }
}
